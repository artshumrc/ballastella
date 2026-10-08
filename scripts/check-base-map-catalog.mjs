#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { failWith, hostOf, repoRoot, sourceFiles } from './fence.mjs';

const catalogModule = 'packages/core/src/base-map/catalog.ts';
const exemptFiles = new Set([catalogModule]);
const isExempt = (relative) =>
	exemptFiles.has(relative) ||
	relative.endsWith('.test.ts') ||
	relative.endsWith('.spec.ts') ||
	relative.endsWith('.e2e.ts') ||
	relative.endsWith('fixture-catalogs.ts');

const catalogSource = readFileSync(path.join(repoRoot, catalogModule), 'utf8');
const deploymentCheck = process.argv.includes('--deployment');
const entryIds = [...catalogSource.matchAll(/^\s*id: '([^']+)'/gm)].map((match) => match[1]);

const archives = [
	...[...catalogSource.matchAll(/'([^']*\.pmtiles)'/g)].map((match) => match[1]),
	...[...catalogSource.matchAll(/'([^']*\{z\}[^']*\{x\}[^']*\{y\}[^']*)'/g)].map(
		(match) => match[1]
	)
];

if (entryIds.length === 0) {
	console.error(`\nNo entry ids found in ${catalogModule}. This check cannot do its job.\n`);
	process.exit(1);
}

const archiveBindings = new Map(
	[...catalogSource.matchAll(/^const\s+(\w+)\s*=\s*'([^']+)';/gm)].map((match) => [
		match[1],
		match[2]
	])
);
const entryArchives = [...catalogSource.matchAll(/^\s*archive:\s*(?:'([^']*)'|(\w+))\s*,?$/gm)].map(
	(match) => match[1] ?? archiveBindings.get(match[2]) ?? match[2]
);

const rasterTiles = [...catalogSource.matchAll(/^\s*tiles:\s*(?:'([^']*)'|(\w+))\s*,?$/gm)].map(
	(match) => match[1] ?? archiveBindings.get(match[2]) ?? match[2]
);

const UNCONTROLLED_HOSTS = new Set([
	'demo-bucket.protomaps.com',
	'data.source.coop',
	's3.amazonaws.com',
	'tiles.maps.eox.at',
	'imagery.nationalmap.gov'
]);
let failed = false;

if (deploymentCheck) {
	const uncontrolled = [...entryArchives, ...rasterTiles].filter((archive) =>
		UNCONTROLLED_HOSTS.has(hostOf(archive))
	);
	if (uncontrolled.length > 0) {
		console.error(
			`\n${catalogModule}: ${entryIds.join(', ')} still read ${[...new Set(uncontrolled)].join(', ')}.\n\n` +
				'These URLs are accepted only for educational development and evaluation. Before a\n' +
				'production deployment, point REMOTE_ARCHIVE at a PMTiles archive that deployment controls,\n' +
				"the catalog's `terrain` at an elevation dataset it controls, and its `imagery` at tiles it\n" +
				'controls or serves under its own agreement (ADR-0025).\n'
		);
		failed = true;
	}
}

failWith(
	`A Base Map entry is named outside ${catalogModule} (ADR-0020).`,
	sourceFiles()
		.filter(({ file }) => !isExempt(file))
		.flatMap(({ file, text }) =>
			text
				.split('\n')
				.flatMap((line, index) =>
					[...entryIds, ...archives]
						.filter((needle) => line.includes(`'${needle}'`) || line.includes(`"${needle}"`))
						.map((needle) => ({ file, line: index + 1, why: `“${needle}”`, text: line.trim() }))
				)
		),
	'The catalog is deployment configuration: a fork must be able to replace it and change\n' +
		'nothing else. Derive the behaviour from the catalog — `resolveBaseMap`, `baseMapOptions`,\n' +
		'and `baseMapStyle` all take one — rather than keying on an id.'
);

if (failed) process.exit(1);

console.log(`${catalogModule}: ${entryIds.length} entries named nowhere else (ADR-0020).`);
