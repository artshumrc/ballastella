// Run the browser suite on this checkout's derived ports, with stray listeners cleared first.
//
// Playwright's `webServer` frees its own port, but only once it starts. Clearing up front means a
// leftover `vite preview` from a killed run is reported to the caller by port and name, rather than
// showing up later as a suite that mysteriously tested someone else's build.
//
// `--profile` is handled here rather than passed on: Playwright has no such flag, and the profiler
// has to be *added* to the reporter list in the config. Spelling it `--reporter=…` on the command
// line would replace that list and take the retry budget with it.

import { spawn } from 'node:child_process';
import process from 'node:process';

import { cleanPorts } from './dev-clean.mjs';
import { editorPort, viewerPort } from './e2e-port.mjs';

const run = (command, args) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { stdio: 'inherit', env: process.env });
		child.on('close', (code) => resolve(code ?? 1));
	});

console.log(`e2e: editor ${editorPort}, viewer ${viewerPort}`);
if (process.env.BALLASTELLA_E2E_PORT) console.log('e2e: ports overridden by BALLASTELLA_E2E_PORT');

const held = await cleanPorts([editorPort, viewerPort]);
if (held.length > 0) {
	console.error(
		`e2e: ${held.join(' and ')} still held, so the suite would test whatever is serving there.\n` +
			`Find it with: lsof -i:${held[0]} -sTCP:LISTEN`
	);
	process.exit(1);
}

const install = await run('pnpm', ['exec', 'playwright', 'install', 'chromium']);
if (install !== 0) process.exit(install);

// Everything after `--` is the caller's: a spec name, `--headed`, `--project`.
const forwarded = process.argv.slice(2).filter((argument) => argument !== '--profile');
if (forwarded.length !== process.argv.length - 2) {
	process.env.BALLASTELLA_E2E_PROFILE = '1';
	process.env.BALLASTELLA_E2E_PROFILE_COMMAND = ['pnpm test:e2e --profile', ...forwarded].join(' ');
	console.log('e2e: profiling worker-seconds per test; the retry budget is unaffected');
}

process.exit(await run('pnpm', ['exec', 'playwright', 'test', ...forwarded]));
