import { describe, expect, it } from 'vitest';

import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { Workspace } from '../project/workspace.js';
import { BASE_MAP_CATALOG } from './catalog';
import { readBaseMapId } from './project';
import { resolveBaseMap } from './resolve';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A Project's manifest as it sits on disk, with `baseMap` set to `id`. */
const savedWith = (id: string | null) =>
	serialiseProjectFile({
		...newProjectFile('Amsterdam 1625', new Date('2026-01-01T00:00:00.000Z')),
		baseMap: id
	});

describe('the Base Map field of project.json', () => {
	it('records the author choice as an id, and nothing that could be an address', () => {
		const entry = BASE_MAP_CATALOG.entries[1];
		if (entry === undefined) throw new Error('the catalog needs a second entry for this test');

		const written = decode(savedWith(entry.id));

		expect(JSON.parse(written).baseMap).toBe(entry.id);
		// ADR-0020: never a URL. The file is portable across deployments precisely because it
		// carries no address, and an unresolvable Base Map renders a wrong map rather than an error.
		expect(written).not.toMatch(/https?:|\.pmtiles|pmtiles:\/\//);
		expect(written).not.toContain(entry.archive);
	});

	it('leaves every other field of the document alone', () => {
		const written = JSON.parse(decode(savedWith('physical')));

		expect(written).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2026-01-01T00:00:00.000Z',
			layers: []
		});
	});

	it('reads back what it wrote', () => {
		expect(parseProjectFile(savedWith('muted')).baseMap).toBe('muted');
	});

	it('reads a Project that has recorded no choice as no choice', () => {
		expect(parseProjectFile(savedWith(null)).baseMap).toBeNull();
		expect(readBaseMapId({ formatVersion: 1 })).toBeNull();
	});

	it('treats any unusable shape as no choice rather than throwing', () => {
		// These come off someone's disk, where an old fork or a hand edit may have left anything.
		for (const document of [
			null,
			undefined,
			42,
			'a string',
			[],
			{ baseMap: 7 },
			{ baseMap: '  ' }
		]) {
			expect(readBaseMapId(document)).toBeNull();
		}
	});

	it('reopens a Project onto the Base Map the author chose', () => {
		const reopened = resolveBaseMap(parseProjectFile(savedWith('physical')).baseMap);

		expect(reopened.entry.id).toBe('physical');
		expect(reopened.fellBack).toBe(false);
	});

	it('opens a Project from another deployment onto the local default, quietly noted', () => {
		const reopened = resolveBaseMap(parseProjectFile(savedWith('ordnance-survey-1888')).baseMap);

		expect(reopened.entry.id).toBe(BASE_MAP_CATALOG.defaultId);
		expect(reopened.fellBack).toBe(true);
	});

	it('keeps an unrecognised id in the document, so moving the Project back restores it', async () => {
		// ADR-0020's portability claim, which is the whole reason `project.json` records an id and not
		// an address: this deployment cannot serve `ordnance-survey-1888`, so it shows its own default —
		// but the author's choice is *their* data and must survive being shown something else.
		// Overwriting it with the local default is one line away and would silently destroy the author's
		// intent the first time a Project were opened on the wrong deployment.
		const store = new MemoryProjectStore();
		const workspace = new Workspace(store, { now: () => new Date('2026-02-02T00:00:00.000Z') });
		await store.write('amsterdam-1625/project.json', savedWith('ordnance-survey-1888'));

		const opened = await workspace.readProject('amsterdam-1625');
		expect(resolveBaseMap(opened.baseMap).entry.id).toBe(BASE_MAP_CATALOG.defaultId);

		// Everything an open Project does thereafter goes through the same document, and none of it may
		// launder the fallback back into the file.
		await workspace.writeProject('amsterdam-1625', { ...opened, name: 'Amsterdam 1625' });

		expect((await workspace.readProject('amsterdam-1625')).baseMap).toBe('ordnance-survey-1888');
	});

	it('stamps updatedAt when the choice is saved, because one write path owns the document', async () => {
		// The Base Map choice goes through the same `Workspace.writeProject` as every other mutation, so
		// it keeps the document's own bookkeeping. A second writer for this one field wrote `baseMap` and
		// nothing else: the hub's "last saved" then went stale, and a stale in-memory document elsewhere
		// in the app could serialise the choice straight back out.
		const store = new MemoryProjectStore();
		const saved = new Date('2026-03-03T12:00:00.000Z');
		const workspace = new Workspace(store, { now: () => saved });
		await store.write('amsterdam-1625/project.json', savedWith(null));

		const opened = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', { ...opened, baseMap: 'physical' });

		const written = await workspace.readProject('amsterdam-1625');
		expect(written.baseMap).toBe('physical');
		expect(written.updatedAt).toBe(saved.toISOString());
		// And nothing else was lost on the way.
		expect(written.name).toBe('Amsterdam 1625');
		expect(written.formatVersion).toBe(1);
		expect(written.layers).toEqual([]);
	});
});
