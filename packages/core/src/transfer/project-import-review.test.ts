// What a Review Workspace's own metadata licenses, and what a review copy hands over when it does
// (ADR-0037).
//
// Two claims, and they are the pair the operation stands on. The **metadata** claim is that a review
// copy names exactly one ordinary Workspace, that the name survives everything the reviewer does
// afterwards, and that a copy naming none is refused rather than given a destination. The **source**
// claim is that what an Import then reads is the review copy *as it stands now* — the reviewer's own
// edits included — rather than the bundle or the published tree it arrived from.
//
// The shared closure matrix is `project-import-source.test.ts`'s and is deliberately not repeated
// here: what is Imported is the same question for all three sources, and asking it three times would
// only prove three adapters self-consistent.

import { describe, expect, it } from 'vitest';

import { detachImportedProject } from './project-import-provenance.js';
import { parseProjectFile } from '../project/project-file.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	parseReviewMark,
	serialiseReviewMark,
	type ReviewMark,
	type ReviewOrigin
} from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { type Bytes, type StorePath } from '../store/project-store.js';
import {
	ReviewDestinationUnavailableError,
	refuseReviewDestination,
	reviewCopyStillHere,
	reviewImportOrigin
} from './project-import-review.js';
import { readReviewWorkspaceSource } from './review-workspace-source.js';

const DIRECTORY = 'amsterdam-1625';

const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;

const BROWSER_ORIGIN: ReviewOrigin = {
	workspaceKey: 'opfs:Marking 2026',
	backing: 'browser',
	name: 'Marking 2026',
	folderReference: ''
};

const FOLDER_ORIGIN: ReviewOrigin = {
	workspaceKey: 'folder:maps',
	backing: 'folder',
	name: 'maps',
	folderReference: 'retained:8f1c'
};

const mark = (origin: ReviewOrigin | null): ReviewMark => ({
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: 'Amsterdam 1625',
	directory: DIRECTORY,
	openedAt: '2026-08-22T10:00:00.000Z',
	origin
});

const projectJson = (name: string, annotation: string): string =>
	`${JSON.stringify(
		{
			formatVersion: 1,
			name,
			updatedAt: '2025-03-04T11:22:33.000Z',
			canonicalUrl: 'https://ada.github.io/atlas/amsterdam-1625/',
			onFrontPage: true,
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
					geojsonRef: annotation
				}
			],
			baseMap: 'protomaps-light'
		},
		null,
		'\t'
	)}\n`;

/** A review copy holding one Project, exactly as `reviewFromRemote` and `openProjectBundle` leave one. */
function reviewCopy(files: Record<string, string> = {}): MemoryProjectStore {
	const store = new MemoryProjectStore();
	const seeded: Record<string, string> = {
		'review.json': '',
		[`${DIRECTORY}/project.json`]: projectJson('Amsterdam 1625', 'annotations/warehouses.geojson'),
		[`${DIRECTORY}/annotations/warehouses.geojson`]:
			'{"type":"FeatureCollection","features":["as published"]}',
		'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
		'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
		// alignment-write-is-the-fixture: the Alignment as the review copy received it, carried out verbatim by the source reader
		'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
		...files
	};
	for (const [path, content] of Object.entries(seeded)) {
		store.plant(path as StorePath, encode(content));
	}
	return store;
}

const read = async (store: MemoryProjectStore, path: string): Promise<string> =>
	new TextDecoder().decode(await store.read(path as StorePath));

describe('which ordinary Workspace a review copy may be Imported into', () => {
	it.each([
		['browser storage', BROWSER_ORIGIN],
		['a folder, with the grant to ask for it back by', FOLDER_ORIGIN]
	])('is the one recorded when review began, in %s', (_case, origin) => {
		expect(reviewImportOrigin(mark(origin))).toEqual(origin);
	});

	// ⚠ **The whole point of writing it down.** A reviewer moves between Workspaces while a review
	// copy is open — the banner's first exit is for exactly that — and the mark is a file inside the
	// review copy that nothing rewrites afterwards. So this is a claim about the *bytes*: whatever the
	// installation now thinks "my Workspace" means, what comes back out of the mark is what went in.
	it('is not redirected by anything the reviewer does afterwards', () => {
		const written = serialiseReviewMark(mark(BROWSER_ORIGIN));

		expect(reviewImportOrigin(parseReviewMark(written) as ReviewMark)).toEqual(BROWSER_ORIGIN);
	});

	// Every review copy made before ADR-0037 is this one, and so is one opened where no ordinary
	// Workspace could be named. It stays reviewable, editable and discardable; only Import refuses.
	it('is refused, and never guessed at, for a copy that records none', () => {
		let thrown: unknown;
		try {
			reviewImportOrigin(mark(null));
		} catch (cause) {
			thrown = cause;
		}

		expect(thrown).toBeInstanceOf(ReviewDestinationUnavailableError);
		expect((thrown as ReviewDestinationUnavailableError).refusal).toBe('no-origin');
		const message = (thrown as Error).message;
		expect(message).toContain('“Amsterdam 1625”');
		expect(message).toContain('will not choose one for you');
		expect(message).toContain('this review copy is still here');
	});

	it.each([
		['gone', 'not there any more'],
		['unreachable', 'cannot be reached'],
		['permission-denied', 'not given permission']
	] as const)('names the Workspace and offers no other when it is %s', (refusal, said) => {
		expect(() => refuseReviewDestination(FOLDER_ORIGIN, refusal)).toThrow(
			ReviewDestinationUnavailableError
		);
		try {
			refuseReviewDestination(FOLDER_ORIGIN, refusal);
		} catch (cause) {
			const message = (cause as Error).message;
			expect((cause as ReviewDestinationUnavailableError).refusal).toBe(refusal);
			expect(message).toContain('the folder “maps”');
			expect(message).toContain(said);
			// The half a reviewer is actually asking about: what they were reading is still there.
			expect(message).toContain('Nothing has been Imported, and this review copy is still here.');
		}
	});

	// Past the commit there is durable work of the user's own in their own Workspace. A discard that
	// then fails is untidiness, and the report says so rather than implying the Import came undone.
	it('reports a review copy that would not go without calling the Import a failure', () => {
		const said = reviewCopyStillHere('Amsterdam 1625 (2)', 'Amsterdam 1625');

		expect(said).toContain('was Imported and is in your Workspace');
		expect(said).toContain('“Amsterdam 1625 (2)”');
		expect(said).toContain('discard it from the banner');
	});
});

describe('what a review Import reads is the review copy as it stands now', () => {
	// ⚠ **The claim the confirmation sentence makes, asserted against the bytes.** A reviewer may have
	// renamed the Project, retyped an Annotation, or aligned a sheet before deciding to keep it, and
	// what they keep is what is on screen — not what arrived. The source reads the Workspace, so an
	// edit written into it after the mark was is simply what is there.
	it('hands over an Annotation the reviewer edited, not the one that arrived', async () => {
		const store = reviewCopy();
		await store.write(
			`${DIRECTORY}/annotations/warehouses.geojson` as StorePath,
			encode('{"type":"FeatureCollection","features":["as the reviewer left it"]}')
		);

		const source = await readReviewWorkspaceSource({ store, mark: mark(BROWSER_ORIGIN) });
		const files: Record<string, string> = {};
		for await (const file of source.files()) {
			files[file.path] = new TextDecoder().decode(file.bytes);
		}

		expect(files['annotations/warehouses.geojson']).toContain('as the reviewer left it');
	});

	it('reads the Project’s own name as the reviewer left it', async () => {
		const store = reviewCopy();
		await store.write(
			`${DIRECTORY}/project.json` as StorePath,
			encode(projectJson('Amsterdam 1625, marked', 'annotations/warehouses.geojson'))
		);

		const source = await readReviewWorkspaceSource({ store, mark: mark(BROWSER_ORIGIN) });

		expect(source.project.name).toBe('Amsterdam 1625, marked');
		expect(source.origin).toEqual({
			kind: 'review',
			projectName: 'Amsterdam 1625',
			directory: DIRECTORY
		});
	});

	// A Layer the reviewer pointed at an Annotation the review copy does not hold is a dangling
	// reference like any other, and Import refuses a source rather than installing a Layer that draws
	// nothing. The review copy is untouched by the refusal, which is what `store` still holding its
	// original bytes says.
	it('refuses a reference the reviewer broke, leaving the review copy as it was', async () => {
		const store = reviewCopy();
		await store.write(
			`${DIRECTORY}/project.json` as StorePath,
			encode(projectJson('Amsterdam 1625', 'annotations/never-written.geojson'))
		);

		await expect(
			readReviewWorkspaceSource({ store, mark: mark(BROWSER_ORIGIN) })
		).rejects.toMatchObject({ refusal: 'missing-annotation' });
		expect(await read(store, `${DIRECTORY}/annotations/warehouses.geojson`)).toContain(
			'as published'
		);
	});

	// The detachment is the shared engine's and is asserted in full in
	// `project-import-provenance.test.ts`. What is asserted here is the one thing specific to this
	// source: the entry a review Import appends says *review*, and carries the Project's name and
	// nothing that could be read as an author or as a route back.
	it('appends a review entry and detaches the copy, as every other Import does', async () => {
		const store = reviewCopy();
		const source = await readReviewWorkspaceSource({ store, mark: mark(BROWSER_ORIGIN) });

		const detached = detachImportedProject(
			source.project,
			source.origin,
			new Date('2026-08-22T11:00:00.000Z')
		);

		expect(detached.canonicalUrl).toBeNull();
		expect(detached.onFrontPage).toBe(false);
		expect(detached.importProvenance).toEqual([
			{
				kind: 'review',
				projectName: 'Amsterdam 1625',
				observedAt: '2026-08-22T11:00:00.000Z',
				evidence: 'observed'
			}
		]);
		// And the review copy's own `project.json` is not what was changed: detaching is a value
		// returned, and nothing is written until the Import commits into the destination.
		expect(
			parseProjectFile(await store.read(`${DIRECTORY}/project.json` as StorePath)).onFrontPage
		).toBe(true);
	});
});
