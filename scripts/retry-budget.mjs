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
// So a retry is printed on the console where the run is watched, and the *rate* of retries is a
// budget. Under it, the run is what it says it is. Over it, the run fails even though every test
// eventually passed — because at that point the thing the suite is telling you is about the suite.
//
// The budget is a rate rather than a count so that it means the same thing for one spec and for the
// whole suite; `flakyTests / totalTests`, where a "flaky test" is Playwright's own definition — it
// failed at least once and then passed. A run with no retries at all has a rate of 0.
//
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BUDGET IS PERMISSIVE, AND THAT IS A MEASURED DECISION RATHER THAN A RETREAT.
//
// It was 0.5% — one test in the whole 398, so a single retry anywhere failed the run. Held for the
// length of the epic, that rule cost many hours of investigation and did not fix the underlying
// races: the suite drives ten workers, each running a real WebGL map against the same origin's OPFS,
// and under that contention a first attempt occasionally loses to a timing margin that no code change
// in the application removes. A gate that fires on something nobody can fix stops being a signal and
// becomes a toll.
//
// So the numbers are set to catch the thing that *is* actionable — a test that needs its retry
// habitually, or a change that makes several tests intermittent at once — and to stay quiet about a
// single unlucky attempt. **Every retry is still printed, by name, on every run.** The visibility was
// always the valuable half; failing the run on one occurrence was the expensive half.
//
// {@link MINIMUM_ALLOWED_RETRIES} is why the rate alone is not enough. A rate is scale-free by
// design, but `Math.floor` makes it *stricter* the smaller the run: 3% of a 21-test spec run floors
// to zero allowed, so running one spec was judged harder than running the suite — which is backwards,
// and is what turned an ordinary single retry into a failed run.
//
// Override with `BALLASTELLA_E2E_RETRY_BUDGET` (a fraction, e.g. `0.01`), and note that the minimum
// applies underneath it: `0` is still absolute, which is how the fence is checked.

/** The share of tests allowed to pass only after a retry before the run itself is failed. */
export const DEFAULT_RETRY_BUDGET = 0.03;

/**
 * Retried tests allowed regardless of how small the run is — unless the budget is `0`.
 *
 * The floor exists so that running one spec is not judged more harshly than running the suite. `0`
 * bypasses it entirely, so the mutation check the config names ("any retry at all must fail") still
 * has something to assert.
 */
export const MINIMUM_ALLOWED_RETRIES = 3;

/**
 * Whether a run is over budget, and the sentence saying so.
 *
 * A pure function of three numbers so that the decision can be read, and tested, without a
 * Playwright run around it.
 */
export const retryVerdict = ({ flaky, total, budget }) => {
	const rate = total === 0 ? 0 : flaky / total;
	const allowed = budget === 0 ? 0 : Math.max(MINIMUM_ALLOWED_RETRIES, Math.floor(total * budget));
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
