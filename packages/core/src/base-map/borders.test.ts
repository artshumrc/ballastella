import { describe, expect, it } from 'vitest';

import {
	BASE_MAP_BORDERS,
	DEFAULT_BASE_MAP_BORDERS,
	NATIONAL_BOUNDARY_LAYER,
	SUBNATIONAL_BOUNDARY_LAYER,
	bordersInclude,
	readBaseMapBorders
} from './borders';

describe('bordersInclude', () => {
	it('keeps both boundary layers for all, which is what a Project drew before the field existed', () => {
		expect(bordersInclude('all', NATIONAL_BOUNDARY_LAYER)).toBe(true);
		expect(bordersInclude('all', SUBNATIONAL_BOUNDARY_LAYER)).toBe(true);
	});

	it('keeps the national line alone for national', () => {
		expect(bordersInclude('national', NATIONAL_BOUNDARY_LAYER)).toBe(true);
		expect(bordersInclude('national', SUBNATIONAL_BOUNDARY_LAYER)).toBe(false);
	});

	it('drops both for none', () => {
		expect(bordersInclude('none', NATIONAL_BOUNDARY_LAYER)).toBe(false);
		expect(bordersInclude('none', SUBNATIONAL_BOUNDARY_LAYER)).toBe(false);
	});

	it('leaves every layer that is not a boundary alone, at every value', () => {
		// Coastlines, rivers and place names are geography, not administration: a Project that asked
		// for no borders asked for no *borders*.
		for (const borders of BASE_MAP_BORDERS) {
			expect(bordersInclude(borders, 'water')).toBe(true);
			expect(bordersInclude(borders, 'earth')).toBe(true);
			expect(bordersInclude(borders, 'places_locality')).toBe(true);
		}
	});
});

describe('readBaseMapBorders', () => {
	it('reads each value an author can choose', () => {
		for (const borders of BASE_MAP_BORDERS) {
			expect(readBaseMapBorders({ borders })).toBe(borders);
		}
	});

	it('trims, so a hand-edited file still resolves', () => {
		expect(readBaseMapBorders({ borders: '  national \n' })).toBe('national');
	});

	it('defaults for every shape this build cannot use, and never throws', () => {
		// A `project.json` off somebody's disk, written by an older fork or a newer build. Each of
		// these means "no choice recorded", which is the documented default rather than an error.
		const unusable = [
			null,
			undefined,
			'a string',
			42,
			{},
			{ borders: '' },
			{ borders: '   ' },
			{ borders: 'continental' },
			{ borders: 3 },
			{ borders: null },
			{ borders: ['national'] }
		];
		for (const document of unusable) {
			expect(readBaseMapBorders(document)).toBe(DEFAULT_BASE_MAP_BORDERS);
		}
	});

	it('defaults to all, because that is what every Project drew before the field existed', () => {
		expect(DEFAULT_BASE_MAP_BORDERS).toBe('all');
	});
});
