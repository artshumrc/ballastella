// The `@allmaps/render` patch is applied, and applied to the version we think it is.
//
// `patches/@allmaps__render@1.0.0-beta.83.patch` works around **two** upstream defects, and both of
// them fail silently, which is why they are guarded here rather than trusted.
//
//   1. Warped rendering goes blank: `fetchFn` is passed into a Comlink worker unproxied, every tile
//      fails with DataCloneError, and upstream logs and swallows it. The patch header records both
//      the diagnosis and the fix.
//   2. A refused `info.json` becomes an uncaught page error: `WebGL2Renderer.render` called
//      `loadMissingImagesInViewport()` and dropped the returned promises, while upstream's three
//      other renderers all wrap the same call in `Promise.allSettled`. Measured at three failures in
//      eight runs before the fix.
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

// ── The second hunk: WebGL2Renderer's dropped promises ────────────────────────────────────────
//
// Checked separately because it is in a different file and fails differently: its absence is not a
// blank map but an uncaught page error on a refused `info.json`, which reaches nobody at all on a
// published site. `viewer-reader.e2e.ts` asserts the *consequence*; this asserts that the mechanism
// is still there, because pnpm applying a patch says nothing about which of its hunks survived a
// version move.
//
// ⚠ **Asked as a PRESENCE question, deliberately, after four versions that asked an absence one.**
// The first three spellings each scanned `WebGL2Renderer.js` for an *unhandled* call and each
// shipped a false green by a different route: strings that also appear in the patch's own comment;
// a line filter that deleted `*g()` methods and code after a mid-line `*/`; a comment scanner that
// read `/\/*$/` as an unterminated block comment and blanked the file to its end. The fourth kept
// only full-line `//` deletion and still let a *trailing* comment ending in `Promise.allSettled(`
// hand the next line's call to nothing — with the hunk fully reverted, exit 0.
//
// The lesson is not "scan more carefully". It is that **"is the fix here?" is decidable by string
// match and "is there no defect anywhere in this file?" is not.** Line 83 has asked the presence
// question about the other hunk since that hunk was written and has never been wrong. This now does
// the same.
//
// What this cannot catch: someone hand-editing `node_modules` to delete the patched line while
// leaving its marker comment. That is not the threat model — the threat is a version move making
// the hunk stop applying, which takes the marker with it. The behaviour has its own guard:
// `viewer-reader.e2e.ts`'s 503 test fails 4-of-4 attempts with this hunk reverted, deterministically
// rather than probabilistically, and that is the assertion that would notice an upstream fix
// arriving by some other shape.
const rendererFile = join(renderDir, 'dist/renderers/WebGL2Renderer.js');
let renderer;
try {
	renderer = readFileSync(rendererFile, 'utf8');
} catch (cause) {
	fail(`could not read ${rendererFile}: ${cause.message}`);
}

if (!renderer.includes('BALLASTELLA PATCH')) {
	fail(
		`@allmaps/render ${resolvedVersion}'s WebGL2Renderer is installed WITHOUT the second hunk. A ` +
			'Map Image whose tiles are refused will throw an uncaught page error again, with ' +
			'nothing on screen changing. Run `pnpm install` and check for a patch-apply failure. If ' +
			'upstream has fixed it — the other three renderers already had — drop this check with the hunk.'
	);
}

// The hunk is only load-bearing while upstream still drops the promises. If the method it wraps is
// gone, the patch is inert and should go rather than sit here looking like protection.
if (!renderer.includes('loadMissingImagesInViewport')) {
	fail(
		`the patch marker is present in @allmaps/render ${resolvedVersion}'s WebGL2Renderer but the ` +
			'code no longer mentions `loadMissingImagesInViewport`. The hunk is stale — re-read it ' +
			'against upstream.'
	);
}

console.log(
	`@allmaps/render ${resolvedVersion}: patched for the unproxied fetchFn (warped rendering) ` +
		'and for the dropped loadMissingImagesInViewport promises.'
);
