#!/usr/bin/env node
// Both apps must answer their own root route under `vite dev`.
//
// **Why this exists.** The browser suite runs against `apps/*/build`, and the shipped Published Site is
// prerendered static files with no server at all (ADR-0006). So development mode — the thing every
// contributor actually runs — was the one configuration nothing exercised. It broke: `maplibre-gl`
// resolves to its CommonJS build when Vite leaves it external, its named exports are not ES bindings,
// and the SSR pass of the root route died with "Named export 'Popup' not found". Every route of both
// apps answered 500 while `pnpm lint`, `pnpm check`, 1195 unit tests, 305 browser tests and both bundle
// fences stayed green, because not one of them starts a dev server.
//
// **Deliberately a boot check and nothing more.** It asserts a 200 and no server-side error, which is
// the failure class that makes the app unusable to work on. Anything about what the page then does
// belongs in the browser suite, against the build that actually ships.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

/** Ports well away from Vite's 5173 default, so a dev server someone is using is never mistaken for this. */
const APPS = [
	{ name: '@ballastella/editor', port: 5391 },
	{ name: '@ballastella/viewer', port: 5392 }
];

const BOOT_TIMEOUT_MS = 180_000;
const POLL_MS = 500;

/** The dev server, once it answers — or a rejection naming what it said instead. */
async function bootAndFetch(app) {
	const output = [];
	// `detached` so the spawn leads its own process group: `pnpm` runs vite as a child, and killing only
	// the parent leaves vite holding the port, which fails the *next* app's check rather than this one's.
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
			} catch {
				// Not listening yet. The editor's `dev` builds the viewer first, so this is a long wait.
			}
			await sleep(POLL_MS);
		}
		throw new Error(`no answer within ${BOOT_TIMEOUT_MS / 1000}s`);
	} finally {
		// The whole tree: `pnpm` spawns vite as a child, and killing only the parent leaves the port held.
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
		console.error(`${app.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
		failed = true;
		continue;
	}

	if (result.status !== 200) {
		// The reason is in the server's own output, and it is the whole point of running this.
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
