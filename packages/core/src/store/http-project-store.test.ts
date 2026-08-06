import { describe, expect, it, vi } from 'vitest';

import { createHttpProjectStore, SiteFileUnreachableError } from './http-project-store.js';
import { InvalidPathError, PathNotFoundError, type StorePath } from './project-store.js';

// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT `describeProjectStore`
//
// Ticket 12's File System Access adapter passed ticket 02's shared suite with **zero changes to the
// suite**, which is the outcome ADR-0001 was aiming for. This adapter cannot, and the reason is worth
// recording rather than worked around, because the tempting fixes are all worse than the honest
// answer.
//
// `describeProjectStore` takes a `StoreUnderTest`, which is a full `ProjectStore` plus three fixture
// hooks: `everyStoredPath()`, `failNextWrite(step)`, and `plantAbandonedWrite(path)`. Every one of
// those is about **writing**. So is the shape of the suite: 27 of its 30 tests either assert a write
// or use `store.write` to arrange their fixture — including all four `listing` tests and both `size`
// tests, which have no other way to put a file where they can find it.
//
// This backend has no `write`, by type (see `ReadOnlyProjectStore`), because ticket 17 requires that
// the viewer have none and a static host would refuse one anyway. Three routes to a green suite were
// considered and all three are worse:
//
//   1. **Give the adapter a `write` that rejects.** Then the suite still fails — every fixture would
//      reject — and the viewer would have a reachable `write`, which is exactly what the ticket says
//      it must not have.
//   2. **Let the fixture seed files behind the adapter's back** (a `seed()` hook, or a fake server the
//      fixture writes into). The suite would then be exercising the fixture's write path and this
//      adapter's read path, so the ~20 assertions about atomicity, litter, and `size` would be
//      assertions about the *test double*. That is a suite passing vacuously, which the tracker
//      records as having happened three times already on ticket 02.
//   3. **Widen the suite** — split it into read-only and read-write halves. That is the one that
//      might be right eventually, but the shared suite is the load-bearing artefact of the storage
//      layer, and quietly restructuring it so a fourth backend fits is the failure ADR-0001's rule is
//      written against ("needing to widen the interface is a signal the interface was wrong, not that
//      the adapter is special"). This adapter *is* special: it is the only one that cannot write.
//
// So the suite is left exactly as it is, and this file asserts the contract this backend actually
// owes: `read` behaves like every other backend's `read` — same path validation, same
// `PathNotFoundError` — and the four methods it does not have are absent rather than broken.

/** A `fetch` over a fixed set of files, so nothing here needs a server. */
function serving(files: Record<string, string | { status: number }>) {
	const asked: string[] = [];
	const init: RequestInit[] = [];
	const fetch = vi.fn(async (url: string, options?: RequestInit) => {
		asked.push(url);
		if (options) init.push(options);
		const answer = files[url];
		if (answer === undefined) return new Response('not here', { status: 404 });
		if (typeof answer === 'object') return new Response('', { status: answer.status });
		return new Response(new TextEncoder().encode(answer), { status: 200 });
	});
	return { fetch, asked, init };
}

/** The viewer's own shape: paths resolved relative to the document, never against `/` (ADR-0006). */
const relativeTo =
	(base: string) =>
	(path: StorePath): string =>
		`${base}${path}`;

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('the HTTP ProjectStore adapter', () => {
	describe('reading', () => {
		it('reads a Published Site’s file as bytes', async () => {
			const { fetch } = serving({
				'https://scholar.example/atlas/amsterdam-1625/project.json': '{"formatVersion":1}'
			});
			const store = createHttpProjectStore({
				resolve: relativeTo('https://scholar.example/atlas/'),
				fetch
			});

			expect(decode(await store.read('amsterdam-1625/project.json'))).toBe('{"formatVersion":1}');
		});

		it('resolves through the injected resolver, so one build serves a root and a subdirectory', async () => {
			// ADR-0006's whole claim, at this seam. The *same* store path has to become two different
			// URLs depending on where the site was uploaded, and nothing in this module may know which —
			// so the assertion is that the path went through `resolve` untouched and was not composed
			// against `/` here.
			const root = serving({ 'https://scholar.example/ballastella-site.json': '{}' });
			const subpath = serving({
				'https://student.example/atlas-2026/ballastella-site.json': '{}'
			});

			await createHttpProjectStore({
				resolve: relativeTo('https://scholar.example/'),
				fetch: root.fetch
			}).read('ballastella-site.json');
			await createHttpProjectStore({
				resolve: relativeTo('https://student.example/atlas-2026/'),
				fetch: subpath.fetch
			}).read('ballastella-site.json');

			expect(root.asked).toEqual(['https://scholar.example/ballastella-site.json']);
			expect(subpath.asked).toEqual(['https://student.example/atlas-2026/ballastella-site.json']);
		});

		it('reads a file’s bytes exactly, including bytes that are not text', async () => {
			// A tile is JPEG (ADR-0003), and the whole point of this adapter is that a renderer reaches
			// one through it. A `Response.text()` round trip would corrupt every one of them.
			const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
			const store = createHttpProjectStore({
				resolve: () => 'https://scholar.example/tile.jpg',
				fetch: async () => new Response(jpeg, { status: 200 })
			});

			expect(await store.read('images/a/0,0,256,256/256,256/0/default.jpg')).toEqual(jpeg);
		});

		it('returns bytes backed by a plain ArrayBuffer, which is what every parser here takes', async () => {
			const store = createHttpProjectStore({
				resolve: () => 'https://scholar.example/f',
				fetch: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })
			});

			const bytes = await store.read('p/f');
			// `Bytes` is `Uint8Array<ArrayBuffer>`. A view over a `SharedArrayBuffer` type-checks as
			// `Uint8Array` and is refused by the write APIs downstream, so this is asserted rather than
			// assumed.
			expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
		});

		it('revalidates rather than serving a stale Project from the browser cache', async () => {
			// SPEC story 81: one repository for a whole semester, re-published in place. A Reader who
			// looked last week must not be shown last week's `project.json` beside this week's tiles.
			const { fetch, init } = serving({ 'https://scholar.example/p/project.json': '{}' });
			await createHttpProjectStore({
				resolve: relativeTo('https://scholar.example/'),
				fetch
			}).read('p/project.json');

			expect(init.map((options) => options.cache)).toEqual(['no-cache']);
		});
	});

	describe('a file that is not on the site', () => {
		it('rejects a 404 with PathNotFoundError, the same as every other backend', async () => {
			// The shared contract that makes this a `ProjectStore` backend at all: callers all over this
			// codebase branch on `PathNotFoundError` to mean "not published / not written yet", and a
			// static host says that with a status rather than by rejecting.
			const store = createHttpProjectStore({
				resolve: relativeTo('https://scholar.example/'),
				fetch: serving({}).fetch
			});

			await expect(store.read('nowhere/project.json')).rejects.toThrow(PathNotFoundError);
		});

		it('rejects a 410 the same way: the host is answering, and the file is gone', async () => {
			const store = createHttpProjectStore({
				resolve: relativeTo('https://scholar.example/'),
				fetch: serving({ 'https://scholar.example/p/gone.json': { status: 410 } }).fetch
			});

			await expect(store.read('p/gone.json')).rejects.toThrow(PathNotFoundError);
		});

		it('names the path it could not find, so a caller can say which Layer is missing', async () => {
			const store = createHttpProjectStore({
				resolve: relativeTo('https://scholar.example/'),
				fetch: serving({}).fetch
			});

			await expect(store.read('p/annotations/l2.geojson')).rejects.toMatchObject({
				path: 'p/annotations/l2.geojson'
			});
		});
	});

	describe('a host that is not answering', () => {
		// Told apart from "not there" on purpose, and this is the distinction ticket 17's degradation
		// table needs: a Layer whose document is absent is a Project published incomplete, and one whose
		// host refused the connection is a Project that is fine and a server that is not.

		it.each([
			['a server error', { status: 500 }],
			['a bad gateway', { status: 502 }],
			['a refusal', { status: 403 }]
		])('rejects %s as unreachable rather than as missing', async (_description, answer) => {
			const store = createHttpProjectStore({
				resolve: relativeTo('https://library.example/'),
				fetch: serving({ 'https://library.example/p/project.json': answer }).fetch
			});

			const failure = await store.read('p/project.json').catch((cause: unknown) => cause);
			expect(failure).toBeInstanceOf(SiteFileUnreachableError);
			expect(failure).not.toBeInstanceOf(PathNotFoundError);
			expect((failure as SiteFileUnreachableError).status).toBe(answer.status);
		});

		it('names the host in the message, because that is the actionable part', async () => {
			const store = createHttpProjectStore({
				resolve: relativeTo('https://maps.library.example/iiif/'),
				fetch: async () => {
					throw new TypeError('Failed to fetch');
				}
			});

			const failure: unknown = await store
				.read('images/a/info.json')
				.catch((cause: unknown) => cause);
			// Narrowed rather than cast, so a `read` that resolved would fail here instead of reading
			// properties off bytes.
			if (!(failure instanceof SiteFileUnreachableError)) {
				throw new Error(`expected SiteFileUnreachableError, got ${String(failure)}`);
			}
			expect(failure.host).toBe('maps.library.example');
			expect(failure.message).toContain('maps.library.example');
			expect(failure.message).toContain('Failed to fetch');
			// `0` rather than a status, because the request never got an answer at all.
			expect(failure.status).toBe(0);
		});
	});

	describe('paths', () => {
		it.each([
			['an empty path', ''],
			['a leading slash', '/p/project.json'],
			['a trailing slash', 'p/'],
			['an empty segment', 'p//project.json'],
			['a parent traversal', 'p/../../etc/passwd'],
			['a current-directory segment', 'p/./project.json'],
			['a backslash separator', 'p\\project.json'],
			['the reserved temporary suffix', 'p/project.json.ballastella-tmp']
		])('refuses %s, exactly as the other backends do', async (_description, path) => {
			// The same `assertStorePath` every backend uses, so a Project reads identically whichever it
			// is read from. It matters more here than anywhere else, because a store path becomes a URL:
			// `p/../..` left unchecked resolves against the site and reaches outside the Workspace.
			const { fetch, asked } = serving({});
			const store = createHttpProjectStore({ resolve: relativeTo('https://x.example/'), fetch });

			await expect(store.read(path)).rejects.toThrow(InvalidPathError);
			// And it was refused *before* a request was made, so a malformed path cannot become a probe.
			expect(asked).toEqual([]);
		});
	});

	describe('what it deliberately cannot do', () => {
		it('has no write, and therefore nothing a Reader does can attempt one', () => {
			// Ticket 17: "The viewer has no store `write`." Asserted on the object rather than only in the
			// type, because a type is not what a Reader's browser runs — and because the tempting shape,
			// a `write` that rejects, would pass a type check and put a reachable write in a Published
			// Site.
			const store = createHttpProjectStore({ resolve: relativeTo('https://x.example/') });

			expect(Object.keys(store)).toEqual(['read']);
			for (const method of ['write', 'delete', 'reclaimAbandonedWrites', 'list', 'size']) {
				expect(store, method).not.toHaveProperty(method);
			}
		});

		it('is the read half of ProjectStore, so ADR-0011’s shim takes it unchanged', async () => {
			// The point of the abstraction paying out a third time (ADR-0001): the very same
			// `createStoreImageFetch` that resolves a pyramid out of OPFS resolves one out of a Published
			// Site, with no second code path. Asserted structurally here; asserted end to end by
			// `e2e/viewer.e2e.ts`, where a real warped Historical Map draws over HTTP.
			const { createStoreImageFetch } = await import('../injection/store-image-fetch.js');
			const store = createHttpProjectStore({
				resolve: (path) => `https://scholar.example/atlas/${path}`,
				fetch: serving({
					// At the site root, because a published pyramid is the Workspace's rather than a Project's
					// (ADR-0023) — one `images/<id>/` served to every Project of the site.
					'https://scholar.example/atlas/images/aaa/info.json': '{"width":1024}'
				}).fetch
			});

			const readTile = createStoreImageFetch({ store });
			const response = await readTile('https://unset.invalid/aaa/info.json');

			expect(response.status).toBe(200);
			expect(await response.text()).toBe('{"width":1024}');
		});
	});
});
