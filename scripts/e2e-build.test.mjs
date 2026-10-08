import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	utimesSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
	OUTPUTS,
	lockIsStale,
	ownerIsGone,
	releaseLock,
	releaseOwnLock,
	takeLock
} from './e2e-build.mjs';
import { repoRoot } from './fence.mjs';

const moduleUrl = new URL('./e2e-build.mjs', import.meta.url).href;
const scriptPath = fileURLToPath(moduleUrl);
const withLockDirectory = (body) => {
	const parent = mkdtempSync(path.join(tmpdir(), 'ballastella-lock-'));
	try {
		return body(path.join(parent, 'build.lock'));
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
};
const ownedBy = (directory, pid) => {
	mkdirSync(directory, { recursive: true });
	writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid }));
};

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

test('a live process is not gone', () => {
	assert.equal(ownerIsGone(process.pid), false);
});

test('a process that has exited is gone — the direction the old code had inverted', () => {
	assert.equal(ownerIsGone(deadPid()), true);
});

test('a process this user may not signal is treated as alive, not as gone', () => {
	assert.equal(ownerIsGone(1), false);
});

test('a lock held by a live process is not stale', () => {
	withLockDirectory((directory) => {
		assert.equal(takeLock(directory), true);
		assert.equal(lockIsStale(directory), false);
	});
});

test('a lock whose owner has exited is stale, and can then be taken', () => {
	withLockDirectory((directory) => {
		ownedBy(directory, deadPid());

		assert.equal(lockIsStale(directory), true);
		releaseLock(directory);
		assert.equal(takeLock(directory), true);
	});
});

test('a lock older than any real build is stale even if some process still holds that pid', () => {
	withLockDirectory((directory) => {
		takeLock(directory);
		const longAgo = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(directory, longAgo, longAgo);
		assert.equal(lockIsStale(directory), true);
	});
});

test('a lock taken between its mkdir and its owner file is not stale', () => {
	withLockDirectory((directory) => {
		mkdirSync(directory, { recursive: true });
		assert.equal(lockIsStale(directory), false);
	});
});

const childHoldingTheLock = (directory, lines) =>
	spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			[
				`import { mkdirSync, writeFileSync } from 'node:fs';`,
				`import path from 'node:path';`,
				`import { takeLock, releaseOnExit, releaseOwnLock } from ${JSON.stringify(moduleUrl)};`,
				`const directory = ${JSON.stringify(directory)};`,
				`if (!takeLock(directory)) process.exit(9);`,
				...lines
			].join('\n')
		],
		{ encoding: 'utf8', timeout: 20_000 }
	);

for (const { name, ending, status, survived } of [
	{
		name: 'the lock is released when the process exits non-zero, not only when it returns',
		ending: 'process.exit(3);',
		status: 3,
		survived: 'the lock survived a process that exited while holding it'
	},
	{
		name: 'the lock is released when the process throws while holding it',
		ending: 'throw new Error("the build blew up");',
		status: 1,
		survived: 'the lock survived an uncaught throw'
	},
	{
		name: 'the lock is released on ^C, whose default action skips exit handlers',
		ending: 'process.kill(process.pid, "SIGINT"); setTimeout(() => {}, 10_000);',
		status: 130,
		survived: 'the lock survived an interrupt'
	}
]) {
	test(name, () => {
		withLockDirectory((directory) => {
			const result = childHoldingTheLock(directory, ['releaseOnExit(directory);', ending]);
			assert.equal(result.status, status, result.stderr);
			assert.equal(existsSync(directory), false, survived);
		});
	});
}

test('releasing does not remove a lock another process has since taken', () => {
	withLockDirectory((directory) => {
		takeLock(directory);
		releaseOwnLock(directory);
		ownedBy(directory, process.pid + 1);

		assert.equal(releaseOwnLock(directory), false, 'it claimed a lock it does not own');
		assert.equal(existsSync(directory), true, "it deleted another process's lock");
	});
});

test('releasing leaves alone a lock whose owner has not written its pid yet', () => {
	withLockDirectory((directory) => {
		mkdirSync(directory, { recursive: true });
		assert.equal(releaseOwnLock(directory), false);
		assert.equal(existsSync(directory), true);
	});
});

test('the exit handlers are disarmed once the lock has been released normally', () => {
	withLockDirectory((directory) => {
		const result = childHoldingTheLock(directory, [
			`const disarm = releaseOnExit(directory);`,
			`releaseOwnLock(directory);`,
			`disarm();`,
			`mkdirSync(directory, { recursive: true });`,
			`writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }));`,
			`process.exit(0);`
		]);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			existsSync(directory),
			true,
			"an exit handler that was supposed to be disarmed deleted the successor's lock"
		);
	});
});

const repoLockDirectory = path.join(repoRoot, 'node_modules/.cache/ballastella-e2e/build.lock');

test('running the script with a failing build leaves no lock behind', (t) => {
	if (existsSync(repoLockDirectory) && !lockIsStale(repoLockDirectory)) {
		t.skip('a live build holds the repository lock');
		return;
	}
	releaseLock(repoLockDirectory);

	const result = spawnSync(process.execPath, [scriptPath], {
		encoding: 'utf8',
		timeout: 60_000,
		env: { ...process.env, PATH: '', BALLASTELLA_E2E_FORCE_BUILD: '1' }
	});

	assert.notEqual(result.status, 0, 'a failing build should fail the script');
	assert.equal(
		existsSync(repoLockDirectory),
		false,
		'the script leaked its lock on a failed build — the defect this file exists for'
	);
});

test('OUTPUTS names something a deployment build does not produce, so the two are told apart', () => {
	const staging = readFileSync(new URL('./stage-deploy-build.mjs', import.meta.url), 'utf8');
	const omitted = [...staging.matchAll(/^\s*omit: '([^']+)'/gm)].map((match) => match[1]);

	assert.ok(
		omitted.length > 0,
		'no `omit:` entries found in stage-deploy-build.mjs — this test can no longer tell what a ' +
			'deployment build leaves out, so it cannot check that OUTPUTS distinguishes one.'
	);

	const sentinels = OUTPUTS.filter((output) => omitted.some((name) => output.includes(name)));
	assert.ok(
		sentinels.length > 0,
		`OUTPUTS names none of what a deployment build omits (${omitted.join(', ')}), so an ` +
			'ordinary build and a deployment build are indistinguishable to the stamp and the e2e ' +
			'suite can be served the wrong one. Keep a path in OUTPUTS that only the ordinary build ' +
			'writes — see the comment on OUTPUTS in e2e-build.mjs.'
	);
});
