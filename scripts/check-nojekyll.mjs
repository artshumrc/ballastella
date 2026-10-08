#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { failProblems, rootFromArgv } from './fence.mjs';

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

const repoRoot = rootFromArgv();
const MARKER = markerName(repoRoot);
const editorBuild = path.join(repoRoot, 'apps/editor/build');
const bundleIndex = path.join(repoRoot, 'apps/editor/static/viewer-bundle/bundle.json');
const sendEngine = 'packages/core/src/remote/send-to-remote.ts';
const problems = [];

if (!existsSync(editorBuild) || !statSync(editorBuild).isDirectory()) {
	problems.push('apps/editor/build does not exist, so this check could not run. Build first.');
} else if (!existsSync(path.join(editorBuild, MARKER))) {
	problems.push(
		`apps/editor/build/${MARKER} is missing.\n` +
			`  A fork deployed to GitHub Pages from a branch would 404 everything under _app/.\n` +
			`  Restore apps/editor/static/${MARKER} (an empty file).`
	);
}

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

failProblems(
	`${MARKER} is not arranged as it has to be`,
	problems,
	'\nSee docs/hosting.md and ADR-0045.\n'
);

console.log(
	`OK: ${MARKER} ships in the editor's build, the site write authors it rather than fetching it, and ` +
		`the engine that syncs with a Remote still spells it from the constant for every commit that ` +
		`carries a site.`
);
