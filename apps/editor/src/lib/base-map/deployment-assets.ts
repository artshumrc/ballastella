import { base } from '$app/paths';

/**
 * Turn a deployment-relative asset path from the Base Map catalog into a URL MapLibre can use.
 *
 * Two constraints meet here.
 *
 * ADR-0006 forbids absolute asset paths outright: the publish target — a domain root or a project
 * subdirectory — is unknown at build time, and `paths.base` is baked in, so `paths.relative: true`
 * is mandatory and CI greps the built output for violations. So the path must go through `base`.
 *
 * MapLibre, meanwhile, hands the glyph and sprite URLs to workers and substitutes `{fontstack}`,
 * `{range}`, and `{flavor}` into them by plain string replacement. `new URL()` would percent-encode
 * those braces and the substitution would silently stop matching, leaving a map with no labels and
 * no error. So this concatenates onto an absolute *prefix* computed once, rather than resolving
 * each templated path as a URL.
 */
export function resolveDeploymentAsset(path: string): string {
	return `${assetPrefix()}/${path}`;
}

function assetPrefix(): string {
	// `base` is relative under `paths.relative: true` — '.' or '..' depending on the route depth —
	// so it needs resolving against the current document before it leaves for a worker.
	const prefix = new URL(base === '' ? '.' : `${base}/`, document.baseURI).href;
	return prefix.replace(/\/+$/, '');
}
