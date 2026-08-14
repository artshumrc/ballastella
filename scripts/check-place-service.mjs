#!/usr/bin/env node
// ADR-0029: the place lookup service is deployment configuration, and repointing it must require no
// change anywhere else. `packages/core/src/places/service.ts` says "change this file, and nothing
// else"; until this script existed, nobody asserted it.
//
// Same shape as `check-base-map-catalog.mjs`, for the same reason: the violation it catches is a
// deliberate act that shows up in a diff, so the check does not need to be clever. And like that
// one, `--deployment` is a **mode** of this check rather than a second check — the containment scan
// below runs in both modes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE SCAN IS ON THE ADDRESS, NOT ON WHO MAY IMPORT THE MODULE
//
// An import fence was considered and declined in ADR-0029: two surfaces import the lookup
// legitimately, and an autocomplete implementation would import it just as legally. So the property
// checked here is the one a fork actually depends on — that no module outside the configuration
// module names the host the requests go to.
//
// **The host, and not the service's name.** `lookup.ts` quotes the default service's autocomplete
// policy and describes the shape of its response, naming the service in prose several times over. A
// scan for the brand would fail `pnpm lint` on documentation, and the remedy on offer would be
// "delete the paragraph explaining the rule" — the same false positive `check-base-map-catalog.mjs`
// records having had against `REMOTE_ARCHIVE`'s comment. The positive control below pins both
// directions: the host is caught, and the service named without its host is not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE HOST IS READ AS A VALUE
//
// The module is imported and asked to build a search URL, rather than grepped for a constant. A
// fork's `searchUrl` may compose its address however it likes — one constant, three, or the URL
// written inline — and the question this check asks is what address the application will actually
// request. Node runs the TypeScript directly (type-stripping, Node 22.18+); the module's only import
// is a type import, so there is nothing to resolve.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(here), '..');
const serviceModule = 'packages/core/src/places/service.ts';

/** Source trees the service address could leak into. Static assets and prose are not code. */
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
 * A fence has to be able to name what it refuses: `BORROWED_SERVICES` below lists the default
 * service by host, for the same reason `check-base-map-catalog.mjs` lists the archives no
 * deployment may ship.
 *
 * **The browser suite is not exempt**, unlike the Base Map's fence. `check-e2e-network-fence.mjs`
 * exists because `e2e/` is where a host most plausibly leaks — a `page.route` interception naming
 * the service it intercepts — and unlike a Base Map entry id, which the switcher's specs can only
 * assert by naming, nothing about this feature requires a spec to write the address down: a test
 * routes a glob on the search path, or takes the URL from `PLACE_SERVICE`. Unit and component
 * specs stay exempt only because they sit beside the module and can be handed it directly.
 */
const exemptFiles = new Set([
	serviceModule,
	path.relative(repoRoot, here).split(path.sep).join('/')
]);
const isExempt = (relative) =>
	exemptFiles.has(relative) ||
	relative.endsWith('.test.ts') ||
	relative.endsWith('.spec.ts') ||
	// The script suite is a seam of its own, and a test of this check has to name what it plants.
	relative.endsWith('.test.mjs');

const deploymentCheck = process.argv.includes('--deployment');

/**
 * Services no deployment provisioned: somebody else's, whoever else's.
 *
 * ⚠ **A host is listed here because of who runs it, not because it is unsuitable.**
 * `nominatim.openstreetmap.org` is OpenStreetMap's own geocoder, and its usage policy *permits*
 * this application's use — human-paced, attributed, no autocomplete. It is still hardware donated
 * to serve the whole world, with no promise to this deployment, so it belongs here until somebody
 * points the service at one they run. The rule this set encodes is *the deployment controls its own
 * lookup*, and a host belongs here whenever it does not — which is every host until somebody
 * provisions one.
 *
 * ⚠ **This set is maintained by hand, and the case it misses is a repoint to somebody else's other
 * service.** A fork pointing at a shared Photon, a Pelias, or another Nominatim mirror is still
 * borrowing, and this check goes silent — `check:deployment` then reports "none blocking" about a
 * lookup nobody provisioned. That is exactly the shape `UNCONTROLLED_HOSTS` in
 * `check-base-map-catalog.mjs` records having had on 2026-08-10, when the catalog moved to a host
 * the set did not name and the fence went green (ADR-0025). It is milder here only because a match
 * warns rather than fails. **Add the host when you repoint at one you do not run**; nothing
 * mechanical will notice that you did not.
 *
 * Unlike `UNCONTROLLED_HOSTS` in `check-base-map-catalog.mjs`, a match here **warns and stays
 * green** (ADR-0029). Repointing an archive is putting a file in a bucket; repointing this means
 * running a planet-scale geocoder — days of compute, hundreds of gigabytes, permanent diff
 * replication — and a check that fails with a remedy nobody can take is a check people learn to
 * route around, which would corrode the Base Map check standing beside it. **Do not tighten this
 * into a failure without revisiting that argument.**
 */
const BORROWED_SERVICES = new Set(['nominatim.openstreetmap.org']);

/**
 * The token a deploy watches for, printed by `--deployment` only when the configured service is one
 * this deployment does not run.
 *
 * A stable token rather than a sentence, so that rewording the warning below cannot silently stop a
 * deploy annotating — and so that a workflow is matching something this script promises rather than
 * prose it happens to have. `.github/workflows/pages.yml` is its only consumer.
 */
const BORROWED_LOOKUP_MARKER = '::borrowed-lookup-service::';

/**
 * The configuration module, or one sentence saying why not.
 *
 * A fork mid-repoint is precisely when this module does not parse, and an unhandled rejection in
 * the middle of `pnpm lint` names Node's internals rather than the file to look at.
 */
let PLACE_SERVICE;
try {
	({ PLACE_SERVICE } = await import(pathToFileURL(path.join(repoRoot, serviceModule)).href));
} catch (error) {
	console.error(
		`\n${serviceModule}: this module could not be loaded, so this check cannot do\nits job.\n\n` +
			`  ${error instanceof Error ? error.message : String(error)}\n`
	);
	process.exit(1);
}

/** The address a lookup actually requests, reduced to its host. */
function configuredHost() {
	try {
		return new URL(PLACE_SERVICE.searchUrl('a place')).host;
	} catch {
		return '';
	}
}

const host = configuredHost();
if (host === '') {
	console.error(
		`\n${serviceModule}: no service host could be read out of \`searchUrl\`. This check cannot do\n` +
			'its job — it would scan for the empty string and report every file as clean.\n'
	);
	process.exit(1);
}

// ── Positive control ──────────────────────────────────────────────────────────────────────────
//
// A substring fence's way of dying is silent, and this one has a specific way to die badly: widened
// to the service's name, it fails on `lookup.ts`'s policy quotation; narrowed to a quoted literal,
// it misses a host pasted into a comment, which is a claim that goes stale on the very repoint this
// exists to make safe.

/** The service named the way prose names it — the first label of its host, capitalised. */
const brand = host.split('.')[0].replace(/^./, (letter) => letter.toUpperCase());

const KNOWN_BAD = [
	{ line: `const SERVICE = 'https://${host}';`, expect: 'the host in a string literal' },
	{ line: `// requests go to ${host} unless overridden`, expect: 'the host in a comment' },
	{ line: `fetch(\`https://${host}/search?q=\${query}\`)`, expect: 'the host inside a template' },
	{ line: `const SERVICE = 'HTTPS://${host.toUpperCase()}';`, expect: 'the host shouted' }
];

/**
 * Prose only, and deliberately.
 *
 * ⚠ **Never build a control line out of live configuration.** An earlier version put
 * `PLACE_SERVICE.attribution.href` here, which is fine on this deployment by luck —
 * `openstreetmap.org/copyright` is not `nominatim.openstreetmap.org` — and hard-fails `pnpm lint`
 * on the most ordinary fork there is: one running its own geocoder and crediting that same
 * instance. The message on offer would have accused this check of being broken, and the remedy
 * would have been "change your attribution URL". Attribution lines live in the configuration
 * module, which is exempt from the scan, so they were guarding a line that cannot occur.
 */
const KNOWN_GOOD = [
	`// ${brand}'s policy prohibits client-side autocomplete outright.`,
	`// \`[south, north, west, east]\`, which is the order ${brand} writes a bounding box in.`
];

const namesHost = (line) => line.toLowerCase().includes(host.toLowerCase());

const controlFailures = [];
for (const { line, expect } of KNOWN_BAD) {
	if (!namesHost(line)) controlFailures.push(`${expect} is no longer caught`);
}
for (const line of KNOWN_GOOD) {
	if (namesHost(line)) controlFailures.push(`a legitimate line is now refused: ${line}`);
}
if (controlFailures.length > 0) {
	console.error('\nThis check can no longer detect what it exists to detect (ADR-0029).\n');
	for (const failure of controlFailures) console.error(`  ${failure}`);
	console.error(
		'\nThe scan is on the service **host**: naming the service in prose is documentation, and\n' +
			'naming its address anywhere outside the configuration module is a dependency.\n'
	);
	process.exit(1);
}

// ── The checks ────────────────────────────────────────────────────────────────────────────────

/**
 * Failures are collected rather than exited on, because `--deployment` is a *mode* of this check and
 * not a different check. Exiting early is how `pnpm check:deployment` came to skip the Base Map's
 * containment scan entirely, and that history is recorded on `let failed` in that script.
 */
let failed = false;

if (deploymentCheck && BORROWED_SERVICES.has(host)) {
	// On **stdout**, exiting zero: the neighbouring checks put failures on stderr and verdicts on
	// stdout, and this is a verdict. See `BORROWED_SERVICES` above for why it is not a failure.
	//
	// ⚠ **`BORROWED_LOOKUP_MARKER` is the line a deploy keys its annotation off**, and it is here
	// rather than in the workflow because only this script knows the answer. The warning cannot be
	// hung off an exit code — this half exits zero by design — and a workflow that simply always
	// annotated would tell a fork running its own geocoder that it had borrowed one. A warning that
	// is present whatever the truth is stops being read, which is the corrosion ADR-0029 declines to
	// risk on the check standing beside this one.
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

const files = scannedRoots.flatMap((root) => walk(path.join(repoRoot, root)));
const violations = [];

for (const absolute of files) {
	const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
	if (isExempt(relative)) continue;

	const lines = readFileSync(absolute, 'utf8').split('\n');
	lines.forEach((line, index) => {
		if (namesHost(line)) violations.push({ file: relative, line: index + 1, text: line.trim() });
	});
}

if (violations.length > 0) {
	console.error(`\nThe place lookup service is named outside ${serviceModule} (ADR-0029).\n`);
	for (const violation of violations) {
		console.error(`  ${violation.file}:${violation.line}  “${host}”`);
		console.error(`    ${violation.text}`);
	}
	console.error(
		'\nThe service is deployment configuration: a fork must be able to repoint it and change\n' +
			'nothing else, and its attribution has to travel with it. Take the address from\n' +
			'`PLACE_SERVICE` rather than naming the host — including in a comment, which a repoint\n' +
			'leaves saying something untrue.\n'
	);
	failed = true;
}

if (failed) process.exit(1);

console.log(`${serviceModule}: ${host} named nowhere else (ADR-0029, SPEC story 26).`);

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
