// What a Reader — or a scholar — is told when a Historical Map's tiles stop arriving.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS HERE AND NOT BESIDE `baseMapUnavailableNotice`
//
// The ticket offered `base-map/resolve.ts` "or a sibling module if that file is the wrong home for a
// Historical Map's failure". It is the wrong home: everything in `base-map/` takes a `BaseMapEntry`
// and answers questions about the modern reference map underneath the work, and this answers a
// question about the work itself. What decides *this* wording is not a catalog entry but the
// refusal the injection layer met — so it lives beside {@link createStoreImageFetch}, which is the
// module that produces the facts and the one place that can classify them.
//
// It follows `baseMapUnavailableNotice` in every other respect, deliberately, because it is the same
// promise made about a different failure:
//
//   - **One function, rendered by both deployments.** The published viewer renders it (ticket 04) and
//     the editor renders it (ticket 05). Two templates would be two answers to one outage, and the
//     scholar who publishes a site is the same person who reads it.
//   - **Three things, in the order the questions arrive**: it is not you; your work is safe; here is
//     what would fix it.
//   - **Visible text, never a tooltip** (ADR-0016: daisyUI renders tooltips through CSS `::before`,
//     so they are neither announced nor dismissable).
//
// ⚠ **The remedies are what the branch is for.** A Reader who reconnects when the site is simply
// missing a file has been sent to do something that cannot work, and one told "that server is having
// a bad afternoon" when their own wifi is off is worse off than one told nothing. So the rows are
// told apart on the facts the refusal carried — a status, or the absence of one — and never on which
// application is asking.

/**
 * Why a Historical Map's tiles could not be fetched, in the terms the remedy turns on.
 *
 * `host` is `null` when the bytes were being read from the site or Workspace the page itself came
 * from, and a hostname when they were being read from somebody else's server — a Library holding a
 * referenced image (ADR-0023). That is the same `null`-means-here convention
 * `baseMapUnavailableNotice` takes, and for the same reason: naming a whole URL at a Reader names a
 * path they cannot act on, while the host identifies who is having the bad afternoon.
 */
export type TileSourceFailure =
	/** The request got no answer at all — a dropped connection, a refused socket, a CORS refusal. */
	| { readonly kind: 'no-answer'; readonly host: string | null }
	/** The server answered, and said it does not hold the file the map is drawn from. */
	| { readonly kind: 'file-missing'; readonly host: string | null }
	/** The server answered with a failure of its own. */
	| { readonly kind: 'server-error'; readonly host: string | null; readonly status: number }
	/**
	 * The read failed for a reason none of the rows above describes — a storage backend refusing, a
	 * permission withdrawn, something unforeseen.
	 *
	 * ⚠ **This row exists so that the other three cannot be made to lie.** The three remedies the
	 * ticket asks for are the three above; this is the honest fourth answer for everything else, and
	 * the alternative — folding an unknown failure into `no-answer` — would tell a scholar whose
	 * browser storage refused to check their connection. It says what happened and offers the only
	 * remedy that is true of every case, which is to try again.
	 */
	| { readonly kind: 'unreadable'; readonly host: string | null; readonly detail: string };

/** `null` means the page's own origin — see {@link TileSourceFailure}. */
const where = (host: string | null): string => (host === null ? 'this site' : host);

/**
 * The sentence shown when a Historical Map's tiles stop arriving.
 *
 * @param failure why the tiles could not be fetched
 * @param mapName the Layer's name, or `null` when the failure cannot be attributed to one Layer —
 *   a pass-through request carries a URL and not a Layer, and a sentence that named the wrong map
 *   would send a scholar to check an Alignment that is fine
 */
export function historicalMapTilesUnavailableNotice(
	failure: TileSourceFailure,
	mapName: string | null = null
): string {
	const subject =
		mapName === null ? 'A Historical Map on this page' : `The Historical Map “${mapName}”`;
	return `${subject} ${cause(failure)} ${SAFE} ${remedy(failure)}`;
}

/**
 * What happened, said as a fact about a server rather than as an error code.
 *
 * "stopped drawing" rather than "failed to load": the failure this sentence exists for is a
 * *mid-session* one, where some of the map is already on screen and stays there. A word implying
 * nothing arrived would contradict the rectangle the Reader is looking at.
 */
function cause(failure: TileSourceFailure): string {
	switch (failure.kind) {
		case 'no-answer':
			return `stopped drawing, because ${where(failure.host)} could not be reached.`;
		case 'file-missing':
			return `stopped drawing, because ${where(failure.host)} does not hold the file it is drawn from.`;
		case 'server-error':
			return `stopped drawing, because ${where(failure.host)} answered ${failure.status}.`;
		case 'unreadable':
			return `stopped drawing, because its tiles could not be read from ${where(failure.host)}: ${failure.detail}`;
	}
}

/**
 * It is not you, and your work is safe — the two things a Reader needs before the remedy.
 *
 * ⚠ **Every clause here has to be true in all four rows**, which is why it is one constant rather
 * than four sentences. It claims nothing about what *is* drawn beyond "whatever had already been
 * drawn is still there", which is the contract the injection layer actually keeps: a refused tile
 * discards no tile that arrived. Anything stronger — that the map is complete, that the geography is
 * under it — would be false in a row somebody meets.
 */
const SAFE =
	'Nothing you did caused this, and nothing has been lost: the Annotations and the rest of the ' +
	'author’s work are unaffected, and whatever of the map had already been drawn is still on screen.';

/**
 * What would help — and, as importantly, what would not.
 *
 * The four rows differ here and nowhere else. `resolve`-style row tests in
 * `tile-failure.test.ts` drive every one of them, plus one asserting that no row makes a claim
 * belonging to another: telling somebody to reconnect when the file is simply absent is advice that
 * cannot work, and it is the failure `baseMapUnavailableNotice` was split into rows to end.
 */
function remedy(failure: TileSourceFailure): string {
	switch (failure.kind) {
		case 'no-answer':
			// Deliberately does not decide between the two. `status === 0` is the browser saying it got
			// nothing back, and from inside the page a dropped connection and a server that has stopped
			// answering are indistinguishable — so the sentence says both rather than guessing, which is
			// the same discipline `online.svelte.ts` applies to `navigator.onLine`.
			return (
				'That is either your connection or that server, and there is no way to tell which from ' +
				'here. The map finishes drawing on its own once the tiles start arriving again, so it is ' +
				'worth checking your connection and waiting rather than reloading.'
			);
		case 'file-missing':
			return (
				'Reconnecting will not help, because the file is not there to fetch. Whoever published ' +
				'this site has to restore it.'
			);
		case 'server-error':
			// The server answered, so the connection demonstrably works. That is the one thing this row
			// can say with certainty and the one thing the row above cannot.
			return (
				'The server answered, so your own connection is working and it is that server that is ' +
				'failing. The map draws itself again once it recovers.'
			);
		case 'unreadable':
			return 'Reloading the page is the thing most likely to help.';
	}
}
