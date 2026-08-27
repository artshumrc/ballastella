/**
 * Whether the guided sequence that puts a Workspace on GitHub is on screen.
 *
 * The sequence has two entry points — the navigation bar and the Workspace settings Remote section —
 * and exactly one implementation, which is the whole point of this module. The dialog is mounted once,
 * by the bar; anything else that wants it calls {@link ConnectSequence.start}. Two components each
 * mounting their own copy would be two sequences a scholar could be inside at the same time, and the
 * settings one would be a third `<dialog>` stacked over the two it is already inside.
 *
 * A module singleton in the shape `editHistorySlot` and `theme` established. Not a context: the bar is
 * mounted outside the layout's `children()`, so a context provided by a route is not in scope for it.
 */

/**
 * That the page is about to be replaced by GitHub's authorisation screen, and why.
 *
 * ⚠ **The App sign-in is a redirect off this page, so continuing afterwards is not something the
 * sequence can hold in memory** (SPEC story 8). A student presses one button, authorises on GitHub,
 * and comes back to a fresh document — and a sequence that did not reopen would have made signing in
 * look like it undid their place rather than advanced it, which is the failure the whole epic is about.
 *
 * `sessionStorage`, beside the sign-in's own `state` and for the same reasons: it is this tab's and
 * nobody else's, and it does not outlive the tab. It is consumed on the first read, so a reload later
 * in the session does not reopen the sequence.
 */
const RESUMING_KEY = 'ballastella.connect-sequence-resuming';

/** Whether this document is the return leg of a sign-in the sequence began. Consumes the mark. */
function resuming(): boolean {
	try {
		const held = sessionStorage.getItem(RESUMING_KEY) === 'yes';
		if (held) sessionStorage.removeItem(RESUMING_KEY);
		return held;
	} catch {
		// No session storage at all — a server render, or a browser with storage blocked for this site.
		// Either way there is no sign-in to resume, and `beginGitHubSignIn` refuses the trip in the
		// second case before it starts.
		return false;
	}
}

class ConnectSequence {
	/** Whether the sequence is on screen. Bound into the one dialog the navigation bar mounts. */
	open = $state(resuming());

	/** Open the sequence from wherever the author pressed. */
	start(): void {
		this.open = true;
	}

	/**
	 * Mark this tab as leaving for GitHub, so the return lands back in the sequence.
	 *
	 * Cleared again when the sign-in is refused before the redirect: the page is not going anywhere,
	 * so a mark left behind would reopen the sequence on some unrelated reload later on.
	 */
	leavingForGitHub(refused: boolean): void {
		try {
			if (refused) sessionStorage.removeItem(RESUMING_KEY);
			else sessionStorage.setItem(RESUMING_KEY, 'yes');
		} catch {
			// A browser that will not keep this will not keep the sign-in's `state` either, and
			// `beginGitHubSignIn` refuses the trip over that rather than over this.
		}
	}
}

export const connectSequence = new ConnectSequence();
