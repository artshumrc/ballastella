#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { reportProblems, repoRoot } from './fence.mjs';
const viewerManifest = path.join(repoRoot, 'apps/viewer/package.json');
const forbiddenNames = ['terra-draw'];
const forbiddenPrefixes = ['@terra-draw/', 'terra-draw-'];
const allowances = [];

const dependencyFields = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies'
];

const readManifest = (file) => JSON.parse(readFileSync(file, 'utf8'));
const violations = [];
const problems = [];

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
const inspected = [];
const visited = new Set([viewerManifest]);
const queue = [viewerManifest];
let hops = 0;
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

if (violations.length > 0) {
	console.error(
		'\napps/viewer must never depend on terra-draw or the tiler — in its own manifest or in a ' +
			'workspace package it imports (ADR-0019).\n'
	);
	for (const { owner, field, name } of violations) console.error(`  ${owner} → ${field}.${name}`);
	console.error(
		'\nThe viewer is a separate build so that its leanness is enforced by the dependency\n' +
			'graph. Every published site ships this bundle; a reader never draws anything.\n' +
			'Move the work into the editor, or into a module the viewer does not import.\n'
	);
}

if (reportProblems('ADR-0019', problems) || violations.length > 0) process.exit(1);

const [viewer, ...reached] = inspected;
console.log(
	`${viewer}: no forbidden dependencies, in its own manifest or in ${reached.join(', ')} (ADR-0019).`
);
