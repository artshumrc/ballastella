import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { escaped, repoRoot, runScript, withTree } from './test-support.mjs';

const APP_RELATIVE = 'packages/core/src/remote/github-app.ts';
const SCRIPT = 'check-github-broker.mjs';
const HOST = 'broker.under-test.invalid';
const CLIENT_ID = 'Iv1.undertestclientid';
const APP_SLUG = 'under-test-app';

const appModule = (brokerOrigin, clientId, appSlug) => `export const GITHUB_APP = {
	brokerOrigin: '${brokerOrigin}',
	clientId: '${clientId}',
	appSlug: '${appSlug}'
};

export const isGitHubAppConfigured = (app) =>
	app.brokerOrigin.trim() !== '' && app.clientId.trim() !== '' && app.appSlug.trim() !== '';
`;

const runIn = (options = {}) =>
	withTree(
		{
			[APP_RELATIVE]: options.app ?? appModule(`https://${HOST}`, CLIENT_ID, APP_SLUG),
			...(options.extraFiles ?? {})
		},
		(root) => runScript(path.join(root, 'scripts', SCRIPT), [], root),
		[SCRIPT, 'fence.mjs']
	);

for (const { name, file, line } of [
	{
		name: 'fails when a module outside the configuration names the broker host',
		file: 'apps/editor/src/lib/sign-in.ts',
		line: `const BROKER = 'https://${HOST}';\n`
	},
	{
		name: 'fails when a module outside the configuration names the client ID',
		file: 'apps/editor/src/lib/sign-in.ts',
		line: `const ID = '${CLIENT_ID}';\n`
	},
	{
		name: 'fails when a module outside the configuration names the App’s own address',
		file: 'apps/editor/src/lib/sign-in.ts',
		line: `const INSTALL = 'https://github.com/apps/${APP_SLUG}/installations/new';\n`
	},
	{
		name: 'catches the broker host pasted into a comment',
		file: 'e2e/support/github-hosts.ts',
		line: `// the exchange goes to ${HOST}\n`
	},
	{
		name: 'catches the client ID pasted into a comment',
		file: 'e2e/support/github-hosts.ts',
		line: `// registered as ${CLIENT_ID}\n`
	},
	{
		name: 'catches the App’s address pasted into a comment',
		file: 'e2e/support/github-hosts.ts',
		line: `// the install screen is github.com/apps/${APP_SLUG}\n`
	},
	{
		name: 'scans the browser suite, which is where an address most plausibly leaks',
		file: 'e2e/editor-github-signin.e2e.ts',
		line: `page.route('https://${HOST}/**', noop);\n`
	}
]) {
	test(name, () => {
		const run = runIn({ extraFiles: { [file]: line } });
		assert.notEqual(run.status, 0, `a planted value was not caught:\n${run.output}`);
		assert.match(run.output, new RegExp(escaped(file)));
	});
}

for (const { name, file, contents } of [
	{
		name: 'passes on a tree that names none of the three anywhere else',
		file: 'packages/core/src/remote/github-sign-in.ts',
		contents: 'export const signIn = () => {};\n'
	},
	{
		name: 'does not fire on the slug as a bare word, which is this project’s own name',
		file: 'apps/editor/src/lib/sign-in.ts',
		contents:
			`import { sendToRemote } from '@${APP_SLUG}/core';\n` +
			`const KEY = '${APP_SLUG}.github-credential';\n`
	},
	{
		name: 'does not fire on prose explaining the broker, nor on GitHub’s own authorize address',
		file: 'packages/core/src/remote/github-sign-in.ts',
		contents:
			'// The broker exchanges a code for a token, and never sees repository data.\n' +
			"// A GitHub App's callback URL is registered per app, so a fork needs its own app and\n" +
			'// its own client ID until which the pasted token is the whole of that fork’s auth.\n' +
			"export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';\n" +
			"export const GITHUB_APPS_URL = 'https://github.com/apps';\n" +
			'const url = `${app.brokerOrigin}/github/token`;\n' +
			'const install = `${GITHUB_APPS_URL}/${app.appSlug}/installations/new`;\n'
	},
	{
		name: 'exempts unit specs, which are handed a fake App directly',
		file: 'packages/core/src/remote/github-sign-in.test.ts',
		contents: `const APP = { brokerOrigin: 'https://${HOST}', clientId: '${CLIENT_ID}', appSlug: '${APP_SLUG}' };\n`
	}
]) {
	test(name, () => {
		const run = runIn({ extraFiles: { [file]: contents } });
		assert.equal(run.status, 0, run.output);
	});
}

test('reports “no App configured” in its own words, and scans for nothing rather than the empty string', () => {
	const unconfigured = runIn({
		app: appModule('', '', ''),
		extraFiles: { 'apps/editor/src/lib/sign-in.ts': `const BROKER = 'https://${HOST}';\n` }
	});
	const ordinary = runIn();

	assert.equal(unconfigured.status, 0, `an unconfigured fork was refused:\n${unconfigured.output}`);
	assert.match(unconfigured.output, /NO GITHUB APP CONFIGURED/);
	assert.doesNotMatch(unconfigured.output, /sign-in\.ts/);
	assert.notEqual(
		unconfigured.output.trim(),
		ordinary.output.trim(),
		'the unconfigured verdict is indistinguishable from a clean scan'
	);
	assert.doesNotMatch(ordinary.output, /NO GITHUB APP CONFIGURED/);
});

test('refuses a part-configured App, which is a button that cannot complete', () => {
	for (const app of [
		appModule('', CLIENT_ID, APP_SLUG),
		appModule(`https://${HOST}`, '', APP_SLUG),
		appModule(`https://${HOST}`, CLIENT_ID, '')
	]) {
		const run = runIn({ app });
		assert.notEqual(run.status, 0, `a part-configured App was accepted:\n${run.output}`);
		assert.match(run.output, /Set all three, or none/);
	}
});

for (const { name, app, expect } of [
	{
		name: 'refuses to run when no host can be read out of `brokerOrigin`',
		app: appModule('not-a-url', CLIENT_ID, APP_SLUG),
		expect: [/not a URL this check\n?can read a host out of/]
	},
	{
		name: 'says so when the configuration module cannot be loaded',
		app: 'export const GITHUB_APP = {\n',
		expect: [/github-app\.ts/, /cannot do\n?its job/]
	},
	{
		name: 'says so when the module exports no `GITHUB_APP` at all',
		app: 'export const SOMETHING_ELSE = {};\n',
		expect: [/exports no/]
	}
]) {
	test(name, () => {
		const run = runIn({ app });
		assert.notEqual(run.status, 0, `a broken configuration was accepted:\n${run.output}`);
		for (const pattern of expect) assert.match(run.output, pattern);
		assert.doesNotMatch(
			run.output,
			/node:internal/,
			`a stack trace reached a forker mid-repoint instead of a sentence:\n${run.output}`
		);
	});
}

test('runs in `pnpm lint`, or it protects nothing', () => {
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
	assert.match(
		manifest.scripts.lint,
		new RegExp(escaped(SCRIPT)),
		'`pnpm lint` no longer runs the GitHub App fence.'
	);
});

test('agrees with this repository’s own tree', () => {
	const { status, output } = runScript(path.join(repoRoot, 'scripts', SCRIPT));
	assert.equal(status, 0, `the GitHub App fence fails on this repository’s tree:\n${output}`);
	console.log(output.trim());
});
