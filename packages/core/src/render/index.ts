// Drawing a Project onto a MapLibre map: the Layer stack, warped Map Images, Annotation popups,
// and the `pmtiles://` protocol the Base Map is read through.
//
// **This directory exists because two apps draw the same picture.** The editor draws a Project's stack
// so an author can compose it; the Published Site draws the same stack so a Reader can explore it. It
// lives in `core` rather than in either app for the reason ADR-0019 gives about
// `renderAnnotationPopup` and `toRenderCollection`: the rules below are load-bearing and **every way
// of getting them wrong is silent** — a blank warped map, an uncolourised overlay, an Annotation Layer
// that draws under the map it annotates. Two copies of a silent rule agree until one of them is
// edited.
//
// It adds `maplibre-gl`, `@allmaps/maplibre`, and `pmtiles` to this package's dependencies. All three
// were already dependencies of `apps/editor`, and `apps/viewer` needs all three to render a Project at
// all, so nothing gains a dependency it did not need — and ADR-0019's forbidden names
// (`terra-draw`, the tiler) are still absent, which is what `scripts/check-viewer-deps.mjs` polices.

// ⚠ **`showAnnotationPopup` has no caller and is kept on purpose**: it is this
// repository's one worked example of building a popup surface safely, and the only caller of the one
// `setHTML` (ADR-0009). A dead-code sweep starts at a barrel, which is why the warning is repeated
// here as well as in `annotation-popup.ts`. Removing it is a decision, not a tidy-up.
export { showAnnotationPopup, type AnnotationPopup } from './annotation-popup.js';
// Where an Annotation sits on the screen, which is what the leader points at.
export { annotationMarkBox, type ScreenBox } from './annotation-mark.js';
export { distortionRamp, themeColour } from './distortion-ramp.js';
export { registerPmtilesProtocol } from './pmtiles-protocol.js';
// The Workspace's own Base Map tiles, behind ADR-0011's third `addProtocol` handler (ADR-0025).
export {
	BASE_MAP_TILE_PROTOCOL,
	cachedBaseMapTileTemplate,
	registerCachedBaseMapTiles,
	type ReadCachedTile
} from './base-map-tile-protocol.js';
export {
	annotationDrawKey,
	annotationLayerIds,
	drawLayerStack,
	isDrawnMap,
	stackLayerId,
	type DrawnAnnotationLayer,
	type DrawnStackObjects,
	type DrawnLayer,
	type DrawnMapLayer,
	type DrawnOutcome,
	type StackBuiltListener,
	type StackRender
} from './stack-layers.js';
export {
	createWarpedMapLayer,
	showAlignment,
	updateAlignment,
	type WarpedRender
} from './warped-map-layer.js';
