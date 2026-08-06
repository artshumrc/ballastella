import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { readImageHeader } from './image-header.js';

const FIXTURE_DIRECTORY = new URL(
	'../../../../apps/editor/static/fixtures/images/floride-1657/',
	import.meta.url
);

describe('readImageHeader', () => {
	it('reads a real JPEG, produced by something other than this repository', async () => {
		// The coarsest committed fixture tile: 150 × 107, which is also a size a naive fixed-offset
		// reader gets wrong, because nothing about it is a round number.
		const bytes = await readFile(new URL('0,0,1200,851/150,107/0/default.jpg', FIXTURE_DIRECTORY));
		expect(readImageHeader(bytes)).toEqual({ width: 150, height: 107, format: 'jpeg' });
	});

	it('reads every committed fixture tile at the size its own URL claims', async () => {
		// The header reader and the IIIF path have to agree about what a tile is, and the fixture is
		// 29 independent chances for them not to.
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
		// A scan out of a digitisation lab opens with tens of kilobytes of EXIF or ICC, and a reader
		// that assumed the frame header came first would report the wrong size — or, worse, read two
		// bytes of an ICC profile as an image's dimensions.
		const exif = new Uint8Array(40_000);
		exif[0] = 0xff;
		exif[1] = 0xe1;
		exif[2] = (39_998 >> 8) & 0xff;
		exif[3] = 39_998 & 0xff;
		const jpeg = new Uint8Array([
			0xff,
			0xd8,
			...exif,
			// SOF2, progressive, which a large scan often is.
			0xff,
			0xc2,
			0x00,
			0x11,
			0x08,
			0x9c,
			0x40, // height 40000
			0x75,
			0x30, // width 30000
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
		gif.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
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
		const webp = new Uint8Array(30);
		webp.set([...'RIFF'].map((c) => c.charCodeAt(0)));
		webp.set(
			[...'WEBP'].map((c) => c.charCodeAt(0)),
			8
		);
		webp.set(
			[...'VP8 '].map((c) => c.charCodeAt(0)),
			12
		);
		const view = new DataView(webp.buffer);
		view.setUint16(26, 1234, true);
		view.setUint16(28, 567, true);
		expect(readImageHeader(webp)).toEqual({ width: 1234, height: 567, format: 'webp' });
	});

	it('reads an extended WebP canvas size', () => {
		const webp = new Uint8Array(30);
		webp.set([...'RIFF'].map((c) => c.charCodeAt(0)));
		webp.set(
			[...'WEBP'].map((c) => c.charCodeAt(0)),
			8
		);
		webp.set(
			[...'VP8X'].map((c) => c.charCodeAt(0)),
			12
		);
		const view = new DataView(webp.buffer);
		// Stored minus one, 24 bits little-endian.
		view.setUint16(24, (16_383 - 1) & 0xffff, true);
		webp[26] = ((16_383 - 1) >> 16) & 0xff;
		view.setUint16(27, (9_000 - 1) & 0xffff, true);
		webp[29] = ((9_000 - 1) >> 16) & 0xff;
		expect(readImageHeader(webp)).toEqual({ width: 16_383, height: 9_000, format: 'webp' });
	});

	it('reads a TIFF, whose dimensions need 32 bits at archival sizes', () => {
		// SPEC story 22: the archival master a library hands over is often a TIFF, and no browser
		// decodes one. Reading the size anyway is what lets it be routed rather than rejected.
		const tiff = new Uint8Array(8 + 2 + 24 + 4);
		const view = new DataView(tiff.buffer);
		tiff.set([0x49, 0x49]); // 'II', little-endian
		view.setUint16(2, 42, true);
		view.setUint32(4, 8, true); // first IFD at byte 8
		view.setUint16(8, 2, true); // two entries
		view.setUint16(10, 256, true); // ImageWidth
		view.setUint16(12, 4, true); // LONG
		view.setUint32(14, 1, true);
		view.setUint32(18, 47_000, true);
		view.setUint16(22, 257, true); // ImageLength
		view.setUint16(24, 4, true);
		view.setUint32(26, 1, true);
		view.setUint32(30, 31_500, true);
		expect(readImageHeader(tiff)).toEqual({ width: 47_000, height: 31_500, format: 'tiff' });
	});

	it('reads a big-endian TIFF with SHORT dimensions', () => {
		const tiff = new Uint8Array(8 + 2 + 24 + 4);
		const view = new DataView(tiff.buffer);
		tiff.set([0x4d, 0x4d]); // 'MM'
		view.setUint16(2, 42);
		view.setUint32(4, 8);
		view.setUint16(8, 2);
		view.setUint16(10, 256);
		view.setUint16(12, 3); // SHORT
		view.setUint32(14, 1);
		view.setUint16(18, 4000);
		view.setUint16(22, 257);
		view.setUint16(24, 3);
		view.setUint32(26, 1);
		view.setUint16(30, 3000);
		expect(readImageHeader(tiff)).toEqual({ width: 4000, height: 3000, format: 'tiff' });
	});

	it('says nothing rather than guessing, for a container it does not know', () => {
		// `undefined` sends the caller to the decoder, which is right for AVIF or JPEG XL. A guess
		// that came in under the decode ceiling would be a dead tab instead of a clear refusal.
		expect(readImageHeader(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined();
		expect(readImageHeader(new Uint8Array(0))).toBeUndefined();
		expect(readImageHeader(new TextEncoder().encode('<svg width="10"></svg>'))).toBeUndefined();
	});

	it('says nothing for a JPEG truncated before its frame header', () => {
		expect(readImageHeader(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toBeUndefined();
	});
});
