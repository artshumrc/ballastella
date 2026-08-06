import { expect, it } from 'vitest';

import * as core from './index.js';
import { Autosave, MemoryProjectStore, Workspace } from './index.js';

// The barrel is what both apps import. A missing re-export is a build error there and a
// puzzling one, so it is worth one assertion here that the whole storage path is reachable
// through the package's public entry point.
it('exposes a working workspace through the package entry point', async () => {
	const store = new MemoryProjectStore();
	const workspace = new Workspace(store, { autosave: new Autosave(store) });

	const created = await workspace.createProject('Amsterdam 1625');

	expect((await workspace.listProjects()).map((p) => p.directory)).toEqual([created.directory]);
});

// The Layer stack, reachable through the barrel because **both** apps need it: the editor edits it
// and the published viewer reads it to know what draws over what (ADR-0019).
it('exposes the Layer stack to both apps', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'addLayer',
			'drawingOrder',
			'moveLayer',
			'newAnnotationLayer',
			'newMapLayer',
			'parseLayers',
			'renameLayer',
			'setLayerVisible',
			'setMapLayerOpacity'
		])
	);
});

// Containment, not equality: every slice adds exports, and an exhaustive list here would
// fail on each one without saying anything true about reachability. The behaviour of these
// lives in `src/image-pane`; this only asserts the apps can reach them.
it('exposes the image pane projection to both apps', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'ROUND_TRIP_TOLERANCE_PX',
			'WINDOW_TILE_ZOOM',
			'createImagePane',
			'createSyntheticProjection'
		])
	);
});

// The tiler, reachable through the barrel and *without* dragging `wasm-vips` in with it. That
// second half is the ADR-0019 boundary: `apps/viewer` imports this barrel, so an import of
// `wasm-vips` anywhere under `src` would put a 5 MB WebAssembly module in the published reader's
// dependency graph with nothing to make it loud.
it('exposes the tiler, and takes libvips only as an injected loader', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'MEASURED_DECODE_CEILING_PIXELS',
			'STREAMING_TILER_THRESHOLD_PIXELS',
			'buildImageInfo',
			'ingestImageFile',
			'openDecodeAndCropSource',
			'planPyramid',
			'streamingTiler'
		])
	);
	// Curried on the loader: calling it does not load anything.
	expect(typeof core.streamingTiler(async () => ({}) as core.VipsModule)).toBe('function');
});

// Mirroring (ticket 15) and the ADR-0008 hosting total, reachable through the same barrel. Mirroring
// is a funnel into the tiler above rather than a second one, so the assertion that matters for
// ADR-0019 is the one above: this adds no new dependency for `apps/viewer` to acquire.
it('exposes mirroring and the hosting-limit total', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'STATIC_HOSTING_LIMIT_BYTES',
			'assembleWithCanvas',
			'crossesHostingLimit',
			'describeBytes',
			'estimateMirrorBytes',
			'hostingLimitWarning',
			'mirrorRemoteImage',
			'partitionByLocalCopy',
			'planMirror',
			'workspaceSize'
		])
	);
});

// The apps import from '@ballastella/core', never from a file inside it, so the entry point
// is the contract. ADR-0020 has the published viewer carrying the catalog too, so this edge
// has to hold for both apps.
it('resolves and exposes the Base Map surface from the package entry point', () => {
	expect(typeof core.resolveBaseMap).toBe('function');
	expect(typeof core.baseMapStyle).toBe('function');
	expect(core.BASE_MAP_CATALOG.entries.length).toBeGreaterThan(0);
});
