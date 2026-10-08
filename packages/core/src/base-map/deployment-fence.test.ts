import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const CATALOG_RELATIVE = 'packages/core/src/base-map/catalog.ts';

const catalogNaming = (archive: string, comment = '') =>
	`${comment}const REMOTE_ARCHIVE = '${archive}';

export const BASE_MAP_CATALOG = {
	entries: [
		{
			id: 'streets',
			label: 'Streets',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE,
			emphasis: 'streets-and-labels',
			flavor: { light: 'light', dark: 'dark' }
		},
		{
			id: 'physical',
			label: 'Physical geography',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE,
			emphasis: 'water-and-terrain',
			flavor: { light: 'light', dark: 'dark' }
		}
	],
	defaultId: 'streets'
};
`;

function runCheck(
	catalog: string,
	options: { deployment?: boolean; extraFiles?: Record<string, string> } = {}
) {
	const root = mkdtempSync(path.join(tmpdir(), 'ballastella-fence-'));
	try {
		for (const [relative, contents] of Object.entries({
			[CATALOG_RELATIVE]: catalog,
			...options.extraFiles
		})) {
			const file = path.join(root, relative);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}
		for (const name of ['check-base-map-catalog.mjs', 'fence.mjs']) {
			cpSync(path.join(repoRoot, 'scripts', name), path.join(root, 'scripts', name));
		}
		const run = spawnSync(
			process.execPath,
			[
				path.join(root, 'scripts/check-base-map-catalog.mjs'),
				...(options.deployment ? ['--deployment'] : [])
			],
			{ encoding: 'utf8' }
		);
		return { status: run.status ?? 1, output: `${run.stdout}${run.stderr}` };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const DEMO = 'https://demo-bucket.protomaps.com/v4.pmtiles';
const CONTROLLED = 'https://tiles.example.edu/planet.pmtiles';
const OPEN_DATA_DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const CONTROLLED_DEM = 'https://tiles.example.edu/elevation/{z}/{x}/{y}.png';

const catalogWithTerrain = (archive: string, tiles: string) =>
	catalogNaming(archive).replace(
		"\tdefaultId: 'streets'",
		`\tterrain: {\n\t\ttiles: '${tiles}',\n\t\tencoding: 'terrarium',\n\t\tmaxZoom: 15\n\t},\n\tdefaultId: 'streets'`
	);

describe('the deployment fence', () => {
	it('refuses a catalog reading the demo bucket, and names the remedy', () => {
		const run = runCheck(catalogNaming(DEMO), { deployment: true });
		expect(run.status).not.toBe(0);
		expect(run.output).toContain('demo-bucket.protomaps.com');
		expect(run.output).toContain('REMOTE_ARCHIVE');
		expect(run.output).toContain('archive that deployment controls');
		expect(run.output).toContain('streets, physical');
	});

	it('accepts the same catalog once it is repointed', () => {
		const run = runCheck(catalogNaming(CONTROLLED), { deployment: true });
		expect(run.status).toBe(0);
		expect(run.output).toContain('2 entries named nowhere else');
	});

	it.each([
		[
			'a repointed catalog whose comment still explains the demo bucket',
			catalogNaming(
				CONTROLLED,
				'// Not demo-bucket.protomaps.com: no rate limit, no uptime promise, no terms of use.\n'
			)
		],
		[
			'a catalog whose archive and elevation dataset are both its own',
			catalogWithTerrain(CONTROLLED, CONTROLLED_DEM)
		]
	])('accepts %s', (_, catalog) => {
		const run = runCheck(catalog, { deployment: true });
		expect(run.status, run.output).toBe(0);
	});

	it('leaves ordinary development green while the catalog reads the demo bucket', () => {
		const run = runCheck(catalogNaming(DEMO));
		expect(run.status).toBe(0);
		expect(run.output).not.toContain('demo-bucket');
	});

	it('refuses an elevation dataset on somebody else\u2019s bucket, however good the archive', () => {
		const run = runCheck(catalogWithTerrain(CONTROLLED, OPEN_DATA_DEM), { deployment: true });
		expect(run.status).not.toBe(0);
		expect(run.output).toContain('s3.amazonaws.com');
		expect(run.output).toContain('elevation dataset it controls');
	});

	it('keeps the elevation dataset inside the catalog, like every other address', () => {
		const run = runCheck(catalogWithTerrain(CONTROLLED, CONTROLLED_DEM), {
			extraFiles: { 'apps/viewer/src/leak.ts': `export const dem = '${CONTROLLED_DEM}';\n` }
		});

		expect(run.status).not.toBe(0);
		expect(run.output).toContain('apps/viewer/src/leak.ts');
	});

	it('still runs the ADR-0020 containment scan in deployment mode', () => {
		const leak = { 'apps/editor/src/leak.ts': "export const pinned = 'physical';\n" };
		const both = runCheck(catalogNaming(DEMO), { deployment: true, extraFiles: leak });
		expect(both.status).not.toBe(0);
		expect(both.output).toContain('demo-bucket.protomaps.com');
		expect(both.output).toContain('apps/editor/src/leak.ts');
		const leakOnly = runCheck(catalogNaming(CONTROLLED), { deployment: true, extraFiles: leak });
		expect(leakOnly.status).not.toBe(0);
		expect(leakOnly.output).toContain('apps/editor/src/leak.ts');
	});
});
