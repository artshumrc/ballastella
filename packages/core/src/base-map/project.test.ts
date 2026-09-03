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
		const entry = BASE_MAP_CATALOG.entries[0];
		if (entry === undefined) throw new Error('the catalog needs an entry for this test');

		const written = decode(savedWith(entry.id));

		expect(JSON.parse(written).baseMap).toBe(entry.id);
		// ADR-0020: never a URL. The file is portable across deployments precisely because it
		// carries no address, and an unresolvable Base Map renders a wrong map rather than an error.
		expect(written).not.toMatch(/https?:|\.pmtiles|pmtiles:\/\//);
		expect(written).not.toContain(entry.archive);
	});

	it('leaves every other field of the document alone', () => {
		const written = JSON.parse(decode(savedWith('regional-extract')));

		expect(written).toMatchObject({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2026-01-01T00:00:00.000Z',
			layers: []
		});
	});

	it('reads back what it wrote', () => {
		expect(parseProjectFile(savedWith('regional-extract')).baseMap).toBe('regional-extract');
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
		await workspace.writeProject('amsterdam-1625', { ...opened, baseMap: 'regional-extract' });

		const written = await workspace.readProject('amsterdam-1625');
		expect(written.baseMap).toBe('regional-extract');
		expect(written.updatedAt).toBe(saved.toISOString());
		// And nothing else was lost on the way.
		expect(written.name).toBe('Amsterdam 1625');
		expect(written.formatVersion).toBe(1);
		expect(written.layers).toEqual([]);
	});
});

/**
 * The four ids the catalog retired, and why they are translated rather than reported.
 *
 * Streets, Physical geography, Topographic and Muted were catalog entries over one archive until
 * they became three orthogonal switches. Every `project.json` written before that names one of them,
 * and to `resolveBaseMap` it is indistinguishable from a fork's id this deployment cannot serve — so
 * an author who had changed nothing was told their Base Map was unavailable and shown a fallback that
 * was, in fact, the same map. The meaning survived the rename; only the name did not.
 */
describe('a Base Map id the catalog has retired', () => {
	const savedAs = (id: string, rest: Record<string, unknown> = {}) =>
		new TextEncoder().encode(JSON.stringify({ formatVersion: 1, baseMap: id, ...rest }));

	it.each([
		['streets', { streets: true, relief: false, highContrast: false }],
		['physical', { streets: false, relief: false, highContrast: false }],
		['topographic', { streets: true, relief: true, highContrast: false }],
		['muted', { streets: true, relief: false, highContrast: true }]
	])('reads “%s” as the appearance it drew, over the deployment default', (id, appearance) => {
		const project = parseProjectFile(savedAs(id));

		expect(project.baseMapAppearance).toEqual(appearance);
		// No id left to fail resolution, so no notice: the tiles never went anywhere.
		expect(project.baseMap).toBeNull();
		expect(resolveBaseMap(project.baseMap).fellBack).toBe(false);
	});

	it('lets an appearance the author has since written stand over the retired id', () => {
		// A Project edited after the switches arrived carries both fields, and the one the author
		// touched last is the one they meant. Reading the two independently would put the retired
		// entry's look back over it.
		const project = parseProjectFile(
			savedAs('topographic', {
				baseMapAppearance: { streets: false, relief: false, highContrast: true }
			})
		);

		expect(project.baseMapAppearance).toEqual({
			streets: false,
			relief: false,
			highContrast: true
		});
	});

	it('drops the retired id from the document on the next ordinary save', () => {
		// The translation is a read; this is what makes it stick. `serialiseProjectFile` writes the
		// parsed model, so a Project that is opened and saved records no choice — the shape this file
		// already writes for one — and gains the appearance the retired id meant, without a migration
		// pass over the Workspace.
		const written = JSON.parse(decode(serialiseProjectFile(parseProjectFile(savedAs('physical')))));

		expect(written.baseMap).toBeNull();
		expect(written.baseMapAppearance).toEqual({
			streets: false,
			relief: false,
			highContrast: false
		});
	});

	it('still reports an id that is somebody else’s rather than retired', () => {
		// ADR-0020's requirement, which the translation above must not quietly widen into “ignore
		// every id that does not resolve”: a fork's Base Map is genuinely absent here, and drawing a
		// plausible-looking substitute in silence is the failure this deployment is written to avoid.
		expect(resolveBaseMap(parseProjectFile(savedAs('ordnance-survey-1888')).baseMap).fellBack).toBe(
			true
		);
	});
});
