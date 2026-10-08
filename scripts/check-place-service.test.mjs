import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { escaped, repoRoot, runScript, setMembers, withTree } from './test-support.mjs';

const SERVICE_RELATIVE = 'packages/core/src/places/service.ts';
const CATALOG_RELATIVE = 'packages/core/src/base-map/catalog.ts';

const [borrowedHost] = setMembers('check-place-service.mjs', 'BORROWED_SERVICES');
assert.ok(
	borrowedHost,
	'no BORROWED_SERVICES could be read out of scripts/check-place-service.mjs; every case below\n' +
		'would have been asserting against a service the check has nothing to say about.'
);
const WARNS_OF_BORROWED = new RegExp(`WARNING[\\s\\S]*${escaped(borrowedHost)}`);

const BORROWED_LOOKUP_MARKER = readFileSync(
	path.join(repoRoot, 'scripts/check-place-service.mjs'),
	'utf8'
).match(/const\s+BORROWED_LOOKUP_MARKER\s*=\s*'([^']+)'/)?.[1];
assert.ok(
	BORROWED_LOOKUP_MARKER,
	'no BORROWED_LOOKUP_MARKER could be read out of scripts/check-place-service.mjs; the two cases\n' +
		'below would have been asserting that `undefined` was absent from some output.'
);

const serviceNaming = (host, attributionHost = 'example.org') => `export const PLACE_SERVICE = {
	searchUrl: (query) => \`https://${host}/search?q=\${encodeURIComponent(query)}&format=jsonv2\`,
	attribution: { text: '© Somebody', href: 'https://${attributionHost}/copyright' }
};
`;

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

function refusedArchive() {
	const [host] = setMembers('check-base-map-catalog.mjs', 'UNCONTROLLED_HOSTS');
	assert.ok(host, 'no UNCONTROLLED_HOSTS could be read; the failing half would not have failed.');
	return `https://${host}/v4.pmtiles`;
}

const runIn = (script, argv, options = {}) =>
	withTree(
		{
			[SERVICE_RELATIVE]: options.service ?? serviceNaming(borrowedHost),
			...(options.catalog === undefined ? {} : { [CATALOG_RELATIVE]: options.catalog }),
			...(options.extraFiles ?? {})
		},
		(root) => runScript(path.join(root, 'scripts', script), argv, root),
		['check-deployment.mjs', 'check-base-map-catalog.mjs', 'check-place-service.mjs', 'fence.mjs']
	);

const scan = (options) => runIn('check-place-service.mjs', [], options);
const brand = borrowedHost.split('.')[0].replace(/^./, (letter) => letter.toUpperCase());

for (const { name, options } of [
	{
		name: 'the containment scan passes on a tree that names the service nowhere else',
		options: {
			extraFiles: { 'packages/core/src/places/lookup.ts': 'export const lookUp = () => {};\n' }
		}
	},
	{
		name: 'the containment scan does not fire on prose naming the service without its host',
		options: {
			extraFiles: {
				'packages/core/src/places/lookup.ts':
					`// ${brand}'s policy states that autocomplete "is not yet supported by ${brand} and you\n` +
					`// must not implement such a service on the client side using the API".\n` +
					`// \`[south, north, west, east]\` is the order ${brand} writes a bounding box in.\n`
			}
		}
	},
	{
		name: 'the positive control accepts a fork whose attribution points at its own service',
		options: { service: serviceNaming('nominatim.example.edu', 'nominatim.example.edu') }
	}
]) {
	test(name, () => {
		const run = scan(options);
		assert.equal(run.status, 0, run.output);
	});
}

for (const { name, file, line } of [
	{
		name: 'the containment scan fails when a module outside the service names its host',
		file: 'apps/editor/src/lib/search.ts',
		line: `const FALLBACK = 'https://${borrowedHost}/search';\n`
	},
	{
		name: 'the containment scan catches a host pasted into a comment',
		file: 'packages/core/src/places/notice.ts',
		line: `// answers come from ${borrowedHost}\n`
	}
]) {
	test(name, () => {
		const run = scan({ extraFiles: { [file]: line } });
		assert.notEqual(run.status, 0, `a planted service host was not caught:\n${run.output}`);
		assert.match(run.output, new RegExp(escaped(file)));
	});
}

test('the check refuses to run when no host can be read out of `searchUrl`', () => {
	const run = scan({ service: 'export const PLACE_SERVICE = { searchUrl: (query) => query };\n' });
	assert.notEqual(run.status, 0, `an unreadable service address was accepted:\n${run.output}`);
	assert.match(run.output, /cannot do\n?its job/);
});

test('the check says so when the configuration module cannot be loaded', () => {
	const run = scan({ service: 'export const PLACE_SERVICE = {\n' });
	assert.notEqual(run.status, 0, `a broken configuration module was accepted:\n${run.output}`);
	assert.match(run.output, /places\/service\.ts/);
	assert.match(run.output, /cannot do\n?its job/);
	assert.doesNotMatch(
		run.output,
		/node:internal/,
		`a stack trace reached a forker mid-repoint instead of a sentence:\n${run.output}`
	);
});

test('the deployment mode warns about the borrowed service, with the marker, and exits 0', () => {
	const run = runIn('check-place-service.mjs', ['--deployment']);
	assert.equal(
		run.status,
		0,
		'The lookup service warning has been tightened into a failure. Read the remedy argument on\n' +
			'`BORROWED_SERVICES` in scripts/check-place-service.mjs, and ADR-0029, before changing\n' +
			`this.\n${run.output}`
	);
	assert.match(run.output, WARNS_OF_BORROWED);
	assert.ok(
		run.output.includes(BORROWED_LOOKUP_MARKER),
		`A deploy annotates on this token; without it the warning reaches no run summary.\n${run.output}`
	);
});

test('the deployment mode says nothing, and prints no marker, for a service the deployment runs', () => {
	const run = runIn('check-place-service.mjs', ['--deployment'], {
		service: serviceNaming('places.example.edu')
	});
	assert.equal(run.status, 0, run.output);
	assert.doesNotMatch(run.output, /WARNING/);
	assert.ok(
		!run.output.includes(BORROWED_LOOKUP_MARKER),
		`A deployment running its own service would be annotated as borrowing one.\n${run.output}`
	);
});

test('the workflow annotates on the marker the check actually prints', () => {
	const workflow = readFileSync(path.join(repoRoot, '.github/workflows/pages.yml'), 'utf8');
	assert.ok(
		workflow.includes(BORROWED_LOOKUP_MARKER),
		'pages.yml no longer watches for the token check-place-service.mjs prints.'
	);
});

test('the composite still fails for a borrowed Base Map archive, and warns anyway', () => {
	const run = runIn('check-deployment.mjs', [], { catalog: catalogNaming(refusedArchive()) });

	assert.notEqual(
		run.status,
		0,
		`A borrowed Base Map archive no longer blocks \`pnpm check:deployment\`:\n${run.output}`
	);
	assert.match(
		run.output,
		WARNS_OF_BORROWED,
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
	assert.match(run.output, WARNS_OF_BORROWED);
});

test('the composite on this repository agrees with the Base Map check, and warns either way', () => {
	const baseMap = runScript(path.join(repoRoot, 'scripts/check-base-map-catalog.mjs'), [
		'--deployment'
	]);
	const composite = runScript(path.join(repoRoot, 'scripts/check-deployment.mjs'));
	const { output } = composite;

	assert.equal(
		composite.status === 0,
		baseMap.status === 0,
		`\`pnpm check:deployment\` and the Base Map check it composes disagree about this tree.\n` +
			`The lookup service must not change the verdict — it warns.\n${output}`
	);
	assert.match(
		output,
		WARNS_OF_BORROWED,
		`\`pnpm check:deployment\` said nothing about the lookup service:\n${output}`
	);
	console.log(
		`check:deployment — ${composite.status === 0 ? 'clear' : 'BLOCKED'} on the Base Map archive, ` +
			`and warning about ${borrowedHost}, which this deployment does not run. The warning is ` +
			'deliberate and does not block (ADR-0029).'
	);
});

test('check:places is in no gate — not lint, not test, not CI', () => {
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	assert.ok(manifest.scripts['check:places'], 'there is no `check:places` for this test to guard');

	const reachesTheNetwork = /check:places|check-places\.mjs/;

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
