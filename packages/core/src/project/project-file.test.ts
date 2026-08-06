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
