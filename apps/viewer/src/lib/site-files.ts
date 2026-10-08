import { base } from '$app/paths';
import { createHttpProjectStore, type ReadOnlyProjectStore } from '@ballastella/core';

const siteUrl = (path: string): string => new URL(path, sitePrefix()).href;

export function sitePrefix(): string {
	return new URL(base === '' ? '.' : `${base}/`, document.baseURI).href;
}

// Concatenated, not new URL(): {fontstack}/{range} must survive for MapLibre's worker.
export function resolveSiteAsset(path: string): string {
	return `${sitePrefix().replace(/\/+$/, '')}/${path}`;
}

// A function: there is no document.baseURI during prerender.
export function siteStore(): ReadOnlyProjectStore {
	return createHttpProjectStore({ resolve: siteUrl });
}
