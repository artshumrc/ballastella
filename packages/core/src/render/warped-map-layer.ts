import { WarpedMapLayer } from '@allmaps/maplibre';
import { MINIMUM_CONTROL_POINTS, type Alignment } from '../alignment/alignment.js';
import {
	COMPUTED_DISTORTION_MEASURES,
	DEFAULT_DISTORTION_VIEW,
	type DistortionView
} from '../alignment/distortion.js';
import {
	toRendererControlPoints,
	toRendererDocument,
	toRendererResourceMask
} from '../alignment/georeference-annotation.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { messageOf } from '../store/project-store.js';
import {
	referencedImagePath,
	referencedRendererDocument
} from '../remote-iiif/referenced-image.js';

import { distortionRamp } from './distortion-ramp.js';

export function createWarpedMapLayer(fetchTile: FetchFn, layerId?: string): WarpedMapLayer {
	return new WarpedMapLayer({ fetchFn: fetchTile, ...(layerId === undefined ? {} : { layerId }) });
}

export type WarpedRender =
	| {
			readonly status: 'drawn';
			readonly mapId: string;
	  }
	| {
			readonly status: 'too-few-points';
			readonly have: number;
			readonly need: number;
	  }
	| { readonly status: 'refused'; readonly reason: string };

function mapOptionsFor(alignment: Alignment, distortion: DistortionView) {
	return {
		gcps: toRendererControlPoints(alignment),
		resourceMask: toRendererResourceMask(alignment),
		transformationType: alignment.transformationType,
		distortionMeasures: [...COMPUTED_DISTORTION_MEASURES],
		distortionMeasure: distortion.measure ?? undefined,
		renderGrid: distortion.grid,
		...distortionRamp()
	};
}

export function showAlignment(
	layer: WarpedMapLayer,
	alignment: Alignment,
	{
		distortion = DEFAULT_DISTORTION_VIEW,
		referenced = false,
		service = ''
	}: {
		distortion?: DistortionView;
		referenced?: boolean;
		service?: string;
	} = {}
): WarpedRender {
	if (referenced && service === '') {
		return {
			status: 'refused',
			reason:
				`This Map Image is referenced rather than copied into this Workspace, and the record ` +
				`of where it is served from (${referencedImagePath(alignment.imageId)}) could not be ` +
				`read — so there is nowhere to fetch its tiles from. Nothing is drawn, rather than an ` +
				`empty Layer reported as drawn.`
		};
	}

	const need = MINIMUM_CONTROL_POINTS[alignment.transformationType];
	const have = alignment.controlPoints.length;
	if (have < need) return { status: 'too-few-points', have, need };

	try {
		const document =
			service === ''
				? toRendererDocument(alignment)
				: referencedRendererDocument(alignment, service);
		const mapId: unknown = layer.addGeoreferencedMap(
			document,
			mapOptionsFor(alignment, distortion)
		);
		if (mapId instanceof Error) return { status: 'refused', reason: mapId.message };
		if (typeof mapId !== 'string' || mapId === '') {
			return { status: 'refused', reason: 'the renderer accepted the Alignment but named no map' };
		}
		reassertDistortionMeasure(layer, mapId, distortion);
		return { status: 'drawn', mapId };
	} catch (cause) {
		return { status: 'refused', reason: messageOf(cause) };
	}
}

// `addGeoreferencedMap` never assigns the measure field, and a same-value set is a no-op: clear, then set.
function reassertDistortionMeasure(
	layer: WarpedMapLayer,
	mapId: string,
	distortion: DistortionView
): void {
	if (distortion.measure === null) return;
	layer.setMapOptions(mapId, { distortionMeasure: undefined });
	layer.setMapOptions(mapId, { distortionMeasure: distortion.measure });
}

export function updateAlignment(
	layer: WarpedMapLayer,
	mapId: string,
	alignment: Alignment,
	distortion: DistortionView
): void {
	try {
		layer.setMapOptions(mapId, mapOptionsFor(alignment, distortion));
	} catch {
		// No map to update.
	}
}

export interface WarpedViewportTiles {
	readonly mapsWithFetchableTilesForViewport: ReadonlySet<string>;
	readonly warpedMapList: {
		getWarpedMap(
			mapId: string
		): { readonly fetchableTilesForViewport: readonly { readonly tileUrl: string }[] } | undefined;
	};
	readonly tileCache: { getCacheableTile(tileUrl: string): unknown };
}

export function warpedTilesRequestedForViewport(renderer: WarpedViewportTiles): boolean {
	for (const mapId of renderer.mapsWithFetchableTilesForViewport) {
		const warpedMap = renderer.warpedMapList.getWarpedMap(mapId);
		if (!warpedMap) continue;
		for (const fetchable of warpedMap.fetchableTilesForViewport) {
			if (renderer.tileCache.getCacheableTile(fetchable.tileUrl) === undefined) return false;
		}
	}
	return true;
}
