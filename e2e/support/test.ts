// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE SUITE'S ONE `test`. Every `*.e2e.ts` file imports it from here and from nowhere else.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// Two fixtures have to be true of every test in this suite, and they arrived from different
// directions:
//
//   1. **No test may reach the network** — a recorded decision by the repository owner, built into
//      the `context` fixture by `network-fence.ts`.
//   2. **A Workspace is a *named directory* in the OPFS root** (ticket 12, ADR-0024), so a
//      `page.evaluate` that wants Workspace files can no longer treat `getDirectory()` as one.
//
// **They are composed here rather than chosen between.** Each was written as its own
// `base.extend(…)` of `@playwright/test`, and two roots is a suite where a spec gets whichever its
// author imported: the fence without `workspaceRoot()`, or `workspaceRoot()` reaching the network.
// So `network-fence.ts` stays the fence *layer* — it is the interesting one, it is where the
// measurement and the reasoning live, and it is separately testable — and this module extends it.
// One import, both guarantees, and a layer that can still be read on its own.
//
// `scripts/check-e2e-network-fence.mjs` enforces both halves: a spec must take `test` from here,
// never from `@playwright/test` and never from `network-fence.js` directly, and **this file must
// itself build on the fence** — otherwise the composition could be quietly unpicked and every spec
// would still pass the import check while reaching the network.

import { test as fenced } from './network-fence.js';
import { expect } from '@playwright/test';

/**
 * The name the editor gives a first visit's Workspace — `DEFAULT_WORKSPACE_NAME` in
 * `@ballastella/core`.
 *
 * Spelled out rather than imported: this file is compiled by the workspace-level `tsconfig.json`,
 * which covers `e2e/` alone and has no path to the packages. A rename that missed this would fail
 * loudly and immediately — every spec that seeds a Project would find an empty hub — rather than
 * quietly, so a literal is an acceptable cost here in a way it is not inside the app.
 */
export const DEFAULT_WORKSPACE = 'My Workspace';

/**
 * Where the editor remembers which named Workspace is open. `workspace-storage.svelte.ts`'s key.
 *
 * Read by the init script below so that `workspaceRoot()` follows the app rather than guessing. It
 * is one string, and reading it is what makes "the current Workspace" a true description instead of
 * a hopeful one — see the note on {@link WORKSPACE_ROOT_SCRIPT}.
 */
const OPEN_WORKSPACE_KEY = 'ballastella.workspace';

/**
 * The two functions the page gets, installed before any of its own script runs.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THE PAGE GETS A FUNCTION AND NOT SEVENTY COPIES OF ONE FACT
 *
 * Some seventy `page.evaluate` bodies across this suite reached for
 * `navigator.storage.getDirectory()` and treated what came back as the Workspace. Since ticket 12
 * the root *holds* Workspaces and is not one, so each of those would otherwise have grown its own
 * `getDirectoryHandle(…)` — which is how a suite ends up half seeding the wrong place and staying
 * green. **The root itself is still reachable and still spelled
 * `navigator.storage.getDirectory()`**, which is what the "empty everything" helpers and the tests
 * *about* several Workspaces mean; the distinction is real now and the suite says which it means.
 *
 * ⚠ **`workspaceRoot()` creates, and `workspaceRootIfAny()` does not.** Creating is right for the
 * seeding and reading that almost every caller does — the app creates the directory on load anyway,
 * so a helper that refused would be stricter than the product. It is wrong for exactly one
 * question: "is this Workspace gone?" A creating helper answers that with an empty directory, which
 * is indistinguishable from a Workspace that is there and empty, so a deletion test asserted
 * against it would pass whether or not anything was deleted. That question takes the other one.
 *
 * ⚠ **Which Workspace it is follows the app.** It reads the editor's own `localStorage` key rather
 * than assuming {@link DEFAULT_WORKSPACE}, so a spec that has switched Workspaces still reads the
 * one it is looking at. Assuming the default was wrong the moment `switchToWorkspace` existed, and
 * wrong in the quiet direction: the read would succeed, against the wrong Workspace.
 */
const WORKSPACE_ROOT_SCRIPT = ({ fallback, key }: { fallback: string; key: string }): void => {
	const currentName = (): string => {
		try {
			return localStorage.getItem(key) || fallback;
		} catch {
			// A context with no storage still has a Workspace; it is simply always the default one.
			return fallback;
		}
	};
	const define = (name: string, value: unknown) =>
		Object.defineProperty(globalThis, name, { configurable: true, value });

	define('workspaceRoot', async () =>
		(await navigator.storage.getDirectory()).getDirectoryHandle(currentName(), { create: true })
	);
	define('workspaceRootIfAny', async () => {
		try {
			return await (await navigator.storage.getDirectory()).getDirectoryHandle(currentName());
		} catch {
			return null;
		}
	});
};

/**
 * `test` for this suite: the network fence, plus `workspaceRoot()` inside every `page.evaluate`.
 *
 * Import this in every spec. Nothing else is behind both fixtures.
 */
export const test = fenced.extend({
	page: async ({ page }, use) => {
		// The function closes over nothing, which is what lets Playwright serialise it into the page.
		await page.addInitScript(WORKSPACE_ROOT_SCRIPT, {
			fallback: DEFAULT_WORKSPACE,
			key: OPEN_WORKSPACE_KEY
		});
		await use(page);
	}
});

export { expect };
export type { ExternalAllowance } from './network-fence.js';
export type {
	BrowserContext,
	Locator,
	Page,
	Request,
	Response,
	Route,
	TestInfo
} from '@playwright/test';
