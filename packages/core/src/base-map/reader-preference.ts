// A Reader's own Base Map appearance on one Published Site (ADR-0020).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THREE RULES, AND EACH ONE IS A DIFFERENT WAY OF GETTING IT WRONG
//
// **It is never Project data.** The author's setting is theirs — it is how the work is framed on
// first contact — and a Reader switching away from it is a preference, not an edit.
// `project.json` is read-only over HTTP anyway, so a naive reuse of the editor's control would try,
// fail, and surface a confusing error at a Reader; the point is that there is nothing here that
// could try. Nothing in this module takes a store.
//
// **The key is per site.** Several scholars' Published Sites routinely share an origin —
// `username.github.io/atlas-2026/` and `username.github.io/seminar/`, and a department's domain with
// a folder per student — and `localStorage` is per *origin*. One key would mean a Reader's choice on
// one scholar's site silently reframing another's, which is the author's framing being overwritten by
// a stranger's preference. So the site's own path is part of the key.
//
// **An unusable stored value reads as no preference.** `localStorage` is a string bag anyone can
// edit, and it can throw on read as well as on write: Safari in private browsing, and any browser
// with site data blocked. A Reader with storage switched off must still see the author's default
// rather than a broken page, so every path here degrades to `null` and never throws.
//
// **Two independent overrides in one record.** Which tiles are read is an id against the site's own
// catalog; how they are drawn is the same `BaseMapAppearance` the author sets (`appearance.ts`), so
// a low-vision Reader can raise the contrast without also giving up the relief the author put under
// the work — which is what a list of named variants forced them to do. Both are stored as one JSON
// object under one key, and each is `null` on its own: a Reader who raised the contrast has not
// thereby chosen a tile source.
//
// The id is not validated against a catalog here. `resolveBaseMap` already falls back visibly for an
// id this deployment cannot serve (ADR-0020) — and it is the same fallback whether the id came from
// a Project or from this, so a second check would be a second answer to one question.

import { appearanceFrom, type BaseMapAppearance } from './appearance.js';

/**
 * The `localStorage` key prefix. Namespaced, because a Published Site is a folder a user may have put
 * anything else beside on the same origin.
 */
export const BASE_MAP_PREFERENCE_PREFIX = 'ballastella.baseMap';

/**
 * The key one Published Site's preference is stored under.
 *
 * Origin **and path**, so two sites on one origin do not share a preference. The path is normalised to
 * end in `/` and to drop `index.html`, because `…/atlas/`, `…/atlas`, and `…/atlas/index.html` are one
 * site reached three ways — a Reader who arrives by a different link must not lose their choice. Query
 * and fragment are dropped: `?p=` names a Project, and the preference is the site's.
 *
 * A URL that will not parse falls back to the string itself, which still keys *something* consistently
 * rather than merging every unparseable case onto one key.
 */
export function baseMapPreferenceKey(siteUrl: string): string {
	return `${BASE_MAP_PREFERENCE_PREFIX}:${siteIdentity(siteUrl)}`;
}

function siteIdentity(siteUrl: string): string {
	let url: URL;
	try {
		url = new URL(siteUrl);
	} catch {
		return siteUrl;
	}
	const path = url.pathname.replace(/index\.html$/, '');
	return `${url.origin}${path.endsWith('/') ? path : `${path}/`}`;
}

/**
 * A minimal `localStorage`, so this module can be driven with no browser.
 *
 * Two methods rather than the whole `Storage` interface: those are the two this needs, and a narrow
 * type is what makes the tests' double honest rather than a partial cast.
 */
export type PreferenceStorage = {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
};

/**
 * What a Reader has chosen for themselves on one site. Each half is `null` until they choose it.
 *
 * Total rather than nullable as a whole, so a caller reads `preference.appearance ?? author's` and
 * never has to ask whether the record was there.
 */
export type ReaderBaseMapPreference = {
	/** The catalog entry this Reader picked, or `null` for the Project's own. */
	readonly entryId: string | null;
	/** How this Reader wants it drawn, or `null` for the author's setting. */
	readonly appearance: BaseMapAppearance | null;
};

/** Nothing chosen. Frozen, so a caller cannot make the shared value mean something. */
const NOTHING_CHOSEN: ReaderBaseMapPreference = Object.freeze({ entryId: null, appearance: null });

/**
 * What this Reader last chose on this site.
 *
 * Both halves `null` for an absent key, a value that will not parse, one carrying neither field, and
 * for storage that throws — see the third rule at the top of this file. A Reader who has switched
 * every appearance switch *off* is not "has not chosen": that is a choice, and `appearanceFrom`
 * keeps it distinct from the absence of one.
 *
 * ⚠ **A value written by a build that stored a bare entry id reads as nothing chosen**, which is the
 * right degradation: the Reader sees the author's framing again and one click puts their choice
 * back, where guessing at the old string would restore half a preference under a new meaning.
 */
export function readBaseMapPreference(
	storage: PreferenceStorage | null | undefined,
	siteUrl: string
): ReaderBaseMapPreference {
	if (!storage) return NOTHING_CHOSEN;
	let stored: string | null;
	try {
		stored = storage.getItem(baseMapPreferenceKey(siteUrl));
	} catch {
		return NOTHING_CHOSEN;
	}
	if (stored === null) return NOTHING_CHOSEN;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return NOTHING_CHOSEN;
	}
	if (typeof parsed !== 'object' || parsed === null) return NOTHING_CHOSEN;
	const fields = parsed as Record<string, unknown>;
	const entryId = typeof fields.entryId === 'string' ? fields.entryId.trim() : '';
	return {
		entryId: entryId === '' ? null : entryId,
		appearance: appearanceFrom(fields.appearance)
	};
}

/**
 * Remember this Reader's choice for this site.
 *
 * Silent on failure, deliberately. A Reader with site data blocked has asked not to be remembered, and
 * the switch itself worked — the Base Map changed, this visit. Surfacing a storage error would report
 * a failure of something the Reader did not ask for.
 *
 * @returns whether it was stored, for a caller that wants to assert rather than for one to render
 */
export function writeBaseMapPreference(
	storage: PreferenceStorage | null | undefined,
	siteUrl: string,
	preference: ReaderBaseMapPreference
): boolean {
	if (!storage) return false;
	try {
		// The whole record each time, including whichever half the Reader did not just touch: this is
		// one Reader's browser rather than a Project's bytes, so there is nothing to keep
		// byte-identical, and a partial write would drop the other choice on the floor.
		storage.setItem(
			baseMapPreferenceKey(siteUrl),
			JSON.stringify({
				...(preference.entryId === null ? {} : { entryId: preference.entryId }),
				...(preference.appearance === null ? {} : { appearance: { ...preference.appearance } })
			})
		);
		return true;
	} catch {
		return false;
	}
}
