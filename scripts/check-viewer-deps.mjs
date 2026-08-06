#!/usr/bin/env node
// ADR-0019: apps/viewer must never depend on terra-draw, the tiler, or wasm-vips.
//
// The viewer is a separate build precisely so its leanness is enforced by the dependency
// graph rather than by tree-shaking, and tree-shaking is not a boundary: one incautious
// import and every published site silently grows by megabytes, with no error and nobody
// looking. This check makes the violation loud, and it deliberately is not clever —
// reading the manifest is enough, because adding a dependency is a deliberate act that
// shows up in a diff.
//
// The tiler is not listed here because it lives inside @ballastella/core rather than in a
// manifest, so this check cannot see it — and the viewer does depend on that package. That half
// of ADR-0019 is `scripts/check-tiler-lazy.mjs`, which reads the source and the built bundles.
// It used to be a standing review item that no script checked.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'apps/viewer/package.json');

/** Exact package names the viewer must never depend on. */
const forbiddenNames = ['terra-draw', 'wasm-vips'];

/** Scopes and prefixes the viewer must never depend on — terra-draw's map adapters. */
const forbiddenPrefixes = ['@terra-draw/', 'terra-draw-'];

const dependencyFields = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies'
];

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const violations = [];
for (const field of dependencyFields) {
	for (const name of Object.keys(manifest[field] ?? {})) {
		const forbidden =
			forbiddenNames.includes(name) || forbiddenPrefixes.some((prefix) => name.startsWith(prefix));
		if (forbidden) violations.push({ field, name });
	}
}

if (violations.length > 0) {
	console.error(
		`\n${manifest.name} must never depend on terra-draw, the tiler, or wasm-vips (ADR-0019).\n`
	);
	for (const { field, name } of violations) {
		console.error(`  ${field}.${name}`);
	}
	console.error(
		'\nThe viewer is a separate build so that its leanness is enforced by the dependency\n' +
			'graph. Every published site ships this bundle; a reader never draws anything.\n' +
			'Move the work into the editor, or into a module the viewer does not import.\n'
	);
	process.exit(1);
}

console.log(`${manifest.name}: no forbidden dependencies (ADR-0019).`);
