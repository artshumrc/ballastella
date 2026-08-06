#!/usr/bin/env node
// ADR-0023: a Historical Map's pyramid and its Alignment live at the **Workspace** root, shared by
// every Project. No module may resolve either of them relative to a Project directory.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A FENCE AND NOT A CODE REVIEW
//
// `createStoreImageFetch` is the ADR-0011 injection shim that resolves the ADR-0004 `unset.invalid`
// placeholder host, and SPEC calls the invariant it upholds the most fragile in the project. Rooting it
// at the Workspace is the riskiest single change in the `workspace-and-layers` epic for one reason:
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
// because the assertion there *is* naming the catalog; there is no equivalent reason here.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source trees a Project-rooted image path could be written in. */
const scannedRoots = ['packages/core/src', 'apps/editor/src', 'apps/viewer/src', 'scripts', 'e2e'];

/**
 * The modules that own the Workspace's layout, and are therefore allowed to name it.
 *
 * Kept short on purpose. These four are the writer and the readers of the pyramid layout — the two
 * modules that *define* the paths, the store layer that is handed arbitrary ones, and the injection
 * layer that turns a placeholder URL back into one. Adding a fifth is the change this fence exists to
 * make somebody argue for.
 */
const exemptPrefixes = [
	'packages/core/src/store/',
	'packages/core/src/injection/',
	'packages/core/src/project/image-files.ts',
	'packages/core/src/alignment/alignment.ts',
	// The fence itself, and its own documentation of the pattern it refuses.
	'scripts/check-workspace-rooted-paths.mjs'
];

const isExempt = (relative) =>
	exemptPrefixes.some((prefix) => relative === prefix || relative.startsWith(prefix));

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
 * The four ways a Project directory gets prefixed onto a shared path, as patterns.
 *
 * Regexes rather than a parser, and they can afford to be: the input is this repository's own
 * TypeScript, where all four forms are one line long and conventional. Each pattern requires the
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
	}
];

const files = scannedRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];

for (const absolute of files) {
	const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
	if (isExempt(relative)) continue;

	const lines = readFileSync(absolute, 'utf8').split('\n');
	lines.forEach((line, index) => {
		// Comments are prose, not dependencies — the same call `check-base-map-catalog.mjs` makes about
		// a variant named in a sentence.
		if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
		for (const { pattern, why } of patterns) {
			pattern.lastIndex = 0;
			if (pattern.test(line)) {
				violations.push({ file: relative, line: index + 1, why, text: line.trim() });
				break;
			}
		}
	});
}

if (violations.length > 0) {
	console.error(
		`\nA Historical Map or Alignment path is built from a Project directory (ADR-0023).\n`
	);
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}  ${violation.why}`);
		console.error(`    ${violation.text}`);
	}
	console.error(
		'\nHistorical Maps and Alignments live at the Workspace root and are shared by every Project.\n' +
			'`imageDirectory`, `imageInfoPath`, `imageManifestPath`, `referencedImagePath`, and\n' +
			'`alignmentPath` each already return the complete store path — use one on its own.\n\n' +
			'This is fenced rather than reviewed because getting it wrong does not raise an error: the\n' +
			'ADR-0011 injection shim answers a Project-rooted request with a *different map*, drawn at a\n' +
			'plausible size in the right pane, with nothing logged (ADR-0004, and SPEC on the most\n' +
			'fragile invariant in the project).\n'
	);
	process.exit(1);
}

console.log(
	`No image or Alignment path is built from a Project directory in ${files.length} files ` +
		`(ADR-0023; ${exemptPrefixes.length} owning modules exempt).`
);

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
