import { describe, expect, it } from 'vitest';

import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
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
});
