import { spawn } from 'node:child_process';
import process from 'node:process';

import { cleanPorts, DEFAULT_DEV_PORTS } from './dev-clean.mjs';

const STAGES = [
	{ name: 'lint', command: 'pnpm', args: ['run', 'lint'] },
	{ name: 'check', command: 'pnpm', args: ['run', 'check'] },
	{ name: 'test', command: 'pnpm', args: ['run', 'test'] },
	{ name: 'e2e', command: 'node', args: ['scripts/e2e.mjs'], optIn: true }
];

const run = (command, args) =>
	new Promise((resolve) => {
		const child = spawn(command, args, { stdio: 'inherit', env: process.env });
		child.on('close', (code) => resolve(code ?? 1));
	});

const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
const only = process.argv.slice(2);
const stages =
	only.length > 0
		? STAGES.filter((stage) => only.includes(stage.name))
		: STAGES.filter((stage) => !stage.optIn);
if (stages.length === 0) {
	console.error(`precommit: no such stage. Known: ${STAGES.map((s) => s.name).join(', ')}`);
	process.exit(2);
}

await cleanPorts(DEFAULT_DEV_PORTS);

const started = Date.now();
const done = [];
for (const stage of stages) {
	console.log(`\n=== precommit: ${stage.name} ===`);
	const at = Date.now();
	const code = await run(stage.command, stage.args);
	done.push({ name: stage.name, code, ms: Date.now() - at });

	if (code !== 0) break;
}

console.log('\n=== precommit summary ===');
for (const stage of done) {
	console.log(
		`${stage.code === 0 ? 'pass' : 'FAIL'}  ${stage.name.padEnd(6)} ${seconds(stage.ms)}`
	);
}
const skipped = stages.length - done.length;
if (skipped > 0) console.log(`      ${skipped} stage(s) not reached`);
console.log(`total ${seconds(Date.now() - started)}`);

process.exit(done.some((stage) => stage.code !== 0) ? 1 : 0);
