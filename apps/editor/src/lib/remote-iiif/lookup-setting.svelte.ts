import { COMMUNITY_ALIGNMENT_HOST } from '@ballastella/core';

/**
 * The one signal for "may this app ask Allmaps whether someone has already aligned this map?"
 *
 * ADR-0015: **on by default, disclosed at the point of use, and switchable.** On by default because
 * most users benefit and what leaves the browser is a hash of an already-public URL; switchable
 * because for a scholar working on unpublished or embargoed material, *which manifests this person
 * is examining* is not nothing, and a tool whose premise is "your work lives in a folder you own"
 * cannot quietly contradict itself on every image add.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * IT IS A PREFERENCE, NOT PROJECT DATA
 *
 * So it is not in `project.json`, and that is deliberate rather than convenient. `project.json` has
 * exactly one writer (`EditorSession`) and travels: it goes into a zip, into a published site, and
 * into a colleague's Workspace. A privacy choice that travelled would mean handing someone a Project
 * that silently changed *their* disclosure behaviour — and an instructor distributing an assignment
 * would be setting it for a class. It belongs to this person and this browser, so it lives in
 * `localStorage`, the same place ADR-0020 puts a Reader's Base Map preference.
 *
 * `localStorage` can throw — Safari in private browsing, and a blocked third-party context — so
 * every access is guarded. A browser that will not remember the choice is a browser where the choice
 * still works for this session, which is much better than a page that fails to load.
 */
const STORAGE_KEY = 'ballastella.communityAlignmentLookup';

class CommunityLookupSetting {
	#enabled = $state(read());

	/** Whether {@link COMMUNITY_ALIGNMENT_HOST} may be contacted. */
	get enabled(): boolean {
		return this.#enabled;
	}

	set enabled(next: boolean) {
		this.#enabled = next;
		write(next);
	}

	/** What the setting control says, with the host in it so the sentence is checkable. */
	get label(): string {
		return `Check ${COMMUNITY_ALIGNMENT_HOST} for existing georeferences`;
	}
}

/**
 * Absent reads as **on**, which is ADR-0015's default. Only the exact string `'off'` disables it:
 * a corrupted or truncated value must not silently turn a documented default off, because nothing
 * in the UI would look different and the user would simply stop being offered other people's work.
 */
function read(): boolean {
	try {
		return globalThis.localStorage?.getItem(STORAGE_KEY) !== 'off';
	} catch {
		return true;
	}
}

function write(enabled: boolean): void {
	try {
		globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
	} catch {
		// A browser that will not remember it is not a browser that has refused the choice.
	}
}

export const communityLookup = new CommunityLookupSetting();
