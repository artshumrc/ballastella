import { alignmentOpeningFit, projectOpeningFit, type ContentLayer } from '@ballastella/core';
import type { Alignment, Layer, OpeningViewFit } from '@ballastella/core';

import type { EditorSession } from '../editor-session.svelte.js';

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
				return { layer };
			}
			return { layer };
		})
	);
}

export async function fitToProjectContent(
	session: EditorSession,
	layers: readonly Layer[]
): Promise<OpeningViewFit | null> {
	return projectOpeningFit(await readProjectContent(session, layers));
}

export async function fitToAlignment(
	session: EditorSession,
	alignment: Alignment | null,
	layers: readonly Layer[]
): Promise<OpeningViewFit | null> {
	const content =
		alignment && alignment.controlPoints.length > 0
			? []
			: await readProjectContent(session, layers);
	return alignmentOpeningFit(alignment, content);
}
