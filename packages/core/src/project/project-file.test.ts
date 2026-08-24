import { describe, expect, it } from 'vitest';

import { parseImportProvenance } from './import-provenance.js';
import { readBaseMapId } from '../base-map/project.js';
import {
	CURRENT_FORMAT_VERSION,
	ProjectFileUnreadableError,
	ProjectFormatTooNewError,
	newProjectFile,
	parseProjectFile,
	serialiseProjectFile,
	type ProjectFile
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
	 * Map Image to a Project — so nothing can resurrect one and there is nothing to record.
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
			'onFrontPage',
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
 * created by exactly one thing — the user adding a Map Image to a Project — so the field means
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

/**
 * The Front Page choice (ADR-0032), and the format-version decision that shapes every test here.
 *
 * `CURRENT_FORMAT_VERSION` was **not** bumped for this field, deliberately. ADR-0010 refuses a
 * `formatVersion` higher than the build understands, and a Remote makes one repository readable by
 * several instances at several versions — so a bump would have turned "my colleague chose something on
 * their newer copy" into "your copy will not open this Project at all". The field therefore has to
 * survive a build that has never heard of it, in both directions: read as on the Front Page when
 * absent, and written back untouched when present.
 */
describe('the Front Page choice (ADR-0032)', () => {
	const withChoice = (onFrontPage?: boolean) =>
		encode({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2026-01-01T00:00:00.000Z',
			layers: [],
			baseMap: null,
			...(onFrontPage === undefined ? {} : { onFrontPage })
		});

	// The upgrade case, and the one a whole Workspace depends on: every `project.json` in existence was
	// written before this field, and reading their absence as anything but "listed" would empty a
	// scholar's Front Page on the day they updated the app.
	it('reads a Project with no such field as on the Front Page', () => {
		expect(parseProjectFile(withChoice()).onFrontPage).toBe(true);
	});

	it('reads the author’s choice when the file carries one', () => {
		expect(parseProjectFile(withChoice(false)).onFrontPage).toBe(false);
		expect(parseProjectFile(withChoice(true)).onFrontPage).toBe(true);
	});

	// A value of some other shape is somebody else's build talking. Reading it as `false` would take a
	// Project off a site over a field this parser could not make sense of, which is the destructive
	// direction; only a literal `false` does that.
	it.each([
		['a string', '"no"'],
		['a number', '0'],
		['null', 'null']
	])('leaves the Project on the Front Page for %s, rather than guessing', (_description, json) => {
		const bytes = new TextEncoder().encode(`{"formatVersion":1,"onFrontPage":${json}}`);

		expect(parseProjectFile(bytes).onFrontPage).toBe(true);
	});

	it('is a new Project’s default, so publishing behaves as it always did', () => {
		expect(newProjectFile('Amsterdam 1625', new Date(0)).onFrontPage).toBe(true);
	});

	// Written as *absence*, exactly as `canonicalUrl` is: a Project on the Front Page keeps the bytes it
	// had before this field existed, so a Workspace kept in git gains no diff on the day of the upgrade.
	it('writes nothing at all for a Project on the Front Page', () => {
		const on = newProjectFile('Amsterdam 1625', new Date(0));

		expect(decode(serialiseProjectFile(on))).not.toContain('onFrontPage');
		expect(
			JSON.parse(decode(serialiseProjectFile({ ...on, onFrontPage: false }))).onFrontPage
		).toBe(false);
	});

	/**
	 * ⚠ **The bytes, not the model.** "Written back untouched" is a claim about what lands on disk, and
	 * a Workspace kept in git or Dropbox is where it is cashed: reading a Project taken off the Front
	 * Page and writing it straight back must produce the same file, or every such Project gains a diff
	 * — and a sync client a rewrite to push — the moment anything opens it.
	 *
	 * Spelled out rather than round-tripped from a model, so the key's position and the file's
	 * formatting are pinned too. It sits last, after `baseMap` and any `canonicalUrl`.
	 */
	it('re-serialises a Project off the Front Page to the very same bytes', () => {
		const onDisk = new TextEncoder().encode(
			[
				'{',
				'\t"formatVersion": 1,',
				'\t"name": "Amsterdam 1625",',
				'\t"updatedAt": "2026-01-01T00:00:00.000Z",',
				'\t"layers": [],',
				'\t"baseMap": null,',
				'\t"onFrontPage": false',
				'}',
				''
			].join('\n')
		);

		expect(serialiseProjectFile(parseProjectFile(onDisk))).toEqual(onDisk);
	});

	it('survives a round trip through this build, without also lodging in unknownFields', () => {
		const off = parseProjectFile(withChoice(false));

		expect(off.unknownFields).toEqual({});
		expect(parseProjectFile(serialiseProjectFile(off)).onFrontPage).toBe(false);
	});

	/**
	 * ⚠ **The reason there is no format-version bump**: a build that has never heard of the field must
	 * hand it back exactly as it found it.
	 *
	 * Such a build's `ProjectFile` has no `onFrontPage` property at all — every key it does not name
	 * falls into `unknownFields`, which is the whole of its knowledge of the choice — so that is the
	 * model constructed here, with `true` standing for the property it does not have. What is asserted
	 * is the *bytes* it writes back, because that is where the loss would happen and nowhere else: a
	 * colleague opening their Project in an older fork, saving a rename, and finding it back on a front
	 * page they had taken it off.
	 */
	it('is written back untouched by a build that does not know it', () => {
		const bytes = withChoice(false);
		const asAnOlderBuildHoldsIt: ProjectFile = {
			...parseProjectFile(bytes),
			onFrontPage: true,
			unknownFields: { onFrontPage: false }
		};

		const rewritten = JSON.parse(decode(serialiseProjectFile(asAnOlderBuildHoldsIt)));
		expect(rewritten.onFrontPage).toBe(false);
	});

	// Asserted here rather than left to the ADR, because the bump is the thing an implementer reaches
	// for when adding a field and it is the one move this field must not make.
	it('did not bump the format version', () => {
		expect(CURRENT_FORMAT_VERSION).toBe(1);
		expect(JSON.parse(decode(withChoice(false))).formatVersion).toBe(CURRENT_FORMAT_VERSION);
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

describe('Import Provenance (ADR-0037)', () => {
	const withHistory = (importProvenance: unknown) =>
		encode({
			formatVersion: 1,
			name: 'Amsterdam 1625',
			updatedAt: '2026-01-01T00:00:00.000Z',
			layers: [],
			baseMap: null,
			importProvenance
		});

	const OBSERVED = {
		kind: 'project-bundle',
		filename: 'amsterdam-1625.project.tar',
		projectName: 'Amsterdam 1625',
		observedAt: '2026-08-22T09:30:00.000Z',
		evidence: 'observed'
	};

	it('is absent from a Project nobody imported, so its bytes are what they always were', () => {
		const file = newProjectFile('Amsterdam 1625', new Date(0));

		expect(file.importProvenance).toBeUndefined();
		expect(JSON.parse(decode(serialiseProjectFile(file)))).not.toHaveProperty('importProvenance');
	});

	it('round-trips an observed entry', () => {
		const parsed = parseProjectFile(withHistory([OBSERVED]));

		expect(parsed.importProvenance).toEqual([OBSERVED]);
		expect(JSON.parse(decode(serialiseProjectFile(parsed))).importProvenance).toEqual([OBSERVED]);
	});

	/**
	 * ⚠ **Only the literal `'observed'` is observed** (SPEC story 64).
	 *
	 * An entry with no `evidence`, or one from a build that spells it a third way, reads as inherited:
	 * the direction that costs nothing is the one that does not claim this application witnessed a
	 * transfer, and reading it the other way would manufacture a witness out of a field this build
	 * could not make sense of.
	 */
	it.each([
		['inherited', 'inherited'],
		[undefined, 'inherited'],
		['verified', 'inherited'],
		['observed', 'observed']
	])('reads evidence %s as %s', (evidence, expected) => {
		const parsed = parseProjectFile(withHistory([{ ...OBSERVED, evidence }]));

		expect(parsed.importProvenance?.[0]?.evidence).toBe(expected);
	});

	it('keeps a member of an entry that this build does not model', () => {
		const entry = { ...OBSERVED, sentBy: 'a later build' };

		const rewritten = JSON.parse(
			decode(serialiseProjectFile(parseProjectFile(withHistory([entry]))))
		);

		expect(rewritten.importProvenance).toEqual([entry]);
	});

	// An append-only history whose entries a build can delete is not one, so a kind this build has
	// never heard of is carried rather than dropped — the discipline `unknownFields` applies to the
	// document as a whole, applied to the array whose whole contract is that nothing removes from it.
	it('keeps an entry of a kind this build has never heard of', () => {
		const entry = {
			kind: 'zenodo',
			doi: '10.5281/zenodo.1234567',
			observedAt: '2026-01-05T08:00:00.000Z',
			evidence: 'observed'
		};

		const rewritten = JSON.parse(
			decode(serialiseProjectFile(parseProjectFile(withHistory([entry]))))
		);

		expect(rewritten.importProvenance).toEqual([entry]);
	});

	it('keeps an importProvenance of some other shape entirely, as an unknown field', () => {
		const parsed = parseProjectFile(withHistory('one day this was a string'));

		expect(parsed.importProvenance).toBeUndefined();
		expect(JSON.parse(decode(serialiseProjectFile(parsed))).importProvenance).toBe(
			'one day this was a string'
		);
	});

	// The carried field and a real history cannot both be written under one key, and the history is
	// the one this build is appending to: a transfer that let the unreadable value win would report a
	// Project imported and leave no trace that it ever was (SPEC story 65).
	it('lets a transfer append over an importProvenance of some other shape', () => {
		const parsed = parseProjectFile(withHistory('one day this was a string'));

		// Through the parser, because that is how a real appended entry reaches a `ProjectFile`.
		const appended = parseImportProvenance([OBSERVED]);
		const rewritten = JSON.parse(
			decode(serialiseProjectFile({ ...parsed, importProvenance: appended }))
		);

		expect(rewritten.importProvenance).toEqual([OBSERVED]);
	});

	// The counterpart of "parses to exactly the fields this build understands": that test asks a
	// Project nobody imported, which cannot see an optional field at all.
	it('parses an imported Project to exactly the fields this build understands', () => {
		const parsed = parseProjectFile(withHistory([OBSERVED]));

		expect(Object.keys(parsed).toSorted()).toEqual([
			'baseMap',
			'canonicalUrl',
			'formatVersion',
			'importProvenance',
			'layers',
			'name',
			'onFrontPage',
			'unknownFields',
			'updatedAt'
		]);
	});

	it('does not also lodge the history in unknownFields', () => {
		const parsed = parseProjectFile(withHistory([OBSERVED]));

		expect(parsed.unknownFields).toEqual({});
	});

	it('serialises byte-identically for an unchanged imported Project', () => {
		const bytes = serialiseProjectFile(parseProjectFile(withHistory([OBSERVED])));

		expect(serialiseProjectFile(parseProjectFile(bytes))).toEqual(bytes);
	});
});
