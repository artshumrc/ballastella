// The one GitHub every test that needs one talks to.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS ONE MODULE, WRITTEN BEFORE ITS FIRST CONSUMER
//
// `e2e/support/iiif-hosts.ts` is the same module written *after* the fact: three specs had grown
// their own IIIF hosts, byte-identical in two of the three and subtly different in the third, so a
// spec asserting a service's behaviour was asserting the behaviour of *its copy* of that service —
// and two specs could disagree about what a level 0 host does while both stayed green. The Remote
// layer needs a GitHub in a dozen places. This is that module built in advance rather than extracted
// from the wreckage afterwards.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT IS NOT A MOCK
//
// It stores real bytes, computes **real** git blob SHAs through {@link gitBlobSha}, and its trees
// are readable back as `path → bytes`. That is what lets a test assert *what arrived at the Remote*
// rather than which calls were made — the distinction every test here rests on, because every
// failure mode is silent and plausible: a truncated tree yields a commit missing most of a pyramid,
// an off-by-one in the owned namespace deletes a `CNAME`, and a test counting requests passes over
// both.
//
// Tree and commit identifiers are content-addressed hashes of a serialisation of their own, **not**
// git's object hashes — git frames those differently, and nothing here re-derives one.
// Blob SHAs are the only identifiers anything computes on both sides of the wire, and those are
// exact.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// EVERYTHING UNIMPLEMENTED IS A 404
//
// A fake that answers vacuously is worse than no fake: the engine passes here and fails against
// GitHub, which is the one place nobody is watching. So the router recognises exactly the requests
// Ballastella makes and refuses everything else — an unknown path with a 404, and a *known* path
// carrying a field this fake does not model (`base_tree`) with a 400 that says so.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';
import { GITHUB_APPS_URL, GITHUB_AUTHORIZE_URL } from './github-sign-in.js';

/** One entry of a tree listing, as `GET /git/trees/{ref}?recursive=1` reports it. */
export type FakeTreeEntry = {
	readonly path: string;
	readonly mode: string;
	/** `commit` is a gitlink: a submodule, pointing at a commit in another repository. */
	readonly type: 'blob' | 'tree' | 'commit';
	readonly sha: string;
	/** Blobs only, as on the real endpoint. */
	readonly size?: number;
};

export type FakeGitHubOptions = {
	readonly owner: string;
	readonly repository: string;
	/** The branch the starting tree is committed on, and the one `files()` reads. */
	readonly branch?: string;
	/**
	 * What the repository already holds, committed as its first commit.
	 *
	 * **Omit it for an empty repository** — no commit and no ref at all, which is the repository
	 * `github.com/new` makes with nothing ticked. Reads and writes of the git database both answer
	 * 409 `Git Repository is empty.` in that state, so a first publish has to open it through the
	 * Contents API before it can send anything.
	 */
	readonly tree?: Readonly<Record<string, string | Uint8Array>>;
	/**
	 * Submodules the repository already holds: path → the commit SHA the gitlink points at.
	 *
	 * A gitlink has no bytes anywhere in this repository, so it never appears in {@link FakeGitHub.files}
	 * — read it back through {@link FakeGitHub.gitlinks}. It is here because a publish must carry one
	 * through untouched (ADR-0033) and a listing filtered to blobs would drop it silently.
	 */
	readonly submodules?: Readonly<Record<string, string>>;
	/**
	 * Turn on the GitHub App sign-in surface: the two departure screens, and the broker's two
	 * endpoints.
	 *
	 * ⚠ **The broker is faked *here*, in the one fake, and not in a second module.** It is not GitHub,
	 * but ADR-0031 makes it a pass-through — it answers *GitHub's token JSON verbatim* — so what it
	 * says is GitHub's answer, and modelling it anywhere else would be a second fake free to disagree
	 * with this one about whether a code is spent or a token has expired. That is precisely the
	 * failure this single fake exists to prevent, and the one `e2e/support/github-hosts.ts` records
	 * having already had once.
	 *
	 * Omit it and none of those three addresses are served, which is what every spec that does not
	 * exercise sign-in expects.
	 */
	readonly signIn?: FakeSignInOptions;
	/**
	 * The repositories this author has granted the App access to, as the two installation endpoints
	 * report them.
	 *
	 * Omit it for an author who has granted nothing: `GET /user/installations` then answers an empty
	 * list — which is what GitHub answers for somebody who has never installed the App, and what the
	 * guided sequence's `no-choices` step is about. {@link FakeGitHub.grant} creates the installation
	 * in that state, so a spec can start from nothing and watch a grant arrive.
	 */
	readonly grants?: FakeGrants;
};

/** One repository in an installation, as {@link FakeGrants} takes it. */
export type FakeGrantedRepository = {
	readonly owner: string;
	readonly repository: string;
	/** `permissions.push`, which is what decides whether the author may publish to it. */
	readonly push: boolean;
	/**
	 * `permissions.admin`, which is what decides whether the author can widen the grant themselves.
	 *
	 * Defaults to `false`, so a spec that means "and they administer it" has to say so — the case
	 * where somebody must be asked instead is the one that goes wrong quietly.
	 */
	readonly admin?: boolean;
	/** Defaults to public, which is the only kind that can serve a Published Site on the free tier. */
	readonly private?: boolean;
};

/** One installation of the App on one account, and the repositories it was given. */
export type FakeGrants = {
	readonly installationId: number;
	readonly account: string;
	readonly repositories: readonly FakeGrantedRepository[];
	/**
	 * The account's own identifier, which is what a preselect link's `suggested_target_id` carries.
	 *
	 * ⚠ **Never equal to {@link installationId} unless a spec says so.** The two are separate numbers
	 * on GitHub and a fake that defaulted them the same would pass a reader that used the wrong one.
	 */
	readonly targetId?: number;
	/** `repository_selection`. Defaults to `selected`, which is the state with a grant step in it. */
	readonly repositorySelection?: 'all' | 'selected';
	/** `account.type` and `target_type`, which GitHub reports as the same answer twice. */
	readonly accountType?: 'User' | 'Organization';
};

/**
 * An account identifier for an installation whose spec did not name one.
 *
 * Offset so that it can never collide with an installation id a spec wrote, which is what keeps a
 * reader that confused the two from passing here.
 */
const defaultTargetId = (installationId: number): number => installationId + 1_000_000;

/** The App and the broker a {@link FakeGitHub} answers as, when it answers as one at all. */
export type FakeSignInOptions = {
	/** The broker's origin, matching the `GitHubApp` the code under test was configured with. */
	readonly brokerOrigin: string;
	/** The client ID the authorize URL and both broker calls must carry, or they are refused. */
	readonly clientId: string;
	/** The slug the install screen hangs off, matching the `GitHubApp` the code was configured with. */
	readonly appSlug: string;
	/**
	 * Where the install screen redirects back to — the callback registered on the App.
	 *
	 * ⚠ **The install screen carries no `redirect_uri`**, unlike the authorize screen: GitHub returns
	 * to the App's registered callback and there is no parameter to override it with. So the fake has
	 * to be told, and the exchange that follows must name the same address or GitHub answers
	 * `redirect_uri_mismatch`. A thunk is allowed because a browser test installs its routes before
	 * the page they will come back to has an address.
	 */
	readonly callbackUrl?: string | (() => string);
	/** The account a completed sign-in is as, reported by `GET /user`. */
	readonly login?: string;
	/** How long an issued token lasts. GitHub's user-to-server token is eight hours. */
	readonly tokenLifetimeSeconds?: number;
};

/** What the repository reports about the caller's rights, at `GET /repos/{owner}/{repo}`. */
export type FakeRepositoryPermissions = { push: boolean; admin: boolean };

/** The hourly budget, as the two headers the browser is allowed to read report it. */
export type FakeRateLimit = {
	remaining: number;
	/** Unix seconds, as GitHub sends it. */
	reset: number;
};

export interface FakeGitHub {
	/** Hand this to the code under test in place of the page's own `fetch`. */
	readonly fetch: FetchFn;

	/**
	 * How many `POST /git/blobs` calls have arrived, counting those {@link refuseWrites} turned away.
	 *
	 * It measures what the engine sent, not what the store accepted, so a test can assert *"the second
	 * publish uploaded nothing"* without asserting a call order — which would pass over an engine that
	 * uploaded everything in a different sequence — and can assert that a refusal stopped the uploads
	 * rather than merely failed them.
	 */
	readonly blobPosts: number;

	/**
	 * How many byte reads have arrived at `raw.githubusercontent.com`, counting those answered 404.
	 *
	 * {@link blobPosts}'s counterpart on the read side, and it measures the same thing for the same
	 * reason: what the engine *asked for*, not what it got. A Clone resumes by skipping paths it
	 * already holds (`clone-from-remote.ts`), and "already holds" is a claim only this counter can
	 * check — an engine that re-downloaded every file and then wrote the same bytes back would leave a
	 * Workspace indistinguishable from a resumed one, and pass any assertion made on the result.
	 */
	readonly rawGets: number;

	/**
	 * Every file a commit holds, path → a copy of its bytes, sorted by path.
	 *
	 * Takes a branch name or a commit SHA, so a test can ask what an *earlier* commit held rather
	 * than only what survived to the head — the question "every commit a publish writes carries
	 * `.nojekyll`" cannot be asked of the head alone.
	 */
	files(ref?: string): Map<string, Uint8Array>;

	/** Every submodule a commit holds, path → the commit SHA it points at. Takes a branch or a SHA. */
	gitlinks(ref?: string): Map<string, string>;

	/** The branch's current commit, or `null` when the repository is empty. */
	head(branch?: string): string | null;

	/** The commit chain from `head` back through its parents, newest first. */
	history(branch?: string): string[];

	/**
	 * Commit a change nothing here made: a scholar editing a file on github.com, or another machine.
	 *
	 * ⚠ **The only way to produce a *foreign* write**, and that is what it is for. A publish's
	 * conflict refusal is entirely about writes this app did not make, and every other way of
	 * changing this repository goes through the publish engine — so a test that built one that way
	 * would be asserting that the engine agrees with itself.
	 *
	 * Paths not named are left exactly as they are, and `null` removes one. The commit is parented
	 * onto whatever the branch held, so the history reads as it would on the real host.
	 *
	 * @returns the commit the branch now holds
	 */
	commitFiles(
		files: Readonly<Record<string, string | Uint8Array | null>>,
		branch?: string
	): Promise<string>;

	/**
	 * Cut every tree listing short after this many entries and report `truncated: true`.
	 *
	 * The real endpoint truncates at 100 000 entries or 7 MB **and still answers 200**, which is
	 * why proceeding is a commit missing most of a Workspace rather than an error.
	 */
	truncateAfter: number | null;

	/**
	 * Answer 403 to every write to the git database — blobs, trees, commits, and refs alike.
	 *
	 * That is the whole set, because that is what a token without `contents: write` meets: the
	 * refusal does not wait for the ref to move, and an engine that discovers it there has already
	 * uploaded a pyramid.
	 */
	refuseWrites: boolean;

	/**
	 * Answer 401 `Bad credentials` to every API request that carries a credential.
	 *
	 * An expired or revoked token, which is a different failure from {@link refuseWrites}: that one
	 * is a good token without a permission, and this one is a token GitHub will not look at. Requests
	 * carrying **no** credential are unaffected, as on the real API — a public repository's metadata
	 * and file list stay readable, which is what Clone and Review depend on.
	 */
	rejectCredential: boolean;

	/**
	 * Answer 403 to `POST /pages`: a token with `contents: write` and no `pages: write`.
	 *
	 * Separate from {@link refuseWrites} because Pages enablement is a different permission from the
	 * git database's, and the common token a scholar makes by hand has the second and not the first —
	 * so a repository fills with correct files and serves nothing.
	 */
	refusePages: boolean;

	/** What `GET /repos/{owner}/{repo}` reports. Independent of {@link refuseWrites} on purpose. */
	permissions: FakeRepositoryPermissions;

	/** Whether Pages is on. `POST /pages` answers 409 when it is, and turns it on when it is not. */
	pagesEnabled: boolean;

	/**
	 * Grant access to one more repository, as the author would on GitHub's own screen.
	 *
	 * The only way to model a repository being granted while the editor is open, which is the return
	 * from the second tab the guided sequence watches for. On a fake configured with no
	 * {@link FakeGitHubOptions.grants} it creates the installation as well.
	 */
	grant(repository: FakeGrantedRepository): void;

	/**
	 * Answer 404 on `raw.githubusercontent.com` to any read carrying no credential.
	 *
	 * Private repositories are out of scope and nothing here refuses one, which is the whole reason
	 * this knob exists: a check that reads a file from the raw host without a credential does not
	 * *fail* on a private repository, it reads "there is no such file" and passes. That is how the
	 * bind-time subset refusal was silently inert on exactly the repository whose owner is most likely
	 * to have two machines.
	 *
	 * ⚠ **Default `false`, and that matters as much as the knob.** A public repository's bytes are
	 * read here with no credential at all, so the ordinary raw host must not so much as *look* at an
	 * `Authorization` header — a fake that demanded one everywhere would hide a Clone sending a token
	 * it has no business sending.
	 */
	privateRepository: boolean;

	rateLimit: FakeRateLimit;

	// ── The GitHub App sign-in, present whether or not `signIn` was asked for ──────────────────
	//
	// The knobs exist unconditionally so a spec can read them without narrowing a type; what `signIn`
	// decides is whether the three addresses are *served*.

	/** The account `GET /user` reports. Only ever asked with a credential. */
	login: string;

	/**
	 * Refuse the code-for-token exchange, in GitHub's own shape: `{ error, error_description }`.
	 *
	 * ⚠ GitHub answers a refused exchange **in the body**, and historically with a 200, which is why
	 * this is modelled as a body rather than a status. A fake that answered 400 would let an engine
	 * that only checks `response.ok` pass.
	 */
	refuseExchange: boolean;

	/** Refuse the refresh endpoint the same way: the refresh token has expired or been revoked. */
	refuseRefresh: boolean;

	/**
	 * Age every token this fake has issued, as eight hours passing would.
	 *
	 * The API then answers 401 to them, which is what an expired user-to-server token does. Separate
	 * from {@link rejectCredential}, which refuses *every* credential including a pasted one — this
	 * refuses only what this fake handed out, so a spec can expire an App sign-in and leave a pasted
	 * token working in the same browser.
	 */
	expireIssuedTokens(): void;

	/** Every authorisation code this fake has issued, in order, so a spec can replay or forge one. */
	readonly issuedCodes: string[];
}

/** A tree object: the flat `path → blob` map the API's own tree parameter describes. */
type StoredTree = ReadonlyMap<string, { readonly sha: string; readonly mode: string }>;

type StoredCommit = {
	readonly message: string;
	readonly tree: string;
	readonly parents: readonly string[];
};

const encoder = new TextEncoder();

/**
 * A content-addressed identifier of the right shape for a tree or a commit.
 *
 * Not git's own — see the header. It goes through {@link gitBlobSha} rather than a second call to
 * `crypto.subtle` so that this module has exactly one hash in it.
 */
const objectId = (serialised: string): Promise<string> => gitBlobSha(encoder.encode(serialised));

const serialiseTree = (tree: StoredTree): string =>
	[...tree]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([path, entry]) => `${entry.mode} ${path}\0${entry.sha}`)
		.join('\n');

const serialiseCommit = (commit: StoredCommit): string =>
	`tree ${commit.tree}\n${commit.parents.map((parent) => `parent ${parent}\n`).join('')}\n${commit.message}`;

const byPath = (left: { path: string }, right: { path: string }): number =>
	left.path < right.path ? -1 : left.path > right.path ? 1 : 0;

// `Uint8Array<ArrayBuffer>` throughout, not the `ArrayBufferLike` default: a `Response` body will
// not take a view onto a `SharedArrayBuffer`, and this is where the bytes go out.
const bytesOf = (content: string | Uint8Array): Uint8Array<ArrayBuffer> =>
	typeof content === 'string' ? encoder.encode(content) : new Uint8Array(content);

/** Base64 as the blob endpoint takes it. `atob` ignores the line breaks GitHub's clients insert. */
const decodeBase64 = (content: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(content), (character) => character.charCodeAt(0));

/** The modes a blob entry may carry. A tree posted with any other is a 422 on the real endpoint. */
const BLOB_MODES = new Set(['100644', '100755', '120000']);

/** The one mode a gitlink carries, and the only thing that tells a submodule from a file in a tree. */
const GITLINK_MODE = '160000';

/**
 * The segments of a path, or `null` when it does not decode.
 *
 * A stray `%` is a `URIError` out of `decodeURIComponent`, and a {@link FetchFn} is a `fetch` drop-in:
 * it resolves with a `Response` or the caller's error handling never runs. GitHub answers 404.
 */
const decodePath = (pathname: string): string[] | null => {
	try {
		return pathname.split('/').filter(Boolean).map(decodeURIComponent);
	} catch {
		return null;
	}
};

/** GitHub takes either spelling of the credential, and this fake looks no closer than that. */
const bearsToken = (request: Request): boolean =>
	/^\s*(?:bearer|token)\s+\S+/i.test(request.headers.get('authorization') ?? '');

const DEFAULT_HOURLY_REQUESTS = 5000;

/**
 * An in-memory GitHub answering the requests Ballastella makes, behind a {@link FetchFn}.
 *
 * Async because seeding the starting tree computes real blob SHAs.
 */
export async function createFakeGitHub(options: FakeGitHubOptions): Promise<FakeGitHub> {
	const defaultBranch = options.branch ?? 'main';

	const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
	const trees = new Map<string, StoredTree>();
	const commits = new Map<string, StoredCommit>();
	const refs = new Map<string, string>();

	let blobPosts = 0;
	let rawGets = 0;

	// ── What the App has been granted, which is not the same question as what this repository is ──
	//
	// An installation lists the repositories the *author* gave the App access to. This fake is one
	// repository, and it need not be among them — a student who created `atlas` and granted nothing is
	// exactly that state.
	let grants: {
		installationId: number;
		account: string;
		targetId: number;
		repositorySelection: 'all' | 'selected';
		accountType: 'User' | 'Organization';
		repositories: FakeGrantedRepository[];
	} | null =
		options.grants === undefined
			? null
			: {
					installationId: options.grants.installationId,
					account: options.grants.account,
					targetId: options.grants.targetId ?? defaultTargetId(options.grants.installationId),
					repositorySelection: options.grants.repositorySelection ?? 'selected',
					accountType: options.grants.accountType ?? 'User',
					repositories: [...options.grants.repositories]
				};

	const state = {
		truncateAfter: null as number | null,
		refuseWrites: false,
		rejectCredential: false,
		refusePages: false,
		permissions: { push: true, admin: true } as FakeRepositoryPermissions,
		pagesEnabled: false,
		privateRepository: false,
		rateLimit: {
			remaining: DEFAULT_HOURLY_REQUESTS,
			reset: Math.floor(Date.now() / 1000) + 3600
		} as FakeRateLimit,
		login: options.signIn?.login ?? 'ada',
		refuseExchange: false,
		refuseRefresh: false
	};

	// ── The GitHub App sign-in's own state ────────────────────────────────────────────────────
	//
	// Codes are single-use, because a spent code is the refusal a scholar actually meets: going back
	// to a callback page that is still open in another tab replays one every time.

	/** Authorisation codes this fake has issued: code → the redirect it was issued for, and whether
	 *  it has been spent. */
	const codes = new Map<string, { redirectUri: string; spent: boolean }>();
	/** Bearer tokens this fake has issued, and whether each has been aged past its expiry. */
	const issuedTokens = new Map<string, { expired: boolean }>();
	/** Refresh tokens, each pointing at nothing but its own right to mint a new bearer token. */
	const refreshTokens = new Set<string>();
	const issuedCodes: string[] = [];
	let issued = 0;

	/** A value no test needs to predict, but which is stable and readable when one fails. */
	const nextValue = (prefix: string): string => {
		issued += 1;
		return `${prefix}_${issued.toString().padStart(4, '0')}`;
	};

	const storeTree = async (entries: StoredTree): Promise<string> => {
		const sha = await objectId(serialiseTree(entries));
		trees.set(sha, entries);
		return sha;
	};

	const storeCommit = async (commit: StoredCommit): Promise<string> => {
		const sha = await objectId(serialiseCommit(commit));
		commits.set(sha, commit);
		return sha;
	};

	if (options.tree || options.submodules) {
		const entries = new Map<string, { sha: string; mode: string }>();
		for (const [path, content] of Object.entries(options.tree ?? {})) {
			const bytes = bytesOf(content);
			const sha = await gitBlobSha(bytes);
			blobs.set(sha, bytes);
			entries.set(path, { sha, mode: '100644' });
		}
		for (const [path, sha] of Object.entries(options.submodules ?? {})) {
			entries.set(path, { sha, mode: GITLINK_MODE });
		}
		const tree = await storeTree(entries);
		refs.set(defaultBranch, await storeCommit({ message: 'Initial commit', tree, parents: [] }));
	}

	const treeAt = (branch: string): StoredTree | null => {
		const at = refs.get(branch);
		const commit = at === undefined ? undefined : commits.get(at);
		return commit === undefined ? null : (trees.get(commit.tree) ?? null);
	};

	/**
	 * The tree a `{ref}` names: a branch, a commit, or a tree, in that order.
	 *
	 * The real endpoint takes all three, and an engine that hands it a commit SHA — which a resumed
	 * Clone reasonably might — must not meet a fake that only knows branch names.
	 */
	const resolveTree = (ref: string): StoredTree | null => {
		const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
		if (refs.has(branch)) return treeAt(branch);
		const commit = commits.get(ref);
		if (commit) return trees.get(commit.tree) ?? null;
		return trees.get(ref) ?? null;
	};

	/** A ref's tree as path-ordered pairs, which is how both readers below hand it out. */
	const sortedTree = (ref: string): [string, { readonly sha: string; readonly mode: string }][] =>
		[...(resolveTree(ref) ?? [])].sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0
		);

	/** The listing, with the directory entries a real recursive listing carries. */
	const listing = async (tree: StoredTree): Promise<FakeTreeEntry[]> => {
		const directories = new Set<string>();
		for (const path of tree.keys()) {
			const segments = path.split('/');
			for (let depth = 1; depth < segments.length; depth += 1) {
				directories.add(segments.slice(0, depth).join('/'));
			}
		}

		// A gitlink is told from a file by its mode and by nothing else, and it carries no size: there
		// are no bytes for it here, because they live in another repository entirely.
		const entries: FakeTreeEntry[] = [...tree].map(([path, entry]) =>
			entry.mode === GITLINK_MODE
				? { path, mode: entry.mode, type: 'commit' as const, sha: entry.sha }
				: {
						path,
						mode: entry.mode,
						type: 'blob' as const,
						sha: entry.sha,
						size: blobs.get(entry.sha)?.byteLength ?? 0
					}
		);

		for (const directory of directories) {
			const prefix = `${directory}/`;
			// Keyed relative to the directory, the way the subtree object itself is: keyed by full path
			// instead, `images` and `images/one` can hash alike, and a repository whose files all sit
			// under one directory gives that directory the root tree's own SHA.
			const under = new Map(
				[...tree]
					.filter(([path]) => path.startsWith(prefix))
					.map(([path, entry]) => [path.slice(prefix.length), entry] as const)
			);
			// Registered, not merely named: a listing hands these SHAs out, and `GET /git/trees/{sha}`
			// for one the fake just advertised has to resolve rather than 404.
			entries.push({ path: directory, mode: '040000', type: 'tree', sha: await storeTree(under) });
		}

		return entries.sort(byPath);
	};

	/**
	 * On **every** response, including refusals and the raw host.
	 *
	 * The engine reads its remaining budget as it goes, and it can read these at all only because
	 * `api.github.com` names them in `access-control-expose-headers` — so a response that carried
	 * none would be a budget that silently stopped being tracked.
	 */
	const headers = (): Record<string, string> => ({
		'X-RateLimit-Remaining': String(state.rateLimit.remaining),
		'X-RateLimit-Reset': String(state.rateLimit.reset),
		// ⚠ **The CORS pair is not decoration, and it is why ADR-0031 holds at all.** Measured:
		// `api.github.com` answers `access-control-allow-origin: *` and *names* both rate-limit headers
		// in `access-control-expose-headers`. The two do different jobs, and only the second is about
		// the budget: without the **origin** header a cross-origin response is not readable at all —
		// `fetch` rejects and the publish reports a network failure — while without the **expose**
		// header the response arrives and every unexposed header is hidden, so the budget reads `null`
		// end to end: no request warning before a publish, no count in the progress line, and a spent
		// budget mid-publish reported as an ordinary refusal rather than as a wait.
		//
		// Both are carried so a fake driven through Playwright routes fails the way GitHub would.
		// **What this does not model is the preflight.** Every request here carries `Authorization`,
		// which is never CORS-safelisted, so a real browser sends `OPTIONS` first and neither this fake
		// nor `e2e/support/github-hosts.ts` answers one — `route.fulfill` short-circuits the preflight,
		// and through an injected `fetch` there is no CORS at all. So these headers are a record of
		// what the real host sends, checked by nothing in this repository.
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Expose-Headers': 'X-RateLimit-Remaining, X-RateLimit-Reset'
	});

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { ...headers(), 'content-type': 'application/json' }
		});

	const problem = (status: number, message: string): Response => json({ message }, status);

	/**
	 * One page of a listing, cut the way `per_page` and `page` cut it, with a truthful `total_count`.
	 *
	 * ⚠ **The numbers are GitHub's own: 30 by default and 100 at most.** A fake that handed back the
	 * whole list whatever was asked would let a reader that never looks past its first page pass here
	 * and show a student a list their own repository is missing from.
	 */
	const paginated = <T>(items: readonly T[], url: URL): { total_count: number; page: T[] } => {
		const askedSize = Number(url.searchParams.get('per_page'));
		const perPage = Number.isFinite(askedSize) && askedSize > 0 ? Math.min(askedSize, 100) : 30;
		const askedPage = Number(url.searchParams.get('page'));
		const page = Number.isFinite(askedPage) && askedPage > 0 ? Math.floor(askedPage) : 1;
		return {
			total_count: items.length,
			page: items.slice((page - 1) * perPage, page * perPage)
		};
	};
	const notFound = (message = 'Not Found') => problem(404, message);

	/**
	 * What a read of the git database answers for a ref it cannot resolve.
	 *
	 * ⚠ **A repository with no commits answers 409 `Git Repository is empty.`, not 404**, and the
	 * difference decides whether a first publish to a repository the scholar created a moment ago
	 * works at all: read as an ordinary failure it stops the publish at plan time, with a message
	 * about a repository that is perfectly fine. A repository that has branches but not this one is
	 * the 404 it always was.
	 */
	const emptyOrMissing = (ref: string): Response =>
		refs.size === 0 ? problem(409, 'Git Repository is empty.') : notFound(`${ref} is not a ref.`);

	/**
	 * The same 409, for the **writes**.
	 *
	 * ⚠ **A repository with no commits refuses the whole Git Data API, not only the ref read.**
	 * `POST /git/blobs` answers 409 `Git Repository is empty.` on real GitHub, so there is no order of
	 * blob, tree and commit calls that opens an empty repository — the Contents API below is the only
	 * way in. A fake that accepted objects here was more permissive than GitHub in the one direction
	 * that mattered: every first-publish test passed while the first publish anybody actually made
	 * failed at its first blob, on the repository the tool's own link tells them to create.
	 */
	const emptyForWrites = (): Response | null =>
		refs.size === 0 ? problem(409, 'Git Repository is empty.') : null;

	const answerApi = async (
		url: URL,
		method: string,
		credentialed: boolean,
		body: () => Promise<Record<string, unknown>>
	): Promise<Response> => {
		const path = decodePath(url.pathname);
		if (path === null) return notFound(`${url.pathname} is not a path this fake implements.`);

		// `GET /user` — whose credential this is, which is the identity the bar shows after a
		// sign-in. Authenticated, because an anonymous caller has no identity to report.
		if (path.length === 1 && path[0] === 'user' && method === 'GET') {
			return credentialed ? json({ login: state.login }) : problem(401, 'Requires authentication');
		}

		// `GET /user/installations` and `GET /user/installations/{id}/repositories` — the two endpoints
		// documented for a GitHub App *user* access token to read a repository listing from, and the only
		// two the guided sequence calls. Authenticated: an installation belongs to whoever is signed in,
		// and there is nothing for an anonymous caller to be told about.
		if (path[0] === 'user' && path[1] === 'installations' && method === 'GET') {
			if (!credentialed) return problem(401, 'Requires authentication');
			if (path.length === 2) {
				const installations =
					grants === null
						? []
						: [
								{
									id: grants.installationId,
									account: { login: grants.account, type: grants.accountType },
									target_id: grants.targetId,
									target_type: grants.accountType,
									repository_selection: grants.repositorySelection
								}
							];
				const listed = paginated(installations, url);
				return json({ total_count: listed.total_count, installations: listed.page });
			}
			if (
				path.length === 4 &&
				path[3] === 'repositories' &&
				grants !== null &&
				path[2] === String(grants.installationId)
			) {
				const reported = grants.repositories.map((one, at) => ({
					id: at + 1,
					name: one.repository,
					full_name: `${one.owner}/${one.repository}`,
					private: one.private === true,
					permissions: { push: one.push, admin: one.admin === true }
				}));
				const listed = paginated(reported, url);
				return json({ total_count: listed.total_count, repositories: listed.page });
			}
			return notFound(`${url.pathname} is not a path this fake implements.`);
		}

		const [scope, owner, repository, ...rest] = path;
		if (scope !== 'repos' || owner !== options.owner || repository !== options.repository) {
			return notFound(`${url.pathname} is not a path this fake implements.`);
		}

		/**
		 * A credential is demanded of writes and of nothing else, which is what GitHub does.
		 *
		 * **The reads below are answered unauthenticated on purpose.** A public repository's file list
		 * and its metadata are readable with no credential at all, and the Import operations depend on
		 * that: Clone and Review are unauthenticated, so a fake that demanded a token everywhere would
		 * refuse the very flow a student with no GitHub account is promised. Whether the credential is
		 * any *good* is still not modelled — only that one was sent, which is enough to catch an engine
		 * that forgets the header on a write.
		 */
		const authenticated = (answer: () => Promise<Response>): Promise<Response> =>
			credentialed ? answer() : Promise.resolve(problem(401, 'Requires authentication'));

		const write = (answer: () => Promise<Response>): Promise<Response> =>
			authenticated(() =>
				state.refuseWrites
					? Promise.resolve(problem(403, 'Resource not accessible by personal access token'))
					: answer()
			);

		if (rest.length === 0 && method === 'GET') {
			// ⚠ **`permissions` is on an authenticated read and on no other**, because it reports what
			// *this caller* may do and an anonymous read of a public repository has no caller to report
			// on. A fake that sent it regardless would answer "you may push" to a request carrying no
			// token at all, which is the one field deciding whether the scholar is told the credential
			// cannot push (ADR-0033).
			return json(credentialed ? { permissions: { ...state.permissions } } : {});
		}

		// `PUT /repos/{owner}/{repo}/contents/{path}` — the one write an empty repository accepts, and
		// the only reason it is modelled here. It is what github.com's "create a new file" uses, and a
		// publish uses it once, to bring the branch into being before the Git Data API is asked for
		// anything. Only the create case is implemented: this fake has no `sha` parameter and so no
		// update-an-existing-file path, because nothing here overwrites a file that way.
		if (rest[0] === 'contents' && rest.length > 1 && method === 'PUT') {
			return write(async () => {
				const path = rest.slice(1).join('/');
				const { content, branch, message } = (await body()) as {
					content?: string;
					branch?: string;
					message?: string;
				};
				if (typeof content !== 'string') {
					return problem(400, 'This fake takes file content as base64 and nothing else.');
				}
				const target = typeof branch === 'string' && branch !== '' ? branch : defaultBranch;
				// A repository that already has this branch is not what this endpoint is used for here,
				// and a fake that quietly committed over it would hide a publish taking the slow road.
				if (refs.has(target)) {
					return problem(
						422,
						`${target} already exists; this fake seeds an empty repository only.`
					);
				}
				const bytes = decodeBase64(content);
				const sha = await gitBlobSha(bytes);
				blobs.set(sha, bytes);
				const tree = await storeTree(new Map([[path, { sha, mode: '100644' }]]));
				const commit = await storeCommit({ message: message ?? '', tree, parents: [] });
				refs.set(target, commit);
				return json({ content: { path, sha }, commit: { sha: commit } }, 201);
			});
		}

		if (rest[0] === 'pages' && rest.length === 1 && method === 'POST') {
			// Outside `write`, which is the git database's own switch: `refuseWrites` models a token
			// without `contents: write`, and Pages enablement turns on a different permission entirely.
			return authenticated(async () => {
				// Authorisation before validation, as on the real endpoint: a token without
				// `pages: write` is refused whatever state the repository is in.
				if (state.refusePages) {
					return problem(403, 'Resource not accessible by personal access token');
				}
				if (state.pagesEnabled) {
					return problem(409, 'GitHub Pages is already enabled for this repo.');
				}
				const { source } = (await body()) as { source?: { branch?: string; path?: string } };
				if (typeof source?.branch !== 'string' || typeof source.path !== 'string') {
					return problem(400, 'Enabling Pages needs a source branch and path.');
				}
				// ⚠ **A source branch that does not exist is a 422, not a 403.** A repository created at
				// `github.com/new` with no README has no branches at all, and that is precisely the
				// repository the "create it yourself" link hands a scholar back from. Modelled because
				// the two failures need opposite sentences: one is a permission to grant, and the other
				// is a branch that appears by itself at the first publish.
				if (!refs.has(source.branch)) {
					return json(
						{
							message: 'Validation Failed',
							errors: [{ resource: 'PagesSourceHash', field: 'source', code: 'invalid' }]
						},
						422
					);
				}
				state.pagesEnabled = true;
				return json({ source }, 201);
			});
		}

		if (rest[0] !== 'git') return notFound(`${url.pathname} is not a path this fake implements.`);

		if (rest[1] === 'ref' && rest[2] === 'heads' && rest.length > 3 && method === 'GET') {
			// Where a publish starts: the branch's current commit, which becomes the parent of the one
			// it writes. Without it a publish can only commit an orphan, which is a force push over
			// whatever the scholar did on github.com — and, because a commit here is content-addressed
			// over tree, parents, and message, an unchanged Workspace would produce the *same* commit
			// SHA and the ref would not move at all.
			const branch = rest.slice(3).join('/');
			const at = refs.get(branch);
			// An empty repository and a missing branch are **different statuses**, and both mean the
			// first publish creates the ref rather than moving it. A repository with no branches at all
			// answers 409 `Git Repository is empty.` — the one `github.com/new` makes with no README —
			// and one that has branches but not this one answers 404.
			if (at === undefined) return emptyOrMissing(branch);
			return json({ ref: `refs/heads/${branch}`, object: { sha: at, type: 'commit' } });
		}

		if (rest[1] === 'trees' && rest.length > 2 && method === 'GET') {
			const ref = rest.slice(2).join('/');
			const tree = resolveTree(ref);
			if (tree === null) return emptyOrMissing(ref);

			const recursive = url.searchParams.get('recursive');
			// A listing that is not recursive holds the top level only, which is how an engine that
			// forgot the parameter comes to publish a Workspace it believes has three files in it.
			const entries = (await listing(tree)).filter(
				(entry) => recursive !== null || !entry.path.includes('/')
			);
			const limit = state.truncateAfter;
			const cut = limit !== null && limit < entries.length ? limit : null;

			return json({
				sha: await objectId(serialiseTree(tree)),
				tree: cut === null ? entries : entries.slice(0, cut),
				truncated: cut !== null
			});
		}

		if (rest[1] === 'blobs' && rest.length === 2 && method === 'POST') {
			// Counted before the refusal, not after it: the counter measures what the engine *sent*,
			// and `refuseWrites` exists to prove an engine stops sending once it meets a 403 — which a
			// counter that only counted accepted posts would read as zero either way.
			blobPosts += 1;
			return write(async () => {
				const empty = emptyForWrites();
				if (empty !== null) return empty;
				const { content, encoding } = (await body()) as { content?: string; encoding?: string };
				if (typeof content !== 'string' || encoding !== 'base64') {
					return problem(400, 'This fake takes blob content as base64 and nothing else.');
				}
				const bytes = decodeBase64(content);
				const sha = await gitBlobSha(bytes);
				blobs.set(sha, bytes);
				return json({ sha }, 201);
			});
		}

		if (rest[1] === 'trees' && rest.length === 2 && method === 'POST') {
			return write(async () => {
				const empty = emptyForWrites();
				if (empty !== null) return empty;
				const posted = await body();
				if ('base_tree' in posted) {
					// Refused rather than ignored: a `base_tree` silently dropped is a commit that keeps
					// every path the caller meant to delete, which is the failure the owned-namespace
					// rules exist to prevent and one no assertion on the resulting tree would explain.
					return problem(400, 'This fake does not implement base_tree; post the whole tree.');
				}
				const given = posted.tree;
				if (!Array.isArray(given)) return problem(400, 'A tree needs a tree array.');

				const entries = new Map<string, { sha: string; mode: string }>();
				for (const { path, mode, type, sha } of given as Record<string, unknown>[]) {
					if (type !== 'blob' && type !== 'commit') {
						return problem(
							400,
							'This fake takes blob and gitlink entries; post paths, not subtrees.'
						);
					}
					// Path and mode are checked for the same reason `base_tree` is refused: taken on
					// trust, a missing mode is stored as `undefined` and serialised as the string
					// "undefined", so the tree hashes to something no repository could hold.
					if (typeof path !== 'string' || path === '') {
						return problem(422, 'Every tree entry needs a path.');
					}
					if (type === 'commit') {
						// The commit a gitlink names lives in another repository, so there is nothing here
						// to check it against — only that it is a mode and a SHA of the right shape.
						if (mode !== GITLINK_MODE) {
							return problem(422, `${path} is a gitlink and must carry mode ${GITLINK_MODE}.`);
						}
						if (typeof sha !== 'string' || sha === '') {
							return problem(422, `${path} names no commit for its submodule.`);
						}
						entries.set(path, { sha, mode });
						continue;
					}
					if (typeof mode !== 'string' || !BLOB_MODES.has(mode)) {
						return problem(422, `${path} carries no file mode this repository takes.`);
					}
					if (typeof sha !== 'string' || !blobs.has(sha)) {
						return problem(422, `${String(sha)} is not a blob this repository holds.`);
					}
					entries.set(path, { sha, mode });
				}
				return json({ sha: await storeTree(entries) }, 201);
			});
		}

		if (rest[1] === 'commits' && rest.length === 2 && method === 'POST') {
			return write(async () => {
				const empty = emptyForWrites();
				if (empty !== null) return empty;
				const { message, tree, parents } = (await body()) as {
					message?: string;
					tree?: string;
					parents?: string[];
				};
				if (typeof tree !== 'string' || !trees.has(tree)) {
					return problem(422, `${tree} is not a tree this repository holds.`);
				}
				const chain = parents ?? [];
				const orphan = chain.find((parent) => !commits.has(parent));
				if (orphan !== undefined) {
					return problem(422, `${orphan} is not a commit this repository holds.`);
				}
				const sha = await storeCommit({ message: message ?? '', tree, parents: chain });
				return json({ sha }, 201);
			});
		}

		if (rest[1] === 'refs' && rest.length === 2 && method === 'POST') {
			return write(async () => {
				const { ref, sha } = (await body()) as { ref?: string; sha?: string };
				if (typeof ref !== 'string' || !ref.startsWith('refs/heads/')) {
					return problem(422, 'This fake holds branches only, so a ref is refs/heads/<branch>.');
				}
				if (typeof sha !== 'string' || !commits.has(sha)) {
					return problem(422, `${sha} is not a commit this repository holds.`);
				}
				const branch = ref.slice('refs/heads/'.length);
				if (refs.has(branch)) return problem(422, 'Reference already exists');
				refs.set(branch, sha);
				return json({ ref, object: { sha } }, 201);
			});
		}

		if (rest[1] === 'refs' && rest[2] === 'heads' && rest.length > 3 && method === 'PATCH') {
			return write(async () => {
				const branch = rest.slice(3).join('/');
				const { sha } = (await body()) as { sha?: string };
				if (!refs.has(branch)) return problem(422, 'Reference does not exist');
				if (typeof sha !== 'string' || !commits.has(sha)) {
					return problem(422, `${sha} is not a commit this repository holds.`);
				}
				// Any move is accepted and `force` is ignored on purpose. Conflict detection in this
				// epic is manifest-based (ADR-0033) — the engine compares the Remote's blob SHAs
				// against what it last published and refuses before it ever gets here — so a
				// fast-forward check at this endpoint would refuse pushes the engine means to make and
				// would test a rule nothing in the product relies on.
				refs.set(branch, sha);
				return json({ ref: `refs/heads/${branch}`, object: { sha } });
			});
		}

		return notFound(`${url.pathname} is not a path this fake implements.`);
	};

	/**
	 * `raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}` — the unauthenticated read half.
	 *
	 * It spends none of the hourly budget, because it is not the API and does not share its ceiling.
	 */
	const answerRaw = (url: URL, request: Request): Response => {
		// Counted before anything is resolved, for {@link FakeGitHub.blobPosts}'s reason in the other
		// direction: a 404 is still a request the engine chose to make.
		rawGets += 1;
		// ⚠ **A private repository answers 404 here, not 401**, which is the whole hazard: a caller
		// reading a file to find out what the Remote carries is told the file is not there, and a check
		// built on that read passes rather than failing (see {@link FakeGitHub.privateRepository}).
		if (state.privateRepository && !bearsToken(request)) {
			return new Response('404: Not Found', { status: 404, headers: headers() });
		}
		const path = decodePath(url.pathname);
		if (path === null) return notFound(`${url.pathname} is not a path this fake implements.`);
		const [owner, repository, ref, ...rest] = path;
		if (
			owner !== options.owner ||
			repository !== options.repository ||
			ref === undefined ||
			rest.length === 0
		) {
			return notFound(`${url.pathname} is not a path this fake implements.`);
		}

		const tree = resolveTree(ref);
		const entry = tree?.get(rest.join('/'));
		const bytes = entry && blobs.get(entry.sha);
		if (!bytes) return new Response('404: Not Found', { status: 404, headers: headers() });

		return new Response(bytes, { status: 200, headers: headers() });
	};

	// ── The sign-in surface: GitHub's authorize screen, and the broker's two endpoints ────────────

	const signIn = options.signIn;

	/** A token grant in GitHub's own shape, which is what the broker passes back verbatim. */
	const grant = (): Response => {
		const token = nextValue('ghu');
		const refresh = nextValue('ghr');
		issuedTokens.set(token, { expired: false });
		refreshTokens.add(refresh);
		return json({
			access_token: token,
			token_type: 'bearer',
			expires_in: signIn?.tokenLifetimeSeconds ?? 8 * 3600,
			refresh_token: refresh,
			refresh_token_expires_in: 6 * 30 * 24 * 3600
		});
	};

	/**
	 * GitHub's authorisation screen, which here answers the redirect a user pressing "Authorize"
	 * would produce.
	 *
	 * The `state` is echoed back **exactly as it arrived and never checked**, because GitHub does not
	 * check it either — it is the client's own value, and verifying it is the client's whole job. A
	 * fake that validated it would make the mismatch and absence cases unreachable, which are two of
	 * this ticket's acceptance criteria.
	 */
	const answerAuthorize = (url: URL): Response => {
		const redirectUri = url.searchParams.get('redirect_uri') ?? '';
		if (signIn === undefined || url.searchParams.get('client_id') !== signIn.clientId) {
			return new Response('404: Not Found', { status: 404, headers: headers() });
		}
		if (redirectUri === '') return problem(400, 'redirect_uri is required');

		return issueCode(redirectUri, url.searchParams.get('state') ?? '');
	};

	/**
	 * The App's own install screen, which installs and authorises in one press.
	 *
	 * With **Request user authorization (OAuth) during installation** enabled on the App, GitHub
	 * answers this the way the authorize screen does — except that the address it comes back to is
	 * the callback registered on the App rather than one the request named.
	 */
	const answerInstall = (url: URL): Response => {
		if (signIn === undefined) {
			return new Response('404: Not Found', { status: 404, headers: headers() });
		}
		const registered = signIn.callbackUrl;
		const redirectUri = (
			typeof registered === 'function' ? registered() : (registered ?? '')
		).trim();
		if (redirectUri === '') {
			return problem(400, 'This App has no callback URL registered, so nowhere to return to.');
		}
		return issueCode(redirectUri, url.searchParams.get('state') ?? '');
	};

	/** Mint a code against an address, and send the browser back to it. Both screens end here. */
	const issueCode = (redirectUri: string, state: string): Response => {
		const code = nextValue('code');
		codes.set(code, { redirectUri, spent: false });
		issuedCodes.push(code);
		const back = new URL(redirectUri);
		back.searchParams.set('code', code);
		back.searchParams.set('state', state);
		return new Response(null, {
			status: 302,
			headers: { ...headers(), location: back.toString() }
		});
	};

	/** `{ error, error_description }`, which is how a refusal arrives — in the body, with a 200. */
	const oauthError = (error: string, description: string): Response =>
		json({ error, error_description: description });

	/** `POST {broker}/github/token` and `POST {broker}/github/refresh` (ADR-0031's contract). */
	const answerBroker = async (
		url: URL,
		method: string,
		body: () => Promise<Record<string, unknown>>
	): Promise<Response> => {
		if (signIn === undefined) return notFound(`${url.origin} is not a host this fake implements.`);
		if (method !== 'POST') return problem(405, 'Method Not Allowed');

		const sent = await body();
		// The secret is looked up **by `client_id`**, so a request naming an App this broker holds no
		// secret for is refused rather than served with somebody else's.
		if (sent.client_id !== signIn.clientId) {
			return oauthError('invalid_client', 'No client secret is held for that client_id.');
		}

		if (url.pathname === '/github/token') {
			if (state.refuseExchange) {
				return oauthError('bad_verification_code', 'The code passed is incorrect or expired.');
			}
			const code = typeof sent.code === 'string' ? sent.code : '';
			const held = codes.get(code);
			if (held === undefined || held.spent) {
				return oauthError('bad_verification_code', 'The code passed is incorrect or expired.');
			}
			// GitHub requires the exchange to name the same address the authorisation did.
			if (sent.redirect_uri !== held.redirectUri) {
				return oauthError('redirect_uri_mismatch', 'The redirect_uri is not associated with it.');
			}
			held.spent = true;
			return grant();
		}

		if (url.pathname === '/github/refresh') {
			const refresh = typeof sent.refresh_token === 'string' ? sent.refresh_token : '';
			if (state.refuseRefresh || !refreshTokens.has(refresh)) {
				return oauthError('bad_refresh_token', 'The refresh token passed is incorrect or expired.');
			}
			refreshTokens.delete(refresh);
			return grant();
		}

		return notFound(`${url.pathname} is not a path this broker implements.`);
	};

	/** The bearer string a request carries, or `''`. */
	const tokenOf = (request: Request): string =>
		/^\s*(?:bearer|token)\s+(\S+)/i.exec(request.headers.get('authorization') ?? '')?.[1] ?? '';

	const fetchFn: FetchFn = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);

		if (signIn !== undefined) {
			if (url.origin === signIn.brokerOrigin) {
				return answerBroker(url, request.method.toUpperCase(), async () => {
					const text = await request.text();
					return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
				});
			}
			if (url.href.split('?')[0] === GITHUB_AUTHORIZE_URL) return answerAuthorize(url);
			if (url.href.split('?')[0] === `${GITHUB_APPS_URL}/${signIn.appSlug}/installations/new`) {
				return answerInstall(url);
			}
		}

		// The raw host spends none of the hourly budget and, unless this repository is private, does not
		// so much as look at a credential: a public repository's bytes are read there with none at all,
		// and a fake that demanded one would hide a Clone sending a token it has no business sending.
		if (url.origin === GITHUB_RAW_ORIGIN) return answerRaw(url, request);
		if (url.origin !== GITHUB_API_ORIGIN) {
			return notFound(`${url.origin} is not a host this fake implements.`);
		}

		if (state.rateLimit.remaining <= 0) {
			return problem(403, 'API rate limit exceeded');
		}
		state.rateLimit.remaining -= 1;

		// A token GitHub will not look at, refused wherever it is sent — and only where one *was*
		// sent, so an anonymous read of a public repository still works while a revoked token is in
		// play. Whether a token is any *good* is a question only GitHub can answer; this is the answer
		// it gives, in its own words.
		if (state.rejectCredential && bearsToken(request)) return problem(401, 'Bad credentials');

		// An expired user-to-server token, which GitHub refuses in exactly the same words as a revoked
		// one — the client cannot tell them apart, and this ticket's answer to both is "sign in again".
		// Only tokens *this fake issued* are aged, so a pasted token in the same browser is untouched.
		if (issuedTokens.get(tokenOf(request))?.expired === true) {
			return problem(401, 'Bad credentials');
		}

		// Read lazily: a request with no body must not be made to have one, and a router branch that
		// never reads the body must not fail on a malformed one it was never going to look at.
		return answerApi(url, request.method.toUpperCase(), bearsToken(request), async () => {
			const text = await request.text();
			return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
		});
	};

	return {
		fetch: fetchFn,
		get blobPosts() {
			return blobPosts;
		},
		get rawGets() {
			return rawGets;
		},
		files(ref = defaultBranch) {
			const files = new Map<string, Uint8Array>();
			for (const [path, entry] of sortedTree(ref)) {
				const bytes = blobs.get(entry.sha);
				// Copied: a caller that decodes a tile in place would otherwise rewrite the object
				// store under every later read, and the corruption would surface as a wrong assertion
				// in some other test.
				if (bytes) files.set(path, new Uint8Array(bytes));
			}
			return files;
		},
		gitlinks(ref = defaultBranch) {
			const links = new Map<string, string>();
			for (const [path, entry] of sortedTree(ref)) {
				if (entry.mode === GITLINK_MODE) links.set(path, entry.sha);
			}
			return links;
		},
		head(branch = defaultBranch) {
			return refs.get(branch) ?? null;
		},
		history(branch = defaultBranch) {
			const chain: string[] = [];
			// First-parent only. Nothing Ballastella does merges, so a commit never has a second parent.
			for (let at = refs.get(branch); at !== undefined; at = commits.get(at)?.parents[0]) {
				chain.push(at);
			}
			return chain;
		},
		async commitFiles(files, branch = defaultBranch) {
			const entries = new Map(treeAt(branch) ?? []);
			for (const [path, content] of Object.entries(files)) {
				if (content === null) {
					entries.delete(path);
					continue;
				}
				const bytes = bytesOf(content);
				const sha = await gitBlobSha(bytes);
				blobs.set(sha, bytes);
				entries.set(path, { sha, mode: '100644' });
			}
			const parent = refs.get(branch);
			const commit = await storeCommit({
				message: 'Edited on github.com',
				tree: await storeTree(entries),
				parents: parent === undefined ? [] : [parent]
			});
			refs.set(branch, commit);
			return commit;
		},
		get truncateAfter() {
			return state.truncateAfter;
		},
		set truncateAfter(value) {
			state.truncateAfter = value;
		},
		get refuseWrites() {
			return state.refuseWrites;
		},
		set refuseWrites(value) {
			state.refuseWrites = value;
		},
		get rejectCredential() {
			return state.rejectCredential;
		},
		set rejectCredential(value) {
			state.rejectCredential = value;
		},
		get refusePages() {
			return state.refusePages;
		},
		set refusePages(value) {
			state.refusePages = value;
		},
		get permissions() {
			return state.permissions;
		},
		set permissions(value) {
			state.permissions = value;
		},
		get pagesEnabled() {
			return state.pagesEnabled;
		},
		set pagesEnabled(value) {
			state.pagesEnabled = value;
		},
		get privateRepository() {
			return state.privateRepository;
		},
		set privateRepository(value) {
			state.privateRepository = value;
		},
		get rateLimit() {
			return state.rateLimit;
		},
		set rateLimit(value) {
			state.rateLimit = value;
		},
		get login() {
			return state.login;
		},
		set login(value) {
			state.login = value;
		},
		get refuseExchange() {
			return state.refuseExchange;
		},
		set refuseExchange(value) {
			state.refuseExchange = value;
		},
		get refuseRefresh() {
			return state.refuseRefresh;
		},
		set refuseRefresh(value) {
			state.refuseRefresh = value;
		},
		grant(repository) {
			grants ??= {
				installationId: 1,
				account: options.owner,
				targetId: defaultTargetId(1),
				repositorySelection: 'selected',
				accountType: 'User',
				repositories: []
			};
			grants.repositories.push(repository);
		},
		expireIssuedTokens() {
			for (const held of issuedTokens.values()) held.expired = true;
		},
		issuedCodes
	};
}
