import { describe, expect, it } from 'vitest';

import { BASE_MAP_CATALOG } from './catalog';
import {
	BASE_MAP_PREFERENCE_PREFIX,
	baseMapPreferenceKey,
	readBaseMapPreference,
	writeBaseMapPreference,
	type PreferenceStorage,
	type ReaderBaseMapPreference
} from './reader-preference';
import { resolveBaseMap } from './resolve';

const NOTHING: ReaderBaseMapPreference = { entryId: null, appearance: null };

const stored = (preference: Partial<ReaderBaseMapPreference>): string =>
	JSON.stringify({
		...(preference.entryId ? { entryId: preference.entryId } : {}),
		...(preference.appearance ? { appearance: preference.appearance } : {})
	});

const HIGH_CONTRAST = { streets: true, relief: false, highContrast: true, imagery: false };

function storage(
	initial: Record<string, string> = {},
	fails: { read?: boolean; write?: boolean } = {}
): PreferenceStorage & { entries(): Record<string, string> } {
	const held = new Map(Object.entries(initial));
	return {
		getItem(key) {
			if (fails.read) throw new DOMException('The operation is insecure.', 'SecurityError');
			return held.get(key) ?? null;
		},
		setItem(key, value) {
			if (fails.write) throw new DOMException('quota exceeded', 'QuotaExceededError');
			held.set(key, value);
		},
		entries: () => Object.fromEntries(held)
	};
}

describe('a Reader’s Base Map preference', () => {
	describe('the key is per site', () => {
		it('gives two Published Sites on one origin, and two origins, different keys', () => {
			expect(baseMapPreferenceKey('https://dept.example/tracy/atlas/')).not.toBe(
				baseMapPreferenceKey('https://dept.example/sam/atlas/')
			);
			expect(baseMapPreferenceKey('https://a.example/')).not.toBe(
				baseMapPreferenceKey('https://b.example/')
			);
		});

		it.each([
			['a trailing slash and none', 'https://x.example/atlas/', 'https://x.example/atlas'],
			['an explicit index.html', 'https://x.example/atlas/', 'https://x.example/atlas/index.html'],
			['a Project query', 'https://x.example/atlas/', 'https://x.example/atlas/?p=amsterdam-1625'],
			['a fragment', 'https://x.example/atlas/', 'https://x.example/atlas/#somewhere']
		])('treats one site reached two ways as one site: %s', (_description, one, other) => {
			expect(baseMapPreferenceKey(other)).toBe(baseMapPreferenceKey(one));
		});

		it('namespaces the key, because a Published Site is a folder with other things beside it', () => {
			expect(baseMapPreferenceKey('https://x.example/atlas/')).toBe(
				`${BASE_MAP_PREFERENCE_PREFIX}:https://x.example/atlas/`
			);
		});

		it('keys something consistent for a URL it cannot parse rather than merging every such case', () => {
			expect(baseMapPreferenceKey('not a url')).toBe(baseMapPreferenceKey('not a url'));
			expect(baseMapPreferenceKey('not a url')).not.toBe(baseMapPreferenceKey('also not a url'));
		});
	});

	describe('reading', () => {
		it.each([
			{ entryId: null, appearance: HIGH_CONTRAST },
			{ entryId: 'harbour-charts', appearance: null }
		])('returns the half this Reader chose here, and only that half: %o', (chosen) => {
			const held = storage({ [baseMapPreferenceKey('https://x.example/')]: stored(chosen) });
			expect(readBaseMapPreference(held, 'https://x.example/')).toEqual(chosen);
		});

		it('reads a Reader who switched everything off as a choice, not as silence', () => {
			const off = { streets: false, relief: false, highContrast: false, imagery: false };
			const held = storage({
				[baseMapPreferenceKey('https://x.example/')]: stored({ appearance: off })
			});

			expect(readBaseMapPreference(held, 'https://x.example/')?.appearance).toEqual(off);
		});

		it('does not see the preference stored for a different site on the same origin', () => {
			const held = storage({
				[baseMapPreferenceKey('https://x.example/tracy/')]: stored({ appearance: HIGH_CONTRAST })
			});

			expect(readBaseMapPreference(held, 'https://x.example/sam/')).toEqual(NOTHING);
		});

		it.each([
			['no key at all', {}],
			['an empty value', { value: '' }],
			['whitespace alone', { value: '   ' }],
			['a record with none of the fields in it', { value: '{"colour":"blue"}' }],
			['a bare id, as an older build wrote', { value: 'muted' }],
			['an appearance whose switches are strings', { value: '{"appearance":{"muted":"yes"}}' }]
		])('reads %s as no preference, so the author’s setting governs', (_description, held) => {
			const key = baseMapPreferenceKey('https://x.example/atlas/');
			const bag = storage('value' in held ? { [key]: held.value as string } : {});
			expect(readBaseMapPreference(bag, 'https://x.example/atlas/')).toEqual(NOTHING);
		});

		it('reads no preference when there is no storage, when it throws, or when it cannot answer', () => {
			for (const absent of [null, undefined, storage({}, { read: true }), {} as never]) {
				expect(readBaseMapPreference(absent, 'https://x.example/')).toEqual(NOTHING);
			}
		});

		it('trims an id edited by hand', () => {
			const held = storage({
				[baseMapPreferenceKey('https://x.example/')]: '{"entryId":"  harbour-charts  "}'
			});

			expect(readBaseMapPreference(held, 'https://x.example/')?.entryId).toBe('harbour-charts');
		});
	});

	describe('writing', () => {
		it('remembers the choice under this site’s key and nothing else', () => {
			const held = storage();

			expect(
				writeBaseMapPreference(held, 'https://x.example/atlas/', {
					entryId: null,
					appearance: HIGH_CONTRAST
				})
			).toBe(true);
			expect(Object.keys(held.entries())).toEqual([
				baseMapPreferenceKey('https://x.example/atlas/')
			]);
		});

		it('is restored on return, both halves of it', () => {
			const held = storage();
			const chosen = { entryId: 'harbour-charts', appearance: HIGH_CONTRAST };
			writeBaseMapPreference(held, 'https://x.example/atlas/', chosen);
			expect(readBaseMapPreference(held, 'https://x.example/atlas/')).toEqual(chosen);
		});

		it('reports failure rather than throwing when storage refuses, or there is none', () => {
			expect(
				writeBaseMapPreference(storage({}, { write: true }), 'https://x.example/', {
					entryId: null,
					appearance: HIGH_CONTRAST
				})
			).toBe(false);
			expect(writeBaseMapPreference(null, 'https://x.example/', NOTHING)).toBe(false);
		});
	});

	describe('what it is not', () => {
		it('does not validate the id, because resolveBaseMap already falls back visibly', () => {
			const held = storage({
				[baseMapPreferenceKey('https://x.example/')]: JSON.stringify({
					entryId: 'a-base-map-from-another-deployment'
				})
			});
			const chosen = readBaseMapPreference(held, 'https://x.example/');
			expect(chosen.entryId).toBe('a-base-map-from-another-deployment');
			const resolution = resolveBaseMap(chosen.entryId, BASE_MAP_CATALOG);
			expect(resolution.fellBack).toBe(true);
			expect(resolution.entry.id).toBe(BASE_MAP_CATALOG.defaultId);
		});
	});
});
