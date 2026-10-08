import type { LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import { namedFlavor } from '@protomaps/basemaps';
import { describe, expect, it } from 'vitest';

import {
	BASE_MAP_BORDERS,
	DEFAULT_BASE_MAP_BORDERS,
	NATIONAL_BOUNDARY_LAYER,
	SUBNATIONAL_BOUNDARY_LAYER,
	bordersInclude,
	readBaseMapBorderStyle,
	readBaseMapBorders,
	strengthenedBorder,
	subnationalWidth,
	DEFAULT_BASE_MAP_BORDER_STYLE,
	isDefaultBorderStyle,
	MAX_BORDER_WIDTH,
	MIN_BORDER_WIDTH,
	contrastRatio as contrast,
	relativeLuminance as luminance
} from './borders';

const FLAVORS = ['light', 'dark', 'white', 'grayscale', 'black'] as const;

const boundaryLayer = (id: string, colour: string, width: number): LayerSpecification => ({
	id,
	type: 'line',
	source: 'protomaps',
	'source-layer': 'boundaries',
	paint: {
		'line-color': colour,
		'line-width': width,
		'line-dasharray': ['step', ['zoom'], ['literal', [2, 0]], 4, ['literal', [2, 1]]]
	}
});

const linePaint = (layer: LayerSpecification): Record<string, unknown> =>
	('paint' in layer ? layer.paint : {}) as Record<string, unknown>;

type Flavor = ReturnType<typeof namedFlavor>;

const strengthened = (
	flavor: Flavor,
	id = NATIONAL_BOUNDARY_LAYER,
	style?: Parameters<typeof strengthenedBorder>[2],
	width = 0.7
): Record<string, unknown> =>
	linePaint(strengthenedBorder(boundaryLayer(id, flavor.boundaries, width), flavor, style));

const channels = (colour: string): number[] => {
	const value = Number.parseInt(colour.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

describe('bordersInclude', () => {
	it.each([
		['all', true, true],
		['national', true, false],
		['none', false, false]
	] as const)('for %s keeps national %s and subnational %s', (borders, national, subnational) => {
		expect(bordersInclude(borders, NATIONAL_BOUNDARY_LAYER)).toBe(national);
		expect(bordersInclude(borders, SUBNATIONAL_BOUNDARY_LAYER)).toBe(subnational);
	});

	it('leaves every layer that is not a boundary alone, at every value', () => {
		for (const borders of BASE_MAP_BORDERS) {
			expect(bordersInclude(borders, 'water')).toBe(true);
			expect(bordersInclude(borders, 'earth')).toBe(true);
			expect(bordersInclude(borders, 'places_locality')).toBe(true);
		}
	});
});

describe('readBaseMapBorders', () => {
	it('reads each value an author can choose, trimmed so a hand-edited file still resolves', () => {
		for (const borders of BASE_MAP_BORDERS) {
			expect(readBaseMapBorders({ borders })).toBe(borders);
		}
		expect(readBaseMapBorders({ borders: '  national \n' })).toBe('national');
	});

	it('defaults to all, as every Project drew before the field, for every shape it cannot use', () => {
		expect(DEFAULT_BASE_MAP_BORDERS).toBe('all');
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
});

describe('strengthenedBorder', () => {
	it('clears 4.5:1 against the land in every flavor the catalog names', () => {
		for (const name of FLAVORS) {
			const flavor = namedFlavor(name);
			for (const id of [NATIONAL_BOUNDARY_LAYER, SUBNATIONAL_BOUNDARY_LAYER]) {
				const paint = strengthened(flavor, id);
				expect(contrast(paint['line-color'] as string, flavor.earth)).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it('moves away from the land, pale darkening and dark lightening, keeping the flavor’s hue', () => {
		const light = namedFlavor('light');
		const dark = namedFlavor('dark');
		const on = (flavor: Flavor) => strengthened(flavor)['line-color'] as string;
		expect(luminance(on(light))).toBeLessThan(luminance(light.boundaries));
		expect(luminance(on(dark))).toBeGreaterThan(luminance(dark.boundaries));
		const [r = 0, g = 0, b = 0] = channels(on(dark));
		expect(b).toBeGreaterThan(r);
		expect(g).toBeGreaterThan(r);
	});

	it('draws the national line heavier than the divisions inside it', () => {
		const flavor = namedFlavor('light');
		const national = strengthened(flavor);
		const subnational = strengthened(flavor, SUBNATIONAL_BOUNDARY_LAYER, undefined, 0.4);
		expect(national['line-width'] as number).toBeGreaterThan(subnational['line-width'] as number);
		expect(subnational['line-width'] as number).toBeGreaterThan(0.4);
	});

	it('leaves the dashes alone, which is what makes the line read as a jurisdiction', () => {
		const flavor = namedFlavor('light');
		const original = boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7);

		expect(linePaint(strengthenedBorder(original, flavor))['line-dasharray']).toEqual(
			linePaint(original)['line-dasharray']
		);
	});

	it.each([
		['every other layer', 'water', 'water'],
		[
			'a boundary id that is not a line, because the ids are upstream to reuse',
			NATIONAL_BOUNDARY_LAYER,
			'boundaries'
		]
	])('returns %s untouched, by identity', (_, id, sourceLayer) => {
		const fill: LayerSpecification = {
			id,
			type: 'fill',
			source: 'protomaps',
			'source-layer': sourceLayer,
			paint: { 'fill-color': '#000000' }
		};
		expect(strengthenedBorder(fill, namedFlavor('light'))).toBe(fill);
	});

	it('makes no adjustment for a colour it cannot parse, and never throws', () => {
		const flavor = { ...namedFlavor('light'), boundaries: 'rgb(120 120 120)' };
		const paint = strengthened(flavor);
		expect(paint['line-color']).toBe('rgb(120 120 120)');
		expect(paint['line-width']).toBe(1);
	});
});

describe('readBaseMapBorderStyle', () => {
	const RED = { color: '#c1272d', lineStyle: null, width: null };

	it.each([
		[
			'a fully specified style',
			{ color: '#c1272d', lineStyle: 'dotted', width: 3 },
			{ ...RED, lineStyle: 'dotted', width: 3 }
		],
		['automatic in every property the author left out', { color: '#c1272d' }, RED],
		[
			'the usable properties beside an unusable one',
			{ color: '#c1272d', width: 'thick', lineStyle: 'wavy' },
			RED
		],
		['a colour normalised the way the swatches spell one', { color: '  #C1272D ' }, RED]
	])('reads %s', (_, borderStyle, expected) => {
		expect(readBaseMapBorderStyle({ borderStyle })).toEqual(expected);
	});

	it('rejects a colour that is not #rrggbb, because that is the format the field is validated on', () => {
		for (const color of ['red', '#fff', '#12345', 'rgb(1 2 3)', '#gggggg', '']) {
			expect(readBaseMapBorderStyle({ borderStyle: { color } }).color).toBeNull();
		}
	});

	it('clamps a width from a build with a wider range instead of ignoring it', () => {
		expect(readBaseMapBorderStyle({ borderStyle: { width: 99 } }).width).toBe(MAX_BORDER_WIDTH);
		expect(readBaseMapBorderStyle({ borderStyle: { width: 0 } }).width).toBe(MIN_BORDER_WIDTH);
		expect(readBaseMapBorderStyle({ borderStyle: { width: -4 } }).width).toBe(MIN_BORDER_WIDTH);
	});

	it('treats a width that is not a number as no width at all', () => {
		for (const width of [Number.NaN, Number.POSITIVE_INFINITY, '3', null, {}]) {
			expect(readBaseMapBorderStyle({ borderStyle: { width } }).width).toBeNull();
		}
	});

	it('defaults for every shape this build cannot use, and never throws', () => {
		const unusable = [
			null,
			undefined,
			'a string',
			42,
			{},
			{ borderStyle: null },
			{ borderStyle: 'red' },
			{ borderStyle: 7 },
			{ borderStyle: [] }
		];
		for (const document of unusable) {
			expect(readBaseMapBorderStyle(document)).toEqual(DEFAULT_BASE_MAP_BORDER_STYLE);
		}
	});

	it('knows the default from anything an author chose, which is what decides the field is written', () => {
		expect(isDefaultBorderStyle(DEFAULT_BASE_MAP_BORDER_STYLE)).toBe(true);
		expect(isDefaultBorderStyle({ color: '#c1272d', lineStyle: null, width: null })).toBe(false);
		expect(isDefaultBorderStyle({ color: null, lineStyle: 'solid', width: null })).toBe(false);
		expect(isDefaultBorderStyle({ color: null, lineStyle: null, width: 2 })).toBe(false);
	});
});

describe('strengthenedBorder, with a style the author chose', () => {
	const flavor = namedFlavor('light');
	const styled = (id: string, style: Parameters<typeof strengthenedBorder>[2]) =>
		strengthened(flavor, id, style);

	it('uses a chosen colour exactly, and derives one when none was chosen, even with a width', () => {
		expect(
			styled(NATIONAL_BOUNDARY_LAYER, { color: '#c1272d', lineStyle: null, width: null })[
				'line-color'
			]
		).toBe('#c1272d');
		const paint = styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle: null, width: 4 });
		expect(paint['line-color']).not.toBe(flavor.boundaries);
		expect(paint['line-width']).toBe(4);
	});

	it.each([
		['solid', [1, 0]],
		['dashed', [8, 4]],
		['dotted', [1, 3]]
	] as const)(
		'writes %s as the dash tuple an Annotation stores, never as an absent property',
		(lineStyle, tuple) => {
			expect(
				styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle, width: null })['line-dasharray']
			).toEqual(tuple);
		}
	);

	it('keeps the national line heavier than the divisions, both drawable, at any chosen width', () => {
		expect(subnationalWidth(MIN_BORDER_WIDTH)).toBeGreaterThan(0);
		const chosen = { color: null, lineStyle: null, width: 4 } as const;
		expect(styled(NATIONAL_BOUNDARY_LAYER, chosen)['line-width']).toBe(4);
		expect(styled(SUBNATIONAL_BOUNDARY_LAYER, chosen)['line-width']).toBe(subnationalWidth(4));
		expect(subnationalWidth(4)).toBeLessThan(4);
	});

	it('draws what it drew before the field existed when nothing was chosen', () => {
		const original = boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7);

		expect(strengthenedBorder(original, flavor, DEFAULT_BASE_MAP_BORDER_STYLE)).toEqual(
			strengthenedBorder(original, flavor)
		);
	});
});
