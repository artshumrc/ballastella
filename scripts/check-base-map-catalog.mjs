#!/usr/bin/env node
// ADR-0020: the Base Map catalog is deployment configuration, and adding, removing, or
// repointing an entry must require no change anywhere else.
//
// That property is what a forker pointing at their own tiles depends on, and
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
const scannedRoots = [
	'packages/core/src',
	'packages/ui/src',
	'apps/editor/src',
	'apps/viewer/src',
	'scripts',
	'e2e'
];

const exemptFiles = new Set([catalogModule]);
const isExempt = (relative) =>
	exemptFiles.has(relative) ||
	relative.endsWith('.test.ts') ||
	relative.endsWith('.spec.ts') ||
	relative.endsWith('.e2e.ts') ||
	// The fixture catalogs exist precisely to be a different catalog.
	relative.endsWith('fixture-catalogs.ts');

const catalogSource = readFileSync(path.join(repoRoot, catalogModule), 'utf8');
const deploymentCheck = process.argv.includes('--deployment');

/** Entry ids, as written in the catalog. */
const entryIds = [...catalogSource.matchAll(/^\s*id: '([^']+)'/gm)].map((match) => match[1]);

/**
 * Addresses, which must never appear outside the catalog either: the pmtiles archives, and the
 * raster DEM template the topographic entry's relief and contours are both drawn from. The DEM is
 * matched by its tile placeholders rather than by a file extension, because it addresses a tile
 * pyramid and not a file.
 */
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

/**
 * The archive each entry actually reads, with `const NAME = '…'` bindings resolved.
 *
 * **Values, not raw file text.** An earlier version of the deployment fence asked whether
 * `catalogSource.includes('demo-bucket.protomaps.com')`, which matches the domain anywhere in the
 * file — including the comment on `REMOTE_ARCHIVE` that explains why the URL is unsuitable. A
 * deployment that correctly repointed the constant but kept the explanation was wrongly blocked,
 * and the remedy on offer was "delete the paragraph saying why".
 *
 * The trailing comma is optional. `archive` is the last property of the only entry, so whether it
 * carries one is the formatter's business — and requiring it once left this fence reading no
 * archive at all, which passes a borrowed host silently.
 */
const archiveBindings = new Map(
	[...catalogSource.matchAll(/^const\s+(\w+)\s*=\s*'([^']+)';/gm)].map((match) => [
		match[1],
		match[2]
	])
);
const entryArchives = [...catalogSource.matchAll(/^\s*archive:\s*(?:'([^']*)'|(\w+))\s*,?$/gm)].map(
	(match) => match[1] ?? archiveBindings.get(match[2]) ?? match[2]
);

/**
 * Every raster tile template in the catalog — the elevation dataset and the satellite imagery —
 * held to the same rule as an archive.
 *
 * They are separate lines because they are separate hosts, and a fence that checked only `archive:`
 * would pass a deployment that had provisioned its own vector tiles and left the relief or the
 * imagery pointed at somebody else's bucket — which is the whole failure, one dataset later.
 *
 * Matched by the `tiles:` key rather than by name, so a fourth dataset added to the catalog is
 * fenced by existing here rather than by somebody remembering to come back to this file.
 */
const rasterTiles = [...catalogSource.matchAll(/^\s*tiles:\s*(?:'([^']*)'|(\w+))\s*,?$/gm)].map(
	(match) => match[1] ?? archiveBindings.get(match[2]) ?? match[2]
);

/**
 * Archives no deployment may ship: someone else's, whoever else's.
 *
 * Compared by host, so a path change on the same bucket does not slip past.
 *
 * ⚠ **A host is listed here because of who runs it, not because it is broken.**
 * `demo-bucket.protomaps.com` is the bucket Protomaps publishes for trying the format out.
 * `data.source.coop` is the Source Cooperative mirror of Protomaps' daily planet build, and its
 * operators say "We don't recommend cross-origin hotlinking directly to source.coop URLs" — so it
 * is the same kind of dependency, on somebody else's bandwidth with no promise to this deployment.
 *
 * **Adding the replacement here was the point.** When the catalog moved off the demo bucket on
 * 2026-08-10, this set still named only the host being left, so `pnpm check:deployment` would have
 * gone green and reported a deployment fit to ship. A fence that passes because the thing it
 * describes moved is worse than no fence: it is a green light nobody asked for. The rule this set
 * encodes is *the deployment controls its own archive*, and a host belongs here whenever it does
 * not — which is every host until somebody provisions one.
 *
 * `s3.amazonaws.com` is the AWS Open Data bucket the Tilezen Terrain Tiles sit in, read by the
 * topographic entry for both its shading and its contour lines. Free to read and keyless, and still
 * nobody's promise to this deployment — the same kind of dependency as the two above, listed here
 * for the same reason.
 *
 * `tiles.maps.eox.at` is EOX's WMTS service, which serves the Sentinel-2 cloudless mosaic behind
 * the satellite switch. The *imagery* is CC BY 4.0 and may be redistributed; the *service* is EOX's
 * own bandwidth, offered as a courtesy, with no promise to this deployment. Those are two different
 * questions and only the second one is this fence's.
 */
const UNCONTROLLED_HOSTS = new Set([
	'demo-bucket.protomaps.com',
	'data.source.coop',
	's3.amazonaws.com',
	'tiles.maps.eox.at'
]);
const hostOf = (archive) => {
	try {
		return new URL(archive).host;
	} catch {
		return '';
	}
};

/**
 * Failures are collected rather than exited on, because `--deployment` is a *mode* of this check
 * and not a different check. Exiting here is how `pnpm check:deployment` — the one gating
 * production — came to skip the ADR-0020 containment scan below entirely.
 */
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
	failed = true;
}

if (failed) process.exit(1);

console.log(`${catalogModule}: ${entryIds.length} entries named nowhere else (ADR-0020).`);

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
