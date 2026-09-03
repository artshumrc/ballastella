import { base } from '$app/paths';
import {
	createHttpProjectStore,
	type Bytes,
	type ReadOnlyProjectStore,
	type StorePath
} from '@ballastella/core';

/**
 * A file of the Published Site, by its Workspace-relative path, as a URL this page can fetch.
 *
 * ADR-0045's relative-path rule is the whole of why this exists. One build has to serve a domain root *and* a project
 * subdirectory — `username.github.io/some-repo/` — and which one is unknown when the viewer is
 * built, so `paths.relative: true` is mandatory and no asset may be referenced by an absolute path.
 * The same rule applies to the *data*: `ballastella-site.json` and every `project.json` sit beside
 * `index.html` in the Workspace, and reaching them by `/ballastella-site.json` would work at a
 * domain root and 404 in a subdirectory — the GitHub Pages case, which is the one students use.
 *
 * Resolved against `document.baseURI` rather than left as a bare relative string, because these
 * URLs are handed to `fetch` from an effect that may run after a client-side navigation to `?p=`,
 * and a relative path resolved against a URL carrying a query is a different thing to reason about
 * than one resolved against the document's base. Same shape as the editor's
 * `resolveDeploymentAsset`, and for the same reason.
 */
export function siteUrl(path: string): string {
	return new URL(path, sitePrefix()).href;
}

/**
 * The site's own address, with a trailing slash: the document's base, plus `paths.base`.
 *
 * Two callers, and they want it for different reasons. `siteUrl` resolves data paths against it, and
 * the Base Map's Reader preference is keyed on it so that two Published Sites on one origin do not
 * share a choice (ADR-0020) — a department domain with a folder per student is the ordinary case.
 */
export function sitePrefix(): string {
	return new URL(base === '' ? '.' : `${base}/`, document.baseURI).href;
}

/**
 * A deployment-relative asset of the Published Site — the Base Map's pmtiles archive, its glyphs, and
 * its sprites — as a URL MapLibre can be given.
 *
 * Separate from {@link siteUrl}, and the difference is not cosmetic. MapLibre hands the glyph and
 * sprite URLs to workers and substitutes `{fontstack}`, `{range}`, and `{flavor}` into them by plain
 * string replacement, so `new URL()` would percent-encode those braces and the substitution would
 * silently stop matching — a Base Map with no labels and no error. This concatenates onto an absolute
 * prefix instead. Exactly the editor's `resolveDeploymentAsset`, for exactly that reason.
 */
export function resolveSiteAsset(path: string): string {
	return `${sitePrefix().replace(/\/+$/, '')}/${path}`;
}

/**
 * The Published Site as a {@link ReadOnlyProjectStore}: ADR-0045's HTTP adapter, wired to this
 * document's own base.
 *
 * **This is the viewer's only way to bytes, and it is read-only by type.** Everything a Reader sees —
 * the site record, every `project.json`, every Alignment, every Annotation Layer, every `info.json`,
 * and every tile through ADR-0011's shim — comes through here. There is no second data path and
 * nothing in this app can write, because `createHttpProjectStore` returns an object whose only method
 * is `read`: this app has no store `write` at all.
 *
 * A function rather than a module-level constant: `document.baseURI` does not exist while this app is
 * being prerendered, and a store built at import time would be built against nothing.
 */
export function siteStore(): ReadOnlyProjectStore {
	return createHttpProjectStore({ resolve: (path: StorePath) => siteUrl(path) });
}

/**
 * The bytes at a Published Site path.
 *
 * Bytes rather than parsed JSON, because core's parsers take bytes: they are the same functions the
 * editor uses, and a `project.json` a Reader is shown must be read by exactly the code that wrote
 * it or the two can disagree about what a Layer is.
 *
 * Through the store rather than through its own `fetch`, so that a 404 is a `PathNotFoundError` and a
 * host that is not answering is a `SiteFileUnreachableError` — the distinction the Reader's
 * degradation notices rest on, which a single sentence about a status code would flatten.
 */
export async function readSiteFile(path: string): Promise<Bytes> {
	return siteStore().read(path);
}
