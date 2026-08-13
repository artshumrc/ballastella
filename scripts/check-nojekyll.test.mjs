// `scripts/check-nojekyll.mjs` driven against fixture trees, so the fence is known to fail.
//
// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ A CHECK THAT HAS NEVER BEEN SEEN TO FAIL IS INDISTINGUISHABLE FROM `exit 0`.                │
// └───────────────────────────────────────────────────────────────────────────────────────────┘
//
// The thing being fenced is an empty marker file whose absence breaks nothing in this repository —
// the whole reason it needs a fence. That gives the fence itself the same property: if a refactor
// broke it into always passing, CI would go green, the marker would drift away next time somebody
// tidied `static/`, and the first report would be a Reader looking at a blank page on a scholar's
// own domain.
//
// So each thing it claims is broken here on purpose, and the passing case is asserted too —
// otherwise a check that refused everything would satisfy the rest. The real build is deliberately
// *not* the fixture: this runs in `pnpm test`, which does not build.
//
// The third case is the regression that already happened once: the marker inside the staged bundle,
// which is publishing fetching an empty file over HTTP and a dead Publish button on any host that
// hides dotfiles.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkPath = path.join(repoRoot, 'scripts/check-nojekyll.mjs');

/**
 * A tree shaped like a built repository.
 *
 * @param defect one of `'editor'` (no marker in the editor's build), `'staged'` (the marker back
 *   inside the viewer bundle), `'constant'` (the exported name gone), `'engine'` (the Remote publish
 *   engine no longer naming the marker), or `null` for a sound tree.
 */
function fixture(defect) {
	const root = mkdtempSync(path.join(tmpdir(), 'nojekyll-'));
	const write = (relative, contents) => {
		mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
		writeFileSync(path.join(root, relative), contents);
	};

	write(
		'packages/core/src/transfer/viewer-files.ts',
		defect === 'constant'
			? 'export const SOMETHING_ELSE = 42;\n'
			: "export const JEKYLL_OFF_MARKER = '.nojekyll';\n"
	);

	write('apps/editor/build/index.html', '');
	if (defect !== 'editor') write('apps/editor/build/.nojekyll', '');

	const files = [{ path: 'index.html', source: 'viewer-bundle/index.html', bytes: 1 }];
	if (defect === 'staged') {
		files.push({ path: '.nojekyll', source: 'viewer-bundle/.nojekyll', bytes: 0 });
	}
	write('apps/editor/static/viewer-bundle/bundle.json', JSON.stringify({ version: 'v', files }));

	// The engine a Publish runs. The defect is the one that would actually happen: the block that
	// authors the marker is deleted, and with it the last mention of the constant.
	write(
		'packages/core/src/remote/publish-to-remote.ts',
		defect === 'engine'
			? 'export const publishToRemote = async () => {};\n'
			: "import { JEKYLL_OFF_MARKER } from '../transfer/viewer-files.js';\n" +
					'export const publishToRemote = async () => JEKYLL_OFF_MARKER;\n'
	);

	return root;
}

/** @returns the check's exit status and its combined output. */
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

test('a sound tree passes', () => {
	withFixture(null, ({ status, output }) => {
		assert.equal(status, 0, output);
		assert.match(output, /OK/);
	});
});

test("the editor's build without the marker is refused", () => {
	withFixture('editor', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /apps\/editor\/build\/\.nojekyll is missing/);
	});
});

test('the marker back inside the staged bundle is refused, by the reason it was removed', () => {
	withFixture('staged', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /carries \.nojekyll as "\.nojekyll", so publishing would fetch it/);
		assert.match(output, /dotfiles/);
	});
});

test('a renamed constant is refused rather than silently looked past', () => {
	// Otherwise this check goes on asserting the presence of a file nothing writes any more.
	withFixture('constant', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /no longer exports JEKYLL_OFF_MARKER/);
	});
});

test('a Publish engine that no longer writes the marker is refused', () => {
	// Link 3, and the end of the chain: the Remote is served by a branch deploy, so a commit without
	// the marker is a blank page on the scholar's own address.
	withFixture('engine', ({ status, output }) => {
		assert.equal(status, 1);
		assert.match(output, /publish-to-remote\.ts no longer names JEKYLL_OFF_MARKER/);
	});
});

// Each of the three links reports its own absence with the same "could not run", so both tests below
// name the file: matching the phrase alone, they would pass on any of the three going missing.
test('a missing Publish engine is a failure, not a pass', () => {
	const root = fixture(null);
	try {
		rmSync(path.join(root, 'packages/core/src/remote/publish-to-remote.ts'), { force: true });
		const { status, output } = run(root);
		assert.equal(status, 1);
		assert.match(output, /publish-to-remote\.ts does not exist, so this check could not run/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('a missing build is a failure, not a pass', () => {
	const root = fixture(null);
	try {
		rmSync(path.join(root, 'apps/editor/build'), { recursive: true, force: true });
		const { status, output } = run(root);
		assert.equal(status, 1);
		assert.match(output, /apps\/editor\/build does not exist, so this check could not run/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
