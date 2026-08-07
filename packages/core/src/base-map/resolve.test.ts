import { describe, expect, it } from 'vitest';

import { BASE_MAP_CATALOG } from './catalog';
import { CATALOG_WITH_STALE_DEFAULT, EMPTY_CATALOG, FORKED_CATALOG } from './fixture-catalogs';
import { baseMapFallbackNotice, baseMapOptions, defaultEntry, resolveBaseMap } from './resolve';

describe('resolveBaseMap', () => {
	it('resolves a stable id against the catalog', () => {
		const resolution = resolveBaseMap('harbour-charts', FORKED_CATALOG);

		expect(resolution.entry.label).toBe('Harbour charts');
		expect(resolution.fellBack).toBe(false);
	});

	it('falls back to the deployment default for an unknown id, without throwing', () => {
		const resolution = resolveBaseMap('a-base-map-from-another-deployment', FORKED_CATALOG);

		expect(resolution.entry.id).toBe(FORKED_CATALOG.defaultId);
		expect(resolution.requestedId).toBe('a-base-map-from-another-deployment');
		expect(resolution.fellBack).toBe(true);
	});

	it('treats a Project that has recorded no default as a choice not yet made', () => {
		for (const nothing of [null, undefined]) {
			const resolution = resolveBaseMap(nothing, FORKED_CATALOG);

			expect(resolution.entry.id).toBe(FORKED_CATALOG.defaultId);
			// Not a fallback, so nothing is announced. The author has not asked for anything.
			expect(resolution.fellBack).toBe(false);
		}
	});

	it('resolves against the real catalog by default', () => {
		expect(resolveBaseMap(null).entry.id).toBe(BASE_MAP_CATALOG.defaultId);
	});
});

describe('defaultEntry', () => {
	it('uses the first entry when the catalog default names nothing', () => {
		expect(defaultEntry(CATALOG_WITH_STALE_DEFAULT).id).toBe(
			CATALOG_WITH_STALE_DEFAULT.entries[0]?.id
		);
	});

	it('throws for a catalog with no entries, which nothing can render', () => {
		expect(() => defaultEntry(EMPTY_CATALOG)).toThrow(/empty/i);
	});
});

describe('baseMapFallbackNotice', () => {
	it('names both the missing Base Map and the one shown instead', () => {
		const notice = baseMapFallbackNotice(resolveBaseMap('nautical', FORKED_CATALOG));

		expect(notice).toContain('nautical');
		expect(notice).toContain('Parish roads');
	});

	it('says nothing when the id resolved', () => {
		expect(baseMapFallbackNotice(resolveBaseMap('satellite', FORKED_CATALOG))).toBeNull();
		expect(baseMapFallbackNotice(resolveBaseMap(null, FORKED_CATALOG))).toBeNull();
	});
});

describe('baseMapOptions', () => {
	it('offers exactly the catalog, in catalog order', () => {
		expect(baseMapOptions(FORKED_CATALOG).map((option) => option.id)).toEqual([
			'harbour-charts',
			'parish-roads',
			'satellite'
		]);
	});

	it('marks a needs-network entry in visible text rather than by colour or a tooltip', () => {
		const options = baseMapOptions(FORKED_CATALOG);
		const satellite = options.find((option) => option.id === 'satellite');
		const offline = options.find((option) => option.id === 'harbour-charts');

		expect(satellite?.text).toBe('Satellite — needs network');
		expect(offline?.text).toBe('Harbour charts');
	});
});

describe('the deployment catalog', () => {
	it('marks every Base Map as needing the network while no tile cache exists', () => {
		const archives = new Set(BASE_MAP_CATALOG.entries.map((entry) => entry.archive));

		expect(BASE_MAP_CATALOG.entries.every((entry) => entry.needsNetwork)).toBe(true);
		// Several looks still use one dataset, without shipping that dataset. **The count is half the
		// assertion**: `every()` and `archives.size === 1` are both true of a one-entry catalog, so
		// dropping this line would let criterion 10 — "three looks over one dataset" — pass vacuously.
		const looks = new Set(
			BASE_MAP_CATALOG.entries.map(
				(entry) => `${entry.emphasis}/${entry.flavor.light}/${entry.flavor.dark}`
			)
		);
		expect(looks.size).toBeGreaterThanOrEqual(3);
		expect(archives.size).toBe(1);
	});

	it('offers content-distinct variants rather than only recolourings', () => {
		const emphases = new Set(BASE_MAP_CATALOG.entries.map((entry) => entry.emphasis));

		expect(emphases.size).toBeGreaterThan(1);
	});

	it('carries a muted or high-contrast entry, without which SPEC story 98 cannot pass', () => {
		const muted = BASE_MAP_CATALOG.entries.filter((entry) =>
			['grayscale', 'white', 'black'].includes(entry.flavor.light)
		);

		expect(muted.length).toBeGreaterThan(0);
	});

	it('marks at least one entry as needing network, so the marking is exercised', () => {
		expect(BASE_MAP_CATALOG.entries.some((entry) => entry.needsNetwork)).toBe(true);
	});

	it('gives every entry a distinct id, since an id is what a Project records', () => {
		const ids = BASE_MAP_CATALOG.entries.map((entry) => entry.id);

		expect(new Set(ids).size).toBe(ids.length);
	});
});
