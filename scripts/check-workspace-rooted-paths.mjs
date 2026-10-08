#!/usr/bin/env node

import {
	assertControls,
	failWith,
	isComment,
	matchingLine,
	sourceFiles,
	specimenFailures
} from './fence.mjs';

const exemptFiles = new Set([
	'packages/core/src/store/project-store.ts',
	'packages/core/src/injection/store-image-fetch.ts',
	'packages/core/src/project/image-files.ts',
	'packages/core/src/alignment/alignment.ts',
	'scripts/check-workspace-rooted-paths.mjs'
]);

const PATH_HELPERS = [
	'imageDirectory',
	'imageInfoPath',
	'imageManifestPath',
	'referencedImagePath',
	'alignmentPath'
];

const PATH_CONSTANTS = ['IMAGE_DIRECTORY', 'ALIGNMENT_DIRECTORY'];
const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const SEGMENT = '[A-Za-z0-9_-]+';

const patterns = [
	{
		pattern: new RegExp(`\\$\\{[^}]*\\}/(?:images|alignments)/`, 'g'),
		why: 'prefixes something onto a literal images/ or alignments/ path'
	},
	{
		pattern: new RegExp(`\\$\\{[^}]*\\}/\\$\\{\\s*(?:${PATH_HELPERS.join('|')})\\s*\\(`, 'g'),
		why: 'prefixes something onto a helper that already returns a Workspace path'
	},
	{
		pattern: new RegExp(`\\$\\{[^}]*\\}/\\$\\{\\s*(?:${PATH_CONSTANTS.join('|')})\\s*\\}`, 'g'),
		why: 'prefixes something onto the shared directory constant'
	},
	{
		pattern: new RegExp(`${IDENTIFIER}\\s*\\+\\s*['"\`]/(?:images|alignments)/`, 'g'),
		why: 'concatenates a literal /images/ or /alignments/ path onto something'
	},
	{
		pattern: new RegExp(`['"\`](?:${SEGMENT}/)+(?:images|alignments)/`, 'g'),
		why: 'names a Project directory in front of a literal images/ or alignments/ path'
	}
];

const PRAGMA = /project-rooted-path-is-the-fixture:\s*(\S[^\n]*)/;
const MINIMUM_REASON = 20;

const pragmaOn = (line) => {
	const match = PRAGMA.exec(line ?? '');
	if (!match) return null;
	const reason = match[1].replace(/\*\/\s*$/, '').trim();
	return reason.length >= MINIMUM_REASON ? reason : null;
};

const pragmaFor = (lines, index) =>
	pragmaOn(lines[index]) ?? (isComment(lines[index - 1]) ? pragmaOn(lines[index - 1]) : null);

const violationIn = (line) => matchingLine(patterns, line);

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

const controlFailures = specimenFailures(patterns, violationIn, KNOWN_BAD, KNOWN_GOOD);
const reason = 'the decoy this test asserts is ignored';
const specimen = KNOWN_BAD[4].line;
const pragmaCases = [
	{ lines: [`${specimen} // project-rooted-path-is-the-fixture: ${reason}`], at: 0, covered: true },
	{ lines: [`// project-rooted-path-is-the-fixture: ${reason}`, specimen], at: 1, covered: true },
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

assertControls(
	controlFailures,
	'If a pattern has been narrowed, a Project-rooted path in that spelling now passes silently.'
);

const files = sourceFiles().filter(({ file }) => !exemptFiles.has(file));
const violations = [];
const optedOut = [];
for (const { file, text } of files) {
	const lines = text.split('\n');
	lines.forEach((line, index) => {
		const why = violationIn(line);
		if (why === null) return;
		const excused = pragmaFor(lines, index);
		if (excused !== null) optedOut.push({ file, line: index + 1, reason: excused });
		else violations.push({ file, line: index + 1, why, text: line.trim() });
	});
}

failWith(
	'A Map Image or Alignment path is built from a Project directory (ADR-0023).',
	violations,
	'Map Images and Alignments live at the Workspace root and are shared by every Project.\n' +
		'`imageDirectory`, `imageInfoPath`, `imageManifestPath`, `referencedImagePath`, and\n' +
		'`alignmentPath` each already return the complete store path — use one on its own.\n\n' +
		'Getting it wrong raises no error: the injection shim answers a Project-rooted request with a\n' +
		'*different map*, at a plausible size, with nothing logged.\n\n' +
		'A test that seeds a Project-rooted path *as its specimen* says so on the line, with a reason:\n' +
		'  // project-rooted-path-is-the-fixture: <why this path is the thing being asserted about>'
);

console.log(
	`No image or Alignment path is built from a Project directory in ${files.length} files ` +
		`(ADR-0023; ${exemptFiles.size} owning modules exempt, ${patterns.length} spellings checked ` +
		`against their specimens).`
);
for (const { file, line, reason } of optedOut) {
	console.log(`  opted out: ${file}:${line} — ${reason}`);
}
