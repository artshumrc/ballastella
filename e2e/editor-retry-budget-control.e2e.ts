import { expect, test } from '@playwright/test';

// The positive control for the retry budget in `playwright.config.ts`.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ A FENCE WITH NO POSITIVE CONTROL IS A FENCE NOBODY HAS SEEN WORK.                          │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// This repository has shipped a fence that printed its success message unconditionally, and this
// epic has repeatedly shipped criteria that passed vacuously. `scripts/retry-budget.mjs` is exactly
// the kind that could: it only ever *fails* a run, so a run that never retries proves nothing about
// it, and every healthy run is a run that never retries.
//
// So the escape is written out and checked in. This test fails its first attempt and passes its
// retry — the "green after a retry" the budget exists to notice — and the two commands below are the
// whole of the check. Run them after changing anything in `retry-budget.mjs`:
//
//   BALLASTELLA_E2E_RETRY_CONTROL=1 BALLASTELLA_E2E_RETRY_BUDGET=0 \
//     pnpm exec playwright test e2e/editor-retry-budget-control.e2e.ts    → must exit 1
//   BALLASTELLA_E2E_RETRY_CONTROL=1 BALLASTELLA_E2E_RETRY_BUDGET=1 \
//     pnpm exec playwright test e2e/editor-retry-budget-control.e2e.ts    → must exit 0
//
// The second is not decoration: without the reporter Playwright exits 0 for a flaky run, so it is
// the run that shows the first one was failed *by the budget* and not by the test.
//
// Skipped in an ordinary run, deliberately. Left live it would spend the suite's entire retry budget
// on itself, which is the fence disabling the fence.
//
// `testInfo.retry` rather than a counter in this module: Playwright starts a fresh worker after a
// failure, so module state does not survive to the second attempt and a counter would fail twice.
test('a test that only passes on its retry is counted against the budget', async ({
	page
}, testInfo) => {
	test.skip(
		process.env.BALLASTELLA_E2E_RETRY_CONTROL !== '1',
		'the retry-budget positive control; see the header of this file for the two commands'
	);
	await page.goto('./');
	expect(testInfo.retry, 'the first attempt fails on purpose').toBeGreaterThan(0);
});
