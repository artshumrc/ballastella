// Where a push credential is held, behind an interface (ADR-0031, ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// OUTSIDE THE STORE, AND NEVER REACHABLE THROUGH IT
//
// `export-workspace-tar.ts` walks the `ProjectStore` and puts everything it finds in one file the
// user downloads and mails to a colleague; the write-ahead journal copies edits into
// `localStorage`; a Publish uploads the Workspace to a public repository. A token kept anywhere in
// the Workspace therefore leaves the machine three ways, and two of them look like a favour. So the
// credential lives here, in a place none of those three walk.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// `sessionStorage` IS THE FIRST IMPLEMENTATION, NOT THE CONTRACT
//
// It happens to give the two properties asked for — forgotten when the tab closes, kept across a
// reload — and a durable "remember me" may replace it later. Nothing above this interface may assume
// session scope: {@link CredentialStore} says only that a token can be put in, taken out, and thrown
// away. The broker-exchanged token of a GitHub App sign-in is the same string through the same three
// methods, which is what keeps the auth flow out of the publish engine.

/** Where the credential is kept in whatever web storage the implementation uses. */
export const CREDENTIAL_KEY = 'ballastella.github-credential';

/** Somewhere a push credential can be kept for as long as it is kept. */
export interface CredentialStore {
	/** The credential being held, or `null`. */
	read(): string | null;
	write(token: string): void;
	/** Sign out. Idempotent. */
	clear(): void;
}

/** The subset of `Storage` this needs, so a test can hand it a `Map` rather than a browser. */
export interface CredentialStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/**
 * A credential store over one web-storage object.
 *
 * Every operation is wrapped, because Safari with cookies blocked has the object and throws from
 * every property of it. A storage that will not answer degrades to *no credential held*, which is a
 * sign-in prompt rather than a broken app.
 */
export function webCredentialStore(storage: CredentialStorage): CredentialStore {
	return {
		read() {
			try {
				return storage.getItem(CREDENTIAL_KEY) || null;
			} catch {
				return null;
			}
		},
		write(token) {
			try {
				storage.setItem(CREDENTIAL_KEY, token);
			} catch {
				// A credential that could not be kept is one the user will be asked for again. Refusing
				// the whole bind over it would be worse: the token still works for this page.
			}
		},
		clear() {
			try {
				storage.removeItem(CREDENTIAL_KEY);
			} catch {
				// Best effort, as above.
			}
		}
	};
}

/** A credential store holding nothing but a variable, for a browser that will not give us storage. */
export function memoryCredentialStore(): CredentialStore {
	let held: string | null = null;
	return {
		read: () => held,
		write: (token) => {
			held = token;
		},
		clear: () => {
			held = null;
		}
	};
}

/**
 * `sessionStorage` where this browser has a usable one, and memory where it does not.
 *
 * ⚠ **The probe is a read.** ADR-0010 is that merely opening a Project modifies nothing, and
 * `editor-opening-view.e2e.ts` counts web-storage *writes* on load — `browserJournalStorage` was
 * written the same way for the same reason. Whether a particular payload will fit is a quota
 * question that cannot be answered in advance, and `write` above already survives the answer.
 *
 * Memory rather than `null`: unlike the write-ahead journal there is nothing here to warn a user
 * about. A credential that does not survive a reload is a sign-in they do again, and refusing to
 * hold one at all would refuse publishing outright on a browser where it would otherwise work.
 */
export function browserCredentialStore(): CredentialStore {
	try {
		if (typeof sessionStorage === 'undefined') return memoryCredentialStore();
		void sessionStorage.length;
		return webCredentialStore(sessionStorage);
	} catch {
		return memoryCredentialStore();
	}
}

/**
 * A credential store that reads and writes nothing while a Review Workspace is open.
 *
 * ⚠ **A wrapper rather than a check at each call site.** A teacher opening a submission must not be
 * able to reach their own push credential from inside it — that is the second half of ADR-0024's
 * containment, and the half a component cannot enforce, because the sealing has to hold for code
 * written later that never saw the rule. Sealed, this answers `null` to every read, so every screen
 * above it renders the not-signed-in state without knowing why.
 *
 * The credential itself is left where it is. Leaving the review copy unseals it again, which is what
 * makes "put the submission down and go back to your own work" cost nothing.
 */
export function closedWhileReviewing(
	reviewing: () => boolean,
	inner: CredentialStore
): CredentialStore {
	return {
		read: () => (reviewing() ? null : inner.read()),
		write: (token) => {
			if (!reviewing()) inner.write(token);
		},
		clear: () => {
			if (!reviewing()) inner.clear();
		}
	};
}

/**
 * The shortest a credential can be and still be one.
 *
 * A fine-grained personal access token is `github_pat_` and 82 characters; a classic one is `ghp_`
 * and 40. This is well under both, because the number's job is to catch a paste that went wrong —
 * an empty clipboard, half a token, a repository name — rather than to predict GitHub's next prefix.
 */
const MIN_CREDENTIAL_LENGTH = 20;

/**
 * Why a pasted credential is not one, in the words the user should see, or `''` when it looks like
 * one.
 *
 * ⚠ **The prefix is deliberately not checked.** `github_pat_`, `ghp_`, `gho_` and `ghu_` are all
 * real, a broker-exchanged token arrives by another route, and a fence on a list of prefixes
 * refuses tomorrow's valid token with a message saying it is malformed — the one refusal a user
 * cannot act on. What is checked is the shape every one of them has: a run of token characters,
 * long enough to be a secret. Whether GitHub *accepts* it is a question only GitHub can answer, and
 * binding asks it immediately.
 */
export function describeTokenProblem(pasted: string): string {
	const token = pasted.trim();
	if (token === '') {
		return (
			`Paste the token GitHub showed you when you created it. It is shown once, on the page that ` +
			`made it, and cannot be read back afterwards — if it has gone, make another one.`
		);
	}
	if (/\s/.test(token)) {
		return (
			`That does not look like a token: it has a space or a line break in it. A GitHub token is ` +
			`one unbroken run of letters, digits and underscores, so something else was copied along ` +
			`with it.`
		);
	}
	if (!/^[A-Za-z0-9_]+$/.test(token)) {
		return (
			// ⚠ Says nothing about *which* field the address belongs in. This sentence is shown on two
			// screens — binding, which has a repository field, and signing in again, which has not —
			// and a message naming a field that is not there is a message that sends somebody looking.
			`That does not look like a token. A GitHub token is made only of letters, digits and ` +
			`underscores, so a repository address or a URL is a different thing.`
		);
	}
	if (token.length < MIN_CREDENTIAL_LENGTH) {
		return (
			`That is too short to be a GitHub token — they are forty characters or more. Only part of ` +
			`it was copied; select the whole of it and paste again.`
		);
	}
	return '';
}
