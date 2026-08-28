#!/usr/bin/env node
// **No test in this suite may depend on the network** — a decision by the repository owner, and the
// reason `e2e/support/network-fence.ts` exists. That module puts the fence on the `context` fixture,
// so a spec is covered by importing a `test` built on it and by nothing else.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THERE IS ONE ROOT `test`, AND THIS CHECKS BOTH HALVES OF IT
//
// `e2e/support/test.ts` composes two fixtures that arrived separately: the network fence, and the
// `workspaceRoot()` a `page.evaluate` needs now that a Workspace is a *named directory* in the OPFS
// root rather than the root itself. Two roots would be a suite where a spec gets whichever its
// author imported — the fence without `workspaceRoot()`, or `workspaceRoot()` reaching the network
// — so specs take `test` from the composed root and from nowhere else, `network-fence.js` included.
//
// And the composition itself is checked, because the import rule alone cannot see it: if
// `support/test.ts` stopped extending the fence, every spec would still import the right module and
// every one of them would reach the network.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A FENCE AND NOT A CONVENTION
//
// `import { expect, test } from '@playwright/test'` is what every Playwright example on the
// internet says, what every existing spec in this repository said until this check was written, and
// what an editor's auto-import offers. A new spec written that way is not *wrong* in any way a
// reader can see — it simply is not behind the fence, and it will reach the network the first time
// somebody adds a Base Map to it.
//
// That is exactly the failure this fence replaces. `routeBaseMapArchive` was opt-in per spec;
// thirteen specs called it and eleven did not, so when `demo-bucket.protomaps.com` began answering
// 404 on 2026-08-07 the suite went red for a reason that had nothing to do with the code under
// test. The three that were failing were routed one at a time.
// Nothing structurally stopped the fourteenth spec from being written the old way, which is why the
// class recurred rather than the instance.
//
// **The patterns are covered by a positive control** (`KNOWN_BAD` / `KNOWN_GOOD` below), run before
// the scan. A regex fence's way of dying is silent: a pattern that matches nothing and a tree with
// nothing to match print the same success line. `check-tiler-lazy.mjs` states the rule; this obeys
// it.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eRoot = path.join(repoRoot, 'e2e');

/**
 * The module every spec must take `test` from: the composed root.
 *
 * Spelled without an extension here because both `'./support/test'` and `'./support/test.js'` are
 * accepted by the suite's tsconfig (`module: Preserve`). Refusing one of them would be a formatting
 * rule wearing a fence's clothes.
 */
const ROOT_MODULE = 'support/test';

/** The fence layer the root is required to be built on. Specs may not take `test` from it. */
const FENCE_MODULE = 'support/network-fence';

/** The composed root's own source, relative to the repository. */
const ROOT_FILE = 'e2e/support/test.ts';

/**
 * A value import of `test` from `@playwright/test`: the one spelling that bypasses the fence.
 *
 * **Type imports are deliberately not matched.** `Locator`, `Page`, `Route` and `Response` carry no
 * behaviour, they still come from `@playwright/test`, and forbidding them would push specs into
 * re-exporting a dozen types through the fence module for no gain. `expect` is likewise fine from
 * either place — it is the same object — but the fence module re-exports it so that the ordinary
 * spelling is one import rather than two.
 */
const PLAYWRIGHT_IMPORT = /import\s+(?!type\b)([^;]*?)\s+from\s+['"]@playwright\/test['"]/gs;

/** Does this import clause bind the value `test`? `type Page` inside the braces does not count. */
function bindsTest(clause) {
	// Strip a default binding and the braces, then look at each specifier.
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

/** An import from the fence layer. Taking `test` from it skips the composed root's other half. */
const FENCE_IMPORT =
	/import\s+(?!type\b)([^;]*?)\s+from\s+['"]\.[^'"]*network-fence(?:\.js)?['"]/gs;

/**
 * Why this file's source is a violation, or `null`. The scan and the positive control share it, so
 * the control exercises the code that runs rather than a paraphrase of it.
 */
function violationIn(source) {
	PLAYWRIGHT_IMPORT.lastIndex = 0;
	for (const match of source.matchAll(PLAYWRIGHT_IMPORT)) {
		if (bindsTest(match[1])) {
			return "imports `test` from '@playwright/test', which is behind neither fixture";
		}
	}
	FENCE_IMPORT.lastIndex = 0;
	for (const match of source.matchAll(FENCE_IMPORT)) {
		if (bindsTest(match[1])) {
			return (
				"imports `test` from './support/network-fence', which is the fence layer and not the " +
				'composed root — it carries no `workspaceRoot()`'
			);
		}
	}
	if (!source.includes(ROOT_MODULE)) {
		return `does not import \`test\` from './${ROOT_MODULE}'`;
	}
	return null;
}

/**
 * Why the composed root is not in fact composed, or `null`.
 *
 * Structural rather than a string match on a comment: the root must bind a `test` from the fence
 * layer and must not bind one from `@playwright/test`. That is what "still fenced" means here, and
 * it is not something a reader of any individual spec could check.
 */
function rootCompositionFault(source) {
	PLAYWRIGHT_IMPORT.lastIndex = 0;
	for (const match of source.matchAll(PLAYWRIGHT_IMPORT)) {
		if (bindsTest(match[1])) {
			return 'takes its `test` from `@playwright/test`, so nothing it exports is fenced';
		}
	}
	FENCE_IMPORT.lastIndex = 0;
	const buildsOnFence = [...source.matchAll(FENCE_IMPORT)].some((match) =>
		/(^|[{,\s])test(\s+as\s+\w+)?\s*[,}]/.test(match[1])
	);
	return buildsOnFence ? null : `does not build on './${FENCE_MODULE}'`;
}

/**
 * Every `allowedExternalHosts` declaration in the suite, so the set cannot grow unremarked.
 *
 * Anchored on `allowedExternalHosts:` and read only as far as the closing bracket, rather than
 * grepping the file for `host: … why: …`. The loose version reported the *specimen* inside
 * `editor-network-fence.e2e.ts`'s own predicate test as a live allowance — a check whose output
 * names an exception that does not exist is a check people stop reading.
 */
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

// ── Positive control ──────────────────────────────────────────────────────────────────────────

/** @type {{ source: string, expect: string }[]} */
const KNOWN_BAD = [
	{
		source: "import { expect, test } from '@playwright/test';",
		expect: 'the ordinary Playwright import'
	},
	{
		source: "import { expect, test, type Page } from '@playwright/test';",
		expect: 'the Playwright import with types mixed in'
	},
	{
		source: "import { expect } from './support/test.js';\nimport { test } from '@playwright/test';",
		expect: 'the root imported for `expect` while `test` still comes from Playwright'
	},
	{
		source: "import { expect, test } from './support/network-fence.js';",
		expect: 'the fence layer imported directly, skipping the composed root'
	},
	{
		source: "import { test as t } from '@playwright/test';",
		expect: 'the renamed import'
	},
	{
		source: "import { expect } from '@playwright/test';",
		expect: 'a spec that imports the root module nowhere at all'
	}
];

/** Spellings that must keep passing. Every one of them is in the suite today. */
const KNOWN_GOOD = [
	"import { expect, test } from './support/test.js';",
	"import { expect, test } from './support/test';",
	"import { expect, test } from './support/test.js';\nimport type { Page } from '@playwright/test';",
	"import { expect, test } from './support/test.js';\nimport { type Locator, type Route } from '@playwright/test';",
	"import { test } from './support/test.js';\nimport { expect } from '@playwright/test';",
	// The fence layer's own predicate, imported for assertion rather than for `test`. This is what
	// `editor-network-fence.e2e.ts` does, and refusing it would push the fence's positive control
	// into testing a copy of the thing instead of the thing itself.
	"import { expect, test } from './support/test.js';\nimport { reachesTheNetwork } from './support/network-fence.js';"
];

/** The composed root, in the shape that is right and the two that quietly are not. */
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

const controlFailures = [];
for (const { source, expect } of KNOWN_BAD) {
	if (violationIn(source) === null) controlFailures.push(`${expect} is no longer caught`);
}
for (const source of KNOWN_GOOD) {
	const why = violationIn(source);
	if (why !== null) {
		controlFailures.push(`a legitimate spelling is now refused (${why}): ${source.split('\n')[0]}`);
	}
}
if (rootCompositionFault(ROOT_GOOD) !== null) {
	controlFailures.push('the composed root is no longer recognised as composed');
}
for (const { source, expect } of ROOT_BAD) {
	if (rootCompositionFault(source) === null) controlFailures.push(`${expect} is no longer caught`);
}
// The allowance reader has to keep reading, or the list below silently empties and a growing set of
// exceptions reads as none at all.
const allowanceControl = allowancesIn(
	"test.use({ allowedExternalHosts: [{ host: 'tiles.example.edu', why: 'a specimen' }] });"
);
if (allowanceControl.length !== 1 || allowanceControl[0].host !== 'tiles.example.edu') {
	controlFailures.push('declared network allowances are no longer being found and listed');
}

if (controlFailures.length > 0) {
	console.error('\nThis check can no longer detect what it exists to detect.\n');
	for (const failure of controlFailures) console.error(`  ${failure}`);
	console.error(
		'\nThe import patterns above are the whole of this fence. If one has been narrowed, a spec\n' +
			'written in that spelling now reaches the network silently.\n'
	);
	process.exit(1);
}

// ── The scan ──────────────────────────────────────────────────────────────────────────────────

const walk = (directory) =>
	readdirSync(directory).flatMap((entry) => {
		const absolute = path.join(directory, entry);
		return statSync(absolute).isDirectory() ? walk(absolute) : [absolute];
	});

// The composition first: without it every spec below could import the right module and still reach
// the network.
const rootFault = rootCompositionFault(readFileSync(path.join(repoRoot, ROOT_FILE), 'utf8'));
if (rootFault !== null) {
	console.error(`\n${ROOT_FILE} ${rootFault}.\n`);
	console.error(
		'Every spec takes its `test` from there, so the network fence reaches them only through it.\n' +
			`It must extend the \`test\` exported by './${FENCE_MODULE}.js'.\n`
	);
	process.exit(1);
}

const specs = walk(e2eRoot).filter((file) => file.endsWith('.e2e.ts'));
if (specs.length === 0) {
	console.error(
		'\ncheck-e2e-network-fence: no *.e2e.ts files found — this check guarded nothing.\n'
	);
	process.exit(1);
}

const violations = [];
const allowances = [];
for (const absolute of specs) {
	const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
	const source = readFileSync(absolute, 'utf8');
	const why = violationIn(source);
	if (why !== null) violations.push({ file: relative, why });
	for (const allowance of allowancesIn(source)) allowances.push({ file: relative, ...allowance });
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
