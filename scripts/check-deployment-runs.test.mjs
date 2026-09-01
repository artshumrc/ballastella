// `check-base-map-catalog.mjs --deployment` against **this repository's own catalog**, in the
// ordinary loop. That check is one half of what `pnpm check:deployment` now composes; the composite
// itself, and the lookup service beside it, are `check-place-service.test.mjs`'s.
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

const checkPath = path.join(repoRoot, 'scripts/check-base-map-catalog.mjs');

/**
 * The hosts `check-base-map-catalog.mjs --deployment` refuses, **read out of the check itself**.
 *
 * This was a second copy of that list — one host, `demo-bucket.protomaps.com`, with a comment
 * claiming the assertions below kept it in step. They did not, and on 2026-08-10 the copy went
 * stale in the one direction that breaks the suite rather than the fence. `REMOTE_ARCHIVE` was
 * repointed off the demo bucket and onto `data.source.coop`, which the check already refuses and
 * this file had never heard of. So the catalog looked clear from here, this test took its
 * "repointed, therefore the check must pass" branch, the check went on refusing the new host — and
 * the failure read as a broken fence when the fence was the only part working.
 *
 * The check is a top-level script rather than a module, so importing the set would run it. Reading
 * it is the same arithmetic-on-source this file already does to the catalog, and it means a third
 * borrowed host is described in exactly one place. `assert.ok` below is the guard that matters: a
 * rename here yields an empty set, every archive looks controlled, and both branches would go
 * vacuously green — which is the shape of failure this whole file exists to refuse.
 */
function refusedHosts() {
	const source = readFileSync(checkPath, 'utf8');
	const set = source.match(/const\s+UNCONTROLLED_HOSTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
	return new Set([...(set?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]));
}

/** Host equality, not substring — the comparison the check makes, for the reason it records. */
const hostOf = (archive) => {
	try {
		return new URL(archive).host;
	} catch {
		return '';
	}
};

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
	return [...source.matchAll(/^\s*archive:\s*(?:'([^']*)'|(\w+))\s*,?$/gm)].map(
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

	const refused = refusedHosts();
	assert.ok(
		refused.size > 0,
		`no UNCONTROLLED_HOSTS could be read out of ${path.relative(repoRoot, checkPath)}; this test\n` +
			'guarded nothing. Either the set was renamed — update `refusedHosts` — or the check has\n' +
			'stopped naming any host as uncontrolled, which is a claim that needs an ADR behind it.'
	);

	const uncontrolled = archives.filter((archive) => refused.has(hostOf(archive)));
	const run = runDeploymentCheck();

	// Whichever borrowed hosts the catalog actually reads, named rather than assumed — the repoint of
	// 2026-08-10 moved between two of them, and a message that named only the one it left would have
	// misreported the state it was describing.
	const hosts = [...new Set(uncontrolled.map(hostOf))];

	if (uncontrolled.length > 0) {
		// The recorded state (ADR-0025): development keeps a borrowed archive by explicit human
		// decision, and production is blocked until `REMOTE_ARCHIVE` reads one deployment controls.
		assert.notEqual(
			run.status,
			0,
			`The catalog still reads ${hosts.join(', ')}, and \`pnpm check:deployment\` passed anyway.\n` +
				'The one mechanical statement that this deployment must not go to production has stopped\n' +
				'being made. Fix the check, not this test.'
		);
		for (const host of hosts) assert.match(run.output, new RegExp(host.replaceAll('.', '\\.')));
		// The remedy, not merely the complaint — ADR-0020 makes it one line of one file.
		assert.match(run.output, /REMOTE_ARCHIVE/);
		console.log(
			`check:deployment — PRODUCTION BLOCKED, as recorded. ${uncontrolled.length} catalog ` +
				`entr${uncontrolled.length === 1 ? 'y reads' : 'ies read'} ${hosts.join(', ')}, which ` +
				'this deployment does not control (ADR-0025) — no uptime promise, and no terms that ' +
				'permit relying on it. The demo bucket named in that ADR began answering 404 on ' +
				'2026-08-07; the mirror replacing it answers, and is borrowed just the same. Repointing ' +
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
	const run = execFileSync(process.execPath, [checkPath], {
		cwd: repoRoot,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe']
	});

	// Every host the deployment mode refuses, not just the one this file used to name: the point is
	// that *no* part of the deployment refusal leaks into the ordinary loop.
	for (const host of refusedHosts()) {
		assert.doesNotMatch(run, new RegExp(host.replaceAll('.', '\\.')));
	}
});
