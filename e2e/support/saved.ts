// Waiting for the app to have *saved* something, rather than for it to look as though it has.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: "THE ROW IS ON SCREEN" AND "THE BYTES ARE ON DISK" ARE DIFFERENT CLAIMS.  │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Autosave writes `project.json` on a 400 ms debounce (ADR-0017 rule 2), so a Layer appears in the
// sidebar the moment the state changes and reaches storage some time afterwards. A helper that
// returned as soon as its row was visible and then reloaded the page was reading a Workspace the
// write had not reached yet — and the Layer was simply not there.
//
// Measured on `main` on 2026-08-07, ten consecutive full runs (ticket 17): this is the single
// largest source of the suite's flake. `editor-pwa.e2e.ts`'s "fully usable with the network off"
// failed in **3 of 10 runs** on it, twice as a 30 s timeout waiting for a Layer row that was never
// going to arrive and once as `TypeError: Cannot read properties of undefined` from
// `annotationLayerId`, which is the same absence read one line later. It passes in isolation every
// time, which is what made it look like contention: contention only widens the window.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// AND WHY NOT THE SAVE INDICATOR
//
// The obvious wait — `expect(page.getByRole('status')).toHaveText('Saved')` — is not one. The
// indicator's whole sequence is **`saved → unsaved → saving → saved`** (measured, and asserted in
// `editor-workspace.e2e.ts`; the three-state shape this file used to quote was wrong, and `unsaved`
// is the 400 ms debounce window the tool spends telling the user it has not written yet). So "Saved"
// is *also* what it reads before the save starts, and a poll that arrives in that first frame passes
// without waiting for anything. `SaveIndicator.svelte` additionally holds "Saving…" on screen for a
// minimum of 400 ms so it does not strobe, which means the text is a deliberately lagged rendering
// of the state and never a statement about storage.
//
// So these wait on the file. It is slower to ask and it is the only question with an answer.

import { expect, type Page } from './test.js';

import { PROJECT_DIRECTORY } from './annotations';
import { readStoredJsonOrNull } from './stored-file';

/**
 * `project.json` as it sits in OPFS, parsed — or `null` when it cannot be read right now.
 *
 * `null` rather than a throw because the callers below are inside `expect.poll`, where a file that is
 * mid-atomic-replace is a retry and not a failure. The retry itself is `stored-file.ts`.
 */
const storedProject = (page: Page, directory: string): Promise<{ layers?: unknown[] } | null> =>
	readStoredJsonOrNull<{ layers?: unknown[] }>(page, `${directory}/project.json`);

/**
 * Wait until `project.json` on disk holds `count` Layers.
 *
 * The settled state, and the one every caller actually depends on: what survives a reload is the
 * file, not the sidebar. Call it after the UI says the Layer is there and before anything that
 * restarts the app.
 */
export async function waitForStoredLayers(
	page: Page,
	count: number,
	directory = PROJECT_DIRECTORY
): Promise<void> {
	await expect
		.poll(async () => (await storedProject(page, directory))?.layers?.length ?? -1, {
			message: `project.json in ${directory} should hold ${count} Layers`
		})
		.toBe(count);
}

/**
 * Every value `[data-save-state]` takes from now on, in order, with no polling.
 *
 * The save indicator's contract is a *sequence* — `saved → unsaved → saving → saved` (ADR-0017
 * rule 5) — and the middle of it cannot be caught by asking repeatedly what the attribute says:
 * "Saving…" can be over in a few milliseconds, and two protocol round trips can straddle it
 * entirely. Asserting it that way is a test that fails when the machine is busy and says nothing
 * when it passes; it failed in 2 of the 10 baseline runs of 2026-08-07 with
 * `Expected "saving", Received "saved"`.
 *
 * A `MutationObserver` sees every change instead of sampling for them, so the claim becomes a record
 * of what happened rather than a race against it. Install it *before* the edit; read it afterwards.
 *
 * ⚠ **Read the result with `expect.poll`, not once.** The returned function answers "what has
 * happened so far", so calling it too early answers `['saved']` — truthfully, and uselessly. A
 * single read is the same one-shot mistake this helper exists to replace, one level up.
 *
 * @returns a function that returns the states recorded so far
 */
export async function recordSaveStates(page: Page): Promise<() => Promise<string[]>> {
	await page.evaluate(() => {
		const indicator = document.querySelector('[data-save-state]');
		if (!indicator) throw new Error('no [data-save-state] element to observe');
		const seen: string[] = [indicator.getAttribute('data-save-state') ?? ''];
		new MutationObserver(() => {
			const state = indicator.getAttribute('data-save-state') ?? '';
			if (state !== seen[seen.length - 1]) seen.push(state);
		}).observe(indicator, { attributes: true, attributeFilter: ['data-save-state'] });
		(window as unknown as { __saveStates?: string[] }).__saveStates = seen;
	});
	return () =>
		page.evaluate(() => (window as unknown as { __saveStates?: string[] }).__saveStates ?? []);
}
