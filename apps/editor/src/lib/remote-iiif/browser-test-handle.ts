/**
 * Every URL the remote-ingest path asked for, for the Playwright suite.
 *
 * Same bargain as `ballastellaLayerStack` and `ballastellaWarped`: SPEC's Seam 2 is the real thing
 * in a real browser, and there are questions a test cannot ask any other way. This one exists for
 * exactly two of them, and both are about what the app *did* rather than what it rendered.
 *
 * **"The lookup is off, so no request is made to `annotations.allmaps.org`."** That is ADR-0015's
 * promise and the acceptance criterion says to assert it by request interception. Playwright's own
 * `page.route` sees requests it is asked to intercept, which makes "nothing was requested" an
 * awkward thing to prove — a route that never fires is indistinguishable from a route that was
 * never installed. Counting here instead makes the absence positive: the same list that holds the
 * `info.json` and the tile also holds every lookup, so `every host requested` is a value a test can
 * read and assert the *whole* of.
 *
 * **"The CORS probe fetched a tile, not only `info.json`."** The failure this ticket exists to
 * prevent is a gate that checks the description and ships the blank map, and a unit test can only
 * assert that against an injected `fetch`. In the running app this list is the evidence.
 *
 * It is not an API. Nothing in `src/` may read it, and nothing outside `add-remote-map.svelte.ts`
 * may write it.
 */
export interface RemoteRequestHandle {
	/** Every URL requested by the remote-ingest path since the page loaded, in order. */
	readonly urls: string[];
	/** The distinct hosts among them. The convenient form for the lookup-is-off assertion. */
	readonly hosts: string[];
}

declare global {
	interface Window {
		ballastellaRemoteRequests?: RemoteRequestHandle;
	}
}

const urls: string[] = [];

export function recordRemoteRequest(url: string): void {
	if (typeof window === 'undefined') return;
	urls.push(url);
	window.ballastellaRemoteRequests = {
		urls,
		hosts: [
			...new Set(
				urls.map((candidate) => {
					try {
						return new URL(candidate).hostname;
					} catch {
						return candidate;
					}
				})
			)
		]
	};
}
