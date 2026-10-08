import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { hostOf } from './fence.mjs';
import { escaped, repoRoot, runScript, setMembers } from './test-support.mjs';

const catalogPath = path.join(repoRoot, 'packages/core/src/base-map/catalog.ts');
const checkPath = path.join(repoRoot, 'scripts/check-base-map-catalog.mjs');
const refusedHosts = () => new Set(setMembers('check-base-map-catalog.mjs', 'UNCONTROLLED_HOSTS'));

function shippedArchives() {
	const source = readFileSync(catalogPath, 'utf8');
	const bindings = new Map(
		[...source.matchAll(/^const\s+(\w+)\s*=\s*'([^']+)';/gm)].map((match) => [match[1], match[2]])
	);
	return [...source.matchAll(/^\s*archive:\s*(?:'([^']*)'|(\w+))\s*,?$/gm)].map(
		(match) => match[1] ?? bindings.get(match[2]) ?? match[2]
	);
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
	const run = runScript(checkPath, ['--deployment']);
	const hosts = [...new Set(uncontrolled.map(hostOf))];

	if (uncontrolled.length > 0) {
		assert.notEqual(
			run.status,
			0,
			`The catalog still reads ${hosts.join(', ')}, and \`pnpm check:deployment\` passed anyway.\n` +
				'The one mechanical statement that this deployment must not go to production has stopped\n' +
				'being made. Fix the check, not this test.'
		);
		for (const host of hosts) assert.match(run.output, new RegExp(escaped(host)));
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
	const { status, output } = runScript(checkPath);
	assert.equal(status, 0, output);
	for (const host of refusedHosts()) assert.doesNotMatch(output, new RegExp(escaped(host)));
});
