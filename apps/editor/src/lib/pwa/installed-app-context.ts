// The refusal behind `useInstalledApp()`, in a module a Node test can import.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ SPLIT OUT SO THE GUARD HAS A TEST. NOT A SEAM ANYBODY WANTED — A BUILD SETTING FORCED IT.  │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// This is three lines that belong in `installed-app.svelte.ts` beside `useInstalledApp`, and it is
// here for one reason: nothing could reach it.
//
//   * **Not from a Node test.** `installed-app.svelte.ts` imports `$lib/base-map/deployment-assets`,
//     which imports `$app/paths` — SvelteKit's own virtual module. `apps/editor`'s vitest project
//     runs plain Node with no `@sveltejs/kit/vite` plugin (deliberately; see `vitest.config.ts`), so
//     importing that file fails to resolve. Aliasing `$lib` was tried and gets one import further
//     before landing on `$app/paths`, which cannot be aliased to anything honest.
//   * **Not from a browser test.** The guard fires only for a component mounted outside the root
//     layout, and every route in this application is under it. There is no such page to drive.
//
// So the `if` was deletable with the whole suite green — which is exactly the shape of untested
// safety this ticket's review keeps finding. A function of one argument fixes that for the cost of
// one file and this note.
//
// `import type`, so the class never loads at runtime and this module drags in no `$lib` of its own.

import type { InstalledApp } from './installed-app.svelte.js';

/**
 * The one {@link InstalledApp}, or a refusal saying which mistake was made.
 *
 * **Not a fallback to a fresh `InstalledApp`**, which is the tempting repair and the wrong one: that
 * is a second pair of `online`/`offline` listeners, banned outright by ticket 07's out-of-scope list,
 * and two answers to "is there a connection" is how a pane and a Layer card come to disagree in
 * front of a scholar.
 *
 * This became worth having in ticket 07: `MapImagePane` reads `.online` in its load effect now
 * — on the component that ticket deliberately made reusable — so what used to be a harmless
 * `undefined` became `Cannot read properties of undefined (reading 'online')` thrown from inside an
 * effect, naming nothing.
 */
export function installedAppOr(app: InstalledApp | undefined): InstalledApp {
	if (!app) {
		throw new Error(
			'useInstalledApp() was called with no InstalledApp in context. It is provided once, by the ' +
				'root layout, and every route is under that layout — so this is a component mounted ' +
				'outside it. Mount it under the root layout rather than creating a second InstalledApp: ' +
				'a second one is a second pair of online/offline listeners.'
		);
	}
	return app;
}
