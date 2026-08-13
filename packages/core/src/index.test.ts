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

// The tiler, reachable through the barrel and adding no dependency for `apps/viewer` to acquire.
// That second half is the ADR-0019 boundary: `apps/viewer` imports this barrel, and it used to be
// possible for an import of `wasm-vips` anywhere under `src` to put a 5 MB WebAssembly module in
// the published reader's dependency graph with nothing to make it loud. ADR-0027 removed the
// package; what is left is `createImageBitmap` and an `OffscreenCanvas`, injected by the app.
it('exposes the tiler and its cap', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'MAX_INGEST_PIXELS',
			'MEASURED_DECODE_CEILING_PIXELS',
			'ImageTooLargeError',
			'buildImageInfo',
			'ingestImageFile',
			'openDecodeAndCropSource',
			'planPyramid'
		])
	);
	// The cap is 528,006,700 (ADR-0027) and not the 268,435,456 routing threshold it replaced, which
	// is the whole of the widening: a 300-megapixel scan both measured engines decode is admitted.
	//
	// **The two constants are equal today and that is deliberately not asserted.** `decode-ceiling.ts`
	// keeps them apart precisely so a later margin, or a Safari measurement, can move the cap without
	// moving the record of what was measured. Pinning them equal would make the reason for the design
	// a build failure the first time somebody acted on it.
	expect(core.MAX_INGEST_PIXELS).toBe(528_006_700);

	// The names that are gone, asserted as gone. `apps/editor` imported both from here, and an export
	// that lingers is how a deleted path gets quietly rewired.
	//
	// Kept under the rule in CONTRIBUTING, worked through in `e2e/editor-pwa.e2e.ts` beside the other
	// three assertions of this same shape: an absence assertion earns its place when a plausible
	// one-line change would make the name appear again, and re-exporting a name is one line.
	expect(Object.keys(core)).not.toContain('streamingTiler');
	expect(Object.keys(core)).not.toContain('STREAMING_TILER_THRESHOLD_PIXELS');
});

// Making an offline copy (ticket 15) and the ADR-0008 hosting total, reachable through the same barrel. Making an offline copy
// is a funnel into the tiler above rather than a second one, so the assertion that matters for
// ADR-0019 is the one above: this adds no new dependency for `apps/viewer` to acquire.
it('exposes making an offline copy and the hosting-limit total', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'STATIC_HOSTING_LIMIT_BYTES',
			'assembleWithCanvas',
			'crossesHostingLimit',
			'describeBytes',
			'estimateOfflineCopyBytes',
			'hostingLimitWarning',
			'makeOfflineCopy',
			'partitionByOfflineCopy',
			'planOfflineCopy',
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

// The blob SHA and the fake GitHub, reachable through the same barrel (ADR-0032). The fake is test
// material in `src/` on the precedent of the store conformance suite and the directory-handle
// fixture, and it is here rather than in each spec so that eleven tickets share one GitHub instead
// of writing eleven that can disagree with each other.
it('exposes the git blob SHA and the fake GitHub', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'GITHUB_API_ORIGIN',
			'GITHUB_RAW_ORIGIN',
			'createFakeGitHub',
			'gitBlobSha'
		])
	);
});

// The publish engine, reachable through the same barrel because the navigation bar drives it
// (ADR-0032). It adds no dependency: paths, byte counts, JSON, and an injected `fetch`.
it('exposes the publish engine and its refusals', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'MAX_PUBLISHED_FILES',
			'RemotePublishRateLimitedError',
			'RemotePublishRefusedError',
			'planRemotePublish',
			'publishToRemote'
		])
	);
});

// The binding and the credential, reachable through the same barrel: the editor is the only caller
// of both, and it imports nothing from `packages/core` except this file. The credential store is
// here rather than in the app so that the one rule ADR-0033 states about it — sealed while a Review
// Workspace is open — has a test seam the app has not got.
it('exposes the Remote binding and the credential store', () => {
	expect(Object.keys(core)).toEqual(
		expect.arrayContaining([
			'REMOTE_BINDING_PATH',
			'bindWorkspaceToRemote',
			'browserCredentialStore',
			'clearRemoteBinding',
			'closedWhileReviewing',
			'describeRemote',
			'describeTokenProblem',
			'parseRemoteReference',
			'readRemoteBinding',
			'writeRemoteBinding'
		])
	);
});
