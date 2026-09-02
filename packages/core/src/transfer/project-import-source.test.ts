// The shared source contract for Project Import (ADR-0037).
//
// **One suite for three adapters, because the claim under test is that they agree.** A Project
// offered as a Project Bundle, as a Project on a Published Site, and as the Project in a Review
// Workspace has to report the *same* closure — so the fixture is one Workspace, the three sources are
// derived from it, and the membership assertion is a single expected list compared against all three.
// A suite per adapter could not make that claim at all; it would only prove each one self-consistent.
//
// The refusals are asserted once each, at whichever adapter can provoke them most directly, because
// an adapter is worth testing only for the closure gathering that is specific to its source — an
// unsafe path and a repeated entry are things a tar can hold and a `list` cannot, and a file that
// disappears between being listed and being read is easiest to stage against a store.

import { packTar, type TarEntry } from 'modern-tar';
import { describe, expect, it } from 'vitest';

import { ProjectFormatTooNewError } from '../project/project-file.js';
import { REVIEW_MARK_FORMAT_VERSION, type ReviewMark } from '../project/review-workspace.js';
import { GITHUB_RAW_ORIGIN } from '../remote/github-api.js';
import { createFakeGitHub } from '../remote/fake-github.js';
import { readRemoteProjectSource } from '../remote/remote-project-source.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import {
	PathNotFoundError,
	type Bytes,
	type EnumerableReadOnlyProjectStore,
	type StorePath
} from '../store/project-store.js';
import { exportProjectBundle } from './export-project-bundle.js';
import { readProjectBundleSource } from './project-bundle-source.js';
import { ImportSourceRefusedError, type ProjectImportSource } from './project-import-source.js';
import { readReviewWorkspaceSource } from './review-workspace-source.js';

const OWNER = 'ada';
const REPOSITORY = 'atlas';
const DIRECTORY = 'amsterdam-1625';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

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
				},
				// The ordinary state ADR-0023 describes: a Map Image added to a Project is a Layer from
				// that moment, aligned or not. Its absent Alignment must not be a missing reference.
				{
					id: 'l3',
					name: 'The unplaced sheet',
					visible: true,
					order: 2,
					kind: 'map',
					opacity: 1,
					imageId: 'unaligned-map'
				},
				// A second Layer on the *same* Map Image, so "each distinct referenced Map Image" is
				// assertable rather than accidentally true of a fixture with one Layer per map.
				{
					id: 'l4',
					name: 'The 1625 plan again',
					visible: true,
					order: 3,
					kind: 'map',
					opacity: 0.4,
					imageId: 'amsterdam-1625'
				}
			],
			baseMap: 'protomaps-light',
			...overrides
		},
		null,
		'\t'
	)}\n`;

/**
 * One Workspace, laid out as ADR-0008 lays one out, holding everything that must **not** travel.
 *
 * A second Project, a Map Image no Layer of the imported Project draws, that map's Alignment, the
 * Workspace's Remote binding, its Review mark, its offline Base Map tiles, and — inside the imported
 * Project's own directory — the generated Published Site output somebody unpacked there. A fixture
 * with one Project and one map could not tell a closure from a Workspace.
 */
const WORKSPACE: Record<string, string> = {
	[`${DIRECTORY}/project.json`]: projectJson(),
	[`${DIRECTORY}/annotations/warehouses.geojson`]: '{"type":"FeatureCollection","features":[]}',
	// Referenced by nothing. ADR-0037's closure is the Annotations the Layers *name*.
	[`${DIRECTORY}/annotations/superseded.geojson`]: '{"type":"FeatureCollection","features":[1]}',
	// Generated Published Site output, inside the Project directory (ADR-0006's warning).
	[`${DIRECTORY}/index.html`]: '<!doctype html><title>Amsterdam</title>',
	[`${DIRECTORY}/_app/app.js`]: 'export const start = () => {};',
	[`${DIRECTORY}/base-map/glyphs/0.pbf`]: 'glyph bytes',

	'the-canal-ring/project.json': projectJson({
		name: 'The Canal Ring',
		layers: [
			{ id: 'l9', name: 'Blaeu', visible: true, order: 0, kind: 'map', imageId: 'blaeu-1649' }
		]
	}),
	'the-canal-ring/annotations/canals.geojson': '{"type":"FeatureCollection","features":[]}',

	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
	'images/unaligned-map/info.json': '{"width":512,"height":512}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	'images/blaeu-1649/0/0/0.jpg': 'somebody else’s tile',

	// alignment-write-is-the-fixture: the Alignments as they already sit in the Workspace, which a source reader carries out verbatim; nothing here writes one through the app
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	// alignment-write-is-the-fixture: the unused map's Alignment, seeded so that leaving it out of the closure is assertable
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}',

	'ballastella-site.json': '{"formatVersion":2,"projects":[]}',
	'review.json': JSON.stringify({
		formatVersion: 1,
		project: 'Amsterdam 1625',
		directory: DIRECTORY
	}),
	'base-map/tiles/protomaps/0/0/0.mvt': 'tile bytes'
};

/** Everything Import copies out of {@link WORKSPACE}, Project-relative, and nothing else. */
const CLOSURE = [
	'alignments/amsterdam-1625.json',
	'annotations/warehouses.geojson',
	'images/amsterdam-1625/0/0/0.jpg',
	'images/amsterdam-1625/info.json',
	'images/unaligned-map/info.json',
	'project.json'
];

const MARK: ReviewMark = {
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: 'Amsterdam 1625',
	directory: DIRECTORY,
	openedAt: '2026-08-22T10:00:00.000Z',
	origin: null
};

function seed(files: Record<string, string>): MemoryProjectStore {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) {
		store.plant(path as StorePath, encode(content));
	}
	return store;
}

/** The Workspace with some of it never written — an author's mistake, as it reaches a recipient. */
const without = (...paths: string[]): Record<string, string> =>
	Object.fromEntries(Object.entries(WORKSPACE).filter(([path]) => !paths.includes(path)));

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

/** The bundle our own exporter makes of the fixture, which is how a Project really arrives as one. */
const bundleOf = async (files: Record<string, string>): Promise<Uint8Array<ArrayBuffer>> =>
	collect((await exportProjectBundle(seed(files), DIRECTORY)).body);

/** A hand-built archive, for the bundles a stranger sends that our exporter could not have made. */
const handBuilt = async (
	files: readonly (readonly [string, string])[]
): Promise<Uint8Array<ArrayBuffer>> =>
	(await packTar(
		files.map(([name, content]): TarEntry => ({
			header: { name, size: encode(content).length, type: 'file' },
			body: encode(content)
		}))
	)) as Uint8Array<ArrayBuffer>;

const streamsOf = (bytes: Uint8Array<ArrayBuffer>) => () => new Blob([bytes]).stream();

const bundleSource = async (
	files: Record<string, string> = WORKSPACE
): Promise<ProjectImportSource> =>
	readProjectBundleSource(streamsOf(await bundleOf(files)), {
		fileName: 'amsterdam-1625.project.tar'
	});

const remoteSource = async (
	files: Record<string, string> = WORKSPACE
): Promise<ProjectImportSource> => {
	const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: files });
	return readRemoteProjectSource({
		remote: { owner: OWNER, repository: REPOSITORY, project: DIRECTORY },
		fetch: fake.fetch
	});
};

const reviewSource = async (
	files: Record<string, string> = WORKSPACE,
	mark: ReviewMark = MARK
): Promise<ProjectImportSource> => readReviewWorkspaceSource({ store: seed(files), mark });

/** Every file a source actually hands over, as plain strings, keyed by closure path. */
async function delivered(source: ProjectImportSource): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for await (const file of source.files()) {
		out[file.path] = new TextDecoder().decode(file.bytes);
	}
	return out;
}

const adapters = [
	['a Project Bundle', bundleSource],
	['a Published GitHub Project', remoteSource],
	['a Review Workspace', reviewSource]
] as const;

describe('one closure, whichever of the three sources it comes from', () => {
	// Acceptance criteria 1 and 2. The same expected list against all three, so "they report the same
	// logical closure" is the assertion rather than a hope about three separate expectations.
	it.each(adapters)('reads the same closure from %s', async (_name, open) => {
		const source = await open();

		expect(source.paths).toEqual(CLOSURE);
		expect(source.project.name).toBe('Amsterdam 1625');
	});

	it.each(adapters)('hands over exactly the closure it declared from %s', async (_name, open) => {
		const source = await open();

		const files = await delivered(source);

		expect(Object.keys(files).sort()).toEqual(CLOSURE);
		expect(files['alignments/amsterdam-1625.json']).toBe(
			WORKSPACE['alignments/amsterdam-1625.json']
		);
		expect(files['annotations/warehouses.geojson']).toBe(
			WORKSPACE[`${DIRECTORY}/annotations/warehouses.geojson`]
		);
	});

	// Asserted by equality above, and spelled out again here so a regression says which class of file
	// leaked rather than only that a list changed.
	it.each(adapters)('leaves everything that is not this Project out of %s', async (_name, open) => {
		const source = await open();

		expect(source.paths).not.toContain('index.html');
		expect(source.paths).not.toContain('_app/app.js');
		expect(source.paths).not.toContain('base-map/glyphs/0.pbf');
		expect(source.paths).not.toContain('annotations/superseded.geojson');
		expect(source.paths).not.toContain('ballastella-site.json');
		expect(source.paths).not.toContain('review.json');
		expect(source.paths.filter((path) => path.includes('blaeu-1649'))).toEqual([]);
		expect(source.paths.filter((path) => path.includes('canal'))).toEqual([]);
	});

	// ADR-0023's ordinary case, and the one a first cut of the bundle reader refused: a Map Image
	// nobody has placed yet has no Alignment, and its Project must still import.
	it.each(adapters)('accepts an unaligned Map Image from %s', async (_name, open) => {
		const source = await open();

		expect(source.paths).toContain('images/unaligned-map/info.json');
		expect(source.paths).not.toContain('alignments/unaligned-map.json');
	});

	// One Alignment and one image directory for a Map Image two Layers draw. Repeated references are
	// what the `taken` set is for, and a duplicated pyramid would be a doubled quota figure.
	it.each(adapters)(
		'takes one copy of a Map Image two Layers draw from %s',
		async (_name, open) => {
			const source = await open();

			expect(
				source.paths.filter((path) => path === 'images/amsterdam-1625/info.json')
			).toHaveLength(1);
		}
	);

	// The manifest is held verbatim and apart from the rest, so a consumer can keep the discipline
	// every transfer path here keeps: `project.json` is the last domain file written (ADR-0008).
	it.each(adapters)('carries project.json verbatim, apart from %s', async (_name, open) => {
		const source = await open();

		expect(new TextDecoder().decode(source.projectFileBytes)).toBe(
			WORKSPACE[`${DIRECTORY}/project.json`]
		);
		expect(source.paths).toContain('project.json');
	});

	it.each(adapters)(
		'declares what the closure weighs without reading it from %s',
		async (_name, open) => {
			const source = await open();

			const measured = CLOSURE.reduce(
				(sum, path) =>
					sum +
					encode(
						WORKSPACE[
							path.startsWith('images/') || path.startsWith('alignments/')
								? path
								: `${DIRECTORY}/${path}`
						] ?? ''
					).length,
				0
			);
			expect(source.totalBytes).toBe(measured);
		}
	);
});

describe('what a source observed about where it came from', () => {
	it('records the bundle file the user picked', async () => {
		const source = await bundleSource();

		expect(source.origin).toEqual({
			kind: 'project-bundle',
			fileName: 'amsterdam-1625.project.tar',
			projectName: 'Amsterdam 1625'
		});
	});

	it('records the repository, branch, Project directory and commit of a published Project', async () => {
		// The fake here rather than through `remoteSource`, so the commit is compared against the one
		// the branch really stands at rather than against a shape.
		const fake = await createFakeGitHub({
			owner: OWNER,
			repository: REPOSITORY,
			tree: WORKSPACE
		});

		const source = await readRemoteProjectSource({
			remote: { owner: OWNER, repository: REPOSITORY, project: DIRECTORY },
			fetch: fake.fetch
		});

		expect(source.origin).toEqual({
			kind: 'github',
			owner: OWNER,
			repository: REPOSITORY,
			branch: 'main',
			directory: DIRECTORY,
			commit: fake.head(),
			projectName: 'Amsterdam 1625'
		});
	});

	// ⚠ **The commit is the state the bytes came from, or it is not a fact Ballastella observed.** A
	// branch moves; a long pyramid copy is minutes of raw reads. Read against the branch, a push
	// landing mid-copy hands over bytes the tree never named — the SHA check calls that tampering and
	// refuses the whole Import — and the recorded commit would name a tree nothing was verified
	// against.
	it('copies one commit, and keeps copying it when the branch moves underneath', async () => {
		const fake = await createFakeGitHub({ owner: OWNER, repository: REPOSITORY, tree: WORKSPACE });
		const at = fake.head();
		let pushed = false;
		// The push lands on the first byte read, which is `project.json` — so every closure read after
		// it is one the branch would answer differently.
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const response = await fake.fetch(input, init);
			if (!pushed && new URL(String(input)).origin === GITHUB_RAW_ORIGIN) {
				pushed = true;
				await fake.commitFiles({
					[`${DIRECTORY}/annotations/warehouses.geojson`]: '{"type":"FeatureCollection"}'
				});
			}
			return response;
		};

		const source = await readRemoteProjectSource({
			remote: { owner: OWNER, repository: REPOSITORY, project: DIRECTORY },
			fetch
		});
		const files = await delivered(source);

		expect(fake.head()).not.toBe(at);
		expect(source.origin).toMatchObject({ kind: 'github', commit: at });
		expect(files['annotations/warehouses.geojson']).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
	});

	it('records what the Review mark says the review copy holds', async () => {
		const source = await reviewSource();

		expect(source.origin).toEqual({
			kind: 'review',
			projectName: 'Amsterdam 1625',
			directory: DIRECTORY
		});
	});

	// ADR-0037: an imported Project retains no Remote relationship, so nothing a source observed may
	// be a binding or a credential. Asserted as the whole shape rather than as absences, because a
	// field added later is exactly how one would arrive.
	it('observes no credential and no Remote to adopt', async () => {
		const source = await remoteSource();

		expect(Object.keys(source.origin).sort()).toEqual([
			'branch',
			'commit',
			'directory',
			'kind',
			'owner',
			'projectName',
			'repository'
		]);
	});
});

describe('the source capability cannot write anywhere', () => {
	// Held by the compiler: this line fails to typecheck the moment a `write`, a `delete`, a
	// destination store or a credential appears on the source's public type.
	it('has no write, delete, destination or credential on its public type', async () => {
		type Forbidden = Extract<
			keyof ProjectImportSource,
			'write' | 'delete' | 'store' | 'destination' | 'credential' | 'token'
		>;
		const none: Forbidden extends never ? true : false = true;
		expect(none).toBe(true);

		const source = await reviewSource();
		expect(Object.keys(source).sort()).toEqual([
			'files',
			'origin',
			'paths',
			'project',
			'projectFileBytes',
			'totalBytes'
		]);
	});

	// The other half of the fence, and the half a runtime assertion cannot make: there is nowhere on a
	// source reader's input to put an ordinary writable Workspace. `@ts-expect-error` fails the build
	// if one of these ever becomes accepted.
	it('takes no ordinary writable destination', async () => {
		const store = new MemoryProjectStore();
		await expect(
			readReviewWorkspaceSource({
				store,
				mark: MARK,
				// @ts-expect-error -- a source reader has no destination to write into (ADR-0037)
				destination: store
			})
		).rejects.toThrow(ImportSourceRefusedError);
	});
});

describe('a source is refused before anything could be installed', () => {
	it('refuses an entry that would not stay inside the Project', async () => {
		const archive = await handBuilt([
			['project.json', projectJson()],
			['../escape.txt', 'somewhere else entirely']
		]);

		await expect(readProjectBundleSource(streamsOf(archive))).rejects.toMatchObject({
			name: 'ImportSourceRefusedError',
			refusal: 'unsafe-path'
		});
	});

	// A tar has no index and nothing in the format forbids one name twice. The Review path declines the
	// later copy and reports it; an Import cannot, because neither copy is the authoritative one.
	it('refuses a bundle that names one path twice', async () => {
		const archive = await handBuilt([
			['project.json', projectJson()],
			['annotations/warehouses.geojson', '{"type":"FeatureCollection","features":[]}'],
			['annotations/warehouses.geojson', '{"type":"FeatureCollection","features":[2]}']
		]);

		await expect(readProjectBundleSource(streamsOf(archive))).rejects.toMatchObject({
			refusal: 'duplicate-entry'
		});
	});

	it('refuses a bundle carrying project.json twice', async () => {
		const archive = await handBuilt([
			['project.json', projectJson()],
			['project.json', projectJson({ name: 'Something else' })]
		]);

		await expect(readProjectBundleSource(streamsOf(archive))).rejects.toMatchObject({
			refusal: 'duplicate-entry'
		});
	});

	it('refuses a file that is not a Project bundle at all', async () => {
		await expect(readProjectBundleSource(streamsOf(encode('not a tar')))).rejects.toMatchObject({
			refusal: 'incomplete'
		});
	});

	it('refuses a source with no project.json where one belongs', async () => {
		const archive = await handBuilt([['annotations/warehouses.geojson', '{}']]);

		await expect(readProjectBundleSource(streamsOf(archive))).rejects.toMatchObject({
			refusal: 'no-project-file'
		});
	});

	it('refuses a project.json that is not a Project', async () => {
		const archive = await handBuilt([['project.json', 'not json at all']]);

		await expect(readProjectBundleSource(streamsOf(archive))).rejects.toMatchObject({
			refusal: 'malformed-project-file'
		});
	});

	// ADR-0010, and it must reach the caller as itself: everything already catching this class still
	// does, and the message names the remedy rather than describing a source.
	it.each(adapters)(
		'refuses a Project from a newer build of the app in %s',
		async (_name, open) => {
			const files = {
				...WORKSPACE,
				[`${DIRECTORY}/project.json`]: projectJson({ formatVersion: 2 })
			};

			await expect(open(files)).rejects.toThrow(ProjectFormatTooNewError);
		}
	);

	it.each(adapters)('refuses a missing Annotation in %s', async (_name, open) => {
		await expect(
			open(without(`${DIRECTORY}/annotations/warehouses.geojson`))
		).rejects.toMatchObject({ refusal: 'missing-annotation' });
	});

	it.each(adapters)('refuses a missing Map Image in %s', async (_name, open) => {
		await expect(
			open(without('images/amsterdam-1625/info.json', 'images/amsterdam-1625/0/0/0.jpg'))
		).rejects.toMatchObject({ refusal: 'missing-image' });
	});

	// A heap of tiles that describes itself as neither a local copy nor a referenced image is a
	// directory no client can open (ADR-0006's layout), so the Map Image is missing whether or not the
	// directory exists.
	it.each(adapters)('refuses an image directory nothing can read in %s', async (_name, open) => {
		await expect(open(without('images/amsterdam-1625/info.json'))).rejects.toMatchObject({
			refusal: 'incomplete-image'
		});
	});

	// The other kind of describable image, which must **not** be refused: a referenced IIIF image's
	// tiles are on somebody else's server, so `remote.json` stands in for `info.json` (ADR-0007).
	it.each(adapters)(
		'accepts a referenced Map Image described by remote.json in %s',
		async (_name, open) => {
			const files = {
				...without('images/amsterdam-1625/info.json'),
				'images/amsterdam-1625/remote.json':
					'{"formatVersion":1,"service":"https://iiif.example/x"}'
			};

			const source = await open(files);

			expect(source.paths).toContain('images/amsterdam-1625/remote.json');
		}
	);

	// The generated-file exclusion is asked of *referenced* paths too, which is the only way it can
	// still matter now the closure is reference-only: a Layer pointing at `_app/app.js` must not pull
	// publishing's own output into the user's Workspace as if it were scholarship (ADR-0006).
	it.each(adapters)(
		'will not follow a Layer reference into generated site output in %s',
		async (_name, open) => {
			const files = {
				...WORKSPACE,
				[`${DIRECTORY}/project.json`]: projectJson({
					layers: [
						{
							id: 'l1',
							name: 'Warehouses',
							visible: true,
							order: 0,
							kind: 'annotation',
							geojsonRef: '_app/app.js'
						}
					]
				})
			};

			await expect(open(files)).rejects.toMatchObject({ refusal: 'missing-annotation' });
		}
	);

	it('names every unresolved reference, not only the first', async () => {
		await expect(
			bundleSource(
				without(`${DIRECTORY}/annotations/warehouses.geojson`, 'images/unaligned-map/info.json')
			)
		).rejects.toThrow(/images\/unaligned-map/);
	});

	// The gap between a listing and the bytes. A file can go in between — a tree that names a blob the
	// raw host answers 404 for, a Workspace file deleted while the dialog is open — and a consumer with
	// no way to tell would install a Project whose Alignment silently never arrived.
	it('refuses a source that lists an Alignment and then cannot hand it over', async () => {
		const store = seed(WORKSPACE);
		const vanishing: EnumerableReadOnlyProjectStore = {
			list: (prefix) => store.list(prefix),
			size: (path) => store.size(path),
			read: (path) => {
				if (path === 'alignments/amsterdam-1625.json') {
					return Promise.reject(new PathNotFoundError(path));
				}
				return store.read(path);
			}
		};

		const source = await readReviewWorkspaceSource({ store: vanishing, mark: MARK });

		expect(source.paths).toContain('alignments/amsterdam-1625.json');
		await expect(delivered(source)).rejects.toMatchObject({ refusal: 'missing-alignment' });
	});

	it('refuses a review copy whose mark records no Project', async () => {
		await expect(reviewSource(WORKSPACE, { ...MARK, directory: '' })).rejects.toMatchObject({
			refusal: 'no-project-file'
		});
	});
});
