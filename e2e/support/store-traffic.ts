import { type Page } from '@playwright/test';

declare global {
	interface Window {
		ballastellaFileReads?: Record<string, number>;
		ballastellaFileWrites?: string[];
	}
}

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
