import { describe, expect, it } from 'vitest';
import {
	classifyInventory,
	classifyPath,
	publishedOutputDrift,
	projectDirectories,
	recognisedProjectDirectories,
	type PathClass
} from './synchronization-paths.js';

const PROJECTS = new Set(['amsterdam-1625', 'leiden-1640']);

describe('classifyPath', () => {
	const cases: readonly (readonly [PathClass, string, string])[] = [
		['source', 'amsterdam-1625/project.json', 'the authored Project file'],
		['source', 'amsterdam-1625/annotations/notes.geojson', 'an Annotation inside a Project'],
		['source', 'leiden-1640/project.json', 'a second Project'],
		['source', 'images/map-1/info.json', 'a Map Image pyramid'],
		['source', 'images/map-1/0/0/0.jpg', 'a pyramid tile'],
		['source', 'images/map-2/image.json', "an Offline Copy's own metadata"],
		['source', 'alignments/map-1.json', 'an Alignment'],
		['source', 'base-map/tiles/9f8/12/2094/1330.mvt', 'a cached Base Map tile'],
		['source', 'base-map/tiles/12/2094/1330.mvt', 'a legacy unkeyed cached tile'],

		['published-output', '_app/immutable/entry/app.abc123.js', 'a viewer chunk'],
		['published-output', 'index.html', "the site's own page"],
		['published-output', '.nojekyll', "GitHub Pages' Jekyll marker"],
		['published-output', 'robots.txt', 'the crawler note'],
		['published-output', 'ballastella-site.json', 'the site record'],
		['published-output', 'base-map/fonts/Noto Sans Regular/0-255.pbf', 'a generated glyph range'],
		['published-output', 'base-map/sprites/sprite.png', 'a generated sprite sheet'],
		['published-output', 'base-map/amsterdam-centre.pmtiles', "the deployment's extract"],

		['outside-ballastella', 'README.md', "the repository's own readme"],
		['outside-ballastella', 'LICENSE', 'a licence'],
		['outside-ballastella', 'CNAME', 'a custom domain'],
		['outside-ballastella', '.github/workflows/pages.yml', 'a workflow'],
		['outside-ballastella', 'vendor/allmaps', 'a submodule'],
		['outside-ballastella', 'docs/notes.md', 'an unrelated repository directory'],
		['outside-ballastella', 'utrecht-1700/project.json', 'a Project directory nobody recognises']
	];

	it.each(cases)('calls it %s: %s, %s', (expected, path) => {
		expect(classifyPath(path, PROJECTS)).toBe(expected);
	});
});

describe('projectDirectories', () => {
	it('names every top-level directory holding a project.json', () => {
		expect([
			...projectDirectories([
				'amsterdam-1625/project.json',
				'amsterdam-1625/annotations/notes.geojson',
				'leiden-1640/project.json'
			])
		]).toEqual(['amsterdam-1625', 'leiden-1640']);
	});

	it('ignores a project.json that is not directly inside a top-level directory', () => {
		expect([
			...projectDirectories(['project.json', 'a/b/project.json', 'images/map-1/project.json'])
		]).toEqual([]);
	});
});

describe('recognisedProjectDirectories', () => {
	const inventories = {
		local: ['amsterdam-1625/project.json', 'images/map-1/info.json'],
		remote: ['leiden-1640/project.json', 'README.md'],
		baseline: ['utrecht-1700/project.json']
	};

	it('takes the union of the local, Remote and Baseline inventories', () => {
		expect([...recognisedProjectDirectories(inventories)].sort()).toEqual([
			'amsterdam-1625',
			'leiden-1640',
			'utrecht-1700'
		]);
	});

	for (const [side, directory] of [
		['locally', 'amsterdam-1625'],
		['on the Remote', 'leiden-1640'],
		['in the Baseline', 'utrecht-1700']
	] as const) {
		it(`keeps a directory recognised only ${side}, and every path below it, source-owned`, () => {
			const projects = recognisedProjectDirectories(inventories);
			for (const path of [
				`${directory}/project.json`,
				`${directory}/annotations/notes.geojson`,
				`${directory}/deeper/still/anything.txt`
			]) {
				expect(classifyPath(path, projects)).toBe('source');
			}
		});
	}

	it('recognises nothing from inventories it was not given', () => {
		expect([...recognisedProjectDirectories({})]).toEqual([]);
	});
});

describe('classifyInventory', () => {
	const tree = [
		{ path: '_app/immutable/entry/app.old.js', sha: 'a1' },
		{ path: 'index.html', sha: 'a2' },
		{ path: 'ballastella-site.json', sha: 'a3' },
		{ path: 'base-map/fonts/Noto Sans Regular/0-255.pbf', sha: 'a4' },
		{ path: 'base-map/tiles/9f8/12/2094/1330.mvt', sha: 'a5' },
		{ path: 'amsterdam-1625/project.json', sha: 'a6' },
		{ path: 'images/map-1/info.json', sha: 'a7' },
		{ path: 'alignments/map-1.json', sha: 'a8' },
		{ path: 'README.md', sha: 'a9' }
	];
	const inventory = classifyInventory(tree, projectDirectories(tree.map((entry) => entry.path)));

	it('sorts source, site-owned output and outside files into their own buckets', () => {
		const paths = (entries: readonly { path: string }[]) => entries.map((entry) => entry.path);
		expect(paths(inventory.source)).toEqual([
			'base-map/tiles/9f8/12/2094/1330.mvt',
			'amsterdam-1625/project.json',
			'images/map-1/info.json',
			'alignments/map-1.json'
		]);
		expect(paths(inventory.publishedOutput)).toEqual([
			'_app/immutable/entry/app.old.js',
			'index.html',
			'ballastella-site.json',
			'base-map/fonts/Noto Sans Regular/0-255.pbf'
		]);
		expect(paths(inventory.outside)).toEqual(['README.md']);
	});

	it('carries each entry through whole, so a caller keeps the evidence it arrived with', () => {
		expect(inventory.source[0]).toBe(tree[4]);
	});
});

describe('publishedOutputDrift', () => {
	const local = [
		{ path: 'index.html', sha: 'new' },
		{ path: '_app/immutable/entry/app.new.js', sha: 'chunk-new' }
	];

	it('is empty when both sides hold the same output', () => {
		expect(publishedOutputDrift(local, local)).toEqual([]);
	});

	it('names the paths a republish would change, whichever side holds them', () => {
		expect(
			publishedOutputDrift(local, [
				{ path: 'index.html', sha: 'old' },
				{ path: '_app/immutable/entry/app.old.js', sha: 'chunk-old' }
			])
		).toEqual(['_app/immutable/entry/app.new.js', '_app/immutable/entry/app.old.js', 'index.html']);
	});
});
