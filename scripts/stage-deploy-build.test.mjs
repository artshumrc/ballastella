import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { repoRoot, runScript, withTree, writeTree } from './test-support.mjs';

const scriptPath = path.join(repoRoot, 'scripts/stage-deploy-build.mjs');

/**
 * A tree shaped like `apps/editor`.
 *
 * @param defect `'renamed-route'` (the harness directory is called something else now),
 *   `'renamed-fixtures'`, or `null` for a tree the script should accept.
 */
const fixture = (defect) => ({
	'apps/editor/src/routes/+page.svelte': '<h1>app</h1>',
	'apps/editor/src/routes/align/+page.svelte': '<h1>align</h1>',
	[defect === 'renamed-route'
		? 'apps/editor/src/routes/pane-harness/+page.svelte'
		: 'apps/editor/src/routes/image-pane/+page.svelte']: '<h1>harness</h1>',
	'apps/editor/static/robots.txt': 'User-agent: *',
	'apps/editor/static/.nojekyll': '',
	[defect === 'renamed-fixtures'
		? 'apps/editor/static/test-data/a-fixture.json'
		: 'apps/editor/static/fixtures/a-fixture.json']: '{}'
});

const stage = (root) => runScript(scriptPath, ['--root', root]);

test('the staged tree drops the harness and the fixtures, and keeps everything else', () => {
	withTree(fixture(null), (root) => {
		const { status, output } = stage(root);
		assert.equal(status, 0, output);

		const staged = (relative) => existsSync(path.join(root, 'apps/editor/.deploy', relative));

		assert.equal(staged('routes/image-pane/+page.svelte'), false, 'the harness was staged');
		assert.equal(staged('static/fixtures/a-fixture.json'), false, 'the fixtures were staged');

		assert.ok(staged('routes/+page.svelte'), 'the app route did not survive staging');
		assert.ok(staged('routes/align/+page.svelte'), 'the alignment route did not survive staging');
		assert.ok(staged('static/robots.txt'), 'robots.txt did not survive staging');
		assert.ok(staged('static/.nojekyll'), 'the Jekyll marker did not survive staging');
	});
});

test('a renamed harness route is refused rather than silently excluding nothing', () => {
	withTree(fixture('renamed-route'), (root) => {
		const { status, output } = stage(root);
		assert.equal(status, 1);
		assert.match(output, /src\/routes\/image-pane does not exist, so this step excluded nothing/);
		assert.match(output, /update EXCLUDED/);
	});
});

test('a renamed fixtures directory is refused too', () => {
	withTree(fixture('renamed-fixtures'), (root) => {
		const { status, output } = stage(root);
		assert.equal(status, 1);
		assert.match(output, /static\/fixtures does not exist, so this step excluded nothing/);
	});
});

test('a rebuild leaves nothing behind from the previous one', () => {
	withTree(fixture(null), (root) => {
		assert.equal(stage(root).status, 0);
		const orphan = 'apps/editor/.deploy/routes/gone/+page.svelte';
		writeTree(root, { [orphan]: '<h1>from a previous staging</h1>' });

		assert.equal(stage(root).status, 0);
		assert.equal(
			existsSync(path.join(root, orphan)),
			false,
			'a stale staged route survived a restage'
		);
	});
});
