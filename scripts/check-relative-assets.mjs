#!/usr/bin/env node
// ADR-0045: one build serves a domain root and a subdirectory, so no asset may be referenced by absolute path.

import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { failWith, repoRoot, scanLines } from './fence.mjs';

const builds = process.argv.slice(2);
const missing = builds.filter((build) => !existsSync(path.join(repoRoot, build)));
if (builds.length === 0 || missing.length > 0) {
	console.error(
		`check-relative-assets: nothing to read (${missing.join(', ') || 'no build given'}).`
	);
	process.exit(1);
}

const absolute = /(src|href)="\/[^"]*"/;
const violations = scanLines(
	() => false,
	(line) => absolute.test(line),
	builds,
	/\.(html|js|css|json|webmanifest|svg|xml)$/
).map((violation) => ({ ...violation, why: 'references an asset by absolute path', text: '' }));

failWith(
	'Absolute asset paths in built output (ADR-0045).',
	violations,
	'Keep `paths.relative: true` in svelte.config.js and reference assets relatively.'
);
console.log(`OK: no absolute asset paths in ${builds.join(', ')}`);
