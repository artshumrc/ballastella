import { packTar, unpackTar, type TarEntry } from 'modern-tar';
import { describe, expect, it } from 'vitest';

import { ProjectFormatTooNewError } from '../project/project-file.js';
import { readReviewMark, REVIEW_MARK_PATH } from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { exportProjectBundle } from './export-project-bundle.js';
import { openProjectBundle, type ReviewDestination } from './open-project-bundle.js';
import { BundleRejectedError } from './project-bundle.js';
import type { TransferProgress } from './transfer.js';
import { createViewerFileFilter } from './viewer-files.js';

// SPEC's Seam 1 for ticket 14: "the bundle holds exactly these entries" and "after opening it, the
// Review Workspace holds exactly these files" are not proxies for the behaviour, they *are* it. The
// in-memory `ProjectStore` stands in for nothing.
//
// The premise this suite is built on — that `modern-tar` really streams, really carries long and
// non-ASCII paths, and really throws on a truncated archive — is measured separately in
// `tar-format.test.ts`, which imports nothing from this package. Keep the two apart: that file is
// about the library, this one is about us.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const projectJson = (overrides: Record<string, unknown> = {}): string =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2025-03-04T11:22:33.000Z',
			layers: [
				{
					id: 'l1',
					name: 'The 1625 plan',
					visible: true,
					order: 0,
					kind: 'map',
					opacity: 0.8,
					imageId: 'amsterdam-1625'
				},
				{
					id: 'l2',
					name: 'Warehouses',
					visible: true,
					order: 1,
					kind: 'annotation',
					geojsonRef: 'annotations/warehouses.geojson'
				}
			],
			baseMap: 'protomaps-light',
			...overrides
		},
		null,
		'\t'
	)}\n`;

/**
 * A Workspace with **two Projects and two Historical Maps**, only one of each pair belonging to the
 * Project that gets exported.
 *
 * This is the shape the first acceptance criterion is about: a bundle carries the Project it names
 * and the shared material *that Project's Layers reference*, and not the Workspace's other maps. A
 * fixture with one Project and one map could not tell a bundle from a backup.
 */
const twoProjectsTwoMaps = (): Record<string, string> => ({
	'amsterdam-1625/project.json': projectJson({ name: 'Amsterdam 1625' }),
	'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'the-canal-ring/project.json': projectJson({
		name: 'The Canal Ring',
		layers: [
			{ id: 'l9', name: 'Blaeu', visible: true, order: 0, kind: 'map', imageId: 'blaeu-1649' }
		]
	}),
	// alignment-write-is-the-fixture: the Alignments already on disk that a bundle has to carry out verbatim; nothing here writes one through the app
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'not really a jpeg, but bytes',
	// The other Project's map. A bundle of `amsterdam-1625` must not carry a byte of it.
	// alignment-write-is-the-fixture: the second map's Alignment, seeded so that leaving it out of the bundle is assertable
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	'images/blaeu-1649/0,0,256,256/256,256/0/default.jpg': 'somebody else’s tile'
});

function seed(files: Record<string, string>): MemoryProjectStore {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) {
		store.plant(path as StorePath, encode(content));
	}
	return store;
}

/** Everything in a store, as plain strings, for whole-Workspace equality assertions. */
function contents(store: MemoryProjectStore): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [path, bytes] of store.snapshot()) out[path] = decode(bytes);
	return out;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
	}
	const out = new Uint8Array(new ArrayBuffer(chunks.reduce((n, c) => n + c.length, 0)));
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

// `Uint8Array<ArrayBuffer>` rather than a bare `Uint8Array`, matching the store's own `Bytes`: a
// `Blob` will not take a view that might be over a `SharedArrayBuffer`.
const streamOf = (bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array> =>
	new Blob([bytes]).stream();

const bundleOf = async (
	store: MemoryProjectStore,
	directory: string,
	options?: Parameters<typeof exportProjectBundle>[2]
): Promise<Uint8Array<ArrayBuffer>> =>
	collect((await exportProjectBundle(store, directory, options)).body);

/**
 * A hand-built archive, for the bundles a stranger sends that our exporter could not have made.
 *
 * Pairs rather than a record, so two entries can share a name — which is not a contrivance: a tar has
 * no index and nothing in the format forbids it, and it is how the declined-Alignment path is
 * reached.
 */
const handBuilt = async (
	files: readonly (readonly [string, string])[]
): Promise<Uint8Array<ArrayBuffer>> => {
	const entries: TarEntry[] = files.map(([name, content]) => ({
		header: { name, size: encode(content).length, type: 'file' },
		body: encode(content)
	}));
	return (await packTar(entries)) as Uint8Array<ArrayBuffer>;
};

/** {@link handBuilt} for the ordinary case, where every entry has a distinct name. */
const handBuiltFrom = (files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> =>
	handBuilt(Object.entries(files));

/**
 * A Review destination that records whether it was discarded.
 *
 * `discarded` is asserted rather than inferred from the store being empty, because "the Workspace
 * was thrown away" and "nothing was written into it" are different claims and only the first one
 * makes the refusals' closing sentence true.
 */
function destination(name = 'Amsterdam 1625'): {
	open: (preferred: string) => Promise<ReviewDestination>;
	store: MemoryProjectStore;
	asked: string[];
	discarded: () => boolean;
} {
	const store = new MemoryProjectStore();
	const asked: string[] = [];
	let discarded = false;
	return {
		store,
		asked,
		discarded: () => discarded,
		open: async (preferred: string) => {
			asked.push(preferred);
			return {
				name,
				store,
				discard: async () => {
					discarded = true;
					for (const path of await store.list('')) await store.delete(path);
				}
			};
		}
	};
}

describe('a Project exports to one self-contained bundle', () => {
	// Acceptance criterion 1. The negative half is the point: two Projects and two maps are seeded, and
	// what must **not** be in the archive is asserted by equality rather than by a `not.toContain`,
	// which would pass for an archive that also carried the whole Workspace.
	it('carries the Project and only the shared material its Layers reference', async () => {
		const store = seed(twoProjectsTwoMaps());

		const bundle = await exportProjectBundle(store, 'amsterdam-1625');

		expect(bundle.fileName).toBe('amsterdam-1625.project.tar');
		expect(bundle.totalFiles).toBe(5);
		const entries = await unpackTar(await collect(bundle.body), { strict: true });
		expect(entries.map((entry) => entry.header.name)).toEqual([
			'alignments/amsterdam-1625.json',
			'annotations/warehouses.geojson',
			'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg',
			'images/amsterdam-1625/info.json',
			'project.json'
		]);
	});

	// Project-relative, exactly as the zip's were, which is what lets the reader choose the directory
	// name — a Project's identity is its directory (ADR-0008) and the archive must not carry one.
	it('is rooted at project.json rather than at a directory named after the Project', async () => {
		const store = seed(twoProjectsTwoMaps());

		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });

		expect(entries.map((entry) => entry.header.name)).not.toContain('amsterdam-1625/project.json');
		expect(entries.map((entry) => entry.header.name)).toContain('project.json');
	});

	it('refuses to export a Project that is not there', async () => {
		const store = seed(twoProjectsTwoMaps());

		await expect(exportProjectBundle(store, 'no-such-project')).rejects.toThrow(
			'no-such-project/project.json'
		);
	});

	// ADR-0006, and the reason the exclusion is injected rather than hard-coded: what the *mechanism*
	// does is assertable without depending on what happens to be in `VIEWER_FILE_PATHS` this month.
	it('leaves out the published viewer files', async () => {
		const store = seed({
			...twoProjectsTwoMaps(),
			'amsterdam-1625/index.html': '<!doctype html>'
		});

		const entries = await unpackTar(
			await bundleOf(store, 'amsterdam-1625', {
				excluded: createViewerFileFilter(['index.html'])
			}),
			{ strict: true }
		);

		expect(entries.map((entry) => entry.header.name)).not.toContain('index.html');
	});

	// Byte-reproducibility is what makes the round-trip test below able to assert *lossless* rather
	// than *plausible*: a constant mtime and a locale-independent sort.
	it('produces identical bytes for the same Project twice', async () => {
		const store = seed(twoProjectsTwoMaps());

		const once = await bundleOf(store, 'amsterdam-1625');
		const twice = await bundleOf(store, 'amsterdam-1625');

		expect(Array.from(twice)).toEqual(Array.from(once));
	});

	// A Project from a newer version of the app is exactly the one a user most needs to get out of a
	// browser they cannot see into, so export never parses `project.json` as a Project (ADR-0010).
	it('exports a Project from a newer version of the app', async () => {
		const store = seed({
			...twoProjectsTwoMaps(),
			'amsterdam-1625/project.json': projectJson({ formatVersion: 99 })
		});

		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });

		expect(entries.map((entry) => entry.header.name)).toContain('project.json');
		// And the shared material still comes with it: the Layer stack is read through `parseLayers`,
		// which has no `formatVersion` opinion, rather than through `parseProjectFile`.
		expect(entries.map((entry) => entry.header.name)).toContain('images/amsterdam-1625/info.json');
	});

	it('exports a Project whose project.json will not parse at all, without its shared material', async () => {
		const store = seed({
			...twoProjectsTwoMaps(),
			'amsterdam-1625/project.json': '{ this is not json'
		});

		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });

		// Getting the bytes out still works, which is the property that matters; the archive is then
		// missing the image and is refused on the way back in, which the reader's own tests cover.
		expect(entries.map((entry) => entry.header.name)).toEqual([
			'annotations/warehouses.geojson',
			'project.json'
		]);
	});

	it('reports progress over every file', async () => {
		const store = seed(twoProjectsTwoMaps());
		const seen: TransferProgress[] = [];

		await collect(
			(await exportProjectBundle(store, 'amsterdam-1625', { onProgress: (p) => seen.push(p) })).body
		);

		expect(seen.at(-1)?.files).toBe(5);
		expect(seen.at(-1)?.totalFiles).toBe(5);
	});
});

describe('a bundle opens into a Review Workspace', () => {
	// Acceptance criterion 2, and the round trip: everything the bundle carried lands, split the way
	// ADR-0023 splits it — the Project's own files inside its directory, the shared material at the
	// Workspace root.
	it('holds exactly that one Project, with the shared material hoisted', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();

		const opened = await openProjectBundle(
			streamOf(await bundleOf(source, 'amsterdam-1625')),
			into.open,
			{ fileName: 'amsterdam-1625.project.tar' }
		);

		expect(opened.directory).toBe('amsterdam-1625');
		expect(opened.project.name).toBe('Amsterdam 1625');
		expect(contents(into.store)).toEqual({
			'review.json': expect.any(String),
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, as bytes to be packed into a tar; nothing here writes to a store
			'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
			'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
			'amsterdam-1625/project.json': projectJson({ name: 'Amsterdam 1625' }),
			'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'not really a jpeg, but bytes',
			'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}'
		});
		expect(into.discarded()).toBe(false);
	});

	// The mark is what makes the banner appear, and it names what was opened. Criterion 5's core half.
	it('marks the Workspace, naming the Project that was opened', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();

		await openProjectBundle(streamOf(await bundleOf(source, 'amsterdam-1625')), into.open, {
			fileName: 'amsterdam-1625.project.tar',
			now: () => new Date('2026-08-08T09:00:00.000Z')
		});

		expect(await readReviewMark(into.store)).toEqual({
			formatVersion: 1,
			project: 'Amsterdam 1625',
			directory: 'amsterdam-1625',
			openedAt: '2026-08-08T09:00:00.000Z'
		});
	});

	// ⚠ The order is the design. A mark written last would leave an interrupted open looking exactly
	// like the user's own Workspace, which is the failure ADR-0024 is built to prevent.
	it('marks the Workspace before it writes a single Project byte', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();
		/** Every path the store held at the moment the first Project file was written. */
		let whenFirstProjectFileLanded: string[] | null = null;
		const store = into.store;
		const write = store.write.bind(store);
		store.write = async (path, bytes) => {
			if (whenFirstProjectFileLanded === null && path !== REVIEW_MARK_PATH) {
				whenFirstProjectFileLanded = [...store.snapshot().keys()];
			}
			return write(path, bytes);
		};

		await openProjectBundle(streamOf(await bundleOf(source, 'amsterdam-1625')), into.open, {
			fileName: 'amsterdam-1625.project.tar'
		});

		expect(whenFirstProjectFileLanded).toEqual([REVIEW_MARK_PATH]);
	});

	// Criterion 7's core half: two bundles naming the same image id with different Control Points
	// never meet, because each is in its own Workspace. This is the collision the whole design exists
	// to prevent, so it is the thing that is tested.
	it('keeps two bundles’ conflicting Alignments of one map apart', async () => {
		const mine = seed({
			...twoProjectsTwoMaps(),
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, as bytes to be packed into a tar; nothing here writes to a store
			'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"student A"}'
		});
		const theirs = seed({
			...twoProjectsTwoMaps(),
			// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, as bytes to be packed into a tar; nothing here writes to a store
			'alignments/amsterdam-1625.json': '{"type":"Annotation","controlPoints":"student B"}'
		});
		const first = destination('Amsterdam 1625');
		const second = destination('Amsterdam 1625 (2)');

		await openProjectBundle(streamOf(await bundleOf(mine, 'amsterdam-1625')), first.open, {
			fileName: 'a.project.tar'
		});
		await openProjectBundle(streamOf(await bundleOf(theirs, 'amsterdam-1625')), second.open, {
			fileName: 'b.project.tar'
		});

		expect(decode(await first.store.read('alignments/amsterdam-1625.json' as StorePath))).toBe(
			'{"type":"Annotation","controlPoints":"student A"}'
		);
		expect(decode(await second.store.read('alignments/amsterdam-1625.json' as StorePath))).toBe(
			'{"type":"Annotation","controlPoints":"student B"}'
		);
	});

	// ⚠ **The declined path ticket 13 could not reach.** `writeRestored`'s decline was unreachable
	// while every destination was new; a bundle reaches it, because a tar has no index and nothing
	// stops an archive from naming a path twice. The first entry wins and the second is *reported*
	// rather than silently overwriting it — a transfer that quietly delivers something other than what
	// it was handed is the failure this format change escaped.
	it('declines a second Alignment for one map, keeps the first, and says so', async () => {
		const into = destination();
		// Two entries under exactly the same name, which is why {@link handBuilt} takes pairs.
		const archive = await handBuilt([
			['project.json', projectJson()],
			['annotations/warehouses.geojson', '{"type":"FeatureCollection","features":[]}'],
			['images/amsterdam-1625/info.json', '{"width":1,"height":1}'],
			['alignments/amsterdam-1625.json', '{"first":true}'],
			['alignments/amsterdam-1625.json', '{"second":true}']
		]);

		const opened = await openProjectBundle(streamOf(archive), into.open, {
			fileName: 'amsterdam-1625.project.tar'
		});

		expect(decode(await into.store.read('alignments/amsterdam-1625.json' as StorePath))).toBe(
			'{"first":true}'
		);
		expect(opened.declined).toEqual(['alignments/amsterdam-1625.json']);
		// Counted nowhere, and named in the sentence the user reads.
		expect(opened.totalFiles).toBe(4);
		expect(opened.notice).toContain('alignments/amsterdam-1625.json');
	});

	it('names the Review Workspace and the Project directory after the file that was picked', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();

		const opened = await openProjectBundle(
			streamOf(await bundleOf(source, 'amsterdam-1625')),
			into.open,
			{ fileName: 'Ada’s Amsterdam.project.tar' }
		);

		expect(into.asked).toEqual(['Ada s Amsterdam']);
		expect(opened.directory).toBe('ada-s-amsterdam');
	});

	// ADR-0023: a Project may not land on `images/`, `alignments/`, or `base-map/`, or `project.json`
	// and `annotations/` would go inside the shared pool the hoisted material also lands in.
	it('refuses to name the Project directory after a directory the Workspace needs', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();

		const opened = await openProjectBundle(
			streamOf(await bundleOf(source, 'amsterdam-1625')),
			into.open,
			{ fileName: 'Images.project.tar' }
		);

		expect(opened.directory).toBe('images-project');
		expect(decode(await into.store.read('images-project/project.json' as StorePath))).toContain(
			'Amsterdam 1625'
		);
	});

	it('writes project.json last, so an interrupted open lists no Project', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();
		const written: string[] = [];
		const store = into.store;
		const write = store.write.bind(store);
		store.write = async (path, bytes) => {
			written.push(path);
			return write(path, bytes);
		};

		await openProjectBundle(streamOf(await bundleOf(source, 'amsterdam-1625')), into.open, {
			fileName: 'amsterdam-1625.project.tar'
		});

		// The Workspace's list of Projects *is* whichever directories hold a `project.json` (ADR-0008),
		// so this is what stands between an interrupted open and a Project on the hub with half its
		// Layers missing. The final mark is written after it, which is not a Project file.
		expect(written.filter((path) => path.endsWith('project.json'))).toEqual([
			'amsterdam-1625/project.json'
		]);
		expect(written.indexOf('amsterdam-1625/project.json')).toBe(written.length - 2);
	});

	it('reports progress over every entry', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();
		const seen: TransferProgress[] = [];

		await openProjectBundle(streamOf(await bundleOf(source, 'amsterdam-1625')), into.open, {
			fileName: 'amsterdam-1625.project.tar',
			onProgress: (progress) => seen.push(progress)
		});

		expect(Math.max(...seen.map((progress) => progress.files))).toBe(4);
	});
});

describe('a bundle that will not be opened leaves nothing behind', () => {
	const refusal = async (
		archive: Uint8Array<ArrayBuffer>,
		options: Parameters<typeof openProjectBundle>[2] = {}
	): Promise<{ cause: unknown; into: ReturnType<typeof destination> }> => {
		const into = destination();
		const cause = await openProjectBundle(streamOf(archive), into.open, {
			fileName: 'amsterdam-1625.project.tar',
			...options
		}).catch((thrown: unknown) => thrown);
		return { cause, into };
	};

	it('refuses something that is not a tar at all, and never makes a Workspace', async () => {
		const { cause, into } = await refusal(
			encode('this is a JPEG, honestly') as Uint8Array<ArrayBuffer>
		);

		expect(cause).toBeInstanceOf(BundleRejectedError);
		expect((cause as BundleRejectedError).reason).toBe('not-a-tar');
		expect((cause as Error).message).toContain('Nothing has been opened.');
		expect(contents(into.store)).toEqual({});
	});

	// The failure the zip could not report at all: a short archive that came back plausibly short.
	// Every cut `tar-format.test.ts` tried raised rather than yielding a truncated archive, and this
	// asserts that the raise reaches the user as a sentence they can act on.
	it('refuses a bundle whose download stopped half way, and discards the Workspace', async () => {
		const source = seed(twoProjectsTwoMaps());
		const whole = await bundleOf(source, 'amsterdam-1625');

		const { cause, into } = await refusal(whole.slice(0, whole.length - 2048));

		expect(cause).toBeInstanceOf(BundleRejectedError);
		expect((cause as Error).message).toContain('may not have downloaded completely');
		expect(into.discarded()).toBe(true);
		expect(contents(into.store)).toEqual({});
	});

	it('refuses an archive with no project.json at its root', async () => {
		const { cause, into } = await refusal(
			await handBuiltFrom({ 'annotations/warehouses.geojson': '{"type":"FeatureCollection"}' })
		);

		expect((cause as BundleRejectedError).reason).toBe('no-project-file');
		expect(into.discarded()).toBe(true);
		expect(contents(into.store)).toEqual({});
	});

	it('refuses an archive carrying project.json twice', async () => {
		const archive = await handBuilt([
			['project.json', projectJson()],
			['project.json', projectJson()]
		]);

		const { cause, into } = await refusal(archive);

		expect((cause as BundleRejectedError).reason).toBe('duplicate-manifest');
		expect(into.discarded()).toBe(true);
	});

	// Criterion 12. ADR-0010's refusal, re-ended for this path: "it has been left untouched" describes
	// a Project in the Workspace, and there is none here.
	it('refuses a Project from a newer version of the app, and creates nothing', async () => {
		const { cause, into } = await refusal(
			await handBuiltFrom({ 'project.json': projectJson({ formatVersion: 99 }) })
		);

		expect(cause).toBeInstanceOf(ProjectFormatTooNewError);
		expect((cause as Error).message).toContain('Nothing has been opened.');
		// The remedy is named, which is the whole of ADR-0010's refusal.
		expect((cause as Error).message).toContain('ballastella');
		expect(into.discarded()).toBe(true);
		expect(contents(into.store)).toEqual({});
	});

	it.each([
		['../../elsewhere.json', 'climbs out of the Project'],
		['/etc/passwd', 'is an absolute path'],
		['a\\b.json', 'uses a backslash as a separator'],
		['a//b.json', 'contains an empty path segment']
	])('refuses an entry named %j', async (name, why) => {
		const { cause, into } = await refusal(
			await handBuiltFrom({ 'project.json': projectJson(), [name]: 'x' })
		);

		expect((cause as BundleRejectedError).reason).toBe('path-traversal');
		expect((cause as Error).message).toContain(why);
		expect(into.discarded()).toBe(true);
		expect(contents(into.store)).toEqual({});
	});

	// The store's reserved suffix marks a path `list` hides, so an entry claiming one is asking to put
	// a file in the Workspace that nothing there can see.
	it('refuses an entry using the reserved unfinished-write suffix', async () => {
		const { cause } = await refusal(
			await handBuiltFrom({ 'project.json': projectJson(), 'a.ballastella-tmp': 'x' })
		);

		expect((cause as BundleRejectedError).reason).toBe('path-traversal');
		expect((cause as Error).message).toContain('reserves for its own unfinished writes');
	});

	// Criterion 13, and the reason `assertReferencesPresent` is checked after the writing rather than
	// before it: a tar has no index, so the path set is only complete when the archive ends. Safe only
	// because the destination is thrown away.
	it('refuses a bundle missing a file a Layer needs, and discards what it wrote', async () => {
		const { cause, into } = await refusal(
			await handBuiltFrom({
				'project.json': projectJson(),
				'annotations/warehouses.geojson': '{"type":"FeatureCollection"}',
				'images/amsterdam-1625/info.json': '{"width":1,"height":1}'
				// No `alignments/amsterdam-1625.json`, which the map Layer names.
			})
		);

		expect((cause as BundleRejectedError).reason).toBe('missing-reference');
		expect((cause as Error).message).toContain('alignments/amsterdam-1625.json');
		expect((cause as Error).message).toContain('The 1625 plan');
		expect(into.discarded()).toBe(true);
		expect(contents(into.store)).toEqual({});
	});

	it('refuses a bundle whose map Layer has no image directory at all', async () => {
		const { cause } = await refusal(
			await handBuiltFrom({
				'project.json': projectJson(),
				'annotations/warehouses.geojson': '{"type":"FeatureCollection"}',
				// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, as bytes to be packed into a tar; nothing here writes to a store
				'alignments/amsterdam-1625.json': '{}'
			})
		);

		expect((cause as BundleRejectedError).reason).toBe('missing-reference');
		expect((cause as Error).message).toContain('images/amsterdam-1625/');
	});

	// A referenced image keeps `remote.json` instead of `info.json`, because its tiles and its
	// `info.json` are on somebody else's server. Requiring `info.json` of both would mean a scholar
	// could not open their own export.
	it('accepts an image directory that describes itself with remote.json', async () => {
		const into = destination();

		const opened = await openProjectBundle(
			streamOf(
				await handBuiltFrom({
					'project.json': projectJson(),
					'annotations/warehouses.geojson': '{"type":"FeatureCollection"}',
					// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, as bytes to be packed into a tar; nothing here writes to a store
					'alignments/amsterdam-1625.json': '{}',
					'images/amsterdam-1625/remote.json': '{"service":"https://a.library.example/iiif/x"}'
				})
			),
			into.open,
			{ fileName: 'amsterdam-1625.project.tar' }
		);

		expect(opened.project.name).toBe('Amsterdam 1625');
	});

	it('refuses an image directory that describes itself as neither', async () => {
		const { cause } = await refusal(
			await handBuiltFrom({
				'project.json': projectJson(),
				'annotations/warehouses.geojson': '{"type":"FeatureCollection"}',
				// alignment-write-is-the-fixture: the Alignment a bundle fixture carries, as bytes to be packed into a tar; nothing here writes to a store
				'alignments/amsterdam-1625.json': '{}',
				'images/amsterdam-1625/0,0,1,1/1,1/0/default.jpg': 'a tile and nothing else'
			})
		);

		expect((cause as BundleRejectedError).reason).toBe('missing-reference');
		expect((cause as Error).message).toContain('images/amsterdam-1625/info.json');
	});

	// Criterion 14. Refused *beforehand*, with the numbers, rather than discovered at eighty per cent —
	// and before the Review Workspace exists at all, which is what `asked` being empty asserts.
	it('refuses a bundle there is no room for, before making a Workspace', async () => {
		const into = destination();

		const cause = await openProjectBundle(
			streamOf(await handBuiltFrom({ 'project.json': projectJson() })),
			into.open,
			{
				fileName: 'amsterdam-1625.project.tar',
				archiveBytes: 900_000_000,
				estimateStorage: async () => ({ quota: 1_000_000_000, usage: 950_000_000 })
			}
		).catch((thrown: unknown) => thrown);

		expect((cause as BundleRejectedError).reason).toBe('insufficient-quota');
		expect((cause as Error).message).toContain('900 MB');
		expect(into.asked).toEqual([]);
		expect(contents(into.store)).toEqual({});
	});

	// A browser that will not answer is not a browser that has said no. Refusing because the quota API
	// is unavailable would refuse on exactly the browsers ADR-0001 makes this path the only way out of.
	it('opens when the browser will not answer about storage', async () => {
		const source = seed(twoProjectsTwoMaps());
		const into = destination();

		const opened = await openProjectBundle(
			streamOf(await bundleOf(source, 'amsterdam-1625')),
			into.open,
			{
				fileName: 'amsterdam-1625.project.tar',
				archiveBytes: 900_000_000,
				estimateStorage: async () => null
			}
		);

		expect(opened.project.name).toBe('Amsterdam 1625');
	});

	it('refuses an archive with more entries than one Project is', async () => {
		const { cause, into } = await refusal(
			await handBuiltFrom({
				'a.json': '1',
				'b.json': '2',
				'c.json': '3',
				'project.json': projectJson()
			}),
			{ limits: { entries: 2 } }
		);

		expect((cause as BundleRejectedError).reason).toBe('too-large');
		expect(into.discarded()).toBe(true);
	});

	it('refuses a project.json that is a document rather than a manifest', async () => {
		const { cause, into } = await refusal(await handBuiltFrom({ 'project.json': projectJson() }), {
			limits: { manifestBytes: 8 }
		});

		expect((cause as BundleRejectedError).reason).toBe('too-large');
		expect(into.discarded()).toBe(true);
	});
});
