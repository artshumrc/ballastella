// SPEC's Seam 1: the injection layer driven against an in-memory ProjectStore.
//
// The whole of ADR-0011 is in the two describes below. The first asserts the routing rule —
// what is captured, what is passed through, and what a missing tile answers — against files put
// in the store by hand, so the rule is readable. The second asserts it against a pyramid
// `ingestImageFile` actually wrote, because a routing rule that agrees with a hand-written path
// and disagrees with the tiler would be worse than no rule at all.

import { describe, expect, it, onTestFinished } from 'vitest';

import { createImagePane } from '../image-pane/iiif-image-pane.js';
import { ROUND_TRIP_TOLERANCE_PX } from '../image-pane/synthetic-projection.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { SiteFileUnreachableError } from '../store/http-project-store.js';
import type { ReadOnlyProjectStore } from '../store/project-store.js';
import { ingestImageFile, type OpenTileSource, type TileSource } from '../tiler/ingest.js';
import {
	buildImageInfo,
	imageServiceId,
	serialiseJson,
	type PlannedTile
} from '../tiler/pyramid.js';
import {
	MissingImageServiceOverrideError,
	createStoreImageFetch,
	isImageServicePlaceholderUrl,
	refuseUnroutedImageServiceRequests,
	type FetchFn,
	type TileFetchOutcome
} from './store-image-fetch.js';

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * A Workspace holding one Historical Map's `info.json` and one tile, at the Workspace root.
 *
 * **No Project directory anywhere in these paths, and that is the point of ADR-0023.** A pyramid is
 * shared, so `images/<id>/…` *is* the path. It also holds a Project directory with a decoy pyramid
 * inside it, because the mistake this file exists to catch is silent: rooted at a Project, the shim
 * answers with those bytes instead — a plausible map, in the right pane, with nothing logged.
 */
async function storeWithTile(): Promise<MemoryProjectStore> {
	const store = new MemoryProjectStore();
	await store.write('images/abc123/info.json', bytes('{"id":"x"}'));
	await store.write('images/abc123/0,0,256,256/256,256/0/default.jpg', bytes('tile bytes'));
	// The decoy. If any of the assertions below can be satisfied by a Project-rooted resolution, they
	// come back as these bytes rather than as a failure to find anything. Both paths are the specimen
	// `check-workspace-rooted-paths.mjs` refuses, seeded here on purpose, so both carry its pragma.
	await store.write(
		// project-rooted-path-is-the-fixture: the decoy pyramid the shim must never resolve to
		'amsterdam-1625/images/abc123/info.json',
		bytes('{"id":"the wrong map"}')
	);
	await store.write(
		// project-rooted-path-is-the-fixture: the decoy tile, whose bytes name the wrong rooting
		'amsterdam-1625/images/abc123/0,0,256,256/256,256/0/default.jpg',
		bytes('the wrong tile')
	);
	return store;
}

const placeholderTile = `${imageServiceId('abc123')}/0,0,256,256/256,256/0/default.jpg`;

describe('createStoreImageFetch', () => {
	it('serves a tile that only exists in the store, keyed on the placeholder base URL', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(placeholderTile);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('image/jpeg');
		expect(await response.text()).toBe('tile bytes');
	});

	it('serves the info.json through the same route, so the pane has one way in', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(`${imageServiceId('abc123')}/info.json`);

		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe('application/json');
		expect(await response.json()).toEqual({ id: 'x' });
	});

	it('accepts a URL and a Request, not only a string', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const fromUrl = await fetchImage(new URL(placeholderTile));
		const fromRequest = await fetchImage(new Request(placeholderTile));

		expect(fromUrl.status).toBe(200);
		expect(fromRequest.status).toBe(200);
	});

	it('percent-encoded IIIF commas resolve to the same tile', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(
			`${imageServiceId('abc123')}/0%2C0%2C256%2C256/256%2C256/0/default.jpg`
		);

		expect(await response.text()).toBe('tile bytes');
	});

	it('answers 404 for a tile the pyramid does not hold, naming the path it looked at', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(`${imageServiceId('abc123')}/9,9,1,1/1,1/0/default.jpg`);

		const detail = await response.text();
		expect(response.status).toBe(404);
		expect(detail).toContain('images/abc123/9,9,1,1/1,1/0/default.jpg');
		// And the path it names has no Project directory in it, which is the whole of the rooting claim.
		expect(detail).not.toContain('amsterdam-1625');
	});

	it('answers 404 for an image id that is not in this Workspace', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(`${imageServiceId('not-here')}/info.json`);

		expect(response.status).toBe(404);
	});

	it('answers 404, and never reads, for a placeholder path that is not a store path', async () => {
		const store = await storeWithTile();
		const fetchImage = createStoreImageFetch({ store });

		// Traversal out of the Project, an empty segment, and the bare base with no IIIF path.
		// A `fetchFn` must answer rather than throw — a stray request must not become an
		// unhandled rejection inside somebody else's renderer — but it must also never turn into
		// a read of a path the caller did not name.
		for (const path of ['../../etc/passwd/1,1/1,1/0/default.jpg', '//info.json', '']) {
			const response = await fetchImage(`${imageServiceId('abc123')}/${path}`);
			expect(response.status, path).toBe(404);
		}

		const bare = await fetchImage(imageServiceId('abc123'));
		expect(bare.status).toBe(404);
	});

	it('answers 405 to a method that is not a read', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(placeholderTile, { method: 'PUT' });

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('GET, HEAD');
	});

	it('answers a HEAD with the length and no body, so a size question costs no bytes', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const response = await fetchImage(placeholderTile, { method: 'HEAD' });

		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('10');
		expect(await response.text()).toBe('');
	});

	it('passes a request to any other host straight through, arguments untouched', async () => {
		const seen: { input: unknown; init: unknown }[] = [];
		const network: FetchFn = async (input, init) => {
			seen.push({ input, init });
			return new Response('from the network');
		};
		const fetchImage = createStoreImageFetch({ store: await storeWithTile(), fetch: network });

		const init = { headers: { accept: 'image/jpeg' } };
		const remote = 'https://iiif.example.org/abc/0,0,256,256/256,256/0/default.jpg';
		const response = await fetchImage(remote, init);

		expect(await response.text()).toBe('from the network');
		// The same values, not a rebuilt URL: a remote IIIF service is entitled to the request
		// its caller made, including whatever headers a CORS or auth flow put on it.
		expect(seen).toEqual([{ input: remote, init }]);
	});

	it('passes a relative URL through rather than trying to parse it as a placeholder', async () => {
		const seen: unknown[] = [];
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			fetch: async (input) => {
				seen.push(input);
				return new Response('from the network');
			}
		});

		await fetchImage('/fixtures/images/floride-1657/info.json');

		expect(seen).toEqual(['/fixtures/images/floride-1657/info.json']);
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE ROOTING ITSELF (ADR-0023), which is the riskiest change in the epic because it cannot fail
	// loudly: a Project-rooted shim returns *another map's* bytes, at a plausible size, in the right
	// pane. So it is asserted from both sides — the Workspace bytes come back, and the Project-rooted
	// bytes are the ones that do not.

	it('resolves at the Workspace root, so one shim serves every Project', async () => {
		// No Project is named anywhere in the construction. There is nowhere to put one.
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		expect(await (await fetchImage(placeholderTile)).text()).toBe('tile bytes');
		expect(await (await fetchImage(`${imageServiceId('abc123')}/info.json`)).json()).toEqual({
			id: 'x'
		});
	});

	it('never answers with a pyramid that is inside a Project directory', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		// The decoy is a complete, readable pyramid under `amsterdam-1625/images/abc123/`. Nothing the
		// placeholder host can be asked reaches it.
		expect(await (await fetchImage(placeholderTile)).text()).not.toBe('the wrong tile');
		const info = await (await fetchImage(`${imageServiceId('abc123')}/info.json`)).text();
		expect(info).not.toContain('the wrong map');
	});

	// The half a Project-rooted shim got right by accident and this one gets right on purpose: two
	// Projects drawing the same Historical Map draw the same bytes, from the same place, through one
	// function. Under the old rooting each Project needed its own copy of the pyramid to draw at all.
	it('serves the same bytes to callers working in different Projects', async () => {
		const store = await storeWithTile();

		const mine = createStoreImageFetch({ store });
		const theirs = createStoreImageFetch({ store });

		expect(await (await mine(placeholderTile)).text()).toBe(
			await (await theirs(placeholderTile)).text()
		);
	});

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// A REFUSAL IS CAUGHT HERE, AND SAID (ticket 04, SPEC stories 14–21)
	//
	// This shim used to rethrow anything that was not "there is nothing there". The caller never sees
	// that promise: `@allmaps/render`'s `WarpedMap.loadImage` rethrows whatever `fetchFn` rejected
	// with, and `WebGL2Renderer.loadMissingImagesInViewport()` is called without `await` and without a
	// `.catch`, so it arrived as an uncaught `pageerror` — measured at three runs in eight — and on a
	// published site nobody is watching a console. So: never reject, and report.

	/** A store whose `read` fails the way `createHttpProjectStore` fails, on command. */
	const refusingStore = (fail: () => never): ReadOnlyProjectStore => ({
		read: async () => fail()
	});

	const outcomesOf = (store: ReadOnlyProjectStore) => {
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({
			store,
			onOutcome: (outcome) => outcomes.push(outcome)
		});
		return { fetchImage, outcomes };
	};

	it('answers a store that cannot be reached with a Response rather than a rejection', async () => {
		const { fetchImage, outcomes } = outcomesOf(
			refusingStore(() => {
				throw new SiteFileUnreachableError(
					'images/abc123/info.json',
					'images/abc123/info.json',
					0,
					'Failed to fetch'
				);
			})
		);

		const response = await fetchImage(`${imageServiceId('abc123')}/info.json`);

		// A Response, and one whose body upstream can read: `@allmaps/stdlib`'s `fetchUrl` calls
		// `response.json()` on any non-ok answer, so a plain-text body would turn a named refusal into
		// a `SyntaxError` naming nothing.
		expect(response.ok).toBe(false);
		expect(await response.json()).toEqual({ error: 'this site could not be reached.' });
		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'no-answer', host: null }, imageId: 'abc123' }
		]);
	});

	it('tells a server that answered apart from one that answered nothing', async () => {
		// The two message forms `SiteFileUnreachableError` carries, whose remedies are opposites.
		const { fetchImage, outcomes } = outcomesOf(
			refusingStore(() => {
				throw new SiteFileUnreachableError(
					'images/abc123/info.json',
					'https://maps.library.example/images/abc123/info.json',
					503,
					''
				);
			})
		);

		const response = await fetchImage(`${imageServiceId('abc123')}/info.json`);

		expect(response.status).toBe(503);
		expect(outcomes).toEqual([
			{
				ok: false,
				failure: { kind: 'server-error', host: 'maps.library.example', status: 503 },
				imageId: 'abc123'
			}
		]);
	});

	it('reports a missing info.json and stays silent about a missing tile', async () => {
		// **The distinction this whole reporting seam turns on.** `@allmaps/iiif-parser` derives its
		// own grid from the `info.json` and asks for cells the tiler never planned, so a complete,
		// healthy pyramid answers 404 to some requests on every load — `viewer-reader.e2e.ts` has to
		// exclude `/default.jpg` from its "no 404 for anything the page asked for" assertion for
		// exactly that reason. Reporting those would leave "this map stopped drawing" permanently on
		// screen over a map that is drawing.
		const { fetchImage, outcomes } = outcomesOf(await storeWithTile());

		expect((await fetchImage(`${imageServiceId('abc123')}/9,9,1,1/1,1/0/default.jpg`)).status).toBe(
			404
		);
		expect(outcomes).toEqual([]);

		expect((await fetchImage(`${imageServiceId('not-here')}/info.json`)).status).toBe(404);
		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'file-missing', host: null }, imageId: 'not-here' }
		]);
	});

	it('classifies a refusal it has no name for without borrowing another row’s remedy', async () => {
		const { fetchImage, outcomes } = outcomesOf(
			refusingStore(() => {
				throw new Error('the quota was exceeded');
			})
		);

		const response = await fetchImage(placeholderTile);

		expect(response.status).toBe(500);
		expect(outcomes).toEqual([
			{
				ok: false,
				failure: { kind: 'unreadable', host: null, detail: 'the quota was exceeded' },
				imageId: 'abc123'
			}
		]);
	});

	it('rethrows an abort untouched, because that is the renderer changing its mind', async () => {
		// Every viewport change aborts the tiles it no longer wants. Reporting those would raise the
		// notice on every pan; upstream already recognises `AbortError` by name and does nothing.
		const abort = new Error('The operation was aborted.');
		abort.name = 'AbortError';
		const { fetchImage, outcomes } = outcomesOf(
			refusingStore(() => {
				throw abort;
			})
		);

		await expect(fetchImage(placeholderTile)).rejects.toBe(abort);
		expect(outcomes).toEqual([]);
	});

	it('reports the pass-through half and rethrows it, because that answer is not this shim’s', async () => {
		// A referenced image on a Library's server (ADR-0023) is fetched over the ordinary network
		// path, and its failure is the "a Library's server is failing" row.
		//
		// ⚠ **Rethrown, unlike the store half.** Answering a pass-through rejection with a `Response`
		// the way the store half does broke `editor-remote-iiif.e2e.ts`'s cross-origin probe, which
		// tells a host whose tiles cannot be read cross-origin from a host that is merely busy **by
		// the rejection** — handed a synthetic 504 it reported the wrong one of two sentences a
		// scholar acts on. This shim owns what happens to a request it answers itself; a pass-through
		// request is the caller's, and so is its answer.
		const refusal = new TypeError('Failed to fetch');
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			fetch: () => Promise.reject(refusal),
			onOutcome: (outcome) => outcomes.push(outcome)
		});

		await expect(fetchImage('https://maps.library.example/iiif/x/info.json')).rejects.toBe(refusal);
		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'no-answer', host: 'maps.library.example' }, imageId: null }
		]);
	});

	it('says nothing at all while everything is arriving', async () => {
		// There is no notice to take down, so there is nothing to report. A shim that announced every
		// healthy tile would make the app's `onOutcome` the hottest callback on the page.
		const { fetchImage, outcomes } = outcomesOf(await storeWithTile());

		expect((await fetchImage(placeholderTile)).status).toBe(200);

		expect(outcomes).toEqual([]);
	});

	it('takes the notice down when the URL that was refused comes back, and not before', async () => {
		let refusing = true;
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if (refusing) throw new SiteFileUnreachableError(path, path, 0, 'Failed to fetch');
				return new TextEncoder().encode('bytes');
			}
		};
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({ store, onOutcome: (o) => outcomes.push(o) });

		await fetchImage(placeholderTile);
		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'no-answer', host: null }, imageId: 'abc123' }
		]);

		// **Some other URL arriving is not evidence about this one.** A map can be serving nine cells
		// happily while the tenth is refused, and a notice withdrawn on the nine is a notice withdrawn
		// over a hole.
		refusing = false;
		await fetchImage(`${imageServiceId('abc123')}/0,0,1,1/1,1/0/default.jpg`);
		expect(outcomes).toHaveLength(1);

		// The one that failed, arriving, is the whole signal.
		await fetchImage(placeholderTile);
		expect(outcomes.at(-1)).toEqual({ ok: true });
	});

	it('keeps the notice up while any refused URL is still missing, not just the last one', async () => {
		// ⚠ **Two outstanding at once, which is the row a one-at-a-time test cannot reach.** An
		// implementation that cleared the whole set whenever any refused URL came back — or that
		// reported `ok` on the first recovery rather than the last — passes every other test in this
		// file and takes the notice down over a map that is still short of a cell.
		const refusing = new Set([placeholderTile, `${imageServiceId('abc123')}/info.json`]);
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if ([...refusing].some((url) => url.endsWith(path.split('/').slice(2).join('/')))) {
					throw new SiteFileUnreachableError(path, path, 0, 'Failed to fetch');
				}
				return new TextEncoder().encode('bytes');
			}
		};
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({ store, onOutcome: (o) => outcomes.push(o) });

		await Promise.all([...refusing].map((url) => fetchImage(url)));
		expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(2);

		// The first of the two starts answering. The other has not, so nothing is withdrawn.
		refusing.delete(placeholderTile);
		await fetchImage(placeholderTile);
		expect(outcomes.filter((outcome) => outcome.ok)).toEqual([]);

		// Only when the last one comes back is the map whole again.
		refusing.clear();
		await fetchImage(`${imageServiceId('abc123')}/info.json`);
		expect(outcomes.at(-1)).toEqual({ ok: true });
	});

	it('keeps a partial outage’s notice up, concurrently and serially alike', async () => {
		// ⚠ **The row that killed the rule this replaced.** That rule withdrew the notice when a burst
		// of in-flight requests completed with no refusal in it, which is sound while requests overlap
		// and nonsense when they do not — requests issued one at a time each formed their own burst,
		// so the serial pass below produced three withdrawals instead of none. `@allmaps/render`
		// mostly fetches concurrently, but the tail of a burst and a re-fetched `info.json` are
		// serial, so the hole was reachable.
		//
		// ⚠ **The serial pass has to ISSUE the second request after the first has settled, not merely
		// collect it later.** The version of this test that shipped with the fix wrote
		// `const requests = [fetchImage(a), fetchImage(b)]` and then chose between `Promise.all` and a
		// `for … await` loop — but both promises are constructed by the array literal, so both fetches
		// were already in flight and the "serial" pass drove the concurrent shape a second time. It
		// passed against the old rule it claimed to have killed. Hence `issue`, which takes thunks.
		const refused = `${imageServiceId('abc123')}/256,0,256,256/256,256/0/default.jpg`;
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if (path.includes('256,0,')) throw new SiteFileUnreachableError(path, path, 0, 'no');
				return new TextEncoder().encode('bytes');
			}
		};

		/** Overlapping, or strictly one after the other — the distinction the whole test rests on. */
		const issue = async (
			concurrently: boolean,
			calls: readonly (() => Promise<unknown>)[]
		): Promise<void> => {
			if (concurrently) {
				await Promise.all(calls.map((call) => call()));
				return;
			}
			for (const call of calls) await call();
		};

		for (const concurrently of [true, false]) {
			const shape = concurrently ? 'concurrent' : 'serial';
			const outcomes: TileFetchOutcome[] = [];
			const fetchImage = createStoreImageFetch({ store, onOutcome: (o) => outcomes.push(o) });

			for (let round = 0; round < 3; round += 1) {
				await issue(concurrently, [() => fetchImage(placeholderTile), () => fetchImage(refused)]);
			}

			// Three rounds, three refusals, and not one withdrawal — even though every round also
			// carried a tile that arrived, and in the serial pass it arrived, alone and complete,
			// before the refusal was even issued.
			expect(
				outcomes.filter((outcome) => outcome.ok),
				shape
			).toEqual([]);
			expect(outcomes, shape).toHaveLength(3);
		}
	});

	it('does not report a refusal for bytes an overlapping request already brought back', async () => {
		// ⚠ **Reachable in the viewer today, and not only through ticket 05's probe.**
		// `BaseRenderer.loadMissingImagesInViewport` filters on `!warpedMap.fetchingImageInfo`, so one
		// `WarpedMap` never double-fetches — but `WarpedMap.loadImage` fills `imagesById` only AFTER
		// its fetch resolves, so **two Layers on the same `imageId`** (which ADR-0023 exists to make
		// legal, and the viewer supports) both fetch that one `info.json` at once. Mid-outage one can
		// fail while the other succeeds.
		//
		// With the failure settling LAST, a rule keyed on URL alone recorded a refusal for bytes the
		// page was already holding: a notice that never came down, over a map with nothing wrong with
		// it. Order decides nothing now.
		const url = `${imageServiceId('abc123')}/info.json`;
		let releaseRefusal: (() => void) | undefined;
		let firstRequest = true;
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if (firstRequest) {
					firstRequest = false;
					await new Promise<void>((resolve) => (releaseRefusal = resolve));
					throw new SiteFileUnreachableError(path, path, 0, 'slow refusal');
				}
				return new TextEncoder().encode('{"id":"x"}');
			}
		};
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({ store, onOutcome: (o) => outcomes.push(o) });

		// Both are issued before either settles, which is the whole shape.
		const slowRefusal = fetchImage(url);
		const quickArrival = await fetchImage(url);
		expect(quickArrival.status).toBe(200);
		releaseRefusal!();
		await slowRefusal;

		// Nothing was said, because nothing is missing: the page has those bytes.
		expect(outcomes).toEqual([]);
	});

	it('still reports a refusal that comes after the bytes it asked for arrived', async () => {
		// The other side of the rule above, so it cannot be satisfied by never reporting at all: a
		// request ISSUED after an arrival is about a later state of the world, and its failure is real.
		let refusing = false;
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if (refusing) throw new SiteFileUnreachableError(path, path, 0, 'gone again');
				return new TextEncoder().encode('bytes');
			}
		};
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({ store, onOutcome: (o) => outcomes.push(o) });

		await fetchImage(placeholderTile);
		refusing = true;
		await fetchImage(placeholderTile);

		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'no-answer', host: null }, imageId: 'abc123' }
		]);
	});

	it('does not take a notice down because a refused URL later answered with an error', async () => {
		// ⚠ **The `response.ok` gate on the pass-through half.** Without it, a URL that was refused and
		// then answers **500** counts as arrived — a notice withdrawn over a map that is still broken,
		// which is the exact failure this reporting rule was redesigned to prevent.
		let answer: 'reject' | 'error' | 'ok' = 'reject';
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			fetch: async () => {
				if (answer === 'reject') throw new TypeError('Failed to fetch');
				return answer === 'error'
					? new Response('the library is unwell', { status: 500 })
					: new Response('tile bytes');
			},
			onOutcome: (outcome) => outcomes.push(outcome)
		});
		const remote = 'https://maps.library.example/iiif/x/info.json';

		await expect(fetchImage(remote)).rejects.toThrow();
		expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);

		// A 500 is an answer, and it is not the bytes. The notice stays.
		answer = 'error';
		expect((await fetchImage(remote)).status).toBe(500);
		expect(outcomes.filter((outcome) => outcome.ok)).toEqual([]);

		// Bytes are the bytes.
		answer = 'ok';
		expect((await fetchImage(remote)).ok).toBe(true);
		expect(outcomes.at(-1)).toEqual({ ok: true });
	});

	it('describes a cause that cannot be turned into a string, rather than throwing over it', async () => {
		// ⚠ **A third way this module could reject, under a docblock saying there are exactly two.**
		// `throw` takes any value, and `String(Object.create(null))` throws `TypeError: Cannot convert
		// object to primitive value`. Escaping here means an unhandled rejection inside the renderer,
		// which is the one class this boundary exists to stop.
		for (const cause of [
			Object.create(null),
			{
				toString() {
					throw new Error('boom');
				}
			}
		]) {
			const { fetchImage } = outcomesOf(
				refusingStore(() => {
					throw cause;
				})
			);

			const response = await fetchImage(placeholderTile);
			expect(response.status).toBe(500);
		}
	});

	it('is not destroyed by a subscriber that throws, on a refusal or on bytes that arrived', async () => {
		// ⚠ **Ticket 01's `9ee43b5` defect, at a new seam.** `onOutcome` is application code called
		// from the middle of a fetch — once from a `catch`, once beside a 200 whose `Response` is
		// already built. Unguarded, a subscriber that throws turns a tile that ARRIVED into a rejected
		// promise, inside the one function in this epic whose purpose is that refusals do not escape
		// into a renderer.
		//
		// ⚠ **The subscriber's own error is not swallowed — it is rethrown out of band**, so it reaches
		// `window.onerror` in a browser and this suite's `pageerror` watch in the viewer. Node turns
		// that into an `uncaughtException`, which vitest would otherwise fail the run with, so the
		// process's handlers are swapped for the length of this test. That swap **is the assertion**
		// as much as the two below: if the module ever starts swallowing, `escaped` is empty.
		const saved = process.listeners('uncaughtException');
		const escaped: unknown[] = [];
		process.removeAllListeners('uncaughtException');
		process.on('uncaughtException', (cause) => escaped.push(cause));
		onTestFinished(() => {
			process.removeAllListeners('uncaughtException');
			for (const listener of saved) process.on('uncaughtException', listener);
		});

		let refusing = true;
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if (refusing) throw new SiteFileUnreachableError(path, path, 0, 'Failed to fetch');
				return new TextEncoder().encode('tile bytes');
			}
		};
		const fetchImage = createStoreImageFetch({
			store,
			onOutcome: () => {
				throw new Error('the subscriber blew up');
			}
		});

		// The refusal still becomes a Response…
		const refusal = await fetchImage(placeholderTile);
		expect(refusal.status).toBe(504);

		// …and the arrival still hands back its bytes, which is the half that matters most: the read
		// succeeded and the subscriber must not be able to throw over the return value.
		refusing = false;
		const arrival = await fetchImage(placeholderTile);
		expect(arrival.status).toBe(200);
		expect(await arrival.text()).toBe('tile bytes');

		// Both failures reached somewhere a person could see them, rather than nowhere.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(escaped.map((cause) => (cause as Error).message)).toEqual([
			'the subscriber blew up',
			'the subscriber blew up'
		]);
	});

	it('carries the cause into statusText, because two editor sentences are built from it', async () => {
		// `HistoricalMapPane.svelte` renders `${status} ${statusText}` at a scholar under ADR-0008, and
		// `tile-protocol.ts` throws it. Answering with a bare status turned `“abc123” could not be
		// opened: the quota was exceeded` into `… (500 )` — the cause lost and a dangling space left.
		const { fetchImage } = outcomesOf(
			refusingStore(() => {
				throw new Error('the quota was exceeded');
			})
		);

		const response = await fetchImage(placeholderTile);

		expect(response.statusText).toContain('the quota was exceeded');
	});

	it('cuts a very long cause short, because a reason-phrase is a label and not a log', async () => {
		const { fetchImage } = outcomesOf(
			refusingStore(() => {
				throw new Error('x'.repeat(20_000));
			})
		);

		expect((await fetchImage(placeholderTile)).statusText.length).toBe(200);
	});

	it('clamps a status a Response constructor would refuse', async () => {
		// `SiteFileUnreachableError.status` is a plain `number` on an exported class, and
		// `new Response(…, { status: 999 })` throws `RangeError` — out of the function that promises
		// not to reject for a request it answers. Newlines in the detail would throw too, from
		// `statusText`, so a multi-line message is folded rather than passed through.
		const { fetchImage } = outcomesOf(
			refusingStore(() => {
				throw new SiteFileUnreachableError(
					'images/abc123/info.json',
					'https://maps.library.example/x',
					999,
					'line one\nline two'
				);
			})
		);

		const response = await fetchImage(`${imageServiceId('abc123')}/info.json`);

		expect(response.status).toBe(500);
		expect(response.statusText).not.toContain('\n');
	});

	it('folds a detail Response would refuse, including the dashes this repo writes', async () => {
		// ⚠ **Measured, and narrower than it looks.** `statusText` throws `TypeError` for a newline,
		// for `NUL`, for `DEL` — and for **any character above US-ASCII**, which is not a hypothetical
		// here: this repository's own error prose is full of typographic dashes and curly quotes. A
		// version of this that folded only `< 0x20` threw on the shim's own wording.
		const { fetchImage } = outcomesOf(
			refusingStore(() => {
				throw new Error('the quota — “abc123” — was exceeded\u007f\u0000');
			})
		);

		const response = await fetchImage(placeholderTile);

		expect(response.statusText).toContain('the quota');
		expect(response.statusText).toContain('was exceeded');
		// The three clauses the docblock claims, which `Response` itself would tolerate the absence of
		// — so nothing but this would notice them going. Collapsed, trimmed, and bounded.
		expect(response.statusText).not.toMatch(/ {2}/);
		expect(response.statusText).toBe(response.statusText.trim());
		expect(response.statusText.length).toBeLessThanOrEqual(200);
		// Every surviving character is one a reason-phrase may hold.
		for (const character of response.statusText) {
			const code = character.codePointAt(0) ?? 0;
			expect(code === 0x09 || (code >= 0x20 && code <= 0x7e), JSON.stringify(character)).toBe(true);
		}
	});
});

describe('isImageServicePlaceholderUrl', () => {
	it('matches the reserved host and nothing else', () => {
		expect(isImageServicePlaceholderUrl(placeholderTile)).toBe(true);
		expect(isImageServicePlaceholderUrl('http://unset.invalid/a/b')).toBe(true);
		expect(isImageServicePlaceholderUrl('https://tiles.unset.invalid/a/b')).toBe(true);
		// A real host that merely ends in the same letters is not the placeholder, and a
		// relative URL is not a host at all.
		expect(isImageServicePlaceholderUrl('https://notunset.invalid/a/b')).toBe(false);
		expect(isImageServicePlaceholderUrl('https://iiif.example.org/a/b')).toBe(false);
		expect(isImageServicePlaceholderUrl('/fixtures/info.json')).toBe(false);
	});
});

describe('refuseUnroutedImageServiceRequests', () => {
	it('turns a placeholder request that escaped the injection layer into a named error', async () => {
		const reached: unknown[] = [];
		const scope = {
			fetch: (async (input) => {
				reached.push(input);
				return new Response('');
			}) as FetchFn
		};

		const restore = refuseUnroutedImageServiceRequests(scope);

		await expect(scope.fetch(placeholderTile)).rejects.toThrow(MissingImageServiceOverrideError);
		// The message has to name the override, because the alternative — what the browser says
		// on its own — is "TypeError: Failed to fetch" from a DNS failure, which diagnoses nothing.
		await expect(scope.fetch(placeholderTile)).rejects.toThrow(/Image#uri/);
		// And nothing left for the network: the request is refused before it is made.
		expect(reached).toEqual([]);

		await scope.fetch('https://iiif.example.org/info.json');
		expect(reached).toEqual(['https://iiif.example.org/info.json']);

		restore();
		await scope.fetch(placeholderTile);
		expect(reached).toHaveLength(2);
	});

	it('is idempotent, and its teardown does not undo somebody else’s wrapper', async () => {
		const scope = { fetch: (async () => new Response('')) as FetchFn };
		const original = scope.fetch;

		const restore = refuseUnroutedImageServiceRequests(scope);
		const wrapped = scope.fetch;
		const second = refuseUnroutedImageServiceRequests(scope);

		expect(scope.fetch).toBe(wrapped);
		second();
		expect(scope.fetch).toBe(wrapped);
		restore();
		expect(scope.fetch).toBe(original);
	});
});

/** A tiler whose bytes are the tile's own geometry, so a test can tell tiles apart. */
const stubTiler =
	(dimensions: { width: number; height: number }): OpenTileSource =>
	async () =>
		({
			dimensions,
			encodeTile: async (tile: PlannedTile) =>
				bytes(`${tile.scaleFactor}/${tile.column},${tile.row}`),
			close: async () => undefined
		}) satisfies TileSource;

/** A PNG header declaring `width` × `height`, so ingest routes on the header and not a decode. */
function pngHeader(width: number, height: number): Uint8Array {
	const header = new Uint8Array(24);
	header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(header.buffer).setUint32(16, width);
	new DataView(header.buffer).setUint32(20, height);
	return header;
}

describe('a pyramid the tiler wrote, read back through the pane', () => {
	/** Ingest one image into the Workspace and build the pane over it, store-backed throughout. */
	async function ingestAndOpen(width: number, height: number) {
		const store = new MemoryProjectStore();
		const result = await ingestImageFile({
			store,
			file: new File([pngHeader(width, height) as BlobPart], 'scan.png', { type: 'image/png' }),
			openDecodeAndCrop: stubTiler({ width, height })
		});

		const fetchImage = createStoreImageFetch({ store });
		const info = await (await fetchImage(`${imageServiceId(result.imageId)}/info.json`)).json();
		const pane = createImagePane(info, { storedImageId: result.imageId });

		return { store, result, pane, fetchImage };
	}

	it('resolves every tile of every level, ragged edges included, with nothing missing', async () => {
		const { result, pane, fetchImage } = await ingestAndOpen(700, 500);

		const tiles = pane.allTiles();
		expect(tiles).toHaveLength(result.tileCount);

		const statuses = await Promise.all(
			tiles.map(async (tile) => {
				const response = await fetchImage(tile.url);
				return { url: tile.url, status: response.status, body: await response.text() };
			})
		);

		// Not "most of them": a hole in this list is a hole in the pane, and the reader and the
		// writer agreeing everywhere is the whole reason both go through `getTileImageRequest`.
		expect(statuses.filter((tile) => tile.status !== 200)).toEqual([]);
		// Every tile the pane asked for is the tile the tiler wrote there, not merely *a* tile —
		// **paired per URL**, not compared as two sorted lists. Sorting both sides accepted any
		// bijection of the pyramid's paths, so a shim that resolved each URL to the *next* tile's
		// file would have answered 200 nine times, matched as a set, and drawn the pyramid scrambled.
		expect(
			statuses.map(({ url, body }) => ({ url, body })),
			'the pane and the tiler disagree about which tile is where'
		).toEqual(
			tiles.map((tile) => ({
				url: tile.url,
				body: `${tile.scaleFactor}/${tile.column},${tile.row}`
			}))
		);

		// Every level is represented, and the right and bottom margins are ragged at each of them.
		expect([...new Set(tiles.map((tile) => tile.scaleFactor))]).toEqual([1, 2, 4]);
		for (const scaleFactor of [1, 2, 4]) {
			const atLevel = tiles.filter((tile) => tile.scaleFactor === scaleFactor);
			expect(
				atLevel.some((tile) => tile.placement.width < pane.tileSize),
				`no ragged right-margin tile at scale factor ${scaleFactor}`
			).toBe(true);
			expect(
				atLevel.some((tile) => tile.placement.height < pane.tileSize),
				`no ragged bottom-margin tile at scale factor ${scaleFactor}`
			).toBe(true);
		}
	});

	it('builds tile URLs on the placeholder host, so the shim is the only way to reach them', async () => {
		const { result, pane } = await ingestAndOpen(700, 500);

		expect(pane.image.uri).toBe(imageServiceId(result.imageId));
		expect(pane.allTiles().every((tile) => isImageServicePlaceholderUrl(tile.url))).toBe(true);
	});

	/**
	 * Worst round-trip error over a grid of points deliberately **off** the binary grid.
	 *
	 * Ticket 03's review recorded why that matters: sample at integers or half-integers on a
	 * power-of-two window and `WINDOW_ORIGIN + t` comes out exact, so the measurement reads 0 and
	 * says nothing about float64. The strides below are chosen to be non-dyadic.
	 */
	const worstRoundTrip = (pane: ReturnType<typeof createImagePane>) => {
		let x = 0;
		let y = 0;
		const { width, height } = pane.image;

		for (let column = 0; column <= 97; column++) {
			for (let row = 0; row <= 89; row++) {
				const point = { x: (width * column) / 97 + 1 / 3, y: (height * row) / 89 + 1 / 7 };
				const back = pane.syntheticToResource(pane.resourceToSynthetic(point));
				x = Math.max(x, Math.abs(back.x - point.x));
				y = Math.max(y, Math.abs(back.y - point.y));
			}
		}

		return { x, y };
	};

	it('keeps the projection’s round-trip precision on a store-backed pyramid', async () => {
		// The measured number, against a pyramid that came out of the tiler rather than out of a
		// committed fixture. `ROUND_TRIP_TOLERANCE_PX` is a scaling law with documented headroom and
		// this slice must not be what spends it: where the bytes come from does not enter the
		// arithmetic, so the expected answer is that nothing changed at all.
		const { pane } = await ingestAndOpen(700, 500);
		const small = worstRoundTrip(pane);

		// And at a size a real archival scan reaches, where the window is large enough for the
		// error to be non-zero. Only `info.json` is written for this one — thirty thousand stub
		// tiles would measure the test's patience rather than the projection — and it is still read
		// back out of the store through the shim, which is what the pane depends on.
		const store = new MemoryProjectStore();
		const info = buildImageInfo({ imageId: 'big', width: 60000, height: 24000 });
		await store.write('images/big/info.json', serialiseJson(info));
		const fetchImage = createStoreImageFetch({ store });
		const large = worstRoundTrip(
			createImagePane(await (await fetchImage(`${imageServiceId('big')}/info.json`)).json(), {
				storedImageId: 'big'
			})
		);

		console.log(
			`store-backed round trip (worst Δ over 8 800 off-grid points), tolerance ` +
				`${ROUND_TRIP_TOLERANCE_PX} px:\n` +
				`  700 × 500, scale factors 1–4:      Δx ${small.x.toExponential(2)} px, ` +
				`Δy ${small.y.toExponential(2)} px\n` +
				`  60000 × 24000, scale factors 1–256: Δx ${large.x.toExponential(2)} px, ` +
				`Δy ${large.y.toExponential(2)} px`
		);

		for (const [label, worst] of [
			['700 × 500', small],
			['60000 × 24000', large]
		] as const) {
			expect(worst.x, `${label} Δx`).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(worst.y, `${label} Δy`).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
		}
	});

	it('keeps two images in one Workspace apart', async () => {
		const store = new MemoryProjectStore();
		const ingest = (width: number, height: number) =>
			ingestImageFile({
				store,
				file: new File([pngHeader(width, height) as BlobPart], 'scan.png', { type: 'image/png' }),
				openDecodeAndCrop: stubTiler({ width, height })
			});

		const wide = await ingest(700, 500);
		const tall = await ingest(300, 900);
		const fetchImage = createStoreImageFetch({ store });

		const panes = await Promise.all(
			[wide, tall].map(async (result) =>
				createImagePane(
					await (await fetchImage(`${imageServiceId(result.imageId)}/info.json`)).json(),
					{ storedImageId: result.imageId }
				)
			)
		);

		expect(panes.map((pane) => [pane.image.width, pane.image.height])).toEqual([
			[700, 500],
			[300, 900]
		]);

		// The two pyramids answer on their own ids and on nobody else's. Both hold a tile at
		// `0,0,256,256` — the same IIIF path in two images — so the id is doing the whole of the
		// work, and asking the wrong one is the failure a single shared prefix would hide.
		const [widePane, tallPane] = panes as [(typeof panes)[0], (typeof panes)[0]];
		const shared = '0,0,256,256/256,256/0/default.jpg';
		const wideShared = widePane.allTiles().find((tile) => tile.url.endsWith(shared))!;
		const tallShared = tallPane.allTiles().find((tile) => tile.url.endsWith(shared))!;

		expect(await (await fetchImage(wideShared.url)).text()).toBe('1/0,0');
		expect(await (await fetchImage(tallShared.url)).text()).toBe('1/0,0');
		expect(wideShared.url).not.toBe(tallShared.url);

		// And a tile only the wider image has is not there under the taller one's id: 700 pixels
		// wide is three columns at full resolution, 300 is two.
		const wideOnly = widePane
			.allTiles()
			.find((tile) => tile.column === 2 && tile.scaleFactor === 1)!;
		expect((await fetchImage(wideOnly.url)).status).toBe(200);
		expect(
			(await fetchImage(wideOnly.url.replace(wide.imageId, tall.imageId))).status,
			'one image answered for another'
		).toBe(404);
	});
});
