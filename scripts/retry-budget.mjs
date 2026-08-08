// A Playwright reporter that makes a retry visible and refuses to call a retried run healthy.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: GREEN-AFTER-RETRY IS DATA, NOT SUCCESS.                                   │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// `retries` on CI turned every intermittent failure into a pass, so a suite that failed roughly one
// run in three reported green roughly every time. That is the shape of a harness that can absorb a
// genuine race indefinitely: the first attempt of a racing test fails, the second wins the race, and
// the only trace is a line in an HTML report nobody opens.
//
// So a retry is now printed on the console where the run is watched, and the *rate* of retries is a
// budget. Under it, the run is what it says it is. Over it, the run fails even though every test
// eventually passed — because at that point the thing the suite is telling you is about the suite.
//
// The budget is a rate rather than a count so that it means the same thing for one spec and for the
// whole suite; `flakyTests / totalTests`, where a "flaky test" is Playwright's own definition — it
// failed at least once and then passed. A run with no retries at all has a rate of 0.
//
// Override with `BALLASTELLA_E2E_RETRY_BUDGET` (a fraction, e.g. `0.01`). That is also how the fence
// is checked: set it to 0 on a suite with one known retry and this must fail the run.

/** The share of tests allowed to pass only after a retry before the run itself is failed. */
export const DEFAULT_RETRY_BUDGET = 0.005;

/**
 * Whether a run is over budget, and the sentence saying so.
 *
 * A pure function of three numbers so that the decision can be read, and tested, without a
 * Playwright run around it.
 */
export const retryVerdict = ({ flaky, total, budget }) => {
	const rate = total === 0 ? 0 : flaky / total;
	const allowed = Math.floor(total * budget);
	const overBudget = flaky > allowed;
	return {
		rate,
		allowed,
		overBudget,
		summary:
			`${flaky} of ${total} tests passed only after a retry ` +
			`(${(rate * 100).toFixed(2)}%, budget ${(budget * 100).toFixed(2)}% = ${allowed} test${allowed === 1 ? '' : 's'})`
	};
};

const budgetFromEnvironment = (environment) => {
	const raw = environment.BALLASTELLA_E2E_RETRY_BUDGET;
	if (raw === undefined || raw === '') return DEFAULT_RETRY_BUDGET;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		throw new Error(
			`BALLASTELLA_E2E_RETRY_BUDGET must be a fraction between 0 and 1, got ${JSON.stringify(raw)}`
		);
	}
	return parsed;
};

export default class RetryBudgetReporter {
	#budget = DEFAULT_RETRY_BUDGET;
	#total = 0;
	#retried = [];

	constructor(options = {}) {
		this.#budget = options.budget ?? budgetFromEnvironment(process.env);
	}

	onBegin(_config, suite) {
		this.#total = suite.allTests().length;
	}

	onTestEnd(test, result) {
		// `result.retry > 0` is the attempt *after* a failure, whatever it ended as. Printed as it
		// happens rather than only in the summary, because the summary is what scrolls past.
		if (result.retry > 0) {
			console.log(
				`  ↻ retry ${result.retry} of ${test.titlePath().slice(1).join(' › ')} — ${result.status}`
			);
		}
		if (test.outcome() === 'flaky' && result.retry > 0 && result.status === 'passed') {
			this.#retried.push(test);
		}
	}

	async onEnd(result) {
		const verdict = retryVerdict({
			flaky: this.#retried.length,
			total: this.#total,
			budget: this.#budget
		});
		console.log(`\nretry budget: ${verdict.summary}`);
		for (const test of this.#retried) {
			console.log(`  ↻ ${test.location.file}:${test.location.line} ${test.title}`);
		}
		if (!verdict.overBudget) return;
		console.log(
			'\nretry budget exceeded — this run is being failed even though every test eventually passed.\n' +
				'A test that passes on a second attempt is a test that can also fail on a first one for a\n' +
				'reason nobody has looked at. Fix the cause or state a new budget with a measurement.'
		);
		// `result.status` is left alone when the run already failed for a better reason.
		return { status: result.status === 'passed' ? 'failed' : result.status };
	}
}
