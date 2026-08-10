// The retry budget's decision, pinned away from a Playwright run.
//
// The reporter half is exercised for real by running the suite with `BALLASTELLA_E2E_RETRY_BUDGET=0`
// and watching it fail — see `playwright.config.ts`. This is the arithmetic underneath it, which is
// where an off-by-one would make the fence permissive without making it silent.

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RETRY_BUDGET, MINIMUM_ALLOWED_RETRIES, retryVerdict } from './retry-budget.mjs';

test('a run with no retries is under any budget', () => {
	const verdict = retryVerdict({ flaky: 0, total: 398, budget: DEFAULT_RETRY_BUDGET });
	assert.equal(verdict.rate, 0);
	assert.equal(verdict.overBudget, false);
});

test('the default budget allows a handful of retried tests across the suite, not an epidemic', () => {
	// 3% of 398 is 11.94, floored to 11. The floor keeps the budget a whole number of tests, and the
	// direction it rounds is the one that fails sooner.
	assert.equal(
		retryVerdict({ flaky: 11, total: 398, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		false
	);
	assert.equal(
		retryVerdict({ flaky: 12, total: 398, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		true
	);
});

test('a budget of zero refuses any retry at all — the mutation check the config names', () => {
	// And it is *not* softened by the minimum: an explicit zero is the one absolute setting, which is
	// what makes it usable as a fence.
	assert.equal(retryVerdict({ flaky: 0, total: 398, budget: 0 }).overBudget, false);
	assert.equal(retryVerdict({ flaky: 1, total: 398, budget: 0 }).overBudget, true);
	assert.equal(retryVerdict({ flaky: 0, total: 398, budget: 0 }).allowed, 0);
});

test('running one spec is not judged more harshly than running the suite', () => {
	// ⚠ The reason the minimum exists. A rate is scale-free, but `Math.floor` is not: 3% of a 21-test
	// run floors to 0, so before this a single retry in one spec failed a run that the same retry
	// would not have failed across 398 tests. That is backwards, and it is the case that was actually
	// hit — 1 of 71 tests, on a run of three specs.
	assert.equal(
		retryVerdict({ flaky: 1, total: 21, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		false
	);
	assert.equal(
		retryVerdict({ flaky: 1, total: 71, budget: DEFAULT_RETRY_BUDGET }).overBudget,
		false
	);
	// The floor is a floor, not a licence: past it, a small run fails like any other.
	assert.equal(
		retryVerdict({
			flaky: MINIMUM_ALLOWED_RETRIES + 1,
			total: 21,
			budget: DEFAULT_RETRY_BUDGET
		}).overBudget,
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
	assert.match(summary, /budget 3\.00% = 11 tests/);
});
