export const DEFAULT_RETRY_BUDGET = 0.03;
export const MINIMUM_ALLOWED_RETRIES = 3;

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
		return { status: result.status === 'passed' ? 'failed' : result.status };
	}
}
