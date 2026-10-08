import { describe, expect, test } from 'vitest';

import { encodeSnapshotPng, readDrawingBuffer } from './map-snapshot.js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

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
		const { canvas, gl } = clearedCanvas(4, 4, [1, 0, 0, 1]);
		gl.enable(gl.SCISSOR_TEST);
		gl.scissor(0, 0, 4, 2);
		gl.clearColor(0, 0, 1, 1);
		gl.clear(gl.COLOR_BUFFER_BIT);
		gl.disable(gl.SCISSOR_TEST);

		const decoded = await decode(await encodeSnapshotPng(readDrawingBuffer(canvas)));
		expect([...decoded.data.slice(0, 4)]).toEqual([255, 0, 0, 255]);
		const bottomLeft = 3 * 4 * 4;
		expect([...decoded.data.slice(bottomLeft, bottomLeft + 4)]).toEqual([0, 0, 255, 255]);
	});

	test('holds at a non-integral device pixel ratio', async () => {
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
