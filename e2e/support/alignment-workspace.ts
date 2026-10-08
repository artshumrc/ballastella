import { expect, type Page } from './test.js';
import zlib from 'node:zlib';

import {
	PROJECT_DIRECTORY,
	PROJECT_NAME,
	baseMap,
	clickAt,
	openNewProject
} from './annotations.js';
import { addMapImageFromFile } from './map-images.js';
import { readStoredFileOrNull } from './stored-file';
import { restoreWorkspace, snapshotWorkspace } from './workspace-snapshot.js';
import { emptyWorkspace } from './workspace.js';

const crcTable = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

const crc32 = (bytes: Buffer): number => {
	let c = -1;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

export const pngChunk = (type: string, data: Buffer): Buffer => {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
};

export function gradientPng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x] = (x * 255) / width / 2 + (y * 255) / height / 2;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', ihdr),
		pngChunk('IDAT', zlib.deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

export const IMAGE_WIDTH = 700;
export const IMAGE_HEIGHT = 500;
const TILES_READY_MS = 15_000;

type AlignmentWrite = { path: string; controlPoints: number };

declare global {
	interface Window {
		ballastellaAlignmentWrites?: AlignmentWrite[];
	}
}

interface WarpedHandle {
	map: { fitBounds(bounds: unknown, options?: unknown): void };
	layer: {
		getBounds(): unknown;
		getMapIds?(): string[];
		getMapOptions?(mapId: string): Record<string, unknown> | undefined;
		getWarpedMap?(mapId: string): { trianglePointsDistortion?: number[] };
		getMapsConvexHull?(mapIds: string[]): number[][] | undefined;
		renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
	};
}

async function ingestThroughTheInterface(
	page: Page
): Promise<{ imageId: string; layerId: string }> {
	await page.reload();
	await openNewProject(page, PROJECT_NAME);
	await addMapImageFromFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
	});
	const row = page.getByTestId('layer-row').first();
	const imageId = (await row.getAttribute('data-image-id')) ?? '';
	const layerId = (await row.getAttribute('data-layer-id')) ?? '';
	expect(imageId).not.toBe('');
	expect(layerId).not.toBe('');
	return { imageId, layerId };
}

/** The Map Image is seeded from a snapshot, not ingested: a test about the ingest drives `pickMapImageFile`. */
export async function start(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, 'alignment', ingestThroughTheInterface);
	await restoreWorkspace(page, snapshot.files);
	await page.goto(`/align/?p=${PROJECT_DIRECTORY}&layer=${snapshot.layerId}`);
	await waitForSurface(page);
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');
	return snapshot.imageId;
}

export async function waitForSurface(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();
	await expect(page.getByTestId('image-pane')).toBeVisible();
	await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: TILES_READY_MS
	});
}

export async function showPaneDetails(page: Page): Promise<void> {
	const toggle = page.getByTestId('map-image-details-toggle');
	await expect(toggle).toBeVisible();
	if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
	await expect(page.getByTestId('map-image-pyramid')).toBeVisible();
}

export const mapImage = (page: Page) => page.getByTestId('image-pane');
export const rows = (page: Page) => page.getByTestId('control-point-row');
export const warpedStatus = (page: Page) => page.getByTestId('warped-status');

export const expectWarpedDrawn = async (page: Page): Promise<void> => {
	await expectWarpedLayerAdded(page);
	await expectBaseMapDrawn(page);
};

export const expectWarpedLayerAdded = (page: Page) =>
	expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

const expectBaseMapDrawn = async (page: Page): Promise<void> => {
	await expect
		.poll(
			() =>
				page.evaluate(() => {
					const map = (
						window as unknown as {
							ballastellaBaseMap?: {
								queryRenderedFeatures(): { source?: string }[];
							};
						}
					).ballastellaBaseMap;
					if (map === undefined) return -1;
					return map.queryRenderedFeatures().filter((feature) => feature.source === 'protomaps')
						.length;
				}),
			{
				timeout: BASE_MAP_DRAWN_MS,
				message:
					'the Base Map rendered no geometry of its own — the archive was answered but nothing ' +
					'was parsed out of it, or the map is looking somewhere the fixture has no tiles'
			}
		)
		.toBeGreaterThan(0);
};

const BASE_MAP_DRAWN_MS = 30_000;

export const imagePoints = (page: Page) =>
	mapImage(page).locator('[data-testid="pane-overlay-point-control-point"]');

export const maskVertices = (page: Page) =>
	mapImage(page).locator('[data-testid="pane-overlay-point-mask-vertex"]');

export const maskEdges = (page: Page) =>
	mapImage(page).locator('[data-testid="pane-overlay-point-mask-edge"]');

export async function makePair(
	page: Page,
	image: readonly [number, number],
	base: readonly [number, number] = image
): Promise<void> {
	const before = await rows(page).count();
	await clickAt(mapImage(page), image[0], image[1]);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(baseMap(page), base[0], base[1]);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
	await expect(rows(page)).toHaveCount(before + 1);
}

export async function makePairs(page: Page, count: number): Promise<void> {
	const spots: readonly (readonly [number, number])[] = [
		[0.2, 0.25],
		[0.7, 0.22],
		[0.48, 0.7],
		[0.32, 0.55],
		[0.8, 0.52],
		[0.18, 0.72],
		[0.58, 0.4],
		[0.42, 0.16],
		[0.66, 0.62],
		[0.3, 0.38],
		[0.54, 0.54],
		[0.24, 0.62]
	];
	for (let index = await rows(page).count(); index < count; index += 1) {
		const spot = spots[index % spots.length];
		if (!spot) throw new Error('ran out of places to click');
		await makePair(page, spot);
	}
}

export const watchWrites = (page: Page) =>
	page.evaluate(() => {
		window.ballastellaAlignmentWrites = [];
	});

export const writes = (page: Page) => page.evaluate(() => window.ballastellaAlignmentWrites ?? []);

export const storedAlignment = (page: Page, imageId: string): Promise<string | null> =>
	readStoredFileOrNull(page, `alignments/${imageId}.json`);

export const storedProjectFile = (
	page: Page,
	directory = PROJECT_DIRECTORY
): Promise<string | null> => readStoredFileOrNull(page, `${directory}/project.json`);

export const waitForStored = async (page: Page, imageId: string, count: number): Promise<void> => {
	await expect
		.poll(async () => {
			const written = await storedAlignment(page, imageId);
			if (written === null) return -1;
			return (JSON.parse(written).body?.features ?? []).length;
		})
		.toBe(count);
};

const WARPED_TILE_WAIT_MS = 30_000;

export const warpedTiles = async (page: Page): Promise<number> =>
	page.evaluate(async (ceiling) => {
		const warped = (window as { ballastellaWarped?: WarpedHandle }).ballastellaWarped;
		if (!warped) return -1;
		warped.map.fitBounds(warped.layer.getBounds(), { animate: false });
		const cached = () => (warped.layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
		for (let waited = 0; waited < ceiling && cached() === 0; waited += 200) {
			await new Promise((resolve) => setTimeout(resolve, 200));
		}
		return cached();
	}, WARPED_TILE_WAIT_MS);

export const drawnMap = (page: Page) =>
	page.evaluate(() => {
		const layer = (window as { ballastellaWarped?: WarpedHandle }).ballastellaWarped?.layer;
		const mapId = layer?.getMapIds?.()[0];
		if (!layer || mapId === undefined) return null;
		const warpedMap = layer.getWarpedMap?.(mapId);
		const options = layer.getMapOptions?.(mapId) ?? {};
		const distortion = warpedMap?.trianglePointsDistortion ?? [];
		return {
			mapId,
			transformationType: options.transformationType as string | undefined,
			distortionMeasure: options.distortionMeasure as string | undefined,
			distortionMeasures: (options.distortionMeasures ?? []) as string[],
			renderGrid: options.renderGrid as boolean | undefined,
			applyMask: options.applyMask as boolean | undefined,
			distortionColor00: options.distortionColor00 as string | undefined,
			distortionColor01: options.distortionColor01 as string | undefined,
			distortionColor3: options.distortionColor3 as string | undefined,
			renderGridColor: options.renderGridColor as string | undefined,
			resourceMask: (options.resourceMask ?? []) as number[][],
			gcps: (options.gcps ?? []) as { resource: number[]; geo: number[] }[],
			worstDistortion: distortion.reduce(
				(worst: number, value: number) => Math.max(worst, Math.abs(value)),
				0
			),
			convexHull: layer.getMapsConvexHull?.([mapId]) ?? null
		};
	});

export function ringArea(ring: number[][] | null | undefined): number {
	if (!ring || ring.length < 3) return 0;
	let twice = 0;
	for (let index = 0; index < ring.length; index += 1) {
		const a = ring[index] as number[];
		const b = ring[(index + 1) % ring.length] as number[];
		twice += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
	}
	return Math.abs(twice) / 2;
}

export const maskPointsAttribute = (written: string): string => {
	const value = JSON.parse(written).target?.selector?.value as string | undefined;
	return /points="([^"]*)"/.exec(value ?? '')?.[1] ?? '';
};

export const storedMask = async (page: Page, imageId: string): Promise<string> => {
	const written = await storedAlignment(page, imageId);
	return written === null ? '' : maskPointsAttribute(written);
};
