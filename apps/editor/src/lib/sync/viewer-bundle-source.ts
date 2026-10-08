import {
	ViewerBundleUnreadableError,
	parseViewerBundle,
	type Bytes,
	type ViewerBundle,
	type ViewerBundleFile
} from '@ballastella/core';

import { resolveDeploymentAsset } from '../base-map/deployment-assets';

const BUNDLE_INDEX = 'viewer-bundle/bundle.json';

export async function loadViewerBundle(): Promise<ViewerBundle> {
	const response = await fetch(resolveDeploymentAsset(BUNDLE_INDEX), { cache: 'no-cache' });
	if (!response.ok) {
		throw new ViewerBundleUnreadableError(
			`${BUNDLE_INDEX} answered ${response.status}, so this deployment has no viewer staged`
		);
	}
	return parseViewerBundle(await response.json());
}

export async function readBundleAsset(file: ViewerBundleFile): Promise<Bytes> {
	const response = await fetch(resolveDeploymentAsset(file.source));
	if (!response.ok) {
		throw new ViewerBundleUnreadableError(
			`${file.source} answered ${response.status}, so ${file.path} cannot be written`
		);
	}
	return new Uint8Array(await response.arrayBuffer());
}
