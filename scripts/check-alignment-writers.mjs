#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
	assertControls,
	failWith,
	isComment,
	isTestFile,
	matchingLine,
	repoRoot,
	sourceFiles,
	specimenFailures
} from './fence.mjs';

const OWNER = 'packages/core/src/alignment/alignment-file.ts';

const exemptFiles = new Set([
	OWNER,
	'scripts/check-alignment-writers.mjs',
	'scripts/check-workspace-rooted-paths.mjs'
]);

const ALIGNMENT_PATH = `(?:alignmentPath\\s*\\(|ALIGNMENT_DIRECTORY|['"\`]alignments/)`;
const WRITE_VERBS = 'write|commit|queue';

const patterns = [
	{
		pattern: new RegExp(`\\.(?:${WRITE_VERBS})\\s*\\(\\s*${ALIGNMENT_PATH}`, 'g'),
		why: 'writes an Alignment path straight to the store or to Autosave'
	},
	{
		pattern: new RegExp(`\\[?['"\`]alignments/[^'"\`]*['"\`]\\s*\\]?\\s*[:=](?!=)`, 'g'),
		why: 'puts an Alignment into a map of files to be written'
	},
	{
		pattern: /as\s+(?:unknown\s+as\s+)?WritablePath/g,
		why: 'casts something to WritablePath, which is the one crossing the owning module makes'
	}
];

const violationIn = (line) => matchingLine(patterns, line);

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

function violationStartingOn(lines, index, ownLength, tainted = new Set(), aliases = new Set()) {
	if (isComment(lines[index])) return null;
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

function taintedNames(lines) {
	const NAME = '[A-Za-z_$][\\w$]*';
	const taints = new RegExp(
		`(?:(?:const|let|var)\\s+(${NAME})\\s*(?::\\s*[^=;(){}]+)?|(${NAME})\\s*)=\\s*[^=][^;]*?${ALIGNMENT_PATH}`,
		'g'
	);
	const rebinds = new RegExp(`\\b(?:const|let|var)\\s+(${NAME})\\s*[=:]|\\b(${NAME})\\s*=[^=]`);
	const parameters = new RegExp(`[(,]\\s*(${NAME})\\s*[,:)]`, 'g');
	const live = new Set();
	const perLine = [];
	for (const line of lines) {
		if (isComment(line)) {
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
		perLine.push(new Set(live));
	}
	return perLine;
}

function viaLocal(tainted) {
	const names = [...tainted].map(escapeName).join('|');
	return {
		pattern: new RegExp(`\\.(?:${WRITE_VERBS})\\s*\\(\\s*(?:${names})\\s*[,)]`, 'g'),
		why: 'writes a local that holds an Alignment path, which the type cannot see'
	};
}

const escapeName = (name) => name.replace(/[$]/g, '\\$');

function writerAliases(lines) {
	const aliases = new Set();
	const bound = new RegExp(
		`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*[^=;]*\\.(?:${WRITE_VERBS})\\s*\\.\\s*bind\\b`
	);
	for (const line of lines) {
		if (isComment(line)) continue;
		const match = bound.exec(line);
		if (match) aliases.add(match[1]);
	}
	return aliases;
}

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

const KNOWN_BAD = [
	{ line: "await store.write('alignments/aaa1.json', bytes(120));", expect: 'store literal' },
	{ line: 'await this.#autosave.commit(alignmentPath(imageId), starter);', expect: 'autosave' },
	{
		line: 'await store.write(`alignments/${imageId}.json`, encode(document));',
		expect: 'template'
	},
	{ line: "files['alignments/floride-1657.json'] = alignmentJson();", expect: 'file map' },
	{ line: '\t\'alignments/amsterdam-1625.json\': \'{"type":"Annotation"}\',', expect: 'file map' },
	{ line: 'await store.write(path as unknown as WritablePath, bytes);', expect: 'cast' },
	{ line: 'await this.#autosave.queue(alignmentPath(imageId), bytes);', expect: 'queue' },
	{
		line: 'await this.#autosave.commit( alignmentPath(alignment.imageId), serialiseAlignment(alignment) );',
		expect: 'wrapped autosave'
	}
];

const KNOWN_GOOD = [
	'const path = alignmentPath(alignment.imageId);',
	'const stored = await store.read(alignmentPath(imageId));',
	'const size = await store.size(alignmentPath(imageId));',
	'await store.delete(alignmentPath(imageId));',
	"expect(await store.list('alignments/')).toEqual(['alignments/floride-1657.json']);",
	"expect(alignmentPath('floride-1657')).toBe('alignments/floride-1657.json');",
	"await writeAlignmentFileReporting(port, { alignment, write: { intent: 'update' } });",
	'await store.write(imageInfoPath(imageId), bytes);',
	'await store.write(`${directory}/project.json`, bytes);',
	"if (path === 'alignments/floride-1657.json') return bytes;"
];

const controlFailures = specimenFailures(patterns, violationIn, KNOWN_BAD, KNOWN_GOOD);
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
	const block = [
		"describe('deleting a Map Image', () => {",
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
{
	const innocent = ['const p = `${directory}/project.json`;', 'await store.write(p, bytes);'];
	const tainted = taintedNames(innocent)[1];
	if (violationStartingOn(innocent, 1, innocent[1].length, tainted) !== null) {
		controlFailures.push('an ordinary path held in a local is being refused as an Alignment');
	}
	const spying = [
		'const write = store.write.bind(store);',
		'await write(imageInfoPath(id), bytes);'
	];
	if (violationStartingOn(spying, 1, spying[1].length, new Set(), writerAliases(spying)) !== null) {
		controlFailures.push('detaching a write method to spy on it is being refused');
	}
}

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

assertControls(
	controlFailures,
	'If a pattern or the owner check has been narrowed, a blind write to an Alignment shared by\n' +
		'every Project now passes silently.'
);

const files = sourceFiles().filter(({ file }) => !exemptFiles.has(file) && !isTestFile(file));
const violations = files.flatMap(({ file, text }) => {
	const lines = text.split('\n');
	const tainted = taintedNames(lines);
	const aliases = writerAliases(lines);
	return lines.flatMap((line, at) => {
		const why = violationStartingOn(lines, at, line.length, tainted[at], aliases);
		return why === null ? [] : [{ file, line: at + 1, why, text: line.trim() }];
	});
});

failWith(
	`Something other than ${OWNER} writes an Alignment (ADR-0023).`,
	violations,
	'An Alignment belongs to the Workspace and is shared by every Project that draws the map, so\n' +
		'an overwrite can destroy Control Points somebody placed in a Project you have never opened.\n\n' +
		'Every write goes through `writeAlignmentFileReporting`, which asks which of three things you mean:\n\n' +
		"  { intent: 'create' }   write only if there is nothing there worth keeping\n" +
		"  { intent: 'update' }   the user is editing the Alignment in front of them\n" +
		"  { intent: 'replace', discarding: '…' }   the user said to discard what is there, in words"
);

console.log(
	`One module writes an Alignment in the application — ${OWNER} — across ${files.length} files ` +
		`scanned (${patterns.length} spellings checked against their specimens).`
);
