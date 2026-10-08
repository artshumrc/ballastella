#!/usr/bin/env node

import process from 'node:process';

import {
	assertControls,
	failWith,
	importOwner,
	matchControls,
	ownersAndTests,
	scanLines
} from './fence.mjs';

const serviceModule = 'packages/core/src/places/service.ts';
const isExempt = ownersAndTests(serviceModule, 'scripts/check-place-service.mjs');

const deploymentCheck = process.argv.includes('--deployment');
const BORROWED_SERVICES = new Set(['nominatim.openstreetmap.org']);
const BORROWED_LOOKUP_MARKER = '::borrowed-lookup-service::';

const { PLACE_SERVICE } = await importOwner(serviceModule);

let host = '';
try {
	host = new URL(PLACE_SERVICE.searchUrl('a place')).host;
} catch {}
if (host === '') {
	console.error(
		`\n${serviceModule}: no service host could be read out of \`searchUrl\`. This check cannot do\n` +
			'its job — it would scan for the empty string and report every file as clean.\n'
	);
	process.exit(1);
}

const brand = host.split('.')[0].replace(/^./, (letter) => letter.toUpperCase());

const KNOWN_BAD = [
	{ line: `const SERVICE = 'https://${host}';`, expect: 'the host in a string literal' },
	{ line: `// requests go to ${host} unless overridden`, expect: 'the host in a comment' },
	{ line: `fetch(\`https://${host}/search?q=\${query}\`)`, expect: 'the host inside a template' },
	{ line: `const SERVICE = 'HTTPS://${host.toUpperCase()}';`, expect: 'the host shouted' }
];

const KNOWN_GOOD = [
	`// ${brand}'s policy prohibits client-side autocomplete outright.`,
	`// \`[south, north, west, east]\`, which is the order ${brand} writes a bounding box in.`
];

const namesHost = (line) => line.toLowerCase().includes(host.toLowerCase());

assertControls(
	matchControls(namesHost, KNOWN_BAD, KNOWN_GOOD),
	'The scan is on the service **host**: naming the service in prose is documentation, and\n' +
		'naming its address anywhere outside the configuration module is a dependency.',
	'ADR-0029'
);

if (deploymentCheck && BORROWED_SERVICES.has(host)) {
	console.log(BORROWED_LOOKUP_MARKER);
	console.log(
		`\nWARNING: place lookup reads ${host}, which this deployment does not run.\n\n` +
			"It works, keylessly, within that service's published usage policy — human-paced searches,\n" +
			'displayed attribution, no autocomplete — and it is somebody else’s hardware with no promise\n' +
			'to this deployment. Point `PLACE_SERVICE` in\n' +
			`${serviceModule} at a service you run to remove this warning.\n\n` +
			'This does not fail the deployment check, unlike a borrowed Base Map archive: running a\n' +
			'planet-scale geocoder is not a remedy most deployments can take (ADR-0029, docs/hosting.md).\n'
	);
}

failWith(
	`The place lookup service is named outside ${serviceModule} (ADR-0029).`,
	scanLines(isExempt, namesHost).map((violation) => ({ ...violation, why: `“${host}”` })),
	'The service is deployment configuration: a fork must be able to repoint it and change\n' +
		'nothing else, and its attribution has to travel with it. Take the address from\n' +
		'`PLACE_SERVICE` rather than naming the host — including in a comment, which a repoint\n' +
		'leaves saying something untrue.'
);

console.log(`${serviceModule}: ${host} named nowhere else (ADR-0029).`);
