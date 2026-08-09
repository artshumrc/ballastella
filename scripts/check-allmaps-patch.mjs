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
 * `source` with its **full-line `//` comments blanked**, and nothing else touched.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS FOUR LINES NOW, AFTER THREE CLEVERER VERSIONS EACH SHIPPED A FALSE GREEN
 *
 * The history is the argument, so it is written down rather than summarised:
 *
 *   1. `includes('Promise.allSettled(this.loadMissingImagesInViewport())')` — satisfied by the
 *      patch's own comment. Deleting the line of code left the check green.
 *   2. A line filter. It dropped any line starting with `*`, which swallows a generator method, and
 *      dropped the whole line that *closes* a block comment, which swallows code after a closing delimiter.
 *   3. A hand-rolled scanner that tracked strings and block comments. It was not regex-aware, so the
 *      `/` in an everyday `url.replace(/\/*$/, '')` opened a phantom block comment that never
 *      closed — and it blanked **the rest of the file**, hiding two unhandled call sites. Its
 *      docblock's central claim was "blanking too much hides real code and passes silently", which
 *      is precisely what it then did.
 *
 * Each attempt was more code defending a narrower claim, and each was wrong in a new way. Lexing a
 * third-party bundle by hand is a losing game; the fourth version stops playing it.
 *
 * **What is left is the one deletion that can be proved safe.** A line whose first non-whitespace
 * characters are `//` cannot be executable JavaScript: either it is a comment, or it is inside a
 * template literal or a multi-line string — in which case it is data, and data is not a call the
 * renderer makes. No other text is removed, so no other text can be hidden.
 *
 * Blanked rather than deleted so the output lines up with the input line for line, which matters
 * only when reading it: the check that follows tolerates `\s*` between its tokens, so the two are
 * equivalent to it. Said here rather than left as a claim the code does not need.
 *
 * ⚠ **The cost, stated rather than engineered around: a block comment or a string that spells the
 * identifier unhandled produces a false RED.** That is the direction this check is now allowed to be
 * wrong in — loudly, with a human reading the message — and `REFUSED_BUT_HARMLESS` below carries the
 * specimens so the trade is encoded and not merely described. The one such comment in the scanned
 * file today is the patch's own, and it is written on `//` lines for exactly this reason.
 */
const codeOf = (source) =>
	source
		.split('\n')
		.map((line) => (line.trimStart().startsWith('//') ? ' '.repeat(line.length) : line))
		.join('\n');

/** Where the call has to be going, immediately before it. */
const HANDED_TO_ALLSETTLED = /Promise\s*\.\s*allSettled\(\s*this\s*\.\s*$/;

/**
 * The method, by name rather than by call text.
 *
 * Matching `'this.loadMissingImagesInViewport()'` literally missed a second call site spelled with a
 * newline between its parentheses — invisible, and green, because a good call site existed elsewhere.
 * The name cannot be spelled two ways.
 */
const METHOD = 'loadMissingImagesInViewport';

/**
 * Why `source` is not patched, or `null` when it is.
 *
 * ⚠ **Every occurrence is checked, not "is there a good one somewhere".** A second call site added
 * by a version move, beside a first the patch still applies to perfectly, is the failure this exists
 * for: pnpm applying a patch says nothing whatever about code that did not exist when it was written.
 *
 * ⚠ **What this does and does not catch, plainly.** It catches: the hunk reverted or removed, the
 * call handed to something other than `Promise.allSettled`, and any further occurrence of the method
 * name not immediately preceded by that call. It does **not** distinguish code from a block comment
 * or a string — an occurrence in either is treated as code and refused. It cannot pass a file
 * containing an unhandled call, and that is the only property it claims.
 */
const dropsTheImagePromises = (source) => {
	const code = codeOf(source);
	let found = 0;
	for (let at = code.indexOf(METHOD); at !== -1; at = code.indexOf(METHOD, at + METHOD.length)) {
		found += 1;
		if (!HANDED_TO_ALLSETTLED.test(code.slice(0, at))) {
			return 'a call to `loadMissingImagesInViewport()` drops the promises it returns';
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
		// ⚠ **The entry that forced the "every call site" rule.** An earlier spelling asked "is there a
		// good call somewhere", which this specimen passes: the hunk applies perfectly to the call
		// site it names while a *second* call site, added by a version move, drops its promises
		// exactly as the first one used to. pnpm applying a patch says nothing whatever about a call
		// site that did not exist when the patch was written.
		source: `${PATCH_COMMENT}\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n\t\tif (x) this.loadMissingImagesInViewport();`,
		expect: 'a second, unhandled call site beside the patched one'
	},
	{
		// ⚠ The next two were each measured GREEN against the line filter this file used to have, and
		// neither was in this list — which is the argument for keeping the list honest rather than
		// long. A generator method's line begins with `*`, so a filter that drops JSDoc continuation
		// lines drops it too.
		source: `${PATCH_COMMENT}\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n\t*g() { this.loadMissingImagesInViewport(); }`,
		expect: 'a second, unhandled call in a method whose line starts with `*`'
	},
	{
		// A block comment closing mid-line with code after it — what a bundler emits around a licence
		// banner.
		source:
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n' +
			'\t\t/* banner\n\t\tmore */ this.loadMissingImagesInViewport();',
		expect: 'a second, unhandled call after a block comment closes mid-line'
	}
];

/** Spellings that must keep passing: the one shipped, and the three upstream already writes. */
const KNOWN_GOOD = [
	`${PATCH_COMMENT}\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());`,
	'\t\tawait Promise.allSettled(this.loadMissingImagesInViewport());',
	'\t\tawait Promise.allSettled( this.loadMissingImagesInViewport() );',
	// A full-line `//` comment mentioning the method unhandled: blanked, so it does not count. This
	// is the one deletion this check makes, and the patch's own comment is an instance of it.
	'\t\t// this.loadMissingImagesInViewport();\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());',
	// A trailing comment after real code, mentioning nothing.
	'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport()); // settled, not awaited'
];

/**
 * Spellings this check **refuses even though they are harmless**, listed so the trade is encoded.
 *
 * Every one is a mention of the method somewhere that is not executable code, in a position this
 * version deliberately declines to reason about. The failure is a red build with a message a human
 * reads, which is the cheap direction; the expensive direction — passing a file that really does
 * drop the promises — is the one three earlier versions took, each in a different way.
 *
 * If one of these ever appears in the scanned file, the fix is to reword it, not to make the check
 * cleverer.
 */
const REFUSED_BUT_HARMLESS = [
	{
		source:
			'\t\t/* this.loadMissingImagesInViewport(); */\n' +
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());',
		expect: 'a block comment mentioning the method unhandled'
	},
	{
		source:
			'\t\tconst what = "this.loadMissingImagesInViewport()";\n' +
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());',
		expect: 'the method named inside a string literal'
	}
];

/**
 * Sources that broke an earlier version of this check by making it delete text it should not have.
 *
 * ⚠ **This is the regression list for the whole class**, and the third false green is in it: a
 * trailing-slash-stripping regular expression, `url.replace(/\/*$/, '')`, left a bare `/*` that the
 * scanner read as an unterminated block comment and blanked the rest of the file with. Every entry
 * carries an unhandled call *after* the awkward construct, so a version that hides text hides the
 * call and passes.
 */
const MUST_STILL_SEE_THE_CALL = [
	{
		source:
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n' +
			"\t\tconst base = url.replace(/\\/*$/, '');\n" +
			'\t\tthis.loadMissingImagesInViewport();',
		expect: 'an unhandled call after a regular expression containing an escaped slash'
	},
	{
		source:
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n' +
			'\t\t/* never closed\n' +
			'\t\tthis.loadMissingImagesInViewport();',
		expect: 'an unhandled call after an unterminated block comment'
	},
	{
		source:
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n' +
			'\t\tconst s = "a // b";\n' +
			'\t\tthis.loadMissingImagesInViewport();',
		expect: 'an unhandled call after a string containing a comment opener'
	},
	{
		source:
			'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());\n' +
			'\t\tthis.loadMissingImagesInViewport(\n\t\t);',
		expect: 'a second call spelled with a newline between its parentheses'
	}
];

const controlFailures = [];
for (const { source, expect } of KNOWN_BAD) {
	if (dropsTheImagePromises(source) === null) controlFailures.push(`${expect} is no longer caught`);
}
for (const { source, expect } of MUST_STILL_SEE_THE_CALL) {
	if (dropsTheImagePromises(source) === null) controlFailures.push(`${expect} is no longer caught`);
}
for (const { source, expect } of REFUSED_BUT_HARMLESS) {
	// Asserted as refused, so that a future version quietly starting to allow one of these is a
	// change somebody has to come here and make deliberately.
	if (dropsTheImagePromises(source) === null) {
		controlFailures.push(`${expect} is now allowed — that is a change, make it on purpose`);
	}
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
