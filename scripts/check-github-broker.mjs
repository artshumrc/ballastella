#!/usr/bin/env node
// ADR-0031: the broker's address and the GitHub App's client ID are deployment configuration, and
// repointing them must require no change anywhere else. `packages/core/src/remote/github-app.ts`
// says "change this file, and nothing else"; this is what asserts it.
//
// The third instance of the pattern `check-base-map-catalog.mjs` and `check-place-service.mjs`
// already use, for the same reason: the violation it catches is a deliberate act that shows up in a
// diff, so the check does not need to be clever.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SCAN IS ON THE VALUES, NOT ON THE SUBJECT
//
// `github-sign-in.ts` explains the broker at length — why a server exists at all, why no repository
// data passes through it, why there is no PKCE — and `docs/hosting.md` Part 1 §6 tells a forker how
// to register an App. A scan widened to the words "broker" or "GitHub App" would fail `pnpm lint` on
// those paragraphs, and the remedy on offer would be "delete the explanation", which is the false
// positive `check-place-service.mjs` records having had against a service *name* and
// `check-base-map-catalog.mjs` against `REMOTE_ARCHIVE`'s comment. So what is scanned for is the two
// values a fork actually repoints: the broker's **host**, and the **client ID**.
//
// `github.com/login/oauth/authorize` is deliberately *not* fenced. It is GitHub's own address, the
// same for every deployment on earth, and it is not the thing a fork changes — it lives in
// `github-sign-in.ts` beside the code that builds the URL, exactly as `GITHUB_API_ORIGIN` does.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE POSITIVE CONTROL IS BUILT FROM A SPECIMEN, NEVER FROM LIVE CONFIGURATION
//
// A substring fence's way of dying is silent: a pattern that matches nothing and a tree with nothing
// to match print the same success line. So `KNOWN_BAD` and `KNOWN_GOOD` below are checked before the
// scan — and they are built from {@link SPECIMEN}, not from `GITHUB_APP`.
//
// ⚠ **That is a recorded lesson, not a preference.** `check-place-service.mjs` carries a warning
// about an earlier version of itself that built a control line out of live configuration and
// hard-failed `pnpm lint` on the most ordinary fork there is. The same trap is sharper here: a fork
// that **empties both values** to turn the front door off is a state this repository explicitly
// supports, and a control built from live values would then be checking that the empty string is
// caught — which every line in the tree contains. The specimen makes the matcher provable whatever
// this deployment happens to be configured with, including not at all.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(here), '..');
const appModule = 'packages/core/src/remote/github-app.ts';

/** Source trees the two values could leak into. Static assets and prose are not code. */
const scannedRoots = [
	'packages/core/src',
	'packages/ui/src',
	'apps/editor/src',
	'apps/viewer/src',
	'scripts',
	'e2e'
];

/**
 * The configuration module, and this fence.
 *
 * **The browser suite is not exempt**, for the reason `check-place-service.mjs` gives about its own:
 * `e2e/` is where an address most plausibly leaks, in a `page.route` naming the host it intercepts.
 * Nothing requires a spec to write either value down — `e2e/support/github-hosts.ts` takes the origin
 * from `GITHUB_APP` and routes that. Unit and component specs stay exempt because they sit beside
 * the module and can be handed a fake App directly, which is what `github-sign-in.test.ts` does.
 */
const exemptFiles = new Set([appModule, path.relative(repoRoot, here).split(path.sep).join('/')]);
const isExempt = (relative) =>
	exemptFiles.has(relative) ||
	relative.endsWith('.test.ts') ||
	relative.endsWith('.spec.ts') ||
	// The script suite is a seam of its own, and a test of this check has to name what it plants.
	relative.endsWith('.test.mjs');

/**
 * The configuration module, or one sentence saying why not.
 *
 * A fork mid-repoint is precisely when this module does not parse, and an unhandled rejection in the
 * middle of `pnpm lint` names Node's internals rather than the file to look at.
 */
let GITHUB_APP;
let isGitHubAppConfigured;
try {
	({ GITHUB_APP, isGitHubAppConfigured } = await import(
		pathToFileURL(path.join(repoRoot, appModule)).href
	));
} catch (error) {
	console.error(
		`\n${appModule}: this module could not be loaded, so this check cannot do\nits job.\n\n` +
			`  ${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exit(1);
}

if (typeof GITHUB_APP !== 'object' || GITHUB_APP === null) {
	console.error(`\n${appModule}: exports no \`GITHUB_APP\`, so this check cannot do its job.\n`);
	process.exit(1);
}

/** A line names a value when it contains it, whatever the case. One matcher, live and specimen. */
const namesAny = (values) => (line) => {
	const lowered = line.toLowerCase();
	return values.some((value) => lowered.includes(value.toLowerCase()));
};

// ── Positive control ──────────────────────────────────────────────────────────────────────────

/**
 * A pair that is not, and must never be, this deployment's.
 *
 * `.invalid` is reserved by RFC 2606 and resolves nowhere, so this can never collide with a real
 * broker somebody points this at.
 */
const SPECIMEN = { host: 'broker.specimen.invalid', clientId: 'Iv1.specimenclientid' };

const specimenMatches = namesAny([SPECIMEN.host, SPECIMEN.clientId]);

const KNOWN_BAD = [
	{ line: `const BROKER = 'https://${SPECIMEN.host}';`, expect: 'the broker host in a literal' },
	{ line: `// the exchange goes to ${SPECIMEN.host}`, expect: 'the broker host in a comment' },
	{
		line: `fetch(\`https://${SPECIMEN.host}/github/token\`)`,
		expect: 'the broker host inside a template'
	},
	{ line: `const BROKER = 'HTTPS://${SPECIMEN.host.toUpperCase()}';`, expect: 'the host shouted' },
	{ line: `client_id: '${SPECIMEN.clientId}'`, expect: 'the client ID in a literal' },
	{ line: `// registered as ${SPECIMEN.clientId}`, expect: 'the client ID in a comment' }
];

/**
 * Prose and code that must go on being allowed.
 *
 * The mechanism is explained at length in three places, and GitHub's own authorize address is not
 * deployment configuration — fencing it would move a constant out of the module it belongs beside
 * and buy nothing, since no fork changes it.
 */
const KNOWN_GOOD = [
	'// The broker exchanges a code for a token, and never sees repository data.',
	"// A GitHub App's callback URL is registered per app, so a fork needs its own app.",
	"export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';",
	'const response = await post(`${app.brokerOrigin}/github/token`, body, fetchFn);',
	'routeGitHubHosts(page, { app: GITHUB_APP });'
];

const controlFailures = [];
for (const { line, expect } of KNOWN_BAD) {
	if (!specimenMatches(line)) controlFailures.push(`${expect} is no longer caught`);
}
for (const line of KNOWN_GOOD) {
	if (specimenMatches(line)) controlFailures.push(`a legitimate line is now refused: ${line}`);
}
if (controlFailures.length > 0) {
	console.error('\nThis check can no longer detect what it exists to detect (ADR-0031).\n');
	for (const failure of controlFailures) console.error(`  ${failure}`);
	console.error(
		'\nThe scan is on the **two values** — the broker host and the client ID. Explaining the\n' +
			'broker in prose is documentation; naming its address or the client ID outside the\n' +
			'configuration module is a dependency.\n'
	);
	process.exit(1);
}

// ── What this deployment is configured with ───────────────────────────────────────────────────

const clientId = String(GITHUB_APP.clientId ?? '').trim();
const brokerOrigin = String(GITHUB_APP.brokerOrigin ?? '').trim();

/**
 * The broker's host, or `''` when there is no readable one.
 *
 * Reduced to a host for the reason `check-place-service.mjs` reduces its service to one: a fork may
 * compose the origin however it likes, and the question this asks is what address the browser will
 * actually reach.
 */
const brokerHost = (() => {
	if (brokerOrigin === '') return '';
	try {
		return new URL(brokerOrigin).host;
	} catch {
		return '';
	}
})();

const configured =
	typeof isGitHubAppConfigured === 'function'
		? isGitHubAppConfigured(GITHUB_APP)
		: brokerOrigin !== '' && clientId !== '';

// ⚠ **A half-configured pair is refused outright.** A broker with no client ID has nothing to look a
// secret up by and a client ID with no broker has nowhere to exchange a code, so this is a sign-in
// button that cannot complete — and the scan below would silently cover only the half that was set.
if (!configured && (brokerOrigin !== '' || clientId !== '')) {
	console.error(
		`\n${appModule}: only one half of the App is configured.\n\n` +
			`  brokerOrigin: ${brokerOrigin === '' ? '(empty)' : brokerOrigin}\n` +
			`  clientId:     ${clientId === '' ? '(empty)' : clientId}\n\n` +
			'Set both, or neither. Both empty turns the GitHub sign-in off and leaves the pasted token\n' +
			"as this deployment's whole auth, which is a supported state (ADR-0031, docs/hosting.md).\n"
	);
	process.exit(1);
}

if (!configured) {
	// ⚠ **Visibly different from the "scanned and found nothing" line below**, and deliberately so.
	// This branch scans nothing, because there is nothing to scan for — and a fence that printed its
	// ordinary success line here would be reporting a clean tree it never looked at. The positive
	// control above has already run, so the matcher is known to work either way.
	console.log(
		`${appModule}: NO GITHUB APP CONFIGURED — nothing scanned for (ADR-0031).\n` +
			'  The GitHub sign-in is off and a pasted personal access token is this deployment’s whole\n' +
			'  auth. That is supported. Set `brokerOrigin` and `clientId` to turn the front door on.'
	);
	process.exit(0);
}

if (brokerHost === '') {
	console.error(
		`\n${appModule}: \`brokerOrigin\` is set to “${brokerOrigin}”, which is not a URL this check\n` +
			'can read a host out of — so it would scan for the empty string and report every file as\n' +
			'clean. Spell it as an origin, like `https://broker.example.org`.\n'
	);
	process.exit(1);
}

// ── The containment scan ──────────────────────────────────────────────────────────────────────

const namesConfigured = namesAny([brokerHost, clientId]);

const files = scannedRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];

for (const absolute of files) {
	const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
	if (isExempt(relative)) continue;

	readFileSync(absolute, 'utf8')
		.split('\n')
		.forEach((line, index) => {
			if (namesConfigured(line)) {
				violations.push({ file: relative, line: index + 1, text: line.trim() });
			}
		});
}

if (violations.length > 0) {
	console.error(`\nThe broker or the client ID is named outside ${appModule} (ADR-0031).\n`);
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}`);
		console.error(`    ${violation.text}`);
	}
	console.error(
		'\nBoth are deployment configuration: a fork must be able to repoint them and change nothing\n' +
			'else, because a GitHub App’s callback URL is registered per app. Take them from\n' +
			'`GITHUB_APP` rather than naming them — including in a comment, which a repoint leaves\n' +
			'saying something untrue.\n'
	);
	process.exit(1);
}

console.log(`${appModule}: ${brokerHost} and the client ID named nowhere else (ADR-0031).`);

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
