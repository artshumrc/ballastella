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
 * `source` with its **comments blanked out**, character for character, so that a comment can never
 * satisfy a code check and every offset stays where it was.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A SCANNER AND NOT A LINE FILTER
 *
 * ⚠ **The line filter this replaced deleted real code, two ways, and each produced a FALSE GREEN**
 * against this guard's own stated threat model — a second call site arriving with a version move:
 *
 *   - it dropped any line whose first non-space character was `*`, meant for a JSDoc continuation,
 *     which also swallows `*g() { this.loadMissingImagesInViewport(); }` — a generator method, valid
 *     in a class body;
 *   - it dropped the whole line that *closes* a block comment, so `more (star-slash)
 *     this.loadMissingImagesInViewport();` vanished — and a closing delimiter with code after it on
 *     the same line is a shape bundlers emit around licence banners.
 *
 * Both are `KNOWN_BAD` specimens now. The lesson is the one this file already records twice: a check
 * that deletes text in order to decide something has to be able to say exactly what it deleted.
 *
 * **The direction of every remaining approximation is deliberate.** Blanking too little makes a
 * comment look like code, which fails LOUDLY and a human reads it. Blanking too much hides real code
 * and passes silently. So:
 *
 *   - a `//` comment is recognised only at the **start of a line**. A trailing `// ...` is left in
 *     place, because deciding whether a mid-line `//` opens a comment, closes a regular expression,
 *     or sits inside a URL in a string is exactly the ambiguity that produced the last two bugs.
 *   - a block comment is matched as a span, with string literals skipped first so that a delimiter
 *     inside one cannot open a phantom comment.
 *   - string **contents** are kept. A call spelled inside a string would be read as code and
 *     refused — noisy, and in a `dist` bundle inconceivable, but wrong in the safe direction.
 */
const codeOf = (source) => {
	const out = [...source];
	const blank = (from, to) => {
		for (let at = from; at < to; at += 1) if (out[at] !== '\n') out[at] = ' ';
	};
	let at = 0;
	let lineStart = true;
	while (at < source.length) {
		const here = source[at];
		if (here === '\n') {
			lineStart = true;
			at += 1;
			continue;
		}
		if (lineStart && (here === ' ' || here === '\t')) {
			at += 1;
			continue;
		}
		// A line comment, only where a line begins with one.
		if (lineStart && here === '/' && source[at + 1] === '/') {
			const end = source.indexOf('\n', at);
			const stop = end === -1 ? source.length : end;
			blank(at, stop);
			at = stop;
			continue;
		}
		lineStart = false;
		// A block comment, wherever it starts, blanked up to and including its close.
		if (here === '/' && source[at + 1] === '*') {
			const close = source.indexOf('*/', at + 2);
			const end = close === -1 ? source.length : close + 2;
			blank(at, end);
			at = end;
			continue;
		}
		// A string literal: stepped over whole, contents kept, so its delimiters cannot open a
		// comment and a `//` in a URL cannot swallow the rest of the line.
		if (here === "'" || here === '"' || here === '`') {
			at += 1;
			while (at < source.length && source[at] !== here) {
				at += source[at] === '\\' ? 2 : 1;
			}
			at += 1;
			continue;
		}
		at += 1;
	}
	return out.join('');
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
	// A comment that *mentions* an unhandled call is not one. This is what `codeOf` exists for, and
	// the patch's own comment is an instance of it.
	'\t\t// this.loadMissingImagesInViewport();\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());',
	'\t\t/* this.loadMissingImagesInViewport(); */\n\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport());',
	// A trailing comment after real code: left in place rather than risking the line, and nothing
	// here needs it gone.
	'\t\tvoid Promise.allSettled(this.loadMissingImagesInViewport()); // settled, not awaited'
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
