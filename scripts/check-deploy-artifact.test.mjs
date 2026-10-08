import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { repoRoot, runScript, withTree } from './test-support.mjs';

const checkPath = path.join(repoRoot, 'scripts/check-deploy-artifact.mjs');

/**
 * A tree shaped like a built editor.
 *
 * @param defect `'harness'` (the exclusion did not happen), `'fixtures'`, `'missing-page'` (a real
 *   page dropped), `'worker'` (the manifest names an absent document), or `null` for a sound tree.
 */
const fixture = (defect) => ({
	...(defect === 'missing-page'
		? {}
		: { 'apps/editor/build/index.html': '', 'apps/editor/build/align.html': '' }),
	'apps/editor/build/_app/immutable/entry/start.AAAA.js': '',
	...(defect === 'harness' ? { 'apps/editor/build/image-pane.html': '' } : {}),
	...(defect === 'fixtures' ? { 'apps/editor/build/fixtures/a-fixture.json': '{}' } : {}),
	'apps/editor/build/service-worker.js':
		defect === 'worker'
			? 'const SHELL=["./","./align","./image-pane"];'
			: 'const SHELL=["./","./align"];'
});

const check = (files) => withTree(files, (root) => runScript(checkPath, ['--root', root]));

test('a deployable artifact passes', () => {
	const { status, output } = check(fixture(null));
	assert.equal(status, 0, output);
	assert.match(output, /OK/);
});

for (const { name, files, expect } of [
	{
		name: 'the harness route in the artifact is refused, and names the likely cause',
		files: fixture('harness'),
		expect: [/image-pane\.html is present/, /BALLASTELLA_DEPLOY=1/]
	},
	{
		name: 'test fixtures in the artifact are refused',
		files: fixture('fixtures'),
		expect: [/fixtures is present/]
	},
	{
		name: 'a service worker naming an absent document is refused',
		files: fixture('worker'),
		expect: [/service worker names "image-pane"/, /rejects atomically/]
	},
	{
		name: 'a real page dropped from the artifact is refused, not celebrated as a clean build',
		files: fixture('missing-page'),
		expect: [/index\.html is missing/]
	},
	{
		name: 'an empty directory fails rather than passing vacuously',
		files: {},
		expect: [/could not run/]
	}
]) {
	test(name, () => {
		const { status, output } = check(files);
		assert.equal(status, 1);
		for (const pattern of expect) assert.match(output, pattern);
	});
}
