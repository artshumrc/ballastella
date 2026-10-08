/** Connection signal gating only the Base Map wording. Not an offline notice: onLine is link, not reachability. */
class OnlineSignal {
	// True until read, so prerender never suppresses a notice.
	#online = $state(true);

	get current(): boolean {
		return this.#online;
	}

	/** Browser only; call from a mounted component. Returns its own teardown. */
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
