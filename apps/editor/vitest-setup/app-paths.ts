// SvelteKit's `$app/paths`, for the `editor-dom` project, which does not run under SvelteKit.
//
// SvelteKit generates this module at build time, so a component that reaches it cannot be mounted
// without it. Two do, by different routes: `AnnotationLayerContents` imports `base` three modules
// down, through `PlaceSearch`'s attribution assets, and `ProjectHub` imports `resolve` to build the
// links on its cards.
//
// ⚠ **Every value here is the empty-base one, and that is a statement about what this seam may
// assert rather than a convenience.** `base` is the deployment prefix. This app is prerendered at
// `base: ''` (`svelte.config.js`), so `resolve` really does return the route id unchanged and that
// is what is reproduced. What none of it reproduces is a deployment *under* a base path — and a
// Published Site's relative paths resolving in a subdirectory is precisely the claim
// `vitest.config.ts` records as belonging to `e2e/`, where there is a real server at two real paths.
// So an `href` read out of a component here says only that the component asked for the route it
// meant to; anything asserted about the prefix would be asserted against this file.

export const base = '';
export const assets = '';

/** The route id, unchanged: `base` is `''` for this app. */
export const resolve = (path: string): string => path;

export const asset = (path: string): string => path;
