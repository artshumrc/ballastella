import { describe, expect, it } from 'vitest';

import { parseProjectFile } from '../project/project-file.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	parseReviewMark,
	serialiseReviewMark,
	type ReviewMark,
	type ReviewOrigin
} from '../project/review-workspace.js';
import type { MemoryProjectStore } from '../store/memory-project-store.js';
import { decode, encode, rejection } from '../test-support.js';
import { detachImportedProject } from './project-import-remapping.js';
import {
	ReviewDestinationUnavailableError,
	readReviewWorkspaceSource,
	refuseReviewDestination,
	reviewCopyStillHere,
	reviewImportOrigin
} from './project-import-source.js';
import {
	PLAN_LAYER,
	WAREHOUSES_LAYER,
	delivered,
	planted,
	projectJson as bundleProjectJson
} from './test-fixtures.js';

const DIRECTORY = 'amsterdam-1625';

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
	bundleProjectJson({
		name,
		canonicalUrl: 'https://ada.github.io/atlas/amsterdam-1625/',
		onFrontPage: true,
		layers: [PLAN_LAYER, { ...WAREHOUSES_LAYER, geojsonRef: annotation }]
	});

const reviewCopy = (): MemoryProjectStore =>
	planted({
		'review.json': '',
		[`${DIRECTORY}/project.json`]: projectJson('Amsterdam 1625', 'annotations/warehouses.geojson'),
		[`${DIRECTORY}/annotations/warehouses.geojson`]:
			'{"type":"FeatureCollection","features":["as sent"]}',
		'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
		'images/amsterdam-1625/0/0/0.jpg': 'not really a jpeg, but bytes',
		'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}'
	});

describe('which ordinary Workspace a review copy may be Imported into', () => {
	it.each([
		['browser storage', BROWSER_ORIGIN],
		['a folder, with the grant to ask for it back by', FOLDER_ORIGIN]
	])('is the one recorded when review began, in %s', (_case, origin) => {
		expect(reviewImportOrigin(mark(origin))).toEqual(origin);
	});

	it('is not redirected by anything the reviewer does afterwards', () => {
		const written = serialiseReviewMark(mark(BROWSER_ORIGIN));
		expect(reviewImportOrigin(parseReviewMark(written) as ReviewMark)).toEqual(BROWSER_ORIGIN);
	});

	it('is refused, and never guessed at, for a copy that records none', async () => {
		const thrown = await rejection(ReviewDestinationUnavailableError, () =>
			reviewImportOrigin(mark(null))
		);

		expect(thrown.refusal).toBe('no-origin');
		expect(thrown.message).toContain('“Amsterdam 1625”');
		expect(thrown.message).toContain('will not choose one for you');
		expect(thrown.message).toContain('this review copy is still here');
	});

	it.each([
		['gone', 'not there any more'],
		['unreachable', 'cannot be reached'],
		['permission-denied', 'not given permission']
	] as const)('names the Workspace and offers no other when it is %s', async (refusal, said) => {
		const thrown = await rejection(ReviewDestinationUnavailableError, () =>
			refuseReviewDestination(FOLDER_ORIGIN, refusal)
		);
		expect(thrown.refusal).toBe(refusal);
		expect(thrown.message).toContain('the folder “maps”');
		expect(thrown.message).toContain(said);
		expect(thrown.message).toContain(
			'Nothing has been Imported, and this review copy is still here.'
		);
	});

	it('reports a review copy that would not go without calling the Import a failure', () => {
		const said = reviewCopyStillHere('Amsterdam 1625 (2)', 'Amsterdam 1625');
		expect(said).toContain('was Imported and is in your Workspace');
		expect(said).toContain('“Amsterdam 1625 (2)”');
		expect(said).toContain('discard it from the banner');
	});
});

describe('what a review Import reads is the review copy as it stands now', () => {
	it('hands over the Annotation and the Project name the reviewer edited, not those that arrived', async () => {
		const store = reviewCopy();
		await store.write(
			`${DIRECTORY}/annotations/warehouses.geojson`,
			encode('{"type":"FeatureCollection","features":["as the reviewer left it"]}')
		);
		await store.write(
			`${DIRECTORY}/project.json`,
			encode(projectJson('Amsterdam 1625, marked', 'annotations/warehouses.geojson'))
		);

		const source = await readReviewWorkspaceSource({ store, mark: mark(BROWSER_ORIGIN) });
		const files = await delivered(source);
		expect(files['annotations/warehouses.geojson']).toContain('as the reviewer left it');
		expect(source.project.name).toBe('Amsterdam 1625, marked');
		expect(source.origin).toEqual({
			kind: 'review',
			projectName: 'Amsterdam 1625',
			directory: DIRECTORY
		});
	});

	it('refuses a reference the reviewer broke, leaving the review copy as it was', async () => {
		const store = reviewCopy();
		await store.write(
			`${DIRECTORY}/project.json`,
			encode(projectJson('Amsterdam 1625', 'annotations/never-written.geojson'))
		);

		await expect(
			readReviewWorkspaceSource({ store, mark: mark(BROWSER_ORIGIN) })
		).rejects.toMatchObject({ refusal: 'missing-annotation' });
		expect(decode(await store.read(`${DIRECTORY}/annotations/warehouses.geojson`))).toContain(
			'as sent'
		);
	});

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
		expect(parseProjectFile(await store.read(`${DIRECTORY}/project.json`)).onFrontPage).toBe(true);
	});
});
