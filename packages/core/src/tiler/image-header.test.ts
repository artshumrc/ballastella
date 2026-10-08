import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { encode } from '../test-support.js';
import { IMAGE_HEADER_BYTES, readImageHeader, readImageHeaderFromBlob } from './image-header.js';

const FIXTURE_DIRECTORY = new URL(
	'../../../../apps/editor/static/fixtures/images/floride-1657/',
	import.meta.url
);

function tiffWithTrailingIfd(width: number, height: number, ifdOffset: number): Uint8Array {
	const bytes = new Uint8Array(ifdOffset + 2 + 24 + 4);
	const view = new DataView(bytes.buffer);
	bytes.set([0x49, 0x49]);
	view.setUint16(2, 42, true);
	view.setUint32(4, ifdOffset, true);
	bytes.fill(0x7f, 8, ifdOffset);
	view.setUint16(ifdOffset, 2, true);
	view.setUint16(ifdOffset + 2, 256, true);
	view.setUint16(ifdOffset + 4, 4, true);
	view.setUint32(ifdOffset + 6, 1, true);
	view.setUint32(ifdOffset + 10, width, true);
	view.setUint16(ifdOffset + 14, 257, true);
	view.setUint16(ifdOffset + 16, 4, true);
	view.setUint32(ifdOffset + 18, 1, true);
	view.setUint32(ifdOffset + 22, height, true);
	return bytes;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

const webp = (chunk: string): { bytes: Uint8Array; view: DataView } => {
	const bytes = new Uint8Array(30);
	bytes.set(ascii('RIFF'));
	bytes.set(ascii('WEBP'), 8);
	bytes.set(ascii(chunk), 12);
	return { bytes, view: new DataView(bytes.buffer) };
};

describe('readImageHeader', () => {
	it('reads a real JPEG, produced by something other than this repository', async () => {
		const bytes = await readFile(new URL('0,0,1200,851/150,107/0/default.jpg', FIXTURE_DIRECTORY));
		expect(readImageHeader(bytes)).toEqual({ width: 150, height: 107, format: 'jpeg' });
	});

	it('reads every committed fixture tile at the size its own URL claims', async () => {
		const info = JSON.parse(
			await readFile(new URL('info.json', FIXTURE_DIRECTORY), 'utf8')
		) as unknown;
		expect(info).toBeTruthy();

		for (const path of [
			'0,0,256,256/256,256/0/default.jpg',
			'1024,0,176,256/176,256/0/default.jpg',
			'0,768,256,83/256,83/0/default.jpg',
			'1024,768,176,83/176,83/0/default.jpg',
			'0,0,1024,851/256,213/0/default.jpg',
			'1024,0,176,851/44,213/0/default.jpg'
		]) {
			const [width, height] = path.split('/')[1]!.split(',').map(Number);
			const bytes = await readFile(new URL(path, FIXTURE_DIRECTORY));
			expect(readImageHeader(bytes), path).toEqual({ width, height, format: 'jpeg' });
		}
	});

	it('walks past a long metadata segment to the frame header', () => {
		const exif = new Uint8Array(40_000);
		exif[0] = 0xff;
		exif[1] = 0xe1;
		exif[2] = (39_998 >> 8) & 0xff;
		exif[3] = 39_998 & 0xff;
		const jpeg = new Uint8Array([
			0xff,
			0xd8,
			...exif,
			0xff,
			0xc2,
			0x00,
			0x11,
			0x08,
			0x9c,
			0x40,
			0x75,
			0x30,
			0x03
		]);
		expect(readImageHeader(jpeg)).toEqual({ width: 30_000, height: 40_000, format: 'jpeg' });
	});

	it('reads a PNG', () => {
		const png = new Uint8Array(24);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		png.set([0x49, 0x48, 0x44, 0x52], 12);
		new DataView(png.buffer).setUint32(16, 100_000);
		new DataView(png.buffer).setUint32(20, 4);
		expect(readImageHeader(png)).toEqual({ width: 100_000, height: 4, format: 'png' });
	});

	it('reads a GIF', () => {
		const gif = new Uint8Array(10);
		gif.set(ascii('GIF89a'));
		new DataView(gif.buffer).setUint16(6, 640, true);
		new DataView(gif.buffer).setUint16(8, 480, true);
		expect(readImageHeader(gif)).toEqual({ width: 640, height: 480, format: 'gif' });
	});

	it('reads a bottom-up BMP as a positive height', () => {
		const bmp = new Uint8Array(26);
		bmp.set([0x42, 0x4d]);
		const view = new DataView(bmp.buffer);
		view.setUint32(14, 40, true);
		view.setInt32(18, 800, true);
		view.setInt32(22, -600, true);
		expect(readImageHeader(bmp)).toEqual({ width: 800, height: 600, format: 'bmp' });
	});

	it('reads a lossy WebP', () => {
		const { bytes, view } = webp('VP8 ');
		view.setUint16(26, 1234, true);
		view.setUint16(28, 567, true);
		expect(readImageHeader(bytes)).toEqual({ width: 1234, height: 567, format: 'webp' });
	});

	it('reads an extended WebP canvas size', () => {
		const { bytes, view } = webp('VP8X');
		view.setUint16(24, (16_383 - 1) & 0xffff, true);
		bytes[26] = ((16_383 - 1) >> 16) & 0xff;
		view.setUint16(27, (9_000 - 1) & 0xffff, true);
		bytes[29] = ((9_000 - 1) >> 16) & 0xff;
		expect(readImageHeader(bytes)).toEqual({ width: 16_383, height: 9_000, format: 'webp' });
	});

	it('reads a TIFF, whose dimensions need 32 bits at archival sizes', () => {
		expect(readImageHeader(tiffWithTrailingIfd(47_000, 31_500, 8))).toEqual({
			width: 47_000,
			height: 31_500,
			format: 'tiff'
		});
	});

	it('reads a big-endian TIFF with SHORT dimensions', () => {
		const tiff = new Uint8Array(8 + 2 + 24 + 4);
		const view = new DataView(tiff.buffer);
		tiff.set([0x4d, 0x4d]);
		view.setUint16(2, 42);
		view.setUint32(4, 8);
		view.setUint16(8, 2);
		view.setUint16(10, 256);
		view.setUint16(12, 3);
		view.setUint32(14, 1);
		view.setUint16(18, 4000);
		view.setUint16(22, 257);
		view.setUint16(24, 3);
		view.setUint32(26, 1);
		view.setUint16(30, 3000);
		expect(readImageHeader(tiff)).toEqual({ width: 4000, height: 3000, format: 'tiff' });
	});

	it('says nothing rather than guessing, for a container it does not know', () => {
		expect(readImageHeader(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined();
		expect(readImageHeader(new Uint8Array(0))).toBeUndefined();
		expect(readImageHeader(encode('<svg width="10"></svg>'))).toBeUndefined();
		expect(
			readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])),
			'a JPEG truncated before its frame header'
		).toBeUndefined();
	});
});

describe('readImageHeaderFromBlob', () => {
	it('follows a TIFF’s IFD pointer past the header window', async () => {
		const tiff = tiffWithTrailingIfd(47_000, 31_500, IMAGE_HEADER_BYTES + 4096);
		expect(readImageHeader(tiff.subarray(0, IMAGE_HEADER_BYTES))).toBeUndefined();

		expect(await readImageHeaderFromBlob(new Blob([tiff as BlobPart]))).toEqual({
			width: 47_000,
			height: 31_500,
			format: 'tiff'
		});
	});

	it('reads a TIFF whose IFD is at the front without a second read', async () => {
		const tiff = tiffWithTrailingIfd(4000, 3000, 8);

		expect(await readImageHeaderFromBlob(new Blob([tiff as BlobPart]))).toEqual({
			width: 4000,
			height: 3000,
			format: 'tiff'
		});
	});

	it('says nothing for a TIFF whose IFD pointer leads outside the file', async () => {
		const tiff = tiffWithTrailingIfd(4000, 3000, IMAGE_HEADER_BYTES + 16);

		expect(
			await readImageHeaderFromBlob(new Blob([tiff.subarray(0, IMAGE_HEADER_BYTES) as BlobPart]))
		).toBeUndefined();
	});

	it('reads every other container from the first slice, unchanged', async () => {
		const png = new Uint8Array(24);
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
		new DataView(png.buffer).setUint32(16, 1200);
		new DataView(png.buffer).setUint32(20, 851);

		expect(await readImageHeaderFromBlob(new Blob([png as BlobPart]))).toEqual({
			width: 1200,
			height: 851,
			format: 'png'
		});
		expect(await readImageHeaderFromBlob(new Blob([new Uint8Array([1, 2, 3]) as BlobPart]))).toBe(
			undefined
		);
	});
});
