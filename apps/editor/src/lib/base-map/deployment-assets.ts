import { base } from '$app/paths';

export function resolveDeploymentAsset(path: string): string {
	return `${assetPrefix()}/${path}`;
}

export function deploymentRoot(): string {
	return `${assetPrefix()}/`;
}

function assetPrefix(): string {
	const prefix = new URL(base === '' ? '.' : `${base}/`, document.baseURI).href;
	return prefix.replace(/\/+$/, '');
}
