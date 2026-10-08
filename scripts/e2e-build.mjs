#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './fence.mjs';

const INPUT_ROOTS = ['apps', 'packages', 'patches'];

const INPUT_FILES = [
	'package.json',
	'pnpm-lock.yaml',
	'pnpm-workspace.yaml',
	'tsconfig.json',
	'scripts/stage-viewer-bundle.mjs'
];

const SKIP_DIRECTORIES = new Set([
	'node_modules',
	'.svelte-kit',
	'build',
	'dist',
	'.vite',
	'test-results',
	'__screenshots__',
	'.vitest-attachments',
	'viewer-bundle',
	'.deploy'
]);

const cacheDirectory = path.join(repoRoot, 'node_modules/.cache/ballastella-e2e');
const stampFile = path.join(cacheDirectory, 'build-stamp.json');
const lockDirectory = path.join(cacheDirectory, 'build.lock');

const inputFiles = () => {
	const found = [];
	const walk = (relative) => {
		for (const entry of readdirSync(path.join(repoRoot, relative), { withFileTypes: true })) {
			if (entry.isDirectory()) {
				if (SKIP_DIRECTORIES.has(entry.name)) continue;
				walk(path.join(relative, entry.name));
			} else if (entry.isFile()) {
				found.push(path.join(relative, entry.name));
			}
		}
	};
	for (const root of INPUT_ROOTS) if (existsSync(path.join(repoRoot, root))) walk(root);
	for (const file of INPUT_FILES) if (existsSync(path.join(repoRoot, file))) found.push(file);
	return found.sort();
};

const fingerprint = () => {
	const digest = createHash('sha256');
	for (const file of inputFiles()) {
		digest.update(file);
		digest.update('\0');
		digest.update(readFileSync(path.join(repoRoot, file)));
		digest.update('\0');
	}
	return digest.digest('hex');
};

export const OUTPUTS = [
	'apps/editor/build/index.html',
	'apps/editor/build/image-pane.html',
	'apps/viewer/build/index.html'
];

const outputsPresent = () => OUTPUTS.every((file) => existsSync(path.join(repoRoot, file)));

const readStamp = () => {
	try {
		return JSON.parse(readFileSync(stampFile, 'utf8'));
	} catch {
		return null;
	}
};

const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_POLL_MS = 250;

export const takeLock = (directory = lockDirectory) => {
	try {
		mkdirSync(directory, { recursive: false });
		writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }));
		return true;
	} catch {
		return false;
	}
};

export const releaseLock = (directory = lockDirectory) =>
	rmSync(directory, { recursive: true, force: true });

export const releaseOwnLock = (directory = lockDirectory) => {
	let owner;
	try {
		owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
	} catch {
		return false;
	}
	if (owner?.pid !== process.pid) return false;
	releaseLock(directory);
	return true;
};

export const ownerIsGone = (pid) => {
	try {
		process.kill(pid, 0);
		return false;
	} catch (cause) {
		if (cause?.code === 'ESRCH') return true;
		return false;
	}
};

export const lockIsStale = (directory = lockDirectory, now = Date.now()) => {
	let owner;
	try {
		if (now - statSync(directory).mtimeMs > LOCK_STALE_MS) return true;
		owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
	} catch {
		return false;
	}
	return typeof owner?.pid === 'number' && ownerIsGone(owner.pid);
};

export const releaseOnExit = (directory) => {
	const release = () => releaseOwnLock(directory);
	const onSignal = (signal) => () => {
		release();
		process.exit(signal === 'SIGINT' ? 130 : 143);
	};
	const handlers = [
		['exit', release],
		['SIGINT', onSignal('SIGINT')],
		['SIGTERM', onSignal('SIGTERM')]
	];
	for (const [event, handler] of handlers) process.on(event, handler);
	return () => {
		for (const [event, handler] of handlers) process.off(event, handler);
	};
};

const build = () => {
	const result = spawnSync('pnpm', ['--filter', '@ballastella/editor', 'run', 'build'], {
		cwd: repoRoot,
		stdio: 'inherit'
	});
	return result.status ?? 1;
};

const main = () => {
	mkdirSync(cacheDirectory, { recursive: true });
	const forced = process.env.BALLASTELLA_E2E_FORCE_BUILD === '1';

	for (;;) {
		const wanted = fingerprint();
		const stamp = readStamp();
		if (!forced && stamp?.fingerprint === wanted && outputsPresent()) {
			console.log(`e2e-build: apps/*/build are current (${wanted.slice(0, 12)}) — not rebuilding`);
			return 0;
		}
		if (takeLock()) {
			const disarm = releaseOnExit(lockDirectory);
			try {
				console.log('e2e-build: building both apps…');
				const started = Date.now();
				const status = build();
				if (status !== 0) return status;
				writeFileSync(stampFile, JSON.stringify({ fingerprint: fingerprint() }));
				console.log(`e2e-build: built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
			} finally {
				releaseOwnLock(lockDirectory);
				disarm();
			}
			return 0;
		}
		if (lockIsStale()) {
			console.warn('e2e-build: breaking a lock whose owner is gone');
			releaseLock();
			continue;
		}
		sleep(LOCK_POLL_MS);
	}
};

const sleep = (ms) => {
	const until = Date.now() + ms;
	while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	process.exitCode = main();
}
