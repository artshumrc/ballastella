import { describe, expect, it } from 'vitest';

import { readBaseMapId } from '../base-map/project.js';
import {
	CURRENT_FORMAT_VERSION,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	newProjectFile,
	parseProjectFile,
	serialiseProjectFile
} from './project-file.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('project.json', () => {
	it('writes formatVersion 1', () => {
		const bytes = serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date(0)));

		expect(JSON.parse(decode(bytes))).toEqual({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '1970-01-01T00:00:00.000Z',
			layers: [],
			baseMap: null
		});
	});

	it('round-trips', () => {
		const file = newProjectFile('Boston 1775', new Date('2026-08-05T12:00:00Z'));

		expect(parseProjectFile(serialiseProjectFile(file))).toEqual(file);
	});

	it('is written with a trailing newline, so a workspace in git has readable diffs', () => {
		expect(decode(serialiseProjectFile(newProjectFile('x', new Date(0))))).toMatch(/\n$/);
	});

	/**
	 * The whole of the model, listed, because ADR-0023 **removed** a field from it.
	 *
	 * A map Layer used to be created by an Alignment write, so "does a Layer for this image exist" was
	 * not an idempotence key a deletion could survive, and this file carried a list of the image ids
	 * whose Layer the user had deleted. A Layer is now created by exactly one thing — the user adding a
	 * Historical Map to a Project — so nothing can resurrect one and there is nothing to record.
	 *
	 * Asserted as the exact key set rather than as an absence, so the day something is added to
	 * `ProjectFile` this test says so and somebody decides on purpose. An absence assertion goes green
	 * for a field nobody has thought about, which is how the deleted one would come back under another
	 * name — the thing ticket 02 forbids by name.
	 */
	it('parses to exactly the fields this build understands', () => {
		const opened = parseProjectFile(serialiseProjectFile(newProjectFile('x', new Date(0))));

		expect(Object.keys(opened).toSorted()).toEqual([
			'baseMap',
			'canonicalUrl',
			'formatVersion',
			'layers',
			'name',
			'unknownFields',
			'updatedAt'
		]);
	});

	it('serialises byte-identically for an unchanged Project', () => {
		const file = newProjectFile('Amsterdam 1625', new Date(0));

		expect(serialiseProjectFile(file)).toEqual(
			serialiseProjectFile(parseProjectFile(serialiseProjectFile(file)))
		);
	});
});

describe('refusing a newer format (ADR-0010)', () => {
	it('refuses a formatVersion above what this build understands', () => {
		expect(() => parseProjectFile(encode({ formatVersion: 2, name: 'From the future' }))).toThrow(
			ProjectFormatTooNewError
		);
	});

	it('names the remedy, because that is the part that protects the user', () => {
		let refusal: ProjectFormatTooNewError | undefined;
		try {
			parseProjectFile(encode({ formatVersion: 7, name: 'From the future' }));
		} catch (cause) {
			refusal = cause as ProjectFormatTooNewError;
		}

		expect(refusal?.formatVersion).toBe(7);
		expect(refusal?.supportedFormatVersion).toBe(CURRENT_FORMAT_VERSION);
		expect(refusal?.message).toContain('newer version');
		expect(refusal?.message).toMatch(/https?:\/\//);
		expect(refusal?.message).toContain('update your copy');
	});

	it('accepts the current version', () => {
		expect(parseProjectFile(encode({ formatVersion: 1, name: 'Now' })).name).toBe('Now');
	});
});

describe('unreadable files', () => {
	it.each([
		['not JSON at all', new TextEncoder().encode('{ this is not json')],
		['a truncated object', new TextEncoder().encode('{"formatVersion": 1, "name": "half')],
		['a JSON array', encode([1, 2, 3])],
		['a file with no formatVersion', encode({ name: 'nameless' })],
		['a non-integer formatVersion', encode({ formatVersion: 1.5 })]
	])('reports %s rather than guessing', (_description, bytes) => {
		expect(() => parseProjectFile(bytes)).toThrow(ProjectFileUnreadableError);
	});
});

describe('the Base Map field', () => {
	// One reader, not two. `readBaseMapId` and this parser both answer "what did the author
	// choose?", and while they disagreed the same file behaved differently depending on which
	// path reached it — the Base Map pane read `"  "` as no choice and the Project view read it
	// as a Base Map called two spaces. A Base Map that fails to resolve renders a
	// plausible-looking but *wrong* map (ADR-0020), so a shape that means "no choice" has to
	// mean it everywhere.
	it.each([
		['an id', '"physical"', 'physical'],
		['surrounding whitespace trimmed off an id', '" physical "', 'physical'],
		['whitespace alone as no choice', '"  "', null],
		['an empty string as no choice', '""', null],
		['a non-string as no choice', '7', null],
		['null as no choice', 'null', null]
	])('reads %s', (_description, json, expected) => {
		const bytes = new TextEncoder().encode(`{"formatVersion":1,"baseMap":${json}}`);

		expect(parseProjectFile(bytes).baseMap).toBe(expected);
		expect(parseProjectFile(bytes).baseMap).toBe(readBaseMapId(JSON.parse(decode(bytes))));
	});
});

/**
 * The tombstone ADR-0023 deleted, and the two halves of "deleted" that are not the same claim.
 *
 * `removedMapLayers` was a list of the image ids whose map Layer the user had deleted, consulted on
 * every Alignment write because an Alignment write is what created map Layers. A Layer is now
 * created by exactly one thing — the user adding a Historical Map to a Project — so the field means
 * nothing.
 *
 * Removing it from `ProjectFile` is not enough on its own, and that is what these cover: an
 * unrecognised key falls into `unknownFields`, which this parser keeps and this serialiser writes
 * back, deliberately, so that a field a build one commit ahead added is not destroyed (ADR-0010).
 * Applied to a field *this* build removed, that tolerance is a bug in the other direction — every
 * `project.json` the previous build wrote would carry a dead tombstone for the life of the
 * Workspace, and would gain a diff moving it after `canonicalUrl` the first time anything was
 * edited.
 */
describe('the deleted tombstone (ADR-0023)', () => {
	const withTombstone = encode({
		formatVersion: 1,
		name: 'Amsterdam 1625',
		updatedAt: '2026-01-01T00:00:00.000Z',
		layers: [{ id: 'l1', kind: 'map', name: 'La Floride', imageId: 'floride-1657' }],
		baseMap: null,
		removedMapLayers: ['floride-1657']
	});

	// Half one: **tolerated on input.** Every `project.json` in every existing Workspace has been
	// written by a build that could produce this field, and refusing one — or letting the key throw
	// anywhere — would turn a dead field into a Project that cannot be opened at all.
	it('opens a Project that still carries it, with everything else intact', () => {
		const opened = parseProjectFile(withTombstone);

		expect(opened.name).toBe('Amsterdam 1625');
		expect(opened.layers).toHaveLength(1);
		expect(opened.updatedAt).toBe('2026-01-01T00:00:00.000Z');
	});

	// Half two: **not carried forward.** Asserted on the re-serialised *bytes*, because the field
	// surviving as an unknown one is exactly the failure — it is invisible on `ProjectFile`, which has
	// no such property either way, and visible only in what gets written back.
	it('does not write it back, so the dead field leaves on the first edit', () => {
		const opened = parseProjectFile(withTombstone);

		expect(opened.unknownFields).toEqual({});
		expect(decode(serialiseProjectFile(opened))).not.toContain('removedMapLayers');
	});

	// A tombstone of the wrong shape is dropped just the same: the value is never read, so there is
	// nothing for a bad one to break.
	it.each([
		['the wrong type', 'floride-1657'],
		['a list of the wrong things', [7, null, '']],
		['null', null]
	])('drops it when it holds %s', (_description, value) => {
		const bytes = encode({ formatVersion: 1, name: 'x', removedMapLayers: value });

		expect(parseProjectFile(bytes).unknownFields).toEqual({});
		expect(decode(serialiseProjectFile(parseProjectFile(bytes)))).not.toContain('removedMapLayers');
	});
});

describe('fields this build does not know about', () => {
	it('keeps them, so writing the file back cannot drop somebody else’s work', () => {
		const original = encode({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2026-01-01T00:00:00.000Z',
			layers: [],
			baseMap: null,
			somethingNewer: { deep: ['value'] }
		});

		const rewritten = JSON.parse(decode(serialiseProjectFile(parseProjectFile(original))));
		expect(rewritten.somethingNewer).toEqual({ deep: ['value'] });
	});
});
