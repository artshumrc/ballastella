// Drawing a Project onto a MapLibre map: the Layer stack, warped Historical Maps, Annotation popups,
// and the `pmtiles://` protocol the Base Map is read through.
//
// **This directory exists because two apps draw the same picture.** The editor draws a Project's stack
// so an author can compose it; the Published Site draws the same stack so a Reader can explore it
// (ticket 17). Everything here was in `apps/editor/src/lib` until ticket 17 needed it, and it moved
// rather than being copied for the reason ADR-0019 gives about `renderAnnotationPopup` and
// `toRenderCollection`: the rules below are load-bearing and **every way of getting them wrong is
// silent** — a blank warped map, an uncolourised overlay, an Annotation Layer that draws under the map
// it annotates. Two copies of a silent rule agree until one of them is edited.
//
// It adds `maplibre-gl`, `@allmaps/maplibre`, and `pmtiles` to this package's dependencies. All three
// were already dependencies of `apps/editor`, and `apps/viewer` needs all three to render a Project at
// all, so nothing gains a dependency it did not need — and ADR-0019's three forbidden names
// (`terra-draw`, the tiler, `wasm-vips`) are still absent, which is what
// `scripts/check-viewer-deps.mjs` and `scripts/check-tiler-lazy.mjs` police.

export { showAnnotationPopup, type AnnotationPopup } from './annotation-popup.js';
export { distortionRamp } from './distortion-ramp.js';
export { registerPmtilesProtocol } from './pmtiles-protocol.js';
export {
	annotationLayerIds,
	drawLayerStack,
	isDrawnMap,
	stackLayerId,
	type DrawnAnnotationLayer,
	type DrawnLayer,
	type DrawnMapLayer,
	type DrawnOutcome,
	type StackRender
} from './stack-layers.js';
export {
	createWarpedMapLayer,
	showAlignment,
	updateAlignment,
	type WarpedRender
} from './warped-map-layer.js';
