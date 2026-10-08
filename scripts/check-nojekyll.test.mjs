import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { repoRoot, runScript, withTree } from './test-support.mjs';

const checkPath = path.join(repoRoot, 'scripts/check-nojekyll.mjs');

/**
 * A tree shaped like a built repository.
 *
 * @param defect one of `'editor'` (no marker in the editor's build), `'staged'` (the marker back
 *   inside the viewer bundle), `'constant'` (the exported name gone), `'engine'` (the Remote send
 *   engine no longer naming the marker), or `null` for a sound tree.
 */
function fixture(defect) {
	const files = [{ path: 'index.html', source: 'viewer-bundle/index.html', bytes: 1 }];
	if (defect === 'staged') {
		files.push({ path: '.nojekyll', source: 'viewer-bundle/.nojekyll', bytes: 0 });
	}
	return {
		'packages/core/src/transfer/viewer-files.ts':
			defect === 'constant'
				? 'export const SOMETHING_ELSE = 42;\n'
				: "export const JEKYLL_OFF_MARKER = '.nojekyll';\n",
		'apps/editor/build/index.html': '',
		...(defect === 'editor' ? {} : { 'apps/editor/build/.nojekyll': '' }),
		'apps/editor/static/viewer-bundle/bundle.json': JSON.stringify({ version: 'v', files }),
		'packages/core/src/remote/send-to-remote.ts':
			defect === 'engine'
				? 'export const sendToRemote = async () => {};\n'
				: "import { JEKYLL_OFF_MARKER } from '../transfer/viewer-files.js';\n" +
					'export const sendToRemote = async () => JEKYLL_OFF_MARKER;\n'
	};
}

const check = (defect, remove) =>
	withTree(fixture(defect), (root) => {
		if (remove) rmSync(path.join(root, remove), { recursive: true, force: true });
		return runScript(checkPath, ['--root', root]);
	});

test('a sound tree passes', () => {
	const { status, output } = check(null);
	assert.equal(status, 0, output);
	assert.match(output, /OK/);
});

for (const { name, defect, remove, expect } of [
	{
		name: "the editor's build without the marker is refused",
		defect: 'editor',
		expect: [/apps\/editor\/build\/\.nojekyll is missing/]
	},
	{
		name: 'the marker back inside the staged bundle is refused, by the reason it was removed',
		defect: 'staged',
		expect: [/carries \.nojekyll as "\.nojekyll", so the site write would fetch it/, /dotfiles/]
	},
	{
		name: 'a renamed constant is refused rather than silently looked past',
		defect: 'constant',
		expect: [/no longer exports JEKYLL_OFF_MARKER/]
	},
	{
		name: 'a send engine that no longer writes the marker is refused',
		defect: 'engine',
		expect: [/send-to-remote\.ts no longer names JEKYLL_OFF_MARKER/]
	},
	{
		name: 'a missing send engine is a failure, not a pass',
		remove: 'packages/core/src/remote/send-to-remote.ts',
		expect: [/send-to-remote\.ts does not exist, so this check could not run/]
	},
	{
		name: 'a missing build is a failure, not a pass',
		remove: 'apps/editor/build',
		expect: [/apps\/editor\/build does not exist, so this check could not run/]
	}
]) {
	test(name, () => {
		const { status, output } = check(defect ?? null, remove);
		assert.equal(status, 1);
		for (const pattern of expect) assert.match(output, pattern);
	});
}
