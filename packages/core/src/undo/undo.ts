// Which file a Layer draws, for the deletion that has to remove it.

import type { Layer } from '../project/layer.js';

/**
 * The file a Layer draws that belongs to **this Project**, by path within it, or `''` when there is
 * none.
 *
 * The one place that maps a Layer's kind to the file that has to be deleted with it, so the deletion
 * and the Step that reverses it cannot disagree about which file that is.
 *
 * **A map Layer answers `''`, and that is ADR-0023 rather than an omission.** Its Alignment and its
 * pyramid belong to the Workspace and are shared by every Project that references the image, so
 * deleting the Layer must leave both alone — removing a Layer leaves the Map Image available.
 * Returning `alignments/<id>.json` here would make one Project's delete button destroy another
 * Project's map.
 *
 * A {@link import('../project/layer.js').ForeignLayer} answers `''` too, for a different reason: its
 * reference is a field in `unknownFields` whose name this build has never heard of, and guessing would
 * either orphan a file or delete one we were never asked to touch.
 */
export function layerFileRef(layer: Layer): string {
	switch (layer.kind) {
		case 'map':
			return '';
		case 'annotation':
			return layer.geojsonRef;
		case 'foreign':
			return '';
	}
}
