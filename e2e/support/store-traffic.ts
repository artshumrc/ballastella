// Counting what a gesture costs the store, from outside the application.
//
// OPFS issues no requests, so there is nothing on the network to watch and nothing but the
// filesystem API itself to count at. `FileSystemFileHandle.getFile()` is the one call every read in
// `DirectoryHandleStore` goes through, and `createWritable()` the one call every write goes through,
// atomic temp file included.
//
// Here rather than in one spec because two of them now ask the same question of different gestures:
// `editor-layers.e2e.ts` asks it of a rename and an opacity drag, and `editor-annotations.e2e.ts`
// asks it of selecting an Annotation, which is the gesture the leader line made expensive if it were
// going to make anything expensive.

import { type Page } from '@playwright/test';

declare global {
	interface Window {
		/** How many times each file has been opened for reading — see {@link countFileReads}. */
		ballastellaFileReads?: Record<string, number>;
		/** Every file opened for writing, in order — see {@link countFileWrites}. */
		ballastellaFileWrites?: string[];
	}
}

/** Count every file the page opens for reading from now on, by file name. */
export async function countFileReads(page: Page): Promise<void> {
	await page.evaluate(() => {
		const counts: Record<string, number> = {};
		window.ballastellaFileReads = counts;
		const proto = FileSystemFileHandle.prototype;
		const original = proto.getFile;
		proto.getFile = function (this: FileSystemFileHandle) {
			counts[this.name] = (counts[this.name] ?? 0) + 1;
			return original.call(this);
		};
	});
}

export const fileReads = (page: Page): Promise<Record<string, number>> =>
	page.evaluate(() => ({ ...window.ballastellaFileReads }));

/**
 * Record every file the page opens for **writing** from now on, by file name.
 *
 * The other half of {@link countFileReads}. A `project.json` that happens to be byte-identical
 * afterwards cannot distinguish "nothing was written" from "the same bytes were written again with a
 * fresh `updatedAt` that happened to round the same way", which is why this counts the call.
 */
export async function countFileWrites(page: Page): Promise<void> {
	await page.evaluate(() => {
		const written: string[] = [];
		window.ballastellaFileWrites = written;
		const proto = FileSystemFileHandle.prototype;
		const original = proto.createWritable;
		proto.createWritable = function (this: FileSystemFileHandle, ...args: unknown[]) {
			written.push(this.name);
			return (original as (...args: unknown[]) => unknown).apply(this, args) as ReturnType<
				typeof original
			>;
		};
	});
}

export const fileWrites = (page: Page): Promise<string[]> =>
	page.evaluate(() => [...(window.ballastellaFileWrites ?? [])]);
