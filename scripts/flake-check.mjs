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

const runSpec = (spec, cwd) => {
	const result = spawnSync('pnpm', ['exec', 'playwright', 'test', spec], {
		cwd,
		stdio: 'inherit',
		encoding: 'utf8'
	});
	return result.status === 0;
};

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

const needsAttention = verdicts.some(({ verdict }) => verdict === 'REAL' || verdict === 'SUSPECT');
process.exit(needsAttention ? 1 : 0);
