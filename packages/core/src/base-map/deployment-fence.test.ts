import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// `scripts/check-base-map-catalog.mjs`, driven both ways.
//
// **The failing direction is the whole point.** This repository has already shipped a fence that
// printed its success message unconditionally, so the rule is to assert the refusal and not only
// the acceptance. A green `pnpm check:deployment` means nothing unless a red one is reachable, and
// the only way to reach red is to hand the script a catalog that should be refused.
//
// The script is run against a **synthetic repository** — a temp directory holding a copy of the
// script and a catalog written for the case under test — rather than by mutating this repo's own
// `catalog.ts`. It derives its root from its own location, so a copy is a complete deployment as
// far as it is concerned; its source scan simply finds no trees to walk unless one is written.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const script = path.join(repoRoot, 'scripts/check-base-map-catalog.mjs');

const CATALOG_RELATIVE = 'packages/core/src/base-map/catalog.ts';

/** A catalog module reading `archive`, with `comment` above the constant. */
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

type Run = { status: number; output: string };

/**
 * Run the check inside a throwaway repository whose catalog is `catalog`.
 *
 * `extraFiles` are written under the synthetic root so that the ADR-0020 containment scan has
 * something to find.
 */
function runCheck(
	catalog: string,
	options: { deployment?: boolean; extraFiles?: Record<string, string> } = {}
): Run {
	const root = mkdtempSync(path.join(tmpdir(), 'ballastella-fence-'));
	try {
		mkdirSync(path.join(root, 'scripts'), { recursive: true });
		cpSync(script, path.join(root, 'scripts/check-base-map-catalog.mjs'));
		mkdirSync(path.dirname(path.join(root, CATALOG_RELATIVE)), { recursive: true });
		writeFileSync(path.join(root, CATALOG_RELATIVE), catalog);
		for (const [relative, contents] of Object.entries(options.extraFiles ?? {})) {
			const file = path.join(root, relative);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}

		try {
			const output = execFileSync(
				process.execPath,
				[
					path.join(root, 'scripts/check-base-map-catalog.mjs'),
					...(options.deployment ? ['--deployment'] : [])
				],
				{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
			);
			return { status: 0, output };
		} catch (error) {
			const failure = error as { status?: number; stdout?: string; stderr?: string };
			return {
				status: failure.status ?? 1,
				output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`
			};
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const DEMO = 'https://demo-bucket.protomaps.com/v4.pmtiles';
const CONTROLLED = 'https://tiles.example.edu/planet.pmtiles';

describe('the deployment fence', () => {
	it('refuses a catalog reading the demo bucket, and names the remedy', () => {
		const run = runCheck(catalogNaming(DEMO), { deployment: true });

		expect(run.status).not.toBe(0);
		expect(run.output).toContain('demo-bucket.protomaps.com');
		// The remedy, not merely the complaint: ADR-0025 makes this one line of one file.
		expect(run.output).toContain('REMOTE_ARCHIVE');
		expect(run.output).toContain('archive that deployment controls');
		expect(run.output).toContain('streets, physical');
	});

	it('accepts the same catalog once it is repointed', () => {
		const run = runCheck(catalogNaming(CONTROLLED), { deployment: true });

		expect(run.status).toBe(0);
		expect(run.output).toContain('2 entries named nowhere else');
	});

	it('accepts a repointed catalog whose comment still explains the demo bucket', () => {
		// Matching raw file text blocked a deployment that had done the right thing and kept the
		// paragraph saying why — offering "delete the explanation" as the remedy.
		const run = runCheck(
			catalogNaming(
				CONTROLLED,
				'// Not demo-bucket.protomaps.com: no rate limit, no uptime promise, no terms of use.\n'
			),
			{ deployment: true }
		);

		expect(run.status).toBe(0);
	});

	it('leaves ordinary development green while the catalog reads the demo bucket', () => {
		// The recorded educational-development exception (ADR-0025): contributors stay unblocked.
		const run = runCheck(catalogNaming(DEMO));

		expect(run.status).toBe(0);
		expect(run.output).not.toContain('demo-bucket');
	});

	it('still runs the ADR-0020 containment scan in deployment mode', () => {
		// The deployment branch used to `process.exit(1)` before the scan, so `pnpm check:deployment`
		// — the check gating production — never ran the containment check it is a mode of.
		const leak = { 'apps/editor/src/leak.ts': "export const pinned = 'physical';\n" };

		const both = runCheck(catalogNaming(DEMO), { deployment: true, extraFiles: leak });
		expect(both.status).not.toBe(0);
		expect(both.output).toContain('demo-bucket.protomaps.com');
		expect(both.output).toContain('apps/editor/src/leak.ts');

		// And a repointed catalog with the same leak still fails, on the leak alone.
		const leakOnly = runCheck(catalogNaming(CONTROLLED), { deployment: true, extraFiles: leak });
		expect(leakOnly.status).not.toBe(0);
		expect(leakOnly.output).toContain('apps/editor/src/leak.ts');
	});
});
