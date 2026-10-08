import { describe, expect, it } from 'vitest';

import { BASE_MAP_CATALOG } from './catalog';
import { CATALOG_WITH_STALE_DEFAULT, EMPTY_CATALOG, FORKED_CATALOG } from './fixture-catalogs';
import {
	baseMapArchiveHost,
	baseMapFallbackNotice,
	baseMapNotInSiteNotice,
	baseMapOptions,
	baseMapUnavailableNotice,
	defaultEntry,
	resolveBaseMap
} from './resolve';

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
			'satellite',
			'ordnance-relief'
		]);
	});

	it('labels an entry with its name, and carries the network fact beside it', () => {
		const options = baseMapOptions(FORKED_CATALOG);
		const satellite = options.find((option) => option.id === 'satellite');
		const offline = options.find((option) => option.id === 'harbour-charts');
		expect(satellite?.label).toBe('Satellite');
		expect(offline?.label).toBe('Harbour charts');
		expect(satellite?.needsNetwork).toBe(true);
		expect(offline?.needsNetwork).toBe(false);
	});
});

describe('the deployment catalog', () => {
	it('marks every Base Map as needing the network while no tile cache exists', () => {
		const archives = new Set(BASE_MAP_CATALOG.entries.map((entry) => entry.archive));
		expect(BASE_MAP_CATALOG.entries.every((entry) => entry.needsNetwork)).toBe(true);
		expect(BASE_MAP_CATALOG.entries.some((entry) => entry.needsNetwork)).toBe(true);
		expect(archives.size).toBe(1);
	});

	it('gives every entry a distinct id, since an id is what a Project records', () => {
		const ids = BASE_MAP_CATALOG.entries.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('baseMapUnavailableNotice', () => {
	const remote = FORKED_CATALOG.entries[2]!;
	const bundled = FORKED_CATALOG.entries[0]!;

	it('names the Base Map and the host, and says the Workspace is unaffected, which is the question a blank map actually raises', () => {
		const notice = baseMapUnavailableNotice(remote, baseMapArchiveHost(remote));
		expect(notice).toContain('Satellite');
		expect(notice).toContain('tiles.example.invalid');
		expect(notice).toContain('Nothing in your Workspace is affected');
		expect(notice).toMatch(/Alignments/);
		expect(notice).toMatch(/still saving/);
	});

	it('offers the reader a remedy for a remote archive, and the deployment one for its own', () => {
		const fromNetwork = baseMapUnavailableNotice(remote, 'tiles.example.invalid');
		expect(fromNetwork).toContain('available offline');
		expect(fromNetwork).not.toContain('Whoever made it');
		const fromSite = baseMapUnavailableNotice(bundled, null);
		expect(fromSite).toContain('this site');
		expect(fromSite).toContain('Whoever made it');
		expect(fromSite).not.toContain('available offline');
	});
});

describe('baseMapArchiveHost', () => {
	it('is the host for an archive somewhere else, and null for this deployment’s own file', () => {
		expect(baseMapArchiveHost(FORKED_CATALOG.entries[2]!)).toBe('tiles.example.invalid');
		expect(baseMapArchiveHost(FORKED_CATALOG.entries[0]!)).toBeNull();
	});
});

describe('baseMapNotInSiteNotice', () => {
	const siteServed = FORKED_CATALOG.entries[0]!;
	const remote = FORKED_CATALOG.entries[2]!;
	const NO_PLACE_NAMES = /carries no place names at all/;
	const NO_LABELS = /[Tt]he author’s Labels are not(?: drawn|:)/;
	const NOTHING_UNDER_THE_WORK = /only the Map Images and the Pins, Lines and Shapes are drawn/;

	it('says nothing at all when the site carries the files', () => {
		for (const entry of [siteServed, remote]) {
			for (const cachedTiles of [true, false]) {
				expect(baseMapNotInSiteNotice(entry, { bundledAssets: true, cachedTiles })).toBe('');
			}
		}
	});

	it('says the reference map is absent when there is nothing to draw one from', () => {
		const notice = baseMapNotInSiteNotice(siteServed, {
			bundledAssets: false,
			cachedTiles: false
		});

		expect(notice).toMatch(NOTHING_UNDER_THE_WORK);
		expect(notice).toContain('needs network');
	});

	it.each([
		[remote, false],
		[siteServed, true],
		[remote, true]
	])(
		'says a map that draws has lost its labels, whichever of the two draws it',
		(entry, cachedTiles) => {
			expect(baseMapNotInSiteNotice(entry, { bundledAssets: false, cachedTiles })).toMatch(
				NO_PLACE_NAMES
			);
		}
	);

	it('names the author’s Labels among what such a site does not draw, and never claims the geography is here, in every absent-assets row', () => {
		for (const entry of [siteServed, remote]) {
			for (const cachedTiles of [true, false]) {
				const notice = baseMapNotInSiteNotice(entry, { bundledAssets: false, cachedTiles });
				expect(notice).toMatch(NO_LABELS);
				expect(notice).toContain('Pins, Lines and Shapes');
				expect(notice).not.toMatch(/the Annotations are not affected/);
				expect(notice).not.toMatch(/are all here/);
				expect(notice).not.toMatch(/geography/);
				expect(notice).not.toMatch(/from the network/);
			}
		}
	});
});
