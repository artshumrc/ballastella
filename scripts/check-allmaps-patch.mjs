// The `@allmaps/render` patch is applied, and applied to the version we think it is.
//
// `patches/@allmaps__render@1.0.0-beta.83.patch` works around **two** upstream defects, and both of
// them fail silently, which is why they are guarded here rather than trusted.
//
//   1. Warped rendering goes blank: `fetchFn` is passed into a Comlink worker unproxied, every tile
//      fails with DataCloneError, and upstream logs and swallows it. Ticket 06 recorded the
//      diagnosis; the patch header records the fix.
//   2. A refused `info.json` becomes an uncaught page error: `WebGL2Renderer.render` called
//      `loadMissingImagesInViewport()` and dropped the returned promises, while upstream's three
//      other renderers all wrap the same call in `Promise.allSettled`. Ticket 04 of the
//      `nothing-fails-silently` epic; measured at three failures in eight runs before the fix.
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
// ⚠ **This check has now been wrong twice, in the same way, and the positive control below is the
// answer to both.** The first spelling looked for
// `Promise.allSettled(this.loadMissingImagesInViewport())`; the second for
// `void Promise.allSettled(`. Neither could fail, because both strings also appear in the patch's
// OWN EXPLANATORY COMMENT in the very file being read — so deleting the line of code, or swapping
// `allSettled` for `all`, or calling `allSettled([])` beside an unhandled call, all left the check
// green. A regex fence's way of dying is silent, and reading it found neither mistake.
//
// So the predicate is a function, comments are not code, and `KNOWN_BAD` runs it against every
// mutation that was measured green. That is the shape CONTRIBUTING requires and that
// `check-e2e-network-fence.mjs`, `check-alignment-writers.mjs` and `check-workspace-rooted-paths.mjs`
// all use.

/**
 * `source` with its comment lines removed, so that a comment can never satisfy a code check.
 *
 * Whole lines only — a line whose first non-space characters are `//`, and every line inside a
 * `/* … *\/` block. That is exactly what the patch adds, and it is the conservative choice: a
 * trailing `//` stripped mid-line could delete real code and turn a failing check green, which is
 * the failure mode this whole comment is about.
 */
const codeOf = (source) => {
	const kept = [];
	let inBlock = false;
	for (const line of source.split('\n')) {
		const trimmed = line.trim();
		if (inBlock) {
			if (trimmed.includes('*/')) inBlock = false;
			continue;
		}
		if (trimmed.startsWith('/*')) {
			if (!trimmed.includes('*/')) inBlock = true;
			continue;
		}
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
		kept.push(line);
	}
	return kept.join('\n');
};

/** Where the array of promises has to be going, immediately before the call that produces it. */
const HANDED_TO_ALLSETTLED = /Promise\s*\.\s*allSettled\(\s*$/;

const CALL = 'this.loadMissingImagesInViewport()';

/**
 * Why `source` is not patched, or `null` when it is.
 *
 * ⚠ **Every call site is checked, not "is there a good one somewhere".** The check is that each
 * occurrence of the call is handed straight to `Promise.allSettled` — so a second call site added by
 * a version move, beside a first one the patch still applies to perfectly, is caught. pnpm applying
 * a patch says nothing whatever about a call site that did not exist when the patch was written.
 */
const dropsTheImagePromises = (source) => {
	const code = codeOf(source);
	let found = 0;
	for (let at = code.indexOf(CALL); at !== -1; at = code.indexOf(CALL, at + CALL.length)) {
		found += 1;
		if (!HANDED_TO_ALLSETTLED.test(code.slice(0, at))) {
			return `a call to \`loadMissingImagesInViewport()\` drops the promises it returns`;
		}
	}
	if (found === 0) return '`loadMissingImagesInViewport()` is not called at all any more';
	return null;
};

// ── Positive control ──────────────────────────────────────────────────────────────────────────
//
// Every entry below is a mutation that was **measured green** against an earlier spelling of this
// check. They are the reason it is a function rather than an `includes`.

const PATCH_COMMENT = [
	'\t\t// BALLASTELLA PATCH — ticket 04.',
	'\t\t// Upstream writes `await Promise.allSettled(this.loadMissingImagesInViewport())` in its',
	'\t\t// three other renderers. `void Promise.allSettled(...)` rather than `await` here.'
].join('\n');

const KNOWN_BAD = [
	{
		source: `${PATCH_COMMENT}\n\t\tthis.loadMissingImagesInViewport();`,
		expect: 'the hunk reverted, with the patch comment left behind'
	},
	{
		source: `${PATCH_COMMENT}\n\t\tif (x) return;`,
		expect: 'the patched line deleted outright, with only the comment left'
	},
	{
		source: `${PATCH_COMMENT}\n\t\tvoid Promise.all(this.loadMissingImagesInViewport());`,
		expect: '`Promise.all`, which rejects on the first failure instead of settling'
	},
	{
		source: `${PATCH_COMMENT}\n\t\tvoid Promise.allSettled([]);\n\t\tthis.loadMissingImagesInViewport();`,
		expect: '`allSettled` called on something else beside an unhandled call'
	},
	{
		source: '\t\tthis.loadMissingImagesInViewport();',
		expect: 'the unpatched upstream line, with no comment at all'
	},
	{
		// ⚠ **The only entry the negative half catches on its own**, and it is here because the check
		// was measured without it: with `DROPPED` deleted, every other row above was still caught by
		// `HANDLED`, so the negative half was decoration. This is the shape that makes it load-bearing
		// — the hunk applies perfectly to the call site it names while a *second* call site, added by
		// a version move, drops its promises exactly as the first one used to. pnpm applying a patch
		// says nothing whatever about that.
		source: `${PATCH_COMMENT}\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n\t\tif (x) this.loadMissingImagesInViewport();`,
		expect: 'a second, unhandled call site beside the patched one'
	}
];

/** Spellings that must keep passing: the one shipped, and the three upstream already writes. */
const KNOWN_GOOD = [
	`${PATCH_COMMENT}\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());`,
	'\t\tawait Promise.allSettled(this.loadMissingImagesInViewport());',
	'\t\tawait Promise.allSettled( this.loadMissingImagesInViewport() );'
];

const controlFailures = [];
for (const { source, expect } of KNOWN_BAD) {
	if (dropsTheImagePromises(source) === null) controlFailures.push(`${expect} is no longer caught`);
}
for (const source of KNOWN_GOOD) {
	const why = dropsTheImagePromises(source);
	if (why !== null) controlFailures.push(`a correct spelling is now refused (${why})`);
}
if (controlFailures.length > 0) {
	fail(
		'the WebGL2Renderer check no longer does what it claims — it has been wrong this way twice ' +
			`already:\n  ${controlFailures.join('\n  ')}`
	);
}

const rendererFile = join(renderDir, 'dist/renderers/WebGL2Renderer.js');
let renderer;
try {
	renderer = readFileSync(rendererFile, 'utf8');
} catch (cause) {
	fail(`could not read ${rendererFile}: ${cause.message}`);
}

const dropped = dropsTheImagePromises(renderer);
if (dropped !== null) {
	fail(
		`@allmaps/render ${resolvedVersion}'s WebGL2Renderer is NOT patched — ${dropped}. A Historical ` +
			'Map whose tiles are refused will throw an uncaught page error again, with nothing on ' +
			'screen changing. If upstream has fixed it — the other three renderers already had — drop ' +
			'this check with the hunk.'
	);
}

console.log(
	`@allmaps/render ${resolvedVersion}: patched for the unproxied fetchFn (ticket 06, warped ` +
		'rendering) and for the dropped loadMissingImagesInViewport promises (ticket 04).'
);
