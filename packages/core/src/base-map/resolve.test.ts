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
			'satellite',
			'ordnance-relief'
		]);
	});

	it('labels an entry with its name, and carries the network fact beside it', () => {
		const options = baseMapOptions(FORKED_CATALOG);
		const satellite = options.find((option) => option.id === 'satellite');
		const offline = options.find((option) => option.id === 'harbour-charts');

		// The label is the map's name. What needs the network is still knowable — `needsNetwork` is what
		// `nothingUnderTheWork` composes its notice from, which is where the requirement is now said in
		// words — but it is not spelled into every option a scholar reads past.
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
		// One dataset, and every look this deployment offers is a style document over it — which is
		// now `appearance.ts`'s business rather than a row per look here. `style.test.ts` counts the
		// eight it draws.
		expect(archives.size).toBe(1);
	});

	it('marks at least one entry as needing network, so the marking is exercised', () => {
		expect(BASE_MAP_CATALOG.entries.some((entry) => entry.needsNetwork)).toBe(true);
	});

	it('gives every entry a distinct id, since an id is what a Project records', () => {
		const ids = BASE_MAP_CATALOG.entries.map((entry) => entry.id);

		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('baseMapUnavailableNotice', () => {
	// The archive answered nothing while the connection is fine — the state this deployment has been
	// in since `demo-bucket.protomaps.com` began refusing on 2026-08-07, and whose entire rendering
	// used to be an empty pane. A scholar cannot tell that from a broken tool, and cannot rule out
	// that their own work failed to draw.
	const remote = FORKED_CATALOG.entries[2]!;
	const bundled = FORKED_CATALOG.entries[0]!;

	it('names the Base Map and the host, for a remote archive', () => {
		const notice = baseMapUnavailableNotice(remote, baseMapArchiveHost(remote));

		expect(notice).toContain('Satellite');
		expect(notice).toContain('tiles.example.invalid');
	});

	it('says the Workspace is unaffected, which is the question a blank map actually raises', () => {
		const notice = baseMapUnavailableNotice(remote, baseMapArchiveHost(remote));

		expect(notice).toContain('Nothing in your Workspace is affected');
		expect(notice).toMatch(/Alignments/);
		expect(notice).toMatch(/still saving/);
	});

	it('offers the reader a remedy for a remote archive, and the deployment one for its own', () => {
		// The split is `needsNetwork`, and it is the whole reason this function branches: a scholar can
		// switch Base Map or cache tiles while one works; nobody but the site's author can restore a file
		// this site was supposed to serve. Telling a reader to try another Base Map when every entry
		// reads the same missing local file would be advice that cannot work.
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
		// A whole archive URL names a path a scholar cannot act on; the host is the part that says who
		// is having the bad afternoon.
		expect(baseMapArchiveHost(FORKED_CATALOG.entries[2]!)).toBe('tiles.example.invalid');
		expect(baseMapArchiveHost(FORKED_CATALOG.entries[0]!)).toBeNull();
	});
});

describe('baseMapNotInSiteNotice', () => {
	// The four rows of "this site does not carry the Base Map's files", which is the author's own choice
	// (ADR-0020) and therefore the state of a great many sites. Two of these are unreachable from the
	// browser suite — one needs a catalog entry with a relative archive, which this deployment has
	// none of, and one needs cached tiles alongside absent assets, which no site fixture builds —
	// and both were **false in the shipped sentence** until this function existed to be driven.
	//
	// `FORKED_CATALOG` rather than the real one, deliberately: this has to hold for the fork that
	// serves its own tiles as much as for the deployment that does not.
	const siteServed = FORKED_CATALOG.entries[0]!;
	const remote = FORKED_CATALOG.entries[2]!;
	const NO_PLACE_NAMES = /carries no place names at all/;
	/** What a site with no typefaces costs the *author's* work, and not only the reference map's. */
	// Both wordings of the same refusal — "are not drawn" where the sentence ends there, "are not:"
	// where the reason follows. Deliberately not `are not\b`, which "are not affected" would satisfy.
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
		// And points at the way out rather than merely apologising. With the switcher's labels plain,
		// this notice is the only place the requirement is stated in words, so its wording is the thing
		// ADR-0020 now rests on.
		expect(notice).toContain('needs network');
	});

	it('says a map that draws has lost its labels, whichever of the two draws it', () => {
		// The archive is somebody else's, so the geography comes over the network…
		expect(baseMapNotInSiteNotice(remote, { bundledAssets: false, cachedTiles: false })).toMatch(
			NO_PLACE_NAMES
		);
		// …and this is the row the shipped sentence got wrong. `styleFor` tries the site's own cached
		// tiles **before** it falls back to the bare background, so a site that carries tiles and no
		// display assets draws geography from its own files — while the notice went on saying only the
		// Map Images and Annotations were drawn.
		expect(baseMapNotInSiteNotice(siteServed, { bundledAssets: false, cachedTiles: true })).toMatch(
			NO_PLACE_NAMES
		);
		expect(baseMapNotInSiteNotice(remote, { bundledAssets: false, cachedTiles: true })).toMatch(
			NO_PLACE_NAMES
		);
	});

	it('names the author’s Labels among what such a site does not draw, in every absent-assets row', () => {
		// A Label is the scholar's words shaped from the Base Map's own typefaces, so a site written
		// without them draws none — `drawLayerStack` omits the Label bucket where the style carries no
		// glyphs. These rows used to promise that "the Annotations are not affected", which stopped
		// being true the day Labels shipped; the Pins, Lines and Shapes are what they can still promise.
		//
		// **Including the row where the reference map is absent outright.** That row is reached only
		// when the display assets are absent, which is the same state that makes `styleFor` build a
		// bare background style with no `glyphs` — losing the geography does not restore the typefaces,
		// so the Labels are missing there for a reason of their own and the row may not promise them.
		for (const entry of [siteServed, remote]) {
			for (const cachedTiles of [true, false]) {
				const notice = baseMapNotInSiteNotice(entry, { bundledAssets: false, cachedTiles });

				expect(notice).toMatch(NO_LABELS);
				expect(notice).toContain('Pins, Lines and Shapes');
				expect(notice).not.toMatch(/the Annotations are not affected/);
			}
		}
		// And nothing of the sort on a site that carries the files, where a Label draws like anything
		// else.
		expect(baseMapNotInSiteNotice(remote, { bundledAssets: true, cachedTiles: true })).toBe('');
	});

	it('never claims the geography is here, in any row', () => {
		// The failure this function was extracted to end. A Reader meets this notice while the archive
		// is refusing — the state of every site this deployment writes since 2026-08-07 — and, with
		// no connection, with the outage notice deliberately withheld and this one standing alone in
		// front of an empty rectangle. Any sentence asserting what is on screen is false there.
		for (const entry of [siteServed, remote]) {
			for (const cachedTiles of [true, false]) {
				const notice = baseMapNotInSiteNotice(entry, { bundledAssets: false, cachedTiles });

				expect(notice).not.toMatch(/are all here/);
				expect(notice).not.toMatch(/geography/);
				expect(notice).not.toMatch(/from the network/);
			}
		}
	});
});
