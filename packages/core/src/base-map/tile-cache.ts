// Which Base Map tiles a Project's extent needs, how many they are, and what they weigh (ADR-0025).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A PURE FUNCTION, AND WHY THE BUDGET AND THE FETCH LOOP READ THE SAME ONE
//
// The user is shown a tile count and a byte estimate and then agrees to them. If the dialog counted
// one way and the loop walked another, the number shown would be a claim about a different piece of
// work from the one performed — and the direction that goes wrong is the one that matters, because
// this fetches from somebody else's server (ADR-0007). So {@link tilesForBounds} returns the list
// itself: the budget is `list.length`, and the loop consumes `list`. There is one enumeration.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE BYTES ARE MEASURED, NOT CITED
//
// The epic's tracker names this as one of two claims that rested on documentation. It was measured
// against `e2e/fixtures/base-map/amsterdam-centre.pmtiles`, a Protomaps basemaps v4 extract of
// central Amsterdam (4,137,622 bytes, z0–14, `tileCompression: 2` — gzip, `tileType: 1` — MVT):
//
//   ┌───────────────────────────────────────────────────────────────────────────────────────┐
//   │ extent                        tiles   decompressed        gzipped      per tile        │
//   │ whole archive extent          43      5,818,431 (5.55 MiB) 4,136,082   135,312 avg     │
//   │ the canal belt, 0.04° × 0.02° 23      3,485,916 (3.32 MiB) 2,478,805   151,562 avg     │
//   └───────────────────────────────────────────────────────────────────────────────────────┘
//
// Per zoom, over the whole extent: z0 93,228 · z4 182,620 · z8 216,089 · z11 201,271 avg ·
// z13 125,417 avg · z14 86,769 avg (16 tiles). The smallest tile measured was 36,308 bytes and the
// largest 260,455.
//
// Two things follow, and both are contracts rather than observations.
//
// **A city-centre Project really is tens of tiles**, which is what ADR-0025 asserts and what makes
// the whole feature reasonable: 23 tiles and about 3.3 MiB for a neighbourhood at every zoom from 0
// to 14. The low zooms are not free in bytes — a planet-derived extract's z0 tile carries the whole
// world — but there are only nine of them, and omitting them is what makes zooming out go blank.
//
// **{@link ESTIMATED_BYTES_PER_TILE} is 152,000**, the canal-belt mean rounded up rather than the
// whole-archive one — see that constant for why the error has a right direction. It is an estimate
// and is presented as one; the fetch loop reports what was actually written. And neither this table
// nor that constant is prose: `cachedBaseMapTiles` in `e2e/support/editor-deployment.ts` re-derives
// every row of it from the archive, `editor-base-map.e2e.ts` asserts them, and `tile-cache.test.ts`
// asserts the constant against {@link MEASURED_CANAL_BELT}.
// A single constant rather than a per-zoom table because the spread within a zoom
// (36 kB to 260 kB at z14) is as wide as the spread between zooms, so a table would be more precise
// about the wrong thing.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// COMPRESSION, DECIDED AND WRITTEN DOWN (ADR-0025)
//
// **The cache holds decompressed MVT.** `pmtiles@4.4.1`'s `PMTiles#getZxyAttempt` ends with
// `this.decompress(data, header.tileCompression)`, and its `Protocol.tilev4` hands that result
// straight to MapLibre — so the bytes MapLibre has always accepted for this dataset are
// *decompressed* protobuf, and the cache stores exactly the bytes the renderer takes. MapLibre's
// vector tile worker does not gunzip, so storing the archive's gzipped bytes and serving them raw is
// the silent blank map ADR-0025 names: bytes arrive, nothing parses, nothing throws.
//
// The measured cost of the decision is 5,818,431 bytes on disk where the gzipped form would be
// 4,136,082 — 41% more, for the whole fixture extent. That is the price of the failure mode being
// impossible rather than merely avoided.

import type { GeoBounds } from '../project/opening-view.js';

/** One tile of the Web Mercator pyramid. */
export interface TileCoordinate {
	readonly z: number;
	readonly x: number;
	readonly y: number;
}

/**
 * The Workspace directory the cache lives in, with its trailing `/` (ADR-0023's reserved names).
 *
 * Workspace-level and not per-Project, which is the whole of ADR-0025's deduplication argument: two
 * Projects in the same city share tiles, and "is this Project available offline?" is therefore a
 * question about which files exist rather than a flag in `project.json` that can lie.
 */
export const BASE_MAP_TILE_DIRECTORY = 'base-map/tiles/';

/** `base-map/tiles/{z}/{x}/{y}.mvt`. Decompressed MVT — see the note at the top of this file. */
export const cachedTilePath = (tile: TileCoordinate): string =>
	`${BASE_MAP_TILE_DIRECTORY}${tile.z}/${tile.x}/${tile.y}.mvt`;

/**
 * The tile a cache path names, or `null` when the path is not one of ours.
 *
 * The inverse of {@link cachedTilePath}, and it has a caller: a `list()` of the cache directory is
 * how the size and the coverage are both computed, and reading the coordinates back off the paths is
 * what keeps that from needing a second index nobody maintains.
 */
export function parseCachedTilePath(path: string): TileCoordinate | null {
	const matched = new RegExp(`^${BASE_MAP_TILE_DIRECTORY}(\\d+)/(\\d+)/(\\d+)\\.mvt$`).exec(path);
	if (!matched) return null;
	const [, z, x, y] = matched as unknown as [string, string, string, string];
	return { z: Number(z), x: Number(x), y: Number(y) };
}

/**
 * Bytes one cached tile is expected to weigh. **Measured** — see the table at the top of this file.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT IS THE HIGHER OF THE TWO MEASURED MEANS, DELIBERATELY
 *
 * 152,000 is the canal-belt mean (151,562) rounded up, not the whole-extent mean (135,312). Choosing
 * the lower one under-quoted a realistic Project's own extent by 8% — 23 × 140 kB is 3.22 MB against
 * 3.49 MB actually fetched — and **the error has a right direction here.** This number is what a user
 * agrees to before Ballastella asks somebody else's server for hundreds of tiles (ADR-0007), and a
 * quote that comes in under is the one form of inaccuracy a courtesy figure must not have.
 *
 * The realistic extent is also the right one to take the mean over: a Project-sized box is weighted
 * towards the deep zooms it actually needs, while the whole-archive figure is diluted by a longer run
 * of single low-zoom tiles. `tile-cache.test.ts` asserts that the estimate does not fall below the
 * measured canal-belt total, and `editor-base-map.e2e.ts` re-measures that total from the archive.
 *
 * Used only for the estimate shown before anything is fetched; what was actually written is reported
 * afterwards from the bytes themselves.
 */
export const ESTIMATED_BYTES_PER_TILE = 152_000;

/**
 * What the canal-belt extent actually weighed, in bytes, at every zoom from 0 to 14.
 *
 * Exported so {@link ESTIMATED_BYTES_PER_TILE} can be asserted against it rather than beside it —
 * the tracker forbade committing to this measurement unverified, and a table in a comment is not a
 * verification. `e2e/support/editor-deployment.ts` re-derives the same figure from the archive and
 * `editor-base-map.e2e.ts` asserts it, so the two ends cannot drift apart in silence.
 */
export const MEASURED_CANAL_BELT = { tiles: 23, decompressedBytes: 3_485_916 } as const;

/**
 * The most tiles one Project may ask for, above which the request is refused (ADR-0007, ADR-0025).
 *
 * 500, which at the measured average is about 76 MB — already a thirteenth of ADR-0008's ~1 GB
 * hosting budget, and far past the "tens of tiles" a city centre measures at. A country at z14 is thousands
 * and a continent hundreds of thousands, so this refuses both without refusing any plausible Project:
 * the whole Amsterdam fixture extent, at every zoom, is 43.
 */
export const OFFLINE_TILE_LIMIT = 500;

/**
 * The latitude Web Mercator stops at. Beyond it `tan` runs away and the projection has no `y`.
 *
 * A Project can legitimately have content past it — a pin at the pole — and clamping rather than
 * refusing is right, because the tile that *does* cover the pole is the one it needs.
 */
const MERCATOR_LATITUDE_LIMIT = 85.0511287798066;

const clamp = (value: number, low: number, high: number): number =>
	Math.min(high, Math.max(low, value));

/** The tile column a longitude falls in at zoom `z`. May be outside `[0, 2^z)` past ±180. */
const tileX = (lng: number, z: number): number => Math.floor(((lng + 180) / 360) * 2 ** z);

/** The tile row a latitude falls in at zoom `z`, clamped to the pyramid. */
const tileY = (lat: number, z: number): number => {
	const bounded = clamp(lat, -MERCATOR_LATITUDE_LIMIT, MERCATOR_LATITUDE_LIMIT);
	const radians = (bounded * Math.PI) / 180;
	const fraction = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
	return clamp(Math.floor(fraction * 2 ** z), 0, 2 ** z - 1);
};

/**
 * How many columns or rows a span covers: never more than the pyramid, and never fewer than none.
 *
 * ⚠ **The lower clamp is the one that matters.** {@link GeoBounds} lets `east` run past 180 for a box
 * crossing the antimeridian, so nothing in the type stops `east < west` — an inverted or degenerate
 * box, which a Layer with one malformed Alignment can produce. `last - first + 1` is then negative.
 * {@link tilesForBounds} simply skipped that zoom, but {@link countTilesForBounds} multiplied it out
 * — so the two enumerations the whole budget rests on being *one* disagreed, and the dialog quoted a
 * negative tile count and a negative byte estimate. Zero is the honest span: an axis with no extent
 * needs no tiles along it.
 */
const spanOf = (span: number, width: number): number => Math.min(Math.max(0, span), width);

/**
 * Every `{z}/{x}/{y}` a box needs, from zoom 0 to `maxZoom` inclusive, in ascending order.
 *
 * **From zoom 0, always** (ADR-0025). Low zooms are one or two tiles each; leaving them out makes
 * zooming out go blank inside an area the user was told is available offline, which reads as the
 * application breaking rather than as a boundary being reached (SPEC story 6).
 *
 * **The antimeridian is handled by the box, not by this** — {@link GeoBounds} says `east` may exceed
 * 180 for content that crosses it, so the column range simply runs past `2^z` and each column is
 * taken modulo the pyramid's width. A box wider than the world yields the whole row once rather than
 * the same tile several times.
 *
 * Pure, and asserted numerically in Node: this is what makes the budget honest.
 */
export function tilesForBounds(bounds: GeoBounds, maxZoom: number): TileCoordinate[] {
	const tiles: TileCoordinate[] = [];
	if (!Number.isFinite(maxZoom) || maxZoom < 0) return tiles;
	const top = Math.floor(maxZoom);
	for (let z = 0; z <= top; z += 1) {
		const width = 2 ** z;
		const first = tileX(bounds.west, z);
		const last = tileX(bounds.east, z);
		// A box spanning the world, or more, is the whole row: `last - first` can exceed the pyramid's
		// width, and taking each column modulo it would otherwise repeat tiles already listed.
		const columns = spanOf(last - first + 1, width);
		const north = tileY(bounds.north, z);
		const south = tileY(bounds.south, z);
		for (let step = 0; step < columns; step += 1) {
			const x = (((first + step) % width) + width) % width;
			for (let y = north; y <= south; y += 1) tiles.push({ z, x, y });
		}
	}
	return tiles;
}

/**
 * How many tiles {@link tilesForBounds} would return, **without building the list**.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS NOT AN OPTIMISATION
 *
 * The Project screen asks "is this Project available offline?" every time it opens, before anybody
 * has pressed anything — and a Project can legitimately have a world-spanning extent, because one
 * Annotation drawn as a polygon round the planet is enough. At z0–14 that is 358 million tiles.
 * Materialising that list to find out it is over the threshold allocates gigabytes and hangs the tab
 * before the Layer stack has drawn; `editor-layers.e2e.ts`'s whole-world fixture found it, and what
 * it looked like was "the Project screen draws no Layers at all".
 *
 * So the count is arithmetic — one multiplication per zoom level — and the list is built only once
 * the count is known to be small enough to be worth having. See {@link tileBudget}.
 */
export function countTilesForBounds(bounds: GeoBounds, maxZoom: number): number {
	if (!Number.isFinite(maxZoom) || maxZoom < 0) return 0;
	let total = 0;
	for (let z = 0; z <= Math.floor(maxZoom); z += 1) {
		const width = 2 ** z;
		const columns = spanOf(tileX(bounds.east, z) - tileX(bounds.west, z) + 1, width);
		const rows = Math.max(0, tileY(bounds.south, z) - tileY(bounds.north, z) + 1);
		total += columns * rows;
	}
	return total;
}

/** What making a Project available offline would cost, before anything is fetched. */
export interface TileBudget {
	/**
	 * Every tile the extent needs, in the order the fetch loop will walk them — **or empty when
	 * {@link overThreshold}**, because a refused request has no work to enumerate and enumerating it
	 * anyway is what hangs the tab. See {@link countTilesForBounds}. {@link count} is the honest number
	 * in both cases, and it is the number the refusal quotes.
	 */
	readonly tiles: readonly TileCoordinate[];
	/** `tiles.length`, spelled out because it is the number the dialog shows. */
	readonly count: number;
	/** {@link ESTIMATED_BYTES_PER_TILE} times {@link count}. An estimate, and said to be one. */
	readonly estimatedBytes: number;
	/** The highest zoom the source carries, which is the highest zoom cached. */
	readonly maxZoom: number;
	/** True when {@link count} is past {@link OFFLINE_TILE_LIMIT} and the request is refused. */
	readonly overThreshold: boolean;
	/** The threshold, so the refusal can quote it without importing the constant. */
	readonly limit: number;
}

/**
 * The budget for a box, up to the source's maximum zoom.
 *
 * The one function both the dialog and the fetch loop go through, so the count shown and the work
 * done cannot diverge — see the note at the top of this file.
 */
export function tileBudget(bounds: GeoBounds, maxZoom: number): TileBudget {
	// Counted first, and the list built only if the count is small enough to be worth building.
	const count = countTilesForBounds(bounds, maxZoom);
	const overThreshold = count > OFFLINE_TILE_LIMIT;
	return {
		tiles: overThreshold ? [] : tilesForBounds(bounds, maxZoom),
		count,
		estimatedBytes: count * ESTIMATED_BYTES_PER_TILE,
		maxZoom: Math.max(0, Math.floor(maxZoom)),
		overThreshold,
		limit: OFFLINE_TILE_LIMIT
	};
}
