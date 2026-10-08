#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { failProblems, rootFromArgv } from './fence.mjs';

const repoRoot = rootFromArgv();
const editor = path.join(repoRoot, 'apps/editor');
const STAGED_DIRECTORY = '.deploy';

const EXCLUDED = [
	{
		from: 'src/routes',
		to: `${STAGED_DIRECTORY}/routes`,
		omit: 'image-pane',
		why: 'the developer harness route — see e2e/editor-image-pane.e2e.ts'
	},
	{
		from: 'static',
		to: `${STAGED_DIRECTORY}/static`,
		omit: 'fixtures',
		why: 'committed test fixtures — see apps/editor/static/fixtures/README.md'
	}
];

function weigh(target) {
	if (!existsSync(target)) return 0;
	if (!statSync(target).isDirectory()) return statSync(target).size;
	return readdirSync(target).reduce((sum, entry) => sum + weigh(path.join(target, entry)), 0);
}

const staged = path.join(editor, STAGED_DIRECTORY);
rmSync(staged, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });
const problems = [];
const report = [];

for (const { from, to, omit, why } of EXCLUDED) {
	const source = path.join(editor, from);
	if (!existsSync(source)) {
		problems.push(`apps/editor/${from} does not exist, so there is nothing to stage from it.`);
		continue;
	}

	const omitted = path.join(source, omit);
	if (!existsSync(omitted)) {
		problems.push(
			`apps/editor/${from}/${omit} does not exist, so this step excluded nothing.\n` +
				`  It is meant to leave out ${why}.\n` +
				`  If it moved or was renamed, update EXCLUDED in scripts/stage-deploy-build.mjs. If it\n` +
				`  was deleted outright, remove its entry — but do not leave this pointing at a name that\n` +
				`  is gone, because then the artifact silently starts shipping whatever replaced it.`
		);
		continue;
	}

	const bytes = weigh(omitted);
	cpSync(source, path.join(editor, to), {
		recursive: true,
		filter: (entry) => path.resolve(entry) !== path.resolve(omitted)
	});
	report.push(`${from}/${omit} (${(bytes / 1000).toFixed(0)} kB) — ${why}`);
}

failProblems('A deployment build could not be staged', problems);

console.log(
	`Staged a deployment build of the editor in ${STAGED_DIRECTORY}/, leaving out:\n` +
		report.map((line) => `  - ${line}`).join('\n')
);
