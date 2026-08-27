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
// │ The values below are this deployment's, and they answer: the broker is an AWS Lambda        │
// │ behind a shared load balancer, and the App is registered on the `artshumrc` organisation    │
// │ with its callback URL set to `https://artshumrc.github.io/ballastella/`. The broker's       │
// │ source and its deployment live in a separate repository (`infrastructure/github_broker`).   │
// │                                                                                            │
// │ **The pasted personal access token remains the path that needs none of this**, and it is    │
// │ asserted rather than assumed: `github-sign-in.test.ts` publishes a Workspace with a pasted  │
// │ token while every request to the broker fails, and asserts the broker was never on the      │
// │ path. `editor-github-signin.e2e.ts` reaches that path in a browser with the broker          │
// │ unreachable and binds by it. Both route the hosts named here rather than reaching them, so  │
// │ no test touches the real broker.                                                            │
// │                                                                                            │
// │ ⚠ **It is not, however, always on screen.** The values below decide which door the editor   │
// │ offers, through {@link isGitHubAppConfigured}: where an App is configured a scholar is      │
// │ never shown a token field, because being asked to choose between two credentials is the     │
// │ failure the guided sequence exists to remove — the paste is reachable only through a        │
// │ disclosure in Workspace settings, closed, for an instructor whose App installation has      │
// │ broken. Where **no** App is configured the paste is the sequence's first step and the plain │
// │ content of that dialog. Gated, in one place, and nothing here is deleted.                   │
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
 * This deployment's App.
 *
 * ⚠ **Replace both, or neither.** A broker with no client ID has nothing to look a secret up by,
 * and a client ID with no broker has nowhere to exchange a code, so a half-replaced pair offers a
 * sign-in that cannot complete. {@link isGitHubAppConfigured} demands both.
 */
export const GITHUB_APP: GitHubApp = {
	brokerOrigin: 'https://github-broker.darthcrimson.org',
	clientId: 'Iv23liRxexPEW2AKFG12'
};

/**
 * Whether this deployment has an App at all.
 *
 * The one question the UI asks before offering to sign in with GitHub, and — inverted — before
 * offering a token field at all. A fork that empties both values gets the token-paste path alone,
 * with no dead button on the screen; a deployment that fills them in gets the sign-in alone, with no
 * second credential on the screen beside it. One predicate, so configuring an App stays a single
 * edit to this file and the two doors can never both be open.
 *
 * The editor reads it once, as `WorkspaceStorage.signInWithGitHubOffered`. Nothing else may compute
 * a second answer to the same question.
 */
export const isGitHubAppConfigured = (app: GitHubApp): boolean =>
	app.brokerOrigin.trim() !== '' && app.clientId.trim() !== '';
