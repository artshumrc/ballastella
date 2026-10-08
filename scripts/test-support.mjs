import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { repoRoot } from './fence.mjs';

export { repoRoot };

export const escaped = (text) => text.replaceAll('.', '\\.');

export const runScript = (script, args = [], cwd = repoRoot) => {
	const run = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
	return { status: run.status, output: `${run.stdout}${run.stderr}` };
};

export const writeTree = (root, files) => {
	for (const [relative, contents] of Object.entries(files)) {
		const file = path.join(root, relative);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
};

export function withTree(files, body, scripts = []) {
	const root = mkdtempSync(path.join(tmpdir(), 'ballastella-'));
	try {
		writeTree(root, files);
		for (const name of scripts) {
			cpSync(path.join(repoRoot, 'scripts', name), path.join(root, 'scripts', name));
		}
		return body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** The quoted members of `const name = new Set([...])` in a script, which runs on import and so cannot be imported. */
export function setMembers(script, name) {
	const source = readFileSync(path.join(repoRoot, 'scripts', script), 'utf8');
	const set = source.match(new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`));
	return [...(set?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
}
