import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const listeners = (port) => {
	for (const [command, args] of [
		['lsof', ['-t', `-i:${port}`, '-sTCP:LISTEN']],
		['fuser', [`${port}/tcp`]]
	]) {
		try {
			return parsePids(
				execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
			);
		} catch {}
	}
	return [];
};

export const parsePids = (out) =>
	out
		.split(/\s+/)
		.filter((token) => /^\d+$/.test(token))
		.map(Number)
		.filter((pid) => pid > 0 && pid !== process.pid);

const freePort = (port) => {
	let stopped = 0;
	for (const pid of listeners(port)) {
		try {
			process.kill(pid, 'SIGTERM');
			stopped++;
			console.log(`free-e2e-port: stopped pid ${pid} holding port ${port}`);
		} catch (cause) {
			console.warn(`free-e2e-port: could not stop pid ${pid} on port ${port}: ${cause}`);
		}
	}
	return stopped;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	const port = Number(process.argv[2]);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.error(`free-e2e-port: expected a port number, got ${JSON.stringify(process.argv[2])}`);
		process.exit(2);
	}
	freePort(port);
}
