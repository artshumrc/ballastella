import { onTestFinished } from 'vitest';

import { MemoryProjectStore } from './store/memory-project-store.js';
import type { Bytes, ProjectStore } from './store/project-store.js';
import type { OpenTileSource } from './tiler/ingest.js';
import type { PlannedTile } from './tiler/pyramid.js';

export const encode = (text: string): Bytes => new TextEncoder().encode(text) as Bytes;
export const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

export async function seeded(files: Record<string, string | Bytes>): Promise<MemoryProjectStore> {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) {
		await store.write(path, typeof content === 'string' ? encode(content) : content);
	}
	return store;
}

export async function snapshot(
	store: Pick<ProjectStore, 'list' | 'read'>,
	prefix = ''
): Promise<Record<string, string>> {
	const held: Record<string, string> = {};
	for (const path of await store.list(prefix)) held[path] = decode(await store.read(path));
	return held;
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Bytes> {
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

export const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
	new Blob([bytes as BlobPart]).stream();

/** The smallest JPEG `readImageHeader` will size: SOI then an SOF0 segment. */
export function jpegHeader(width: number, height: number): Uint8Array {
	const bytes = new Uint8Array(13);
	bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
	bytes[7] = (height >> 8) & 0xff;
	bytes[8] = height & 0xff;
	bytes[9] = (width >> 8) & 0xff;
	bytes[10] = width & 0xff;
	return bytes;
}

/** Each tile's bytes describe the tile, so a test can read back what was cut. */
export const stubTiler =
	(
		dimensions: { width: number; height: number },
		encodeTile: (tile: PlannedTile) => Bytes = (tile) =>
			encode(
				JSON.stringify({ region: tile.region, size: tile.size, scaleFactor: tile.scaleFactor })
			)
	): OpenTileSource =>
	async () => ({ dimensions, encodeTile: async (tile) => encodeTile(tile), close: async () => {} });

export async function rejection<E extends Error>(
	ErrorClass: abstract new (...args: never[]) => E,
	run: Promise<unknown> | (() => unknown)
): Promise<E> {
	try {
		await (typeof run === 'function' ? run() : run);
	} catch (cause) {
		if (cause instanceof ErrorClass) return cause;
		throw cause;
	}
	throw new Error(`expected a ${ErrorClass.name}, and nothing was thrown`);
}

export function escapesOutOfBand(): unknown[] {
	const saved = process.listeners('uncaughtException');
	const escaped: unknown[] = [];
	process.removeAllListeners('uncaughtException');
	process.on('uncaughtException', (cause) => escaped.push(cause));
	onTestFinished(() => {
		process.removeAllListeners('uncaughtException');
		for (const listener of saved) process.on('uncaughtException', listener);
	});
	return escaped;
}

export const imageService3 = (fields: Record<string, unknown> = {}) => ({
	'@context': 'http://iiif.io/api/image/3/context.json',
	type: 'ImageService3',
	protocol: 'http://iiif.io/api/image',
	profile: 'level0',
	...fields
});
