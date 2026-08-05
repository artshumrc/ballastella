// @ballastella/core — the domain model, ProjectStore and its adapters, IIIF glue,
// alignment serialisation, and annotation styling (ADR-0019).

export {
	ROUND_TRIP_TOLERANCE_PX,
	WINDOW_TILE_ZOOM,
	createSyntheticProjection
} from './image-pane/synthetic-projection';
export type {
	PyramidGeometry,
	ResourcePoint,
	SyntheticLngLat,
	SyntheticProjection
} from './image-pane/synthetic-projection';

export { createImagePane } from './image-pane/iiif-image-pane';
export type { ImagePane, ImagePaneTile, XyzTile } from './image-pane/iiif-image-pane';
