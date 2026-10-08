import type { DrawnStackObjects, StackBuiltListener } from '@ballastella/core/render';

type TileAddress = { z: number; x: number; y: number };
type StackHandle = DrawnStackObjects & { builds: number };

declare global {
	interface Window {
		ballastellaServedBaseMapTiles?: (TileAddress & { bytes: number })[];
		ballastellaMissedBaseMapTiles?: TileAddress[];
		ballastellaLayerStack?: StackHandle;
		ballastellaReaderMap?: StackHandle;
	}
}

export const recordCachedBaseMapTiles = () => ({
	onServed: (tile: TileAddress & { bytes: number }) => {
		(window.ballastellaServedBaseMapTiles ??= []).push(tile);
	},
	onMissed: (tile: TileAddress) => {
		(window.ballastellaMissedBaseMapTiles ??= []).push(tile);
	}
});

const builds = { ballastellaLayerStack: 0, ballastellaReaderMap: 0 };

export const exposeStackToBrowserTests =
	(name: keyof typeof builds): StackBuiltListener =>
	(map, warped) => {
		window[name] = { map, warped, builds: ++builds[name] };
		return () => delete window[name];
	};
