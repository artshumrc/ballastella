import { expect, test } from './support/test.js';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('the hub page loads', async ({ page }) => {
	await page.goto('./');

	await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
});

test('the built bundle carries no site-writing machinery and no alignment route', async () => {
	const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
	const build = path.join(repoRoot, 'apps/viewer/build');

	const markers = [
		'a free static host such as GitHub Pages will serve',
		'VIEWER_FILE_PATHS does not record',
		'still fetched from the library that holds',
		'is a Project whose folder has',
		'Waiting for the matching place on the Base Map',
		'Move it instead, or reset the crop.'
	];

	const filesUnder = async (directory: string, pattern: RegExp) =>
		(await readdir(directory, { recursive: true }))
			.filter((name) => pattern.test(name))
			.map((name) => path.join(directory, name));

	const offenders: string[] = [];
	for (const file of await filesUnder(build, /\.(js|css|html)$/)) {
		const source = await readFile(file, 'latin1');
		for (const marker of markers) {
			if (source.includes(marker)) offenders.push(`${path.relative(repoRoot, file)}: ${marker}`);
		}
	}

	const inEditor = new Set<string>();
	for (const file of await filesUnder(path.join(repoRoot, 'apps/editor/build/_app'), /\.js$/)) {
		const source = await readFile(file, 'latin1');
		for (const marker of markers) if (source.includes(marker)) inEditor.add(marker);
	}

	expect(offenders).toEqual([]);
	expect([...inEditor].sort()).toEqual([...markers].sort());
	const viewerPages = (await readdir(build)).filter((name) => /align/i.test(name));
	expect(viewerPages, 'the viewer build carries an alignment route').toEqual([]);

	const editorPrerendersIt = await stat(path.join(repoRoot, 'apps/editor/build/align.html')).then(
		(entry) => entry.isFile(),
		() => false
	);
	expect(editorPrerendersIt, 'the editor no longer prerenders /align, so this proves nothing').toBe(
		true
	);
});
