import type { WarpedMapLayer } from '@allmaps/maplibre';
import type { FetchFn, ImagePaneTile } from '@ballastella/core';
import type { Map as MapLibreMap } from 'maplibre-gl';

import { attempt } from './browser-storage.js';

type ServedTile = {
	paneId: string;
	scaleFactor: number;
	column: number;
	row: number;
	url: string;
	placement: { width: number; height: number };
};

declare global {
	interface Window {
		ballastellaWarped?: { map: MapLibreMap; layer: WarpedMapLayer };
		ballastellaImagePane?: MapLibreMap;
		ballastellaServedTiles?: ServedTile[];
		ballastellaAlignmentWrites?: { path: string; controlPoints: number }[];
		ballastellaAnnotationWrites?: { path: string; annotations: number; bytes: number }[];
		ballastellaBaseMap?: MapLibreMap;
		ballastellaRemoteRequests?: { hosts: string[] };
	}
}

const inBrowser = (): boolean => typeof window !== 'undefined';

export function exposeWarpedLayerToBrowserTests(
	map: MapLibreMap,
	layer: WarpedMapLayer
): () => void {
	window.ballastellaWarped = { map, layer };
	return () => delete window.ballastellaWarped;
}

export function exposeImagePaneToBrowserTests(map: MapLibreMap): () => void {
	window.ballastellaImagePane = map;
	return () => {
		if (window.ballastellaImagePane === map) delete window.ballastellaImagePane;
	};
}

export function recordServedTile(paneId: string, tile: ImagePaneTile): void {
	const { scaleFactor, column, row, url, placement } = tile;
	window.ballastellaServedTiles?.push({
		paneId,
		scaleFactor,
		column,
		row,
		url,
		placement: { ...placement }
	});
}

export function recordAlignmentWrite(path: string, controlPoints: number): void {
	if (inBrowser()) window.ballastellaAlignmentWrites?.push({ path, controlPoints });
}

export function recordAnnotationWrite(path: string, annotations: number, bytes: number): void {
	if (inBrowser()) window.ballastellaAnnotationWrites?.push({ path, annotations, bytes });
}

export function exposeBaseMapToBrowserTests(map: MapLibreMap): () => void {
	window.ballastellaBaseMap = map;
	return () => delete window.ballastellaBaseMap;
}

const hosts = new Set<string>();

function recordRemoteRequest(url: string): void {
	if (!inBrowser()) return;
	hosts.add(attempt(() => new URL(url).hostname) ?? url);
	window.ballastellaRemoteRequests = { hosts: [...hosts] };
}

export function recordingFetch(through: FetchFn = (input, init) => fetch(input, init)): FetchFn {
	return (input, init) => {
		recordRemoteRequest(
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		);
		return through(input, init);
	};
}
