// The GitHub App fence (ADR-0031): the containment scan, its positive control, and the
// two states a fork can put the configuration module into.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE UNCONFIGURED CASE IS THE ONE THIS FILE EXISTS FOR.                                     │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// A fork with no infrastructure empties all three values, and a fence with nothing to scan for
// prints a success line indistinguishable from a fence that scanned a clean tree. So the
// unconfigured case is
// asserted **in both directions**: the report says so in its own words, and a planted violation in
// that same tree is *not* reported — which is what proves the ordinary success line means something.
//
// The synthetic-repository idiom is `check-place-service.test.mjs`'s: the script derives its root
// from its own location, so a temp directory holding a copy of it and a configuration module is a
// complete deployment as far as it is concerned. This repository's own tree cannot exercise the
// unconfigured verdict, because it ships configured.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_RELATIVE = 'packages/core/src/remote/github-app.ts';
const SCRIPT = 'check-github-broker.mjs';

/** A set no deployment will ever hold. `.invalid` is reserved by RFC 2606 and resolves nowhere. */
const HOST = 'broker.under-test.invalid';
const CLIENT_ID = 'Iv1.undertestclientid';
const APP_SLUG = 'under-test-app';

/**
 * A configuration module holding all three values. Plain JS is valid TypeScript.
 *
 * `isGitHubAppConfigured` is exported too, because the check prefers the module's own answer to
 * re-deriving one — a fork is free to make "configured" mean something narrower.
 */
const appModule = (brokerOrigin, clientId, appSlug) => `export const GITHUB_APP = {
	brokerOrigin: '${brokerOrigin}',
	clientId: '${clientId}',
	appSlug: '${appSlug}'
};

export const isGitHubAppConfigured = (app) =>
	app.brokerOrigin.trim() !== '' && app.clientId.trim() !== '' && app.appSlug.trim() !== '';
`;

const configured = () => appModule(`https://${HOST}`, CLIENT_ID, APP_SLUG);

/**
 * Run the check inside a throwaway repository.
 *
 * @param {{ app?: string, extraFiles?: Record<string, string> }} options
 */
function runIn(options = {}) {
	const root = mkdtempSync(path.join(tmpdir(), 'ballastella-broker-'));
	try {
		mkdirSync(path.join(root, 'scripts'), { recursive: true });
		cpSync(path.join(repoRoot, 'scripts', SCRIPT), path.join(root, 'scripts', SCRIPT));
		for (const [relative, contents] of Object.entries({
			[APP_RELATIVE]: options.app ?? configured(),
			...(options.extraFiles ?? {})
		})) {
			const file = path.join(root, relative);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, contents);
		}
		const run = spawnSync(process.execPath, [path.join(root, 'scripts', SCRIPT)], {
			cwd: root,
			encoding: 'utf8'
		});
		return { status: run.status, output: `${run.stdout}${run.stderr}` };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ── The containment scan ──────────────────────────────────────────────────────────────────────

test('passes on a tree that names none of the three anywhere else', () => {
	const run = runIn({
		extraFiles: {
			'packages/core/src/remote/github-sign-in.ts': 'export const signIn = () => {};\n'
		}
	});
	assert.equal(run.status, 0, run.output);
});

test('fails when a module outside the configuration names the broker host', () => {
	const run = runIn({
		extraFiles: { 'apps/editor/src/lib/sign-in.ts': `const BROKER = 'https://${HOST}';\n` }
	});
	assert.notEqual(run.status, 0, `a planted broker host was not caught:\n${run.output}`);
	assert.match(run.output, /apps\/editor\/src\/lib\/sign-in\.ts/);
});

test('fails when a module outside the configuration names the client ID', () => {
	const run = runIn({
		extraFiles: { 'apps/editor/src/lib/sign-in.ts': `const ID = '${CLIENT_ID}';\n` }
	});
	assert.notEqual(run.status, 0, `a planted client ID was not caught:\n${run.output}`);
	assert.match(run.output, /apps\/editor\/src\/lib\/sign-in\.ts/);
});

test('fails when a module outside the configuration names the App’s own address', () => {
	const run = runIn({
		extraFiles: {
			'apps/editor/src/lib/sign-in.ts': `const INSTALL = 'https://github.com/apps/${APP_SLUG}/installations/new';\n`
		}
	});
	assert.notEqual(run.status, 0, `a planted install address was not caught:\n${run.output}`);
	assert.match(run.output, /apps\/editor\/src\/lib\/sign-in\.ts/);
});

// ⚠ **The slug alone is not the value; the address is.** This deployment's App is named after this
// deployment, so a fence on the bare word would refuse every import of this repository's own
// packages and offer "rename the packages" as its remedy — the false positive the two neighbouring
// checks both record having had.
test('does not fire on the slug as a bare word, which is this project’s own name', () => {
	const run = runIn({
		extraFiles: {
			'apps/editor/src/lib/sign-in.ts':
				`import { publishToRemote } from '@${APP_SLUG}/core';\n` +
				`const KEY = '${APP_SLUG}.github-credential';\n`
		}
	});
	assert.equal(run.status, 0, `a package import named after the App was refused:\n${run.output}`);
});

test('catches any of the three pasted into a comment', () => {
	// A comment naming the address is a claim the very next repoint makes untrue.
	const host = runIn({
		extraFiles: { 'e2e/support/github-hosts.ts': `// the exchange goes to ${HOST}\n` }
	});
	assert.notEqual(host.status, 0, `a host in a comment was not caught:\n${host.output}`);

	const id = runIn({
		extraFiles: { 'e2e/support/github-hosts.ts': `// registered as ${CLIENT_ID}\n` }
	});
	assert.notEqual(id.status, 0, `a client ID in a comment was not caught:\n${id.output}`);

	const slug = runIn({
		extraFiles: {
			'e2e/support/github-hosts.ts': `// the install screen is github.com/apps/${APP_SLUG}\n`
		}
	});
	assert.notEqual(slug.status, 0, `an App address in a comment was not caught:\n${slug.output}`);
});

test('scans the browser suite, which is where an address most plausibly leaks', () => {
	const run = runIn({
		extraFiles: { 'e2e/editor-github-signin.e2e.ts': `page.route('https://${HOST}/**', noop);\n` }
	});
	assert.notEqual(run.status, 0, `a host in a spec was not caught:\n${run.output}`);
});

test('does not fire on prose explaining the broker, nor on GitHub’s own authorize address', () => {
	// The mechanism is explained at length in three places, and a fence that failed on those would
	// offer "delete the explanation" as its remedy — the false positive the neighbouring two checks
	// both record having had.
	const run = runIn({
		extraFiles: {
			'packages/core/src/remote/github-sign-in.ts':
				'// The broker exchanges a code for a token, and never sees repository data.\n' +
				"// A GitHub App's callback URL is registered per app, so a fork needs its own app and\n" +
				'// its own client ID until which the pasted token is the whole of that fork’s auth.\n' +
				"export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';\n" +
				"export const GITHUB_APPS_URL = 'https://github.com/apps';\n" +
				'const url = `${app.brokerOrigin}/github/token`;\n' +
				'const install = `${GITHUB_APPS_URL}/${app.appSlug}/installations/new`;\n'
		}
	});
	assert.equal(run.status, 0, `prose explaining the broker was refused:\n${run.output}`);
});

test('exempts unit specs, which are handed a fake App directly', () => {
	const run = runIn({
		extraFiles: {
			'packages/core/src/remote/github-sign-in.test.ts': `const APP = { brokerOrigin: 'https://${HOST}', clientId: '${CLIENT_ID}', appSlug: '${APP_SLUG}' };\n`
		}
	});
	assert.equal(run.status, 0, `a unit spec's own fake App was refused:\n${run.output}`);
});

// ── The unconfigured fork ─────────────────────────────────────────────────────────────────────

test('reports “no App configured” in its own words, distinct from an ordinary pass', () => {
	const unconfigured = runIn({ app: appModule('', '', '') });
	const ordinary = runIn();

	assert.equal(unconfigured.status, 0, `an unconfigured fork was refused:\n${unconfigured.output}`);
	assert.match(unconfigured.output, /NO GITHUB APP CONFIGURED/);
	// ⚠ The two verdicts must not read the same. A fence with nothing to scan for and a fence that
	// scanned a clean tree print the same success line unless something makes them differ, and that
	// is the whole failure mode this file exists to close.
	assert.notEqual(
		unconfigured.output.trim(),
		ordinary.output.trim(),
		'the unconfigured verdict is indistinguishable from a clean scan'
	);
	assert.doesNotMatch(ordinary.output, /NO GITHUB APP CONFIGURED/);
});

test('scans nothing when nothing is configured, rather than scanning for the empty string', () => {
	// The other direction of the case above, and the one that would actually bite: a check that
	// scanned for `''` would report every file in the tree as a violation.
	const run = runIn({
		app: appModule('', '', ''),
		extraFiles: { 'apps/editor/src/lib/sign-in.ts': `const BROKER = 'https://${HOST}';\n` }
	});
	assert.equal(run.status, 0, `an unconfigured tree was refused:\n${run.output}`);
	assert.doesNotMatch(run.output, /sign-in\.ts/);
});

test('refuses a part-configured App, which is a button that cannot complete', () => {
	const parts = [
		appModule('', CLIENT_ID, APP_SLUG),
		appModule(`https://${HOST}`, '', APP_SLUG),
		appModule(`https://${HOST}`, CLIENT_ID, '')
	];
	for (const app of parts) {
		const run = runIn({ app });
		assert.notEqual(run.status, 0, `a part-configured App was accepted:\n${run.output}`);
		assert.match(run.output, /Set all three, or none/);
	}
});

// ── The check's own self-protection ───────────────────────────────────────────────────────────

test('refuses to run when no host can be read out of `brokerOrigin`', () => {
	// A `brokerOrigin` that yields no host would have it scan for the empty string and report every
	// file as clean — a fence that passes because it stopped asking, which is worse than no fence.
	const run = runIn({ app: appModule('not-a-url', CLIENT_ID, APP_SLUG) });
	assert.notEqual(run.status, 0, `an unreadable broker origin was accepted:\n${run.output}`);
	assert.match(run.output, /not a URL this check\n?can read a host out of/);
});

test('says so when the configuration module cannot be loaded', () => {
	const run = runIn({ app: 'export const GITHUB_APP = {\n' });
	assert.notEqual(run.status, 0, `a broken configuration module was accepted:\n${run.output}`);
	assert.match(run.output, /github-app\.ts/);
	assert.match(run.output, /cannot do\n?its job/);
	assert.doesNotMatch(
		run.output,
		/node:internal/,
		`a stack trace reached a forker mid-repoint instead of a sentence:\n${run.output}`
	);
});

test('says so when the module exports no `GITHUB_APP` at all', () => {
	const run = runIn({ app: 'export const SOMETHING_ELSE = {};\n' });
	assert.notEqual(run.status, 0, `a module with no App was accepted:\n${run.output}`);
	assert.match(run.output, /exports no/);
});

// ── The gate ──────────────────────────────────────────────────────────────────────────────────

test('runs in `pnpm lint`, or it protects nothing', () => {
	// The check and the gate live in different files and nothing else ties them together. This is the
	// discipline `check-deployment-runs.test.mjs` exists for: a check nobody runs has rotted.
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	assert.match(
		manifest.scripts.lint,
		new RegExp(SCRIPT.replaceAll('.', '\\.')),
		'`pnpm lint` no longer runs the GitHub App fence.'
	);
});

test('agrees with this repository’s own tree', () => {
	// Against the tree that ships, in the ordinary loop — so a violation committed here is caught by
	// this file as well as by `pnpm lint`.
	const run = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', SCRIPT)], {
		cwd: repoRoot,
		encoding: 'utf8'
	});
	const output = `${run.stdout}${run.stderr}`;
	assert.equal(run.status, 0, `the GitHub App fence fails on this repository’s tree:\n${output}`);
	console.log(output.trim());
});
