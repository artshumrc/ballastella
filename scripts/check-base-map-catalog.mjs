#!/usr/bin/env node
// ADR-0020: the Base Map catalog is deployment configuration, and adding, removing, or
// repointing an entry must require no change anywhere else.
//
// That property is what a forker pointing at their own tiles depends on (SPEC story 100), and
// unlike most design intentions it can be checked mechanically: if no module outside the catalog
// names an entry id or an archive, then no module outside the catalog can need editing when one
// changes. So this check greps for exactly that. It is the same shape as
// `check-viewer-deps.mjs` — deliberately not clever, because the violation it catches is a
// deliberate act that shows up in a diff.
//
// The failure it prevents is quiet. A special case keyed on one id — a default hard-coded in a
// component, a branch on one entry inside a style helper — still works perfectly on this
// deployment. It fails only on the fork, where nobody is looking.
//
// Test files are exempt. The browser suite asserts that the switcher offers exactly this
// deployment's catalog, which it can only do by naming it, and that assertion is the other half
// of the same property: change the catalog and the switcher changes with it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogModule = 'packages/core/src/base-map/catalog.ts';

/** Source trees a Base Map entry could leak into. Static assets and prose are not code. */
const scannedRoots = ['packages/core/src', 'apps/editor/src', 'apps/viewer/src', 'scripts', 'e2e'];

const exemptFiles = new Set([catalogModule]);
const isExempt = (relative) =>
	exemptFiles.has(relative) ||
	relative.endsWith('.test.ts') ||
	relative.endsWith('.spec.ts') ||
	relative.endsWith('.e2e.ts') ||
	// The fixture catalogs exist precisely to be a different catalog.
	relative.endsWith('fixture-catalogs.ts');

const catalogSource = readFileSync(path.join(repoRoot, catalogModule), 'utf8');

/** Entry ids, as written in the catalog. */
const entryIds = [...catalogSource.matchAll(/^\s*id: '([^']+)'/gm)].map((match) => match[1]);

/** Archive locations, which are addresses and must never appear outside the catalog either. */
const archives = [...catalogSource.matchAll(/'([^']*\.pmtiles)'/g)].map((match) => match[1]);

if (entryIds.length === 0) {
	console.error(`\nNo entry ids found in ${catalogModule}. This check cannot do its job.\n`);
	process.exit(1);
}

const files = scannedRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];

for (const absolute of files) {
	const relative = path.relative(repoRoot, absolute);
	if (isExempt(relative)) continue;

	const lines = readFileSync(absolute, 'utf8').split('\n');
	lines.forEach((line, index) => {
		for (const needle of [...entryIds, ...archives]) {
			// Quoted only: prose in a comment naming a variant is documentation, not a dependency.
			if (line.includes(`'${needle}'`) || line.includes(`"${needle}"`)) {
				violations.push({ file: relative, line: index + 1, needle, text: line.trim() });
			}
		}
	});
}

if (violations.length > 0) {
	console.error(`\nA Base Map entry is named outside ${catalogModule} (ADR-0020).\n`);
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}  “${violation.needle}”`);
		console.error(`    ${violation.text}`);
	}
	console.error(
		'\nThe catalog is deployment configuration: a fork must be able to replace it and change\n' +
			'nothing else. Derive the behaviour from the catalog — `resolveBaseMap`, `baseMapOptions`,\n' +
			'and `baseMapStyle` all take one — rather than keying on an id.\n'
	);
	process.exit(1);
}

console.log(
	`${catalogModule}: ${entryIds.length} entries named nowhere else (ADR-0020, SPEC story 100).`
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
