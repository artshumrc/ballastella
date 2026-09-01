import { describe, expect, it } from 'vitest';

import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import {
	appearanceFrom,
	baseMapFlavorName,
	DEFAULT_BASE_MAP_APPEARANCE,
	isDefaultAppearance,
	readBaseMapAppearance,
	type BaseMapAppearance
} from './appearance';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A Project's manifest as it sits on disk, drawn the way `appearance` says. */
const savedWith = (appearance: BaseMapAppearance) =>
	serialiseProjectFile({
		...newProjectFile('Amsterdam 1625', new Date('2026-01-01T00:00:00.000Z')),
		baseMapAppearance: appearance
	});

const look = (patch: Partial<BaseMapAppearance> = {}): BaseMapAppearance => ({
	...DEFAULT_BASE_MAP_APPEARANCE,
	...patch
});

describe('the Base Map appearance', () => {
	it('defaults to the map every Project drew before the field existed', () => {
		// A build that started hiding the roads on upgrade would silently change what published maps
		// assert, which is the same rule `borders` follows.
		expect(DEFAULT_BASE_MAP_APPEARANCE).toEqual({ streets: true, relief: false, muted: false });
		expect(isDefaultAppearance(look())).toBe(true);
		expect(isDefaultAppearance(look({ muted: true }))).toBe(false);
	});

	it('names a flavor per theme, and a different one when high contrast is on', () => {
		// ADR-0016: one theme signal drives the map as well as the interface, so a dark UI cannot
		// frame a bright white map.
		expect(baseMapFlavorName(look(), 'light')).not.toBe(baseMapFlavorName(look(), 'dark'));
		expect(baseMapFlavorName(look({ muted: true }), 'light')).not.toBe(
			baseMapFlavorName(look(), 'light')
		);
		expect(baseMapFlavorName(look({ muted: true }), 'dark')).not.toBe(
			baseMapFlavorName(look(), 'dark')
		);
	});

	describe('reading it off a document', () => {
		it('takes each switch on its own, so one unusable value does not lose the others', () => {
			expect(
				readBaseMapAppearance({
					baseMapAppearance: { streets: false, relief: 'yes', muted: true }
				})
			).toEqual({ streets: false, relief: false, muted: true });
		});

		it.each([
			['nothing at all', {}],
			['a value of the wrong shape', { baseMapAppearance: 'topographic' }],
			['a record with no switch in it', { baseMapAppearance: { colour: 'blue' } }],
			['a document that is not one', null]
		])('reads %s as the default rather than throwing', (_description, document) => {
			// These come off someone's disk, where an old fork or a hand edit may have left anything.
			expect(readBaseMapAppearance(document)).toEqual(DEFAULT_BASE_MAP_APPEARANCE);
		});

		it('separates “switched everything off” from “said nothing”', () => {
			// `appearanceFrom` is what a Reader's own stored preference leans on: all three off is a map
			// somebody asked for, and falling back to the author's would put the streets back.
			const off = { streets: false, relief: false, muted: false };

			expect(appearanceFrom(off)).toEqual(off);
			expect(appearanceFrom({})).toBeNull();
			expect(appearanceFrom(undefined)).toBeNull();
		});
	});

	describe('in project.json', () => {
		it('is not written at all while the author has changed nothing', () => {
			// ADR-0010: a Project that has said nothing keeps the exact bytes it had before this field
			// existed, so a Workspace in git gains no diff on the day the app is updated.
			expect(decode(savedWith(look()))).not.toContain('baseMapAppearance');
			expect(savedWith(look())).toEqual(
				serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-01-01T00:00:00.000Z')))
			);
		});

		it('records the switches, and nothing that could be an address', () => {
			const written = decode(savedWith(look({ relief: true, muted: true })));

			expect(JSON.parse(written).baseMapAppearance).toEqual({
				streets: true,
				relief: true,
				muted: true
			});
			// ADR-0020, restated one level down: how a map is drawn travels, and where its tiles are
			// does not.
			expect(written).not.toMatch(/https?:|\.pmtiles/);
		});

		it('reads back what it wrote', () => {
			const chosen = look({ streets: false, relief: true });

			expect(parseProjectFile(savedWith(chosen)).baseMapAppearance).toEqual(chosen);
		});

		it('does not also lodge the field in unknownFields, which would write it back twice', () => {
			const parsed = parseProjectFile(savedWith(look({ muted: true })));

			expect(parsed.unknownFields).not.toHaveProperty('baseMapAppearance');
			// The round trip is the half that would actually bite: a carried copy is spread over the
			// modelled one and silently undoes the edit just made.
			expect(parseProjectFile(serialiseProjectFile(parsed)).baseMapAppearance).toEqual(
				look({ muted: true })
			);
		});
	});
});
