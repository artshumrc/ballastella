import { expect, test } from './support/network-fence.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the hub page loads', async ({ page }) => {
	// Served straight out of `apps/viewer/build`, with no site record beside it — which is what the
	// bundle looks like before publishing has written one. It has to load and say something rather
	// than throw: the same files are what a half-set-up GitHub Pages repository serves.
	await page.goto('./');

	await expect(page.getByRole('heading', { level: 1, name: 'Published Projects' })).toBeVisible();
});

test('the built bundle carries no publishing machinery', async () => {
	// ADR-0019's boundary, in the direction ticket 16 pushed on it. The publish planner, its warnings,
	// and the canonical stamp all live in `@ballastella/core`, which `apps/viewer` imports **wholesale**
	// — so `scripts/check-viewer-deps.mjs` cannot see them, exactly as a review of that fence found.
	// Every published site ships this bundle and a Reader never publishes anything.
	//
	// Marker strings rather than identifiers, because identifiers are minified away, and each one is
	// present in the built *editor*, which is what makes them known-good positives. The build is here
	// to be read because this project's `webServer` built it before the suite ran.
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const build = path.join(repoRoot, 'apps/viewer/build');

	const markers = [
		'a free static host such as GitHub Pages will publish',
		'VIEWER_FILE_PATHS does not record',
		'still fetched from the library that holds',
		'is a Project whose folder has'
	];

	const files: string[] = [];
	const walk = async (directory: string) => {
		for (const entry of await readdir(directory)) {
			const full = path.join(directory, entry);
			if ((await stat(full)).isDirectory()) await walk(full);
			else if (/\.(js|css|html)$/.test(full)) files.push(full);
		}
	};
	await walk(build);

	const offenders: string[] = [];
	for (const file of files) {
		const source = await readFile(file, 'latin1');
		for (const marker of markers) {
			if (source.includes(marker)) offenders.push(`${path.relative(repoRoot, file)}: ${marker}`);
		}
	}

	// The counterpart every fence needs: proof the markers exist somewhere, so this cannot be passing
	// because the strings were reworded.
	const editorChunks: string[] = [];
	const walkEditor = async (directory: string) => {
		for (const entry of await readdir(directory)) {
			const full = path.join(directory, entry);
			if ((await stat(full)).isDirectory()) await walkEditor(full);
			else if (full.endsWith('.js')) editorChunks.push(full);
		}
	};
	await walkEditor(path.join(repoRoot, 'apps/editor/build/_app'));
	const inEditor = new Set<string>();
	for (const file of editorChunks) {
		const source = await readFile(file, 'latin1');
		for (const marker of markers) if (source.includes(marker)) inEditor.add(marker);
	}

	expect(offenders).toEqual([]);
	expect([...inEditor].sort()).toEqual([...markers].sort());
});
