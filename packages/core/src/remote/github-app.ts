// ┌───────────────────────────────────────────────────────────────────────────────────────────┐
// │ THE GITHUB APP AND ITS BROKER. This module is deployment configuration (ADR-0031).         │
// │                                                                                            │
// │ Three values, none of them a secret: the address of the broker that exchanges an            │
// │ authorisation code for a token, the client identifier of the GitHub App the code is issued  │
// │ against, and the App's public slug, which is the address of its own install screen. A       │
// │ client ID is public by design — it travels in the authorize URL, in the browser's address   │
// │ bar, in front of the user, and a slug is the public link GitHub prints on the App's         │
// │ settings page. The **client secret** is the broker's, lives only there, and is looked up by │
// │ client ID.                                                                                  │
// │                                                                                            │
// │ So: change this file, and nothing else. No other module may name any of the three.         │
// │                                                                                            │
// │ `scripts/check-github-broker.mjs` fails `pnpm lint` on any module outside this one that     │
// │ names the broker's host, the client ID, or the App's own address, which is what makes that  │
// │ a property rather than a hope. It scans for **the values**, not for the words "broker" or   │
// │ "GitHub App": `github-sign-in.ts` and `docs/hosting.md` describe this mechanism at length,  │
// │ and a fence that failed on documentation would offer "delete the paragraph" as its remedy   │
// │ (ADR-0029's recorded lesson, applied here before the fact). The slug is fenced as           │
// │ `github.com/apps/<slug>` rather than as a bare word for the same reason it is fenced at     │
// │ all: a deployment's App is very often named after the deployment, so a scan on the word     │
// │ alone would fail on this project's own package names and offer "rename the packages".       │
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
// │ ⚠ **It is not, however, always on screen.** The values below decide which door the          │
// │ editor offers, through {@link isGitHubAppConfigured}: where an App is configured a          │
// │ scholar is never shown a token field anywhere — not in the guided sequence, not in the      │
// │ publish dialog, and nowhere else outside a disclosure that stays closed                     │
// │ until an instructor whose App installation has broken asks for it. Being asked to           │
// │ choose between two credentials is the failure the sequence exists to remove. Where          │
// │ **no** App is configured the paste is the sequence's first step, the plain content of       │
// │ that dialog, and the plain content of the publish dialog — which is where a bound           │
// │ Workspace reopened in a fresh tab meets the question. Gated, in one place, and nothing      │
// │ here is deleted.                                                                            │
// │                                                                                            │
// │ ⚠ **A GitHub App's callback URL is registered per App.** The App holds the one address      │
// │ GitHub will redirect back to, so a fork living at a different address cannot borrow another │
// │ deployment's App — it needs its **own** App, its **own** client ID, and a broker holding    │
// │ that App's secret. Until a fork replaces all three values below, **the pasted token is the  │
// │ whole of that fork's auth**, and everything except the nicer front door works unchanged.    │
// │ Replacing them is one edit to this file and no infrastructure knowledge; `docs/hosting.md`  │
// │ Part 1 §6 is the longer version of this paragraph.                                          │
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
	/**
	 * The App's public slug, from **Public link** on its settings page.
	 *
	 * It is the App's own address on GitHub — `https://github.com/apps/<slug>` — and it is what the
	 * install screen a first-time author is sent to hangs off. It is *not* the App's display name:
	 * GitHub lowercases and hyphenates that to make the slug, and the two can differ.
	 */
	readonly appSlug: string;
};

/**
 * This deployment's App.
 *
 * ⚠ **Replace all three, or none.** A broker with no client ID has nothing to look a secret up by,
 * a client ID with no broker has nowhere to exchange a code, and a slug that is not the App's sends
 * a first-time author to an install screen for somebody else's App — so a half-replaced set offers a
 * sign-in that cannot complete. {@link isGitHubAppConfigured} demands all three.
 */
export const GITHUB_APP: GitHubApp = {
	brokerOrigin: 'https://github-broker.darthcrimson.org',
	clientId: 'Iv23liRxexPEW2AKFG12',
	appSlug: 'ballastella'
};

/**
 * Whether this deployment has an App at all.
 *
 * The one question the UI asks before offering to sign in with GitHub, and — inverted — before
 * offering a token field at all. A fork that empties the values gets the token-paste path alone,
 * with no dead button on the screen; a deployment that fills them in gets the sign-in alone, with no
 * second credential on the screen beside it. One predicate, so configuring an App stays a single
 * edit to this file and the two doors can never both be open.
 *
 * ⚠ **All three, or none.** A half-configured fork would offer a sign-in that departs to an install
 * screen that does not exist, or exchanges a code no broker holds a secret for.
 *
 * The editor reads it once, as `WorkspaceStorage.signInWithGitHubOffered`. Nothing else may compute
 * a second answer to the same question.
 */
export const isGitHubAppConfigured = (app: GitHubApp): boolean =>
	app.brokerOrigin.trim() !== '' && app.clientId.trim() !== '' && app.appSlug.trim() !== '';
