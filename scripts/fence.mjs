import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const rootFromArgv = () => {
	const flag = process.argv.indexOf('--root');
	return flag === -1 ? repoRoot : path.resolve(process.argv[flag + 1] ?? '.');
};

export const SOURCE_ROOTS = [
	'packages/core/src',
	'packages/ui/src',
	'apps/editor/src',
	'apps/viewer/src',
	'scripts',
	'e2e'
];

export const messageOf = (cause) => (cause instanceof Error ? cause.message : String(cause));

export const hostOf = (url) => {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
};

export const isComment = (line) => /^\s*(?:\/\/|\*|\/\*)/.test(line ?? '');

export const ownersAndTests =
	(...owners) =>
	(relative) =>
		owners.includes(relative) || /\.(?:test|spec)\.ts$|\.test\.mjs$/.test(relative);

export function isTestFile(relative) {
	const base = relative.split('/').pop() ?? '';
	return (
		relative.startsWith('e2e/') ||
		relative.includes('/test-support/') ||
		/\.test\.[cm]?[jt]s$/.test(base) ||
		/(?:^|-)(?:fake|fixtures?|suite|test-support)[-.]/.test(base)
	);
}

/** @returns {{ file: string, text: string }[]} repo-relative paths with their contents */
export function sourceFiles(roots = SOURCE_ROOTS, extensions = /\.(ts|js|mjs|svelte)$/) {
	const walk = (directory) => {
		let entries;
		try {
			entries = readdirSync(directory);
		} catch {
			return [];
		}
		return entries.flatMap((entry) => {
			if (entry === 'node_modules') return [];
			const absolute = path.join(directory, entry);
			if (statSync(absolute).isDirectory()) return walk(absolute);
			return extensions.test(entry) ? [absolute] : [];
		});
	};
	return roots
		.flatMap((root) => walk(path.join(repoRoot, root)))
		.map((absolute) => ({
			file: path.relative(repoRoot, absolute).split(path.sep).join('/'),
			text: readFileSync(absolute, 'utf8')
		}));
}

/** Exits when a positive control failed: a fence that stopped matching prints the same success as a clean tree. */
export function assertControls(failures, consequence, adr) {
	if (failures.length === 0) return;
	console.error(
		`\nThis check can no longer detect what it exists to detect${adr ? ` (${adr})` : ''}.\n`
	);
	for (const failure of failures) console.error(`  ${failure}`);
	console.error(`\n${consequence}\n`);
	process.exit(1);
}

/** A check whose controls are a predicate over lines: every bad line matches, no good line does. */
export function matchControls(matches, knownBad, knownGood) {
	return [
		...knownBad
			.filter(({ line }) => !matches(line))
			.map(({ expect }) => `${expect} is no longer caught`),
		...knownGood.filter(matches).map((line) => `a legitimate line is now refused: ${line}`)
	];
}

export async function importOwner(module) {
	try {
		return await import(pathToFileURL(path.join(repoRoot, module)).href);
	} catch (error) {
		console.error(
			`\n${module}: this module could not be loaded, so this check cannot do\nits job.\n\n` +
				`  ${messageOf(error)}\n`
		);
		process.exit(1);
	}
}

/** Prints `- problem` paragraphs under a heading and exits. */
export function failProblems(heading, problems, footer = '') {
	if (problems.length === 0) return;
	console.error(
		`\n${heading}:\n\n` + problems.map((problem) => `- ${problem}`).join('\n\n') + `\n${footer}`
	);
	process.exit(1);
}

/** Prints what keeps a check from inspecting what it claims to; true when there was anything. */
export function reportProblems(adr, problems) {
	if (problems.length === 0) return false;
	console.error(`\nThis check is not inspecting what it claims to (${adr}).\n`);
	for (const problem of problems) console.error(`  ${problem}\n`);
	return true;
}

/** Specimen check: every bad line matches, every good line does not, every pattern has a specimen. */
export function specimenFailures(patterns, violationIn, knownBad, knownGood) {
	const failures = [];
	for (const { line, expect } of knownBad) {
		if (violationIn(line) === null) {
			failures.push(`the ${expect} spelling is no longer caught: ${line.trim()}`);
		}
	}
	for (const line of knownGood) {
		const why = violationIn(line);
		if (why !== null) failures.push(`a legitimate line is now refused (${why}): ${line.trim()}`);
	}
	for (const { pattern, why } of patterns) {
		const matched = knownBad.some(({ line }) => {
			pattern.lastIndex = 0;
			return pattern.test(line);
		});
		if (!matched) failures.push(`no specimen exercises the pattern that ${why}`);
	}
	return failures;
}

/** Prints violations as `file:line  why` with the offending text, then the remedy, and exits. */
export function failWith(heading, violations, remedy) {
	if (violations.length === 0) return;
	console.error(`\n${heading}\n`);
	for (const { file, line, why, text } of violations) {
		console.error(`  ${file}:${line}${why ? `  ${why}` : ''}`);
		if (text) console.error(`    ${text}`);
	}
	console.error(`\n${remedy}\n`);
	process.exit(1);
}

export function matchingLine(patterns, line) {
	if (isComment(line)) return null;
	for (const { pattern, why } of patterns) {
		pattern.lastIndex = 0;
		if (pattern.test(line)) return why;
	}
	return null;
}

export const scanLines = (skip, matches, roots = SOURCE_ROOTS, extensions = undefined) =>
	sourceFiles(roots, extensions)
		.filter(({ file }) => !skip(file))
		.flatMap(({ file, text }) =>
			text
				.split('\n')
				.flatMap((line, index) =>
					matches(line) ? [{ file, line: index + 1, text: line.trim() }] : []
				)
		);
