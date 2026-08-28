// A Reader's own Base Map choice on one Published Site (ADR-0020).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THREE RULES, AND EACH ONE IS A DIFFERENT WAY OF GETTING IT WRONG
//
// **It is never Project data.** The author's default is theirs — it is how the work is framed on
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
// The id is not validated against a catalog here. `resolveBaseMap` already falls back visibly for an
// id this deployment cannot serve (ADR-0020) — and it is the same fallback whether the id came from a
// Project or from this, so a second check would be a second answer to one question.

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
 * The Base Map this Reader last chose on this site, or `null` if they have not chosen.
 *
 * `null` for an absent key, an empty or whitespace-only value, and for storage that throws — see the
 * third rule at the top of this file. Trimmed, so a value edited by hand still resolves.
 */
export function readBaseMapPreference(
	storage: PreferenceStorage | null | undefined,
	siteUrl: string
): string | null {
	if (!storage) return null;
	let stored: string | null;
	try {
		stored = storage.getItem(baseMapPreferenceKey(siteUrl));
	} catch {
		return null;
	}
	const id = stored?.trim() ?? '';
	return id === '' ? null : id;
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
	baseMapId: string
): boolean {
	if (!storage) return false;
	try {
		storage.setItem(baseMapPreferenceKey(siteUrl), baseMapId);
		return true;
	} catch {
		return false;
	}
}
