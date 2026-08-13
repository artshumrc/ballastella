// The GitHub every spec in the publish epic talks to, installed as Playwright routes.
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
// SPEC's Seam 2: *the end-to-end suite, against the same fake through Playwright routes.* Ticket 01
// wrote that fake before its first consumer for one reason — `iiif-hosts`'s lesson, where three
// specs grew their own IIIF hosts and two of them could disagree about what a service does while
// both stayed green. So everything below the `route.fulfill` is `packages/core`'s fake, reached by
// a relative import; only the request and the response are translated.
//
// ⚠ **A second hand-written GitHub stood here, and it had already drifted in the one place that
// matters.** On an unauthenticated `GET /repos/{owner}/{repo}` it omitted `permissions` while the
// shared fake sent it, and a missing `permissions` is what `bind-remote.ts` maps to `canPush:
// false` — so the two fakes gave *opposite* answers on the field deciding whether the scholar is
// told their token cannot push. That is exactly the failure ticket 01 exists to prevent, arriving
// within one ticket of the fake being written. Where the two disagreed, real GitHub won: the
// omission was right and now lives in the shared fake, along with `refusePages`, `rejectCredential`
// and the 422 a Pages request meets when the repository has no branches yet.
//
// **The import works, and the claim that it could not was measured to be false.** The workspace
// `tsconfig.json`'s `include` governs which files are compilation *roots*, not what they may
// import; this file typechecks, lints, and runs unchanged. (`support/test.ts` still spells
// `DEFAULT_WORKSPACE` out as a literal, which is a different and much cheaper judgement: one word,
// and a rename that missed it fails every spec loudly.)

import {
	createFakeGitHub,
	type FakeGitHub,
	type FakeRateLimit
} from '../../packages/core/src/remote/fake-github.js';
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
	 * `{}` for a repository with a commit and no files, and pass files a publish must **not** touch —
	 * a `CNAME`, a `docs/` folder — to assert ADR-0033's owned namespace from a browser.
	 */
	readonly files?: Readonly<Record<string, string>>;
	/** What `GET /repos/{owner}/{repo}` reports about the caller. */
	readonly push?: boolean;
	/** `POST /pages` answers 409 when this is already true, and turns it on when it is not. */
	readonly pagesEnabled?: boolean;
	/** Answer 403 to `POST /pages`: a token with `contents: write` and no `pages: write`. */
	readonly refusePages?: boolean;
	/**
	 * Cut every tree listing short after this many entries and report `truncated: true`.
	 *
	 * The real endpoint truncates at 100 000 entries or 7 MB **and still answers 200**, which is why
	 * a publish that did not look would commit a tree missing most of a Workspace.
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
};

/**
 * What the fake was asked, and — the half that matters — what it now holds.
 *
 * ⚠ **SPEC's testing decision in as many words: *a good test here asserts what arrived at the
 * Remote, not which calls were made.*** Every failure mode in this epic is silent and plausible: a
 * truncated tree yields a commit missing most of a pyramid, an off-by-one in the owned namespace
 * deletes a `CNAME`. A spec counting requests passes over both, so {@link GitHubHosts.files} is what
 * a publish is asserted on and {@link GitHubHosts.requests} is for the one claim of the opposite
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
	 * The one request count worth having: "the second publish uploaded nothing" and "the refusal
	 * stopped the uploads rather than merely failing them" are claims about what was *sent*, and no
	 * assertion on the resulting tree can make either.
	 */
	blobPosts(): number;
	/** The commit the branch is on, or `null` when the repository is empty. */
	head(owner: string, name: string): string | null;
	/**
	 * How many byte reads `owner/name` has answered, refusals included.
	 *
	 * The fake's own counter rather than a length of {@link rawRequests}, so a spec asserting that a
	 * resumed Clone re-downloaded nothing is asserting the same number the domain tests assert.
	 */
	rawGets(owner: string, name: string): number;
};

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
	target: Pick<Page | BrowserContext, 'route'>,
	options: GitHubHostsOptions = {}
): Promise<GitHubHosts> {
	const requests: string[] = [];
	const rawRequests: string[] = [];
	const fakes = new Map<string, FakeGitHub>();

	for (const repository of options.repositories ?? []) {
		// A starting tree, so the repository has the `main` branch a Pages source names. A fake made
		// without one is a repository with no commits at all, which GitHub answers 409 and 422 about —
		// its own case, and not the one a spec asking for "a repository" means.
		const fake = await createFakeGitHub({
			owner: repository.owner,
			repository: repository.name,
			tree: repository.files ?? { 'README.md': '# Atlas\n' }
		});
		fake.permissions = { push: repository.push ?? true, admin: false };
		fake.pagesEnabled = repository.pagesEnabled ?? false;
		fake.refusePages = repository.refusePages ?? false;
		fake.rejectCredential = options.rejectCredential ?? false;
		fake.truncateAfter = repository.truncateAfter ?? null;
		if (repository.rateLimit) fake.rateLimit = { ...repository.rateLimit };
		fakes.set(key(repository.owner, repository.name), fake);
	}

	await target.route(`${GITHUB_API_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		requests.push(url.pathname);

		const [scope, owner, name] = url.pathname.split('/').filter(Boolean);
		const fake = scope === 'repos' && owner && name ? fakes.get(key(owner, name)) : undefined;
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
	// is what a Clone depends on (ADR-0031, SPEC "Import: two operations, both unauthenticated").
	await target.route(`${GITHUB_RAW_ORIGIN}/**`, async (route) => {
		const url = new URL(route.request().url());
		rawRequests.push(url.pathname);

		const [owner, name] = url.pathname.split('/').filter(Boolean);
		const fake = owner && name ? fakes.get(key(owner, name)) : undefined;
		if (!fake) return notFound(route);

		const response = await fake.fetch(route.request().url());
		await route.fulfill({
			status: response.status,
			headers: Object.fromEntries(response.headers),
			body: Buffer.from(await response.arrayBuffer())
		});
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
		rawGets: (owner, name) => fakes.get(key(owner, name))?.rawGets ?? 0
	};
}
