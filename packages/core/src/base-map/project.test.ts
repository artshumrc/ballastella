import { describe, expect, it } from 'vitest';

import { BASE_MAP_CATALOG } from './catalog';
import { readBaseMapId, withBaseMapId } from './project';
import { resolveBaseMap } from './resolve';

/** The document ticket 02 writes for a new Project. */
const newProject = () => ({ formatVersion: 1, name: 'Amsterdam 1625', layers: [], baseMap: null });

describe('the Base Map field of project.json', () => {
	it('records the author choice as an id, and nothing that could be an address', () => {
		const entry = BASE_MAP_CATALOG.entries[1];
		if (entry === undefined) throw new Error('the catalog needs a second entry for this test');

		const written = JSON.stringify(withBaseMapId(newProject(), entry.id));

		expect(JSON.parse(written).baseMap).toBe(entry.id);
		// ADR-0020: never a URL. The file is portable across deployments precisely because it
		// carries no address, and an unresolvable Base Map renders a wrong map rather than an error.
		expect(written).not.toMatch(/https?:|\.pmtiles|pmtiles:\/\//);
		expect(written).not.toContain(entry.archive);
	});

	it('leaves every other field of the document alone', () => {
		const before = newProject();
		const after = withBaseMapId(before, 'physical');

		expect(after).toMatchObject({ formatVersion: 1, name: 'Amsterdam 1625', layers: [] });
		// Returns a new document rather than mutating the caller's.
		expect(before.baseMap).toBeNull();
	});

	it('reads back what it wrote', () => {
		expect(readBaseMapId(withBaseMapId(newProject(), 'muted'))).toBe('muted');
	});

	it('reads a Project that has recorded no choice as no choice', () => {
		expect(readBaseMapId(newProject())).toBeNull();
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
		const saved = JSON.stringify(withBaseMapId(newProject(), 'physical'));

		const reopened = resolveBaseMap(readBaseMapId(JSON.parse(saved)));

		expect(reopened.entry.id).toBe('physical');
		expect(reopened.fellBack).toBe(false);
	});

	it('opens a Project from another deployment onto the local default, quietly noted', () => {
		const fromElsewhere = JSON.stringify(withBaseMapId(newProject(), 'ordnance-survey-1888'));

		const reopened = resolveBaseMap(readBaseMapId(JSON.parse(fromElsewhere)));

		expect(reopened.entry.id).toBe(BASE_MAP_CATALOG.defaultId);
		expect(reopened.fellBack).toBe(true);
	});
});
