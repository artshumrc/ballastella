#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { messageOf } from './fence.mjs';

const APPS = [
	{ name: '@ballastella/editor', port: 5391 },
	{ name: '@ballastella/viewer', port: 5392 }
];

const BOOT_TIMEOUT_MS = 180_000;
const POLL_MS = 500;

async function bootAndFetch(app) {
	const output = [];
	const server = spawn('pnpm', ['--filter', app.name, 'dev', '--port', String(app.port)], {
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	server.stdout.on('data', (chunk) => output.push(String(chunk)));
	server.stderr.on('data', (chunk) => output.push(String(chunk)));

	try {
		const deadline = Date.now() + BOOT_TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (server.exitCode !== null) {
				throw new Error(`the dev server exited with ${server.exitCode} before answering`);
			}
			try {
				const response = await fetch(`http://localhost:${app.port}/`);
				const body = await response.text();
				return { status: response.status, body, output: output.join('') };
			} catch {}
			await sleep(POLL_MS);
		}
		throw new Error(`no answer within ${BOOT_TIMEOUT_MS / 1000}s`);
	} finally {
		try {
			process.kill(-server.pid, 'SIGKILL');
		} catch {
			server.kill('SIGKILL');
		}
	}
}

let failed = false;

for (const app of APPS) {
	let result;
	try {
		result = await bootAndFetch(app);
	} catch (cause) {
		console.error(`${app.name}: ${messageOf(cause)}`);
		failed = true;
		continue;
	}

	if (result.status !== 200) {
		const reason =
			/Named export '[^']+' not found[^\n]*/.exec(result.output)?.[0] ??
			/Error when evaluating SSR module[^\n]*/.exec(result.output)?.[0] ??
			'see the dev server output above';
		console.error(`${app.name}: \`vite dev\` answered ${result.status} at /, not 200 — ${reason}`);
		console.error(result.output.split('\n').slice(-40).join('\n'));
		failed = true;
		continue;
	}

	console.log(`${app.name}: \`vite dev\` answers 200 at /.`);
}

if (failed) process.exit(1);
