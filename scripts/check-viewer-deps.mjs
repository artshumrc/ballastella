#!/usr/bin/env node
// ADR-0019: apps/viewer must never depend on terra-draw, the tiler, or wasm-vips.
//
// The viewer is a separate build precisely so its leanness is enforced by the dependency
// graph rather than by tree-shaking, and tree-shaking is not a boundary: one incautious
// import and every published site silently grows by megabytes, with no error and nobody
// looking. This check makes the violation loud, and it deliberately is not clever —
// reading the manifests is enough, because adding a dependency is a deliberate act that
// shows up in a diff.
//
// **Manifests, plural, and that is the correction ticket 17 forced.** Reading only the viewer's
// own manifest left a hole the size of the next feature. The viewer now reaches `maplibre-gl`,
// `@allmaps/maplibre` and `pmtiles` *through* `@ballastella/core`, and `packages/core/src/render/`
// is the sanctioned home for browser-render code both apps share — so the next module of that
// shape, the Annotation drawing surface, would put `terra-draw` in `packages/core/package.json`,
// ship it to every Published Site, and this check would have printed green. It walks the workspace
// packages the viewer can reach and reads their manifests too.
//
// **Every dependency field at every hop, `devDependencies` included**, because `core` publishes its
// TypeScript source rather than a build artefact (CONTRIBUTING, "Layout"): the viewer's bundler
// compiles that source and resolves its imports against `core`'s own `node_modules`, so a
// devDependency there reaches a published site exactly as a dependency does. The one allowance is
// `wasm-vips` in `@ballastella/core` — see ALLOWANCES, which is where this fence hands over to the
// other one rather than a hole in it.
//
// The tiler itself is still not visible here: it is source inside `@ballastella/core` rather than a
// package, so no manifest names it. That half is `scripts/check-tiler-lazy.mjs`, which reads the
// source and the built bundles. It used to be a standing review item that no script checked.
//
// There is deliberately **no** built-output grep for terra-draw to match that script's for wasm-vips.
// No package in this repository uses terra-draw — `pnpm-workspace.yaml` declines it, three tickets
// running — so it has no string literal that is a known-good positive in any build, and a grep for
// markers absent from every build is exactly the check that reports success unconditionally. The
// walk below is what closes that door instead: terra-draw cannot arrive without a manifest naming it.
//
// Like that script, this one **fails if it finds nothing to guard**: a workspace dependency whose
// manifest cannot be found, a viewer that reaches no workspace package at all, or an allowance
// below that matches nothing are all reported as defects in the check rather than passed over. The
// grep this pair replaced — for a module specifier that bundling resolves away — reported success
// unconditionally, and a fence that passes whatever the code does is worse than no fence, because
// it is read as evidence.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viewerManifest = path.join(repoRoot, 'apps/viewer/package.json');

/** Exact package names the viewer must never reach, in its own manifest or in a workspace one. */
const forbiddenNames = ['terra-draw', 'wasm-vips'];

/** Scopes and prefixes the viewer must never depend on — terra-draw's map adapters. */
const forbiddenPrefixes = ['@terra-draw/', 'terra-draw-'];

/**
 * The one forbidden name a workspace package the viewer reaches may still declare.
 *
 * `@ballastella/core` tests the streaming tiler against the real `wasm-vips`, and a test dependency
 * is the honest way to say so. What keeps the module out of the viewer is not this manifest but the
 * source rule in `scripts/check-tiler-lazy.mjs`: nothing under `packages/core/src` may name the
 * package at all, because the tiler takes it through an injected loader that the app supplies. So
 * this entry is the seam between the two fences, written down rather than assumed — and it must
 * match something, or it is describing an arrangement the repository no longer has.
 */
const allowances = [{ owner: '@ballastella/core', field: 'devDependencies', name: 'wasm-vips' }];

const dependencyFields = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies'
];

const readManifest = (file) => JSON.parse(readFileSync(file, 'utf8'));

/** Every forbidden dependency found, and every way this check turned out to be inspecting nothing. */
const violations = [];
const problems = [];

/**
 * Every workspace package's manifest, by package name.
 *
 * The globs are read out of `pnpm-workspace.yaml` rather than written here a second time, so a new
 * package directory cannot join the workspace and be invisible to this check. Only `dir/*` and a
 * literal directory are understood, and anything else is a failure rather than a skip: a glob this
 * script quietly ignores is a package it quietly stops fencing, which is the shape of the defect
 * the whole pair exists to avoid.
 */
function workspaceManifests() {
	const yaml = readFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
	const block = /^packages:[ \t]*\r?\n((?:[ \t]+-[ \t]*[^\n]+\r?\n)+)/m.exec(yaml);
	if (!block) {
		problems.push(
			'pnpm-workspace.yaml declares no `packages:` globs this script can read, so it found no ' +
				'workspace packages to walk into and would pass without having looked at any of them.'
		);
		return new Map();
	}

	const globs = [...block[1].matchAll(/-[ \t]*['"]?([^'"\n\r]+?)['"]?[ \t\r]*$/gm)].map(
		(match) => match[1]
	);

	const directories = [];
	for (const glob of globs) {
		const literal = glob.endsWith('/*') ? glob.slice(0, -2) : glob;
		if (literal.includes('*')) {
			problems.push(
				`pnpm-workspace.yaml lists the glob \`${glob}\`, which this script cannot expand. Teach it ` +
					`that form rather than leaving those packages unchecked (ADR-0019).`
			);
			continue;
		}
		if (glob === literal) {
			directories.push(path.join(repoRoot, literal));
			continue;
		}
		const parent = path.join(repoRoot, literal);
		if (!existsSync(parent)) continue;
		for (const entry of readdirSync(parent, { withFileTypes: true })) {
			if (entry.isDirectory()) directories.push(path.join(parent, entry.name));
		}
	}

	const byName = new Map();
	for (const directory of directories) {
		const file = path.join(directory, 'package.json');
		if (existsSync(file)) byName.set(readManifest(file).name, file);
	}
	return byName;
}

const workspace = workspaceManifests();

// ── The walk: the viewer, and everything in this repository it can import ──────────────────────

/** Package names inspected, viewer first, in the order the walk reached them. */
const inspected = [];
const visited = new Set([viewerManifest]);
const queue = [viewerManifest];

/** Workspace dependencies followed. Zero means the transitive half of this check inspected nothing. */
let hops = 0;

/** The allowances that matched. One that matches nothing is stale and is reported as such. */
const matched = new Set();

while (queue.length > 0) {
	const file = queue.shift();
	const manifest = readManifest(file);
	inspected.push(manifest.name);

	for (const field of dependencyFields) {
		for (const [name, range] of Object.entries(manifest[field] ?? {})) {
			const forbidden =
				forbiddenNames.includes(name) ||
				forbiddenPrefixes.some((prefix) => name.startsWith(prefix));
			const allowance = allowances.find(
				(one) => one.owner === manifest.name && one.field === field && one.name === name
			);
			if (forbidden && allowance) matched.add(allowance);
			else if (forbidden) violations.push({ owner: manifest.name, field, name });

			// `workspace:` rather than the `@ballastella/` scope, because what makes a package reachable
			// through this repository's own source is the protocol, whatever it ends up being called.
			if (!String(range).startsWith('workspace:')) continue;
			const target = workspace.get(name);
			if (target === undefined) {
				problems.push(
					`${manifest.name} declares ${field}.${name} as a workspace dependency, but no package of ` +
						`that name is in the workspace — so its manifest was never read and this check passed ` +
						`without having looked at it.`
				);
				continue;
			}
			hops += 1;
			if (visited.has(target)) continue;
			visited.add(target);
			queue.push(target);
		}
	}
}

if (hops === 0) {
	problems.push(
		'apps/viewer reaches no workspace package, so the transitive half of this check inspected ' +
			'nothing. If the viewer has deliberately stopped depending on @ballastella/core, say so by ' +
			'simplifying this script in the same change rather than leaving it passing vacuously.'
	);
}

for (const allowance of allowances) {
	if (matched.has(allowance)) continue;
	problems.push(
		`The allowance for ${allowance.field}.${allowance.name} in ${allowance.owner} matches nothing. ` +
			`It describes an arrangement this repository no longer has, so delete it — an exception that ` +
			`guards nothing reads as permission the next time somebody needs one.`
	);
}

// ── Report ────────────────────────────────────────────────────────────────────────────────────

if (violations.length > 0) {
	console.error(
		'\napps/viewer must never depend on terra-draw, the tiler, or wasm-vips — in its own manifest ' +
			'or in a workspace package it imports (ADR-0019).\n'
	);
	for (const { owner, field, name } of violations) console.error(`  ${owner} → ${field}.${name}`);
	console.error(
		'\nThe viewer is a separate build so that its leanness is enforced by the dependency\n' +
			'graph. Every published site ships this bundle; a reader never draws anything.\n' +
			'Move the work into the editor, or into a module the viewer does not import.\n'
	);
}

if (problems.length > 0) {
	console.error('\nThis check is not inspecting what it claims to (ADR-0019).\n');
	for (const problem of problems) console.error(`  ${problem}\n`);
}

if (violations.length > 0 || problems.length > 0) process.exit(1);

const [viewer, ...reached] = inspected;
console.log(
	`${viewer}: no forbidden dependencies, in its own manifest or in ${reached.join(', ')} (ADR-0019).`
);
