import { generateRandomId } from '@allmaps/id';

import {
	messageOf,
	serialiseJson,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import {
	IMAGE_DIRECTORY,
	imageDirectory,
	imageInfoPath,
	imageManifestPath
} from '../project/image-files.js';
import { MAX_INGEST_PIXELS } from './decode-ceiling.js';
import { readImageHeaderFromBlob } from './image-header.js';
import { buildImageManifest } from './image-manifest.js';
import { buildImageInfo, planPyramid, type PlannedTile } from './pyramid.js';

export interface TileSource {
	readonly dimensions: { readonly width: number; readonly height: number };
	encodeTile(tile: PlannedTile): Promise<Bytes>;
	close(): Promise<void>;
}

export type OpenTileSource = (file: Blob) => Promise<TileSource>;

export type IngestProgress = {
	readonly phase: 'inspecting' | 'opening' | 'tiling' | 'finishing' | 'done';
	readonly tilesWritten: number;
	readonly tileCount: number;
	readonly fraction: number;
};

export type IngestResult = {
	readonly imageId: string;
	readonly directory: StorePath;
	readonly infoPath: StorePath;
	readonly manifestPath: StorePath;
	readonly width: number;
	readonly height: number;
	readonly tileCount: number;
};

export type IngestedImage = {
	readonly imageId: string;
	readonly directory: StorePath;
	readonly infoPath: StorePath;
};

export async function listIngestedImages(store: ProjectStore): Promise<IngestedImage[]> {
	const prefix = `${IMAGE_DIRECTORY}/`;
	const paths = await store.list(prefix);

	return paths
		.filter((path) => path.endsWith('/info.json'))
		.map((path) => {
			const directory = path.slice(0, -'/info.json'.length);
			return { imageId: directory.slice(prefix.length), directory, infoPath: path };
		})
		.filter((image) => !image.imageId.includes('/'));
}

export class ImageTooLargeError extends Error {
	override readonly name = 'ImageTooLargeError';

	constructor(
		readonly pixels: number,
		readonly maxPixels: number
	) {
		super(
			`This file is ${Math.round(pixels / 1e6)} megapixels, above the ` +
				`${Math.round(maxPixels / 1e6)} megapixel limit of what a browser can decode. Convert it ` +
				`to a IIIF pyramid outside the browser and add that instead. Nothing has been added to ` +
				`the Workspace.`
		);
	}
}

export class UnreadableImageError extends Error {
	override readonly name = 'UnreadableImageError';

	constructor(cause: unknown) {
		super(
			`This file could not be read as an image. Browsers read JPEG, PNG, WebP, GIF and AVIF; ` +
				`a TIFF or JPEG 2000 archival master needs to be converted first. (${messageOf(cause)})`
		);
	}
}

// Every tile lands before info.json, so an interrupted ingest leaves no image that looks complete.
export async function ingestImageFile(options: {
	readonly store: ProjectStore;
	readonly file: File | Blob;
	readonly label?: string;
	// Only an offline copy passes one: it must keep `generateId(uri)`.
	readonly imageId?: string;
	readonly openDecodeAndCrop: OpenTileSource;
	readonly maxIngestPixels?: number;
	readonly onProgress?: (progress: IngestProgress) => void;
	readonly signal?: AbortSignal;
}): Promise<IngestResult> {
	const {
		store,
		file,
		openDecodeAndCrop,
		maxIngestPixels = MAX_INGEST_PIXELS,
		onProgress,
		signal
	} = options;

	const label = options.label ?? (file instanceof File ? file.name : 'Untitled image');
	let tilesWritten = 0;
	let tileCount = 0;

	const report = (phase: IngestProgress['phase']) => {
		onProgress?.({
			phase,
			tilesWritten,
			tileCount,
			fraction:
				phase === 'done' ? 1 : tileCount === 0 ? 0 : Math.min(0.99, tilesWritten / tileCount)
		});
	};

	report('inspecting');
	signal?.throwIfAborted();

	const header = await readImageHeaderFromBlob(file);
	const headerPixels = header ? header.width * header.height : undefined;

	if (headerPixels !== undefined && headerPixels > maxIngestPixels) {
		throw new ImageTooLargeError(headerPixels, maxIngestPixels);
	}

	report('opening');
	signal?.throwIfAborted();

	let source: TileSource;
	try {
		source = await openDecodeAndCrop(file);
	} catch (cause) {
		throw new UnreadableImageError(cause);
	}

	const written: StorePath[] = [];

	try {
		const { width, height } = source.dimensions;
		const imageId = options.imageId ?? (await generateRandomId());
		const directory = imageDirectory(imageId);
		const info = buildImageInfo({ imageId, width, height });
		const tiles = planPyramid(info, directory);
		tileCount = tiles.length;
		report('tiling');

		for (const tile of tiles) {
			signal?.throwIfAborted();
			const bytes = await source.encodeTile(tile);
			await store.write(tile.path, bytes);
			written.push(tile.path);
			tilesWritten += 1;
			report('tiling');
		}

		report('finishing');
		signal?.throwIfAborted();

		const infoPath = imageInfoPath(imageId);
		const manifestPath = imageManifestPath(imageId);
		await store.write(manifestPath, serialiseJson(buildImageManifest({ imageId, label, info })));
		written.push(manifestPath);
		signal?.throwIfAborted();
		await store.write(infoPath, serialiseJson(info));
		written.push(infoPath);
		signal?.throwIfAborted();

		report('done');

		return {
			imageId,
			directory,
			infoPath,
			manifestPath,
			width,
			height,
			tileCount
		};
	} catch (cause) {
		await Promise.all(written.map((path) => store.delete(path).catch(() => undefined)));
		throw cause;
	} finally {
		await source.close().catch(() => undefined);
	}
}
