// `scripts/stage-deploy-build.mjs` driven against fixture trees.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE CLAIM WORTH TESTING IS THE ONE ABOUT A NAME THAT IS NO LONGER THERE.                        │
// └───────────────────────────────────────────────────────────────────────────────────────────────┘
//
// The staging script excludes by name. A rename therefore has a silent failure available to it: the
// filter matches nothing, the copy succeeds, the build succeeds, and the artifact quietly starts
// shipping whatever the harness was renamed to. The script says it refuses that. This is where that
// sentence becomes true.
//
// The happy path is asserted too — that what is meant to be excluded is gone from the staged tree and
// that everything else survived — because a script that copied nothing at all would satisfy an
// exclusion check on its own.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts/stage-deploy-build.mjs');

/**
 * A tree shaped like `apps/editor`.
 *
 * @param defect `'renamed-route'` (the harness directory is called something else now),
 *   `'renamed-fixtures'`, or `null` for a tree the script should accept.
 */
function fixture(defect) {
	const root = mkdtempSync(path.join(tmpdir(), 'stage-deploy-'));
	const write = (relative, contents) => {
		mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
		writeFileSync(path.join(root, relative), contents);
	};

	write('apps/editor/src/routes/+page.svelte', '<h1>app</h1>');
	write('apps/editor/src/routes/align/+page.svelte', '<h1>align</h1>');
	write(
		defect === 'renamed-route'
			? 'apps/editor/src/routes/pane-harness/+page.svelte'
			: 'apps/editor/src/routes/image-pane/+page.svelte',
		'<h1>harness</h1>'
	);

	write('apps/editor/static/robots.txt', 'User-agent: *');
	write('apps/editor/static/.nojekyll', '');
	write(
		defect === 'renamed-fixtures'
			? 'apps/editor/static/test-data/a-fixture.json'
			: 'apps/editor/static/fixtures/a-fixture.json',
		'{}'
	);

	return root;
}

function run(root) {
	try {
		const stdout = execFileSync('node', [scriptPath, '--root', root], { encoding: 'utf8' });
		return { status: 0, output: stdout };
	} catch (error) {
		return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

function withFixture(defect, assertion) {
	const root = fixture(defect);
	try {
		assertion(run(root), root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('the staged tree drops the harness and the fixtures, and keeps everything else', () => {
	withFixture(null, ({ status, output }, root) => {
		assert.equal(status, 0, output);

		const staged = (relative) => existsSync(path.join(root, 'apps/editor/.deploy', relative));

		assert.equal(staged('routes/image-pane/+page.svelte'), false, 'the harness was staged');
		assert.equal(staged('static/fixtures/a-fixture.json'), false, 'the fixtures were staged');

		// The positive half: a script that copied nothing would pass the two assertions above.
		assert.ok(staged('routes/+page.svelte'), 'the app route did not survive staging');
		assert.ok(staged('routes/align/+page.svelte'), 'the alignment route did not survive staging');
		assert.ok(staged('static/robots.txt'), 'robots.txt did not survive staging');
		assert.ok(staged('static/.nojekyll'), 'the Jekyll marker did not survive staging');
	});
});

test('a renamed harness route is refused rather than silently excluding nothing', () => {
	withFixture('renamed-route', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /src\/routes\/image-pane does not exist, so this step excluded nothing/);
		assert.match(output, /update EXCLUDED/);
	});
});

test('a renamed fixtures directory is refused too', () => {
	withFixture('renamed-fixtures', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /static\/fixtures does not exist, so this step excluded nothing/);
	});
});

test('a rebuild leaves nothing behind from the previous one', () => {
	// The staged tree is output, and a stale entry in it is a file in the artifact that is in nobody's
	// source tree — worse than either shipping the harness or not.
	const root = fixture(null);
	try {
		assert.equal(run(root).status, 0);
		const orphan = path.join(root, 'apps/editor/.deploy/routes/gone/+page.svelte');
		mkdirSync(path.dirname(orphan), { recursive: true });
		writeFileSync(orphan, '<h1>from a previous staging</h1>');

		assert.equal(run(root).status, 0);
		assert.equal(existsSync(orphan), false, 'a stale staged route survived a restage');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
