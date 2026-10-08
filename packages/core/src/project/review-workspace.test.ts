import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { PathNotFoundError } from '../store/project-store.js';
import { encode, rejection } from '../test-support.js';
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

const mark = {
	formatVersion: REVIEW_MARK_FORMAT_VERSION,
	project: 'Amsterdam 1625',
	directory: 'amsterdam-1625',
	openedAt: '2026-08-08T09:00:00.000Z',
	origin: null
};

const markedWith = (text: string): MemoryProjectStore => {
	const store = new MemoryProjectStore();
	store.plant(REVIEW_MARK_PATH, encode(text));
	return store;
};

describe('the mark that makes a Workspace a review copy', () => {
	it('round-trips, and is read off the Workspace itself', async () => {
		expect(parseReviewMark(serialiseReviewMark(mark))).toEqual(mark);
		expect(await readReviewMark(markedWith(JSON.stringify(mark)))).toEqual(mark);
	});

	it('is absent from a Workspace of the user’s own', async () => {
		expect(await readReviewMark(new MemoryProjectStore())).toBeNull();
	});

	it.each([
		['not JSON at all', '{ this is not json'],
		['JSON that is not an object', '"a string"'],
		['an object with no formatVersion', '{"project":"Amsterdam 1625"}'],
		['null', 'null']
	])('still counts a mark that is %s, with no origin', async (_case, text) => {
		const found = await readReviewMark(markedWith(text));
		expect(found).not.toBeNull();
		expect(found?.project).toBe('');
		expect(found?.origin).toBeNull();
	});

	it('still counts a mark on a store that will not answer, and only a missing file is none', async () => {
		const store = new MemoryProjectStore();
		store.read = async () => {
			throw new Error('the folder grant has lapsed');
		};
		expect(await readReviewMark(store)).not.toBeNull();

		store.read = async (path) => {
			throw new PathNotFoundError(path);
		};
		expect(await readReviewMark(store)).toBeNull();
	});

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

	it('cannot collide with a Project directory, whatever the Project is called', () => {
		expect(toDirectoryName('review.json')).not.toBe(REVIEW_MARK_PATH);
		expect(toDirectoryName('Review')).not.toBe(REVIEW_MARK_PATH);
		expect(REVIEW_MARK_PATH).toContain('.');
	});
});

describe('the ordinary Workspace a review copy records as its origin', () => {
	it.each([
		{
			workspaceKey: 'opfs:My Workspace',
			backing: 'browser' as const,
			name: 'My Workspace',
			folderReference: ''
		},
		{
			workspaceKey: 'folder:maps',
			backing: 'folder' as const,
			name: 'maps',
			folderReference: 'retained:8f1c'
		}
	])('round-trips a $backing origin', (origin) => {
		expect(parseReviewMark(serialiseReviewMark({ ...mark, origin }))?.origin).toEqual(origin);
	});

	it('is absent from a mark written before there was one, which is still a mark', async () => {
		const found = await readReviewMark(markedWith(JSON.stringify({ ...mark, origin: undefined })));
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
		['naming no Workspace', '{"workspaceKey":"k","backing":"browser","name":""}'],
		[
			'a folder with no grant behind it',
			'{"workspaceKey":"folder:maps","backing":"folder","name":"maps","folderReference":""}'
		]
	])('is no origin at all when it is %s', (_case, origin) => {
		const parsed = parseReviewMark(
			encode(`{"formatVersion":1,"project":"p","directory":"d","openedAt":"","origin":${origin}}`)
		);

		expect(parsed).not.toBeNull();
		expect(parsed?.origin).toBeNull();
	});
});

describe('what a Review Workspace may and may not be asked to do', () => {
	it('lets a Workspace of the user’s own be backed up', () => {
		expect(() => assertNotReviewing('My Workspace', null, 'backed up')).not.toThrow();
	});

	it('refuses a review copy, naming the Workspace, the Project, and the way out', async () => {
		const { message } = await rejection(ReviewWorkspaceError, () =>
			assertNotReviewing('amsterdam-1625', mark, 'backed up')
		);

		expect(message).toContain('“amsterdam-1625”');
		expect(message).toContain('“Amsterdam 1625”');
		expect(message).toContain('cannot be backed up');
		expect(message).toContain('Go back to your own Workspace first.');
	});

	it('says “a Project somebody sent you” for a mark it could not read', () => {
		expect(() =>
			assertNotReviewing(
				'assignment 3',
				{ ...mark, project: '', directory: '', openedAt: '' },
				'sent to GitHub'
			)
		).toThrow(/a Project somebody sent you.*cannot be sent to GitHub/s);
	});

	it('lets a review copy be discarded, and refuses to discard one of the user’s own', () => {
		expect(() => assertReviewing('amsterdam-1625', mark)).not.toThrow();
		expect(() => assertReviewing('My Workspace', null)).toThrow(ReviewWorkspaceError);
		expect(() => assertReviewing('My Workspace', null)).toThrow(
			/“My Workspace” is one of your own Workspaces.*Workspace list on the bar/s
		);
	});
});
