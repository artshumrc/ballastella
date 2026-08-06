// Getting the editor from "a Project is open" to "the map is framed on it" (ADR-0026).
//
// The framing itself is `projectOpeningBounds` in `@ballastella/core`, which is pure, numeric, and
// shared with the published viewer. What is here is the two things core cannot do: reach the store
// for the documents, and hold the *once* — the guard that makes the fit happen on open and never
// again.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS READS EVERY LAYER AND NOT THE ONES ON THE MAP
//
// The Layers pane loads documents for the Layers it is *drawing*, which is the visible ones, and it
// reloads them when that set changes. Neither property is wanted here. ADR-0026's fallback chain ends
// "…failing that, all Layers", so a Project whose author has hidden everything to look at the Base Map
// must still open on their work — and a hidden Layer's Alignment is simply not in that record. And a
// read tied to what is drawn is a read that happens again when a Layer is toggled, which is the
// refit ADR-0026 exists to prevent.
//
// So this is a separate, one-shot pass over every Layer, run once per Project opened. It is a read and
// nothing else: opening a Project must not modify a byte (ADR-0010), and there is no write on this path.

import {
	alignmentOpeningBounds,
	openingViewFit,
	projectOpeningBounds,
	type ContentLayer
} from '@ballastella/core';
import type { Alignment, Layer, OpeningViewFit } from '@ballastella/core';

import type { EditorSession } from '../editor-session.svelte.js';

/**
 * Every Layer of the open Project with whatever gives it a place on the earth.
 *
 * **Hidden Layers included**, and a Layer whose document cannot be read contributes nothing rather
 * than failing the whole pass: a damaged Alignment is already reported beside its own row in the
 * Layer list, and letting it decide where the map opens — or that the map does not open anywhere —
 * would be one failure standing in for the Project.
 */
export async function readProjectContent(
	session: EditorSession,
	layers: readonly Layer[]
): Promise<ContentLayer[]> {
	return Promise.all(
		layers.map(async (layer): Promise<ContentLayer> => {
			try {
				if (layer.kind === 'map') {
					return { layer, alignment: await session.readLayerAlignment(layer) };
				}
				if (layer.kind === 'annotation') {
					return { layer, annotations: await session.readAnnotations(layer) };
				}
			} catch {
				// A Layer this build cannot read has no place on the earth as far as the opening view is
				// concerned. The Layer list says what happened; the map does not have to.
			}
			return { layer };
		})
	);
}

/** What the opening view settled on, for the sentence beside the map. */
export type OpeningViewOutcome = 'pending' | 'content' | 'default';

/** The fit for a Project's current content, or `null` when it has nothing on the earth. */
export async function fitToProjectContent(
	session: EditorSession,
	layers: readonly Layer[]
): Promise<OpeningViewFit | null> {
	const bounds = projectOpeningBounds(await readProjectContent(session, layers));
	return bounds === null ? null : openingViewFit(bounds);
}

/**
 * The fit the alignment view opens on: the Alignment's Control Points, or the Project around it.
 *
 * The Project is read **only when the Alignment has nothing of its own to land on**, which is the
 * first time a Historical Map is opened. Reading it unconditionally would walk every Layer's
 * documents on every switch between Historical Maps for an answer that is then discarded — and
 * `alignmentOpeningBounds` never looks at the content it is given once there is a Control Point.
 */
export async function fitToAlignment(
	session: EditorSession,
	alignment: Alignment | null,
	layers: readonly Layer[]
): Promise<OpeningViewFit | null> {
	const content =
		alignment && alignment.controlPoints.length > 0
			? []
			: await readProjectContent(session, layers);
	const bounds = alignmentOpeningBounds(alignment, content);
	return bounds === null ? null : openingViewFit(bounds);
}
