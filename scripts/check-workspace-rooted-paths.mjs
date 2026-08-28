#!/usr/bin/env node
// ADR-0023: a Map Image's pyramid and its Alignment live at the **Workspace** root, shared by
// every Project. No module may resolve either of them relative to a Project directory.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A FENCE AND NOT A CODE REVIEW
//
// `createStoreImageFetch` is the ADR-0011 injection shim that resolves the ADR-0004 `unset.invalid`
// placeholder host, and the invariant it upholds is the most fragile in the project — the header of
// `packages/core/src/injection/store-image-fetch.ts` says why. Rooting it at the Workspace was the
// riskiest single step of the move to Workspace-rooted paths for one reason:
// **its failure mode is not an error.** Prefix a Project directory back onto an image path and the shim
// does not throw, does not 404 in a way anyone notices, and does not log — it answers with a pyramid
// from somewhere else, at a plausible size, in the right pane. A scholar sees somebody else's map where
// their own should be, and nothing anywhere says so.
//
// A test cannot catch the general case, because the mistake is a *new* call site written later. So the
// rule is mechanical: the string `<something>/images/…` or `<something>/alignments/…` must not be built
// anywhere. Every legitimate image and Alignment path is already a complete store path — `imageDirectory`,
// `imageInfoPath`, `imageManifestPath`, `referencedImagePath`, and `alignmentPath` all return one — so
// prefixing anything onto one is always the defect and never a style choice.
//
// **Test and e2e files are deliberately not exempt.** They are where a Project-rooted path is most
// likely to be written from muscle memory, and a fixture that seeds `<project>/images/…` makes every
// assertion above it vacuous while staying green. `check-base-map-catalog.mjs` exempts its tests
// because the assertion there *is* naming the catalog; there is no equivalent reason here. The
// exemptions below are therefore *files* and never directories: a directory prefix would exempt the
// tests of the modules it covers, including `injection/store-image-fetch.test.ts`, which is the test
// guarding the one function whose failure mode this whole fence is about.
//
// **The one opt-out is a per-line pragma**, `project-rooted-path-is-the-fixture: <reason>` in a
// comment on the offending line or on the line directly above it. It covers that one line, needs a
// reason of a sentence's length, and has no file-level or directory-level form, because there is
// exactly one honest use for it: a test that seeds a Project-rooted path *as the specimen*, to assert
// that the code under test ignores it. There are four of those, all decoys. Written anywhere else it
// is a claim, in a diff, on the line that makes it — and every use is listed in this check's own
// output whether or not anything is wrong, so they cannot accumulate unremarked.
//
// **The patterns are covered by a positive control** (`KNOWN_BAD` / `KNOWN_GOOD` below), which runs
// before the scan and fails if the patterns no longer match the spellings they exist to catch, or if
// they have grown to match a legitimate one. The rule is that a fence
// that passes whatever the code does is worse than no fence, because it is read as evidence — and a
// regex fence's way of becoming vacuous is silent, since a pattern that matches nothing and a tree
// with nothing to match print the same success line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source trees a Project-rooted image path could be written in. */
const scannedRoots = [
	'packages/core/src',
	'packages/ui/src',
	'apps/editor/src',
	'apps/viewer/src',
	'scripts',
	'e2e'
];

/**
 * The modules that own the Workspace's layout, and are therefore allowed to name it.
 *
 * Kept short on purpose, and **one source file each** — never a directory. These four are the writer
 * and the readers of the pyramid layout: the two modules that *define* the paths, the store layer that
 * is handed arbitrary ones, and the injection layer that turns a placeholder URL back into one. Adding
 * a fifth is the change this fence exists to make somebody argue for.
 *
 * Their tests are **not** covered by their exemption, which is the whole reason these are files: a
 * `packages/core/src/injection/` prefix silently exempted `store-image-fetch.test.ts` too, and that
 * test is the one thing standing between the shim and the failure described above.
 *
 * None of the four trips a pattern as they are written today — they build their paths out of the
 * constants, which is the spelling this fence is asking everybody else to use. The list is therefore a
 * statement of who owns the layout rather than a set of excused lines, and the counterweight to it is
 * that every one of their tests is scanned.
 */
const exemptFiles = new Set([
	'packages/core/src/store/project-store.ts',
	'packages/core/src/injection/store-image-fetch.ts',
	'packages/core/src/project/image-files.ts',
	'packages/core/src/alignment/alignment.ts',
	// The fence itself, and its own specimens of the spellings it refuses.
	'scripts/check-workspace-rooted-paths.mjs'
]);

const isExempt = (relative) => exemptFiles.has(relative);

/** The path-building helpers that already return a complete store path. */
const PATH_HELPERS = [
	'imageDirectory',
	'imageInfoPath',
	'imageManifestPath',
	'referencedImagePath',
	'alignmentPath'
];

/** The constants naming the two shared directories. */
const PATH_CONSTANTS = ['IMAGE_DIRECTORY', 'ALIGNMENT_DIRECTORY'];

const IDENTIFIER = '[A-Za-z_$][\\w$]*';

/**
 * One path segment as `toDirectoryName` can produce it — a Project directory name is `[a-z0-9-]+`
 * and nothing else, which is what makes the literal pattern below safe to anchor at the quote.
 */
const SEGMENT = '[A-Za-z0-9_-]+';

/**
 * The five ways a Project directory gets prefixed onto a shared path, as patterns.
 *
 * Regexes rather than a parser, and they can afford to be: the input is this repository's own
 * TypeScript, where all five forms are one line long and conventional. Each pattern requires the
 * separating `/` explicitly, so `${directory}` beside an unrelated word cannot match.
 */
const patterns = [
	{
		// `${anything}/images/…` or `${anything}/alignments/…` in a template literal.
		pattern: new RegExp(`\\$\\{[^}]*\\}/(?:images|alignments)/`, 'g'),
		why: 'prefixes something onto a literal images/ or alignments/ path'
	},
	{
		// `${anything}/${imageInfoPath(id)}` — the helper already returns the whole path.
		pattern: new RegExp(`\\$\\{[^}]*\\}/\\$\\{\\s*(?:${PATH_HELPERS.join('|')})\\s*\\(`, 'g'),
		why: 'prefixes something onto a helper that already returns a Workspace path'
	},
	{
		// `${anything}/${IMAGE_DIRECTORY}/…`
		pattern: new RegExp(`\\$\\{[^}]*\\}/\\$\\{\\s*(?:${PATH_CONSTANTS.join('|')})\\s*\\}`, 'g'),
		why: 'prefixes something onto the shared directory constant'
	},
	{
		// `something + '/images/…'`, the concatenation spelling of the first pattern.
		pattern: new RegExp(`${IDENTIFIER}\\s*\\+\\s*['"\`]/(?:images|alignments)/`, 'g'),
		why: 'concatenates a literal /images/ or /alignments/ path onto something'
	},
	{
		// `'some-project/images/abc/info.json'` — the whole thing spelled out, which is how a *test*
		// writes it. The four patterns above all require a `${…}` or a `+`, so a fixture seeding a
		// Project-rooted pyramid by hand — the exact thing that makes the assertions above it vacuous
		// while staying green — went straight through.
		//
		// Anchored at the opening quote and built from path segments only, so a literal that is not a
		// store path cannot match: `'/fixtures/images/…'` and `'**/images/…'` start with a character no
		// segment may contain, `'https://host/images/…'` stops at the `:`, and `'../…/images/…'` at the
		// `.`. `'images/<id>/info.json'` with nothing before it is the *correct* spelling and is not
		// matched — the defect is precisely the segment in front of it.
		pattern: new RegExp(`['"\`](?:${SEGMENT}/)+(?:images|alignments)/`, 'g'),
		why: 'names a Project directory in front of a literal images/ or alignments/ path'
	}
];

/**
 * The per-line opt-out, and the reason it must carry.
 *
 * Deliberately not a bare token: a pragma that can be pasted in without saying anything is a pragma
 * that gets pasted in. The reason has to be a sentence's worth, and it appears in this check's output
 * whether or not anything is wrong, so the set of opted-out lines is visible without grepping for it.
 *
 * It covers **one line** — the one it is on, or the one directly below it, which is the eslint
 * spelling and the only way to say this about a path that Prettier has put on a line of its own.
 * There is no file-level form and there should not be: the claim being made is about a single path.
 */
const PRAGMA = /project-rooted-path-is-the-fixture:\s*(\S[^\n]*)/;
const MINIMUM_REASON = 20;

/** The reason on `line`'s pragma, or `null` when it has none the fence will honour. */
const pragmaOn = (line) => {
	const match = PRAGMA.exec(line ?? '');
	if (!match) return null;
	const reason = match[1].replace(/\*\/\s*$/, '').trim();
	return reason.length >= MINIMUM_REASON ? reason : null;
};

/** The reason covering the line at `index`, from the line itself or the comment above it. */
const pragmaFor = (lines, index) => {
	const own = pragmaOn(lines[index]);
	if (own !== null) return own;
	const above = lines[index - 1];
	return above !== undefined && /^\s*(?:\/\/|\*|\/\*)/.test(above) ? pragmaOn(above) : null;
};

/**
 * Why `line` is a violation, or `null`. The scan and the positive control share it, so the control
 * exercises the code that runs rather than a paraphrase of it.
 */
function violationIn(line) {
	// Comments are prose, not dependencies — the same call `check-base-map-catalog.mjs` makes about
	// a variant named in a sentence.
	if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return null;
	for (const { pattern, why } of patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(line)) return why;
	}
	return null;
}

// ── Positive control ──────────────────────────────────────────────────────────────────────────
//
// Runs before the scan, because a pattern that has stopped matching prints the same success line as
// a tree with nothing to match, and a fence must fail when it turns out to be guarding
// nothing. Every specimen here is a real spelling: the four `${…}` and `+` forms, and the bare
// literal a test fixture writes.

/** @type {{ line: string, expect: string }[]} */
const KNOWN_BAD = [
	{ line: 'const info = `${projectDirectory}/images/${imageId}/info.json`;', expect: 'template' },
	{ line: 'const info = `${directory}/${imageInfoPath(imageId)}`;', expect: 'helper' },
	{ line: 'const dir = `${directory}/${IMAGE_DIRECTORY}/${imageId}`;', expect: 'constant' },
	{ line: "const path = directory + '/alignments/' + imageId + '.json';", expect: 'concatenation' },
	{ line: "await store.write('some-project/images/decoy/info.json', bytes);", expect: 'literal' },
	{
		line: 'await store.write("amsterdam-1625/alignments/floride-1657.json", bytes);',
		expect: 'literal'
	}
];

/** Spellings that must keep passing. Every one of them is somewhere in the tree. */
const KNOWN_GOOD = [
	'const info = imageInfoPath(imageId);',
	'const info = `images/${imageId}/info.json`;',
	"await store.write('alignments/floride-1657.json', bytes);",
	"await store.write('images/abc/info.json', bytes);",
	"await page.route('**/images/aaa/remote.json', (route) => route.fulfill({}));",
	"expect(info.id).toBe('https://scholar.example/images/aaa');",
	"const fixture = '/fixtures/images/floride-1657/info.json';",
	"const fixture = '../../../../apps/editor/static/fixtures/images/floride-1657/';"
];

const controlFailures = [];

for (const { line, expect } of KNOWN_BAD) {
	if (violationIn(line) === null) {
		controlFailures.push(`the ${expect} spelling is no longer caught: ${line.trim()}`);
	}
}
for (const line of KNOWN_GOOD) {
	const why = violationIn(line);
	if (why !== null) {
		controlFailures.push(`a legitimate line is now refused (${why}): ${line.trim()}`);
	}
}
// Each pattern must earn its place, or a pattern that has quietly stopped matching hides behind one
// that still does.
for (const { pattern, why } of patterns) {
	const matched = KNOWN_BAD.some(({ line }) => {
		pattern.lastIndex = 0;
		return pattern.test(line);
	});
	if (!matched) controlFailures.push(`no specimen exercises the pattern that ${why}`);
}
// And the opt-out has to be an opt-out for exactly one line, with a reason on it. Asserted through
// `pragmaFor`, over a specimen file, so what is exercised is the arithmetic the scan below does.
const reason = 'the decoy this test asserts is ignored';
const specimen = KNOWN_BAD[4].line;
const pragmaCases = [
	{ lines: [`${specimen} // project-rooted-path-is-the-fixture: ${reason}`], at: 0, covered: true },
	{ lines: [`// project-rooted-path-is-the-fixture: ${reason}`, specimen], at: 1, covered: true },
	// One line, and one only: the line after the one the pragma covers is not covered.
	{
		lines: [`// project-rooted-path-is-the-fixture: ${reason}`, specimen, specimen],
		at: 2,
		covered: false
	},
	{ lines: [`${specimen} // project-rooted-path-is-the-fixture: why`], at: 0, covered: false },
	{ lines: ['// project-rooted-path-is-the-fixture', specimen], at: 1, covered: false },
	{ lines: [specimen], at: 0, covered: false }
];
for (const { lines, at, covered } of pragmaCases) {
	if ((pragmaFor(lines, at) !== null) !== covered) {
		controlFailures.push(
			covered
				? `an opt-out that should be honoured is not: ${lines.join(' ⏎ ')}`
				: `something that is not a reasoned opt-out is being honoured: ${lines.join(' ⏎ ')}`
		);
	}
}

if (controlFailures.length > 0) {
	console.error('\nThis check can no longer detect what it exists to detect.\n');
	for (const failure of controlFailures) console.error(`  ${failure}`);
	console.error(
		'\nThe patterns above are the whole of this fence. If one of them has been narrowed, a\n' +
			'Project-rooted path in that spelling now passes silently — which is the state this control\n' +
			'exists to make impossible to reach quietly.\n'
	);
	process.exit(1);
}

const files = scannedRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];
const optedOut = [];

for (const absolute of files) {
	const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
	if (isExempt(relative)) continue;

	const lines = readFileSync(absolute, 'utf8').split('\n');
	lines.forEach((line, index) => {
		const why = violationIn(line);
		if (why === null) return;
		const excused = pragmaFor(lines, index);
		if (excused !== null) {
			optedOut.push({ file: relative, line: index + 1, reason: excused });
			return;
		}
		violations.push({ file: relative, line: index + 1, why, text: line.trim() });
	});
}

if (violations.length > 0) {
	console.error(`\nA Map Image or Alignment path is built from a Project directory (ADR-0023).\n`);
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}  ${violation.why}`);
		console.error(`    ${violation.text}`);
	}
	console.error(
		'\nMap Images and Alignments live at the Workspace root and are shared by every Project.\n' +
			'`imageDirectory`, `imageInfoPath`, `imageManifestPath`, `referencedImagePath`, and\n' +
			'`alignmentPath` each already return the complete store path — use one on its own.\n\n' +
			'This is fenced rather than reviewed because getting it wrong does not raise an error: the\n' +
			'ADR-0011 injection shim answers a Project-rooted request with a *different map*, drawn at a\n' +
			'plausible size in the right pane, with nothing logged (ADR-0004, and the header of\n' +
			'`store-image-fetch.ts` on the most fragile invariant in the project).\n\n' +
			'A test that seeds a Project-rooted path *as its specimen* — to assert that the code under\n' +
			'test ignores it — says so on the line, with a reason:\n' +
			'  // project-rooted-path-is-the-fixture: <why this path is the thing being asserted about>\n'
	);
	process.exit(1);
}

console.log(
	`No image or Alignment path is built from a Project directory in ${files.length} files ` +
		`(ADR-0023; ${exemptFiles.size} owning modules exempt, ${patterns.length} spellings checked ` +
		`against their specimens).`
);
for (const { file, line, reason } of optedOut) {
	console.log(`  opted out: ${file}:${line} — ${reason}`);
}

/** @param {string} directory @returns {string[]} */
function walk(directory) {
	let entries;
	try {
		entries = readdirSync(directory);
	} catch {
		return [];
	}
	return entries.flatMap((entry) => {
		const absolute = path.join(directory, entry);
		if (statSync(absolute).isDirectory()) return walk(absolute);
		return /\.(ts|js|mjs|svelte)$/.test(entry) ? [absolute] : [];
	});
}
