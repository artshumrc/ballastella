// `scripts/check-deploy-artifact.mjs` driven against fixture trees.
//
// The check asserts an **absence**, which is the shape that passes vacuously: point it at nothing
// and nothing is there. So the sound tree, both exclusions, the positive controls, and the service
// worker case are each exercised, and the vacuous case — an empty directory — is required to fail.
//
// It also pins the two failures that matter operationally, because both look like success from the
// inside: a deployment build that read `src/routes` after all (harness present), and a service
// worker whose precache manifest names a document the artifact does not hold (install rejects for
// ever, silently).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkPath = path.join(repoRoot, 'scripts/check-deploy-artifact.mjs');

/**
 * A tree shaped like a built editor.
 *
 * @param defect `'harness'` (the exclusion did not happen), `'fixtures'`, `'missing-page'` (a real
 *   page dropped), `'worker'` (the manifest names an absent document), or `null` for a sound tree.
 */
function fixture(defect) {
	const root = mkdtempSync(path.join(tmpdir(), 'deploy-artifact-'));
	const write = (relative, contents) => {
		mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
		writeFileSync(path.join(root, relative), contents);
	};

	if (defect !== 'missing-page') {
		write('apps/editor/build/index.html', '');
		write('apps/editor/build/align.html', '');
	}
	write('apps/editor/build/_app/immutable/entry/start.AAAA.js', '');

	if (defect === 'harness') write('apps/editor/build/image-pane.html', '');
	// Any file under `fixtures/` will do — the check is about the directory, and spelling a pyramid
	// path here would trip `check-workspace-rooted-paths.mjs` for no gain.
	if (defect === 'fixtures') write('apps/editor/build/fixtures/a-fixture.json', '{}');

	write(
		'apps/editor/build/service-worker.js',
		defect === 'worker'
			? 'const SHELL=["./","./align","./image-pane"];'
			: 'const SHELL=["./","./align"];'
	);

	return root;
}

function run(root) {
	try {
		const stdout = execFileSync('node', [checkPath, '--root', root], { encoding: 'utf8' });
		return { status: 0, output: stdout };
	} catch (error) {
		return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
	}
}

function withFixture(defect, assertion) {
	const root = fixture(defect);
	try {
		assertion(run(root));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test('a deployable artifact passes', () => {
	withFixture(null, ({ status, output }) => {
		assert.equal(status, 0, output);
		assert.match(output, /OK/);
	});
});

test('the harness route in the artifact is refused, and names the likely cause', () => {
	withFixture('harness', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /image-pane\.html is present/);
		assert.match(output, /BALLASTELLA_DEPLOY=1/);
	});
});

test('test fixtures in the artifact are refused', () => {
	withFixture('fixtures', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /fixtures is present/);
	});
});

test('a service worker naming an absent document is refused', () => {
	// The silent one: install rejects atomically and the app simply stops updating.
	withFixture('worker', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /service worker names "image-pane"/);
		assert.match(output, /rejects atomically/);
	});
});

test('a real page dropped from the artifact is refused, not celebrated as a clean build', () => {
	withFixture('missing-page', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /index\.html is missing/);
	});
});

test('an empty directory fails rather than passing vacuously', () => {
	const root = mkdtempSync(path.join(tmpdir(), 'deploy-artifact-empty-'));
	try {
		const { status, output } = run(root);
		assert.equal(status, 1);
		assert.match(output, /could not run/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
