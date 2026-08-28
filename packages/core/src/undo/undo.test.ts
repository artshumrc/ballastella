import { describe, expect, it } from 'vitest';

import { newAnnotationLayer, newMapLayer } from '../project/layer.js';
import { layerFileRef } from './undo.js';

const mapLayer = newMapLayer({ id: 'l-map', name: 'La Floride', imageId: 'floride-1657' });
const notes = newAnnotationLayer({ id: 'l-notes', name: 'Trade routes' });

describe('the file a Layer draws', () => {
	// ADR-0023: removing a Layer leaves the Map Image available. A map Layer's Alignment and pyramid are
	// the Workspace's and may be drawn by other Projects, so a delete must take **nothing** with it —
	// which is why `layerFileRef` answers `''` for one. Returning the Alignment path here would make one
	// Project's delete button destroy another Project's map.
	it('claims no file for a map Layer, because its Map Image is the Workspace’s', () => {
		expect(layerFileRef(mapLayer)).toBe('');
		expect(layerFileRef(notes)).toBe('annotations/l-notes.geojson');
		expect(
			layerFileRef({
				kind: 'foreign',
				declaredKind: 'image-annotation',
				id: 'l-cartouche',
				name: 'Cartouche',
				visible: true,
				order: 0,
				unknownFields: { webAnnotationRef: 'image-annotations/l-cartouche.json' }
			})
		).toBe('');
	});
});
