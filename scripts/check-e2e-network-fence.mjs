#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { assertControls, matchControls, repoRoot, sourceFiles } from './fence.mjs';

const ROOT_MODULE = 'support/test';
const FENCE_MODULE = 'support/network-fence';
const ROOT_FILE = 'e2e/support/test.ts';
const PLAYWRIGHT_IMPORT = /import\s+(?!type\b)([^;]*?)\s+from\s+['"]@playwright\/test['"]/gs;

function bindsTest(clause) {
	const braces = /\{([^}]*)\}/.exec(clause);
	if (!braces) return /^\s*test\s*$/.test(clause);
	return braces[1]
		.split(',')
		.map((specifier) => specifier.trim())
		.filter(Boolean)
		.some((specifier) => {
			if (/^type\s/.test(specifier)) return false;
			const [imported] = specifier.split(/\s+as\s+/);
			return imported.trim() === 'test';
		});
}

const FENCE_IMPORT =
	/import\s+(?!type\b)([^;]*?)\s+from\s+['"]\.[^'"]*network-fence(?:\.js)?['"]/gs;

const importsTest = (source, pattern) =>
	[...source.matchAll(pattern)].some((match) => bindsTest(match[1]));

function violationIn(source) {
	if (importsTest(source, PLAYWRIGHT_IMPORT)) {
		return "imports `test` from '@playwright/test', which is behind neither fixture";
	}
	if (importsTest(source, FENCE_IMPORT)) {
		return (
			"imports `test` from './support/network-fence', which is the fence layer and not the " +
			'composed root — it carries no `workspaceRoot()`'
		);
	}
	if (!source.includes(ROOT_MODULE)) {
		return `does not import \`test\` from './${ROOT_MODULE}'`;
	}
	return null;
}

function rootCompositionFault(source) {
	if (importsTest(source, PLAYWRIGHT_IMPORT)) {
		return 'takes its `test` from `@playwright/test`, so nothing it exports is fenced';
	}
	const buildsOnFence = [...source.matchAll(FENCE_IMPORT)].some((match) =>
		/(^|[{,\s])test(\s+as\s+\w+)?\s*[,}]/.test(match[1])
	);
	return buildsOnFence ? null : `does not build on './${FENCE_MODULE}'`;
}

function allowancesIn(source) {
	const found = [];
	for (const declaration of source.matchAll(/allowedExternalHosts:\s*\[([^\]]*)\]/g)) {
		for (const match of declaration[1].matchAll(
			/host:\s*['"]([^'"]+)['"]\s*,\s*why:\s*['"]([^'"]*)['"]/g
		)) {
			found.push({ host: match[1], why: match[2] });
		}
	}
	return found;
}

const KNOWN_BAD = [
	{
		line: "import { expect, test } from '@playwright/test';",
		expect: 'the ordinary Playwright import'
	},
	{
		line: "import { expect, test, type Page } from '@playwright/test';",
		expect: 'the Playwright import with types mixed in'
	},
	{
		line: "import { expect } from './support/test.js';\nimport { test } from '@playwright/test';",
		expect: 'the root imported for `expect` while `test` still comes from Playwright'
	},
	{
		line: "import { expect, test } from './support/network-fence.js';",
		expect: 'the fence layer imported directly, skipping the composed root'
	},
	{
		line: "import { test as t } from '@playwright/test';",
		expect: 'the renamed import'
	},
	{
		line: "import { expect } from '@playwright/test';",
		expect: 'a spec that imports the root module nowhere at all'
	}
];

const KNOWN_GOOD = [
	"import { expect, test } from './support/test.js';",
	"import { expect, test } from './support/test';",
	"import { expect, test } from './support/test.js';\nimport type { Page } from '@playwright/test';",
	"import { expect, test } from './support/test.js';\nimport { type Locator, type Route } from '@playwright/test';",
	"import { test } from './support/test.js';\nimport { expect } from '@playwright/test';",
	"import { expect, test } from './support/test.js';\nimport { reachesTheNetwork } from './support/network-fence.js';"
];

const ROOT_GOOD =
	"import { test as fenced } from './network-fence.js';\nexport const test = fenced.extend({});";
const ROOT_BAD = [
	{
		source:
			"import { test as base } from '@playwright/test';\nexport const test = base.extend({});",
		expect: 'a root built straight on Playwright, fencing nothing'
	},
	{
		source: "import { expect } from './network-fence.js';\nexport const test = somethingElse;",
		expect: 'a root that mentions the fence but does not build on it'
	}
];

const controlFailures = matchControls(
	(source) => violationIn(source) !== null,
	KNOWN_BAD,
	KNOWN_GOOD
);
if (rootCompositionFault(ROOT_GOOD) !== null) {
	controlFailures.push('the composed root is no longer recognised as composed');
}
for (const { source, expect } of ROOT_BAD) {
	if (rootCompositionFault(source) === null) controlFailures.push(`${expect} is no longer caught`);
}
const allowanceControl = allowancesIn(
	"test.use({ allowedExternalHosts: [{ host: 'tiles.example.edu', why: 'a specimen' }] });"
);
if (allowanceControl.length !== 1 || allowanceControl[0].host !== 'tiles.example.edu') {
	controlFailures.push('declared network allowances are no longer being found and listed');
}

assertControls(
	controlFailures,
	'The import patterns above are the whole of this fence. If one has been narrowed, a spec\n' +
		'written in that spelling now reaches the network silently.'
);

const rootFault = rootCompositionFault(readFileSync(path.join(repoRoot, ROOT_FILE), 'utf8'));
if (rootFault !== null) {
	console.error(`\n${ROOT_FILE} ${rootFault}.\n`);
	console.error(
		'Every spec takes its `test` from there, so the network fence reaches them only through it.\n' +
			`It must extend the \`test\` exported by './${FENCE_MODULE}.js'.\n`
	);
	process.exit(1);
}

const specs = sourceFiles(['e2e'], /\.e2e\.ts$/);
if (specs.length === 0) {
	console.error(
		'\ncheck-e2e-network-fence: no *.e2e.ts files found — this check guarded nothing.\n'
	);
	process.exit(1);
}

const violations = [];
const allowances = [];
for (const { file, text } of specs) {
	const why = violationIn(text);
	if (why !== null) violations.push({ file, why });
	for (const allowance of allowancesIn(text)) allowances.push({ file, ...allowance });
}

if (allowances.length === 0) {
	console.log(
		`check-e2e-network-fence: ${specs.length} specs behind the composed root, no external hosts allowed.`
	);
} else {
	console.log(
		`check-e2e-network-fence: ${specs.length} specs, ${allowances.length} allowed host(s):`
	);
	for (const { file, host, why } of allowances) console.log(`  ${file}: ${host} — ${why}`);
}

if (violations.length > 0) {
	console.error('\nThese specs are not behind the network fence:\n');
	for (const { file, why } of violations) console.error(`  ${file} ${why}`);
	console.error(
		'\nNo test in this suite may depend on the network. Import `test` from the suite root instead:\n\n' +
			`    import { expect, test } from './${ROOT_MODULE}.js';\n\n` +
			'It is `@playwright/test`’s `test` with two things built in: a `context` that refuses any\n' +
			'request to an origin other than localhost, naming the URL, and a `workspaceRoot()` for the\n' +
			'`page.evaluate` bodies that read the Workspace. Types may still come from `@playwright/test`.\n'
	);
	process.exit(1);
}
