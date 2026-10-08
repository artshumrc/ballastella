import { describe, expect, it } from 'vitest';

import { parseImportProvenance } from './import-provenance.js';
import { readBaseMapBorderStyle, readBaseMapBorders } from '../base-map/borders.js';
import { readBaseMapChoice } from '../base-map/project.js';
import { decode, encode, rejection } from '../test-support.js';
import {
	CURRENT_FORMAT_VERSION,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	newProjectFile,
	parseProjectFile,
	serialiseProjectFile,
	type ProjectFile
} from './project-file.js';

const json = (value: unknown) => encode(JSON.stringify(value));
const manifest = (extra: Record<string, unknown> = {}) =>
	json({
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2026-01-01T00:00:00.000Z',
		layers: [],
		baseMap: null,
		...extra
	});
const fresh = (): ProjectFile => newProjectFile('Amsterdam 1625', new Date(0));
const text = (file: ProjectFile) => decode(serialiseProjectFile(file));
const written = (file: ProjectFile) => JSON.parse(text(file));
const reserialised = (bytes: Uint8Array) => serialiseProjectFile(parseProjectFile(bytes));

const UNDERSTOOD_FIELDS = (
	'baseMap baseMapAppearance borderStyle borders canonicalUrl description formatVersion ' +
	'layers name onFrontPage unknownFields updatedAt'
).split(' ');

describe('project.json', () => {
	it('writes formatVersion 1 with a trailing newline, re-serialising byte-identically', () => {
		const bytes = serialiseProjectFile(fresh());
		expect(written(fresh())).toEqual({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '1970-01-01T00:00:00.000Z',
			layers: [],
			baseMap: null
		});
		expect(text(fresh())).toMatch(/\n$/);
		expect(reserialised(bytes)).toEqual(bytes);
		expect(Object.keys(parseProjectFile(bytes)).toSorted()).toEqual(UNDERSTOOD_FIELDS);
	});

	it('round-trips, with a description and without', () => {
		const file = newProjectFile('Boston 1775', new Date('2026-08-05T12:00:00Z'));
		expect(parseProjectFile(serialiseProjectFile(file))).toEqual(file);
		expect(text(fresh())).not.toContain('description');
		const described = newProjectFile('Boston 1775', new Date(0), 'The siege, sheet by sheet.');
		expect(parseProjectFile(serialiseProjectFile(described)).description).toBe(
			'The siege, sheet by sheet.'
		);
	});

	it('reads a description of some other shape as none, writing it back until the author replaces it', () => {
		const parsed = parseProjectFile(manifest({ description: { en: 'a title' } }));
		expect(parsed.description).toBe('');
		expect(text(parsed)).toContain('"en": "a title"');
		const described = { ...parsed, description: 'Mine now.' };
		expect(parseProjectFile(serialiseProjectFile(described)).description).toBe('Mine now.');
	});
});

describe('refusing a newer format (ADR-0010)', () => {
	it('refuses a formatVersion above what this build understands, naming the remedy', async () => {
		expect(parseProjectFile(json({ formatVersion: 1, name: 'Now' })).name).toBe('Now');
		const refusal = await rejection(ProjectFormatTooNewError, () =>
			parseProjectFile(json({ formatVersion: 7, name: 'From the future' }))
		);
		expect(refusal.formatVersion).toBe(7);
		expect(refusal.supportedFormatVersion).toBe(CURRENT_FORMAT_VERSION);
		expect(refusal.message).toContain('newer version');
		expect(refusal.message).toMatch(/https?:\/\//);
		expect(refusal.message).toContain('update your copy');
	});
});

describe('unreadable files', () => {
	it.each([
		['not JSON at all', encode('{ this is not json')],
		['a truncated object', encode('{"formatVersion": 1, "name": "half')],
		['a JSON array', json([1, 2, 3])],
		['a file with no formatVersion', json({ name: 'nameless' })],
		['a non-integer formatVersion', json({ formatVersion: 1.5 })]
	])('reports %s rather than guessing', (_description, bytes) => {
		expect(() => parseProjectFile(bytes)).toThrow(ProjectFileUnreadableError);
	});
});

describe('the Base Map field', () => {
	it.each([
		['an id', '"regional-extract"', 'regional-extract'],
		['surrounding whitespace trimmed off an id', '" regional-extract "', 'regional-extract'],
		['whitespace alone as no choice', '"  "', null],
		['an empty string as no choice', '""', null],
		['a non-string as no choice', '7', null],
		['null as no choice', 'null', null]
	])('reads %s', (_description, value, expected) => {
		const bytes = encode(`{"formatVersion":1,"baseMap":${value}}`);
		expect(parseProjectFile(bytes).baseMap).toBe(expected);
		expect(parseProjectFile(bytes).baseMap).toBe(readBaseMapChoice(JSON.parse(decode(bytes))).id);
	});
});

describe('the boundary choice', () => {
	it('reads the field through `readBaseMapBorders` alone, not also lodging it in unknownFields', () => {
		const bytes = manifest({ borders: 'national' });
		expect(parseProjectFile(bytes).borders).toBe(readBaseMapBorders(JSON.parse(decode(bytes))));
		expect(parseProjectFile(manifest({ borders: 'none' })).unknownFields).toEqual({});
	});

	it.each([
		[undefined, 'all'],
		['none', 'none'],
		['national', 'national'],
		['continental', 'all'],
		['', 'all'],
		[7, 'all'],
		[null, 'all']
	])('reads %j as %s, falling back to every boundary rather than none', (borders, expected) => {
		expect(parseProjectFile(manifest({ borders })).borders).toBe(expected);
	});

	it('defaults to every boundary, written as nothing at all', () => {
		expect(fresh().borders).toBe('all');
		expect(text(fresh())).not.toContain('borders');
		expect(written({ ...fresh(), borders: 'none' }).borders).toBe('none');
	});

	it('re-serialises a Project that hides its borders to the very same bytes', () => {
		const bytes = serialiseProjectFile({ ...fresh(), borders: 'national' });
		expect(reserialised(bytes)).toEqual(bytes);
	});
});

describe('the border styling', () => {
	const unstyled = { color: null, lineStyle: null, width: null };

	it('reads the field through `readBaseMapBorderStyle` alone, not also lodging it in unknownFields', () => {
		const bytes = manifest({ borderStyle: { color: '#c1272d', width: 3 } });
		expect(parseProjectFile(bytes).borderStyle).toEqual(
			readBaseMapBorderStyle(JSON.parse(decode(bytes)))
		);
		expect(parseProjectFile(bytes).unknownFields).toEqual({});
	});

	it('reads no field, and a new Project, as having chosen nothing, and writes nothing for it', () => {
		expect(parseProjectFile(manifest()).borderStyle).toEqual(unstyled);
		expect(fresh().borderStyle).toEqual(unstyled);
		expect(text(fresh())).not.toContain('borderStyle');
	});

	it('writes only the properties the author chose', () => {
		const styled = { ...fresh(), borderStyle: { ...unstyled, color: '#c1272d' } };
		expect(written(styled).borderStyle).toEqual({ color: '#c1272d' });
	});

	it('re-serialises a Project that styles its borders to the very same bytes', () => {
		const borderStyle = { color: '#c1272d', lineStyle: 'dotted', width: 2.5 } as const;
		const bytes = serialiseProjectFile({ ...fresh(), borderStyle });
		expect(reserialised(bytes)).toEqual(bytes);
	});

	it('keeps the styling through a Project that hides its borders', () => {
		const bytes = serialiseProjectFile({
			...fresh(),
			borders: 'none',
			borderStyle: { ...unstyled, color: '#c1272d' }
		});
		expect(parseProjectFile(bytes).borderStyle.color).toBe('#c1272d');
		expect(parseProjectFile(bytes).borders).toBe('none');
	});
});

describe('the deleted tombstone (ADR-0023)', () => {
	const withTombstone = manifest({
		layers: [{ id: 'l1', kind: 'map', name: 'La Floride', imageId: 'floride-1657' }],
		removedMapLayers: ['floride-1657']
	});

	it('opens a Project that still carries it, with everything else intact', () => {
		const opened = parseProjectFile(withTombstone);
		expect(opened.name).toBe('Amsterdam 1625');
		expect(opened.layers).toHaveLength(1);
		expect(opened.updatedAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it.each([
		['a list of ids', ['floride-1657']],
		['the wrong type', 'floride-1657'],
		['a list of the wrong things', [7, null, '']],
		['null', null]
	])('drops it when it holds %s, so the dead field leaves on the first edit', (_, value) => {
		const opened = parseProjectFile(manifest({ removedMapLayers: value }));
		expect(opened.unknownFields).toEqual({});
		expect(text(opened)).not.toContain('removedMapLayers');
	});
});

describe('the Front Page choice (ADR-0045)', () => {
	it.each([
		[undefined, false],
		[false, false],
		[true, true],
		['yes', false],
		[1, false],
		[null, false]
	])('reads onFrontPage %j as %j, rather than guessing', (onFrontPage, expected) => {
		expect(parseProjectFile(manifest({ onFrontPage })).onFrontPage).toBe(expected);
	});

	it('is off for a new Project, written as nothing, and `true` explicitly, with no format bump', () => {
		expect(fresh().onFrontPage).toBe(false);
		expect(text(fresh())).not.toContain('onFrontPage');
		expect(written({ ...fresh(), onFrontPage: true }).onFrontPage).toBe(true);
		expect(CURRENT_FORMAT_VERSION).toBe(1);
	});

	it('re-serialises a Project on the Front Page to the very same bytes', () => {
		const onDisk = encode(
			[
				'{',
				'\t"formatVersion": 1,',
				'\t"name": "Amsterdam 1625",',
				'\t"updatedAt": "2026-01-01T00:00:00.000Z",',
				'\t"layers": [],',
				'\t"baseMap": null,',
				'\t"onFrontPage": true',
				'}',
				''
			].join('\n')
		);

		expect(reserialised(onDisk)).toEqual(onDisk);
	});

	it('survives a round trip through this build, without also lodging in unknownFields', () => {
		const on = parseProjectFile(manifest({ onFrontPage: true }));
		expect(on.unknownFields).toEqual({});
		expect(parseProjectFile(serialiseProjectFile(on)).onFrontPage).toBe(true);
	});

	it('is written back untouched by a build that does not know it', () => {
		const asAnOlderBuildHoldsIt: ProjectFile = {
			...parseProjectFile(manifest({ onFrontPage: true })),
			onFrontPage: false,
			unknownFields: { onFrontPage: true }
		};

		expect(written(asAnOlderBuildHoldsIt).onFrontPage).toBe(true);
	});
});

describe('fields this build does not know about', () => {
	it('keeps them, so writing the file back cannot drop somebody else’s work', () => {
		const original = manifest({ somethingNewer: { deep: ['value'] } });
		expect(written(parseProjectFile(original)).somethingNewer).toEqual({ deep: ['value'] });
	});
});

describe('Import Provenance (ADR-0037)', () => {
	const withHistory = (importProvenance: unknown) => manifest({ importProvenance });
	const reread = (importProvenance: unknown) =>
		written(parseProjectFile(withHistory(importProvenance))).importProvenance;

	const OBSERVED = {
		kind: 'project-bundle',
		filename: 'amsterdam-1625.project.tar',
		projectName: 'Amsterdam 1625',
		observedAt: '2026-08-22T09:30:00.000Z',
		evidence: 'observed'
	};

	it('is absent from a Project nobody imported, so its bytes are what they always were', () => {
		expect(fresh().importProvenance).toBeUndefined();
		expect(written(fresh())).not.toHaveProperty('importProvenance');
	});

	it('round-trips an observed entry', () => {
		expect(parseProjectFile(withHistory([OBSERVED])).importProvenance).toEqual([OBSERVED]);
		expect(reread([OBSERVED])).toEqual([OBSERVED]);
	});

	it.each([
		['inherited', 'inherited'],
		[undefined, 'inherited'],
		['verified', 'inherited'],
		['observed', 'observed']
	])('reads evidence %s as %s', (evidence, expected) => {
		const parsed = parseProjectFile(withHistory([{ ...OBSERVED, evidence }]));
		expect(parsed.importProvenance?.[0]?.evidence).toBe(expected);
	});

	it.each([
		[
			'a member of an entry that this build does not model',
			{ ...OBSERVED, sentBy: 'a later build' }
		],
		[
			'an entry of a kind this build has never heard of',
			{
				kind: 'zenodo',
				doi: '10.5281/zenodo.1',
				observedAt: OBSERVED.observedAt,
				evidence: 'observed'
			}
		]
	])('keeps %s', (_description, entry) => {
		expect(reread([entry])).toEqual([entry]);
	});

	it('keeps an importProvenance of some other shape as an unknown field, until a transfer appends', () => {
		const parsed = parseProjectFile(withHistory('one day this was a string'));
		expect(parsed.importProvenance).toBeUndefined();
		expect(written(parsed).importProvenance).toBe('one day this was a string');
		const appended = { ...parsed, importProvenance: parseImportProvenance([OBSERVED]) };
		expect(written(appended).importProvenance).toEqual([OBSERVED]);
	});

	it('parses an imported Project to exactly the fields understood, re-serialising byte-identically', () => {
		const parsed = parseProjectFile(withHistory([OBSERVED]));
		expect(Object.keys(parsed).toSorted()).toEqual(
			[...UNDERSTOOD_FIELDS, 'importProvenance'].toSorted()
		);
		expect(parsed.unknownFields).toEqual({});
		const bytes = reserialised(withHistory([OBSERVED]));
		expect(reserialised(bytes)).toEqual(bytes);
	});
});
