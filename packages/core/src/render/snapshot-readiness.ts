// Whether the map on screen can be handed over as a Map Snapshot — as a state machine over the
// events that change the answer, and nothing else.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// WHY THIS IS A REDUCER IN `core` AND NOT A HANDFUL OF BOOLEANS IN A PANE
//
// The claim a ready control makes is precise: *this frame, the one on screen now, is complete*. Every
// way of getting that wrong produces a plausible file rather than an error — a Map Image half drawn,
// a Base Map at the zoom the scholar left two seconds ago, a label that had not been placed yet. The
// scholar cannot tell from the PNG; they find out when the figure is already in the paper.
//
// So the rules are worth stating once, in a form that can be proved without a browser:
//
//   1. Anything that can change pixels **replaces the frame**, synchronously, before anything is
//      awaited. There is no window in which the control is ready for a frame that has gone.
//   2. An answer that arrives from an earlier frame is **discarded**. Tiles, idle events and renders
//      all arrive late, and the one thing they must never do is enable a control for a picture that
//      is no longer on screen.
//   3. A known asset failure outranks a settled frame. The map may well have stopped drawing and
//      fallen quiet; quiet is not complete.
//   4. Capturing is a **busy overlay**, not a state of its own: it stops a second press and then
//      gives the frame's own answer back. A capture that failed is not a frame that failed.
//
// The pane feeds it map events, the page feeds it asset outcomes and the capture, and neither owns
// the rules. `packages/core` because the Published Site will do exactly the same thing (ADR-0019) —
// and because a second copy of rule 2 would agree with this one right up until one of them was
// edited.
//
// **Nothing here composes prose.** `MapSnapshotButton` in `packages/ui` owns the control's wording,
// including the sentence announced after a failed capture; this owns the state that wording
// describes.

/**
 * Everything that can change what the map draws, named.
 *
 * The list is the point. Each entry is a real source in the pane — a MapLibre event, a `setStyle`, a
 * write into a live source — and a source missing from it is a frame whose readiness describes the
 * frame before it. They are told apart only so that the enumeration can be read, and asserted,
 * rather than inferred from the call sites: the reducer does the same thing with every one of them.
 *
 * - `camera` — a pan, a zoom, a rotation, a tilt, or a frame of an animated flight.
 * - `resize` — the container changed size, so the drawing buffer did too.
 * - `base-map` — the style was replaced: the theme, the tile choice, the appearance switches, or the
 *   border choice (ADR-0020 puts the last three behind one button, and all three change pixels).
 * - `layer-stack` — Layers appeared, disappeared or changed order, and the stack was rebuilt.
 * - `layer-opacity` — a Map Image's opacity, applied in place.
 * - `annotations` — an Annotation's content, geometry or styling, or a drag preview.
 * - `selection` — which Annotation is drawn emphasised, which a clean capture has to render without.
 */
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

/**
 * What the control can do about the frame on screen.
 *
 * The generation travels with the state so that a reader of one of these can tell *which* frame it
 * describes, which is the whole distinction this module exists to keep.
 */
export type SnapshotAvailability =
	/** The frame is being drawn, or its assets are still arriving. */
	| { readonly state: 'preparing'; readonly generation: number }
	/** Everything this frame needs is drawn, and it can be captured. */
	| { readonly state: 'ready'; readonly generation: number }
	/** Something this frame needs is known to have failed; the map's own notice says what. */
	| { readonly state: 'unavailable'; readonly generation: number };

/** The facts the availability above is read off. */
export interface SnapshotReadiness {
	/**
	 * Which frame this describes. Incremented by every invalidator, and never reused.
	 *
	 * It is the only defence against a late answer: an `idle` event or a settled tile cache carries
	 * the generation it was asked about, and one that does not match is a report about a picture that
	 * is no longer on screen.
	 */
	readonly generation: number;
	/** Whether {@link generation}'s frame has finished drawing everything it asked for. */
	readonly settled: boolean;
	/** Whether the Base Map is known to have failed. Cleared by the map reporting it is drawing again. */
	readonly baseMapFailed: boolean;
	/**
	 * Whether a visible Map Image's bytes are known to have been refused.
	 *
	 * Latched from the injection shim's outcomes rather than per frame, because that is what those
	 * outcomes mean: a refusal stands until *every* refused URL has come back
	 * (`createStoreImageFetch`'s `onOutcome`), which is the only evidence that the map is whole again.
	 */
	readonly mapImageFailed: boolean;
	/** Whether a capture is in flight, which is what stops a second one starting. */
	readonly capturing: boolean;
	/**
	 * Whether the last capture attempt failed and nothing has superseded it.
	 *
	 * A fact rather than a sentence: the control owns the wording (`MapSnapshotButton`), and both
	 * applications mount that same control.
	 */
	readonly captureFailed: boolean;
}

/** Nothing drawn, nothing asked for, nothing wrong. */
export const initialSnapshotReadiness: SnapshotReadiness = {
	generation: 0,
	settled: false,
	baseMapFailed: false,
	mapImageFailed: false,
	capturing: false,
	captureFailed: false
};

/** What the pane, the page and the download tell {@link snapshotReadinessAfter}. */
export type SnapshotReadinessEvent =
	/** The pixels can have changed: a new frame, and readiness starts again. */
	| { readonly kind: 'frame-invalidated'; readonly by: FrameInvalidator }
	/** A frame finished drawing everything it asked for. Ignored unless it is the current one. */
	| { readonly kind: 'frame-settled'; readonly generation: number }
	/** The Base Map's own source failed, or reported itself drawing again. */
	| { readonly kind: 'base-map-assets'; readonly failed: boolean }
	/** A Map Image's bytes were refused, or every refused URL has come back. */
	| { readonly kind: 'map-image-assets'; readonly failed: boolean }
	/** A capture began. Refused unless the current frame is ready and nothing else is capturing. */
	| { readonly kind: 'capture-started' }
	/** The PNG reached the browser's download. */
	| { readonly kind: 'capture-finished' }
	/** The read, the encode or the download failed. Not an asset failure — see the module header. */
	| { readonly kind: 'capture-failed' };

/**
 * Whether the frame on screen can be captured right now.
 *
 * The one question the control asks, so that "ready" and "not already busy" cannot be spelled two
 * ways at two call sites.
 */
export const canCaptureSnapshot = (readiness: SnapshotReadiness): boolean =>
	snapshotAvailability(readiness).state === 'ready' && !readiness.capturing;

/**
 * What the control can do about the frame this readiness describes.
 *
 * Derived rather than stored, so that the three facts behind it cannot drift out of agreement with
 * the answer they produce. A known failure outranks a settled frame: a map that stopped drawing
 * falls quiet exactly as a finished one does.
 */
export function snapshotAvailability(readiness: SnapshotReadiness): SnapshotAvailability {
	const { generation } = readiness;
	if (readiness.baseMapFailed || readiness.mapImageFailed)
		return { state: 'unavailable', generation };
	return { state: readiness.settled ? 'ready' : 'preparing', generation };
}

/**
 * The readiness after one event.
 *
 * Returns the state it was given, by identity, for an event that changes nothing — a settled report
 * from a frame that has gone, a second press while a capture is running. A consumer holding this in
 * `$state.raw` therefore does no work for the events that are supposed to do nothing, which is most
 * of them during a drag.
 */
export function snapshotReadinessAfter(
	readiness: SnapshotReadiness,
	event: SnapshotReadinessEvent
): SnapshotReadiness {
	switch (event.kind) {
		case 'frame-invalidated':
			// Synchronously, and before anything is awaited: the window between "the map moved" and
			// "we noticed" is the window in which a scholar downloads the previous view. The asset
			// failures are deliberately carried over — a refused tile is refused for this frame too,
			// until the shim says every refused URL has come back — and so is a capture in flight,
			// which is reading a frame of its own and is not cancelled by the map moving under it.
			return { ...readiness, generation: readiness.generation + 1, settled: false };
		case 'frame-settled':
			// Rule 2. The pane starts a fresh wait per generation, so a late resolution from an
			// abandoned one is not merely redundant: acting on it would enable the control for a
			// picture that is no longer on screen.
			if (event.generation !== readiness.generation) return readiness;
			return readiness.settled ? readiness : { ...readiness, settled: true };
		case 'base-map-assets':
			if (event.failed === readiness.baseMapFailed) return readiness;
			return { ...readiness, baseMapFailed: event.failed };
		case 'map-image-assets':
			if (event.failed === readiness.mapImageFailed) return readiness;
			return { ...readiness, mapImageFailed: event.failed };
		case 'capture-started':
			// The control is disabled in both of these cases, so neither should arrive; refusing them
			// here is what makes that a property of the machine rather than of the markup.
			if (!canCaptureSnapshot(readiness)) return readiness;
			// The announcement is cleared as the retry begins, not when it succeeds. An `aria-live`
			// region speaks when its text *changes*, so a second failure whose sentence was still
			// standing from the first would be a failure nobody was told about.
			return { ...readiness, capturing: true, captureFailed: false };
		case 'capture-finished':
			return { ...readiness, capturing: false, captureFailed: false };
		case 'capture-failed':
			// Rule 4: the frame is untouched. Whatever was true of it before the press is true after,
			// so a transient `toBlob` refusal leaves the control ready to be pressed again.
			return { ...readiness, capturing: false, captureFailed: true };
	}
}
