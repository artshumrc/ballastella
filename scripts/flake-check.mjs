// Decide whether a failing e2e spec is this branch's fault or the suite's.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS EXISTS: FOUR PEOPLE WROTE THIS PROCEDURE BY HAND, THE SAME WAY, IN ONE WEEK.      │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// The suite flakes in roughly one full run in three — see the `workers` comment in
// `playwright.config.ts` for the measured profile. So every implementer who finishes a change meets
// the same question: is this red mine? And every one of them answers it the same way, by hand:
// re-run the failing file alone, and if that passes, stash and run it against the merge-base to
// show it was already failing.
//
// That is a procedure, not a judgement, and doing it by hand has a specific failure mode: it is
// tedious enough that a tired implementer skips the second half and reports "known flake" for a
// real regression. One did the whole thing properly this week and found a genuine defect the suite
// had been red on for three commits — bisecting to the exact commit. That is the standard, and it
// should cost one command.
//
// Usage:
//   pnpm flake:check e2e/editor-pwa.e2e.ts [more specs…]      isolation only
//   pnpm flake:check --against main e2e/editor-pwa.e2e.ts     isolation, then the merge-base
//   pnpm flake:check --runs 3 e2e/…                           isolation runs per spec (default 2)
//
// The verdict is advisory and says so. A spec that passes alone twice and fails in the full suite
// is *consistent with* contention; it is not proof of innocence, and a race your change introduced
// can look exactly like this. `--against` is what turns a guess into evidence, so use it before
// reporting anything as a flake.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const specs = [];
let against;
let runs = 2;

for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--against') against = argv[++i];
	else if (argv[i] === '--runs') runs = Number(argv[++i]);
	else specs.push(argv[i]);
}

if (specs.length === 0) {
	console.error(
		'flake-check: name at least one spec.\n' +
			'  pnpm flake:check e2e/editor-pwa.e2e.ts\n' +
			'  pnpm flake:check --against main e2e/editor-pwa.e2e.ts'
	);
	process.exit(2);
}
if (!Number.isInteger(runs) || runs < 1) {
	console.error(`flake-check: --runs expects a positive integer, got ${runs}`);
	process.exit(2);
}

/** Run one spec once. Returns true when it passed. Output is streamed so a real failure is readable. */
const runSpec = (spec, cwd) => {
	const result = spawnSync('pnpm', ['exec', 'playwright', 'test', spec], {
		cwd,
		stdio: 'inherit',
		encoding: 'utf8'
	});
	return result.status === 0;
};

/**
 * A throwaway worktree at `ref`, so the comparison run cannot see this branch's changes.
 *
 * A worktree rather than `git stash`, deliberately: stashing mutates the tree the implementer is
 * working in, and a stash left behind by an interrupted run is its own bad afternoon. This costs a
 * checkout and an install, and it cannot lose anybody's work.
 */
const worktreeAt = (ref) => {
	const dir = mkdtempSync(path.join(tmpdir(), 'ballastella-flake-'));
	execFileSync('git', ['worktree', 'add', '--detach', dir, ref], { stdio: 'inherit' });
	console.log(`\nflake-check: installing dependencies in the ${ref} worktree…`);
	execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: dir, stdio: 'inherit' });
	return dir;
};

const verdicts = [];

for (const spec of specs) {
	console.log(`\n━━━ ${spec}: ${runs} run(s) in isolation ━━━`);
	let passedAlone = 0;
	for (let i = 0; i < runs; i++) if (runSpec(spec, process.cwd())) passedAlone++;

	if (passedAlone < runs) {
		verdicts.push({
			spec,
			verdict: 'REAL',
			detail: `failed ${runs - passedAlone} of ${runs} runs on its own — contention is not the explanation`
		});
		continue;
	}

	if (!against) {
		verdicts.push({
			spec,
			verdict: 'CONSISTENT WITH FLAKE',
			detail: `passed ${runs}/${runs} alone. Not proof — re-run with --against <merge-base> before reporting it as a flake`
		});
		continue;
	}

	console.log(`\n━━━ ${spec}: against ${against} ━━━`);
	let dir;
	try {
		dir = worktreeAt(against);
		const passedThere = runSpec(spec, dir);
		verdicts.push(
			passedThere
				? {
						spec,
						verdict: 'SUSPECT',
						detail: `passed alone here and passed at ${against}. Green in isolation both sides, so the full-suite red is unexplained — do not report this as a known flake without looking at it`
					}
				: {
						spec,
						verdict: 'PRE-EXISTING',
						detail: `fails at ${against} too, so it is not this branch's doing`
					}
		);
	} finally {
		if (dir) {
			execFileSync('git', ['worktree', 'remove', '--force', dir], { stdio: 'ignore' });
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

console.log('\n━━━ verdicts ━━━');
for (const { spec, verdict, detail } of verdicts)
	console.log(`${verdict.padEnd(22)} ${spec}\n${' '.repeat(23)}${detail}`);

// Non-zero when anything needs a human's attention, so this composes into a gate.
const needsAttention = verdicts.some(({ verdict }) => verdict === 'REAL' || verdict === 'SUSPECT');
process.exit(needsAttention ? 1 : 0);
