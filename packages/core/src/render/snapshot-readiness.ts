export const FRAME_INVALIDATORS = [
	'camera',
	'resize',
	'base-map',
	'layer-stack',
	'layer-opacity',
	'annotations',
	'selection'
] as const;

export type FrameInvalidator = (typeof FRAME_INVALIDATORS)[number];

type SnapshotAvailability = {
	readonly state: 'preparing' | 'ready' | 'unavailable';
	readonly generation: number;
};

export interface SnapshotReadiness {
	readonly generation: number;
	readonly settled: boolean;
	readonly baseMapFailed: boolean;
	readonly mapImageFailed: boolean;
	readonly capturing: boolean;
	readonly captureFailed: boolean;
}

export const initialSnapshotReadiness: SnapshotReadiness = {
	generation: 0,
	settled: false,
	baseMapFailed: false,
	mapImageFailed: false,
	capturing: false,
	captureFailed: false
};

export type SnapshotReadinessEvent =
	| { readonly kind: 'frame-invalidated'; readonly by: FrameInvalidator }
	| { readonly kind: 'frame-settled'; readonly generation: number }
	| { readonly kind: 'base-map-assets'; readonly failed: boolean }
	| { readonly kind: 'map-image-assets'; readonly failed: boolean }
	| { readonly kind: 'capture-started' }
	| { readonly kind: 'capture-finished' }
	| { readonly kind: 'capture-failed' };

export const canCaptureSnapshot = (readiness: SnapshotReadiness): boolean =>
	snapshotAvailability(readiness).state === 'ready' && !readiness.capturing;

export function snapshotAvailability(readiness: SnapshotReadiness): SnapshotAvailability {
	const { generation } = readiness;
	if (readiness.baseMapFailed || readiness.mapImageFailed)
		return { state: 'unavailable', generation };
	return { state: readiness.settled ? 'ready' : 'preparing', generation };
}

export function snapshotReadinessAfter(
	readiness: SnapshotReadiness,
	event: SnapshotReadinessEvent
): SnapshotReadiness {
	switch (event.kind) {
		case 'frame-invalidated':
			return { ...readiness, generation: readiness.generation + 1, settled: false };
		case 'frame-settled':
			if (event.generation !== readiness.generation) return readiness;
			return readiness.settled ? readiness : { ...readiness, settled: true };
		case 'base-map-assets':
			if (event.failed === readiness.baseMapFailed) return readiness;
			return { ...readiness, baseMapFailed: event.failed };
		case 'map-image-assets':
			if (event.failed === readiness.mapImageFailed) return readiness;
			return { ...readiness, mapImageFailed: event.failed };
		case 'capture-started':
			if (!canCaptureSnapshot(readiness)) return readiness;
			return { ...readiness, capturing: true, captureFailed: false };
		case 'capture-finished':
			return { ...readiness, capturing: false, captureFailed: false };
		case 'capture-failed':
			return { ...readiness, capturing: false, captureFailed: true };
	}
}
