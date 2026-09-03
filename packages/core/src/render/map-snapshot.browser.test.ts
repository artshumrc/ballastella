// A Map Snapshot's one irreducible browser claim: a real WebGL drawing buffer, read and encoded,
// is a PNG of exactly that buffer's size.
//
// A browser test rather than a node one because every part of it is the platform — `readPixels`
// against a real `WebGLRenderingContext`, `putImageData` into a real canvas, and the browser's own
// PNG encoder — and a stub of any of the three would only prove the stub agrees with itself. The
// row arithmetic is checked without a browser in `map-snapshot.test.ts`.
//
// It runs in Chromium only, excluded from the Firefox instance in `vitest.config.ts`: the GitHub
// Actions runner gives Firefox no WebGL context at all, so there is no drawing buffer there to read.

import { describe, expect, test } from 'vitest';

import { encodeSnapshotPng, readDrawingBuffer } from './map-snapshot.js';

/** The first eight bytes of every PNG, which is what makes a Blob a PNG rather than a claim. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * A canvas with a real WebGL context, cleared to one colour.
 *
 * `preserveDrawingBuffer` is on **here and only here**, because this test reads the buffer from
 * outside a render callback and the map deliberately does not (the whole reason the capture path
 * reads inside `render`). What is under test is the read and the encode, not MapLibre's frame
 * timing.
 */
const clearedCanvas = (
	width: number,
	height: number,
	colour: readonly [number, number, number, number]
): { canvas: HTMLCanvasElement; gl: WebGLRenderingContext } => {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
	if (gl === null) throw new Error('This browser gave no WebGL context to read.');
	gl.clearColor(colour[0], colour[1], colour[2], colour[3]);
	gl.clear(gl.COLOR_BUFFER_BIT);
	return { canvas, gl };
};

/** The pixels of a Blob, back through the browser's own decoder. */
const decode = async (blob: Blob): Promise<ImageData> => {
	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement('canvas');
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;
	const context = canvas.getContext('2d');
	if (context === null) throw new Error('This browser gave no 2d context to decode into.');
	context.drawImage(bitmap, 0, 0);
	return context.getImageData(0, 0, bitmap.width, bitmap.height);
};

describe('reading a real drawing buffer', () => {
	test('answers with the drawing buffer’s own dimensions and its pixels', async () => {
		const { canvas } = clearedCanvas(7, 5, [1, 0, 0, 1]);

		const read = readDrawingBuffer(canvas);

		expect([read.width, read.height]).toEqual([7, 5]);
		expect(read.pixels.length).toBe(7 * 5 * 4);
		// Opaque red, straight out of the context — the read is of the frame, not of a clear colour
		// this module remembered.
		expect([...read.pixels.slice(0, 4)]).toEqual([255, 0, 0, 255]);
	});

	test('refuses a canvas with no WebGL context, which is a failure and not an empty picture', () => {
		const canvas = document.createElement('canvas');
		canvas.getContext('2d');

		expect(() => readDrawingBuffer(canvas)).toThrow(/WebGL/);
	});
});

describe('encoding a read frame', () => {
	test('is a PNG of exactly the drawing buffer’s dimensions', async () => {
		const { canvas } = clearedCanvas(13, 9, [0, 0, 1, 1]);

		const blob = await encodeSnapshotPng(readDrawingBuffer(canvas));

		expect(blob.type).toBe('image/png');
		const signature = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
		expect([...signature]).toEqual(PNG_SIGNATURE);
		const decoded = await decode(blob);
		expect([decoded.width, decoded.height]).toEqual([13, 9]);
	});

	test('is lossless, and the right way up', async () => {
		// The bottom half is drawn a second colour with a scissored clear, so the flip is visible in
		// the decoded image rather than merely asserted about the buffer: WebGL's origin is the
		// bottom-left, so scissoring `y = 0` colours the **bottom** of the picture.
		const { canvas, gl } = clearedCanvas(4, 4, [1, 0, 0, 1]);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(0, 0, 4, 2);
		gl.clearColor(0, 0, 1, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.SCISSOR_TEST);

		const decoded = await decode(await encodeSnapshotPng(readDrawingBuffer(canvas)));

		// Top-left is the red half, bottom-left the blue one, exactly — no interpolation, no
		// resampling, which is what "lossless" is worth asserting about.
		expect([...decoded.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
		const bottomLeft = 3 * 4 * 4;
		expect([...decoded.data.slice(bottomLeft, bottomLeft + 4)]).toEqual([0, 0, 255, 255]);
	});

	test('holds at a non-integral device pixel ratio', async () => {
		// A 1.5× display gives MapLibre a drawing buffer that is not a whole multiple of the CSS box,
		// and its width and height are what the file must be — not the CSS size, and not a rounding of
		// either. 600 × 400 CSS pixels at 1.5 is the case, written out as the buffer the browser would
		// have.
		const cssWidth = 61;
		const cssHeight = 41;
		const ratio = 1.5;
		const { canvas } = clearedCanvas(
			Math.round(cssWidth * ratio),
			Math.round(cssHeight * ratio),
			[0, 1, 0, 1]
		);
		canvas.style.width = `${cssWidth}px`;
		canvas.style.height = `${cssHeight}px`;

		const decoded = await decode(await encodeSnapshotPng(readDrawingBuffer(canvas)));

		expect([decoded.width, decoded.height]).toEqual([92, 62]);
	});

	test('refuses when the browser hands back no Blob at all', async () => {
		// `toBlob` is specified to be able to call back with `null`, and a snapshot that quietly
		// became nothing is the one failure a scholar would mistake for a successful download.
		const encoder = HTMLCanvasElement.prototype.toBlob;
		HTMLCanvasElement.prototype.toBlob = function refuse(callback: BlobCallback): void {
			callback(null);
		};
		const { canvas } = clearedCanvas(2, 2, [1, 1, 1, 1]);
		const read = readDrawingBuffer(canvas);

		try {
			await expect(encodeSnapshotPng(read)).rejects.toThrow(/PNG/);
		} finally {
			HTMLCanvasElement.prototype.toBlob = encoder;
		}
	});
});
