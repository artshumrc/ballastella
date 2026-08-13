// The cost profile's arithmetic, pinned away from a Playwright run.
//
// The reporter half is exercised by running the suite with `--profile` and reading the table it
// writes. This is the rollup underneath it, which is where a wrong denominator would produce a
// confident per-test figure that sends a later ticket at the wrong file.

import assert from 'node:assert/strict';
import test from 'node:test';

import { isWholeSuite, profile, profileMarkdown } from './cost-profile.mjs';

const run = (overrides = {}) => ({
	when: '2026-08-13',
	command: 'pnpm test:e2e --profile',
	workers: 4,
	wallMs: 30_000,
	...overrides
});

// The per-test figure is asserted through the table rather than through a field on the rollup, because
// the table is what a later ticket reads: a field nothing prints can drift from it with the suite green.
const row = (markdown, spec) =>
	markdown.split('\n').find((line) => line.startsWith(`| \`${spec}\``));

test('a spec costs the sum of its tests, and ranks by that rather than by count', () => {
	const rolled = profile([
		{ spec: 'e2e/cheap.e2e.ts', title: 'a', ms: 100 },
		{ spec: 'e2e/cheap.e2e.ts', title: 'b', ms: 100 },
		{ spec: 'e2e/cheap.e2e.ts', title: 'c', ms: 100 },
		{ spec: 'e2e/dear.e2e.ts', title: 'd', ms: 1000 }
	]);
	assert.deepEqual(
		rolled.specs.map((entry) => entry.spec),
		['e2e/dear.e2e.ts', 'e2e/cheap.e2e.ts']
	);
	assert.equal(rolled.totalMs, 1300);
	assert.equal(rolled.totalTests, 4);

	const markdown = profileMarkdown(rolled, run());
	assert.equal(row(markdown, 'e2e/dear.e2e.ts'), '| `e2e/dear.e2e.ts` | 1 | 1.0 | 1.00 |');
	assert.equal(row(markdown, 'e2e/cheap.e2e.ts'), '| `e2e/cheap.e2e.ts` | 3 | 0.3 | 0.10 |');
	assert.match(markdown, /\| \*\*total\*\* \| \*\*4\*\* \| \*\*1\.3\*\* \| \*\*0\.33\*\* \|/);
});

test('a test that was retried costs the run both attempts', () => {
	// The caller sums a test's attempts before this point; what matters here is that the retried test
	// is one test in the denominator, not two, so its per-test cost reads as high rather than average.
	const rolled = profile([{ spec: 'e2e/flaky.e2e.ts', title: 'a', ms: 8000 }]);
	assert.equal(rolled.specs[0].count, 1);
	assert.equal(
		row(profileMarkdown(rolled, run()), 'e2e/flaky.e2e.ts'),
		'| `e2e/flaky.e2e.ts` | 1 | 8.0 | 8.00 |'
	);
});

test('a skipped test is not a cheap test, so it stays out of the denominator', () => {
	const rolled = profile([
		{ spec: 'e2e/some-skips.e2e.ts', title: 'ran', ms: 4000 },
		// A runtime `test.skip(condition)` records a small duration rather than none at all.
		{ spec: 'e2e/some-skips.e2e.ts', title: 'skipped', ms: 90, skipped: true }
	]);
	assert.equal(rolled.totalTests, 1);
	assert.equal(rolled.totalSkipped, 1);
	assert.equal(rolled.totalMs, 4000);
	const markdown = profileMarkdown(rolled, run());
	// 4.00 rather than the 2.00 a counted skip would have printed.
	assert.equal(
		row(markdown, 'e2e/some-skips.e2e.ts'),
		'| `e2e/some-skips.e2e.ts` | 1 | 4.0 | 4.00 |'
	);
	assert.match(markdown, /\| Skipped \(not counted above\) \| 1 \|/);
	// And it is not listed among the spec's costliest tests either.
	assert.doesNotMatch(markdown, /- 0\.1s — skipped/);
});

test('a run with no skips says nothing about skips', () => {
	const markdown = profileMarkdown(profile([{ spec: 'e2e/one.e2e.ts', title: 'a', ms: 1 }]), run());
	assert.doesNotMatch(markdown, /Skipped/);
});

test('only a run over the whole suite may claim the committed table', () => {
	assert.equal(isWholeSuite('pnpm test:e2e --profile'), true);
	assert.equal(isWholeSuite('pnpm test:e2e --profile --headed'), true);
	assert.equal(isWholeSuite('pnpm test:e2e --profile --workers=10'), true);
	assert.equal(isWholeSuite('pnpm test:e2e --profile e2e/editor-layers.e2e.ts'), false);
	assert.equal(isWholeSuite('pnpm test:e2e --profile --grep @slow'), false);
	assert.equal(isWholeSuite('pnpm test:e2e --profile --project=chromium'), false);
	assert.equal(isWholeSuite('pnpm test:e2e --profile --shard=1/4'), false);
});

test('the costliest tests inside a spec are listed first', () => {
	const { specs } = profile([
		{ spec: 'e2e/one.e2e.ts', title: 'quick', ms: 10 },
		{ spec: 'e2e/one.e2e.ts', title: 'slow', ms: 900 }
	]);
	assert.deepEqual(
		specs[0].tests.map((item) => item.title),
		['slow', 'quick']
	);
});

test('the table records the run it came from, so a one-spec profile cannot read as a suite one', () => {
	const rolled = profile([{ spec: 'e2e/one.e2e.ts', title: 'a', ms: 2500 }]);
	const markdown = profileMarkdown(rolled, run({ command: 'pnpm test:e2e --profile one.e2e.ts' }));
	assert.match(markdown, /pnpm test:e2e --profile one\.e2e\.ts/);
	assert.match(markdown, /\| Tests \| 1 \|/);
	assert.match(markdown, /\| Workers \| 4 \|/);
	assert.match(markdown, /\| `e2e\/one\.e2e\.ts` \| 1 \| 2\.5 \| 2\.50 \|/);
});
