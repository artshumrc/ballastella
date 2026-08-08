/**
 * Whether this Published Site has a connection, as one signal.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY A READ-ONLY SITE NEEDS THIS AT ALL
 *
 * Nothing here fetches on the Reader's behalf that a retry would help with — the site is static and
 * read-only. What this exists for is the **wording** of the Base Map's failure notice (ticket 22).
 * `baseMapUnavailableNotice` in `@ballastella/core` says, of a `needsNetwork` entry, that the failure
 * "is usually that server rather than your connection". That sentence is true while the connection is
 * fine and a plain falsehood while it is not, and telling somebody whose wifi is off that a bucket in
 * another country is having a bad afternoon is worse than saying nothing. So the notice is gated on
 * this, exactly as the editor's is on `useInstalledApp().online`.
 *
 * **This is deliberately not an offline notice**, and the viewer does not have one. `navigator.onLine`
 * is a weak signal — it reports a link, not reachability, and it is false-positive in both directions
 * — which is fine for suppressing a claim and would not be fine for making one.
 *
 * The editor's copy lives on `InstalledApp` because a service worker owns the rest of that object.
 * There is no service worker on a Published Site, so this is the whole of it.
 */
class OnlineSignal {
	// `true` before the browser has been asked, so that a prerendered page and the first frame of a
	// hydrated one never suppress a notice on the strength of a value nobody has read yet.
	#online = $state(true);

	get current(): boolean {
		return this.#online;
	}

	/** Begin listening. Browser only, so call it from a mounted component. Returns its own teardown. */
	start(): () => void {
		if (typeof window === 'undefined') return () => undefined;
		const abort = new AbortController();
		const { signal } = abort;
		this.#online = navigator.onLine;
		addEventListener('online', () => (this.#online = true), { signal });
		addEventListener('offline', () => (this.#online = false), { signal });
		return () => abort.abort();
	}
}

export const online = new OnlineSignal();
