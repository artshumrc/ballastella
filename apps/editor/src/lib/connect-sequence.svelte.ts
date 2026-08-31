/**
 * Whether the guided sequence that puts a Workspace on GitHub is on screen.
 *
 * The bar's own control is the entry point, and there is exactly one implementation, which is the
 * whole point of this module. The dialog is mounted once, by the bar; anything else that wants it —
 * a refusal offering the way forward, a link that landed on the page — calls
 * {@link ConnectSequence.start}. Two components each mounting their own copy would be two sequences
 * a scholar could be inside at the same time.
 *
 * A module singleton in the shape `editHistorySlot` and `theme` established. Not a context: the bar is
 * mounted outside the layout's `children()`, so a context provided by a route is not in scope for it.
 */

/**
 * That the page is about to be replaced by GitHub's authorisation screen, and why.
 *
 * ⚠ **The App sign-in is a redirect off this page, so continuing afterwards is not something the
 * sequence can hold in memory.** A student presses one button, authorises on GitHub, and comes back
 * to a fresh document — and a sequence that did not reopen would have made signing in look like it
 * undid their place rather than advanced it, which is the failure this mark exists to prevent.
 *
 * `sessionStorage`, beside the sign-in's own `state` and for the same reasons: it is this tab's and
 * nobody else's, and it does not outlive the tab. It is consumed on the first read, so a reload later
 * in the session does not reopen the sequence.
 */
const RESUMING_KEY = 'ballastella.connect-sequence-resuming';

/**
 * That the author has already been past the step telling them a GitHub account is needed.
 *
 * ⚠ **A hint that refines a derived step, never a position that replaces one.** Whether somebody
 * has a GitHub account is the one fact in the whole sequence that cannot be read from anywhere:
 * GitHub will not answer it about a stranger, so the pre-sign-in step *offers* the prerequisite
 * rather than detecting it, and the only thing worth remembering is that it has been offered. Every
 * other step of the sequence is still a reading of what is true, and this one is overruled the
 * moment a credential exists.
 *
 * `sessionStorage`, so it lasts exactly as long as the tab the sign-in does — a lab machine handed
 * to the next student starts from the beginning. Not consumed on read, unlike {@link RESUMING_KEY}:
 * an author who makes an account, comes back, and reloads twice is still an author with an account.
 */
const ACCOUNT_KEY = 'ballastella.connect-sequence-account-known';

/** Whether this tab has already been told a GitHub account is needed, or shown that one is held. */
export function gitHubAccountKnown(): boolean {
	try {
		return sessionStorage.getItem(ACCOUNT_KEY) === 'yes';
	} catch {
		return false;
	}
}

/** Remember that the account step is behind this author, so returning lands at the sign-in. */
export function rememberGitHubAccount(): void {
	try {
		sessionStorage.setItem(ACCOUNT_KEY, 'yes');
	} catch {
		// A browser holding nothing puts the account step back on a reload, which is a repeated
		// sentence rather than a lost place: the link and the way past it are both still there.
	}
}

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

	/**
	 * Why GitHub sent the author back without signing them in, or `''`.
	 *
	 * ⚠ **The refusal happens on a document this sequence did not exist in.** The App sign-in
	 * replaces the page, so a decline on GitHub's own screen is judged by the route that receives the
	 * callback — and without somewhere to put it, the sequence reopened on the return leg would show
	 * a sign-in step with no account of why the last press did not work.
	 */
	signInRefusal = $state('');

	/** Open the sequence from wherever the author pressed. */
	start(): void {
		this.open = true;
	}

	/**
	 * Mark this tab as leaving for GitHub, so the return lands back in the sequence.
	 *
	 * The mark goes down before the sign-in is begun, because beginning it navigates: there is no
	 * moment after that call in which this page is still the one on screen.
	 */
	leavingForGitHub(): void {
		try {
			sessionStorage.setItem(RESUMING_KEY, 'yes');
		} catch {
			// A browser that will not keep this will not keep the sign-in's `state` either, and
			// `beginGitHubSignIn` refuses the trip over that rather than over this.
		}
	}

	/**
	 * Take the mark back up, for a sign-in that was refused before the redirect.
	 *
	 * The page is not going anywhere, so a mark left behind would reopen the sequence on some
	 * unrelated reload later in the session.
	 */
	notLeavingAfterAll(): void {
		try {
			sessionStorage.removeItem(RESUMING_KEY);
		} catch {
			// Nothing was kept, so there is nothing left behind to take back up.
		}
	}
}

export const connectSequence = new ConnectSequence();
