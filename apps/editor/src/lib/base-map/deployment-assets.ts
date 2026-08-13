import { base } from '$app/paths';

/**
 * Turn a deployment-relative asset path — the Base Map catalog's, and the staged viewer bundle's
 * (`$lib/publish/viewer-bundle-source`) — into a URL that can be fetched or handed to MapLibre.
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

/**
 * Where this deployment of the editor lives, with a trailing slash.
 *
 * Recorded into a Published Site at publish time, so that the site's Front Page can lead a Reader
 * back to the instance that made it (SPEC stories 51 and 55). Nothing is configured and nothing is
 * asked: `location.origin` plus this app's base path is the whole of what an instance's address is,
 * and it is knowledge only the app has — `packages/core` must not read `location` (ADR-0006).
 *
 * Absolute, unlike everything else this module produces, because it is the one address that has to
 * mean something on **another origin**: the Published Site is a different host under ADR-0032.
 *
 * ⚠ **This is `location.origin`, which is often not an address a Reader could reach** — a `pnpm dev`
 * server, or an instance inside an institution's network. Publishing does not record such an address:
 * `parseEditorUrl` in `packages/core/src/publish/publish.ts` refuses loopback and single-label hosts,
 * where the reasoning is written out, and the site degrades to carrying no return link at all.
 */
export function deploymentRoot(): string {
	return `${assetPrefix()}/`;
}

function assetPrefix(): string {
	// `base` is relative under `paths.relative: true` — '.' or '..' depending on the route depth —
	// so it needs resolving against the current document before it leaves for a worker.
	const prefix = new URL(base === '' ? '.' : `${base}/`, document.baseURI).href;
	return prefix.replace(/\/+$/, '');
}
