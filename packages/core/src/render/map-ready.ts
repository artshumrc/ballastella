import type { Map as MapLibreMap } from 'maplibre-gl';

import type { BaseMapAppearance, BaseMapBorderStyle, BaseMapBorders } from '../base-map/index.js';

const STYLE_WAIT_MS = 15_000;
const STYLE_POLL_MS = 250;

// Polls too: errored tiles finish without `styledata` or `idle`. Giving up keeps waiting.
export function whenStyleLoaded(
	map: MapLibreMap,
	attach: () => void,
	giveUp: () => void = () => undefined
): () => void {
	if (map.isStyleLoaded()) {
		attach();
		return () => undefined;
	}
	const stop = () => {
		clearTimeout(timer);
		clearInterval(poll);
		map.off('styledata', retry);
		map.off('idle', retry);
	};
	const retry = () => {
		if (!map.isStyleLoaded()) return;
		stop();
		attach();
	};
	map.on('styledata', retry);
	map.on('idle', retry);
	const poll = setInterval(retry, STYLE_POLL_MS);
	const timer = setTimeout(giveUp, STYLE_WAIT_MS);
	return stop;
}

export const whenMapIdle = (map: MapLibreMap): Promise<void> =>
	new Promise((resolve) => {
		if (map.loaded() && !map.isMoving() && !map.isZooming() && !map.isRotating()) resolve();
		else map.once('idle', () => resolve());
	});

export const baseMapPaintKey = (paint: {
	entryId: string;
	theme: string;
	cachedTo: number | null;
	appearance: BaseMapAppearance;
	borders: BaseMapBorders;
	borderStyle: BaseMapBorderStyle;
}): string => {
	const { appearance: a, borderStyle: b } = paint;
	return `${paint.entryId}@${paint.theme}@${paint.cachedTo ?? 'network'}@${a.streets}${a.relief}${a.highContrast}${a.imagery}@${paint.borders}@${b.color ?? 'auto'}@${b.lineStyle ?? 'auto'}@${b.width ?? 'auto'}`;
};
