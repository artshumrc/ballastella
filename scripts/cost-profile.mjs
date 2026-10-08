import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';

const DEFAULT_PROFILE_PATH = 'docs/e2e-cost-profile.md';
const TESTS_LISTED_PER_SPEC = 5;
const seconds = (ms) => (ms / 1000).toFixed(1);
const perTest = (ms, count) => (count === 0 ? '0.00' : (ms / 1000 / count).toFixed(2));

export const profile = (tests) => {
	const bySpec = new Map();
	for (const { spec, title, ms, skipped = false } of tests) {
		const entry = bySpec.get(spec) ?? { spec, tests: [], ms: 0, skipped: 0 };
		if (skipped) entry.skipped += 1;
		else {
			entry.tests.push({ title, ms });
			entry.ms += ms;
		}
		bySpec.set(spec, entry);
	}
	const specs = [...bySpec.values()]
		.map((entry) => ({
			...entry,
			count: entry.tests.length,
			tests: [...entry.tests].sort((a, b) => b.ms - a.ms)
		}))
		.sort((a, b) => b.ms - a.ms);
	return {
		specs,
		totalMs: specs.reduce((sum, entry) => sum + entry.ms, 0),
		totalTests: specs.reduce((sum, entry) => sum + entry.count, 0),
		totalSkipped: specs.reduce((sum, entry) => sum + entry.skipped, 0)
	};
};

const WHOLE_SUITE_ARGUMENTS =
	/^(--headed|--debug|--quiet|--workers(=|$)|--retries(=|$)|--timeout(=|$)|--trace(=|$)|--output(=|$)|--reporter(=|$))/;

export const isWholeSuite = (command) =>
	command
		.split(/\s+/)
		.slice(3)
		.filter(Boolean)
		.every((argument) => WHOLE_SUITE_ARGUMENTS.test(argument));

export const profileMarkdown = ({ specs, totalMs, totalTests, totalSkipped = 0 }, run) => {
	const lines = [
		'# Seam 2 cost profile',
		'',
		'⚠ **Generated. Do not edit by hand** — regenerate with `pnpm test:e2e --profile`',
		`(\`scripts/cost-profile.mjs\`), which appends a reporter rather than replacing the list, so a`,
		'profiled run keeps the retry budget and gives the gate’s verdict.',
		'',
		'**Worker-seconds, not wall time.** A test’s cost is the time a worker spent inside it, summed',
		'over every attempt. That is what moving the claim to another seam actually removes; wall time',
		'depends on how the scheduler packed the run.',
		'',
		`| Run | ${run.when} |`,
		'| --- | --- |',
		`| Command | \`${run.command}\` |`,
		`| Tests | ${totalTests} |`,
		...(totalSkipped > 0 ? [`| Skipped (not counted above) | ${totalSkipped} |`] : []),
		`| Workers | ${run.workers} |`,
		`| Wall clock | ${seconds(run.wallMs)}s |`,
		`| Worker-seconds | ${seconds(totalMs)}s |`,
		'',
		'| Spec | Tests | Worker-seconds | Per test |',
		'| --- | ---: | ---: | ---: |'
	];
	for (const entry of specs) {
		lines.push(
			`| \`${entry.spec}\` | ${entry.count} | ${seconds(entry.ms)} | ${perTest(entry.ms, entry.count)} |`
		);
	}
	lines.push(
		`| **total** | **${totalTests}** | **${seconds(totalMs)}** | **${perTest(totalMs, totalTests)}** |`,
		'',
		`## The ${TESTS_LISTED_PER_SPEC} costliest tests in each spec`,
		''
	);
	for (const entry of specs) {
		lines.push(`### \`${entry.spec}\` — ${seconds(entry.ms)}s over ${entry.count} tests`, '');
		for (const item of entry.tests.slice(0, TESTS_LISTED_PER_SPEC)) {
			lines.push(`- ${seconds(item.ms)}s — ${item.title}`);
		}
		lines.push('');
	}
	return lines.join('\n');
};

export default class CostProfileReporter {
	#tests = new Map();
	#startedAt = Date.now();
	#workers = 0;
	#root = process.cwd();
	#path;
	#pathWasChosen;

	constructor(options = {}) {
		const chosen = options.path ?? process.env.BALLASTELLA_E2E_PROFILE_PATH;
		this.#path = chosen ?? DEFAULT_PROFILE_PATH;
		this.#pathWasChosen = chosen !== undefined;
	}

	onBegin(config) {
		this.#startedAt = Date.now();
		this.#workers = config.workers;
	}

	onTestEnd(test, result) {
		const key = test.id;
		const entry = this.#tests.get(key) ?? {
			spec: relative(this.#root, test.location.file),
			title: test.titlePath().slice(1).filter(Boolean).join(' › '),
			ms: 0,
			skipped: true
		};
		entry.ms += result.duration;
		entry.skipped &&= result.status === 'skipped';
		this.#tests.set(key, entry);
	}

	async onEnd() {
		const rolled = profile([...this.#tests.values()]);
		const command = process.env.BALLASTELLA_E2E_PROFILE_COMMAND ?? 'pnpm test:e2e --profile';
		const markdown = profileMarkdown(rolled, {
			when: new Date().toISOString().slice(0, 10),
			command,
			workers: this.#workers,
			wallMs: Date.now() - this.#startedAt
		});

		const refused = !this.#pathWasChosen && !isWholeSuite(command);
		if (!refused) {
			const out = resolve(this.#root, this.#path);
			mkdirSync(dirname(out), { recursive: true });
			writeFileSync(out, `${markdown}\n`);
		}

		console.log(
			`\ncost profile: ${seconds(rolled.totalMs)}s of worker time over ${rolled.totalTests} tests ` +
				`(${perTest(rolled.totalMs, rolled.totalTests)}s each)`
		);
		for (const entry of rolled.specs.slice(0, 10)) {
			console.log(
				`  ${seconds(entry.ms).padStart(8)}s  ${perTest(entry.ms, entry.count).padStart(6)}s/test  ` +
					`${String(entry.count).padStart(3)} tests  ${entry.spec}`
			);
		}
		if (refused)
			console.log(
				`not written: \`${command}\` profiled part of the suite, and ${DEFAULT_PROFILE_PATH}\n` +
					`is the whole suite's table. Name a file for this one:\n` +
					`  BALLASTELLA_E2E_PROFILE_PATH=/tmp/profile.md ${command}`
			);
		else console.log(`written to ${this.#path}`);
	}
}
