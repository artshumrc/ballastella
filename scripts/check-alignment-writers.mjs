#!/usr/bin/env node
// Ticket 18: exactly one module writes `alignments/<image-id>.json`, and every caller of it says
// which of create / update / replace it means.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A FENCE HERE WHEN THERE IS ALREADY A TYPE
//
// `alignmentPath` returns an `AlignmentPath`; `ProjectStore.write`, `TempFileWriteStore.write`,
// `Autosave.commit` and `Autosave.queue` take a `WritablePath`, which an `AlignmentPath` is not.
//
// **That refuses exactly one thing: a value that came out of `alignmentPath()`.** It cannot refuse
// more, and the reason is not an oversight. `WritablePath` brands with an *optional* property
// precisely so that every ordinary `string` in the codebase — ten thousand paths that have nothing
// to do with Alignments — stays assignable without a cast. The cost of that is exact and worth
// stating plainly: any Alignment path the compiler sees as a plain `string` sails through. One
// `const p = ` + "`alignments/${id}.json`" + ` launders it.
//
// So the type is a guard against the obvious spelling, not a proof. This check covers what it
// cannot see:
//
//   1. **The path spelled out by hand.** `store.write('alignments/aaa1.json', bytes)` compiles
//      perfectly. It is also exactly how a *test fixture* writes one, which is where this would come
//      back: not in a pane, but in the arrange step of the test meant to prove the guard works.
//   2. **The path laundered through a local**, in any of the spellings above — followed here by a
//      small positional taint pass. See {@link taintedNames}.
//   3. **A detached write method**, `store.write.bind(store)`, called with an Alignment path.
//   4. **A second crossing.** `as unknown as WritablePath` written anywhere outside the one owning
//      module reopens the hole completely, and reads as a cast rather than as the decision it is.
//
// What neither layer can see is a path computed at *runtime* from data — an archive entry's own
// path, say. There are exactly **two** of those, both tar readers, and neither is fenced: they are
// routed, calling `writeAlignmentBytes` like everybody else.
//
//   - `packages/core/src/transfer/restore-workspace-tar.ts` — a Workspace backup coming back in.
//   - `packages/core/src/transfer/open-project-bundle.ts` — a handoff bundle being opened into a
//     Review Workspace (ticket 14).
//
// **Both escapes were exercised again in ticket 07, and the answers are unchanged.** A path
// laundered through a `const` template literal in `AlignmentWorkspace.svelte` was caught here, at
// the line, with the three intents printed; a path assembled at runtime from three fragments
// (`folder + imageId + suffix`) passed **both** `pnpm check` and this fence. That second one is the
// gap stated above, measured rather than assumed, and it is still the honest limit: the cheap ways
// in are closed and the remaining ones are conspicuous.
//
// Ticket 07 added `writeAlignmentFileReporting` beside `writeAlignmentFile` — the same function with
// the concurrency report attached, and `writeAlignmentFile` delegates to it. It is a third export of
// the one owning module rather than a third writer, so nothing here changes: the crossing from
// `AlignmentPath` to `WritablePath` is still the single cast in `alignment-file.ts`.
//
// This paragraph named one file, "the Project-zip importer", which ticket 14 deleted along with the
// whole zip path. A fence whose honesty statement describes a file that is not there any more is a
// fence nobody can check the honesty of, so the list is kept current here rather than in a ticket.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY EITHER GUARD EXISTS AT ALL
//
// ADR-0023 made an Alignment belong to the **Workspace**, shared by every Project that uses that
// map. Before, an Alignment belonged to one Project and clobbering it could only cost you the work
// in front of you; now it can cost somebody else's afternoon in a Project you are not looking at.
//
// Nothing in the code was changed to reflect what that means for a write, and **two blind
// overwrites of that file were then written independently**: ticket 02's community-Alignment import
// and ticket 03's Align route. Ticket 02's starter path, two lines from its own unguarded write,
// guards correctly — so the same author wrote the check and missed the hole beside it. A third
// existence check, spelled differently again, was found in the since-deleted Project-zip importer during this
// ticket's review; it was not a live overwrite, but it was a third answer to one question. Two
// authors reaching for the same mistake is a missing invariant, not two lapses.
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
 * Every verb that puts bytes at a path.
 *
 * **`queue` is in this list because leaving it out was the largest hole in the first cut.**
 * `Autosave.queue` reaches `store.write` on a debounce exactly as `commit` does, so a fence — and a
 * type — that covered only `commit` covered nothing: the pending bytes land anyway, and nobody is
 * even awaiting them. The proof was inside the branch that shipped, in `autosave.test.ts`.
 */
const WRITE_VERBS = 'write|commit|queue';

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
		// `this.store` spellings of all three verbs.
		pattern: new RegExp(`\\.(?:${WRITE_VERBS})\\s*\\(\\s*${ALIGNMENT_PATH}`, 'g'),
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
function violationStartingOn(lines, index, ownLength, tainted = new Set(), aliases = new Set()) {
	if (/^\s*(?:\/\/|\*|\/\*)/.test(lines[index])) return null;
	const text = joinedFrom(lines, index);
	const all = [
		...patterns,
		...(tainted.size === 0 ? [] : [viaLocal(tainted)]),
		...(aliases.size === 0 ? [] : [viaAlias(aliases)])
	];
	for (const { pattern, why } of all) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			if (match.index < ownLength) return why;
		}
	}
	return null;
}

/**
 * The names in this file that hold an Alignment path, so a write through one is caught.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY A TAINT PASS AND NOT ANOTHER REGEX
 *
 * The first cut of this fence was defeated by one local variable, and a review proved it against
 * this very repository:
 *
 *     const p = `alignments/${id}.json`;   await store.write(p, bytes);   // passed
 *     const p = ALIGNMENT_DIRECTORY + '/' + id + '.json';                 // passed
 *
 * The type does not stop either — a template literal is a plain `string`, and `WritablePath` is a
 * `string` with an *optional* phantom property, so every ordinary string is assignable to it by
 * design. That is what lets the other ten thousand paths in this codebase keep working, and it is
 * also the precise limit of what the brand can refuse: values that came out of `alignmentPath()`.
 * One `const` launders the path past it.
 *
 * So the path is followed through the name it is bound to. This is deliberately shallow — one file,
 * one hop, no control flow — because it is a fence and not a type checker. What it buys is that the
 * cheapest way around the guard is no longer cheap.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IT IS POSITIONAL, BECAUSE A NAME IS NOT TAINTED FOREVER
 *
 * `path` is the most reused identifier in this codebase. A file-wide set of names produced three
 * false positives immediately — `editor-session.svelte.ts` binds `path` to an Alignment path in one
 * method and to an *Annotation* path in another, and takes it as a parameter in a third. Refusing
 * those would train everybody to reach for the opt-out, which is how a fence stops meaning
 * anything.
 *
 * So taint is tracked as it changes down the file: a binding to an Alignment path taints the name,
 * and any *other* binding of the same name — including its appearance in a parameter list — clears
 * it. Still one file and no control flow. It is a fence, not a type checker; what it has to be is
 * right about the code that is actually here, and honest about the rest.
 *
 * @returns for each line, the set of names holding an Alignment path at that point.
 */
function taintedNames(lines) {
	const NAME = '[A-Za-z_$][\\w$]*';
	// `const p: StorePath = <alignment path>` and the bare `p = <alignment path>`.
	//
	// **The type annotation may not contain a bracket**, and that is load-bearing rather than
	// tidiness. An earlier version allowed `[^=;]+` there, which on a single line containing both a
	// parameter list and a declaration let the engine bind NAME to a *parameter* and swallow
	// everything up to the declaration's `=` as its "annotation" — so `p` was never tainted and
	// `const p = ` + "`alignments/${id}.json`" + `; await s.write(p, b);` on one line went straight
	// through. It was found by writing the escape out and watching it pass.
	//
	// Global, and every match on the line is taken: one line can declare more than one name.
	const taints = new RegExp(
		`(?:(?:const|let|var)\\s+(${NAME})\\s*(?::\\s*[^=;(){}]+)?|(${NAME})\\s*)=\\s*[^=][^;]*?${ALIGNMENT_PATH}`,
		'g'
	);
	// Any other binding of a name: a declaration, an assignment, or a parameter.
	const rebinds = new RegExp(`\\b(?:const|let|var)\\s+(${NAME})\\s*[=:]|\\b(${NAME})\\s*=[^=]`);
	// `(path, bytes) =>` and `(path: StorePath)` — the name is a parameter here, not the outer local.
	const parameters = new RegExp(`[(,]\\s*(${NAME})\\s*[,:)]`, 'g');

	const live = new Set();
	const perLine = [];
	for (const line of lines) {
		if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) {
			perLine.push(new Set(live));
			continue;
		}
		if (/=>|\bfunction\b/.test(line)) {
			let parameter;
			parameters.lastIndex = 0;
			while ((parameter = parameters.exec(line)) !== null) live.delete(parameter[1]);
		}
		const rebound = rebinds.exec(line);
		if (rebound) live.delete(rebound[1] ?? rebound[2]);
		taints.lastIndex = 0;
		let tainted;
		while ((tainted = taints.exec(line)) !== null) live.add(tainted[1] ?? tainted[2]);
		// After this line's own bindings, so `const p = alignmentPath(id)` taints from its own line and
		// a write on that same line is caught.
		perLine.push(new Set(live));
	}
	return perLine;
}

/** A write whose first argument is one of `tainted`. Built per line, so the names are live ones. */
function viaLocal(tainted) {
	const names = [...tainted].map(escapeName).join('|');
	return {
		pattern: new RegExp(`\\.(?:${WRITE_VERBS})\\s*\\(\\s*(?:${names})\\s*[,)]`, 'g'),
		why: 'writes a local that holds an Alignment path, which the type cannot see'
	};
}

const escapeName = (name) => name.replace(/[$]/g, '\\$');

/**
 * Names bound to a store write method taken off its object — `const w = store.write.bind(store)`.
 *
 * A *source* rather than a violation, which is the difference between a fence and a nuisance:
 * `.bind` on a write is ordinary and appears twice in this repository, both times to spy on writes
 * in a test. What is not ordinary is calling the result with an Alignment path, and that is what
 * {@link viaAlias} refuses. Detaching the method is only a way around this check if it is then used
 * as one.
 */
function writerAliases(lines) {
	const aliases = new Set();
	const bound = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*[^=;]*\\.(?:${WRITE_VERBS})\\s*\\.\\s*bind\\b`
	);
	for (const line of lines) {
		if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
		const match = bound.exec(line);
		if (match) aliases.add(match[1]);
	}
	return aliases;
}

/** A call to a detached write method with an Alignment path. */
function viaAlias(aliases) {
	const names = [...aliases].map(escapeName).join('|');
	return {
		pattern: new RegExp(`\\b(?:${names})\\s*\\(\\s*${ALIGNMENT_PATH}`, 'g'),
		why: 'calls a detached store write method with an Alignment path'
	};
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
	{ line: 'await this.#autosave.queue(alignmentPath(imageId), bytes);', expect: 'queue' },
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
// ── The escapes a review proved against the first cut ─────────────────────────────────────────
//
// Each is a *sequence*: a name bound to an Alignment path, and then a write through that name. All
// three passed the fence as originally written, which is why they are specimens now rather than
// prose. If `taintedNames` or `viaLocal` stops working, these stop being caught and this fails.
for (const { lines, at, expect } of [
	{
		lines: ['const p = `alignments/${id}.json`;', 'await store.write(p, bytes);'],
		at: 1,
		expect: 'a template literal laundered through a local'
	},
	{
		lines: ["const p = ALIGNMENT_DIRECTORY + '/' + id + '.json';", 'await store.write(p, bytes);'],
		at: 1,
		expect: 'a concatenation laundered through a local'
	},
	{
		lines: ['const p = alignmentPath(id);', 'await autosave.queue(p, bytes);'],
		at: 1,
		expect: 'the helper laundered through a local and queued'
	},
	{
		lines: ['const w = store.write.bind(store);', "await w('alignments/aaa1.json', bytes);"],
		at: 1,
		expect: 'a write method detached with bind and called with an Alignment path'
	},
	{
		// **All on one line, beside a parameter list**, which is the form that slipped through the
		// remediation's own first attempt: the binding regex bound to a parameter and swallowed the
		// declaration whole. Found by writing the escape out and watching it pass, so it is a specimen
		// now rather than a paragraph.
		lines: [
			'export async function f(s: ProjectStore, id: string, b: Bytes) { ' +
				'const p = `alignments/${id}.json`; await s.write(p, b); }'
		],
		at: 0,
		expect: 'a declaration and a write on one line, after a parameter list'
	}
]) {
	const tainted = taintedNames(lines)[at];
	const aliases = writerAliases(lines);
	if (violationStartingOn(lines, at, lines[at].length, tainted, aliases) === null) {
		controlFailures.push(`${expect} is no longer caught: ${lines.join(' ⏎ ')}`);
	}
}
// And a local that holds something else must not be caught, or every `write` in the repo is one.
{
	const innocent = ['const p = `${directory}/project.json`;', 'await store.write(p, bytes);'];
	const tainted = taintedNames(innocent)[1];
	if (violationStartingOn(innocent, 1, innocent[1].length, tainted) !== null) {
		controlFailures.push('an ordinary path held in a local is being refused as an Alignment');
	}
	// Detaching a write to spy on it is ordinary and happens twice in this repository. Only calling
	// the detached method with an Alignment path is the escape.
	const spying = [
		'const write = store.write.bind(store);',
		'await write(imageInfoPath(id), bytes);'
	];
	if (violationStartingOn(spying, 1, spying[1].length, new Set(), writerAliases(spying)) !== null) {
		controlFailures.push('detaching a write method to spy on it is being refused');
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
	const tainted = taintedNames(lines);
	const aliases = writerAliases(lines);
	lines.forEach((line, at) => {
		const why = violationStartingOn(lines, at, line.length, tainted[at], aliases);
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
	`One module writes an Alignment in the application — ${OWNER} — across ${files.length} files ` +
		`scanned (ticket 18; ${patterns.length} spellings checked against their specimens). ` +
		`${optedOut.length} fixture write${optedOut.length === 1 ? '' : 's'} in ` +
		`${modules.size} file${modules.size === 1 ? '' : 's'} are opted out with a reason, listed below.`
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
