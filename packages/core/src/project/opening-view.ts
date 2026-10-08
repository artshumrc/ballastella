import { GcpTransformer } from '@allmaps/transform';

import { canSolve, type Alignment } from '../alignment/alignment.js';
import {
	toRendererControlPoints,
	toRendererResourceMask
} from '../alignment/georeference-annotation.js';
import type { AnnotationCollection, AnnotationGeometry } from '../annotation/annotation.js';
import type { Layer } from './layer.js';

export interface GeoBounds {
	readonly west: number;
	readonly south: number;
	readonly east: number;
	readonly north: number;
}

export interface ContentLayer {
	readonly layer: Layer;
	readonly alignment?: Alignment | null;
	readonly annotations?: AnnotationCollection | null;
}

export const OPENING_VIEW_MAX_ZOOM = 16;
export const OPENING_VIEW_PADDING = 48;

export interface OpeningViewFit {
	readonly bounds: [[number, number], [number, number]];
	readonly padding: number;
	readonly maxZoom: number;
	readonly animate: false;
}

export type OpeningViewOutcome = 'pending' | 'content' | 'default';

export function openingViewSentence(outcome: OpeningViewOutcome, refitted: boolean): string {
	switch (outcome) {
		case 'pending':
			return '';
		case 'content':
			return `${refitted ? 'Framed on' : 'Opened framed on'} this Project’s own content.`;
		case 'default':
			return 'This Project has nothing placed on the earth, so the map is on the default view.';
	}
}

export function openingViewFit(bounds: GeoBounds): OpeningViewFit {
	return {
		bounds: [
			[bounds.west, bounds.south],
			[bounds.east, bounds.north]
		],
		padding: OPENING_VIEW_PADDING,
		maxZoom: OPENING_VIEW_MAX_ZOOM,
		animate: false
	};
}

export function projectOpeningBounds(content: readonly ContentLayer[]): GeoBounds | null {
	const visible = boundsOf(content.filter((entry) => entry.layer.visible).flatMap(pathsOf));
	return visible ?? boundsOf(content.flatMap(pathsOf));
}

const fitOf = (bounds: GeoBounds | null): OpeningViewFit | null =>
	bounds === null ? null : openingViewFit(bounds);

export const projectOpeningFit = (content: readonly ContentLayer[]): OpeningViewFit | null =>
	fitOf(projectOpeningBounds(content));

export function alignmentOpeningBounds(
	alignment: Alignment | null,
	content: readonly ContentLayer[]
): GeoBounds | null {
	const points = (alignment?.controlPoints ?? []).map((point): GeoPath => [
		[point.geo.lng, point.geo.lat]
	]);
	return boundsOf(points) ?? projectOpeningBounds(content);
}

export const alignmentOpeningFit = (
	alignment: Alignment | null,
	content: readonly ContentLayer[]
): OpeningViewFit | null => fitOf(alignmentOpeningBounds(alignment, content));

interface FittableMap {
	fitBounds(
		bounds: [[number, number], [number, number]],
		options: { padding: number; maxZoom: number; animate: boolean }
	): void;
}

export function applyOpeningFit(
	map: FittableMap | undefined,
	request: OpeningViewFit | null,
	fitted: OpeningViewFit | null
): OpeningViewFit | null {
	if (map === undefined || request === null || request === fitted) return fitted;
	map.fitBounds(request.bounds, {
		padding: request.padding,
		maxZoom: request.maxZoom,
		animate: request.animate
	});
	return request;
}

type GeoPath = readonly (readonly [number, number])[];

function pathsOf(entry: ContentLayer): GeoPath[] {
	const paths: GeoPath[] = [];
	if (entry.alignment) {
		const ring = alignedSheetRing(entry.alignment);
		if (ring.length > 0) paths.push(closedRing(ring));
	}
	if (entry.annotations) {
		for (const annotation of entry.annotations.annotations) {
			paths.push(...geometryPaths(annotation.geometry));
		}
	}
	return paths;
}

function alignedSheetRing(alignment: Alignment): (readonly [number, number])[] {
	if (!canSolve(alignment) || alignment.resourceMask.length === 0) return [];
	let ring: [number, number][];
	try {
		ring = new GcpTransformer(toRendererControlPoints(alignment), alignment.transformationType)
			.transformToGeo([toRendererResourceMask(alignment)], MASK_REFINEMENT)
			.flat();
	} catch {
		return [];
	}
	return isAPlace(ring) ? ring : [];
}

const MASK_REFINEMENT = { maxDepth: 2, minOffsetRatio: 0 } as const;

function isAPlace(ring: readonly (readonly [number, number])[]): boolean {
	let west = Number.POSITIVE_INFINITY;
	let east = Number.NEGATIVE_INFINITY;
	for (const [lng, lat] of ring) {
		if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
		if (Math.abs(lat) > 90 || Math.abs(lng) > 360) return false;
		west = Math.min(west, lng);
		east = Math.max(east, lng);
	}
	return east - west <= 360;
}

function geometryPaths(geometry: AnnotationGeometry): GeoPath[] {
	if (geometry === null) return [];
	switch (geometry.type) {
		case 'Point':
			return [[geometry.coordinates]];
		case 'LineString':
			return [geometry.coordinates];
		case 'Polygon':
		case 'Circle':
			return geometry.coordinates.map(closedRing);
		case 'foreign':
			return [];
	}
}

function closedRing(ring: GeoPath): GeoPath {
	const first = ring[0];
	const last = ring[ring.length - 1];
	if (ring.length < 2 || first === undefined || last === undefined) return ring;
	return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

function normaliseLongitude(lng: number): number {
	if (lng >= -180 && lng < 180) return lng;
	return ((((lng + 180) % 360) + 360) % 360) - 180;
}

function boundsOf(paths: readonly GeoPath[]): GeoBounds | null {
	const runs = paths.flatMap(usableRuns);
	if (runs.length === 0) return null;
	let south = Number.POSITIVE_INFINITY;
	let north = Number.NEGATIVE_INFINITY;
	for (const run of runs) {
		for (const [, lat] of run) {
			south = Math.min(south, lat);
			north = Math.max(north, lat);
		}
	}
	const { west, east } = longitudeSpan(runs);
	return { west, south, east, north };
}

function usableRuns(path: GeoPath): GeoPath[] {
	const runs: (readonly [number, number])[][] = [];
	let current: (readonly [number, number])[] = [];
	for (const position of path) {
		const [lng, lat] = position;
		if (Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90) {
			current.push(position);
		} else if (current.length > 0) {
			runs.push(current);
			current = [];
		}
	}
	if (current.length > 0) runs.push(current);
	return runs;
}

interface LongitudeArc {
	readonly start: number;
	readonly end: number;
	readonly origin: number;
	readonly endAt: number;
}

function longitudeArc(a: number, b: number): LongitudeArc {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const shift = Math.round((normaliseLongitude(lo) - lo) / 360) * 360;
	const start = lo + shift;
	const end = hi + shift;
	return { start, end, origin: start, endAt: end };
}

const WHOLE_WORLD = { west: -180, east: 180 } as const;

function longitudeSpan(runs: readonly GeoPath[]): { west: number; east: number } {
	const arcs: LongitudeArc[] = [];
	for (const run of runs) {
		const first = run[0];
		if (first === undefined) continue;
		if (run.length === 1) arcs.push(longitudeArc(first[0], first[0]));
		let previous = first;
		for (const position of run.slice(1)) {
			arcs.push(longitudeArc(previous[0], position[0]));
			previous = position;
		}
	}
	if (arcs.length === 0) return WHOLE_WORLD;

	const doubled = arcs
		.flatMap((arc): LongitudeArc[] => [
			arc,
			{ start: arc.start + 360, end: arc.end + 360, origin: arc.origin, endAt: arc.endAt }
		])
		.sort((left, right) => left.start - right.start);

	const covered: { start: number; end: number; origin: number; endAt: number }[] = [];
	for (const arc of doubled) {
		const last = covered[covered.length - 1];
		if (last !== undefined && arc.start <= last.end) {
			if (arc.end > last.end) {
				last.end = arc.end;
				last.endAt = arc.endAt;
			}
		} else {
			covered.push({ start: arc.start, end: arc.end, origin: arc.origin, endAt: arc.endAt });
		}
	}
	if (covered.some((run) => run.end - run.start >= 360)) return WHOLE_WORLD;
	const period = covered.filter((run) => run.start < 180).length;
	if (period === 0 || period >= covered.length) return WHOLE_WORLD;
	let before = covered[period - 1] as LongitudeArc;
	let after = covered[period] as LongitudeArc;
	let widest = after.start - before.end;
	for (let index = 0; index < period - 1; index += 1) {
		const candidateBefore = covered[index] as LongitudeArc;
		const candidateAfter = covered[index + 1] as LongitudeArc;
		const gap = candidateAfter.start - candidateBefore.end;
		if (gap > widest) {
			widest = gap;
			before = candidateBefore;
			after = candidateAfter;
		}
	}

	const west = after.origin;
	const east = before.endAt;
	return { west, east: east >= west ? east : east + 360 };
}
