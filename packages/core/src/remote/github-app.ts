// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE GITHUB APP AND ITS BROKER. This module is deployment configuration (ADR-0031).         │
// │                                                                                            │
// │ Two values, neither of them a secret: the address of the broker that exchanges an           │
// │ authorisation code for a token, and the client identifier of the GitHub App the code is     │
// │ issued against. A client ID is public by design — it travels in the authorize URL, in the   │
// │ browser's address bar, in front of the user. The **client secret** is the broker's, lives   │
// │ only there, and is looked up by client ID.                                                  │
// │                                                                                            │
// │ So: change this file, and nothing else. No other module may name either value.             │
// │                                                                                            │
// │ `scripts/check-github-broker.mjs` fails `pnpm lint` on any module outside this one that     │
// │ names the broker's host or the client ID, which is what makes that a property rather than   │
// │ a hope. It scans for **the values**, not for the words "broker" or "GitHub App":            │
// │ `github-sign-in.ts` and `docs/hosting.md` describe this mechanism at length, and a fence    │
// │ that failed on documentation would offer "delete the paragraph" as its remedy (ADR-0029's   │
// │ recorded lesson, applied here before the fact).                                             │
// │                                                                                            │
// │ ═══════════════════════════════════════════════════════════════════════════════════════    │
// │ ⚠ **NEITHER VALUE BELOW IS DEPLOYED. BOTH ARE PLACEHOLDERS.**                              │
// │                                                                                            │
// │ No broker has been written or deployed, and no GitHub App has been registered. The host     │
// │ below is on `example.org`, which RFC 2606 reserves so that it can never be registered by    │
// │ anybody — so it will never answer, and it can never *begin* to answer to a stranger who     │
// │ bought the name. A real-looking address on a buyable domain was declined for exactly that   │
// │ reason: the failure mode is not "sign-in breaks", it is "sign-in silently starts working,   │
// │ to somebody else's server". The client ID is self-evidently not one of GitHub's.            │
// │                                                                                            │
// │ **This is a supported state, not a broken one.** With the broker unreachable the sign-in    │
// │ button is offered and fails legibly, and the pasted personal access token binds and         │
// │ publishes exactly as it always has. That is what licenses shipping a placeholder at all, so │
// │ it is asserted in two places rather than assumed: `editor-github-signin.e2e.ts` presses the │
// │ button with this host unreachable and then binds by paste on the same screen, and           │
// │ `github-sign-in.test.ts` publishes a Workspace with a pasted token while every request to   │
// │ this host fails, and asserts the broker was never on the path.                              │
// │                                                                                            │
// │ ⚠ **A GitHub App's callback URL is registered per App.** The App holds the one address      │
// │ GitHub will redirect back to, so a fork living at a different address cannot borrow another │
// │ deployment's App — it needs its **own** App, its **own** client ID, and a broker holding    │
// │ that App's secret. Until a fork replaces both values below, **the pasted token is the       │
// │ whole of that fork's auth**, and everything except the nicer front door works unchanged     │
// │ (SPEC stories 56, 57, 58). Replacing them is one edit to this file and no infrastructure    │
// │ knowledge; `docs/hosting.md` Part 1 §6 is the longer version of this paragraph.             │
// └───────────────────────────────────────────────────────────────────────────────────────────┘

/** Where the code-for-token exchange happens, and the App the code is issued against. */
export type GitHubApp = {
	/**
	 * The broker's origin, with no trailing slash — `https://…`. The two endpoints ADR-0031 names
	 * are `/github/token` and `/github/refresh` beneath it.
	 */
	readonly brokerOrigin: string;
	/** The GitHub App's client identifier. Public: it is in the authorize URL the user can read. */
	readonly clientId: string;
};

/**
 * This deployment's App. **Both values are placeholders** — see the header.
 *
 * ⚠ **Replace both, or neither.** A broker with no client ID has nothing to look a secret up by,
 * and a client ID with no broker has nowhere to exchange a code, so a half-replaced pair offers a
 * sign-in that cannot complete. {@link isGitHubAppConfigured} demands both.
 */
export const GITHUB_APP: GitHubApp = {
	// `example.org` is reserved by RFC 2606 and can never be registered. Deliberate: see the header.
	brokerOrigin: 'https://github-broker.example.org',
	clientId: 'Iv1.not-a-real-client-id'
};

/**
 * Whether this deployment has an App at all.
 *
 * The one question the UI asks before offering to sign in with GitHub. A fork that empties both
 * values gets the token-paste path alone, with no dead button on the screen — which is the state
 * a fork with no infrastructure should be in until it registers an App of its own.
 */
export const isGitHubAppConfigured = (app: GitHubApp): boolean =>
	app.brokerOrigin.trim() !== '' && app.clientId.trim() !== '';
