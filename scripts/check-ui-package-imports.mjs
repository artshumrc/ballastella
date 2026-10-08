#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { reportProblems, repoRoot, sourceFiles } from './fence.mjs';

const PACKAGE = 'packages/ui';
const packageRoot = path.join(repoRoot, PACKAGE);
const problems = [];

function appPackageNames() {
	const appsRoot = path.join(repoRoot, 'apps');
	if (!existsSync(appsRoot)) return [];
	return readdirSync(appsRoot, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(appsRoot, entry.name, 'package.json'))
		.filter((file) => existsSync(file))
		.map((file) => JSON.parse(readFileSync(file, 'utf8')).name)
		.filter((name) => typeof name === 'string');
}

const appNames = appPackageNames();

function specifiersIn(text) {
	const found = [];
	const patterns = [
		/\bimport\s+[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
		/\bexport\s+[^'"();]*?\bfrom\s*['"]([^'"]+)['"]/g,
		/\bimport\s*['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/@import\s*(?:url\()?\s*['"]([^'"]+)['"]/g
	];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match;
		while ((match = pattern.exec(text)) !== null) {
			found.push({ specifier: match[1], line: text.slice(0, match.index).split('\n').length });
		}
	}
	return found;
}

const SVELTEKIT_ALIASES = [
	['$lib', "uses $lib, which is one app's src/lib and does not exist here"],
	['$app', "uses $app, which SvelteKit generates inside an app's build"],
	['$env', "uses $env, which SvelteKit generates from one app's build-time environment"],
	['$service-worker', "uses $service-worker, which exists only in one app's service worker build"]
];

function violationIn(specifier) {
	if (appNames.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
		return 'names an app package';
	}
	if (/(^|\/)apps\//.test(specifier)) return 'reaches into apps/ by path';
	for (const [alias, why] of SVELTEKIT_ALIASES) {
		if (specifier === alias || specifier.startsWith(`${alias}/`)) return why;
	}
	return null;
}

function violationsIn(text) {
	return specifiersIn(text)
		.map(({ specifier, line }) => ({ specifier, line, why: violationIn(specifier) }))
		.filter(({ why }) => why !== null);
}

const KNOWN_BAD = [
	'@ballastella/editor',
	'@ballastella/viewer/src/lib/theme.svelte.js',
	'../../apps/editor/src/lib/layers/layer-kind-style.js',
	'$lib',
	'$lib/base-map/opening-view',
	'$app/paths',
	'$env/static/public',
	'$env/dynamic/private',
	'$service-worker'
];

const KNOWN_GOOD = [
	'@ballastella/core',
	'@ballastella/core/render',
	'svelte',
	'./BaseMapSwitcher.svelte',
	'../layout.css',
	'@ballastella/core-apps',
	'./mapps/index.js'
];

for (const specifier of KNOWN_BAD) {
	if (violationIn(specifier) === null) {
		problems.push(`this check no longer refuses \`${specifier}\`, which reaches an app`);
	}
}
for (const specifier of KNOWN_GOOD) {
	const why = violationIn(specifier);
	if (why !== null) {
		problems.push(`this check now refuses \`${specifier}\`, which is legitimate (${why})`);
	}
}
for (const { source, expect } of [
	{ source: "import Thing from '$lib/Thing.svelte';", expect: '$lib/Thing.svelte' },
	{ source: "export { x } from '@ballastella/editor';", expect: '@ballastella/editor' },
	{ source: "import '@ballastella/core/test-fence';", expect: '@ballastella/core/test-fence' },
	{ source: "const m = await import('$app/paths');", expect: '$app/paths' },
	{ source: "@import '@ballastella/ui/layout.css';", expect: '@ballastella/ui/layout.css' }
]) {
	if (!specifiersIn(source).some(({ specifier }) => specifier === expect)) {
		problems.push(`an import spelled \`${source}\` is no longer seen by this check`);
	}
}
for (const { source, expect, line } of [
	{
		source: [
			"import { baseMapOptions } from '@ballastella/core';",
			'import {',
			'\tlayerKindInk,',
			'\tlayerKindStyle',
			"} from '@ballastella/editor';"
		].join('\n'),
		expect: '@ballastella/editor',
		line: 2
	},
	{
		source: ['import {', '\topeningView', "} from '$lib/base-map/opening-view';"].join('\n'),
		expect: '$lib/base-map/opening-view',
		line: 1
	},
	{ source: "import { env } from '$env/dynamic/public';", expect: '$env/dynamic/public', line: 1 },
	{ source: "import { build } from '$service-worker';", expect: '$service-worker', line: 1 }
]) {
	const found = violationsIn(source);
	if (!found.some((violation) => violation.specifier === expect && violation.line === line)) {
		problems.push(
			`this check no longer refuses \`${expect}\` at line ${line} of:\n\n${source}\n\n` +
				`  it found: ${JSON.stringify(found)}`
		);
	}
}

if (appNames.length === 0) {
	problems.push(
		'no app package names were found under apps/, so the first and most direct spelling of this ' +
			'violation is not being checked for at all.'
	);
}

const files = sourceFiles([PACKAGE], /\.(ts|js|mjs|svelte|css)$/);

if (files.length === 0) {
	problems.push(
		`${PACKAGE} has no source files this check can read, so it inspected nothing. If the shared ` +
			`package has been renamed or removed, change this check in the same commit rather than ` +
			`leaving it passing over an absence.`
	);
}

const violations = [];

for (const { file, text } of files) {
	for (const { specifier, line, why } of violationsIn(text)) {
		violations.push({ file, line, specifier, why });
	}
}

{
	const manifestFile = path.join(packageRoot, 'package.json');
	if (existsSync(manifestFile)) {
		const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
		for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
			for (const name of Object.keys(manifest[field] ?? {})) {
				if (appNames.includes(name)) {
					violations.push({
						file: `${PACKAGE}/package.json`,
						line: 0,
						specifier: `${field}.${name}`,
						why: 'declares an app as a dependency of the shared package'
					});
				}
			}
		}
	}
}

if (violations.length > 0) {
	console.error(`\nSomething in ${PACKAGE} reaches back into an app (ADR-0034).\n`);
	for (const { file, line, specifier, why } of violations) {
		console.error(`  ${file}${line > 0 ? `:${line}` : ''}  ${specifier} — ${why}`);
	}
	console.error(
		`\n${PACKAGE} is compiled by both apps. A module here that imports from one of them is a\n` +
			'module whose meaning depends on which app compiled it, which is not a shared component\n' +
			'but a copy with extra steps. Move what is needed into this package or into\n' +
			'@ballastella/core, or pass it in as a prop.\n'
	);
}

if (reportProblems('ADR-0034', problems) || violations.length > 0) process.exit(1);

console.log(
	`${PACKAGE}: nothing imports from apps/ — ${files.length} files scanned against ` +
		`${appNames.length} app package names (${appNames.join(', ')}) and ` +
		`${SVELTEKIT_ALIASES.map(([alias]) => alias).join(', ')} (ADR-0034).`
);
