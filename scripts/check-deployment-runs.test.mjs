// `pnpm check:deployment` against **this repository's own catalog**, in the ordinary loop.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE GAP THIS CLOSES: A CHECK NOBODY RUNS IS A CHECK THAT HAS ALREADY ROTTED.               │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// `packages/core/src/base-map/deployment-fence.test.ts` already drives
// `scripts/check-base-map-catalog.mjs --deployment` against *synthetic* catalogs, and it is
// thorough: demo bucket refused, repointed catalog accepted, the explanation in a comment not
// mistaken for the URL. What nothing did was run it against the catalog that actually ships.
//
// That mattered on 2026-08-07. `demo-bucket.protomaps.com/v4.pmtiles` began answering 404, so the
// application could not draw a Base Map on this deployment at all — and the check that exists to say
// "this URL is not yours and you cannot rely on it" was, by design, only ever run by hand before a
// production deploy. Nobody deployed, so nobody ran it, so the one mechanical statement about the
// risk sat silent through the whole failure.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS ASSERTS A VERDICT AND DOES NOT SIMPLY RUN THE CHECK
//
// `pnpm check:deployment` **fails today, deliberately**: ADR-0025 records an explicit human decision
// of 2026-08-07 that this educational-development deployment temporarily keeps the demo bucket
// because there is no hosting budget, and that ordinary development stays green while production
// stays blocked. Adding `check:deployment` to `pnpm lint` would therefore make every contributor's
// loop red, which is the one outcome the recorded decision rules out.
//
// So this runs it and asserts that its verdict **matches the catalog**, which is a statement that is
// true in both states and rots in neither:
//
//   - while the catalog reads the demo bucket → the check must fail, name the bucket, and name the
//     remedy. If it ever stops failing, the fence has broken and this test says so.
//   - once the catalog is repointed → the check must pass. Lifting the exception does not require
//     editing this test, which is what would have made it a nuisance and then a lie.
//
// And it prints the verdict either way, so `pnpm test`'s output carries the sentence "production is
// currently blocked, for this reason" rather than leaving it in an ADR nobody re-reads.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPath = path.join(repoRoot, 'packages/core/src/base-map/catalog.ts');

/** The hosts `check-base-map-catalog.mjs --deployment` refuses. Kept in step by the assertions below. */
const UNCONTROLLED_HOST = 'demo-bucket.protomaps.com';

/**
 * Which archive the shipped catalog's entries actually read, with `const` bindings resolved.
 *
 * The same arithmetic the check itself does, and deliberately so: asking whether the *file text*
 * mentions the host would be satisfied by the paragraph in `REMOTE_ARCHIVE`'s comment explaining why
 * the host is unsuitable — the exact false positive `deployment-fence.test.ts` records an earlier
 * version of the fence having had.
 */
function shippedArchives() {
	const source = readFileSync(catalogPath, 'utf8');
	const bindings = new Map(
		[...source.matchAll(/^const\s+(\w+)\s*=\s*'([^']+)';/gm)].map((match) => [match[1], match[2]])
	);
	return [...source.matchAll(/^\s*archive:\s*(?:'([^']*)'|(\w+))\s*,/gm)].map(
		(match) => match[1] ?? bindings.get(match[2]) ?? match[2]
	);
}

function runDeploymentCheck() {
	try {
		const output = execFileSync(
			process.execPath,
			[path.join(repoRoot, 'scripts/check-base-map-catalog.mjs'), '--deployment'],
			{ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
		);
		return { status: 0, output };
	} catch (error) {
		return {
			status: error.status ?? 1,
			output: `${error.stdout ?? ''}${error.stderr ?? ''}`
		};
	}
}

test('the deployment check agrees with the catalog that ships', () => {
	const archives = shippedArchives();
	assert.ok(archives.length > 0, 'no catalog entries were found; this test guarded nothing');

	const uncontrolled = archives.filter((archive) => archive.includes(UNCONTROLLED_HOST));
	const run = runDeploymentCheck();

	if (uncontrolled.length > 0) {
		// The recorded state as of 2026-08-07 (ADR-0025): development keeps the demo bucket by
		// explicit human decision, and production is blocked until `REMOTE_ARCHIVE` is repointed.
		assert.notEqual(
			run.status,
			0,
			`The catalog still reads ${UNCONTROLLED_HOST}, and \`pnpm check:deployment\` passed anyway.\n` +
				'The one mechanical statement that this deployment must not go to production has stopped\n' +
				'being made. Fix the check, not this test.'
		);
		assert.match(run.output, new RegExp(UNCONTROLLED_HOST));
		// The remedy, not merely the complaint — ADR-0020 makes it one line of one file.
		assert.match(run.output, /REMOTE_ARCHIVE/);
		console.log(
			`check:deployment — PRODUCTION BLOCKED, as recorded. ${uncontrolled.length} catalog ` +
				`entr${uncontrolled.length === 1 ? 'y reads' : 'ies read'} ${UNCONTROLLED_HOST}, which ` +
				'has no uptime promise and no terms of use (ADR-0025). It began answering 404 on ' +
				'2026-08-07 and this deployment has been unable to draw a Base Map since. Repointing ' +
				'`REMOTE_ARCHIVE` in packages/core/src/base-map/catalog.ts is the whole fix.'
		);
		return;
	}

	assert.equal(
		run.status,
		0,
		`The catalog names no uncontrolled archive, so \`pnpm check:deployment\` should pass:\n${run.output}`
	);
	console.log(
		'check:deployment — clear. Every catalog entry reads an archive this deployment names.'
	);
});

test('ordinary development stays green while production is blocked', () => {
	// The other half of the recorded decision, and the half that would break contributors if it
	// regressed: `pnpm lint`'s containment scan must not inherit the deployment refusal. Asserted
	// here against the real catalog, because `deployment-fence.test.ts` asserts it against a
	// synthetic one and the two can disagree.
	const run = execFileSync(
		process.execPath,
		[path.join(repoRoot, 'scripts/check-base-map-catalog.mjs')],
		{ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
	);

	assert.doesNotMatch(run, new RegExp(UNCONTROLLED_HOST));
});
