import { describe, expect, test } from 'vitest';

import { flipPixelRows, mapSnapshotFileName } from './map-snapshot.js';

const row = (width: number, value: number): number[] =>
	Array.from({ length: width * 4 }, () => value);

const buffer = (width: number, values: readonly number[]): Uint8Array =>
	new Uint8Array(values.flatMap((value) => row(width, value)));

describe('flipping a framebuffer read into image order', () => {
	test('turns the bottom row into the first row', () => {
		expect([...flipPixelRows(buffer(1, [10, 20]), 1, 2)]).toEqual([20, 20, 20, 20, 10, 10, 10, 10]);
	});

	test('leaves the order of pixels within a row alone', () => {
		const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

		expect([...flipPixelRows(pixels, 2, 2)]).toEqual([
			9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8
		]);
	});

	test('keeps the middle row where it is when the height is odd', () => {
		expect([...flipPixelRows(buffer(1, [10, 20, 30]), 1, 3)]).toEqual([
			30, 30, 30, 30, 20, 20, 20, 20, 10, 10, 10, 10
		]);
	});

	test('is the identity on a single row', () => {
		expect([...flipPixelRows(buffer(3, [7]), 3, 1)]).toEqual(row(3, 7));
	});

	test('does not write into the buffer it was given', () => {
		const pixels = buffer(1, [10, 20]);
		flipPixelRows(pixels, 1, 2);
		expect([...pixels]).toEqual([10, 10, 10, 10, 20, 20, 20, 20]);
	});

	test('answers with the clamped array `ImageData` takes', () => {
		expect(flipPixelRows(buffer(1, [1]), 1, 1)).toBeInstanceOf(Uint8ClampedArray);
	});

	test('accepts a clamped array as well, which is what a second pass would hand it', () => {
		const once = flipPixelRows(buffer(1, [10, 20]), 1, 2);
		expect([...flipPixelRows(once, 1, 2)]).toEqual([10, 10, 10, 10, 20, 20, 20, 20]);
	});

	test('refuses a buffer that is not four bytes per pixel of the size claimed', () => {
		expect(() => flipPixelRows(buffer(2, [1]), 3, 1)).toThrow(/12 bytes, but this read is 8/);
	});

	test.each([
		['zero width', 0, 1],
		['zero height', 1, 0],
		['negative width', -1, 1],
		['fractional height', 1, 1.5]
	])('refuses %s, which is not a frame anything can encode', (_name, width, height) => {
		expect(() => flipPixelRows(new Uint8Array(0), width, height)).toThrow(/dimensions/);
	});
});

describe('what the downloaded file is called', () => {
	test('is the Project directory with the Map Snapshot suffix', () => {
		expect(mapSnapshotFileName('amsterdam-1625')).toBe('amsterdam-1625.map-snapshot.png');
	});

	test('says the same thing every time, so repeated downloads collide rather than accumulate', () => {
		expect(mapSnapshotFileName('boston-1775')).toBe(mapSnapshotFileName('boston-1775'));
	});

	test('leaves a directory name that already has dots in it alone', () => {
		expect(mapSnapshotFileName('v1.2.atlas')).toBe('v1.2.atlas.map-snapshot.png');
	});
});
