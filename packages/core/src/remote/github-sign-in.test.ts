import { describe, expect, it } from 'vitest';

import { rejection, seeded } from '../test-support.js';
import { FakeStorage, refusingStorage, TOKEN } from './credential-store-suite.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { GITHUB_API_ORIGIN } from './github-api.js';
import { GITHUB_APP, isGitHubAppConfigured, type GitHubApp } from './github-app.js';
import { planRemoteSend, sendToRemote } from './send-to-remote.js';
import {
	CREDENTIAL_FRESHNESS_MARGIN_MS,
	GITHUB_APP_SESSION_KEY,
	GitHubSignInError,
	REMEMBERED_GRANT_KEY,
	authorizeUrl,
	clearGrantRecord,
	clearRememberedGrant,
	describeCallbackRefusal,
	exchangeAuthorizationCode,
	grantAccessUrl,
	installUrl,
	isGrantFresh,
	newSignInState,
	readGrantRecord,
	readRememberedGrant,
	readSignInCallback,
	refreshGitHubToken,
	signInDepartureUrl,
	verifySignInState,
	writeGrantRecord,
	writeRememberedGrant
} from './github-sign-in.js';

const APP: GitHubApp = {
	brokerOrigin: 'https://broker.test',
	clientId: 'Iv1.testclientid',
	appSlug: 'specimen-atlas'
};

const REDIRECT_URI = 'https://atlas.example.edu/editor/';

const github = (): Promise<FakeGitHub> =>
	createFakeGitHub({
		owner: 'ada',
		repository: 'atlas',
		tree: { 'README.md': '# Atlas\n' },
		signIn: {
			brokerOrigin: APP.brokerOrigin,
			clientId: APP.clientId,
			appSlug: APP.appSlug,
			callbackUrl: REDIRECT_URI,
			login: 'ada'
		}
	});

async function authorize(fake: FakeGitHub, state: string): Promise<URLSearchParams> {
	const response = await fake.fetch(authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state }), {
		method: 'GET'
	});
	expect(response.status).toBe(302);
	return new URL(response.headers.get('location') ?? '').searchParams;
}

async function install(fake: FakeGitHub, state: string): Promise<URL> {
	const response = await fake.fetch(installUrl({ app: APP, state }), { method: 'GET' });
	expect(response.status).toBe(302);
	return new URL(response.headers.get('location') ?? '');
}

const exchange = (
	fetch: FakeGitHub['fetch'],
	code: string,
	overrides: Partial<Parameters<typeof exchangeAuthorizationCode>[0]> = {}
) => exchangeAuthorizationCode({ app: APP, code, redirectUri: REDIRECT_URI, fetch, ...overrides });

const asBearer = (fake: FakeGitHub, url: string, token: string) =>
	fake.fetch(url, { headers: { Authorization: `Bearer ${token}` } });

async function signIn(fake: FakeGitHub) {
	const callback = await authorize(fake, newSignInState());
	return exchange(fake.fetch, callback.get('code') ?? '');
}

describe('the App this deployment ships with', () => {
	it('is configured with an https origin that has nothing after it', () => {
		const broker = new URL(GITHUB_APP.brokerOrigin);
		expect(broker.protocol).toBe('https:');
		expect(GITHUB_APP.brokerOrigin).toBe(broker.origin);
		expect(isGitHubAppConfigured(GITHUB_APP)).toBe(true);
	});

	it('reads as unconfigured when any one of the three values is empty', () => {
		for (const key of ['brokerOrigin', 'clientId', 'appSlug'] as const) {
			for (const value of ['', '   ']) {
				expect(isGitHubAppConfigured({ ...APP, [key]: value })).toBe(false);
			}
		}
		expect(isGitHubAppConfigured({ brokerOrigin: '', clientId: '', appSlug: '' })).toBe(false);
		expect(isGitHubAppConfigured(APP)).toBe(true);
	});
});

describe('the GitHub URLs', () => {
	it('authorizes with the client ID, the callback and the state, and no PKCE GitHub would ignore', () => {
		const url = new URL(authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state: 'abc123' }));
		expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			client_id: APP.clientId,
			redirect_uri: REDIRECT_URI,
			state: 'abc123'
		});
		expect(url.searchParams.get('code_challenge')).toBeNull();
		expect(url.searchParams.get('code_challenge_method')).toBeNull();
	});

	it('installs on the App’s own screen, carrying the state and no redirect_uri or setup action', () => {
		expect(installUrl({ app: APP, state: 'abc123' })).toBe(
			'https://github.com/apps/specimen-atlas/installations/new?state=abc123'
		);
	});

	it('grants access on the App’s own screen, for the account and any repository in hand', () => {
		expect(grantAccessUrl({ app: APP, targetId: 5150 })).toBe(
			'https://github.com/apps/specimen-atlas/installations/new/permissions?suggested_target_id=5150'
		);
		const url = new URL(grantAccessUrl({ app: APP, targetId: 5150, repositoryId: 987 }));
		expect(url.searchParams.get('suggested_target_id')).toBe('5150');
		expect(url.searchParams.get('repository_ids[]')).toBe('987');
	});

	it.each([
		['install', installUrl({ app: { ...APP, appSlug: 'a/../evil' }, state: 's' }), ''],
		[
			'grant-access',
			grantAccessUrl({ app: { ...APP, appSlug: 'a/../evil' }, targetId: 1 }),
			'/permissions'
		]
	])('escapes a mis-typed slug in the %s URL to its own path segment', (_, url, rest) => {
		expect(new URL(url).pathname).toBe(`/apps/a%2F..%2Fevil/installations/new${rest}`);
	});

	it('departs to the install screen before the App is installed, and to authorize after', () => {
		const departure = (installed: boolean) =>
			signInDepartureUrl({ app: APP, redirectUri: REDIRECT_URI, state: 'abc123', installed });

		expect(departure(false)).toBe(installUrl({ app: APP, state: 'abc123' }));
		expect(departure(true)).toBe(
			authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state: 'abc123' })
		);
	});
});

it('returns from the install screen to the registered callback with an exchangeable code', async () => {
	const fake = await github();
	const back = await install(fake, 'abc123');
	expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
	expect(back.searchParams.get('state')).toBe('abc123');
	expect(back.searchParams.get('code')).not.toBe('');
	const grant = await exchange(fake.fetch, back.searchParams.get('code') ?? '');
	expect(grant.token).not.toBe('');
});

describe('the state', () => {
	it('is unguessable and fresh each time', () => {
		const states = new Set(Array.from({ length: 50 }, () => newSignInState()));
		expect(states.size).toBe(50);
		for (const state of states) expect(state).toMatch(/^[0-9a-f]{32}$/);
	});

	it('accepts only the state this tab generated, saying nothing is wrong with the account', () => {
		expect(verifySignInState('abc123', 'abc123')).toBe('');
		const refusal = verifySignInState('forged', 'abc123');
		expect(refusal).toContain('did not match');
		expect(refusal).toContain('Nothing is wrong with your account');
		expect(verifySignInState('abc123', null)).toContain('did not start a GitHub sign-in');
		expect(verifySignInState('abc123', '')).toContain('did not start a GitHub sign-in');
	});

	it('refuses a callback carrying a code and no state, and reads nothing from an ordinary load', () => {
		const callback = readSignInCallback(new URLSearchParams('code=abc'));
		expect(callback).toEqual({ code: 'abc', state: '', error: '', errorDescription: '' });
		expect(verifySignInState(callback?.state ?? '', 'abc123')).toContain('did not match');
		expect(readSignInCallback(new URLSearchParams('p=amsterdam-1625'))).toBeNull();
	});
});

describe('a callback that refuses rather than authorises', () => {
	it('is read whole, its state included, and names Cancel, because that is what was pressed', () => {
		const callback = readSignInCallback(
			new URLSearchParams(
				'error=access_denied&error_description=The+user+has+denied+your+application+access.&state=abc123'
			)
		);
		expect(callback).toEqual({
			code: '',
			state: 'abc123',
			error: 'access_denied',
			errorDescription: 'The user has denied your application access.'
		});
		expect(verifySignInState(callback!.state, 'abc123')).toBe('');
		const refusal = describeCallbackRefusal(callback!);
		for (const part of ['not given permission', 'Cancel', 'personal access token']) {
			expect(refusal).toContain(part);
		}
	});

	it.each([
		[
			'passes GitHub’s own words on for anything else',
			{ error: 'application_suspended', errorDescription: 'This application has been suspended.' },
			'This application has been suspended.'
		],
		['refuses a callback with neither a code nor a reason', {}, 'carried no authorisation']
	])('%s', (_, fields, says) => {
		const callback = { code: '', state: 'abc123', error: '', errorDescription: '', ...fields };
		expect(describeCallbackRefusal(callback)).toContain(says);
	});

	it('has nothing to say about an ordinary code', () => {
		expect(
			describeCallbackRefusal({ code: 'abc', state: 'abc123', error: '', errorDescription: '' })
		).toBe('');
	});
});

describe('the code exchange', () => {
	it('completes, and the token it yields is one GitHub accepts', async () => {
		const fake = await github();
		const state = newSignInState();
		const callback = await authorize(fake, state);
		expect(callback.get('state')).toBe(state);
		const grant = await exchange(fake.fetch, callback.get('code') ?? '', { now: 1_000_000 });
		expect(grant.token).not.toBe('');
		expect(grant.expiresAt).toBe(1_000_000 + 8 * 3600 * 1000);
		expect(grant.refreshToken).not.toBe('');
		const who = await asBearer(fake, `${GITHUB_API_ORIGIN}/user`, grant.token);
		expect(await who.json()).toEqual({ login: 'ada' });
	});

	it.each([
		['a spent code, rather than succeeding', true, {}, /only be used once/],
		[
			'a code naming a different callback than it was issued for',
			false,
			{ redirectUri: 'https://somewhere-else.example.edu/' },
			/redirect_uri/
		],
		[
			'a client ID the broker holds no secret for',
			false,
			{ app: { ...APP, clientId: 'Iv1.somebody-elses-app' } },
			/client_id/
		]
	])('refuses %s, in a sentence', async (_, spent, overrides, says) => {
		const fake = await github();
		const code = (await authorize(fake, newSignInState())).get('code') ?? '';
		if (spent) await exchange(fake.fetch, code);

		const refusal = await rejection(GitHubSignInError, exchange(fake.fetch, code, overrides));
		expect(refusal.message).toMatch(says);
	});

	it('says the service could not be reached, and names the path that needs none', async () => {
		const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));

		await expect(exchange(unreachable, 'code_0001')).rejects.toThrow(
			/could not be reached[\s\S]*personal access token/
		);
	});
});

describe('the refresh', () => {
	it('trades a refresh token for a working one through the broker', async () => {
		const fake = await github();
		const first = await signIn(fake);

		const second = await refreshGitHubToken({
			app: APP,
			refreshToken: first.refreshToken,
			fetch: fake.fetch
		});

		expect(second.token).not.toBe(first.token);
		expect((await asBearer(fake, `${GITHUB_API_ORIGIN}/user`, second.token)).status).toBe(200);
	});

	it('surfaces an expired refresh token as a refusal', async () => {
		const fake = await github();
		fake.refuseRefresh = true;

		await expect(
			refreshGitHubToken({ app: APP, refreshToken: 'ghr_0000', fetch: fake.fetch })
		).rejects.toThrow(GitHubSignInError);
	});
});

describe('kept grants', () => {
	it('keep the refresh token and its expiry past the tab, never the access token, until cleared', () => {
		const storage = new FakeStorage();
		writeRememberedGrant(storage, {
			token: 'ghu_publishes',
			expiresAt: 42,
			refreshToken: 'ghr_renews'
		});
		expect(readRememberedGrant(storage)).toEqual({ refreshToken: 'ghr_renews', expiresAt: 42 });
		expect([...storage.items.keys()]).toEqual([REMEMBERED_GRANT_KEY]);
		expect(storage.items.get(REMEMBERED_GRANT_KEY)).not.toContain('ghu_publishes');

		clearRememberedGrant(storage);
		expect(readRememberedGrant(storage)).toBeNull();
	});

	it('keep nothing past the tab for a grant that cannot be renewed, removing what was kept', () => {
		const storage = new FakeStorage();
		writeRememberedGrant(storage, { token: 'ghu_1', expiresAt: 42, refreshToken: 'ghr_1' });
		writeRememberedGrant(storage, { token: 'ghu_2', expiresAt: 99, refreshToken: '' });
		expect(readRememberedGrant(storage)).toBeNull();
		expect([...storage.items.keys()]).toEqual([]);
	});

	it('keep the whole grant record beside the credential, until cleared', () => {
		const storage = new FakeStorage();
		const grant = { token: 'ghu_1', expiresAt: 42, refreshToken: 'ghr_1' };
		writeGrantRecord(storage, grant);
		expect(readGrantRecord(storage)).toEqual(grant);
		expect([...storage.items.keys()]).toEqual([GITHUB_APP_SESSION_KEY]);
		clearGrantRecord(storage);
		expect(readGrantRecord(storage)).toBeNull();
	});

	describe.each([
		[
			'the remembered grant',
			REMEMBERED_GRANT_KEY,
			readRememberedGrant,
			writeRememberedGrant,
			clearRememberedGrant
		],
		[
			'the grant record',
			GITHUB_APP_SESSION_KEY,
			readGrantRecord,
			writeGrantRecord,
			clearGrantRecord
		]
	])('%s', (_, key, read, write, clear) => {
		it('reads a damaged record as nothing kept rather than throwing', () => {
			const storage = new FakeStorage();
			storage.items.set(key, '{not json');

			expect(read(storage)).toBeNull();
		});

		it('survives a storage that throws from every property', () => {
			const hostile = refusingStorage();
			expect(read(hostile)).toBeNull();
			expect(() =>
				write(hostile, { token: 'x', expiresAt: 1, refreshToken: 'ghr_1' })
			).not.toThrow();
			expect(() => clear(hostile)).not.toThrow();
		});
	});
});

it('calls a token at the end of its life stale, with a margin', () => {
	const now = 1_000_000;
	const fresh = (expiresAt: number | null) =>
		isGrantFresh({ token: 't', expiresAt, refreshToken: '' }, now);

	expect([
		fresh(null),
		fresh(now + CREDENTIAL_FRESHNESS_MARGIN_MS + 1),
		fresh(now + CREDENTIAL_FRESHNESS_MARGIN_MS),
		fresh(now - 1)
	]).toEqual([true, true, false, false]);
});

it('never reaches the broker on a send with a pasted token, even when it would fail', async () => {
	const fake = await github();
	const store = await seeded({ 'amsterdam-1625/project.json': '{"name":"A"}' });
	const reached: string[] = [];
	const noBroker: typeof fake.fetch = (input, init) => {
		const url = new URL(typeof input === 'string' ? input : input.toString());
		reached.push(url.origin);
		if (url.origin === APP.brokerOrigin) return Promise.reject(new TypeError('Failed to fetch'));
		return fake.fetch(input, init);
	};

	const remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
	const plan = await planRemoteSend(store, { token: TOKEN, remote, fetch: noBroker });
	await sendToRemote(store, { token: TOKEN, remote, plan, fetch: noBroker });

	expect(fake.files().get('amsterdam-1625/project.json')).toBeDefined();
	expect(reached).not.toContain(APP.brokerOrigin);
});

it('refuses an expired token at the API, while a pasted token in the same browser is not', async () => {
	const fake = await github();
	const grant = await signIn(fake);

	fake.expireIssuedTokens();

	const repo = `${GITHUB_API_ORIGIN}/repos/ada/atlas`;
	expect((await asBearer(fake, repo, grant.token)).status).toBe(401);
	expect((await asBearer(fake, repo, TOKEN)).status).toBe(200);
});
