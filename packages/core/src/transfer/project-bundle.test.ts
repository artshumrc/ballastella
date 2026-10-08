import { unpackTar } from 'modern-tar';
import { describe, expect, it } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import { collect } from '../test-support.js';
import { exportProjectBundle } from './export-project-bundle.js';
import { planted, projectJson } from './test-fixtures.js';
import type { TransferProgress } from './transfer.js';

const twoProjectsTwoMaps = (): Record<string, string> => ({
	'amsterdam-1625/project.json': projectJson({ name: 'Amsterdam 1625' }),
	'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection","features":[]}',
	'the-canal-ring/project.json': projectJson({
		name: 'The Canal Ring',
		layers: [
			{ id: 'l9', name: 'Blaeu', visible: true, order: 0, kind: 'map', imageId: 'blaeu-1649' }
		]
	}),
	'alignments/amsterdam-1625.json': '{"type":"Annotation","id":"amsterdam-1625"}',
	'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}',
	'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg': 'not really a jpeg, but bytes',
	'alignments/blaeu-1649.json': '{"type":"Annotation","id":"blaeu-1649"}',
	'images/blaeu-1649/info.json': '{"width":2048,"height":2048}',
	'images/blaeu-1649/0,0,256,256/256,256/0/default.jpg': 'somebody else’s tile'
});

const bundleOf = async (store: MemoryProjectStore, directory: string) =>
	collect((await exportProjectBundle(store, directory)).body);

describe('a Project exports to one self-contained bundle', () => {
	it('carries the Project and only the shared material its Layers reference', async () => {
		const store = planted(twoProjectsTwoMaps());
		const bundle = await exportProjectBundle(store, 'amsterdam-1625');
		expect(bundle.fileName).toBe('amsterdam-1625.project.tar');
		expect(bundle.totalFiles).toBe(5);
		const entries = await unpackTar(await collect(bundle.body), { strict: true });
		expect(entries.map((entry) => entry.header.name)).toEqual([
			'alignments/amsterdam-1625.json',
			'annotations/warehouses.geojson',
			'images/amsterdam-1625/0,0,256,256/256,256/0/default.jpg',
			'images/amsterdam-1625/info.json',
			'project.json'
		]);
	});

	it('is rooted at project.json rather than at a directory named after the Project', async () => {
		const store = planted(twoProjectsTwoMaps());
		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });
		expect(entries.map((entry) => entry.header.name)).not.toContain('amsterdam-1625/project.json');
		expect(entries.map((entry) => entry.header.name)).toContain('project.json');
	});

	it('refuses to export a Project that is not there', async () => {
		const store = planted(twoProjectsTwoMaps());

		await expect(exportProjectBundle(store, 'no-such-project')).rejects.toThrow(
			'no-such-project/project.json'
		);
	});

	it('leaves out the published viewer files', async () => {
		const store = planted({
			...twoProjectsTwoMaps(),
			'amsterdam-1625/index.html': '<!doctype html>'
		});

		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });
		expect(entries.map((entry) => entry.header.name)).not.toContain('index.html');
	});

	it('produces identical bytes for the same Project twice', async () => {
		const store = planted(twoProjectsTwoMaps());
		const once = await bundleOf(store, 'amsterdam-1625');
		const twice = await bundleOf(store, 'amsterdam-1625');
		expect(Array.from(twice)).toEqual(Array.from(once));
	});

	it('exports a Project from a newer version of the app', async () => {
		const store = planted({
			...twoProjectsTwoMaps(),
			'amsterdam-1625/project.json': projectJson({ formatVersion: 99 })
		});

		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });
		expect(entries.map((entry) => entry.header.name)).toContain('project.json');
		expect(entries.map((entry) => entry.header.name)).toContain('images/amsterdam-1625/info.json');
	});

	it('exports a Project whose project.json will not parse at all, without its shared material', async () => {
		const store = planted({
			...twoProjectsTwoMaps(),
			'amsterdam-1625/project.json': '{ this is not json'
		});

		const entries = await unpackTar(await bundleOf(store, 'amsterdam-1625'), { strict: true });

		expect(entries.map((entry) => entry.header.name)).toEqual([
			'annotations/warehouses.geojson',
			'project.json'
		]);
	});

	it('exports a Project whose Map Image has not been aligned yet', async () => {
		const workspace = planted({
			'amsterdam-1625/project.json': projectJson(),
			'amsterdam-1625/annotations/warehouses.geojson': '{"type":"FeatureCollection"}',
			'images/amsterdam-1625/info.json': '{"width":4096,"height":3072}'
		});

		const entries = await unpackTar(await bundleOf(workspace, 'amsterdam-1625'), { strict: true });

		expect(entries.map((entry) => entry.header.name)).toEqual([
			'annotations/warehouses.geojson',
			'images/amsterdam-1625/info.json',
			'project.json'
		]);
	});

	it('reports progress over every file', async () => {
		const store = planted(twoProjectsTwoMaps());
		const seen: TransferProgress[] = [];

		await collect(
			(await exportProjectBundle(store, 'amsterdam-1625', { onProgress: (p) => seen.push(p) })).body
		);

		expect(seen.at(-1)?.files).toBe(5);
		expect(seen.at(-1)?.totalFiles).toBe(5);
	});
});
