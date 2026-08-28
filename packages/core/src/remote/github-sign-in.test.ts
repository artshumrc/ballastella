import { describe, expect, it } from 'vitest';

import { GITHUB_API_ORIGIN } from './github-api.js';
import type { GitHubApp } from './github-app.js';
import { GITHUB_APP, isGitHubAppConfigured } from './github-app.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { planRemotePublish, publishToRemote } from './publish-to-remote.js';
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

// The in-memory seam for the GitHub App path (ADR-0031). The whole flow is asserted here
// against the one shared fake — the authorize redirect, the `state` check, the code exchange, the
// refresh, and the expiry — so that the browser suite has to assert only what a browser can show.

/** A fake App, supplied by the test rather than read from the module (see `github-app.ts`). */
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
			// The App's registered callback, which is where the install screen returns to.
			callbackUrl: REDIRECT_URI,
			login: 'ada'
		}
	});

/** Press "Authorize" on GitHub's screen, and read the callback it redirects to. */
async function authorize(fake: FakeGitHub, state: string): Promise<URLSearchParams> {
	const response = await fake.fetch(authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state }), {
		method: 'GET'
	});
	expect(response.status).toBe(302);
	return new URL(response.headers.get('location') ?? '').searchParams;
}

/** Press "Install" on the App's own screen, which authorises in the same act. */
async function install(fake: FakeGitHub, state: string): Promise<URL> {
	const response = await fake.fetch(installUrl({ app: APP, state }), { method: 'GET' });
	expect(response.status).toBe(302);
	return new URL(response.headers.get('location') ?? '');
}

/** A `Storage`-shaped `Map`, which is all the grant record needs. */
function fakeStorage() {
	const held = new Map<string, string>();
	return {
		getItem: (key: string) => held.get(key) ?? null,
		setItem: (key: string, value: string) => void held.set(key, value),
		removeItem: (key: string) => void held.delete(key),
		held
	};
}

describe('the App this deployment ships with', () => {
	// A code is exchanged against this address, so it must be an origin and it must be encrypted: a
	// trailing slash or a path would send `/github/token` to somewhere other than the broker, and
	// `http:` would put an authorisation code on the wire in front of anyone on the network.
	it('is an https origin with nothing after it', () => {
		const broker = new URL(GITHUB_APP.brokerOrigin);
		expect(broker.protocol).toBe('https:');
		expect(GITHUB_APP.brokerOrigin).toBe(broker.origin);
	});

	it('is nonetheless configured, so the sign-in path is offered and can be exercised', () => {
		expect(isGitHubAppConfigured(GITHUB_APP)).toBe(true);
	});

	// A fork with no infrastructure empties all three values, and must then get no dead button at all.
	// ⚠ **Each of the three, on its own.** A half-configured fork offers a sign-in that cannot
	// complete: no broker to exchange the code, no client ID to look a secret up by, or an install
	// screen that is somebody else's App or nobody's.
	it('reads as unconfigured when any one of the three values is empty', () => {
		expect(isGitHubAppConfigured({ ...APP, brokerOrigin: '' })).toBe(false);
		expect(isGitHubAppConfigured({ ...APP, brokerOrigin: '   ' })).toBe(false);
		expect(isGitHubAppConfigured({ ...APP, clientId: '' })).toBe(false);
		expect(isGitHubAppConfigured({ ...APP, clientId: '   ' })).toBe(false);
		expect(isGitHubAppConfigured({ ...APP, appSlug: '' })).toBe(false);
		expect(isGitHubAppConfigured({ ...APP, appSlug: '   ' })).toBe(false);
		expect(isGitHubAppConfigured({ brokerOrigin: '', clientId: '', appSlug: '' })).toBe(false);
		expect(isGitHubAppConfigured(APP)).toBe(true);
	});
});

describe('the authorize URL', () => {
	it('carries the client ID, the callback, and the state', () => {
		const url = new URL(authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state: 'abc123' }));

		expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
		expect(url.searchParams.get('client_id')).toBe(APP.clientId);
		expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
		expect(url.searchParams.get('state')).toBe('abc123');
	});

	// GitHub's OAuth ignores PKCE, so a challenge would be protection that is present and does not
	// run. ADR-0031 and the ticket both refuse it by name; this is what keeps it refused.
	it('carries no PKCE challenge, which GitHub would ignore', () => {
		const url = new URL(authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state: 'abc123' }));

		expect(url.searchParams.get('code_challenge')).toBeNull();
		expect(url.searchParams.get('code_challenge_method')).toBeNull();
	});
});

describe('the install URL', () => {
	// The one screen that installs the App *and* issues the code, so a first-time author is not sent
	// back a second time for a step nothing named.
	it('is the App\u2019s own install screen, carrying the state', () => {
		const url = installUrl({ app: APP, state: 'abc123' });

		expect(url).toBe('https://github.com/apps/specimen-atlas/installations/new?state=abc123');
	});

	// ⚠ **No `redirect_uri`, and no `setup_action`.** The install screen has no redirect parameter —
	// GitHub comes back to the callback registered on the App — and `setup_action` is undocumented
	// across the whole of GitHub's documentation, so nothing may be built on it.
	it('sends no redirect_uri and asks for no setup action', () => {
		const url = new URL(installUrl({ app: APP, state: 'abc123' }));

		expect([...url.searchParams.keys()]).toEqual(['state']);
	});

	it('escapes a slug, so a mis-typed one cannot reach outside its own path segment', () => {
		const url = new URL(installUrl({ app: { ...APP, appSlug: 'a/../evil' }, state: 's' }));

		expect(url.pathname).toBe('/apps/a%2F..%2Fevil/installations/new');
	});
});

describe('the install screen’s return leg', () => {
	// ⚠ **The whole claim of install-first**: one screen installs the App *and* issues the code, so
	// nothing about what comes back differs from the authorize trip — same callback, same `state`,
	// same exchange. This is what lets the return leg go unchanged.
	it('comes back to the App’s registered callback with a code and the state', async () => {
		const fake = await github();

		const back = await install(fake, 'abc123');

		expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
		expect(back.searchParams.get('state')).toBe('abc123');
		expect(back.searchParams.get('code')).not.toBe('');
	});

	it('issues a code the broker will exchange, against that same callback', async () => {
		const fake = await github();
		const back = await install(fake, 'abc123');

		const grant = await exchangeAuthorizationCode({
			app: APP,
			code: back.searchParams.get('code') ?? '',
			redirectUri: REDIRECT_URI,
			fetch: fake.fetch
		});

		expect(grant.token).not.toBe('');
	});
});

describe('where a departing sign-in goes', () => {
	// An author with no Installation: an authorize-only trip would leave them holding a credential
	// against no Installation, which reads to them as owning no repositories.
	it('is the install screen for an author who has not installed the App', () => {
		const url = signInDepartureUrl({
			app: APP,
			redirectUri: REDIRECT_URI,
			state: 'abc123',
			installed: false
		});

		expect(url).toBe(installUrl({ app: APP, state: 'abc123' }));
	});

	// An Installation that already exists needs only a fresh credential, which is what the plain
	// authorize URL is for — and it is kept unchanged.
	it('is the plain authorize screen for an author who has', () => {
		const url = signInDepartureUrl({
			app: APP,
			redirectUri: REDIRECT_URI,
			state: 'abc123',
			installed: true
		});

		expect(url).toBe(authorizeUrl({ app: APP, redirectUri: REDIRECT_URI, state: 'abc123' }));
	});
});

describe('the state', () => {
	it('is unguessable and fresh each time', () => {
		const states = new Set(Array.from({ length: 50 }, () => newSignInState()));

		expect(states.size).toBe(50);
		for (const state of states) expect(state).toMatch(/^[0-9a-f]{32}$/);
	});

	it('accepts the state this tab generated', () => {
		expect(verifySignInState('abc123', 'abc123')).toBe('');
	});

	// The two refusals this ticket names. Neither is a retry: sending the user back round would make
	// the second attempt carry a state this tab *did* generate, which is the attack working.
	it('refuses a state that does not match, and says nothing is wrong with the account', () => {
		const refusal = verifySignInState('forged', 'abc123');

		expect(refusal).toContain('did not match');
		expect(refusal).toContain('Nothing is wrong with your account');
	});

	it('refuses a callback when this tab has no state at all', () => {
		expect(verifySignInState('abc123', null)).toContain('did not start a GitHub sign-in');
		expect(verifySignInState('abc123', '')).toContain('did not start a GitHub sign-in');
	});

	// A `?code=` with no `?state=` is the shape a forged callback has, so it is read in order to be
	// refused rather than ignored as noise.
	it('refuses a callback carrying a code and no state', () => {
		const callback = readSignInCallback(new URLSearchParams('code=abc'));

		expect(callback).toEqual({ code: 'abc', state: '', error: '', errorDescription: '' });
		expect(verifySignInState(callback?.state ?? '', 'abc123')).toContain('did not match');
	});

	it('reads nothing at all out of an ordinary page load', () => {
		expect(readSignInCallback(new URLSearchParams('p=amsterdam-1625'))).toBeNull();
	});
});

// GitHub answers a refusal with `error`, `error_description` and **the real `state`**, and no code at
// all — so a reader that took only `code` and `state` found a state that verifies and posted the empty
// string to the broker, and the scholar who pressed Cancel was told the code passed was incorrect or
// expired.
describe('a callback that refuses rather than authorises', () => {
	const cancelled = new URLSearchParams(
		'error=access_denied&error_description=The+user+has+denied+your+application+access.&state=abc123'
	);

	it('is read whole, including the state it carries', () => {
		expect(readSignInCallback(cancelled)).toEqual({
			code: '',
			state: 'abc123',
			error: 'access_denied',
			errorDescription: 'The user has denied your application access.'
		});
	});

	// The state does verify, which is exactly why the refusal has to be read: it is a real reply to a
	// real sign-in, and the only thing wrong with it is what it says.
	it('names Cancel, because that is what the scholar pressed', () => {
		const callback = readSignInCallback(cancelled)!;

		expect(verifySignInState(callback.state, 'abc123')).toBe('');
		const refusal = describeCallbackRefusal(callback);
		expect(refusal).toContain('not given permission');
		expect(refusal).toContain('Cancel');
		expect(refusal).toContain('personal access token');
	});

	it('passes GitHub’s own words on for anything else it refuses with', () => {
		const refusal = describeCallbackRefusal({
			code: '',
			state: 'abc123',
			error: 'application_suspended',
			errorDescription: 'This application has been suspended.'
		});

		expect(refusal).toContain('This application has been suspended.');
	});

	// The remaining malformed shape: a reply with nothing in it to exchange. Sent to the broker it
	// comes back as "the code passed is incorrect or expired", which describes nothing that happened.
	it('refuses a callback with neither a code nor a reason', () => {
		expect(
			describeCallbackRefusal({ code: '', state: 'abc123', error: '', errorDescription: '' })
		).toContain('carried no authorisation');
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

		const grant = await exchangeAuthorizationCode({
			app: APP,
			code: callback.get('code') ?? '',
			redirectUri: REDIRECT_URI,
			fetch: fake.fetch,
			now: 1_000_000
		});

		expect(grant.token).not.toBe('');
		// Eight hours, which is a GitHub App user-to-server token's life.
		expect(grant.expiresAt).toBe(1_000_000 + 8 * 3600 * 1000);
		expect(grant.refreshToken).not.toBe('');

		// And it is a credential the API honours, which is the only thing that makes it a sign-in.
		const who = await fake.fetch(`${GITHUB_API_ORIGIN}/user`, {
			headers: { Authorization: `Bearer ${grant.token}` }
		});
		expect(await who.json()).toEqual({ login: 'ada' });
	});

	// ⚠ The refusal arrives **in the body, with a 200**. An engine checking `response.ok` alone would
	// read this as success and then fail on an absent `access_token` with nothing to show the user.
	it('surfaces a spent code as a sentence rather than as a success', async () => {
		const fake = await github();
		const callback = await authorize(fake, newSignInState());
		const code = callback.get('code') ?? '';
		const exchange = () =>
			exchangeAuthorizationCode({ app: APP, code, redirectUri: REDIRECT_URI, fetch: fake.fetch });

		await exchange();

		await expect(exchange()).rejects.toThrow(GitHubSignInError);
		await expect(exchange()).rejects.toThrow(/only be used once/);
	});

	it('refuses a code that names a different callback than it was issued for', async () => {
		const fake = await github();
		const callback = await authorize(fake, newSignInState());

		await expect(
			exchangeAuthorizationCode({
				app: APP,
				code: callback.get('code') ?? '',
				redirectUri: 'https://somewhere-else.example.edu/',
				fetch: fake.fetch
			})
		).rejects.toThrow(/redirect_uri/);
	});

	// The broker looks a secret up **by `client_id`**, which is what lets one deployment serve several
	// unrelated projects without any of them minting tokens against another's App (ADR-0031).
	it('is refused for a client ID the broker holds no secret for', async () => {
		const fake = await github();
		const callback = await authorize(fake, newSignInState());

		await expect(
			exchangeAuthorizationCode({
				app: { ...APP, clientId: 'Iv1.somebody-elses-app' },
				code: callback.get('code') ?? '',
				redirectUri: REDIRECT_URI,
				fetch: fake.fetch
			})
		).rejects.toThrow(/client_id/);
	});

	// ⚠ **The state this deployment actually ships in.** `github-app.ts` points at a reserved domain
	// that will never answer, so this is not a hypothetical outage — it is every sign-in attempt in
	// this build, and it must be a sentence naming the token-paste path rather than a stack trace.
	it('says the service could not be reached, and names the path that needs none', async () => {
		const unreachable = () => Promise.reject(new TypeError('Failed to fetch'));

		await expect(
			exchangeAuthorizationCode({
				app: APP,
				code: 'code_0001',
				redirectUri: REDIRECT_URI,
				fetch: unreachable
			})
		).rejects.toThrow(/could not be reached[\s\S]*personal access token/);
	});
});

describe('the refresh', () => {
	it('trades a refresh token for a working one through the broker', async () => {
		const fake = await github();
		const callback = await authorize(fake, newSignInState());
		const first = await exchangeAuthorizationCode({
			app: APP,
			code: callback.get('code') ?? '',
			redirectUri: REDIRECT_URI,
			fetch: fake.fetch
		});

		const second = await refreshGitHubToken({
			app: APP,
			refreshToken: first.refreshToken,
			fetch: fake.fetch
		});

		expect(second.token).not.toBe(first.token);
		const who = await fake.fetch(`${GITHUB_API_ORIGIN}/user`, {
			headers: { Authorization: `Bearer ${second.token}` }
		});
		expect(who.status).toBe(200);
	});

	// The other half of an expiring sign-in: when the refresh fails there is nothing left to do but
	// sign in again, and the caller has to be able to tell that apart from a broker that was merely
	// unreachable.
	it('surfaces an expired refresh token as a refusal', async () => {
		const fake = await github();
		fake.refuseRefresh = true;

		await expect(
			refreshGitHubToken({ app: APP, refreshToken: 'ghr_0000', fetch: fake.fetch })
		).rejects.toThrow(GitHubSignInError);
	});
});

// ADR-0041: what may be kept past the tab is the renewable half and nothing else. Eight hours of
// publish rights at rest is the outcome this whole feature must not produce, so the stripping is
// asserted at the function that does it rather than trusted to each caller.
describe('the half of a grant that may be kept past the tab', () => {
	it('keeps the refresh token and its expiry, and not the access token', () => {
		const storage = fakeStorage();
		const grant = { token: 'ghu_publishes', expiresAt: 42, refreshToken: 'ghr_renews' };

		writeRememberedGrant(storage, grant);

		expect(readRememberedGrant(storage)).toEqual({ refreshToken: 'ghr_renews', expiresAt: 42 });
		expect([...storage.held.keys()]).toEqual([REMEMBERED_GRANT_KEY]);
		// The bytes themselves, because a record that merely parses without the token could still
		// carry it in a field nothing reads back.
		expect(storage.held.get(REMEMBERED_GRANT_KEY)).not.toContain('ghu_publishes');
	});

	it('is taken away again when it is cleared', () => {
		const storage = fakeStorage();
		writeRememberedGrant(storage, { token: 'ghu_1', expiresAt: 42, refreshToken: 'ghr_1' });

		clearRememberedGrant(storage);

		expect(readRememberedGrant(storage)).toBeNull();
	});

	// A grant with no refresh token has no renewable half. Kept, it would be spent once on the next
	// visit, fail, and report an expiry to somebody who never asked to be remembered.
	it('keeps nothing at all for a grant that cannot be renewed, and removes what was kept', () => {
		const storage = fakeStorage();
		writeRememberedGrant(storage, { token: 'ghu_1', expiresAt: 42, refreshToken: 'ghr_1' });

		writeRememberedGrant(storage, { token: 'ghu_2', expiresAt: 99, refreshToken: '' });

		expect(readRememberedGrant(storage)).toBeNull();
		expect([...storage.held.keys()]).toEqual([]);
	});

	it('reads a damaged record as nothing remembered rather than throwing', () => {
		const storage = fakeStorage();
		storage.held.set(REMEMBERED_GRANT_KEY, '{not json');

		expect(readRememberedGrant(storage)).toBeNull();
	});

	it('survives a storage that throws from every property', () => {
		const hostile = {
			getItem: () => {
				throw new Error('cookies are blocked');
			},
			setItem: () => {
				throw new Error('cookies are blocked');
			},
			removeItem: () => {
				throw new Error('cookies are blocked');
			}
		};

		expect(readRememberedGrant(hostile)).toBeNull();
		expect(() =>
			writeRememberedGrant(hostile, { token: 'x', expiresAt: 1, refreshToken: 'ghr_1' })
		).not.toThrow();
		expect(() => clearRememberedGrant(hostile)).not.toThrow();
	});
});

describe('the grant record', () => {
	it('is kept beside the credential and read back whole', () => {
		const storage = fakeStorage();
		const grant = { token: 'ghu_1', expiresAt: 42, refreshToken: 'ghr_1' };

		writeGrantRecord(storage, grant);

		expect(readGrantRecord(storage)).toEqual(grant);
		expect([...storage.held.keys()]).toEqual([GITHUB_APP_SESSION_KEY]);

		clearGrantRecord(storage);
		expect(readGrantRecord(storage)).toBeNull();
	});

	// A record that will not parse degrades to *no App session*, which is the pasted-token path,
	// rather than to a screen nobody can get past.
	it('reads a damaged record as no session rather than throwing', () => {
		const storage = fakeStorage();
		storage.held.set(GITHUB_APP_SESSION_KEY, '{not json');

		expect(readGrantRecord(storage)).toBeNull();
	});

	it('survives a storage that throws from every property', () => {
		const hostile = {
			getItem: () => {
				throw new Error('cookies are blocked');
			},
			setItem: () => {
				throw new Error('cookies are blocked');
			},
			removeItem: () => {
				throw new Error('cookies are blocked');
			}
		};

		expect(readGrantRecord(hostile)).toBeNull();
		expect(() =>
			writeGrantRecord(hostile, { token: 'x', expiresAt: 1, refreshToken: '' })
		).not.toThrow();
		expect(() => clearGrantRecord(hostile)).not.toThrow();
	});
});

describe('freshness', () => {
	// The rule that makes expiry a refusal *before* a publish rather than a failure during one.
	it('calls a token at the end of its life stale, with a margin', () => {
		const now = 1_000_000;

		expect(isGrantFresh({ token: 't', expiresAt: null, refreshToken: '' }, now)).toBe(true);
		expect(
			isGrantFresh(
				{ token: 't', expiresAt: now + CREDENTIAL_FRESHNESS_MARGIN_MS + 1, refreshToken: '' },
				now
			)
		).toBe(true);
		expect(
			isGrantFresh(
				{ token: 't', expiresAt: now + CREDENTIAL_FRESHNESS_MARGIN_MS, refreshToken: '' },
				now
			)
		).toBe(false);
		expect(isGrantFresh({ token: 't', expiresAt: now - 1, refreshToken: '' }, now)).toBe(false);
	});
});

// ADR-0031's first consequence, and the property that licenses this deployment shipping placeholder
// values: *a fork with no infrastructure is fully functional, not degraded.* The broker is on no data
// path at all, so a publish with a pasted token must not touch it — asserted here rather than in the
// browser because "which host was reached" is a question about the engine, not about a screen.
describe('a publish with a pasted token', () => {
	it('never reaches the broker, even when every request to it would fail', async () => {
		const fake = await github();
		const store = new MemoryProjectStore();
		await store.write('amsterdam-1625/project.json', new TextEncoder().encode('{"name":"A"}'));

		const reached: string[] = [];
		/** GitHub as normal; anything on the broker's origin throws, as an undeployed one would. */
		const noBroker: typeof fake.fetch = (input, init) => {
			const url = new URL(typeof input === 'string' ? input : input.toString());
			reached.push(url.origin);
			if (url.origin === APP.brokerOrigin) {
				return Promise.reject(new TypeError('Failed to fetch'));
			}
			return fake.fetch(input, init);
		};

		const remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
		const token = 'github_pat_11ABCDE0000abcdefghij';
		const plan = await planRemotePublish(store, { token, remote, fetch: noBroker });
		await publishToRemote(store, { token, remote, plan, fetch: noBroker });

		expect(fake.files().get('amsterdam-1625/project.json')).toBeDefined();
		expect(reached).not.toContain(APP.brokerOrigin);
	});
});

describe('an expired token, at the API', () => {
	// GitHub refuses an expired user-to-server token in exactly the words it refuses a revoked one,
	// which is why the app's answer to both is the same sentence.
	it('is refused, while a pasted token in the same browser is not', async () => {
		const fake = await github();
		const callback = await authorize(fake, newSignInState());
		const grant = await exchangeAuthorizationCode({
			app: APP,
			code: callback.get('code') ?? '',
			redirectUri: REDIRECT_URI,
			fetch: fake.fetch
		});

		fake.expireIssuedTokens();

		const withGrant = await fake.fetch(`${GITHUB_API_ORIGIN}/repos/ada/atlas`, {
			headers: { Authorization: `Bearer ${grant.token}` }
		});
		expect(withGrant.status).toBe(401);

		const pasted = await fake.fetch(`${GITHUB_API_ORIGIN}/repos/ada/atlas`, {
			headers: { Authorization: 'Bearer github_pat_11ABCDE0000abcdefghij' }
		});
		expect(pasted.status).toBe(200);
	});
});
