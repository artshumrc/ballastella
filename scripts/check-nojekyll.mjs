#!/usr/bin/env node
// GitHub Pages' Jekyll build drops every path beginning with `_`, and both apps put their whole
// JavaScript and CSS payload under `_app/` (`PUBLISHED_APP_DIRECTORY`). A `.nojekyll` file at the
// served root turns that build off. Without it a Pages site deployed *from a branch* answers
// `index.html` and 404s every asset in it.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ WHY THIS IS FENCED RATHER THAN LEFT TO THE FILE SITTING THERE                              │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// The file is an empty marker in `static/`, which is the least noticeable thing a repository can
// contain: nothing imports it, no type mentions it, and deleting it breaks no build, no test, and
// no lint. It would be removed as "an empty file nobody explained" and everything here would stay
// green — because the failure is not ours. It happens on somebody else's host, to a Reader who sees
// a blank page.
//
// This deployment does not even exercise it: `.github/workflows/pages.yml` uploads an artifact and
// `actions/deploy-pages` never runs Jekyll, so the editor's own site is fine with or without the
// file. **The site that needs it is the author's** — their Remote, served by the default branch
// deploy, where Jekyll runs.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE SUBJECT IS A SITE, AND SINCE ADR-0045 A SITE ONLY SOMETIMES EXISTS                     │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// A repository holds the scholar's work until they ask for **Share Links**, and until then there is
// no `_app/` for Jekyll to drop and no marker to be missing. So the property being fenced is
// conditional: *every commit that carries a site carries the marker*. What remains unconditional is
// the chain — the constant, the build, and the engine still spelling the name from the constant —
// because a break anywhere along it breaks the site that does exist.
//
// So there are three links, carried by different mechanisms on purpose.
//
//   1. **The editor's own build** ships the marker from `apps/editor/static/`, for a forker who
//      chooses a branch deploy over `pages.yml`. Checked here, against built output rather than
//      against `static/`, because the config is not what ships: a `publicDir` change or an adapter
//      that filters dotfiles would leave the `static/` file in place and the deployed site broken.
//
//   2. **Every Workspace a site is written into** gets the marker from `writePublishedSite`, which *authors* it
//      — zero bytes, `source: ''`, nothing fetched. It is deliberately **not** in the viewer's
//      build. It was, once, and that made the site write `fetch` an empty file: dead Share Links
//      under `vite preview`, which serves no dotfiles, and the same on any static host that hides
//      them. See the note on `JEKYLL_OFF_MARKER_FILE` in `published-site/published-site.ts`.
//
//   3. **Every commit that carries a site** holds the marker at the tree root, authored by
//      `planRemoteSend` whether or not the Workspace holds one. This is the end of the chain: the
//      repository that needs the file is one this code now writes to, so it is the last point at
//      which the property can be checked at all. A Sync from a Workspace with no Share Links carries
//      neither the marker nor anything for it to protect (ADR-0045), and the marker that opened an
//      empty repository is preserved rather than owned.
//
// Links 2 and 3 are asserted where they live, against what was actually written — `published-site.test.ts`
// checks `VIEWER_FILE_PATHS` against what `writePublishedSite` wrote, and `send-to-remote.test.ts` reads
// the marker out of every commit a Sync *with Share Links* sent to the fake GitHub, with a commit
// that Sync did not write as its control and a Sync with no Share Links as the other one. This
// script re-asserts neither, because neither is visible to a script: it checks that the constant
// still says `.nojekyll` and that the engine still spells its file from that constant, because
// everything downstream is spelled from that name.
//
// **It also refuses the arrangement that broke**: a marker inside the staged viewer bundle means
// somebody has put it back in `apps/viewer/static/`, and the site write is fetching it again.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Read out of `viewer-files.ts` rather than spelled here, so this check and the application cannot
 * disagree about the name. A rename that missed this script would otherwise leave it happily
 * asserting the presence of a file nothing writes any more.
 */
function markerName(root) {
	const source = readFileSync(
		path.join(root, 'packages/core/src/transfer/viewer-files.ts'),
		'utf8'
	);
	const found = source.match(/export const JEKYLL_OFF_MARKER = '([^']+)';/);
	if (!found) {
		console.error(
			'\npackages/core/src/transfer/viewer-files.ts no longer exports JEKYLL_OFF_MARKER as a ' +
				'string literal, so this check cannot know what file to look for.\n'
		);
		process.exit(1);
	}
	return found[1];
}

/**
 * `--root` exists so `check-nojekyll.test.mjs` can drive this against fixture trees. A fence whose
 * only input is this repository's real build cannot be shown to fail, and one that has never been
 * seen to fail is indistinguishable from one that always passes.
 */
const rootFlag = process.argv.indexOf('--root');
const repoRoot =
	rootFlag === -1
		? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
		: path.resolve(process.argv[rootFlag + 1] ?? '.');

const MARKER = markerName(repoRoot);

const editorBuild = path.join(repoRoot, 'apps/editor/build');
const bundleIndex = path.join(repoRoot, 'apps/editor/static/viewer-bundle/bundle.json');
const sendEngine = 'packages/core/src/remote/send-to-remote.ts';

const problems = [];

// Link 1: the editor's own build, for a forker who deploys from a branch.
if (!existsSync(editorBuild) || !statSync(editorBuild).isDirectory()) {
	problems.push('apps/editor/build does not exist, so this check could not run. Build first.');
} else if (!existsSync(path.join(editorBuild, MARKER))) {
	problems.push(
		`apps/editor/build/${MARKER} is missing.\n` +
			`  A fork deployed to GitHub Pages from a branch would 404 everything under _app/.\n` +
			`  Restore apps/editor/static/${MARKER} (an empty file).`
	);
}

// Link 2, from the other side: the marker must **not** be in the staged bundle. If it is, somebody
// has put it back in `apps/viewer/static/` and the site write is fetching an empty file over HTTP
// again — which is dead Share Links on any host that hides dotfiles, `vite preview` among them.
if (!existsSync(bundleIndex)) {
	problems.push(
		`${path.relative(repoRoot, bundleIndex)} does not exist, so this check could not run.\n` +
			'  Run: pnpm --filter @ballastella/editor run stage:viewer'
	);
} else {
	let staged;
	try {
		staged = JSON.parse(readFileSync(bundleIndex, 'utf8'));
	} catch (error) {
		problems.push(`${path.relative(repoRoot, bundleIndex)} is not readable JSON: ${error.message}`);
	}
	const carried = staged?.files?.find((file) => file?.path?.endsWith(MARKER));
	if (carried) {
		problems.push(
			`The staged viewer bundle carries ${MARKER} as "${carried.path}", so the site write would ` +
				`fetch it.\n` +
				`  An empty file is not worth a round trip, and it makes Share Links depend on\n` +
				`  the authoring host serving dotfiles — which vite preview does not, and nor do many\n` +
				`  static hosts. writePublishedSite authors this file; see JEKYLL_OFF_MARKER_FILE.\n` +
				`  Remove apps/viewer/static/${MARKER}.`
		);
	}
}

// Link 3: the engine that sends to a Remote authors the marker into every commit. What that
// commit *held* is a runtime fact, asserted against the fake in `send-to-remote.test.ts`; what a
// script can see is that the engine still names the constant at all. It stops naming it the moment
// the block that writes it goes — the import would be unused, and the next hand to tidy that removes
// the last mention.
if (!existsSync(path.join(repoRoot, sendEngine))) {
	problems.push(`${sendEngine} does not exist, so this check could not run.`);
} else if (!readFileSync(path.join(repoRoot, sendEngine), 'utf8').includes('JEKYLL_OFF_MARKER')) {
	problems.push(
		`${sendEngine} no longer names JEKYLL_OFF_MARKER, so a Sync may be sending commits\n` +
			`  with no ${MARKER} in them.\n` +
			`  Every commit that carries a site must hold it at the tree root, whether or not the\n` +
			`  Workspace holds one — the Remote is served by a branch deploy, which runs Jekyll, and\n` +
			`  a Reader would meet a blank page.\n` +
			`  See the ${MARKER} assertions in packages/core/src/remote/send-to-remote.test.ts.`
	);
}

if (problems.length > 0) {
	console.error(
		`\n${MARKER} is not arranged as it has to be:\n\n` +
			problems.map((problem) => `- ${problem}`).join('\n\n') +
			'\n\nSee docs/hosting.md and ADR-0045.\n'
	);
	process.exit(1);
}

console.log(
	`OK: ${MARKER} ships in the editor's build, the site write authors it rather than fetching it, and ` +
		`the engine that syncs with a Remote still spells it from the constant for every commit that ` +
		`carries a site.`
);
