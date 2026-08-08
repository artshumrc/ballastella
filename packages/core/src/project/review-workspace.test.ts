import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { PathNotFoundError, type Bytes } from '../store/project-store.js';
import {
	parseReviewMark,
	readReviewMark,
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
	openedAt: '2026-08-08T09:00:00.000Z'
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
			openedAt: ''
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
