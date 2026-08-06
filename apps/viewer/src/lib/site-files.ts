import { base } from '$app/paths';

/**
 * A file of the Published Site, by its Workspace-relative path, as a URL this page can fetch.
 *
 * ADR-0006 is the whole of why this exists. One build has to serve a domain root *and* a project
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
	const prefix = new URL(base === '' ? '.' : `${base}/`, document.baseURI);
	return new URL(path, prefix).href;
}

/**
 * The bytes at a Published Site path.
 *
 * Bytes rather than parsed JSON, because core's parsers take bytes: they are the same functions the
 * editor uses, and a `project.json` a Reader is shown must be read by exactly the code that wrote
 * it or the two can disagree about what a Layer is.
 *
 * A missing file is a `Response` with a status, not a rejection, so this raises one deliberately —
 * a static host answers a wrong `?p=` with 404 and an HTML error page, and `JSON.parse` on that
 * would blame the file's contents for a URL problem.
 */
export async function readSiteFile(path: string): Promise<Uint8Array> {
	const response = await fetch(siteUrl(path), { cache: 'no-cache' });
	if (!response.ok) {
		throw new Error(`${path} is not on this site (the server answered ${response.status}).`);
	}
	return new Uint8Array(await response.arrayBuffer());
}
