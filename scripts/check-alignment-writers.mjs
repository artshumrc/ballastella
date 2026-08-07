#!/usr/bin/env node
// Ticket 18: exactly one module writes `alignments/<image-id>.json`, and every caller of it says
// which of create / update / replace it means.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A FENCE HERE WHEN THERE IS ALREADY A TYPE
//
// `alignmentPath` returns an `AlignmentPath`; `ProjectStore.write`, `TempFileWriteStore.write` and
// `Autosave.commit` take a `WritablePath`, which an `AlignmentPath` is not. So the *helper* route
// into a blind Alignment write does not compile, and that is the primary guard — this check exists
// for the two things a type cannot see:
//
//   1. **The path spelled out by hand.** `store.write('alignments/aaa1.json', bytes)` is a plain
//      string literal, assignable to `WritablePath`, and compiles perfectly. It is also exactly how
//      a *test fixture* writes one, which is where this would come back: not in a pane, but in the
//      arrange step of the test that was supposed to prove the guard works.
//   2. **A second crossing.** `as unknown as WritablePath` written anywhere outside the one owning
//      module reopens the hole completely, and reads as a cast rather than as the decision it is.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY EITHER GUARD EXISTS AT ALL
//
// ADR-0023 made an Alignment belong to the **Workspace**, shared by every Project that uses that
// map. Before, an Alignment belonged to one Project and clobbering it could only cost you the work
// in front of you; now it can cost somebody else's afternoon in a Project you are not looking at.
//
// Nothing in the code was changed to reflect what that means for a write, and **three separate
// tickets in this epic then independently wrote a blind overwrite of that file** — in one case two
// lines from a correct guard doing exactly the right thing. Two authors reaching for the same
// mistake is a missing invariant, not two lapses.
//
// The failure mode is why this is mechanical rather than reviewed, and it is the same argument
// `check-workspace-rooted-paths.mjs` makes about a Project-rooted image path: an overwrite does not
// throw, does not log, and does not 404. It shows up as a colleague's Control Points quietly gone.
//
// **Test and e2e files are not exempt**, for the reason above: the fixture is where this hides. The
// per-line opt-out is how a test that really is seeding a file at that path says so, and every use
// of it is printed on success whether or not anything is wrong, so they cannot accumulate unremarked.
//
// **The patterns are covered by a positive control** (`KNOWN_BAD` / `KNOWN_GOOD`), which runs before
// the scan and fails if they no longer match the spellings they exist to catch or have grown to
// match a legitimate one — and so is the *owner*, which is checked to still contain the crossing and
// the three intents it is being trusted with. A fence that passes whatever the code does is worse
// than no fence, because it is read as evidence; a regex fence's way of becoming vacuous is silent,
// since a pattern that matches nothing and a tree with nothing to match print the same success line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Source trees an Alignment write could be written in. */
const scannedRoots = ['packages/core/src', 'apps/editor/src', 'apps/viewer/src', 'scripts', 'e2e'];

/**
 * The one module that may write an Alignment.
 *
 * **One file, and it is the whole point of this check** — not a directory, which would silently
 * exempt `alignment-file.test.ts` and every other test beside it. That test is where a blind write
 * would be most convenient to reach for and least visible.
 */
const OWNER = 'packages/core/src/alignment/alignment-file.ts';

const exemptFiles = new Set([
	OWNER,
	// This fence's own specimens of the spellings it refuses, and its sibling's — ADR-0023's other
	// fence keeps `store.write('alignments/…')` in its `KNOWN_GOOD`, because a bare Workspace-rooted
	// Alignment path is exactly what *that* check exists to permit.
	'scripts/check-alignment-writers.mjs',
	'scripts/check-workspace-rooted-paths.mjs'
]);

/**
 * An expression that names an Alignment's path, in the three spellings that reach one.
 *
 * `alignmentPath(` is here even though the type already refuses it at a write: the type is the
 * guard, and this is the check that the guard is *load-bearing* — if somebody widens `write` back to
 * `StorePath`, the compiler goes quiet and this does not.
 */
const ALIGNMENT_PATH = `(?:alignmentPath\\s*\\(|ALIGNMENT_DIRECTORY|['"\`]alignments/)`;

/**
 * The ways an Alignment's path reaches a write, as patterns.
 *
 * Matched against a *logical* line — a line joined with those below it until its brackets balance —
 * because Prettier puts a two-argument `commit` across four lines, and a per-line regex would see
 * the verb and the path separately and match neither.
 */
const patterns = [
	{
		// `store.write('alignments/…', …)`, `autosave.commit(alignmentPath(id), …)`, and the `#store` /
		// `this.store` spellings of both.
		pattern: new RegExp(`\\.(?:write|commit)\\s*\\(\\s*${ALIGNMENT_PATH}`, 'g'),
		why: 'writes an Alignment path straight to the store or to Autosave'
	},
	{
		// The e2e helper that seeds a file into OPFS in the page. Same act, different verb.
		pattern: new RegExp(`seedFile\\s*\\([^;]*?,\\s*${ALIGNMENT_PATH}`, 'g'),
		why: 'seeds an Alignment through the e2e page helper'
	},
	{
		// `files['alignments/x.json'] = …` and `{ 'alignments/x.json': … }` — a map of files to be
		// written, which is how the e2e fixtures and the zip tests spell a write.
		pattern: new RegExp(`\\[?['"\`]alignments/[^'"\`]*['"\`]\\s*\\]?\\s*[:=](?!=)`, 'g'),
		why: 'puts an Alignment into a map of files to be written'
	},
	{
		// A second crossing from `AlignmentPath` to `WritablePath`. There is exactly one, in the owner.
		pattern: /as\s+(?:unknown\s+as\s+)?WritablePath/g,
		why: 'casts something to WritablePath, which is the one crossing the owning module makes'
	}
];

/**
 * The per-line opt-out, and the reason it must carry.
 *
 * Deliberately not a bare token: a pragma that can be pasted in without saying anything is a pragma
 * that gets pasted in. It covers **one line** — the one it is on, or the one directly below it,
 * which is the eslint spelling and the only way to say this about a call Prettier has wrapped. There
 * is no file-level form and there should not be: the claim is about a single write.
 *
 * There is exactly one honest use for it, and it is a test seeding a file at the Alignment's path as
 * its *arrange* step — bytes of a known size for a deletion test, or a colleague's document for a
 * round-trip test — where what is wanted is a file and not an Alignment anybody could read.
 */
const PRAGMA = /alignment-write-is-the-fixture:\s*(\S[^\n]*)/;
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
 * Why `text` is a violation, or `null`. The scan and the positive control share it, so the control
 * exercises the code that runs rather than a paraphrase of it.
 */
function violationIn(text) {
	// Comments are prose, not writes — the same call `check-workspace-rooted-paths.mjs` makes.
	if (/^\s*(?:\/\/|\*|\/\*)/.test(text)) return null;
	for (const { pattern, why } of patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(text)) return why;
	}
	return null;
}

/**
 * The line at `index` joined with the ones below it until its brackets balance.
 *
 * Without this the fence is defeated by `prettier --write`, which is not a hypothetical: the blind
 * write in `editor-session.svelte.ts` that this ticket replaced was four lines long, with `commit(`
 * on one line and the Alignment path on the next, and a per-line regex saw neither.
 *
 * Bounded at {@link JOIN_LIMIT} lines, so an unbalanced bracket cannot swallow the rest of the file.
 */
const JOIN_LIMIT = 12;

function joinedFrom(lines, index) {
	let text = lines[index];
	let depth = bracketDepth(text);
	let last = index;
	while (depth > 0 && last + 1 < lines.length && last - index < JOIN_LIMIT) {
		last += 1;
		text += ` ${lines[last].trim()}`;
		depth += bracketDepth(lines[last]);
	}
	return text;
}

/**
 * Whether the violation in `text` **begins on the first line** of the join rather than on one of
 * the lines dragged in behind it.
 *
 * This is what keeps the report — and therefore the opt-out — pointing at the write itself. Without
 * it, `describe('…', () => {` is an unbalanced line that joins the twelve below it, so a write
 * eleven lines inside the block is reported against the `describe`, and a test wanting to opt out
 * has to put the pragma above a `describe` where it says nothing about the line it excuses. Every
 * line is a join start in its turn, so nothing is missed by ignoring a match that began later: it
 * is found again, and attributed correctly, when the scan reaches the line it is actually on.
 */
function violationStartingOn(lines, index, ownLength) {
	if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[index])) return null;
	const text = joinedFrom(lines, index);
	for (const { pattern, why } of patterns) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			if (match.index < ownLength) return why;
		}
	}
	return null;
}

const bracketDepth = (line) => {
	let depth = 0;
	for (const character of line) {
		if (character === '(' || character === '[' || character === '{') depth += 1;
		if (character === ')' || character === ']' || character === '}') depth -= 1;
	}
	return depth;
};

// ── Positive control ──────────────────────────────────────────────────────────────────────────
//
// Runs before the scan, because a pattern that has stopped matching prints the same success line as
// a tree with nothing to match. Every specimen is a real spelling: the two blind writes this epic
// actually shipped, the fixture spellings, and the cast.

/** @type {{ line: string, expect: string }[]} */
const KNOWN_BAD = [
	{ line: "await store.write('alignments/aaa1.json', bytes(120));", expect: 'store literal' },
	{ line: 'await this.#autosave.commit(alignmentPath(imageId), starter);', expect: 'autosave' },
	{
		line: 'await store.write(`alignments/${imageId}.json`, encode(document));',
		expect: 'template'
	},
	{ line: "await seedFile(page, 'alignments/shared.json', '{}');", expect: 'seedFile' },
	{ line: "files['alignments/floride-1657.json'] = alignmentJson();", expect: 'file map' },
	{ line: '\t\'alignments/amsterdam-1625.json\': \'{"type":"Annotation"}\',', expect: 'file map' },
	{ line: 'await store.write(path as unknown as WritablePath, bytes);', expect: 'cast' },
	// The multi-line spelling Prettier produces, as one logical line — the form the real defect took.
	{
		line: 'await this.#autosave.commit( alignmentPath(alignment.imageId), serialiseAlignment(alignment) );',
		expect: 'wrapped autosave'
	}
];

/** Spellings that must keep passing. Every one of them is somewhere in the tree, or could be. */
const KNOWN_GOOD = [
	'const path = alignmentPath(alignment.imageId);',
	'const stored = await store.read(alignmentPath(imageId));',
	'const size = await store.size(alignmentPath(imageId));',
	'await store.delete(alignmentPath(imageId));',
	"expect(await store.list('alignments/')).toEqual(['alignments/floride-1657.json']);",
	"expect(alignmentPath('floride-1657')).toBe('alignments/floride-1657.json');",
	"await writeAlignmentFile(port, { alignment, write: { intent: 'update' } });",
	'await store.write(imageInfoPath(imageId), bytes);',
	'await store.write(`${directory}/project.json`, bytes);',
	"if (path === 'alignments/floride-1657.json') return bytes;"
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
// Each pattern must earn its place, or one that has quietly stopped matching hides behind one that
// still does.
for (const { pattern, why } of patterns) {
	const matched = KNOWN_BAD.some(({ line }) => {
		pattern.lastIndex = 0;
		return pattern.test(line);
	});
	if (!matched) controlFailures.push(`no specimen exercises the pattern that ${why}`);
}
// The line-joining has to actually join, or the wrapped specimen above passes for the wrong reason.
{
	const wrapped = [
		'await this.#autosave.commit(',
		'\talignmentPath(alignment.imageId),',
		'\tserialiseAlignment(alignment)',
		');'
	];
	if (violationStartingOn(wrapped, 0, wrapped[0].length) === null) {
		controlFailures.push('a write Prettier wrapped across lines is no longer joined and caught');
	}
	// And a block opener must not be blamed for a write inside it, or the pragma that excuses a
	// fixture would have to sit above a `describe` where it describes nothing.
	const block = [
		"describe('deleting a Historical Map', () => {",
		'\tit('.concat("'takes the Alignment with it', async () => {"),
		"\t\tawait store.write('alignments/aaa1.json', bytes(120));",
		'\t});',
		'});'
	];
	if (violationStartingOn(block, 0, block[0].length) !== null) {
		controlFailures.push('a block opener is being blamed for a write on a line inside it');
	}
	if (violationStartingOn(block, 2, block[2].length) === null) {
		controlFailures.push('a write inside a block is no longer caught on its own line');
	}
}
// And the opt-out has to be an opt-out for exactly one line, with a reason on it.
{
	const reason = 'the arrange step this deletion test is about';
	const specimen = KNOWN_BAD[0].line;
	const cases = [
		{ lines: [`${specimen} // alignment-write-is-the-fixture: ${reason}`], at: 0, covered: true },
		{ lines: [`// alignment-write-is-the-fixture: ${reason}`, specimen], at: 1, covered: true },
		// One line, and one only.
		{
			lines: [`// alignment-write-is-the-fixture: ${reason}`, specimen, specimen],
			at: 2,
			covered: false
		},
		{ lines: [`${specimen} // alignment-write-is-the-fixture: why`], at: 0, covered: false },
		{ lines: ['// alignment-write-is-the-fixture', specimen], at: 1, covered: false },
		{ lines: [specimen], at: 0, covered: false }
	];
	for (const { lines, at, covered } of cases) {
		if ((pragmaFor(lines, at) !== null) !== covered) {
			controlFailures.push(
				covered
					? `an opt-out that should be honoured is not: ${lines.join(' ⏎ ')}`
					: `something that is not a reasoned opt-out is being honoured: ${lines.join(' ⏎ ')}`
			);
		}
	}
}

// ── The owner has to still be the owner ────────────────────────────────────────────────────────
//
// The scan below proves that nobody *else* writes an Alignment. On its own that is also true of a
// codebase that cannot write one at all, and of one where the owner has quietly become a passthrough
// — both of which would print the same success line. So the owner is checked for the three things it
// is being trusted with: the crossing, and each of the three intents the contract requires a caller
// to choose between.
{
	let source = '';
	try {
		source = readFileSync(path.join(repoRoot, OWNER), 'utf8');
	} catch {
		controlFailures.push(`the one module allowed to write an Alignment is missing: ${OWNER}`);
	}
	if (source !== '') {
		if (!/as\s+unknown\s+as\s+WritablePath/.test(source)) {
			controlFailures.push(
				`${OWNER} no longer crosses from AlignmentPath to WritablePath, so either it has stopped ` +
					`writing Alignments or the brand has been removed from the store`
			);
		}
		for (const intent of ['create', 'update', 'replace']) {
			if (!new RegExp(`'${intent}'`).test(source)) {
				controlFailures.push(`${OWNER} no longer offers the '${intent}' intent`);
			}
		}
	}
}

if (controlFailures.length > 0) {
	console.error('\nThis check can no longer detect what it exists to detect.\n');
	for (const failure of controlFailures) console.error(`  ${failure}`);
	console.error(
		'\nThe patterns and the owner above are the whole of this fence. If one has been narrowed or\n' +
			'removed, a blind write to an Alignment shared by every Project now passes silently — which\n' +
			'is the state this control exists to make impossible to reach quietly.\n'
	);
	process.exit(1);
}

const files = scannedRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];
const optedOut = [];

for (const absolute of files) {
	const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
	if (exemptFiles.has(relative)) continue;

	const lines = readFileSync(absolute, 'utf8').split('\n');
	lines.forEach((line, at) => {
		const why = violationStartingOn(lines, at, line.length);
		if (why === null) return;
		const excused = pragmaFor(lines, at);
		if (excused !== null) {
			optedOut.push({ file: relative, line: at + 1, reason: excused });
			return;
		}
		violations.push({ file: relative, line: at + 1, why, text: line.trim() });
	});
}

if (violations.length > 0) {
	console.error(`\nSomething other than ${OWNER} writes an Alignment (ADR-0023, ticket 18).\n`);
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}  ${violation.why}`);
		console.error(`    ${violation.text}`);
	}
	console.error(
		'\nAn Alignment belongs to the Workspace and is shared by every Project that draws the map, so\n' +
			'an overwrite can destroy Control Points somebody placed in a Project you have never opened.\n' +
			'It does not throw, does not log, and does not 404 — it is simply gone.\n\n' +
			'Every write goes through `writeAlignmentFile`, which will not let you past without saying\n' +
			'which of three things you mean:\n\n' +
			"  { intent: 'create' }   write only if there is nothing there worth keeping\n" +
			"  { intent: 'update' }   the user is editing the Alignment in front of them\n" +
			"  { intent: 'replace', discarding: '…' }   the user said to discard what is there, in words\n\n" +
			'A test seeding a file at that path *as its fixture* — bytes of a known size, or a colleague’s\n' +
			'document to read back — says so on the line, with a reason:\n' +
			'  // alignment-write-is-the-fixture: <why this write is the specimen and not a real write>\n'
	);
	process.exit(1);
}

const modules = new Set(optedOut.map(({ file }) => file));
console.log(
	`Exactly one module writes an Alignment — ${OWNER} — across ${files.length} files (ticket 18; ` +
		`${patterns.length} spellings checked against their specimens, ${optedOut.length} fixture ` +
		`write${optedOut.length === 1 ? '' : 's'} opted out in ${modules.size} file${modules.size === 1 ? '' : 's'}).`
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
