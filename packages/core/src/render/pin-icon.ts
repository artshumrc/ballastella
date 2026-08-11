// The pin a Point Annotation is drawn as.
//
// **A pin, not a circle.** A circle on a map reads as an area — a region, a catchment, a radius —
// and a Point Annotation is none of those: it is "this place, here". The teardrop is the one shape
// that says so without a legend, and its tip is the thing being pointed at, which is why the symbol
// is anchored at the bottom rather than centred on the coordinate.
//
// **It is the same drawing as the sidebar's glyph** (`shape-icons.ts` → Lucide's `map-pin`), on the
// same 24×24 grid, so the button that draws a pin, the row that lists one, and the mark on the map
// are recognisably one thing.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A SIGNED DISTANCE FIELD, AND NOT A PNG
//
// Each Annotation carries its own `marker-color`, and **MapLibre honours `icon-color` only on an
// image registered with `{ sdf: true }`**. A plain raster icon is drawn in whatever colours it was
// authored with, so a PNG would mean either one colour for every pin in every Project, or an image
// generated and registered per distinct colour — a cache keyed by hex, invalidated on every drag of
// the colour input. The SDF is registered once and tinted per feature by the GPU.
//
// An SDF stores, in the alpha channel, the *distance* from each pixel to the shape's edge rather
// than coverage. That is what the shader needs to reconstruct a crisp edge at any size. Handing
// MapLibre a plain alpha mask and calling it an SDF is the tempting shortcut and it looks wrong in a
// specific way: the shader thresholds at the halfway value, so a mask's binary alpha produces hard,
// aliased edges that get worse as the icon scales. So the mask is rasterised once and converted with
// a real Euclidean distance transform.
//
// The rasterising needs a canvas and therefore a browser; the transform is arithmetic and is tested
// in Node.

/** The image id both apps register the pin under. */
export const PIN_IMAGE_ID = 'ballastella-pin';

/**
 * The pin, as two subpaths on Lucide's 24×24 grid: the teardrop, and the hole in it.
 *
 * Filled with the even-odd rule, so the second subpath is a hole rather than a disc drawn on top —
 * which is what lets the Base Map show through the pin's eye and keeps the shape legible over dark
 * ground.
 */
const PIN_PATH =
	'M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0Z' +
	'M15 10a3 3 0 1 0-6 0 3 3 0 0 0 6 0Z';

/** How far, in pixels of the rasterised image, the field carries usable distance either side of the edge. */
const SPREAD = 8;

/** The rasterised size. 96 px for a 24-unit drawing: 4× so the mask has edge detail to measure. */
const SIZE = 96;

/**
 * How many image pixels there are per CSS pixel — handed to `addImage` as `pixelRatio`.
 *
 * At 2, the 96 px image is a 48 px icon, which is the size a pin wants to be before `icon-size`
 * scales it for `marker-size`.
 */
export const PIN_PIXEL_RATIO = 2;

/** `icon-size` for each simplestyle `marker-size`, against the 48 px icon above. */
export const PIN_ICON_SIZE: Record<string, number> = { small: 0.5, medium: 0.7, large: 0.95 };

/**
 * A one-dimensional squared-distance transform (Felzenszwalb & Huttenlocher).
 *
 * The lower envelope of a set of parabolas, one per sample, in linear time. Run once per row and
 * once per column, it gives the exact Euclidean distance transform of the whole image — which is
 * what makes this cheap enough to do at startup rather than shipping a generated asset.
 *
 * Exported for its own test: it is the part with arithmetic in it, and the part a canvas would stop
 * us from testing in Node.
 */
export function distanceTransform1d(f: Float64Array): Float64Array {
	const n = f.length;
	const d = new Float64Array(n);
	// `v` is which parabola is lowest in each region, `z` the boundaries between those regions.
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

/** The exact Euclidean distance, in pixels, from every pixel to the nearest set pixel of `mask`. */
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

/**
 * Turn a coverage mask into the alpha channel MapLibre's SDF shader expects.
 *
 * Signed: **inside is above the halfway value and outside is below it**, which is the convention the
 * shader thresholds against. Distances further than {@link SPREAD} from the edge clamp to solid or
 * to nothing, because a field that spent its range on pixels nowhere near the edge would quantise
 * the edge itself — the only part anybody sees — into a handful of steps.
 *
 * Exported for its own test, for the same reason as {@link distanceTransform1d}.
 */
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
		// Positive inside, negative outside, zero on the edge.
		const signed = mask[i] ? (inside[i] as number) : -(outside[i] as number);
		alpha[i] = Math.round(((signed / spread) * 0.5 + 0.5) * 255);
	}
	return alpha;
}

/**
 * The pin as an image MapLibre can register, or `null` where there is no canvas to draw it on.
 *
 * `null` rather than a throw or a fallback, because both apps prerender (ADR-0006): this is reached
 * from a stack build, which only happens in a browser, but a build step that imported its way here
 * should get nothing rather than a crash — and the caller draws no pin layer at all, which is
 * visible, rather than a mis-registered image, which is not.
 */
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

	const scale = SIZE / 24;
	context.clearRect(0, 0, SIZE, SIZE);
	context.setTransform(scale, 0, 0, scale, 0, 0);
	context.fillStyle = '#ffffff';
	context.fill(new Path2D(PIN_PATH), 'evenodd');
	context.setTransform(1, 0, 0, 1, 0, 0);

	const pixels = context.getImageData(0, 0, SIZE, SIZE).data;
	const mask = new Uint8Array(SIZE * SIZE);
	// Halfway coverage is the edge, which is the same threshold the field is built around.
	for (let i = 0; i < mask.length; i += 1) mask[i] = (pixels[i * 4 + 3] as number) >= 128 ? 1 : 0;

	const alpha = signedDistanceAlpha(mask, SIZE, SIZE);
	const data = new Uint8ClampedArray(SIZE * SIZE * 4);
	for (let i = 0; i < mask.length; i += 1) {
		// White throughout; `icon-color` supplies the colour and the alpha carries the shape.
		data[i * 4] = 255;
		data[i * 4 + 1] = 255;
		data[i * 4 + 2] = 255;
		data[i * 4 + 3] = alpha[i] as number;
	}
	return { width: SIZE, height: SIZE, data };
}
