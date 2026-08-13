// The one GitHub every test in this epic talks to.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS ONE MODULE, WRITTEN BEFORE ITS FIRST CONSUMER
//
// `e2e/support/iiif-hosts.ts` is the same module written *after* the fact: three specs had grown
// their own IIIF hosts, byte-identical in two of the three and subtly different in the third, so a
// spec asserting a service's behaviour was asserting the behaviour of *its copy* of that service —
// and two specs could disagree about what a level 0 host does while both stayed green. Eleven
// tickets are about to need a GitHub. This is that module built in advance rather than extracted
// from the wreckage afterwards.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT IS NOT A MOCK
//
// It stores real bytes, computes **real** git blob SHAs through {@link gitBlobSha}, and its trees
// are readable back as `path → bytes`. That is what lets a test assert *what arrived at the Remote*
// rather than which calls were made — the distinction SPEC's testing decisions rest on, because
// every failure mode here is silent and plausible: a truncated tree yields a commit missing most of
// a pyramid, an off-by-one in the owned namespace deletes a `CNAME`, and a test counting requests
// passes over both.
//
// Tree and commit identifiers are content-addressed hashes of a serialisation of their own, **not**
// git's object hashes — git frames those differently, and nothing in this epic re-derives one.
// Blob SHAs are the only identifiers anything computes on both sides of the wire, and those are
// exact.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// EVERYTHING UNIMPLEMENTED IS A 404
//
// A fake that answers vacuously is worse than no fake: the engine passes here and fails against
// GitHub, which is the one place nobody is watching. So the router recognises exactly the requests
// this epic makes and refuses everything else — an unknown path with a 404, and a *known* path
// carrying a field this fake does not model (`base_tree`) with a 400 that says so.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';

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
	 * **Omit it for an empty repository** — no commit, no ref at all, so `GET /git/trees/{branch}`
	 * is a 404 and the first publish has to create the ref rather than move it.
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
	 * already holds (ticket 07), and "already holds" is a claim only this counter can check — an
	 * engine that re-downloaded every file and then wrote the same bytes back would leave a Workspace
	 * indistinguishable from a resumed one, and pass any assertion made on the result.
	 */
	readonly rawGets: number;

	/** Every file the branch's current commit holds, path → a copy of its bytes, sorted by path. */
	files(branch?: string): Map<string, Uint8Array>;

	/** Every submodule the branch's current commit holds, path → the commit SHA it points at. */
	gitlinks(branch?: string): Map<string, string>;

	/** The branch's current commit, or `null` when the repository is empty. */
	head(branch?: string): string | null;

	/** The commit chain from `head` back through its parents, newest first. */
	history(branch?: string): string[];

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
	 * so a repository fills with correct files and serves nothing (story 6).
	 */
	refusePages: boolean;

	/** What `GET /repos/{owner}/{repo}` reports. Independent of {@link refuseWrites} on purpose. */
	permissions: FakeRepositoryPermissions;

	/** Whether Pages is on. `POST /pages` answers 409 when it is, and turns it on when it is not. */
	pagesEnabled: boolean;

	rateLimit: FakeRateLimit;
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
 * An in-memory GitHub answering the requests this epic makes, behind a {@link FetchFn}.
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

	const state = {
		truncateAfter: null as number | null,
		refuseWrites: false,
		rejectCredential: false,
		refusePages: false,
		permissions: { push: true, admin: true } as FakeRepositoryPermissions,
		pagesEnabled: false,
		rateLimit: {
			remaining: DEFAULT_HOURLY_REQUESTS,
			reset: Math.floor(Date.now() / 1000) + 3600
		} as FakeRateLimit
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

	/** The branch's tree as path-ordered pairs, which is how both readers below hand it out. */
	const sortedTree = (
		branch: string
	): [string, { readonly sha: string; readonly mode: string }][] =>
		[...(treeAt(branch) ?? [])].sort(([left], [right]) =>
			left < right ? -1 : left > right ? 1 : 0
		);

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
		'X-RateLimit-Reset': String(state.rateLimit.reset)
	});

	const json = (body: unknown, status = 200): Response =>
		new Response(JSON.stringify(body), {
			status,
			headers: { ...headers(), 'content-type': 'application/json' }
		});

	const problem = (status: number, message: string): Response => json({ message }, status);
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

	const answerApi = async (
		url: URL,
		method: string,
		credentialed: boolean,
		body: () => Promise<Record<string, unknown>>
	): Promise<Response> => {
		const path = decodePath(url.pathname);
		if (path === null) return notFound(`${url.pathname} is not a path this fake implements.`);
		const [scope, owner, repository, ...rest] = path;
		if (scope !== 'repos' || owner !== options.owner || repository !== options.repository) {
			return notFound(`${url.pathname} is not a path this fake implements.`);
		}

		/**
		 * A credential is demanded of writes and of nothing else, which is what GitHub does.
		 *
		 * **The reads below are answered unauthenticated on purpose.** A public repository's file list
		 * and its metadata are readable with no credential at all, and this epic depends on that: Clone
		 * and Review are unauthenticated operations (SPEC, "Import: two operations, both
		 * unauthenticated"), so a fake that demanded a token everywhere would refuse the very flow a
		 * student with no GitHub account is promised. Whether the credential is any *good* is still not
		 * modelled — only that one was sent, which is enough to catch an engine that forgets the header
		 * on a write.
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
	const answerRaw = (url: URL): Response => {
		// Counted before anything is resolved, for {@link FakeGitHub.blobPosts}'s reason in the other
		// direction: a 404 is still a request the engine chose to make.
		rawGets += 1;
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

	const fetchFn: FetchFn = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);

		// The raw host is deliberately not covered: a public repository's bytes are read there with no
		// credential at all, and a fake that demanded one would hide a Clone sending a token it has no
		// business sending.
		if (url.origin === GITHUB_RAW_ORIGIN) return answerRaw(url);
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
		files(branch = defaultBranch) {
			const files = new Map<string, Uint8Array>();
			for (const [path, entry] of sortedTree(branch)) {
				const bytes = blobs.get(entry.sha);
				// Copied: a caller that decodes a tile in place would otherwise rewrite the object
				// store under every later read, and the corruption would surface as a wrong assertion
				// in some other test.
				if (bytes) files.set(path, new Uint8Array(bytes));
			}
			return files;
		},
		gitlinks(branch = defaultBranch) {
			const links = new Map<string, string>();
			for (const [path, entry] of sortedTree(branch)) {
				if (entry.mode === GITLINK_MODE) links.set(path, entry.sha);
			}
			return links;
		},
		head(branch = defaultBranch) {
			return refs.get(branch) ?? null;
		},
		history(branch = defaultBranch) {
			const chain: string[] = [];
			// First-parent only. Nothing in this epic merges, so a commit never has a second parent.
			for (let at = refs.get(branch); at !== undefined; at = commits.get(at)?.parents[0]) {
				chain.push(at);
			}
			return chain;
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
		get rateLimit() {
			return state.rateLimit;
		},
		set rateLimit(value) {
			state.rateLimit = value;
		}
	};
}
