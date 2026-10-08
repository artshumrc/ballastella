import type { FetchFn } from '../injection/store-image-fetch.js';
import { messageOf, textField } from '../store/project-store.js';
import { type CredentialStorage, webCredentialStore } from './credential-store.js';
import type { GitHubApp } from './github-app.js';

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_APPS_URL = 'https://github.com/apps';
export const SIGN_IN_STATE_KEY = 'ballastella.github-sign-in-state';
export const GITHUB_APP_SESSION_KEY = 'ballastella.github-app-session';
export const REMEMBERED_GRANT_KEY = 'ballastella.github-app-remembered';

export type SignInCallback = {
	readonly code: string;
	readonly state: string;
	readonly error: string;
	readonly errorDescription: string;
};

export type GitHubTokenGrant = {
	readonly token: string;
	readonly expiresAt: number | null;
	readonly refreshToken: string;
};

export class GitHubSignInError extends Error {
	override readonly name: string = 'GitHubSignInError';
}

export class GitHubCallbackRefusedError extends GitHubSignInError {
	override readonly name = 'GitHubCallbackRefusedError';
}

export function newSignInState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

export function installUrl(options: { readonly app: GitHubApp; readonly state: string }): string {
	const parameters = new URLSearchParams({ state: options.state });
	const slug = encodeURIComponent(options.app.appSlug);
	return `${GITHUB_APPS_URL}/${slug}/installations/new?${parameters}`;
}

export function grantAccessUrl(options: {
	readonly app: GitHubApp;
	readonly targetId: number;
	readonly repositoryId?: number;
}): string {
	const slug = encodeURIComponent(options.app.appSlug);
	const parameters = new URLSearchParams({ suggested_target_id: String(options.targetId) });
	if (options.repositoryId !== undefined) {
		parameters.append('repository_ids[]', String(options.repositoryId));
	}
	return `${GITHUB_APPS_URL}/${slug}/installations/new/permissions?${parameters}`;
}

export function signInDepartureUrl(options: {
	readonly app: GitHubApp;
	readonly redirectUri: string;
	readonly state: string;
	readonly installed: boolean;
}): string {
	return options.installed ? authorizeUrl(options) : installUrl(options);
}

export function readSignInCallback(parameters: URLSearchParams): SignInCallback | null {
	const code = parameters.get('code');
	const state = parameters.get('state');
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

// A mismatch or absence is a refusal, never a retry: retrying would let a forged callback through.
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

type TokenResponse = {
	access_token?: unknown;
	expires_in?: unknown;
	refresh_token?: unknown;
	error?: unknown;
	error_description?: unknown;
};

async function readGrant(response: Response, now: number): Promise<GitHubTokenGrant> {
	let body: TokenResponse;
	try {
		body = (await response.json()) as TokenResponse;
	} catch {
		throw new GitHubSignInError(unexpectedAnswer(response.status));
	}

	if (typeof body.error === 'string' && body.error !== '') {
		const detail = typeof body.error_description === 'string' ? body.error_description : body.error;
		throw new GitHubSignInError(refusedExchange(detail));
	}
	if (!response.ok || typeof body.access_token !== 'string' || body.access_token === '') {
		throw new GitHubSignInError(unexpectedAnswer(response.status));
	}

	const seconds = typeof body.expires_in === 'number' ? body.expires_in : null;
	return {
		token: body.access_token,
		expiresAt: seconds === null ? null : now + seconds * 1000,
		refreshToken: textField(body.refresh_token)
	};
}

type BrokerOptions = { readonly app: GitHubApp; readonly fetch?: FetchFn; readonly now?: number };

async function askBroker(
	options: BrokerOptions,
	path: string,
	body: Record<string, string>
): Promise<GitHubTokenGrant> {
	const fetchFn = options.fetch ?? fetch;
	const response = await fetchFn(`${options.app.brokerOrigin}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify({ client_id: options.app.clientId, ...body })
	}).catch((cause: unknown) => {
		throw new GitHubSignInError(
			`The GitHub sign-in service could not be reached, so nothing has been signed in to. The ` +
				`browser reported: ${messageOf(cause)}. Everything you ` +
				`have is still saved on this computer, and you can send by pasting a personal access ` +
				`token instead — that path needs no service at all.`
		);
	});
	return readGrant(response, options.now ?? Date.now());
}

export const exchangeAuthorizationCode = (
	options: BrokerOptions & { readonly code: string; readonly redirectUri: string }
): Promise<GitHubTokenGrant> =>
	askBroker(options, '/github/token', { code: options.code, redirect_uri: options.redirectUri });

export const refreshGitHubToken = (
	options: BrokerOptions & { readonly refreshToken: string }
): Promise<GitHubTokenGrant> =>
	askBroker(options, '/github/refresh', { refresh_token: options.refreshToken });

export const CREDENTIAL_FRESHNESS_MARGIN_MS = 60_000;

export const isGrantFresh = (grant: GitHubTokenGrant, now: number): boolean =>
	grant.expiresAt === null || grant.expiresAt - now > CREDENTIAL_FRESHNESS_MARGIN_MS;

function readRecord<T>(storage: CredentialStorage, key: string): Partial<T> | null {
	const raw = webCredentialStore(storage, key).read();
	if (raw === null) return null;
	try {
		return JSON.parse(raw) as Partial<T> | null;
	} catch {
		return null;
	}
}

const expiryOf = (record: { expiresAt?: unknown }): number | null =>
	typeof record.expiresAt === 'number' ? record.expiresAt : null;

export function readGrantRecord(storage: CredentialStorage): GitHubTokenGrant | null {
	const record = readRecord<GitHubTokenGrant>(storage, GITHUB_APP_SESSION_KEY);
	if (typeof record?.token !== 'string' || record.token === '') return null;
	return {
		token: record.token,
		expiresAt: expiryOf(record),
		refreshToken: textField(record.refreshToken)
	};
}

export const writeGrantRecord = (storage: CredentialStorage, grant: GitHubTokenGrant): void =>
	webCredentialStore(storage, GITHUB_APP_SESSION_KEY).write(JSON.stringify(grant));

export const clearGrantRecord = (storage: CredentialStorage): void =>
	webCredentialStore(storage, GITHUB_APP_SESSION_KEY).clear();

type RememberedGrant = {
	readonly refreshToken: string;
	readonly expiresAt: number | null;
};

export function readRememberedGrant(storage: CredentialStorage): RememberedGrant | null {
	const record = readRecord<RememberedGrant>(storage, REMEMBERED_GRANT_KEY);
	if (typeof record?.refreshToken !== 'string' || record.refreshToken === '') return null;
	return { refreshToken: record.refreshToken, expiresAt: expiryOf(record) };
}

export function writeRememberedGrant(storage: CredentialStorage, grant: GitHubTokenGrant): void {
	if (grant.refreshToken === '') return clearRememberedGrant(storage);
	const remembered: RememberedGrant = {
		refreshToken: grant.refreshToken,
		expiresAt: grant.expiresAt
	};
	webCredentialStore(storage, REMEMBERED_GRANT_KEY).write(JSON.stringify(remembered));
}

export const clearRememberedGrant = (storage: CredentialStorage): void =>
	webCredentialStore(storage, REMEMBERED_GRANT_KEY).clear();

export const signInAgainMessage = (): string =>
	`Your GitHub sign-in has expired, so nothing has been sent. A sign-in from GitHub lasts ` +
	`eight hours and this one has run out — renewing it was tried and did not work. Press “Sign in ` +
	`with GitHub” to sign in again, then Sync. Nothing on this computer or on GitHub has been ` +
	`changed, and your work is exactly where you left it.`;

const refusedExchange = (detail: string): string =>
	`GitHub refused the sign-in, so nothing has been signed in to: ${detail}. Starting again ` +
	`usually settles it — a reply from GitHub can only be used once, so going back to a page you ` +
	`had open meets this every time.`;

const unexpectedAnswer = (status: number): string =>
	`The GitHub sign-in service gave an answer this application did not understand (HTTP ` +
	`${status}), so nothing has been signed in to. You can send by pasting a personal access ` +
	`token instead, which needs no service at all.`;
