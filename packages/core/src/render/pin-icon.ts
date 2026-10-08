import { NEEDLE_GRID, NEEDLE_HEAD_PATH, NEEDLE_SHAFT_PATH } from './needle.js';

export const PIN_IMAGE_ID = 'ballastella-pin';
const SPREAD = 8;
const SIZE = NEEDLE_GRID * 4;
export const PIN_PIXEL_RATIO = 2;
export const PIN_ICON_SIZE = { small: 0.5, medium: 0.7, large: 0.95 } as const;

export const pinHeight = (markerSize: string | undefined): number =>
	Math.round(
		(SIZE / PIN_PIXEL_RATIO) *
			((PIN_ICON_SIZE as Record<string, number>)[markerSize ?? 'medium'] ?? PIN_ICON_SIZE.medium)
	);

export function distanceTransform1d(f: Float64Array): Float64Array {
	const n = f.length;
	const d = new Float64Array(n);
	const v = new Int32Array(n);
	const z = new Float64Array(n + 1);
	let k = 0;
	v[0] = 0;
	z[0] = -Infinity;
	z[1] = Infinity;
	for (let q = 1; q < n; q += 1) {
		let intersection: number;
		for (;;) {
			const p = v[k] as number;
			intersection = ((f[q] as number) + q * q - ((f[p] as number) + p * p)) / (2 * q - 2 * p);
			if (intersection > (z[k] as number)) break;
			k -= 1;
		}
		k += 1;
		v[k] = q;
		z[k] = intersection;
		z[k + 1] = Infinity;
	}
	k = 0;
	for (let q = 0; q < n; q += 1) {
		while ((z[k + 1] as number) < q) k += 1;
		const p = v[k] as number;
		d[q] = (q - p) * (q - p) + (f[p] as number);
	}
	return d;
}

function distanceField(mask: Uint8Array, width: number, height: number): Float64Array {
	const INF = 1e20;
	const grid = new Float64Array(width * height);
	for (let i = 0; i < grid.length; i += 1) grid[i] = mask[i] ? 0 : INF;
	const column = new Float64Array(height);
	const row = new Float64Array(width);
	for (let x = 0; x < width; x += 1) {
		for (let y = 0; y < height; y += 1) column[y] = grid[y * width + x] as number;
		const done = distanceTransform1d(column);
		for (let y = 0; y < height; y += 1) grid[y * width + x] = done[y] as number;
	}
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) row[x] = grid[y * width + x] as number;
		const done = distanceTransform1d(row);
		for (let x = 0; x < width; x += 1) grid[y * width + x] = Math.sqrt(done[x] as number);
	}
	return grid;
}

export function signedDistanceAlpha(
	mask: Uint8Array,
	width: number,
	height: number,
	spread = SPREAD
): Uint8ClampedArray {
	const outside = distanceField(mask, width, height);
	const inverted = new Uint8Array(mask.length);
	for (let i = 0; i < mask.length; i += 1) inverted[i] = mask[i] ? 0 : 1;
	const inside = distanceField(inverted, width, height);
	const alpha = new Uint8ClampedArray(mask.length);
	for (let i = 0; i < mask.length; i += 1) {
		const signed = mask[i] ? (inside[i] as number) : -(outside[i] as number);
		alpha[i] = Math.round(((signed / spread) * 0.5 + 0.5) * 255);
	}
	return alpha;
}

export function pinImage(): { width: number; height: number; data: Uint8ClampedArray } | null {
	const canvas =
		typeof OffscreenCanvas === 'function'
			? new OffscreenCanvas(SIZE, SIZE)
			: typeof document === 'undefined'
				? null
				: Object.assign(document.createElement('canvas'), { width: SIZE, height: SIZE });
	if (canvas === null) return null;
	const context = canvas.getContext('2d') as
		| (CanvasRenderingContext2D & {
				getImageData(x: number, y: number, w: number, h: number): ImageData;
		  })
		| null;
	if (context === null || typeof Path2D !== 'function') return null;
	const scale = SIZE / NEEDLE_GRID;
	context.clearRect(0, 0, SIZE, SIZE);
	context.setTransform(scale, 0, 0, scale, 0, 0);
	context.fillStyle = '#ffffff';
	context.fill(new Path2D(NEEDLE_HEAD_PATH));
	context.fill(new Path2D(NEEDLE_SHAFT_PATH));
	context.setTransform(1, 0, 0, 1, 0, 0);

	const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
	const mask = new Uint8Array(SIZE * SIZE);
	for (let i = 0; i < mask.length; i += 1) mask[i] = (pixels[i * 4 + 3] as number) >= 128 ? 1 : 0;

	return sdfImage(signedDistanceAlpha(mask, SIZE, SIZE), SIZE);
}

// White throughout: `icon-color` tints it and the alpha carries the shape.
export function sdfImage(
	alpha: Uint8ClampedArray,
	size: number
): { width: number; height: number; data: Uint8ClampedArray } {
	const data = new Uint8ClampedArray(size * size * 4).fill(255);
	for (let i = 0; i < alpha.length; i += 1) data[i * 4 + 3] = alpha[i] as number;
	return { width: size, height: size, data };
}
