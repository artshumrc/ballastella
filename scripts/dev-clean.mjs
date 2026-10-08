import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './fence.mjs';
import { listeners as listening } from './free-e2e-port.mjs';

export const DEFAULT_DEV_PORTS = [5173, 5174];

const workingDirectory = (pid) => {
	try {
		return readlinkSync(`/proc/${pid}/cwd`);
	} catch {}
	try {
		const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		});
		return (
			out
				.split('\n')
				.find((line) => line.startsWith('n'))
				?.slice(1) ?? null
		);
	} catch {
		return null;
	}
};

export const belongsToRepo = (pid, root = repoRoot) => {
	const cwd = workingDirectory(pid);
	if (cwd === null) return false;
	const relative = path.relative(root, cwd);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const describe = (pid) => {
	try {
		return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		})
			.trim()
			.slice(0, 100);
	} catch {
		return '(gone)';
	}
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Free `ports` of this checkout's servers. SIGTERM first (no TIME_WAIT), then SIGKILL by pid for the wedged. @returns ports still held. */
export const cleanPorts = async (ports) => {
	const held = [];
	for (const port of ports) {
		const pids = listening(port);
		if (pids.length === 0) {
			console.log(`dev-clean: ${port} already free`);
			continue;
		}

		const ours = pids.filter((pid) => belongsToRepo(pid));
		for (const pid of pids.filter((pid) => !ours.includes(pid))) {
			console.log(
				`dev-clean: leaving pid ${pid} on ${port} alone — not this checkout: ${describe(pid)}`
			);
		}
		if (ours.length === 0) {
			held.push(port);
			continue;
		}

		for (const pid of ours) {
			try {
				process.kill(pid, 'SIGTERM');
				console.log(`dev-clean: stopped pid ${pid} holding ${port}`);
			} catch (cause) {
				console.warn(`dev-clean: could not stop pid ${pid} on ${port}: ${cause}`);
			}
		}
		for (let attempt = 0; attempt < 10 && listening(port).some((p) => ours.includes(p)); attempt++)
			await sleep(300);

		const stubborn = listening(port).filter((pid) => ours.includes(pid));
		for (const pid of stubborn) {
			try {
				process.kill(pid, 'SIGKILL');
				console.log(`dev-clean: SIGKILLed pid ${pid}, which ignored SIGTERM on ${port}`);
			} catch {}
		}
		if (stubborn.length > 0) await sleep(500);

		if (listening(port).length > 0) held.push(port);
		else console.log(`dev-clean: ${port} free`);
	}
	return held;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const requested = process.argv.slice(2).map(Number);
	if (requested.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
		console.error(`dev-clean: expected port numbers, got ${process.argv.slice(2).join(' ')}`);
		process.exit(2);
	}
	const held = await cleanPorts(requested.length > 0 ? requested : DEFAULT_DEV_PORTS);
	if (held.length > 0) {
		console.error(`dev-clean: still held: ${held.join(', ')}`);
		process.exit(1);
	}
}
