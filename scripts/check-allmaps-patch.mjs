// The `@allmaps/render` patch is applied, and applied to the version we think it is.
//
// `patches/@allmaps__render@1.0.0-beta.83.patch` works around an upstream defect that makes warped
// rendering silently blank: `fetchFn` is passed into a Comlink worker unproxied, every tile fails
// with DataCloneError, and upstream logs and swallows it. Ticket 06 recorded the diagnosis; the
// patch header records the fix.
//
// This check exists because of HOW that fails if it stops applying. `@allmaps/render` is not a
// direct dependency — it arrives through `@allmaps/maplibre` — so bumping *maplibre* can move
// *render* underneath us. pnpm errors on a patch whose exact version is gone, but the failure this
// guards is subtler: a patch that still applies to a file whose surrounding code has moved on, or a
// resolved version that no longer matches the one the patch names. In both cases the tiles simply
// stop arriving, on the one screen the whole application exists to produce, with nothing in the
// console. ADR-0010 already makes an `@allmaps/*` bump a migration event; this makes the patch part
// of what that migration has to check.
//
// Delete this script, the patch, and the `patchedDependencies` entry together, once upstream carries
// the fix and the version is raised past it.

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message) => {
	console.error(`check-allmaps-patch: ${message}`);
	process.exit(1);
};

const workspace = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
const declared = workspace.match(/'@allmaps\/render@([^']+)':\s*(\S+)/);
if (!declared) {
	fail(
		'no patchedDependencies entry for @allmaps/render in pnpm-workspace.yaml. If upstream has ' +
			'fixed the unproxied fetchFn, delete this script and the patch together.'
	);
}
const [, patchedVersion] = declared;

// Located through @allmaps/maplibre, which is how it actually reaches the app. Walked on disk rather
// than with `require.resolve`, because neither package exports `./package.json` — and the path is
// what a patch applies to anyway.
let renderDir;
try {
	const maplibre = realpathSync(
		join(repoRoot, 'apps', 'editor', 'node_modules', '@allmaps', 'maplibre')
	);
	renderDir = join(dirname(maplibre), 'render');
} catch (cause) {
	fail(`could not locate @allmaps/maplibre — has \`pnpm install\` run? (${cause.message})`);
}

let resolvedVersion;
try {
	resolvedVersion = JSON.parse(readFileSync(join(renderDir, 'package.json'), 'utf8')).version;
} catch (cause) {
	fail(`could not read @allmaps/render's manifest beside @allmaps/maplibre: ${cause.message}`);
}
if (resolvedVersion !== patchedVersion) {
	fail(
		`the patch names @allmaps/render ${patchedVersion} but ${resolvedVersion} is installed — ` +
			'almost certainly because @allmaps/maplibre was bumped, which moves render underneath it. ' +
			'Re-verify the patch against the new version (or drop it if upstream has fixed the ' +
			'unproxied fetchFn), then update pnpm-workspace.yaml.'
	);
}

const patchedFile = join(renderDir, 'dist/tilecache/CacheableWorkerImageDataTile.js');
let source;
try {
	source = readFileSync(patchedFile, 'utf8');
} catch (cause) {
	fail(`could not read ${patchedFile}: ${cause.message}`);
}

if (!source.includes('BALLASTELLA PATCH')) {
	fail(
		`@allmaps/render ${resolvedVersion} is installed WITHOUT the patch. Warped rendering will be ` +
			'blank and nothing will say so. Run `pnpm install` and check for a patch-apply failure.'
	);
}

// The patch is only load-bearing because the fetch it moves used to go to the worker. If upstream
// ever stops passing a fetchFn through at all, the patch is inert and should go.
if (!source.includes('this.fetchFn')) {
	fail(
		`the patch marker is present in @allmaps/render ${resolvedVersion} but the code no longer ` +
			'reads `this.fetchFn`. The patch is stale — re-read it against upstream.'
	);
}

console.log(
	`@allmaps/render ${resolvedVersion}: patched for the unproxied fetchFn (ticket 06, warped rendering).`
);
