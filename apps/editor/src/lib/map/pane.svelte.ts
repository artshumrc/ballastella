import type { Map as MapLibreMap } from 'maplibre-gl';

import {
	createOverlayPointLayer,
	type OverlayPoint,
	type OverlayPointLayer,
	type OverlayPointLayerOptions
} from '$lib/overlay/overlay-points';

export function showOverlayPoints<TPoint>(
	map: () => MapLibreMap | undefined,
	options: Omit<OverlayPointLayerOptions<TPoint>, 'map'>,
	points: () => readonly OverlayPoint<TPoint>[]
): void {
	let layer = $state.raw<OverlayPointLayer<TPoint>>();

	$effect(() => {
		const current = map();
		if (!current) return;
		const created = createOverlayPointLayer({ ...options, map: current });
		layer = created;
		return () => {
			layer = undefined;
			created.destroy();
		};
	});

	$effect(() => {
		layer?.update(points());
	});
}
