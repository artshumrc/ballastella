import { packTar, type TarEntry } from 'modern-tar';

import { PROJECT_FILE_NAME, parseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { decode, encode } from '../test-support.js';
import { TAR_ENTRY_MTIME } from './archive.js';
import {
	createProjectImportSource,
	type ClosurePath,
	type ProjectImportOrigin,
	type ProjectImportSource
} from './project-import-source.js';

export const json = (value: unknown): string => `${JSON.stringify(value, null, '\t')}\n`;

export const PLAN_LAYER = {
	id: 'l1',
	name: 'The 1625 plan',
	visible: true,
	order: 0,
	kind: 'map',
	opacity: 0.8,
	imageId: 'amsterdam-1625'
};

export const WAREHOUSES_LAYER = {
	id: 'l2',
	name: 'Warehouses',
	visible: true,
	order: 1,
	kind: 'annotation',
	geojsonRef: 'annotations/warehouses.geojson'
};

export const projectJson = (overrides: Record<string, unknown> = {}): string =>
	json({
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [PLAN_LAYER, WAREHOUSES_LAYER],
		baseMap: 'protomaps-light',
		...overrides
	});

export const georeferenceDocument = (service: string, width = 1200, height = 851, order = 1) => ({
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: { id: service, type: 'ImageService3', width, height },
		selector: {
			type: 'SvgSelector',
			value: `<svg width="${width}" height="${height}"><polygon points="10,20 1190,20 1190,830 10,830" /></svg>`
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order } },
		features: [
			[263, 200, 4.88969, 52.37403],
			[612, 168, 4.9, 52.38],
			[700, 545, 4.91, 52.36]
		].map(([x, y, lng, lat]) => ({
			type: 'Feature',
			properties: { resourceCoords: [x, y] },
			geometry: { type: 'Point', coordinates: [lng, lat] }
		}))
	}
});

/** Planted rather than written, so no write is counted against a store armed to fail. */
export function planted<T extends MemoryProjectStore>(
	files: Record<string, string>,
	store: T = new MemoryProjectStore() as T
): T {
	for (const [path, content] of Object.entries(files)) store.plant(path, encode(content));
	return store;
}

/** Temporary files included, unlike `snapshot`. */
export const contents = (store: MemoryProjectStore): Record<string, string> =>
	Object.fromEntries([...store.snapshot()].map(([path, bytes]) => [path, decode(bytes)]));

export const tarOf = async (
	entries: readonly (readonly [name: string, body?: string])[],
	pax?: Record<string, string>
): Promise<Bytes> =>
	(await packTar(
		entries.map(([name, body]): TarEntry => {
			const mtime = TAR_ENTRY_MTIME;
			if (body === undefined) {
				return { header: { name, size: 0, type: 'directory', mtime, ...(pax ? { pax } : {}) } };
			}
			const bytes = encode(body);
			return { header: { name, size: bytes.length, type: 'file', mtime }, body: bytes };
		})
	)) as Bytes;

export function destination<T extends object>(name: string, extra: T) {
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
				...extra,
				discard: async () => {
					discarded = true;
					for (const path of await store.list('')) await store.delete(path);
				}
			};
		}
	};
}

export const REVIEW_ORIGIN: ProjectImportOrigin = {
	kind: 'review',
	projectName: 'Amsterdam 1625',
	directory: 'amsterdam-1625'
};

export function closureSource(
	files: Record<ClosurePath, string>,
	options: {
		readonly origin?: ProjectImportOrigin;
		readonly order?: readonly ClosurePath[];
		readonly between?: ((path: ClosurePath) => void | Promise<void>) | undefined;
	} = {}
): ProjectImportSource {
	const projectFileBytes = encode(files[PROJECT_FILE_NAME] ?? '');
	const order = options.order ?? Object.keys(files).sort();
	return createProjectImportSource({
		origin: options.origin ?? REVIEW_ORIGIN,
		project: parseProjectFile(projectFileBytes),
		projectFileBytes,
		offered: Object.entries(files).map(([path, text]) => ({
			path,
			bytes: encode(text).byteLength
		})),
		files: async function* (wanted) {
			for (const path of order.filter((one) => wanted.includes(one))) {
				yield { path, bytes: encode(files[path] ?? '') };
				await options.between?.(path);
			}
		}
	});
}

export async function delivered(source: ProjectImportSource): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for await (const file of source.files()) out[file.path] = decode(file.bytes);
	return out;
}
