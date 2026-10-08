import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_RETRY_BUDGET, MINIMUM_ALLOWED_RETRIES, retryVerdict } from './retry-budget.mjs';

for (const { name, cases } of [
	{
		name: 'the default budget allows a handful of retried tests across the suite, not an epidemic',
		cases: [
			[0, 398, false],
			[11, 398, false],
			[12, 398, true]
		]
	},
	{
		name: 'running one spec is not judged more harshly than running the suite',
		cases: [
			[1, 21, false],
			[1, 71, false],
			[MINIMUM_ALLOWED_RETRIES + 1, 21, true]
		]
	},
	{
		name: 'an empty run has a rate of zero rather than a division by zero',
		cases: [[0, 0, false]]
	}
]) {
	test(name, () => {
		for (const [flaky, total, overBudget] of cases) {
			const verdict = retryVerdict({ flaky, total, budget: DEFAULT_RETRY_BUDGET });
			assert.equal(verdict.overBudget, overBudget, `${flaky} of ${total}`);
			if (flaky === 0) assert.equal(verdict.rate, 0);
		}
	});
}

test('a budget of zero refuses any retry at all — the mutation check the config names', () => {
	assert.equal(retryVerdict({ flaky: 0, total: 398, budget: 0 }).overBudget, false);
	assert.equal(retryVerdict({ flaky: 1, total: 398, budget: 0 }).overBudget, true);
	assert.equal(retryVerdict({ flaky: 0, total: 398, budget: 0 }).allowed, 0);
});

test('the summary states the rate and the budget it was judged against', () => {
	const { summary } = retryVerdict({ flaky: 2, total: 398, budget: DEFAULT_RETRY_BUDGET });
	assert.match(summary, /2 of 398/);
	assert.match(summary, /0\.50%/);
	assert.match(summary, /budget 3\.00% = 11 tests/);
});
