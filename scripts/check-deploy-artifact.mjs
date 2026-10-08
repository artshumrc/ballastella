#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { failProblems, rootFromArgv } from './fence.mjs';

const repoRoot = rootFromArgv();
const build = path.join(repoRoot, 'apps/editor/build');

const RULES = [
	{
		entry: 'image-pane.html',
		expect: 'absent',
		why: 'the developer harness route. Nothing in the UI links to it, and it is not a public page.'
	},
	{
		entry: 'fixtures',
		expect: 'absent',
		why: 'committed test fixtures — about 1 MB of pyramid a reader will never ask for.'
	},
	{ entry: 'index.html', expect: 'present', why: 'the app itself' },
	{ entry: 'align.html', expect: 'present', why: 'the alignment route, a real page' },
	{ entry: '_app', expect: 'present', why: "the app's code and styles" }
];

const WORKER_MUST_NOT_NAME = [
	{ name: 'image-pane', decidedBy: 'image-pane.html' },
	{ name: 'fixtures', decidedBy: 'fixtures' }
];

const problems = [];

if (!existsSync(build) || !statSync(build).isDirectory()) {
	problems.push(
		'apps/editor/build does not exist, so this check could not run.\n' + '  Run: pnpm build:deploy'
	);
} else {
	for (const { entry, expect, why } of RULES) {
		const there = existsSync(path.join(build, entry));
		if (expect === 'absent' && there) {
			problems.push(
				`apps/editor/build/${entry} is present, and a deployment must not ship it:\n` +
					`  ${why}\n` +
					'  This build read src/routes and static rather than the filtered tree. Check that\n' +
					'  BALLASTELLA_DEPLOY=1 reached svelte.config.js, and that the deploy step runs\n' +
					'  `pnpm build:deploy` rather than `pnpm -r build`.'
			);
		}
		if (expect === 'present' && !there) {
			problems.push(
				`apps/editor/build/${entry} is missing — ${why}.\n` +
					'  This is not an over-zealous exclusion to be relaxed: a deployment build that drops a\n' +
					'  real page is broken, and this check exists so it fails here rather than in public.'
			);
		}
	}

	const workerPath = path.join(build, 'service-worker.js');
	if (!existsSync(workerPath)) {
		problems.push(
			'apps/editor/build/service-worker.js is missing, so the precache manifest could not be read.'
		);
	} else {
		const worker = readFileSync(workerPath, 'utf8');
		for (const { name, decidedBy } of WORKER_MUST_NOT_NAME) {
			if (existsSync(path.join(build, decidedBy))) continue;
			if (worker.includes(name)) {
				problems.push(
					`The built service worker names "${name}", which this artifact does not contain.\n` +
						'  `cache.addAll` rejects atomically, so install would fail for ever: the worker is\n' +
						'  never promoted, the app stops updating and stops working offline, and nothing says\n' +
						'  so. The route must be absent when SvelteKit writes the manifest — which is what\n' +
						'  scripts/stage-deploy-build.mjs is for. Do not fix this by deleting files from build/.'
				);
			}
		}
	}
}

failProblems(
	'This is not a deployable artifact',
	problems,
	'\nSee scripts/stage-deploy-build.mjs and docs/hosting.md.\n'
);

console.log(
	'OK: the artifact holds the app and no developer harness, and its service worker agrees.'
);
