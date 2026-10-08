import { describe, expect, it } from 'vitest';

import { decode, encode } from '../test-support.js';
import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { Workspace } from '../project/workspace.js';
import { BASE_MAP_CATALOG } from './catalog';
import { readBaseMapChoice } from './project';
import { resolveBaseMap } from './resolve';

const savedWith = (id: string | null) =>
	serialiseProjectFile({
		...newProjectFile('Amsterdam 1625', new Date('2026-01-01T00:00:00.000Z')),
		baseMap: id
	});

const workspaceHolding = async (id: string | null, now: Date) => {
	const store = new MemoryProjectStore();
	await store.write('amsterdam-1625/project.json', savedWith(id));
	return new Workspace(store, { now: () => now });
};

describe('the Base Map field of project.json', () => {
	it('records the author choice as an id, and nothing that could be an address', () => {
		const entry = BASE_MAP_CATALOG.entries[0];
		if (entry === undefined) throw new Error('the catalog needs an entry for this test');
		const written = decode(savedWith(entry.id));
		expect(JSON.parse(written).baseMap).toBe(entry.id);
		expect(written).not.toMatch(/https?:|\.pmtiles|pmtiles:\/\//);
		expect(written).not.toContain(entry.archive);
	});

	it('leaves every other field of the document alone, and reads back what it wrote', () => {
		expect(JSON.parse(decode(savedWith('regional-extract')))).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2026-01-01T00:00:00.000Z',
			layers: []
		});
		expect(parseProjectFile(savedWith('regional-extract')).baseMap).toBe('regional-extract');
	});

	it('reads a Project that has recorded no choice as no choice', () => {
		expect(parseProjectFile(savedWith(null)).baseMap).toBeNull();
		expect(readBaseMapChoice({ formatVersion: 1 }).id).toBeNull();
	});

	it('treats any unusable shape as no choice rather than throwing', () => {
		for (const document of [
			null,
			undefined,
			42,
			'a string',
			[],
			{ baseMap: 7 },
			{ baseMap: '  ' }
		]) {
			expect(readBaseMapChoice(document).id).toBeNull();
		}
	});

	it('reopens a Project onto the Base Map the author chose', () => {
		const chosen = BASE_MAP_CATALOG.entries[0];
		if (chosen === undefined) throw new Error('the catalog needs an entry for this test');
		const reopened = resolveBaseMap(parseProjectFile(savedWith(chosen.id)).baseMap);
		expect(reopened.entry.id).toBe(chosen.id);
		expect(reopened.fellBack).toBe(false);
	});

	it('opens a Project from another deployment onto the local default, quietly noted', () => {
		const reopened = resolveBaseMap(parseProjectFile(savedWith('ordnance-survey-1888')).baseMap);
		expect(reopened.entry.id).toBe(BASE_MAP_CATALOG.defaultId);
		expect(reopened.fellBack).toBe(true);
	});

	it('keeps an unrecognised id in the document, so moving the Project back restores it', async () => {
		const workspace = await workspaceHolding(
			'ordnance-survey-1888',
			new Date('2026-02-02T00:00:00.000Z')
		);

		const opened = await workspace.readProject('amsterdam-1625');
		expect(resolveBaseMap(opened.baseMap).entry.id).toBe(BASE_MAP_CATALOG.defaultId);

		await workspace.writeProject('amsterdam-1625', { ...opened, name: 'Amsterdam 1625' });

		expect((await workspace.readProject('amsterdam-1625')).baseMap).toBe('ordnance-survey-1888');
	});

	it('stamps updatedAt when the choice is saved, because one write path owns the document', async () => {
		const saved = new Date('2026-03-03T12:00:00.000Z');
		const workspace = await workspaceHolding(null, saved);

		const opened = await workspace.readProject('amsterdam-1625');
		await workspace.writeProject('amsterdam-1625', { ...opened, baseMap: 'regional-extract' });

		expect(await workspace.readProject('amsterdam-1625')).toMatchObject({
			baseMap: 'regional-extract',
			updatedAt: saved.toISOString(),
			name: 'Amsterdam 1625',
			formatVersion: 1,
			layers: []
		});
	});
});

describe('a Base Map id the catalog has retired', () => {
	const savedAs = (id: string, rest: Record<string, unknown> = {}) =>
		encode(JSON.stringify({ formatVersion: 1, baseMap: id, ...rest }));

	it.each([
		['streets', { streets: true, relief: false, highContrast: false, imagery: false }],
		['physical', { streets: false, relief: false, highContrast: false, imagery: false }],
		['topographic', { streets: true, relief: true, highContrast: false, imagery: false }],
		['muted', { streets: true, relief: false, highContrast: true, imagery: false }]
	])('reads “%s” as the appearance it drew, over the deployment default', (id, appearance) => {
		const project = parseProjectFile(savedAs(id));
		expect(project.baseMapAppearance).toEqual(appearance);
		expect(project.baseMap).toBeNull();
		expect(resolveBaseMap(project.baseMap).fellBack).toBe(false);
	});

	it('lets an appearance the author has since written stand over the retired id', () => {
		const project = parseProjectFile(
			savedAs('topographic', {
				baseMapAppearance: { streets: false, relief: false, highContrast: true }
			})
		);

		expect(project.baseMapAppearance).toEqual({
			streets: false,
			relief: false,
			highContrast: true,
			imagery: false
		});
	});

	it('drops the retired id from the document on the next ordinary save', () => {
		const written = JSON.parse(decode(serialiseProjectFile(parseProjectFile(savedAs('physical')))));
		expect(written.baseMap).toBeNull();
		expect(written.baseMapAppearance).toEqual({
			streets: false,
			relief: false,
			highContrast: false,
			imagery: false
		});
	});

	it('still reports an id that is somebody else’s rather than retired', () => {
		expect(resolveBaseMap(parseProjectFile(savedAs('ordnance-survey-1888')).baseMap).fellBack).toBe(
			true
		);
	});
});
