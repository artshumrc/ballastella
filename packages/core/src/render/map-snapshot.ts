// A Map Snapshot: the map's own framebuffer, the right way up, as a PNG.
//
// **In `core` because both applications download the same picture**, and because every step below
// has a way of going wrong that produces a plausible file rather than an error — an upside-down map,
// a map at the CSS size instead of the drawing buffer's, a `null` Blob that reaches the download as
// nothing at all. Two copies of these rules would agree until one of them was edited.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THE CAPTURE IS A RENDER CALLBACK AND NOT A `toBlob` ON THE MAP'S CANVAS
//
// MapLibre creates its WebGL context with the default `preserveDrawingBuffer: false`, which is what
// keeps ordinary panning cheap: the browser is free to discard the buffer the moment the frame is
// presented. Anything that reads the canvas afterwards — `toBlob`, `toDataURL`, `readPixels` — is
// reading a buffer the specification says may already be empty, and in practice usually is.
//
// So {@link captureMapFrame} asks for one more frame and reads it **synchronously inside the
// `render` event**, which MapLibre fires at the end of its paint with the frame still intact. That
// is the whole technique, and it is why nothing here is `async` between the callback and the read.
// Turning `preserveDrawingBuffer` on permanently would remove the constraint and put its cost on
// every gesture instead, which is a trade this feature is not entitled to make.
//
// Nothing here imports `maplibre-gl`, not even for a type: the runtime side of this module is a
// canvas, a WebGL context and the browser's PNG encoder, and {@link SnapshotSource} is the three
// methods a map has to offer. So the browser tests reach all of it without a map.

/** RGBA, which is the only format `readPixels` is required to support for the default framebuffer. */
const BYTES_PER_PIXEL = 4;

/** What a Map Snapshot of one Project is called, given the Project's directory name. */
export const mapSnapshotFileName = (directory: string): string => `${directory}.map-snapshot.png`;

/** One frame, as WebGL handed it over: bottom row first. */
export interface DrawingBufferRead {
	readonly pixels: Uint8Array;
	readonly width: number;
	readonly height: number;
}

/**
 * The whole of what capturing a frame needs from a MapLibre map.
 *
 * Structural rather than `Map` itself, so a browser test can drive {@link captureMapFrame} with a
 * canvas and no map at all — and so that reading this says what the capture actually touches, which
 * is three methods rather than every gesture on the pane.
 */
export interface SnapshotSource {
	getCanvas(): HTMLCanvasElement;
	once(type: 'render', listener: () => void): unknown;
	triggerRepaint(): void;
}

/**
 * Turn a `readPixels` buffer into image order.
 *
 * WebGL's origin is the bottom-left and `putImageData`'s is the top-left, so the rows come back
 * reversed and nothing downstream can tell: an upside-down map is still a map. Only the rows move;
 * the pixels within a row are already in the same order both conventions use.
 *
 * A new buffer rather than a flip in place, because the caller's is the one the context filled and
 * a second pass over a flipped buffer would quietly undo the first.
 */
export function flipPixelRows(
	pixels: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number
): Uint8ClampedArray<ArrayBuffer> {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(
			`A frame of ${width} × ${height} has no dimensions to encode: both have to be whole pixels above zero.`
		);
	}
	const stride = width * BYTES_PER_PIXEL;
	const expected = stride * height;
	if (pixels.length !== expected) {
		throw new Error(
			`A ${width} × ${height} frame is ${expected} bytes, but this read is ${pixels.length}.`
		);
	}
	// Over an `ArrayBuffer` explicitly, not the `ArrayBufferLike` a bare `new Uint8ClampedArray(n)`
	// is typed as: `ImageData` will not take a view that might be over shared memory.
	const flipped = new Uint8ClampedArray(new ArrayBuffer(expected));
	for (let row = 0; row < height; row += 1) {
		flipped.set(pixels.subarray(row * stride, (row + 1) * stride), (height - 1 - row) * stride);
	}
	return flipped;
}

/**
 * Read the default framebuffer of `canvas` at its drawing-buffer size.
 *
 * `drawingBufferWidth`/`Height` rather than `canvas.width` — they are the same number whenever the
 * browser honoured the size asked for, and when it did not (a context capped at the platform's
 * maximum) they are the size of the pixels that actually exist, which is the size that can be read.
 *
 * ⚠ **The default framebuffer is bound first.** A custom layer that renders through a framebuffer of
 * its own — which is how warped Map Images are drawn — may have left it bound, and reading from it
 * would give a Map Snapshot of that layer's intermediate texture rather than of the map.
 */
export function readDrawingBuffer(canvas: HTMLCanvasElement): DrawingBufferRead {
	const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as
		WebGL2RenderingContext | WebGLRenderingContext | null;
	if (gl === null) throw new Error('This canvas has no WebGL context to read a frame from.');
	const width = gl.drawingBufferWidth;
	const height = gl.drawingBufferHeight;
	const pixels = new Uint8Array(width * height * BYTES_PER_PIXEL);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
	return { pixels, width, height };
}

/**
 * Encode a read frame as a lossless PNG.
 *
 * The frame goes through a two-dimensional canvas of exactly its own size, because `putImageData`
 * plus `toBlob` is the only PNG encoder the platform offers and it takes a canvas. Nothing is
 * scaled, cropped or resampled on the way: the file is the pixels the display already drew.
 *
 * `toBlob` is specified to be able to call back with `null`, so that is a rejection rather than an
 * empty download — the one failure a scholar would otherwise mistake for a successful capture.
 */
export async function encodeSnapshotPng(read: DrawingBufferRead): Promise<Blob> {
	const { width, height } = read;
	const image = new ImageData(flipPixelRows(read.pixels, width, height), width, height);
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('This browser gave no 2d context to encode the PNG in.');
	context.putImageData(image, 0, 0);
	return new Promise<Blob>((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob === null) {
				reject(new Error('The browser produced no PNG for this frame.'));
				return;
			}
			resolve(blob);
		}, 'image/png');
	});
}

/**
 * One more frame of `map`, captured as a PNG.
 *
 * See this module's header for why the read is inside the `render` callback. The caller is
 * responsible for what is *in* the frame — a clean one has no selection emphasis and no drawing
 * preview — because only the caller knows what to put back afterwards.
 */
export async function captureMapFrame(map: SnapshotSource): Promise<Blob> {
	const read = await new Promise<DrawingBufferRead>((resolve, reject) => {
		map.once('render', () => {
			try {
				resolve(readDrawingBuffer(map.getCanvas()));
			} catch (cause) {
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
		map.triggerRepaint();
	});
	return encodeSnapshotPng(read);
}
