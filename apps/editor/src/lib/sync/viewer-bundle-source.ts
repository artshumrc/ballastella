// Where the editor keeps the read-only viewer a site is written from, and how it reads those bytes.
//
// A Published Site is an `index.html` and the viewer's files inside the user's Workspace, so
// the editor has to hold them. `scripts/stage-viewer-bundle.mjs` copies the viewer's build into
// `apps/editor/static/viewer-bundle/` during the editor's own build and writes an index beside it;
// this module fetches both back at runtime.
//
// **Everything goes through `resolveDeploymentAsset`, which means relative** (ADR-0006). The editor
// itself may be served from a domain root or from a project subdirectory, and a bundle fetched from
// `/viewer-bundle/…` would 404 on every fork hosted on GitHub Pages — where Share Links would
// then fail with the user's Workspace half written.
//
// The `source` → `path` mapping is the bundle index's, never reconstructed here. Fetching the
// Workspace-relative `index.html` from the editor's own base would fetch the *editor's* page, and a
// Published Site whose front page is the authoring application is the whole failure in one file.

import {
	ViewerBundleUnreadableError,
	parseViewerBundle,
	type Bytes,
	type ViewerBundle,
	type ViewerBundleFile
} from '@ballastella/core';

import { resolveDeploymentAsset } from '../base-map/deployment-assets';

/** Where the staged bundle's index lives among the editor's own assets. */
const BUNDLE_INDEX = 'viewer-bundle/bundle.json';

/**
 * The staged viewer, as the build recorded it.
 *
 * `no-cache` because a deployment that has been updated must not write yesterday's bundle out of
 * the HTTP cache while reporting today's version stamp — the one thing the stamp exists to make
 * detectable.
 */
export async function loadViewerBundle(): Promise<ViewerBundle> {
	const response = await fetch(resolveDeploymentAsset(BUNDLE_INDEX), { cache: 'no-cache' });
	if (!response.ok) {
		throw new ViewerBundleUnreadableError(
			`${BUNDLE_INDEX} answered ${response.status}, so this deployment has no viewer staged`
		);
	}
	return parseViewerBundle(await response.json());
}

/** One bundle file's bytes, from where this deployment serves it. */
export async function readBundleAsset(file: ViewerBundleFile): Promise<Bytes> {
	const response = await fetch(resolveDeploymentAsset(file.source));
	if (!response.ok) {
		throw new ViewerBundleUnreadableError(
			`${file.source} answered ${response.status}, so ${file.path} cannot be written`
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}
