// Shared driving for the Alignment surface: get a Project open with one ingested Historical Map,
// make Control Point pairs, and read what landed in OPFS.
//
// Extracted here because ticket 08's refinement suite needs exactly the ground ticket 07's pairing
// suite stands on — a real pyramid, both panes live, and the Alignment file on disk — and a second
// copy of a hundred lines of PNG encoder and OPFS reader is a second thing to keep true.
// `editor-alignment.e2e.ts` still carries its own; it was written first, and rewriting a green suite
// to import from here would be churn in a file another slice is also touching.

import { expect, type Locator, type Page } from '@playwright/test';
import zlib from 'node:zlib';

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

const chunk = (type: string, data: Buffer): Buffer => {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
};

/** A greyscale gradient PNG, so these tests need no binary fixture. */
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
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

/** The pyramid every test here aligns: wide enough that a mask edit is visibly a change. */
export const IMAGE_WIDTH = 700;
export const IMAGE_HEIGHT = 500;

export const PROJECT_NAME = 'Amsterdam 1625';
export const PROJECT_DIRECTORY = 'amsterdam-1625';

/** One Alignment write the app made, as `alignment/browser-test-handle.ts` records it. */
type AlignmentWrite = { path: string; controlPoints: number };

/**
 * What the Playwright suite is allowed to reach inside the page for.
 *
 * Declared here as well as in the app, because the root tsconfig compiles only `e2e/` and never sees
 * the editor's own declaration — the same duplication `ballastellaServedTiles` carries.
 */
declare global {
	interface Window {
		ballastellaAlignmentWrites?: AlignmentWrite[];
	}
}

/**
 * The warped layer, as much of it as this suite reaches for.
 *
 * **Not a `declare global`, deliberately.** `editor-alignment.e2e.ts` and `editor-warped-fetch.e2e.ts`
 * already declare `window.ballastellaWarped` with the narrower shape each of them needs, and a second
 * global declaration of the same property has to match theirs exactly or the program will not
 * compile. Widening theirs would be churn in two green files for the sake of a type; the cast at the
 * one place this shape is used costs less and touches nothing.
 *
 * Typed loosely and optionally all the way down, on purpose: these are upstream's internals, they are
 * pre-1.0, and a version bump that moves them should fail as a `-1` in an assertion rather than as a
 * compile error in a file that cannot see upstream's types.
 */
interface WarpedHandle {
	map: { fitBounds(bounds: unknown, options?: unknown): void };
	layer: {
		getBounds(): unknown;
		getMapIds?(): string[];
		getMapOptions?(mapId: string): Record<string, unknown> | undefined;
		getWarpedMap?(mapId: string): {
			trianglePointsDistortion?: number[];
			options?: Record<string, unknown>;
		};
		getMapsBbox?(mapIds: string[]): number[] | undefined;
		getMapsConvexHull?(mapIds: string[]): number[][] | undefined;
		renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
	};
}

export async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/**
 * A Project open, one Historical Map ingested, both panes live.
 *
 * @returns the image id, which is the Alignment's file name
 */
export async function start(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();

	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(PROJECT_NAME);
	await dialog.getByRole('button', { name: 'Create' }).click();

	// The wait is load-bearing: a Project is selected client-side from `?p=` (ADR-0008), so for a
	// moment after the click the hub is still rendered — and the hub lists Projects as list items.
	await page.getByRole('link', { name: PROJECT_NAME }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(IMAGE_WIDTH, IMAGE_HEIGHT)
	});
	await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
	const imageId = (await page.getByRole('listitem').first().innerText()).trim();

	await expect(page.getByTestId('image-pane')).toBeVisible();
	await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true'
	);
	// The pairing status only renders once the Alignment has been read, so waiting for it is waiting
	// for the whole surface to be live rather than for a timeout.
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');
	return imageId;
}

/** After a reload, the same wait `start` ends on. */
export async function waitForSurface(page: Page): Promise<void> {
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
	await expect(page.getByTestId('image-pane')).toBeVisible();
	await expect(page.getByTestId('historical-map-tiles')).toHaveAttribute(
		'data-tiles-loaded',
		'true'
	);
}

export const historicalMap = (page: Page) => page.getByTestId('image-pane');
export const baseMap = (page: Page) => page.getByTestId('base-map-pane');
export const rows = (page: Page) => page.getByTestId('control-point-row');
export const warpedStatus = (page: Page) => page.getByTestId('warped-status');

export const imagePoints = (page: Page) =>
	historicalMap(page).locator('[data-testid="pane-overlay-point-control-point"]');

export const maskVertices = (page: Page) =>
	historicalMap(page).locator('[data-testid="pane-overlay-point-mask-vertex"]');

export const maskEdges = (page: Page) =>
	historicalMap(page).locator('[data-testid="pane-overlay-point-mask-edge"]');

/** Click at a fraction across a pane, so the same helper works for both canvases. */
export async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/**
 * Make one complete pair: a click on the Historical Map, then one on the Base Map.
 *
 * Waits for the pending state in between, which is what makes this click-then-click rather than two
 * clicks that happen to arrive in order. The two panes take separate fractions so that a *mirrored*
 * pair set can be built as easily as a well-behaved one.
 */
export async function makePair(
	page: Page,
	image: readonly [number, number],
	base: readonly [number, number] = image
): Promise<void> {
	const before = await rows(page).count();
	await clickAt(historicalMap(page), image[0], image[1]);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(baseMap(page), base[0], base[1]);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
	await expect(rows(page)).toHaveCount(before + 1);
}

/** `count` well-behaved pairs, spread across both panes so the solve is not degenerate. */
export async function makePairs(page: Page, count: number): Promise<void> {
	// A deliberately irregular scatter, and all of it well inside both panes: evenly spaced points on
	// a line are collinear, which is a solve the higher-order polynomials refuse — and MapLibre's
	// navigation control sits in the top-right corner and its attribution along the bottom, so a click
	// near either is a click on a control rather than on the earth.
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

/** The Alignment as it sits in OPFS, or `null` when there is no such file. */
export const storedAlignment = (page: Page, imageId: string, directory = PROJECT_DIRECTORY) =>
	page.evaluate(
		async ([directory, imageId]) => {
			const root = await navigator.storage.getDirectory();
			try {
				const project = await root.getDirectoryHandle(directory as string);
				const alignments = await project.getDirectoryHandle('alignments');
				const handle = await alignments.getFileHandle(`${imageId}.json`);
				return await (await handle.getFile()).text();
			} catch {
				return null;
			}
		},
		[directory, imageId] as const
	);

/** `project.json` as it sits in OPFS, or `null`. */
export const storedProjectFile = (page: Page, directory = PROJECT_DIRECTORY) =>
	page.evaluate(async (directory) => {
		const root = await navigator.storage.getDirectory();
		try {
			const project = await root.getDirectoryHandle(directory);
			const handle = await project.getFileHandle('project.json');
			return await (await handle.getFile()).text();
		} catch {
			return null;
		}
	}, directory);

/**
 * Wait until the Alignment on disk carries `count` pairs.
 *
 * A completed pair is written immediately rather than on a timer (ADR-0017 rule 1), but "immediately"
 * is still a promise: the row appears in the page before the bytes reach OPFS. Reloading inside that
 * window is a race, and one that would fail as "a pair was lost across reload".
 */
export const waitForStored = async (page: Page, imageId: string, count: number): Promise<void> => {
	await expect
		.poll(async () => {
			const written = await storedAlignment(page, imageId);
			if (written === null) return -1;
			return (JSON.parse(written).body?.features ?? []).length;
		})
		.toBe(count);
};

/**
 * How many warped tiles have arrived **and decoded**.
 *
 * `CacheableTile.isCachedTile()` is `data !== undefined`, and `data` is the ImageData the tile worker
 * produced — so this counts tiles that made it all the way through the ADR-0011 shim rather than
 * tiles that were merely asked for. It is the honest signal for "the Historical Map renders warped":
 * the failure this path used to have was an error `@allmaps/render` logged and swallowed, so a check
 * for an absence of console errors went green while the map rendered blank.
 */
export const warpedTiles = async (page: Page): Promise<number> =>
	page.evaluate(async () => {
		const warped = (window as { ballastellaWarped?: WarpedHandle }).ballastellaWarped;
		if (!warped) return -1;
		// Bring the warped map into view, or the renderer has no reason to ask for a tile.
		warped.map.fitBounds(warped.layer.getBounds(), { animate: false });
		await new Promise((resolve) => setTimeout(resolve, 3000));
		return (warped.layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
	});

/** What the renderer thinks it has been asked to draw. `null` when there is no warped map. */
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
			// How far from zero the *displayed* measure is at the triangulated points. Zero everywhere
			// means nothing is being colourised, whatever the options claim.
			worstDistortion: distortion.reduce(
				(worst: number, value: number) => Math.max(worst, Math.abs(value)),
				0
			),
			bbox: layer.getMapsBbox?.([mapId]) ?? null,
			// The convex hull and **not** the bounding box, for "the mask narrows what is drawn": cutting
			// a corner off a rectangle leaves the bounding box exactly where it was, because the three
			// remaining corners still hold every extreme. The hull is the measure that actually moves.
			convexHull: layer.getMapsConvexHull?.([mapId]) ?? null
		};
	});

/** The area of a ring of `[x, y]` points, by the shoelace formula. */
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

/** The `points="…"` attribute of the Resource Mask in a written Alignment. */
export const maskPointsAttribute = (written: string): string => {
	const value = JSON.parse(written).target?.selector?.value as string | undefined;
	return /points="([^"]*)"/.exec(value ?? '')?.[1] ?? '';
};
