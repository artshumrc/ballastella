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

/** Nothing chosen — what every degradation in this module has to come back to. */
const NOTHING: ReaderBaseMapPreference = { entryId: null, appearance: null };

/** A stored record, as the module writes one. */
const stored = (preference: Partial<ReaderBaseMapPreference>): string =>
	JSON.stringify({
		...(preference.entryId ? { entryId: preference.entryId } : {}),
		...(preference.appearance ? { appearance: preference.appearance } : {})
	});

const HIGH_CONTRAST = { streets: true, relief: false, highContrast: true, imagery: false };

/** A `localStorage` in a `Map`, with the two ways a real one fails. */
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
		it('gives two Published Sites on one origin different keys', () => {
			// The rule this module exists for. `localStorage` is per *origin*, and a department's domain
			// with a folder per student — or one `username.github.io` with a repository per semester — is
			// the normal case, not an edge one. One key would mean a Reader's choice on one scholar's site
			// silently reframing another scholar's work, and the framing is the author's.
			expect(baseMapPreferenceKey('https://dept.example/tracy/atlas/')).not.toBe(
				baseMapPreferenceKey('https://dept.example/sam/atlas/')
			);
		});

		it('gives two origins different keys', () => {
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
			// A Reader who arrives by a different link must not lose their choice — and `?p=` names a
			// Project, while the preference is the site's.
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
		it('returns the appearance this Reader chose here', () => {
			const held = storage({
				[baseMapPreferenceKey('https://x.example/atlas/')]: stored({ appearance: HIGH_CONTRAST })
			});

			expect(readBaseMapPreference(held, 'https://x.example/atlas/')).toEqual({
				entryId: null,
				appearance: HIGH_CONTRAST
			});
		});

		it('keeps the two halves independent, so raising the contrast chooses no tile source', () => {
			const held = storage({
				[baseMapPreferenceKey('https://x.example/')]: stored({ entryId: 'harbour-charts' })
			});

			expect(readBaseMapPreference(held, 'https://x.example/')).toEqual({
				entryId: 'harbour-charts',
				appearance: null
			});
		});

		it('reads a Reader who switched everything off as a choice, not as silence', () => {
			// The distinction the whole `null` half of this module exists for: "nothing on" is a map
			// this Reader asked for, and falling back to the author's would put the streets back.
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

		it('reads no preference when there is no storage at all', () => {
			// Prerendering, and a browser with site data blocked. Nothing chosen rather than a throw: the
			// author's setting is a working answer, and a page that would not render is not.
			expect(readBaseMapPreference(null, 'https://x.example/atlas/')).toEqual(NOTHING);
			expect(readBaseMapPreference(undefined, 'https://x.example/atlas/')).toEqual(NOTHING);
		});

		it('reads no preference when storage itself throws', () => {
			// Safari in private browsing throws from `localStorage` on *access*, not only on write.
			expect(readBaseMapPreference(storage({}, { read: true }), 'https://x.example/')).toEqual(
				NOTHING
			);
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

		it('reports failure rather than throwing when storage refuses', () => {
			// A Reader with site data blocked has asked not to be remembered, and the switch itself
			// worked — the Base Map changed, this visit. Surfacing an error would report the failure of
			// something they did not ask for.
			expect(
				writeBaseMapPreference(storage({}, { write: true }), 'https://x.example/', {
					entryId: null,
					appearance: HIGH_CONTRAST
				})
			).toBe(false);
		});

		it('reports failure when there is no storage', () => {
			expect(writeBaseMapPreference(null, 'https://x.example/', NOTHING)).toBe(false);
		});
	});

	describe('what it is not', () => {
		it('reaches no store, and its whole surface is the two calls plus the key', async () => {
			// The Base Map choice is **never** written to Project data. Asserted on the module's
			// own surface rather than as an intention: the preference is stored and read by exactly these
			// two functions, both of which take a `PreferenceStorage` — two methods over strings — so
			// there is no call site anywhere that could be handed a `ProjectStore` by mistake.
			//
			// The end-to-end half of the claim (a Reader changing a view control makes no write attempt at
			// all, and produces no error) is in `e2e/viewer.e2e.ts`, where there is a real server to watch.
			const module = await import('./reader-preference.js');

			expect(Object.keys(module).sort()).toEqual([
				'BASE_MAP_PREFERENCE_PREFIX',
				'baseMapPreferenceKey',
				'readBaseMapPreference',
				'writeBaseMapPreference'
			]);
			// A `PreferenceStorage` is structurally two methods and cannot be a `ProjectStore`: passing one
			// is a type error, and passing something that merely *has* `getItem`/`setItem` still cannot
			// write a file. The runtime half is that neither call reaches for a global store either — a
			// double with no `getItem` at all is simply not consulted.
			expect(readBaseMapPreference({} as never, 'https://x.example/')).toEqual(NOTHING);
		});

		it('does not validate the id, because resolveBaseMap already falls back visibly', () => {
			// One answer to "can this deployment serve that id?" (ADR-0020), and it is the same answer
			// whether the id came from a Project or from a Reader's own storage. A second check here
			// would be a second answer that can disagree.
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
