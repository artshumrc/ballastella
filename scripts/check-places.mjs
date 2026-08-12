#!/usr/bin/env node
// `pnpm check:places` — does the configured lookup service still answer, and does it still answer
// the shape this application reads?
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ HAND-RUN. IN NO GATE — NOT `pnpm lint`, NOT `pnpm test`, NOT CI. THIS IS THE ONE THING IN  │
// │ THIS REPOSITORY PERMITTED TO REACH THE NETWORK, AND BEING OUTSIDE EVERY GATE IS *WHY*.     │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// No test may depend on the network — the standing rule, enforced by `e2e/support/network-fence.ts`
// and `scripts/check-e2e-network-fence.mjs`. In a gate, this script would hand a stranger's uptime
// the power to turn this repository red, which is that rule's whole subject. **Do not add it to
// one**, however tempting the coverage looks.
//
// It exists because a fixture is a snapshot of an assumption. Every test of the lookup drives a
// captured response, and a captured response goes on passing forever after reality has moved. This
// repository has been bitten by exactly that: `demo-bucket.protomaps.com` did not change shape, it
// vanished, and nothing in the suite could have said so.
//
// And it gives a forker something they would otherwise lack — a way to find out they configured the
// service wrongly before their students do (SPEC story 28).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceModule = 'packages/core/src/places/service.ts';
const lookupModule = 'packages/core/src/places/lookup.ts';

let PLACE_SERVICE;
try {
	({ PLACE_SERVICE } = await import(pathToFileURL(path.join(repoRoot, serviceModule)).href));
} catch (error) {
	fail(
		`${serviceModule} could not be loaded, so there is no service to ask.`,
		`${error instanceof Error ? error.message : String(error)}\n\n` +
			'Mid-repoint, this is the file to look at. Node runs the TypeScript directly ' +
			'(type-stripping, Node 22.18+), so a construct it cannot erase reads as a syntax error here.'
	);
}

/**
 * A query with several real answers, so an empty result is evidence about the service rather than
 * about the query. Springfield is the disambiguation case the whole candidate list exists for.
 */
const QUERY = 'Springfield';

/** Long enough that a slow answer is an answer. The app waits ten seconds; a person here can wait. */
const TIMEOUT_MS = 15_000;

/**
 * The fields `readPlace` reads, **read out of `readPlace`** rather than copied beside it.
 *
 * The whole of what this application depends on: the service answers a great deal more —
 * `place_id`, `osm_type`, `importance`, `licence` — and none of it is read, so none of it is asked
 * about here. A second copy of the list is the one thing here that can rot silently, because a
 * field added to or dropped from `readPlace` would leave this probe asking the live service about
 * the wrong shape and reporting green. `check-place-service.test.mjs` reads `BORROWED_SERVICES` out
 * of its script for the same reason, and cites the precedent: a hand copy is how
 * `check-deployment-runs.test.mjs` came to describe a catalog this repository had moved off.
 */
function requiredFields() {
	let source;
	try {
		source = readFileSync(path.join(repoRoot, lookupModule), 'utf8');
	} catch (error) {
		fail(
			`${lookupModule} could not be read, so this check does not know what shape to ask about.`,
			`${error instanceof Error ? error.message : String(error)}`
		);
	}
	const body = source.split('function readPlace(')[1]?.split('\nfunction ')[0] ?? '';
	const fields = [...body.matchAll(/record\['([^']+)'\]/g)].map((match) => match[1]);
	if (fields.length === 0) {
		fail(
			`No fields could be read out of \`readPlace\` in ${lookupModule}.`,
			'This check would then assert nothing about the answer and report the service healthy. ' +
				"`readPlace` reads its fields as `record['name']`; if it no longer does, teach this " +
				'function the new spelling rather than writing the list out again here.'
		);
	}
	return fields;
}

const REQUIRED_FIELDS = requiredFields();

let url;
let host;
try {
	url = PLACE_SERVICE.searchUrl(QUERY);
	host = new URL(url).host;
} catch (error) {
	fail(
		`No address could be built out of \`PLACE_SERVICE.searchUrl\` in ${serviceModule}.`,
		`${error instanceof Error ? error.message : String(error)}\n\n` +
			'There is nothing to ask until `searchUrl` returns an absolute URL.'
	);
}

console.log(`Asking ${host} about “${QUERY}” …\n  ${url}\n`);

let response;
try {
	response = await fetch(url, {
		// The default service's policy requires a `Referer` or `User-Agent` identifying the
		// application. A browser sends the first; a script has to say who it is.
		headers: {
			'user-agent': 'ballastella-check-places (https://github.com/artshumrc/ballastella)'
		},
		signal: AbortSignal.timeout(TIMEOUT_MS)
	});
} catch (error) {
	fail(
		`${host} did not answer: ${error instanceof Error ? error.message : String(error)}`,
		'Unreachable, refused, or slower than ' +
			`${TIMEOUT_MS / 1000}s. If this machine is online ` +
			`and ${host} is up, the address in ${serviceModule} is the thing to check.`
	);
}

if (!response.ok) {
	fail(
		`${host} answered HTTP ${response.status} ${response.statusText}.`,
		response.status === 429
			? 'That is the rate limit. This script issues one request; something else on this network is ' +
					'using the same service, or a previous run was moments ago.'
			: 'A geocoder that is up answers 200 to a search. Check the address and the query parameters ' +
					`in ${serviceModule}.`
	);
}

let payload;
try {
	payload = await response.json();
} catch (error) {
	fail(
		`${host} answered 200, and the body is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		'The application folds this into “the service did not answer”, which is the right sentence for ' +
			'a scholar and the wrong one for you — hence this script.'
	);
}

if (!Array.isArray(payload)) {
	fail(
		`${host} answered JSON that is not an array of results (got ${typeof payload}).`,
		`The lookup reads an array. If this service answers a different document, \`readPlace\` in ` +
			'packages/core/src/places/lookup.ts has to be taught it — repointing the address alone is not ' +
			'enough for a service that speaks a different dialect.'
	);
}

if (payload.length === 0) {
	fail(
		`${host} answered 200 with no candidates for “${QUERY}”.`,
		'A working geocoder has several. An empty answer here means the service is up and is not ' +
			'indexing what this application expects it to.'
	);
}

const missing = new Map();
for (const entry of payload) {
	for (const field of REQUIRED_FIELDS) {
		if (entry?.[field] === undefined || entry?.[field] === null) {
			missing.set(field, (missing.get(field) ?? 0) + 1);
		}
	}
}

if (missing.size > 0) {
	fail(
		`${host} answered ${payload.length} candidates, and fields this application reads are absent.`,
		[...missing]
			.map(([field, count]) => `  ${field} — missing from ${count} of ${payload.length}`)
			.join('\n') +
			'\n\nThe committed fixtures still have these fields, so the suite is green and the ' +
			'application is not. Every one of them is read by `readPlace` in ' +
			'packages/core/src/places/lookup.ts.'
	);
}

console.log(
	`${host} answered ${payload.length} candidates, each carrying ${REQUIRED_FIELDS.join(', ')}.\n` +
		`  first: ${payload[0].display_name}\n` +
		`  point: ${payload[0].lat}, ${payload[0].lon}\n` +
		`  bounds: [${payload[0].boundingbox.join(', ')}]\n\n` +
		`Attribution shown beside candidates: ${PLACE_SERVICE.attribution?.text ?? '(none configured)'} ` +
		`(${PLACE_SERVICE.attribution?.href ?? 'no link'})`
);

/**
 * Say what happened and what to do about it, then stop.
 *
 * @param {string} what @param {string} remedy @returns {never}
 */
function fail(what, remedy) {
	console.error(`\n${what}\n\n${remedy}\n`);
	process.exit(1);
}
