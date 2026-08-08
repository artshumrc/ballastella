// The retry budget's decision, pinned away from a Playwright run.
//
// The reporter half is exercised for real by running the suite with `BALLASTELLA_E2E_RETRY_BUDGET=0`
// and watching it fail — see `playwright.config.ts`. This is the arithmetic underneath it, which is
// where an off-by-one would make the fence permissive without making it silent.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RETRY_BUDGET, retryVerdict } from './retry-budget.mjs';

test('a run with no retries is under any budget', () => {
	const verdict = retryVerdict({ flaky: 0, total: 398, budget: DEFAULT_RETRY_BUDGET });
	assert.equal(verdict.rate, 0);
	assert.equal(verdict.overBudget, false);
});

test('the default budget allows one retried test in the whole suite and no more', () => {
	// 0.5% of 398 is 1.99, floored to 1. The floor is what makes the budget a whole number of tests
	// rather than a fraction of one, and it is the direction that fails sooner.
	assert.equal(
		retryVerdict({ flaky: 1, total: 398, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		false
	);
	assert.equal(
		retryVerdict({ flaky: 2, total: 398, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		true
	);
});

test('a budget of zero refuses any retry at all — the mutation check the config names', () => {
	assert.equal(retryVerdict({ flaky: 0, total: 398, budget: 0 }).overBudget, false);
	assert.equal(retryVerdict({ flaky: 1, total: 398, budget: 0 }).overBudget, true);
});

test('running one spec is judged by the same rate as running the suite', () => {
	// The reason the fence is a rate and not a count: `playwright test e2e/editor-pwa.e2e.ts` is a
	// run of about twenty tests, and a fixed count of allowed retries would be far more permissive
	// there than across 398.
	assert.equal(
		retryVerdict({ flaky: 1, total: 20, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		true
	);
});

test('an empty run has a rate of zero rather than a division by zero', () => {
	const verdict = retryVerdict({ flaky: 0, total: 0, budget: DEFAULT_RETRY_BUDGET });
	assert.equal(verdict.rate, 0);
	assert.equal(verdict.overBudget, false);
});

test('the summary states the rate and the budget it was judged against', () => {
	const { summary } = retryVerdict({ flaky: 2, total: 398, budget: DEFAULT_RETRY_BUDGET });
	assert.match(summary, /2 of 398/);
	assert.match(summary, /0\.50%/);
	assert.match(summary, /budget 0\.50% = 1 test/);
});
