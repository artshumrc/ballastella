// The place lookup service's fences (ADR-0029): the containment scan, and the composite
// `pnpm check:deployment` it now sits inside.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ BOTH HALVES OF THE COMPOSITE, OR NEITHER IS ASSERTED.                                      │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// `check:deployment` now runs two checks that disagree about what a failure is: the Base Map archive
// **fails**, the lookup service **warns and stays green**. A composite written as `a && b` passes a
// test written for either half alone — the Base Map half looks right because it still fails, and the
// lookup half looks right on a tree where the Base Map happens to pass. So every composite case below
// asserts the exit code *and* that the lookup warning was printed, and the two synthetic cases put
// the failing check first, which is the order in which a short-circuit is invisible.
//
// The synthetic-repository idiom is `packages/core/src/base-map/deployment-fence.test.ts`'s: the
// scripts derive their root from their own location, so a temp directory holding copies of them and
// the two configuration modules is a complete deployment as far as they are concerned. This
// repository's own tree cannot exercise both verdicts — its Base Map archive is borrowed by a
// recorded decision (ADR-0025), so the composite fails here today and the passing branch would never
// run.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_RELATIVE = 'packages/core/src/places/service.ts';
const CATALOG_RELATIVE = 'packages/core/src/base-map/catalog.ts';

const SCRIPTS = ['check-deployment.mjs', 'check-base-map-catalog.mjs', 'check-place-service.mjs'];

/**
 * The hosts `check-place-service.mjs --deployment` warns about, **read out of the check itself**.
 *
 * A second copy of that list is how `check-deployment-runs.test.mjs` came to describe a catalog this
 * repository had already moved off. `assert.ok` below is the guard that matters: a rename here
 * yields an empty set, the "borrowed" case would silently become the "repointed" case, and both
 * branches would go vacuously green.
 */
function borrowedServices() {
	const source = readFileSync(path.join(repoRoot, 'scripts/check-place-service.mjs'), 'utf8');
	const set = source.match(/const\s+BORROWED_SERVICES\s*=\s*new Set\(\[([^\]]*)\]\)/);
	return [...(set?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const [borrowedHost] = borrowedServices();
assert.ok(
	borrowedHost,
	'no BORROWED_SERVICES could be read out of scripts/check-place-service.mjs; every case below\n' +
		'would have been asserting against a service the check has nothing to say about.'
);

/**
 * The token a deploy annotates on, **read out of the check itself** for the same reason
 * `BORROWED_SERVICES` is: a literal copied to here would let the two sides be renamed apart, and the
 * pair of assertions below would go on passing against a token nothing prints.
 */
const BORROWED_LOOKUP_MARKER = (() => {
	const source = readFileSync(path.join(repoRoot, 'scripts/check-place-service.mjs'), 'utf8');
	return source.match(/const\s+BORROWED_LOOKUP_MARKER\s*=\s*'([^']+)'/)?.[1];
})();
assert.ok(
	BORROWED_LOOKUP_MARKER,
	'no BORROWED_LOOKUP_MARKER could be read out of scripts/check-place-service.mjs; the two cases\n' +
		'below would have been asserting that `undefined` was absent from some output.'
);

/**
 * A configuration module whose lookup goes to `host`. Plain JS is valid TypeScript.
 *
 * `attributionHost` is separate because the two are separate in principle and identical in the most
 * ordinary fork: somebody running their own geocoder credits that same instance.
 */
const serviceNaming = (host, attributionHost = 'example.org') => `export const PLACE_SERVICE = {
	searchUrl: (query) => \`https://${host}/search?q=\${encodeURIComponent(query)}&format=jsonv2\`,
	attribution: { text: '© Somebody', href: 'https://${attributionHost}/copyright' }
};
`;

/**
 * A Base Map catalog reading `archive`. Only the fields the Base Map check reads are present.
 *
 * The entry id is one this repository's real catalog does not hold, because `pnpm lint` runs the
 * Base Map containment scan over `scripts/` and this file is not among the exemptions it grants.
 */
const catalogNaming = (archive) => `const REMOTE_ARCHIVE = '${archive}';

export const BASE_MAP_CATALOG = {
	entries: [
		{
			id: 'the-only-entry',
			label: 'The only entry',
			archive: REMOTE_ARCHIVE,
		}
	],
	defaultId: 'the-only-entry'
};
`;

/** An archive `check-base-map-catalog.mjs --deployment` refuses, read out of that check. */
function refusedArchive() {
	const source = readFileSync(path.join(repoRoot, 'scripts/check-base-map-catalog.mjs'), 'utf8');
	const set = source.match(/const\s+UNCONTROLLED_HOSTS\s*=\s*new Set\(\[([^\]]*)\]\)/);
	const host = /'([^']+)'/.exec(set?.[1] ?? '')?.[1];
	assert.ok(host, 'no UNCONTROLLED_HOSTS could be read; the failing half would not have failed.');
	return `https://${host}/v4.pmtiles`;
}

/**
 * Run `script` inside a throwaway repository.
 *
 * @param {string} script @param {string[]} argv
 * @param {{ service?: string, catalog?: string, extraFiles?: Record<string, string> }} options
 */
function runIn(script, argv, options = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'ballastella-places-'));
	try {
		mkdirSync(path.join(root, 'scripts'), { recursive: true });
		for (const name of SCRIPTS) {
			cpSync(path.join(repoRoot, 'scripts', name), path.join(root, 'scripts', name));
		}
		for (const [relative, contents] of Object.entries({
			[SERVICE_RELATIVE]: options.service ?? serviceNaming(borrowedHost),
			...(options.catalog === undefined ? {} : { [CATALOG_RELATIVE]: options.catalog }),
			...(options.extraFiles ?? {})
		})) {
			const file = path.join(root, relative);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}
		const run = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...argv], {
			cwd: root,
			encoding: 'utf8'
		});
		return { status: run.status, output: `${run.stdout}${run.stderr}` };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ── The containment scan ──────────────────────────────────────────────────────────────────────

test('the containment scan passes on a tree that names the service nowhere else', () => {
	const run = runIn('check-place-service.mjs', [], {
		extraFiles: { 'packages/core/src/places/lookup.ts': 'export const lookUp = () => {};\n' }
	});
	assert.equal(run.status, 0, run.output);
});

test('the containment scan fails when a module outside the service names its host', () => {
	const run = runIn('check-place-service.mjs', [], {
		extraFiles: {
			'apps/editor/src/lib/search.ts': `const FALLBACK = 'https://${borrowedHost}/search';\n`
		}
	});
	assert.notEqual(run.status, 0, `a planted service host was not caught:\n${run.output}`);
	assert.match(run.output, /apps\/editor\/src\/lib\/search\.ts/);
});

test('the containment scan catches a host pasted into a comment', () => {
	// A comment naming the address is a claim the very next repoint makes untrue, so it is caught
	// where a comment naming a Base Map *variant* is not: an id is documentation, an address is not.
	const run = runIn('check-place-service.mjs', [], {
		extraFiles: { 'packages/core/src/places/notice.ts': `// answers come from ${borrowedHost}\n` }
	});
	assert.notEqual(run.status, 0, `a host in a comment was not caught:\n${run.output}`);
});

test('the containment scan does not fire on prose naming the service without its host', () => {
	// `lookup.ts` quotes the default service's autocomplete policy by name, several times. A scan
	// widened to the brand would fail `pnpm lint` on that paragraph and offer "delete it" as the fix.
	const brand = borrowedHost.split('.')[0].replace(/^./, (letter) => letter.toUpperCase());
	const run = runIn('check-place-service.mjs', [], {
		extraFiles: {
			'packages/core/src/places/lookup.ts':
				`// ${brand}'s policy states that autocomplete "is not yet supported by ${brand} and you\n` +
				`// must not implement such a service on the client side using the API".\n` +
				`// \`[south, north, west, east]\` is the order ${brand} writes a bounding box in.\n`
		}
	});
	assert.equal(run.status, 0, `prose naming the service was refused:\n${run.output}`);
});

test('the positive control accepts a fork whose attribution points at its own service', () => {
	// The most ordinary self-hosting configuration there is, and the one this check must never
	// refuse: the geocoder and the credit are the same instance, so the host is inside the
	// attribution href. A positive control built out of live attribution values reads that as
	// "a legitimate line is now refused" and hard-fails `pnpm lint` — on the fork, where nobody is
	// looking, which is the failure class `check-base-map-catalog.mjs` exists to prevent.
	const run = runIn('check-place-service.mjs', [], {
		service: serviceNaming('nominatim.example.edu', 'nominatim.example.edu')
	});
	assert.equal(
		run.status,
		0,
		`A fork attributing its own geocoder was refused by this check's own positive control:\n${run.output}`
	);
});

test('the check refuses to run when no host can be read out of `searchUrl`', () => {
	// The check's principal self-protection. A `searchUrl` that yields no host would have it scan
	// for the empty string and report every file as clean — a fence that passes because it stopped
	// asking, which is worse than no fence.
	const run = runIn('check-place-service.mjs', [], {
		service: 'export const PLACE_SERVICE = { searchUrl: (query) => query };\n'
	});
	assert.notEqual(run.status, 0, `an unreadable service address was accepted:\n${run.output}`);
	assert.match(run.output, /cannot do\n?its job/);
});

test('the check says so when the configuration module cannot be loaded', () => {
	const run = runIn('check-place-service.mjs', [], {
		service: 'export const PLACE_SERVICE = {\n'
	});
	assert.notEqual(run.status, 0, `a broken configuration module was accepted:\n${run.output}`);
	assert.match(run.output, /places\/service\.ts/);
	assert.match(run.output, /cannot do\n?its job/);
	assert.doesNotMatch(
		run.output,
		/node:internal/,
		`a stack trace reached a forker mid-repoint instead of a sentence:\n${run.output}`
	);
});

// ── The deployment mode: it warns, and it does not fail ───────────────────────────────────────

test('the deployment mode warns about the borrowed service and exits 0', () => {
	const run = runIn('check-place-service.mjs', ['--deployment']);
	assert.equal(
		run.status,
		0,
		'The lookup service warning has been tightened into a failure. Read the remedy argument on\n' +
			'`BORROWED_SERVICES` in scripts/check-place-service.mjs, and ADR-0029, before changing\n' +
			`this.\n${run.output}`
	);
	assert.match(run.output, new RegExp(`WARNING[\\s\\S]*${borrowedHost.replaceAll('.', '\\.')}`));
});

test('the deployment mode says nothing about a service the deployment runs', () => {
	const run = runIn('check-place-service.mjs', ['--deployment'], {
		service: serviceNaming('places.example.edu')
	});
	assert.equal(run.status, 0, run.output);
	assert.doesNotMatch(run.output, /WARNING/);
});

// ⚠ **The marker a deploy annotates on**, asserted in both directions because only the pair says
// anything. The annotation cannot hang off an exit code — this half exits 0 whatever the answer —
// so `.github/workflows/pages.yml` watches for this token instead. Present-when-borrowed alone
// would still pass if the token were printed unconditionally, which is the version that tells a
// fork running its own geocoder that it had borrowed one.
test('the borrowed-service marker is printed for a borrowed service and for no other', () => {
	const borrowed = runIn('check-place-service.mjs', ['--deployment']);
	assert.ok(
		borrowed.output.includes(BORROWED_LOOKUP_MARKER),
		`A deploy annotates on this token; without it the warning reaches no run summary.\n${borrowed.output}`
	);

	const own = runIn('check-place-service.mjs', ['--deployment'], {
		service: serviceNaming('places.example.edu')
	});
	assert.ok(
		!own.output.includes(BORROWED_LOOKUP_MARKER),
		`A deployment running its own service would be annotated as borrowing one.\n${own.output}`
	);
});

test('the workflow annotates on the marker the check actually prints', () => {
	// The two halves live in different files and nothing else ties them together: a rename of the
	// token on one side would leave the deploy silently un-annotated, which is the failure this
	// whole item exists to end.
	const workflow = readFileSync(path.join(repoRoot, '.github/workflows/pages.yml'), 'utf8');
	assert.ok(
		workflow.includes(BORROWED_LOOKUP_MARKER),
		'pages.yml no longer watches for the token check-place-service.mjs prints.'
	);
});

// ── The composite ─────────────────────────────────────────────────────────────────────────────

test('the composite still fails for a borrowed Base Map archive, and warns anyway', () => {
	const run = runIn('check-deployment.mjs', [], { catalog: catalogNaming(refusedArchive()) });

	assert.notEqual(
		run.status,
		0,
		`A borrowed Base Map archive no longer blocks \`pnpm check:deployment\`:\n${run.output}`
	);
	// The half a short-circuit would eat. The Base Map check runs first and fails first, so a
	// composite that stopped there would print everything above this line and none of it.
	assert.match(
		run.output,
		new RegExp(`WARNING[\\s\\S]*${borrowedHost.replaceAll('.', '\\.')}`),
		`The composite failed on the Base Map and never reached the lookup service:\n${run.output}`
	);
});

test('the composite passes once the Base Map archive is one the deployment controls', () => {
	const run = runIn('check-deployment.mjs', [], {
		catalog: catalogNaming('https://tiles.example.edu/planet.pmtiles')
	});

	assert.equal(
		run.status,
		0,
		`The lookup warning is failing the deployment check on a clean Base Map:\n${run.output}`
	);
	assert.match(run.output, new RegExp(`WARNING[\\s\\S]*${borrowedHost.replaceAll('.', '\\.')}`));
});

test('the composite on this repository agrees with the Base Map check, and warns either way', () => {
	// Against the tree that ships, in the ordinary loop — the discipline
	// `check-deployment-runs.test.mjs` exists for: a check nobody runs is a check that has rotted.
	const baseMap = spawnSync(
		process.execPath,
		[path.join(repoRoot, 'scripts/check-base-map-catalog.mjs'), '--deployment'],
		{ cwd: repoRoot, encoding: 'utf8' }
	);
	const composite = spawnSync(
		process.execPath,
		[path.join(repoRoot, 'scripts/check-deployment.mjs')],
		{ cwd: repoRoot, encoding: 'utf8' }
	);
	const output = `${composite.stdout}${composite.stderr}`;

	assert.equal(
		composite.status === 0,
		baseMap.status === 0,
		`\`pnpm check:deployment\` and the Base Map check it composes disagree about this tree.\n` +
			`The lookup service must not change the verdict — it warns.\n${output}`
	);
	assert.match(
		output,
		new RegExp(`WARNING[\\s\\S]*${borrowedHost.replaceAll('.', '\\.')}`),
		`\`pnpm check:deployment\` said nothing about the lookup service:\n${output}`
	);
	console.log(
		`check:deployment — ${composite.status === 0 ? 'clear' : 'BLOCKED'} on the Base Map archive, ` +
			`and warning about ${borrowedHost}, which this deployment does not run. The warning is ` +
			'deliberate and does not block (ADR-0029).'
	);
});

// ── The one command permitted out ─────────────────────────────────────────────────────────────

test('check:places is in no gate — not lint, not test, not CI', () => {
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	assert.ok(manifest.scripts['check:places'], 'there is no `check:places` for this test to guard');

	// Named by either spelling: a gate could call the script directly rather than through pnpm.
	const reachesTheNetwork = /check:places|check-places\.mjs/;

	// Every script the manifest declares, rather than a list written here: a hand-written one was
	// already missing `test:e2e`, `check:dev`, `flake:check` and `build:deploy`, and the next script
	// added would have been missing too. `check:places` is the one that is allowed to say it.
	for (const [gate, command] of Object.entries(manifest.scripts)) {
		if (gate === 'check:places') continue;
		assert.doesNotMatch(
			command,
			reachesTheNetwork,
			`\`pnpm ${gate}\` runs check:places. It reaches a service this repository does not run, so a\n` +
				"stranger's uptime would turn this suite red — which is the whole subject of the standing\n" +
				'rule that no test may depend on the network (ADR-0029).'
		);
	}

	const workflows = path.join(repoRoot, '.github/workflows');
	const files = readdirSync(workflows);
	assert.ok(files.length > 0, `no workflows found in ${workflows}; this test guarded nothing`);
	for (const file of files) {
		assert.doesNotMatch(
			readFileSync(path.join(workflows, file), 'utf8'),
			reachesTheNetwork,
			`.github/workflows/${file} runs check:places. It must be hand-run and in no gate (ADR-0029).`
		);
	}
});
