#!/usr/bin/env node
// What a public instance of the editor must not contain.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
// │ THIS IS THE HALF OF THE ARRANGEMENT THAT CAN ACTUALLY GO WRONG.                                 │
// └───────────────────────────────────────────────────────────────────────────────────────────────┘
//
// `scripts/stage-deploy-build.mjs` leaves the harness route and the test fixtures out of the tree a
// deployment build reads. That works, and it works *invisibly*: the ordinary build still contains
// both, every test drives them, and nothing in a developer's loop ever looks at a deployment build.
// So the ways it silently stops working are all live —
//
//   - `BALLASTELLA_DEPLOY` not reaching `svelte.config.js` (a renamed variable, a shell that drops
//     it, a `pnpm` script edited to lose the assignment), in which case the build reads `src/routes`
//     and `static` and the exclusion simply does not happen;
//   - `kit.files` renamed or moved by a SvelteKit upgrade, same outcome;
//   - `pages.yml` edited back to `pnpm -r build`, which is the ordinary build.
//
// Every one of those produces a **successful build of the wrong artifact**. Hence a check on the
// output rather than trust in the input, run on the artifact about to be uploaded.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE SERVICE WORKER IS CHECKED TOO, AND NOT AS A FORMALITY
//
// `apps/editor/src/service-worker.ts` precaches `[...prerendered, ...build.filter(js|css)]` and
// `cache.addAll` **rejects atomically**. A manifest naming a document the artifact does not hold
// means `install` rejects for ever: the new worker is never promoted, the app stops updating and
// stops working offline, and nothing on screen says why. That is the failure that makes deleting the
// harness from `build/` after the fact unsafe, and it is worth one grep to know the built worker
// agrees with the built site.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const repoRoot =
	rootFlag === -1
		? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
		: path.resolve(process.argv[rootFlag + 1] ?? '.');

const build = path.join(repoRoot, 'apps/editor/build');

/**
 * What must not be in a deployed artifact, and the name to say when it is.
 *
 * `expect: 'present'` entries are the positive controls. Without them this check passes on an empty
 * directory, which is the shape every "asserts an absence" check fails in — and a deployment build
 * that produced nothing would be the loudest possible reason to look.
 */
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

/**
 * Names the built service worker must not precache **once the artifact no longer holds them**, each
 * with the artifact entry that decides whether it is there.
 *
 * Gated on the absence rather than asserted flat, because the same worker naming the same path is
 * correct in an ordinary build and fatal in a deployment one. An ungated version reported "names
 * `image-pane`, which this artifact does not contain" about an artifact that contained it — true
 * about the deployment rule and false about the file, which is the kind of message that gets a real
 * check disbelieved.
 */
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

if (problems.length > 0) {
	console.error(
		'\nThis is not a deployable artifact:\n\n' +
			problems.map((problem) => `- ${problem}`).join('\n\n') +
			'\n\nSee scripts/stage-deploy-build.mjs and docs/hosting.md.\n'
	);
	process.exit(1);
}

console.log(
	'OK: the artifact holds the app and no developer harness, and its service worker agrees.'
);
