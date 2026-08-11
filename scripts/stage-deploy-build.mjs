#!/usr/bin/env node
// Stage a filtered source tree for a **deployment** build of the editor, so that a public instance
// ships neither the developer harness route nor the test fixtures it reads.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY A FILTERED TREE AND NOT A DELETION FROM `build/`                                           │
// └───────────────────────────────────────────────────────────────────────────────────────────────┘
//
// Because deleting `image-pane.html` after the build would break the PWA on every deployment, and
// would break it *silently*. `apps/editor/src/service-worker.ts` builds its precache list as
// `[...prerendered, ...build.filter(js|css)]`, and `cache.addAll` **rejects atomically** if any one
// request fails — so a manifest naming a document that is no longer there means `install` rejects,
// the new worker is never promoted, and the app simply stops updating and stops working offline.
// Nothing on screen says so.
//
// The route has to be absent when SvelteKit *writes* that manifest, which means absent from the
// routes directory the build reads. So the build reads a copy with the harness left out.
//
// The fixtures are a different case and are handled the same way anyway. They are `static/`, and
// nothing precaches them — `BASE_MAP` takes only `base-map/`, and `editor-pwa.e2e.ts` asserts that
// no fixture path is ever cached — so pruning them afterwards would in fact be safe. Doing it here
// instead means **one mechanism with one explanation** rather than two rules a reader has to keep
// apart, and it costs a directory copy in CI.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE HARNESS IS NOT DEAD CODE, WHICH IS WHY IT IS EXCLUDED RATHER THAN DELETED                  │
// └───────────────────────────────────────────────────────────────────────────────────────────────┘
//
// `/image-pane` carries `e2e/editor-image-pane.e2e.ts` — 329 lines of Seam 2 coverage that nothing
// else makes: MapLibre's `project` and `unproject` composed in opposite directions against a point
// drawn by `resourceToSynthetic`, a pan pinned to a physical distance, and the zoom-stability
// acceptance criterion of ticket 03. It needs a bare pane with no alignment workspace around it.
// So it stays in the app, type-checked and linted and driven by the suite, and it is the *deployed
// artifact* that leaves it out. `apps/editor/static/fixtures/README.md` records the fixture's
// provenance; `@ballastella/core`'s unit tests read the same pyramid off disk and are unaffected.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// **A NAME THAT NO LONGER EXISTS IS AN ERROR, NOT A NO-OP.** Excluding by name means a rename
// silently stops excluding anything — the harness would quietly reappear in the artifact and the
// build would still report success. So every entry in `EXCLUDED` must be found, or this fails.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * `--root` exists so `stage-deploy-build.test.mjs` can drive this against fixture trees — in
 * particular the not-found case below, which is a claim about behaviour and is worth nothing
 * unasserted.
 */
const rootFlag = process.argv.indexOf('--root');
const repoRoot =
	rootFlag === -1
		? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
		: path.resolve(process.argv[rootFlag + 1] ?? '.');
const editor = path.join(repoRoot, 'apps/editor');

/**
 * Where the filtered tree goes. Gitignored, and rebuilt from scratch every time: a stale entry here
 * is a file in the artifact that is in nobody's source tree, which is worse than either extreme.
 */
export const STAGED_DIRECTORY = '.deploy';

/**
 * What a deployment does not ship, as `<source directory>` → `<entry name to leave out>`.
 *
 * Names rather than globs, so the failure when one is renamed is "not found" rather than "matched
 * nothing", and so this list reads as an inventory.
 */
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

/** Total bytes under `target`, for reporting what was left out. */
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

if (problems.length > 0) {
	console.error(
		'\nA deployment build could not be staged:\n\n' +
			problems.map((problem) => `- ${problem}`).join('\n\n') +
			'\n'
	);
	process.exit(1);
}

console.log(
	`Staged a deployment build of the editor in ${STAGED_DIRECTORY}/, leaving out:\n` +
		report.map((line) => `  - ${line}`).join('\n')
);
