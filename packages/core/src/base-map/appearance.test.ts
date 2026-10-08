import { describe, expect, it } from 'vitest';

import { decode } from '../test-support.js';
import { newProjectFile, parseProjectFile, serialiseProjectFile } from '../project/project-file.js';
import {
	appearanceFrom,
	baseMapFlavorName,
	DEFAULT_BASE_MAP_APPEARANCE,
	drawnAppearance,
	isDefaultAppearance,
	type BaseMapAppearance
} from './appearance';
import { readBaseMapChoice } from './project';

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
		expect(DEFAULT_BASE_MAP_APPEARANCE).toEqual({
			streets: true,
			relief: false,
			highContrast: false,
			imagery: false
		});
		expect(isDefaultAppearance(look())).toBe(true);
		expect(isDefaultAppearance(look({ highContrast: true }))).toBe(false);
	});

	it('switches the high-contrast palette off over imagery, and leaves the relief alone', () => {
		expect(drawnAppearance(look({ imagery: true, highContrast: true }))).toEqual(
			look({ imagery: true, highContrast: false })
		);
		expect(drawnAppearance(look({ imagery: true, relief: true }))).toEqual(
			look({ imagery: true, relief: true })
		);

		const contrast = look({ highContrast: true });
		expect(drawnAppearance(contrast)).toBe(contrast);
	});

	it('names a flavor per theme, and a different one when high contrast is on', () => {
		expect(baseMapFlavorName(look(), 'light')).not.toBe(baseMapFlavorName(look(), 'dark'));
		expect(baseMapFlavorName(look({ highContrast: true }), 'light')).not.toBe(
			baseMapFlavorName(look(), 'light')
		);
		expect(baseMapFlavorName(look({ highContrast: true }), 'dark')).not.toBe(
			baseMapFlavorName(look(), 'dark')
		);
	});

	describe('reading it off a document', () => {
		it('takes each switch on its own, so one unusable value does not lose the others', () => {
			expect(
				readBaseMapChoice({
					baseMapAppearance: { streets: false, relief: 'yes', highContrast: true }
				}).appearance
			).toEqual({ streets: false, relief: false, highContrast: true, imagery: false });
		});

		it.each([
			['nothing at all', {}],
			['a value of the wrong shape', { baseMapAppearance: 'topographic' }],
			['a record with no switch in it', { baseMapAppearance: { colour: 'blue' } }],
			['a document that is not one', null]
		])('reads %s as the default rather than throwing', (_description, document) => {
			expect(readBaseMapChoice(document).appearance).toEqual(DEFAULT_BASE_MAP_APPEARANCE);
		});

		it('reads the name this switch shipped under, so a saved Project keeps its palette', () => {
			expect(appearanceFrom({ muted: true })).toEqual(look({ highContrast: true }));
			expect(appearanceFrom({ streets: false, muted: false })).toEqual(
				look({ streets: false, highContrast: false })
			);
			expect(appearanceFrom({ muted: true, highContrast: false })).toEqual(look());
		});

		it('separates “switched everything off” from “said nothing”', () => {
			const off = { streets: false, relief: false, highContrast: false, imagery: false };
			expect(appearanceFrom(off)).toEqual(off);
			expect(appearanceFrom({})).toBeNull();
			expect(appearanceFrom(undefined)).toBeNull();
		});
	});

	describe('in project.json', () => {
		it('is not written at all while the author has changed nothing', () => {
			expect(decode(savedWith(look()))).not.toContain('baseMapAppearance');
			expect(savedWith(look())).toEqual(
				serialiseProjectFile(newProjectFile('Amsterdam 1625', new Date('2026-01-01T00:00:00.000Z')))
			);
		});

		it('records the switches, and nothing that could be an address', () => {
			const written = decode(savedWith(look({ relief: true, highContrast: true })));

			expect(JSON.parse(written).baseMapAppearance).toEqual({
				streets: true,
				relief: true,
				highContrast: true,
				imagery: false
			});
			expect(written).not.toMatch(/https?:|\.pmtiles/);
		});

		it('reads back what it wrote', () => {
			const chosen = look({ streets: false, relief: true });
			expect(parseProjectFile(savedWith(chosen)).baseMapAppearance).toEqual(chosen);
		});

		it('does not also lodge the field in unknownFields, which would write it back twice', () => {
			const parsed = parseProjectFile(savedWith(look({ highContrast: true })));
			expect(parsed.unknownFields).not.toHaveProperty('baseMapAppearance');
			expect(parseProjectFile(serialiseProjectFile(parsed)).baseMapAppearance).toEqual(
				look({ highContrast: true })
			);
		});
	});
});
