import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { PathNotFoundError, type Bytes } from '../store/project-store.js';
import {
	assertNotReviewing,
	assertReviewing,
	parseReviewMark,
	readReviewMark,
	ReviewWorkspaceError,
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	serialiseReviewMark
} from './review-workspace.js';
import { toDirectoryName } from './workspace.js';

const encode = (text: string): Bytes => new TextEncoder().encode(text);

const mark = {
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: 'Amsterdam 1625',
	directory: 'amsterdam-1625',
	openedAt: '2026-08-08T09:00:00.000Z',
	origin: null
};

describe('the mark that makes a Workspace a review copy', () => {
	it('round-trips', () => {
		expect(parseReviewMark(serialiseReviewMark(mark))).toEqual(mark);
	});

	it('is absent from a Workspace of the user’s own', async () => {
		expect(await readReviewMark(new MemoryProjectStore())).toBeNull();
	});

	it('is read off the Workspace itself, so it survives a reload', async () => {
		const store = new MemoryProjectStore();
		store.plant(REVIEW_MARK_PATH, serialiseReviewMark(mark));

		expect(await readReviewMark(store)).toEqual(mark);
	});

	// ⚠ **Unreadable is not absent, and here that rule points the opposite way from usual.** The
	// failure to avoid is a scholar doing an afternoon's real work inside a Workspace built to be
	// thrown away, so anything that is *there* and will not read still counts as a mark. Only
	// `PathNotFoundError` means "this is your own Workspace".
	it.each([
		['not JSON at all', '{ this is not json'],
		['JSON that is not an object', '"a string"'],
		['an object with no formatVersion', '{"project":"Amsterdam 1625"}'],
		['null', 'null']
	])('still counts a mark that is %s', async (_case, text) => {
		const store = new MemoryProjectStore();
		store.plant(REVIEW_MARK_PATH, encode(text));

		const found = await readReviewMark(store);

		expect(found).not.toBeNull();
		// It names nothing it does not know, rather than inventing a Project name.
		expect(found?.project).toBe('');
	});

	it('still counts a mark on a store that will not answer at all', async () => {
		const store = new MemoryProjectStore();
		store.read = async () => {
			throw new Error('the folder grant has lapsed');
		};

		expect(await readReviewMark(store)).not.toBeNull();
	});

	it('reports no mark only when the file is genuinely not there', async () => {
		const store = new MemoryProjectStore();
		store.read = async (path) => {
			throw new PathNotFoundError(path);
		};

		expect(await readReviewMark(store)).toBeNull();
	});

	// A mark from a newer build keeps what this one understands rather than being discarded: discarding
	// it would report the Workspace as the user's own, which is the one answer that is dangerous.
	it('keeps what it understands of a mark from a newer build', () => {
		const found = parseReviewMark(
			encode('{"formatVersion":99,"project":"Amsterdam 1625","directory":"a","somethingNew":true}')
		);

		expect(found).toEqual({
			formatVersion: 99,
			project: 'Amsterdam 1625',
			directory: 'a',
			openedAt: '',
			origin: null
		});
	});

	// The mark is a top-level *file*, so no Project directory can ever land on it: `listProjects`
	// matches only `<directory>/project.json`, and `toDirectoryName` produces a slug with no `.` in it.
	it('cannot collide with a Project directory, whatever the Project is called', () => {
		expect(toDirectoryName('review.json')).not.toBe(REVIEW_MARK_PATH);
		expect(toDirectoryName('Review')).not.toBe(REVIEW_MARK_PATH);
		expect(REVIEW_MARK_PATH).toContain('.');
	});
});

// ⚠ **The one part of the mark read *meanly*, and the asymmetry is the point** (ADR-0037). Every
// other field above is read as generously as possible, because a missed mark is an afternoon's work
// in a throwaway Workspace. An origin is the destination an Import copies into and then discards the
// review copy behind, so a half-read one is refused: no destination is a refusal to Import, and a
// guessed destination is somebody else's work landing in a Workspace nobody named.
describe('the ordinary Workspace a review copy records as its origin', () => {
	const browserOrigin = {
		workspaceKey: 'opfs:My Workspace',
		backing: 'browser' as const,
		name: 'My Workspace',
		folderReference: ''
	};
	const folderOrigin = {
		workspaceKey: 'folder:maps',
		backing: 'folder' as const,
		name: 'maps',
		folderReference: 'retained:8f1c'
	};

	it.each([
		['a browser-storage Workspace', browserOrigin],
		['a chosen folder, with the grant to ask for it back by', folderOrigin]
	])('round-trips %s', (_case, origin) => {
		expect(parseReviewMark(serialiseReviewMark({ ...mark, origin }))?.origin).toEqual(origin);
	});

	// Every review copy made before ADR-0037 is this one. It stays a mark — reviewable, editable,
	// discardable — and only Import is refused over it.
	it('is absent from a mark written before there was one, which is still a mark', async () => {
		const store = new MemoryProjectStore();
		store.plant(
			REVIEW_MARK_PATH,
			encode(
				JSON.stringify({
					formatVersion: REVIEW_MARK_FORMAT_VERSION,
					project: 'Amsterdam 1625',
					directory: 'amsterdam-1625',
					openedAt: '2026-08-08T09:00:00.000Z'
				})
			)
		);

		const found = await readReviewMark(store);

		expect(found).not.toBeNull();
		expect(found?.project).toBe('Amsterdam 1625');
		expect(found?.origin).toBeNull();
	});

	it.each([
		['not an object', '"opfs:My Workspace"'],
		['carrying no key', '{"backing":"browser","name":"My Workspace","folderReference":""}'],
		['carrying an empty key', '{"workspaceKey":"","backing":"browser","name":"x"}'],
		[
			'naming a backing this build has none of',
			'{"workspaceKey":"k","backing":"remote","name":"x"}'
		],
		[
			'naming no Workspace the reviewer could recognise',
			'{"workspaceKey":"k","backing":"browser","name":""}'
		],
		[
			'a folder with no grant behind it, which is a name and not a place',
			'{"workspaceKey":"folder:maps","backing":"folder","name":"maps","folderReference":""}'
		]
	])('is no origin at all when it is %s', (_case, origin) => {
		const parsed = parseReviewMark(
			encode(`{"formatVersion":1,"project":"p","directory":"d","openedAt":"","origin":${origin}}`)
		);

		expect(parsed).not.toBeNull();
		expect(parsed?.origin).toBeNull();
	});

	// The unreadable-mark answer names nothing it does not know, and a destination is the last thing
	// to invent for a Workspace whose own mark could not be read.
	it('is absent from the mark answered for a file that would not read', async () => {
		const store = new MemoryProjectStore();
		store.plant(REVIEW_MARK_PATH, encode('{ not json'));

		expect((await readReviewMark(store))?.origin).toBeNull();
	});
});

// ⚠ **The two refusals, at the only seam they have.** Both sentences used to live in
// `apps/editor/src/lib/workspace-storage.svelte.ts`, which has no test project at all, so the
// wording and both branches were unasserted — and a message nobody asserts is a message that
// drifts, which is the whole reason there is one sentence rather than a phrase per call site.
describe('what a Review Workspace may and may not be asked to do', () => {
	it('lets a Workspace of the user’s own be backed up', () => {
		expect(() => assertNotReviewing('My Workspace', null, 'backed up')).not.toThrow();
	});

	it('refuses a review copy, naming the Workspace, the Project, and the way out', () => {
		let thrown: unknown;
		try {
			assertNotReviewing('amsterdam-1625', mark, 'backed up');
		} catch (cause) {
			thrown = cause;
		}

		expect(thrown).toBeInstanceOf(ReviewWorkspaceError);
		const message = (thrown as Error).message;
		expect(message).toContain('“amsterdam-1625”');
		expect(message).toContain('“Amsterdam 1625”');
		expect(message).toContain('cannot be backed up');
		expect(message).toContain('Go back to your own Workspace first.');
	});

	// A mark that could not be read carries no Project name, and the refusal must not invent one:
	// the Workspace's own name is not what the bundle said.
	it('says “a Project somebody sent you” for a mark it could not read', () => {
		expect(() =>
			assertNotReviewing(
				'assignment 3',
				{
					formatVersion: REVIEW_MARK_FORMAT_VERSION,
					project: '',
					directory: '',
					openedAt: '',
					origin: null
				},
				'published'
			)
		).toThrow(/a Project somebody sent you.*cannot be published/s);
	});

	it('lets a review copy be discarded, and refuses to discard one of the user’s own', () => {
		expect(() => assertReviewing('amsterdam-1625', mark)).not.toThrow();
		expect(() => assertReviewing('My Workspace', null)).toThrow(ReviewWorkspaceError);
		expect(() => assertReviewing('My Workspace', null)).toThrow(
			/“My Workspace” is one of your own Workspaces.*Workspace settings/s
		);
	});
});
