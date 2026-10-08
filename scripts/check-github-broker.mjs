#!/usr/bin/env node

import process from 'node:process';

import {
	assertControls,
	failWith,
	hostOf,
	importOwner,
	matchControls,
	ownersAndTests,
	scanLines
} from './fence.mjs';

const appModule = 'packages/core/src/remote/github-app.ts';
const isExempt = ownersAndTests(appModule, 'scripts/check-github-broker.mjs');

const { GITHUB_APP, isGitHubAppConfigured } = await importOwner(appModule);

if (typeof GITHUB_APP !== 'object' || GITHUB_APP === null) {
	console.error(`\n${appModule}: exports no \`GITHUB_APP\`, so this check cannot do its job.\n`);
	process.exit(1);
}

const appAddress = (slug) => `github.com/apps/${slug}`;

const namesAny = (values) => (line) => {
	const lowered = line.toLowerCase();
	return values.some((value) => lowered.includes(value.toLowerCase()));
};

const SPECIMEN = {
	host: 'broker.specimen.invalid',
	clientId: 'Iv1.specimenclientid',
	appSlug: 'specimen-app'
};

const specimenMatches = namesAny([SPECIMEN.host, SPECIMEN.clientId, appAddress(SPECIMEN.appSlug)]);

const KNOWN_BAD = [
	{ line: `const BROKER = 'https://${SPECIMEN.host}';`, expect: 'the broker host in a literal' },
	{ line: `// the exchange goes to ${SPECIMEN.host}`, expect: 'the broker host in a comment' },
	{
		line: `fetch(\`https://${SPECIMEN.host}/github/token\`)`,
		expect: 'the broker host inside a template'
	},
	{ line: `const BROKER = 'HTTPS://${SPECIMEN.host.toUpperCase()}';`, expect: 'the host shouted' },
	{ line: `client_id: '${SPECIMEN.clientId}'`, expect: 'the client ID in a literal' },
	{ line: `// registered as ${SPECIMEN.clientId}`, expect: 'the client ID in a comment' },
	{
		line: `const INSTALL = 'https://github.com/apps/${SPECIMEN.appSlug}/installations/new';`,
		expect: "the App's install address in a literal"
	},
	{
		line: `// the install screen is github.com/apps/${SPECIMEN.appSlug}`,
		expect: "the App's address in a comment"
	},
	{
		line: `await page.route('https://GITHUB.COM/APPS/${SPECIMEN.appSlug.toUpperCase()}/**', noop);`,
		expect: "the App's address shouted"
	}
];

const KNOWN_GOOD = [
	'// The broker exchanges a code for a token, and never sees repository data.',
	"// A GitHub App's callback URL is registered per app, so a fork needs its own app.",
	"export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';",
	"export const GITHUB_APPS_URL = 'https://github.com/apps';",
	'const response = await post(`${app.brokerOrigin}/github/token`, body, fetchFn);',
	'return `${GITHUB_APPS_URL}/${slug}/installations/new?${parameters}`;',
	'routeGitHubHosts(page, { app: GITHUB_APP });',
	`import { createFakeGitHub } from '@${SPECIMEN.appSlug}/core';`
];

assertControls(
	matchControls(specimenMatches, KNOWN_BAD, KNOWN_GOOD),
	'The scan is on the **two values** — the broker host and the client ID. Explaining the\n' +
		'broker in prose is documentation; naming its address or the client ID outside the\n' +
		'configuration module is a dependency.',
	'ADR-0031'
);

const clientId = String(GITHUB_APP.clientId ?? '').trim();
const brokerOrigin = String(GITHUB_APP.brokerOrigin ?? '').trim();
const appSlug = String(GITHUB_APP.appSlug ?? '').trim();
const brokerHost = hostOf(brokerOrigin);

const configured =
	typeof isGitHubAppConfigured === 'function'
		? isGitHubAppConfigured(GITHUB_APP)
		: brokerOrigin !== '' && clientId !== '' && appSlug !== '';

if (!configured && (brokerOrigin !== '' || clientId !== '' || appSlug !== '')) {
	console.error(
		`\n${appModule}: only part of the App is configured.\n\n` +
			`  brokerOrigin: ${brokerOrigin === '' ? '(empty)' : brokerOrigin}\n` +
			`  clientId:     ${clientId === '' ? '(empty)' : clientId}\n` +
			`  appSlug:      ${appSlug === '' ? '(empty)' : appSlug}\n\n` +
			'Set all three, or none. All empty turns the GitHub sign-in off and leaves the pasted token\n' +
			"as this deployment's whole auth, which is a supported state (ADR-0031, docs/hosting.md).\n"
	);
	process.exit(1);
}

if (!configured) {
	console.log(
		`${appModule}: NO GITHUB APP CONFIGURED — nothing scanned for (ADR-0031).\n` +
			'  The GitHub sign-in is off and a pasted personal access token is this deployment’s whole\n' +
			'  auth. That is supported. Set `brokerOrigin`, `clientId` and `appSlug` to turn the front\n' +
			'  door on.'
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

const namesConfigured = namesAny([brokerHost, clientId, appAddress(appSlug)]);

failWith(
	`The broker, the client ID or the App's own address is named outside ${appModule}\n(ADR-0031).`,
	scanLines(isExempt, namesConfigured),
	'All three are deployment configuration: a fork must be able to repoint them and change\n' +
		'nothing else, because a GitHub App’s callback URL is registered per app. Take them from\n' +
		'`GITHUB_APP` rather than naming them — including in a comment, which a repoint leaves\n' +
		'saying something untrue.'
);

console.log(
	`${appModule}: ${brokerHost}, the client ID and ${appAddress(appSlug)} named nowhere ` +
		'else (ADR-0031).'
);
