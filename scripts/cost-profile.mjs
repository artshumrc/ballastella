// A Playwright reporter that answers "which specs cost the most, and which tests inside them".
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY WORKER-SECONDS AND NOT WALL TIME.                                                      │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// Wall time is a property of how the scheduler happened to pack a run: four workers, files of
// wildly different sizes, and a machine that is not the run's alone. Move a spec's claims one seam
// down and the wall time may barely move, because the workers simply pick up other work sooner.
// What a migration actually removes is **worker-seconds** — the time a worker spent inside that
// test, summed over every attempt, retries included, because a retry is time the run really paid.
//
// So the profile ranks by worker-seconds, reports the per-test average that decides which file is
// worth attacking next, and prints the suite total so a later migration can state the fraction it
// removed. Every estimate that has come out wrong here came from generalising a partial measurement,
// which is why the output records the test count and wall clock of the run it came from: a table written
// by one spec's run is visibly one spec's run rather than a suite profile.
//
// The reporter is additive — `playwright.config.ts` appends it to the reporter list rather than
// replacing it — so a profiled run keeps the retry budget and gives the same verdict as the gate.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';

/** Where the committed table lands unless the caller names somewhere else. */
export const DEFAULT_PROFILE_PATH = 'docs/e2e-cost-profile.md';

/** Individual tests listed per spec in the committed table. */
export const TESTS_LISTED_PER_SPEC = 5;

const seconds = (ms) => (ms / 1000).toFixed(1);

/**
 * Worker-seconds per test, to two decimals. The single place this division happens: a second copy of
 * it could drift from the table and no test would notice.
 */
export const perTest = (ms, count) => (count === 0 ? '0.00' : (ms / 1000 / count).toFixed(2));

/**
 * Roll per-test measurements up into the ranked shape the table is printed from.
 *
 * A pure function of a list of `{ spec, title, ms, skipped }` so that the arithmetic can be read and
 * tested without a Playwright run around it. `ms` is already summed over a test's attempts by the
 * caller.
 *
 * A skipped test costs a worker nothing but would still occupy a slot in the denominator, so every
 * spec carrying a skip would read cheaper per test than it is. Skips are counted on the side instead.
 */
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

/**
 * Playwright arguments that leave the run's *membership* alone. Anything else — a spec name, `--grep`,
 * `--project`, `--shard` — profiles a subset, and a subset must not be written over the committed
 * suite table. Unknown flags count as filtering: guessing wrong in that direction only costs a file
 * the caller can still ask for by name.
 */
const WHOLE_SUITE_ARGUMENTS =
	/^(--headed|--debug|--quiet|--workers(=|$)|--retries(=|$)|--timeout(=|$)|--trace(=|$)|--output(=|$)|--reporter(=|$))/;

/** Did this run measure the whole suite, or a slice of it? Read from the command `e2e.mjs` recorded. */
export const isWholeSuite = (command) =>
	command
		.split(/\s+/)
		.slice(3) // `pnpm test:e2e --profile`
		.filter(Boolean)
		.every((argument) => WHOLE_SUITE_ARGUMENTS.test(argument));

/** The committed Markdown: a ranked spec table, then the worst tests inside each spec. */
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
	// Specs are named relative to the repository root, which is where the suite is always run from,
	// so a row reads `e2e/…` rather than as a bare filename. `config.rootDir` is the *test* directory
	// and would drop that prefix.
	#root = process.cwd();
	#path;
	// A path the caller named is written wherever it points; the committed one is defended below.
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
		// Summed rather than replaced: a retried test cost the run both attempts.
		entry.ms += result.duration;
		// Only a test skipped on *every* attempt is a skip. A runtime `test.skip(condition)` still
		// records a duration — small, but not zero — so the status is what decides this, not the clock.
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

		// The committed table is what every later migration targets by, and a filtered run would replace
		// the whole suite's rows with its own handful. Such a run has to name its own file.
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
