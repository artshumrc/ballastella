// The GitHub every GitHub-area spec talks to, installed as Playwright routes.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// THE NETWORK FENCE, AND WHY THESE ROUTES COME FIRST
//
// `e2e/support/network-fence.ts` installs `context.route('**/*')` in the `context` fixture, before
// any `beforeEach`, and aborts anything it did not expect. Playwright consults the most recently
// added handler first, so a host installed here is served and never reaches the fence. A spec that
// forgets to install these gets `net::ERR_BLOCKED_BY_CLIENT`, which is the fence working: **no spec
// using this module reaches api.github.com.**
//
// `target` is `Pick<Page | BrowserContext, 'route'>`, the same signature `routeIiifHosts` and
// `routeBaseMapArchive` take: `page.route` cannot see requests a **service worker** makes, so a
// spec testing offline behaviour has to install these on the context.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT IS `createFakeGitHub` — THE SAME FAKE THE DOMAIN PACKAGE DRIVES — AND NOT A SECOND ONE
//
// Seam 2 is the end-to-end suite against the same fake, through Playwright routes. One fake, for one
// reason — `iiif-hosts`'s lesson, where three specs grew their own IIIF hosts and two of them could
// disagree about what a service does while both stayed green. So everything below the
// `route.fulfill` is `packages/core`'s fake, reached by a relative import; only the request and the
// response are translated.
//
// ⚠ **A second hand-written GitHub stood here, and it had already drifted in the one place that
// matters.** On an unauthenticated `GET /repos/{owner}/{repo}` it omitted `permissions` while the
// shared fake sent it, and a missing `permissions` is what `bind-remote.ts` maps to `canPush:
// false` — so the two fakes gave *opposite* answers on the field deciding whether the scholar is
// told their token cannot push. That is exactly the failure a single shared fake exists to prevent.
// Where the two disagreed, real GitHub won: the omission was right and lives in the shared fake,
// along with `refusePages`, `rejectCredential` and the 422 a Pages request meets when the repository
// has no branches yet.
//
// **The import works, and the claim that it could not was measured to be false.** The workspace
// `tsconfig.json`'s `include` governs which files are compilation *roots*, not what they may
// import; this file typechecks, lints, and runs unchanged. (`support/test.ts` still spells
// `DEFAULT_WORKSPACE` out as a literal, which is a different and much cheaper judgement: one word,
// and a rename that missed it fails every spec loudly.)

import {
	createFakeGitHub,
	type FakeGitHub,
	type FakeGrants,
	type FakeRateLimit
} from '../../packages/core/src/remote/fake-github.js';
import {
	GITHUB_APP,
	isGitHubAppConfigured,
	type GitHubApp
} from '../../packages/core/src/remote/github-app.js';
import {
	GITHUB_APPS_URL,
	GITHUB_AUTHORIZE_URL
} from '../../packages/core/src/remote/github-sign-in.js';
import type { BrowserContext, Page, Route } from './test.js';

/** GitHub's data plane. It answers `access-control-allow-origin: *`, which is why ADR-0031 holds. */
export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** Where a public repository's bytes are read from, unauthenticated, by Clone and Review. */
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';

export type FakeRepository = {
	readonly owner: string;
	readonly name: string;
	/**
	 * What the repository already holds, as its first commit.
	 *
	 * A `README.md` by default, so the repository has the `main` branch a Pages source names. Pass
	 * `{}` for a repository with a commit and no files, and pass files a send must **not** touch —
	 * a `CNAME`, a `docs/` folder — to assert ADR-0033's owned namespace from a browser.
	 */
	readonly files?: Readonly<Record<string, string>>;
	/** What `GET /repos/{owner}/{repo}` reports about the caller. */
	readonly push?: boolean;
	/**
	 * Make it private: every read carrying no credential answers 404, on both hosts.
	 *
	 * ⚠ **404 and never 401**, because that is what GitHub does — it will not admit that a repository
	 * the caller cannot see exists at all (ADR-0044). Set it beside a `grants` entry marked
	 * `private`, so what the chooser is told and what the API answers cannot disagree.
	 */
	readonly private?: boolean;
	/**
	 * Who `GET /repos/{owner}/{repo}/contributors` reports, which is how a shared Remote is told from
	 * a solo one (ADR-0043).
	 *
	 * The owner alone by default: every other spec here means a repository nobody else works in, and
	 * that is the state whose overwrite behaviour is unchanged.
	 */
	readonly contributors?: readonly string[];
	/** `POST /pages` answers 409 when this is already true, and turns it on when it is not. */
	readonly pagesEnabled?: boolean;
	/** Answer 403 to `POST /pages`: a token with `contents: write` and no `pages: write`. */
	readonly refusePages?: boolean;
	/**
	 * Cut every tree listing short after this many entries and report `truncated: true`.
	 *
	 * The real endpoint truncates at 100 000 entries or 7 MB **and still answers 200**, which is why
	 * a send that did not look would commit a tree missing most of a Workspace.
	 */
	readonly truncateAfter?: number;
	/** The hourly budget this repository starts with, and when it resets. */
	readonly rateLimit?: FakeRateLimit;
};

export type GitHubHostsOptions = {
	/** The repositories that exist. Anything else is a 404, as GitHub answers for both cases. */
	readonly repositories?: readonly FakeRepository[];
	/** Answer 401 to every credentialed request: an expired or revoked token. */
	readonly rejectCredential?: boolean;
	/**
	 * Serve the GitHub App sign-in as well: GitHub's authorize screen, and the broker's two endpoints.
	 *
	 * ⚠ **The addresses come from `GITHUB_APP`, because the app under test is built with them.** The
	 * browser's own `beginGitHubSignIn` reads that module, so a spec that routed a pair of its own
	 * would be intercepting addresses nothing requests — and the fence
	 * (`scripts/check-github-broker.mjs`) refuses a spec that writes either value down, for the same
	 * reason the place-lookup fence refuses one that names its host.
	 *
	 * Left out, none of those three addresses are served and the network fence aborts any request to
	 * them, which is the fence working: no spec reaches `github.com` or a real broker.
	 *
	 * The surface is served by the **first repository's** fake, so that a token it issues is one that
	 * repository's API honours. Every spec driving sign-in has exactly one repository.
	 */
	readonly signIn?: boolean;
	/**
	 * Serve GitHub's authorize screen, but let every request to the broker fail to connect.
	 *
	 * ⚠ **This is the state this deployment ships in**, and it is not the same as `signIn: false`.
	 * GitHub is real and answers; the broker's host is reserved by RFC 2606 and resolves nowhere
	 * (`github-app.ts`), so a scholar gets all the way through the redirect and meets the failure at
	 * the exchange. What must come out of that is a sentence naming the token-paste path, and a paste
	 * that then binds and sends exactly as it always did (ADR-0031's first consequence).
	 */
	readonly brokerUnreachable?: boolean;
	/** How long an issued token lasts. Short values are how a spec reaches expiry without waiting. */
	readonly tokenLifetimeSeconds?: number;
	/**
	 * The account this credential belongs to, reported by `GET /user`.
	 *
	 * ⚠ **Applied whether or not the sign-in surface is served.** Whose a repository is, is a
	 * comparison between its owner and this — so a spec that seeds a credential rather than acquiring
	 * one still has to be able to say who the seeded credential is.
	 */
	readonly login?: string;
	/**
	 * The repositories the author has granted the App access to, as the two installation endpoints
	 * report them.
	 *
	 * ⚠ **Answered by the *same* fake that issues the sign-in's token**, which is why it belongs here
	 * rather than on a repository: `GET /user/installations` is a question about the credential, and
	 * `routeGitHubHosts` already sends everything under `/user` to that one fake. Omit it and the
	 * author has granted nothing, which is a 200 with an empty list rather than a 404 — GitHub's own
	 * answer for somebody who has never installed the App.
	 */
	readonly grants?: FakeGrants;
};

/**
 * What the fake was asked, and — the half that matters — what it now holds.
 *
 * ⚠ **A good test here asserts what arrived at the Remote, not which calls were made.** Every
 * failure mode in this area is silent and plausible: a truncated tree yields a commit missing most of
 * a pyramid, an off-by-one in the owned namespace deletes a `CNAME`. A spec counting requests passes over both, so {@link GitHubHosts.files} is what
 * a send is asserted on and {@link GitHubHosts.requests} is for the one claim of the opposite
 * shape — that a Review Workspace asked GitHub nothing at all.
 */
export type GitHubHosts = {
	/** Every API path that was requested, in order. */
	readonly requests: string[];
	/** Every `raw.githubusercontent.com` path that was requested, in order. */
	readonly rawRequests: string[];
	/** Whether Pages is on for `owner/name`. */
	pagesOn(owner: string, name: string): boolean;
	/** Every path the branch's current commit holds, sorted. Empty for a repository this fake lacks. */
	files(owner: string, name: string): string[];
	/** The bytes at one path in the branch's current commit, as text, or `null`. */
	fileText(owner: string, name: string, path: string): string | null;
	/**
	 * How many `POST /git/blobs` have arrived across every repository, refusals included.
	 *
	 * The one request count worth having: "the second send uploaded nothing" and "the refusal
	 * stopped the uploads rather than merely failing them" are claims about what was *sent*, and no
	 * assertion on the resulting tree can make either.
	 */
	blobPosts(): number;
	/** The commit the branch is on, or `null` when the repository is empty. */
	head(owner: string, name: string): string | null;
	/**
	 * Commit a change the browser did not make: another machine sending, or an edit on github.com.
	 *
	 * ⚠ **The only way to produce a *foreign* write**, which is what the send's conflict refusal is
	 * entirely about — every other way of changing a repository here goes through the app under test.
	 * Paths not named are left as they are; `null` removes one. It is the shared fake's own
	 * `commitFiles`, not a second way of writing bytes.
	 */
	commitFiles(
		owner: string,
		name: string,
		files: Readonly<Record<string, string | null>>
	): Promise<void>;
	/**
	 * How many byte reads `owner/name` has answered, refusals included.
	 *
	 * The fake's own counter rather than a length of {@link rawRequests}, so a spec asserting that a
	 * resumed Clone re-downloaded nothing is asserting the same number the domain tests assert.
	 */
	rawGets(owner: string, name: string): number;
	/**
	 * The most byte reads that were ever in flight at once, across every repository.
	 *
	 * A transfer's *shape* rather than its size, and the only counter here that can see it: a Workspace
	 * of ten thousand pyramid tiles fetched with one `Promise.all` and one fetched six at a time ask
	 * for the same paths and arrive at the same bytes, so no assertion on {@link rawRequests} or on
	 * what landed can tell them apart. Measured where the handler runs, so it reads 1 unless the spec
	 * holds the responses open long enough for an overlap to exist.
	 */
	peakRawInFlight(): number;
	/** Age every token the sign-in issued, as eight hours passing would. */
	expireSignIn(): void;
	/** Refuse the broker's refresh endpoint, so an expired sign-in cannot be renewed. */
	refuseRefresh(): void;
};

/**
 * The App the app under test is built with, re-exported so a spec need never write it down.
 *
 * Taking it from here is what keeps `scripts/check-github-broker.mjs` green: a spec that spelled the
 * broker's host out would be a second place to change on a repoint, which is the whole property that
 * fence exists to hold.
 */
export const SIGN_IN_APP: GitHubApp = GITHUB_APP;

const key = (owner: string, name: string): string => `${owner}/${name}`;

/** A 404 for a repository no fake holds, in GitHub's own words rather than the fake's. */
const notFound = (route: Route): Promise<void> =>
	route.fulfill({
		status: 404,
		contentType: 'application/json',
		body: JSON.stringify({ message: 'Not Found' })
	});

/**
 * Serve `api.github.com` and `raw.githubusercontent.com` from memory, and answer what was asked.
 *
 * Two hosts and deliberately not a third: `codeload.github.com` is routed nowhere, so a Clone that
 * reached for the tarball endpoint would meet the network fence's `net::ERR_BLOCKED_BY_CLIENT`
 * rather than quietly working in a test and failing in a browser (ADR-0031).
 *
 * @param target a `Page` for an ordinary spec, or a `BrowserContext` where a service worker is in
 *   play — see the header
 */
export async function routeGitHubHosts(
	target: Pick<Page, 'route' | 'url'> | Pick<BrowserContext, 'route'>,
	options: GitHubHostsOptions = {}
): Promise<GitHubHosts> {
	const requests: string[] = [];
	const rawRequests: string[] = [];
	let rawInFlight = 0;
	let peakRawInFlight = 0;
	const fakes = new Map<string, FakeGitHub>();

	/**
	 * The callback registered on the App, which is where the install screen returns to.
	 *
	 * ⚠ **Read at request time, and from the page rather than from a constant.** The install screen
	 * carries no `redirect_uri`, so the fake has to be told where to send the browser back to — and
	 * the address a real App registers is the one the editor is served from, which is exactly the
	 * page the departure left. Composed as origin plus pathname, because that is what
	 * `WorkspaceStorage` names at the exchange, and the two must match byte for byte.
	 *
	 * A `BrowserContext` has no current page, and no service-worker spec drives the install screen.
	 */
	const registeredCallback = (): string => {
		if (!('url' in target)) return '';
		const at = target.url();
		if (at === '' || at === 'about:blank') return '';
		const url = new URL(at);
		return `${url.origin}${url.pathname}`;
	};

	// The sign-in surface hangs off the first repository's fake, so a token it issues is one that
	// repository's API honours — see `GitHubHostsOptions.signIn`.
	let primary: FakeGitHub | null = null;

	for (const repository of options.repositories ?? []) {
		// A starting tree, so the repository has the `main` branch a Pages source names. A fake made
		// without one is a repository with no commits at all, which GitHub answers 409 and 422 about —
		// its own case, and not the one a spec asking for "a repository" means.
		const fake = await createFakeGitHub({
			owner: repository.owner,
			repository: repository.name,
			tree: repository.files ?? { 'README.md': '# Atlas\n' },
			...(options.signIn === true && primary === null
				? {
						signIn: {
							brokerOrigin: SIGN_IN_APP.brokerOrigin,
							clientId: SIGN_IN_APP.clientId,
							appSlug: SIGN_IN_APP.appSlug,
							callbackUrl: registeredCallback,
							login: options.login ?? repository.owner,
							tokenLifetimeSeconds: options.tokenLifetimeSeconds
						},
						// On the same fake as the sign-in, for the reason `GitHubHostsOptions.grants` gives.
						...(options.grants === undefined ? {} : { grants: options.grants })
					}
				: {})
		});
		primary ??= fake;
		if (options.login !== undefined) fake.login = options.login;
		fake.contributors = [...(repository.contributors ?? [repository.owner])];
		fake.permissions = { push: repository.push ?? true, admin: false };
		fake.privateRepository = repository.private ?? false;
		fake.pagesEnabled = repository.pagesEnabled ?? false;
		fake.refusePages = repository.refusePages ?? false;
		fake.rejectCredential = options.rejectCredential ?? false;
		fake.truncateAfter = repository.truncateAfter ?? null;
		if (repository.rateLimit) fake.rateLimit = { ...repository.rateLimit };
		fakes.set(key(repository.owner, repository.name), fake);
	}

	if (options.signIn === true && primary !== null) {
		// ⚠ **A fork with no App configured must not be routed at all.** `SIGN_IN_APP` is this
		// checkout's `GITHUB_APP`, and a fork that turns the front door off by emptying both values
		// (`github-app.ts`) would reduce the glob below to `'/**'` — which matches every request the
		// page makes, so this module would silently become the whole network. Said out loud instead:
		// the sign-in surface cannot be served where there is no App for it to be.
		if (!isGitHubAppConfigured(SIGN_IN_APP)) {
			throw new Error(
				'This checkout has no GitHub App configured, so the sign-in surface cannot be served and ' +
					'no spec can drive it. See packages/core/src/remote/github-app.ts.'
			);
		}
		const signInFake = primary;

		/** Forward a request into the fake and send back exactly what it answered. */
		const forward = async (route: Route): Promise<void> => {
			const request = route.request();
			requests.push(new URL(request.url()).pathname);
			const method = request.method();
			const response = await signInFake.fetch(request.url(), {
				method,
				headers: await request.allHeaders(),
				body: method === 'GET' || method === 'HEAD' ? undefined : (request.postData() ?? undefined)
			});
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: Buffer.from(await response.arrayBuffer())
			});
		};

		// GitHub's authorisation screen. The fake answers the 302 a user pressing "Authorize" produces,
		// so the browser follows it straight back to the callback — which is the whole round trip, with
		// no page on `github.com` ever being fetched.
		await target.route(`${GITHUB_AUTHORIZE_URL}*`, forward);
		// The App's own install screen, which a first-time author departs to instead. Same 302, same
		// callback, same code — the difference is on the way out, not on the way back.
		await target.route(`${GITHUB_APPS_URL}/${SIGN_IN_APP.appSlug}/installations/new*`, forward);
		// The broker's two endpoints, and nothing else on that origin (ADR-0031). Recorded before it
		// fails when the broker is unreachable, so a spec can tell "tried and could not" from
		// "never went near it".
		await target.route(`${SIGN_IN_APP.brokerOrigin}/**`, async (route) => {
			if (options.brokerUnreachable !== true) return forward(route);
			requests.push(new URL(route.request().url()).pathname);
			await route.abort('connectionfailed');
		});
	}

	await target.route(`${GITHUB_API_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		requests.push(url.pathname);

		const [scope, owner, name] = url.pathname.split('/').filter(Boolean);
		// `GET /user` is about the credential rather than about a repository, so it goes to the fake
		// holding the sign-in — the same one that issued the token being presented.
		const fake =
			scope === 'user'
				? (primary ?? undefined)
				: scope === 'repos' && owner && name
					? fakes.get(key(owner, name))
					: undefined;
		// ⚠ GitHub answers 404 for a repository that does not exist **and** for one the credential
		// cannot see, which is why the app's refusal names both.
		if (!fake) return notFound(route);

		const method = request.method();
		const response = await fake.fetch(request.url(), {
			method,
			headers: await request.allHeaders(),
			// undici refuses a GET or HEAD carrying one, and neither ever does.
			body: method === 'GET' || method === 'HEAD' ? undefined : (request.postData() ?? undefined)
		});
		await route.fulfill({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: Buffer.from(await response.arrayBuffer())
		});
	});

	// ⚠ **The raw host is a second route into the *same* fakes, never a second store of bytes.** A
	// Clone's file list comes from the API and its bytes come from here, and the two agreeing is the
	// whole of what makes a resumed Clone's blob-SHA comparison mean anything — a separate byte source
	// could serve content whose SHA the tree never named, and every assertion would still pass.
	//
	// It carries no credential and none is demanded: reading a public repository is anonymous, which
	// is what a Clone depends on (ADR-0031): Import's two operations are both unauthenticated.
	await target.route(`${GITHUB_RAW_ORIGIN}/**`, async (route) => {
		const url = new URL(route.request().url());
		rawRequests.push(url.pathname);

		const [owner, name] = url.pathname.split('/').filter(Boolean);
		const fake = owner && name ? fakes.get(key(owner, name)) : undefined;
		if (!fake) return notFound(route);

		rawInFlight += 1;
		peakRawInFlight = Math.max(peakRawInFlight, rawInFlight);
		try {
			const response = await fake.fetch(route.request().url());
			await route.fulfill({
				status: response.status,
				headers: Object.fromEntries(response.headers),
				body: Buffer.from(await response.arrayBuffer())
			});
		} finally {
			rawInFlight -= 1;
		}
	});

	const decoder = new TextDecoder();
	return {
		requests,
		rawRequests,
		pagesOn: (owner, name) => fakes.get(key(owner, name))?.pagesEnabled ?? false,
		files: (owner, name) => [...(fakes.get(key(owner, name))?.files().keys() ?? [])].sort(),
		fileText: (owner, name, path) => {
			const bytes = fakes.get(key(owner, name))?.files().get(path);
			return bytes === undefined ? null : decoder.decode(bytes);
		},
		blobPosts: () => [...fakes.values()].reduce((sum, fake) => sum + fake.blobPosts, 0),
		head: (owner, name) => fakes.get(key(owner, name))?.head() ?? null,
		commitFiles: async (owner, name, files) => {
			const fake = fakes.get(key(owner, name));
			if (fake === undefined) {
				throw new Error(`No fake repository at ${key(owner, name)} to commit to.`);
			}
			await fake.commitFiles(files);
		},
		rawGets: (owner, name) => fakes.get(key(owner, name))?.rawGets ?? 0,
		peakRawInFlight: () => peakRawInFlight,
		expireSignIn: () => primary?.expireIssuedTokens(),
		refuseRefresh: () => {
			if (primary !== null) primary.refuseRefresh = true;
		}
	};
}
