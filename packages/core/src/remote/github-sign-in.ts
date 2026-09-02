// The GitHub App sign-in: the redirect out, the `state` check on the way back, and the code-for-
// token exchange through the broker (ADR-0031).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE SECOND ACQUISITION PATH, BEHIND THE SAME INTERFACE
//
// A push credential lives behind {@link CredentialStore}: a token can be put in, taken out, and
// thrown away. A pasted fine-grained token was the first way to get one; this is the second, and
// **below that interface the two are indistinguishable** — the send engine is handed an opaque
// bearer string and never learns which door it came through. Nothing here or anywhere beneath the UI
// branches on which of the two it holds, which is ADR-0031's consequence written as a rule.
//
// What this module adds on top of the string is the part a pasted token does not have: an **expiry**
// and a **refresh token**. A GitHub App's user-to-server token lasts eight hours, so the record below
// travels beside the credential rather than inside it, and `read()` on the credential store goes on
// answering a plain string.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A SERVER AT ALL, AND WHY IT IS ONLY THIS
//
// `github.com/login/oauth/access_token` sends no CORS headers, so a browser cannot exchange a code
// for a token itself. `api.github.com` answers `access-control-allow-origin: *`, so every other
// other request goes browser-to-GitHub directly. The broker is that one asymmetry and nothing
// else: **no repository data ever passes through it** (ADR-0031, which is named for this).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NO PKCE, DELIBERATELY
//
// GitHub's OAuth does not support PKCE — a `code_challenge` is ignored, so adding one would buy
// nothing and read to a future maintainer as protection that is present. What actually protects this
// flow is three things: the `state` below, the redirect-URI allowlist on the App itself, and the
// broker's own `Origin` allowlist stored beside the secret. Do not add a fourth that does not run.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { CredentialStorage } from './credential-store.js';
import type { GitHubApp } from './github-app.js';

/**
 * Where a user is sent to authorise, on GitHub's own screen.
 *
 * ⚠ Named here rather than in `github-app.ts`: this is GitHub's address, the same for every
 * deployment on earth, and it is not the thing a fork repoints. What a fork repoints is the broker,
 * the client ID and the App's slug, and `scripts/check-github-broker.mjs` fences those three alone.
 */
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';

/**
 * Where every GitHub App lives, publicly, under its own slug.
 *
 * ⚠ Named here for the same reason {@link GITHUB_AUTHORIZE_URL} is: this is GitHub's address, the
 * same for every deployment on earth. What a fork repoints is the slug that goes after it, which is
 * `GITHUB_APP`'s, and `scripts/check-github-broker.mjs` fences `github.com/apps/<slug>` — the two
 * together — rather than either half.
 */
export const GITHUB_APPS_URL = 'https://github.com/apps';

/** Where the `state` waits while the user is away on GitHub. Session-scoped, like the credential. */
export const SIGN_IN_STATE_KEY = 'ballastella.github-sign-in-state';

/** Where the expiry and the refresh token live, beside the credential rather than inside it. */
export const GITHUB_APP_SESSION_KEY = 'ballastella.github-app-session';

/** Where the renewable half of a sign-in waits when the author has asked for it past the tab. */
export const REMEMBERED_GRANT_KEY = 'ballastella.github-app-remembered';

/** What GitHub sends back to the callback: a code, or a refusal, and the `state` either way. */
export type SignInCallback = {
	readonly code: string;
	readonly state: string;
	/**
	 * GitHub's own refusal, or `''`. `access_denied` is what pressing **Cancel** on the authorise
	 * screen produces, and it arrives with the real `state` beside it.
	 */
	readonly error: string;
	/** GitHub's sentence about that refusal, or `''`. */
	readonly errorDescription: string;
};

/** A token the broker handed back, with everything needed to know when it stops working. */
export type GitHubTokenGrant = {
	/** The opaque bearer string. The only part anything below the UI ever sees. */
	readonly token: string;
	/** Unix milliseconds, or `null` for a token that does not expire (a classic OAuth App's). */
	readonly expiresAt: number | null;
	/** `''` when the App does not issue them, which makes a refresh impossible rather than failed. */
	readonly refreshToken: string;
};

/** Why a sign-in did not happen, in the words the user should see. */
export class GitHubSignInError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GitHubSignInError';
	}
}

/**
 * A callback that was not this tab's: a `state` that does not match, or none at all.
 *
 * Its own type because the caller does more than show the sentence — a callback this tab really did
 * ask for may put the tab back where the scholar left it, and one it did not must not be able to
 * steer it anywhere. Every other refusal, including GitHub's own and a broker that is down, is an
 * ordinary {@link GitHubSignInError}.
 */
export class GitHubCallbackRefusedError extends GitHubSignInError {
	constructor(message: string) {
		super(message);
		this.name = 'GitHubCallbackRefusedError';
	}
}

/**
 * A fresh, unguessable `state`.
 *
 * `crypto.getRandomValues` rather than `Math.random`: this is the whole of the cross-site request
 * forgery protection on a flow that has no PKCE, so it has to be unpredictable rather than merely
 * unique.
 */
export function newSignInState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Where to send the user to authorise, for this App and this callback address. */
export function authorizeUrl(options: {
	readonly app: GitHubApp;
	readonly redirectUri: string;
	readonly state: string;
}): string {
	const parameters = new URLSearchParams({
		client_id: options.app.clientId,
		redirect_uri: options.redirectUri,
		state: options.state
	});
	return `${GITHUB_AUTHORIZE_URL}?${parameters}`;
}

/**
 * Where a first-time author is sent: the App's own install screen, carrying the `state`.
 *
 * ⚠ **This installs *and* signs in, in one trip.** The App registration has **Request user
 * authorization (OAuth) during installation** enabled, so GitHub returns to the callback URL
 * registered on the App with `code` and `state` — the same return leg {@link readSignInCallback}
 * and {@link verifySignInState} already read. There is no `redirect_uri` to send: the install screen
 * has no such parameter, and the App's registered callback is the one address it will come back to.
 *
 * ⚠ **No Setup URL is registered and `setup_action` is never read.** It is undocumented across the
 * whole of GitHub's documentation, so nothing here may be built on it.
 */
export function installUrl(options: { readonly app: GitHubApp; readonly state: string }): string {
	const parameters = new URLSearchParams({ state: options.state });
	const slug = encodeURIComponent(options.app.appSlug);
	return `${GITHUB_APPS_URL}/${slug}/installations/new?${parameters}`;
}

/**
 * Where an author widens a narrow Installation so that it reaches one more repository.
 *
 * ⚠ **The App's own grant screen, never GitHub's list of installed Apps.** That page holds every App
 * the author has ever installed, and from it the grant is five moves away — spot
 * Ballastella, press Configure, find *Repository access*, find the repository, save — and it is the
 * hand-off this replaced. `suggested_target_id` is the *account's* identifier, so GitHub opens on the
 * Installation that has to change rather than asking which one.
 *
 * ⚠ **The endpoint that would do this without leaving is documented not to work.**
 * `PUT /user/installations/{id}/repositories/{id}` is for classic personal access tokens, and
 * ADR-0040 refuses `Administration: write`, so GitHub's own screen is the whole of the mechanism.
 */
export function grantAccessUrl(options: {
	readonly app: GitHubApp;
	/** `target_id` of the account the Installation is on — not the installation's own id. */
	readonly targetId: number;
	/**
	 * The repository to arrive preselected, where an id for it is in hand.
	 *
	 * ⚠ **Usually it is not, and that is not an oversight.** The repository this link is about is by
	 * definition outside the grant, and GitHub reports nothing at all — id included — about a
	 * repository an Installation does not reach. So the caller in the editor passes none and the
	 * author picks the repository on GitHub's screen; the parameter is here for a caller that reads a
	 * repository by some other route and can spare them that.
	 */
	readonly repositoryId?: number;
}): string {
	const slug = encodeURIComponent(options.app.appSlug);
	const parameters = new URLSearchParams({ suggested_target_id: String(options.targetId) });
	if (options.repositoryId !== undefined) {
		parameters.append('repository_ids[]', String(options.repositoryId));
	}
	return `${GITHUB_APPS_URL}/${slug}/installations/new/permissions?${parameters}`;
}

/**
 * The one address a departing sign-in goes to, given what is already true.
 *
 * An author with no Installation gets {@link installUrl}, because an authorize-only trip leaves them
 * holding a credential against no Installation and a list of no repositories — which reads to them
 * as having no repositories rather than as a step nobody named. An author who already installed the
 * App and wants only a fresh credential gets {@link authorizeUrl}, which is what that is for.
 *
 * Both mint and verify `state` the same way, and both come back through the same callback.
 */
export function signInDepartureUrl(options: {
	readonly app: GitHubApp;
	readonly redirectUri: string;
	readonly state: string;
	/** Whether an Installation is already known to exist, so only a credential is wanted. */
	readonly installed: boolean;
}): string {
	return options.installed ? authorizeUrl(options) : installUrl(options);
}

/**
 * The callback's parameters, or `null` when this is an ordinary page load.
 *
 * ⚠ **Both, or neither.** A `?code=` with no `?state=` is not a half-arrival to be tolerated — it is
 * the shape a forged callback has, because an attacker who could mint a `state` would not need to
 * omit it. {@link verifySignInState} refuses it; this reads it so that it *can* be refused rather
 * than ignored as noise.
 */
export function readSignInCallback(parameters: URLSearchParams): SignInCallback | null {
	const code = parameters.get('code');
	const state = parameters.get('state');
	// ⚠ **`error` is a callback too.** A scholar who presses Cancel on GitHub's screen is sent back
	// with `error=access_denied` and the real `state`, and no `code` at all. Read as a code-and-state
	// pair alone that is an empty code with a state that verifies — so the empty string went to the
	// broker and the person who chose not to authorise was told their code was "incorrect or expired".
	const error = parameters.get('error');
	const description = parameters.get('error_description');
	if (code === null && state === null && error === null) return null;
	return {
		code: code ?? '',
		state: state ?? '',
		error: error ?? '',
		errorDescription: description ?? ''
	};
}

/**
 * Why this callback cannot be exchanged at all, or `''` when it can — **read after the `state`**.
 *
 * The `state` is judged first because it is the only question about whether this reply is ours;
 * everything here is about what the reply *says*, and a forged one may say anything.
 */
export function describeCallbackRefusal(callback: SignInCallback): string {
	if (callback.error === 'access_denied') {
		return (
			`GitHub was not given permission, so nothing has been signed in to. That is what pressing ` +
			`Cancel on GitHub's screen does, and it is a complete answer — nothing is wrong with your ` +
			`account and nothing on this computer has changed. Press “Sign in with GitHub” if you meant ` +
			`to authorise it, or paste a personal access token instead.`
		);
	}
	if (callback.error !== '') {
		const detail = callback.errorDescription || callback.error;
		return (
			`GitHub would not authorise this application, so nothing has been signed in to: ${detail}. ` +
			`Nothing on this computer has changed, and you can send by pasting a personal access ` +
			`token instead.`
		);
	}
	if (callback.code === '') {
		return (
			`The reply from GitHub carried no authorisation in it, so nothing has been signed in to and ` +
			`nothing on this computer has changed. Press “Sign in with GitHub” to start again.`
		);
	}
	return '';
}

/**
 * Whether the callback is the one this tab asked for: `''` when it is, else why it is refused.
 *
 * ⚠ **A mismatch or an absence is a refusal, never a retry.** Sending the user back round the
 * redirect would be the one response that turns a forged callback into a working attack — the second
 * attempt carries a `state` this tab did generate. So the code is dropped on the floor and the user
 * is asked to start the sign-in themselves.
 */
export function verifySignInState(returned: string, stored: string | null): string {
	if (stored === null || stored === '') {
		return (
			`This tab did not start a GitHub sign-in, so the reply from GitHub has been ignored and ` +
			`nothing has been signed in to. That happens when the sign-in was begun in another tab, or ` +
			`when the tab was reloaded while you were away on GitHub. Press “Sign in with GitHub” here ` +
			`to start one this tab can finish.`
		);
	}
	if (returned === '' || returned !== stored) {
		return (
			`The reply from GitHub did not match the sign-in this tab started, so it has been refused ` +
			`and nothing has been signed in to. Nothing is wrong with your account. Press “Sign in with ` +
			`GitHub” to start again.`
		);
	}
	return '';
}

/** GitHub's token response, which the broker passes back verbatim (ADR-0031). */
type TokenResponse = {
	access_token?: unknown;
	expires_in?: unknown;
	refresh_token?: unknown;
	error?: unknown;
	error_description?: unknown;
};

const request = (fetchFn: FetchFn | undefined): FetchFn =>
	fetchFn ?? ((input, init) => fetch(input, init));

/**
 * Turn the broker's answer into a grant, or throw the sentence the user should see.
 *
 * @param now injected so a test can assert an expiry without waiting eight hours
 */
async function readGrant(response: Response, now: number): Promise<GitHubTokenGrant> {
	let body: TokenResponse;
	try {
		body = (await response.json()) as TokenResponse;
	} catch {
		throw new GitHubSignInError(unexpectedAnswer(response.status));
	}

	// ⚠ GitHub reports a refused exchange **in the body**, and historically with a 200. So the error
	// field is read before the status: a check on `response.ok` alone would treat "this code has
	// already been used" as a success and then fail on an absent `access_token` with no reason to show.
	if (typeof body.error === 'string' && body.error !== '') {
		const detail = typeof body.error_description === 'string' ? body.error_description : body.error;
		throw new GitHubSignInError(refusedExchange(detail));
	}
	if (!response.ok) throw new GitHubSignInError(unexpectedAnswer(response.status));
	if (typeof body.access_token !== 'string' || body.access_token === '') {
		throw new GitHubSignInError(unexpectedAnswer(response.status));
	}

	const seconds = typeof body.expires_in === 'number' ? body.expires_in : null;
	return {
		token: body.access_token,
		expiresAt: seconds === null ? null : now + seconds * 1000,
		refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : ''
	};
}

/** `fetch` rejected: the broker is down, unreachable, or was never deployed (see `github-app.ts`). */
const brokerUnreachable = (cause: unknown): GitHubSignInError =>
	new GitHubSignInError(
		`The GitHub sign-in service could not be reached, so nothing has been signed in to. The ` +
			`browser reported: ${cause instanceof Error ? cause.message : String(cause)}. Everything you ` +
			`have is still saved on this computer, and you can send by pasting a personal access ` +
			`token instead — that path needs no service at all.`
	);

const post = async (
	url: string,
	body: unknown,
	fetchFn: FetchFn | undefined
): Promise<Response> => {
	try {
		return await request(fetchFn)(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body)
		});
	} catch (cause) {
		throw brokerUnreachable(cause);
	}
};

/**
 * Exchange an authorisation code for a token, through the broker.
 *
 * The one server-side step in this whole epic. `redirect_uri` is sent because GitHub requires the
 * exchange to name the same address the authorisation did.
 *
 * @throws GitHubSignInError when the broker is unreachable or the exchange is refused
 */
export async function exchangeAuthorizationCode(options: {
	readonly app: GitHubApp;
	readonly code: string;
	readonly redirectUri: string;
	readonly fetch?: FetchFn;
	readonly now?: number;
}): Promise<GitHubTokenGrant> {
	const response = await post(
		`${options.app.brokerOrigin}/github/token`,
		{ client_id: options.app.clientId, code: options.code, redirect_uri: options.redirectUri },
		options.fetch
	);
	return readGrant(response, options.now ?? Date.now());
}

/**
 * Trade a refresh token for a new one, through the broker's second endpoint.
 *
 * Refresh needs the client secret, which is why this cannot be done from the browser either.
 *
 * @throws GitHubSignInError when the broker is unreachable or the refresh is refused
 */
export async function refreshGitHubToken(options: {
	readonly app: GitHubApp;
	readonly refreshToken: string;
	readonly fetch?: FetchFn;
	readonly now?: number;
}): Promise<GitHubTokenGrant> {
	const response = await post(
		`${options.app.brokerOrigin}/github/refresh`,
		{ client_id: options.app.clientId, refresh_token: options.refreshToken },
		options.fetch
	);
	return readGrant(response, options.now ?? Date.now());
}

// ── The grant, kept beside the credential ─────────────────────────────────────────────────────

/**
 * How much of the eight hours has to be left for a send to be allowed to start.
 *
 * ⚠ **The whole point of a margin is that expiry is refused *before* an upload, never during one.**
 * A first send of a large Map Image is thousands of requests and can run for many minutes,
 * and a token that dies partway leaves loose blobs in no tree and a ref that never moved. One minute
 * is not enough to cover a long send, so this is not a guarantee that the token outlives the
 * upload — it is what stops a send being started with a credential already at its end. The
 * refresh below is what keeps the token far from its expiry in the ordinary case.
 */
export const CREDENTIAL_FRESHNESS_MARGIN_MS = 60_000;

/** Whether this grant is too near its end to start work with. Grants that never expire are fresh. */
export const isGrantFresh = (grant: GitHubTokenGrant, now: number): boolean =>
	grant.expiresAt === null || grant.expiresAt - now > CREDENTIAL_FRESHNESS_MARGIN_MS;

/**
 * The record kept beside the credential, so an expiry survives a reload.
 *
 * ⚠ **It holds a refresh token, which is a secret**, so it lives wherever the credential lives and
 * nowhere else — never in the Workspace, which is what a Backup packs and a send uploads, and
 * never in `localStorage`, which holds the write-ahead journal (ADR-0033).
 */
export function readGrantRecord(storage: CredentialStorage): GitHubTokenGrant | null {
	let raw: string | null;
	try {
		raw = storage.getItem(GITHUB_APP_SESSION_KEY);
	} catch {
		return null;
	}
	if (raw === null || raw === '') return null;
	try {
		const record = JSON.parse(raw) as Partial<GitHubTokenGrant>;
		if (typeof record.token !== 'string' || record.token === '') return null;
		return {
			token: record.token,
			expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null,
			refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : ''
		};
	} catch {
		// A record that will not parse is one nobody can act on, and treating it as *no App session*
		// degrades to the pasted-token path rather than to a broken screen.
		return null;
	}
}

export function writeGrantRecord(storage: CredentialStorage, grant: GitHubTokenGrant): void {
	try {
		storage.setItem(GITHUB_APP_SESSION_KEY, JSON.stringify(grant));
	} catch {
		// As with the credential itself: a record that could not be kept costs a sign-in, not the tab.
	}
}

export function clearGrantRecord(storage: CredentialStorage): void {
	try {
		storage.removeItem(GITHUB_APP_SESSION_KEY);
	} catch {
		// Best effort, as above.
	}
}

// ── The half of a grant that may be kept past the tab (ADR-0041) ──────────────────────────────

/**
 * What survives a tab close when the author has asked this machine to keep their sign-in.
 *
 * ⚠ **The access token is not in it, and cannot be added to it.** Eight hours of push rights at
 * rest is the thing this feature must not create; a refresh token at rest still has to be exchanged
 * through the broker, which leaves the broker's `Origin` allowlist in the path. {@link
 * writeRememberedGrant} takes a whole grant and writes these two fields, so the stripping is one
 * function rather than a rule each caller has to remember.
 */
export type RememberedGrant = {
	/** The renewable half. `''` never gets here — see {@link writeRememberedGrant}. */
	readonly refreshToken: string;
	/** When the access token this was issued beside ran out, or `null` for one that never did. */
	readonly expiresAt: number | null;
};

/** The remembered half of a sign-in, or `null` when this machine has kept none. */
export function readRememberedGrant(storage: CredentialStorage): RememberedGrant | null {
	let raw: string | null;
	try {
		raw = storage.getItem(REMEMBERED_GRANT_KEY);
	} catch {
		return null;
	}
	if (raw === null || raw === '') return null;
	try {
		const record = JSON.parse(raw) as Partial<RememberedGrant>;
		if (typeof record.refreshToken !== 'string' || record.refreshToken === '') return null;
		return {
			refreshToken: record.refreshToken,
			expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : null
		};
	} catch {
		// As with the session record: one that will not parse is one nobody can act on, and reading it
		// as *nothing remembered* costs a sign-in rather than a broken screen.
		return null;
	}
}

/**
 * Keep the renewable half of this grant, and only that half.
 *
 * A grant with no refresh token has no renewable half, so nothing is kept and anything kept before
 * is taken away — a record describing a sign-in that cannot be renewed would be spent once on the
 * next visit, fail, and report an expiry to somebody who never asked for one.
 */
export function writeRememberedGrant(storage: CredentialStorage, grant: GitHubTokenGrant): void {
	if (grant.refreshToken === '') {
		clearRememberedGrant(storage);
		return;
	}
	const remembered: RememberedGrant = {
		refreshToken: grant.refreshToken,
		expiresAt: grant.expiresAt
	};
	try {
		storage.setItem(REMEMBERED_GRANT_KEY, JSON.stringify(remembered));
	} catch {
		// A sign-in that could not be kept costs the next visit a sign-in, not this tab.
	}
}

export function clearRememberedGrant(storage: CredentialStorage): void {
	try {
		storage.removeItem(REMEMBERED_GRANT_KEY);
	} catch {
		// Best effort, as above.
	}
}

/** What a scholar is told when the token has run out and could not be renewed. */
export function signInAgainMessage(): string {
	return (
		`Your GitHub sign-in has expired, so nothing has been sent. A sign-in from GitHub lasts ` +
		`eight hours and this one has run out — renewing it was tried and did not work. Press “Sign in ` +
		`with GitHub” to sign in again, then Sync. Nothing on this computer or on GitHub has been ` +
		`changed, and your work is exactly where you left it.`
	);
}

function refusedExchange(detail: string): string {
	return (
		`GitHub refused the sign-in, so nothing has been signed in to: ${detail}. Starting again ` +
		`usually settles it — a reply from GitHub can only be used once, so going back to a page you ` +
		`had open meets this every time.`
	);
}

function unexpectedAnswer(status: number): string {
	return (
		`The GitHub sign-in service gave an answer this application did not understand (HTTP ` +
		`${status}), so nothing has been signed in to. You can send by pasting a personal access ` +
		`token instead, which needs no service at all.`
	);
}
