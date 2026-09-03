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
	MIN_BORDER_WIDTH
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

const channels = (colour: string): number[] => {
	const value = Number.parseInt(colour.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
};

const luminance = (colour: string): number => {
	const linear = (channel: number): number => {
		const unit = channel / 255;
		return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
	};
	const [r = 0, g = 0, b = 0] = channels(colour);
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
};

const contrast = (a: string, b: string): number => {
	const [high = 0, low = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (high + 0.05) / (low + 0.05);
};

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

describe('strengthenedBorder', () => {
	it('clears 4.5:1 against the land in every flavor the catalog names', () => {
		// The whole point of the control: at upstream's own colours this ratio is 1.8:1 on `light` and
		// 2.8:1 on `dark`, which is a border an author cannot see they have drawn.
		for (const name of FLAVORS) {
			const flavor = namedFlavor(name);
			for (const id of [NATIONAL_BOUNDARY_LAYER, SUBNATIONAL_BOUNDARY_LAYER]) {
				const paint = linePaint(
					strengthenedBorder(boundaryLayer(id, flavor.boundaries, 0.7), flavor)
				);
				expect(contrast(paint['line-color'] as string, flavor.earth)).toBeGreaterThanOrEqual(4.5);
			}
		}
	});

	it('moves away from the land, so a pale flavor darkens and a dark one lightens', () => {
		const light = namedFlavor('light');
		const dark = namedFlavor('dark');
		const on = (flavor: typeof light): string =>
			linePaint(
				strengthenedBorder(boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7), flavor)
			)['line-color'] as string;

		expect(luminance(on(light))).toBeLessThan(luminance(light.boundaries));
		expect(luminance(on(dark))).toBeGreaterThan(luminance(dark.boundaries));
	});

	it('keeps the hue the flavor chose rather than substituting a colour of its own', () => {
		// `dark` picks a bluish grey for its boundaries. Pushing it toward white must not flatten it to
		// a neutral, or this becomes the third theme ADR-0016 exists to prevent.
		const dark = namedFlavor('dark');
		const [r = 0, g = 0, b = 0] = channels(
			linePaint(
				strengthenedBorder(boundaryLayer(NATIONAL_BOUNDARY_LAYER, dark.boundaries, 0.7), dark)
			)['line-color'] as string
		);

		expect(b).toBeGreaterThan(r);
		expect(g).toBeGreaterThan(r);
	});

	it('draws the national line heavier than the divisions inside it', () => {
		// `national` versus `all` has to be legible as a difference, not just present in the document.
		const flavor = namedFlavor('light');
		const national = linePaint(
			strengthenedBorder(boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7), flavor)
		);
		const subnational = linePaint(
			strengthenedBorder(boundaryLayer(SUBNATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.4), flavor)
		);

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

	it('returns every other layer untouched, by identity', () => {
		const flavor = namedFlavor('light');
		const water: LayerSpecification = {
			id: 'water',
			type: 'fill',
			source: 'protomaps',
			'source-layer': 'water',
			paint: { 'fill-color': flavor.water }
		};

		expect(strengthenedBorder(water, flavor)).toBe(water);
	});

	it('leaves a boundary id that is not a line alone, because the ids are upstream to reuse', () => {
		const flavor = namedFlavor('light');
		const fill: LayerSpecification = {
			id: NATIONAL_BOUNDARY_LAYER,
			type: 'fill',
			source: 'protomaps',
			'source-layer': 'boundaries',
			paint: { 'fill-color': '#000000' }
		};

		expect(strengthenedBorder(fill, flavor)).toBe(fill);
	});

	it('makes no adjustment for a colour it cannot parse, and never throws', () => {
		// A flavor is a fork's to edit, and this module is evaluated during both apps' prerender.
		const flavor = { ...namedFlavor('light'), boundaries: 'rgb(120 120 120)' };
		const paint = linePaint(
			strengthenedBorder(boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7), flavor)
		);

		expect(paint['line-color']).toBe('rgb(120 120 120)');
		expect(paint['line-width']).toBe(1);
	});
});

describe('readBaseMapBorderStyle', () => {
	it('reads a fully specified style', () => {
		expect(
			readBaseMapBorderStyle({ borderStyle: { color: '#c1272d', lineStyle: 'dotted', width: 3 } })
		).toEqual({ color: '#c1272d', lineStyle: 'dotted', width: 3 });
	});

	it('is automatic in every property the author left out', () => {
		expect(readBaseMapBorderStyle({ borderStyle: { color: '#c1272d' } })).toEqual({
			color: '#c1272d',
			lineStyle: null,
			width: null
		});
	});

	it('keeps the properties it can use when one beside them is unusable', () => {
		// Per-property rather than per-object: a `width` from a hand edit must not cost the author the
		// colour written next to it.
		expect(
			readBaseMapBorderStyle({
				borderStyle: { color: '#c1272d', width: 'thick', lineStyle: 'wavy' }
			})
		).toEqual({ color: '#c1272d', lineStyle: null, width: null });
	});

	it('normalises a colour the way the swatches spell one', () => {
		expect(readBaseMapBorderStyle({ borderStyle: { color: '  #C1272D ' } }).color).toBe('#c1272d');
	});

	it('rejects a colour that is not #rrggbb, because that is the format the field is validated on', () => {
		for (const color of ['red', '#fff', '#12345', 'rgb(1 2 3)', '#gggggg', '']) {
			expect(readBaseMapBorderStyle({ borderStyle: { color } }).color).toBeNull();
		}
	});

	it('clamps a width from a build with a wider range instead of ignoring it', () => {
		// The nearest width this build can draw is closer to the author's intent than automatic.
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
		linePaint(strengthenedBorder(boundaryLayer(id, flavor.boundaries, 0.7), flavor, style));

	it('uses the chosen colour exactly, without adjusting it for contrast', () => {
		// The author's argument travels to the Published Site; silently correcting it would make the
		// swatch they picked a lie about what is on the map.
		const paint = styled(NATIONAL_BOUNDARY_LAYER, {
			color: '#c1272d',
			lineStyle: null,
			width: null
		});

		expect(paint['line-color']).toBe('#c1272d');
	});

	it('derives the colour when the author chose none, even having chosen a width', () => {
		const paint = styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle: null, width: 4 });

		expect(paint['line-color']).not.toBe(flavor.boundaries);
		expect(paint['line-width']).toBe(4);
	});

	it('leaves upstream dashes in place for an unchosen line style', () => {
		// Solid below z4 and dashed above it is a considered pattern; making "automatic" replace it
		// with a flat tuple would make the absence of a choice into a choice.
		const original = boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7);
		const paint = styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle: null, width: null });

		expect(paint['line-dasharray']).toEqual(linePaint(original)['line-dasharray']);
	});

	it('writes solid as an unbroken tuple, not as the property being absent', () => {
		// The opposite of ADR-0009's rule for an Annotation, and it has to be: absence here leaves
		// upstream's zoom-stepped expression standing and discards the author's choice.
		const paint = styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle: 'solid', width: null });

		expect(paint['line-dasharray']).toEqual([1, 0]);
	});

	it('writes the same dash tuples an Annotation stores, so the two vocabularies agree', () => {
		expect(
			styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle: 'dashed', width: null })[
				'line-dasharray'
			]
		).toEqual([8, 4]);
		expect(
			styled(NATIONAL_BOUNDARY_LAYER, { color: null, lineStyle: 'dotted', width: null })[
				'line-dasharray'
			]
		).toEqual([1, 3]);
	});

	it('keeps the national line heavier than the divisions at a chosen width', () => {
		// `national` versus `all` has to stay legible as a difference at every width the author picks.
		const chosen = { color: null, lineStyle: null, width: 4 } as const;

		expect(styled(NATIONAL_BOUNDARY_LAYER, chosen)['line-width']).toBe(4);
		expect(styled(SUBNATIONAL_BOUNDARY_LAYER, chosen)['line-width']).toBe(subnationalWidth(4));
		expect(subnationalWidth(4)).toBeLessThan(4);
	});

	it('keeps both levels drawable at the narrowest width the control offers', () => {
		expect(subnationalWidth(MIN_BORDER_WIDTH)).toBeGreaterThan(0);
	});

	it('draws what it drew before the field existed when nothing was chosen', () => {
		const original = boundaryLayer(NATIONAL_BOUNDARY_LAYER, flavor.boundaries, 0.7);

		expect(strengthenedBorder(original, flavor, DEFAULT_BASE_MAP_BORDER_STYLE)).toEqual(
			strengthenedBorder(original, flavor)
		);
	});
});
