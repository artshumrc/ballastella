// One file listing of a repository, for the operations that read one — anonymously for a public
// repository, and as the signed-in author for a private one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT A FUNCTION IN EACH READER
//
// A get takes the whole owned namespace and a Review takes one Project's closure, so they want
// *different subsets* of the same listing — but the listing itself is one request, one set of
// statuses to make sense of, and one 200-response-that-is-not-complete to refuse. Written twice,
// the two readings could disagree about what a repository holds while both stayed green: the
// `iiif-hosts` divergence, and the reason `projectDirectories` is exported rather than
// restated. So the reading lives here and the *wording* does not.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO PAIRS OF FUNCTIONS RATHER THAN ONE PAIR WITH AN OPTIONAL TOKEN
//
// {@link readRemoteTree} and {@link readRemoteHeadCommit} take no credential and can send no header,
// and that is a property of their signatures rather than of what a caller happens to pass. The
// signed-out door (`workspace-address.ts`) and the Review (`review-from-remote.ts`) call those, and
// an optional `Authorization` on one shared function is one refactor away from making an account a
// prerequisite for the operations that need none (ADR-0031, ADR-0043) — silently, because the flow
// would go on working for everybody who had already signed in.
//
// {@link readSignedInRemoteTree} and {@link readSignedInRemoteHeadCommit} require one, and a private
// repository is the whole reason they exist: GitHub answers 404 to an anonymous read of one, so the
// only way to get from it is signed in (ADR-0044). What both pairs share is {@link githubGet}'s
// *reading* of the response, which is the part that must not be written twice.
//
// ⚠ **The refusals carry a kind and nothing else that a user reads.** A get's truncation message
// says a Workspace would arrive with a pyramid missing and that nothing has been downloaded; a
// Review's says nothing has been opened. Those are different sentences about the same fact, so each
// caller writes its own from {@link RemoteTreeRefusedError.refusal} — this module has no opinion
// about how a refusal is spelled and must not grow one.
//
// `remote-tree.test.ts` drives this directly, because most of what is here is a reading of responses
// no caller can produce through the fake — a body that is not JSON, a `tree` that is not an array, a
// status neither reader has a name for. What the *callers* do with each refusal is asserted in
// `clone-from-remote.test.ts` and `review-from-remote.test.ts`, against the sentences they write.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { GITHUB_API_ORIGIN, headerNumber } from './github-api.js';

/** The repository a listing is read from, with its branch already decided. */
export type RemoteTreeReference = {
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
};

/** One file the branch's tip holds, as the tree listing reports it. */
export type RemoteBlob = {
	readonly path: string;
	/** git's blob SHA, which is what makes a downloaded byte checkable against what was named. */
	readonly sha: string;
	readonly bytes: number;
};

/** Why a Remote's file list could not be read, or could not be trusted once it had been. */
export type RemoteTreeRefusal =
	/** No such public repository, or one no anonymous reader can see — which look the same. */
	| 'no-repository'
	/** GitHub demanded a credential, so the repository is not a public one. */
	| 'not-public'
	/**
	 * GitHub's hourly limit for anonymous readers is used up, whatever the repository is.
	 *
	 * ⚠ **Told apart from {@link RemoteTreeRefusal} `'not-public'` by the remaining count, and it has
	 * to be.** The unauthenticated API allows 60 requests an hour **per IP address**, and answers 403
	 * when they are gone — the same status a repository needing a credential answers. On a shared
	 * campus address, a class all reading their instructor's repository spends that between them, so
	 * reporting it as a private repository tells a room full of people to change a setting on somebody
	 * else's repository. Waiting is the remedy, and only this refusal can say so.
	 */
	| 'rate-limited'
	/** The repository holds no commits, so there is nothing in it to read. */
	| 'empty'
	/** GitHub could only list part of the tree, so anything built from it would silently be partial. */
	| 'truncated'
	/** The request never got an answer at all. */
	| 'unreachable'
	/** Anything else GitHub said. */
	| 'refused';

/**
 * A file list that could not be had, with the facts a caller needs to say why in its own words.
 *
 * Not a message for a user: {@link readRemoteTree}'s callers each write one, because "nothing has
 * been downloaded" and "nothing has been opened" are the same fact about two different operations.
 */
export class RemoteTreeRefusedError extends Error {
	readonly refusal: RemoteTreeRefusal;
	/** What GitHub or the browser said, for the two refusals that quote it. `''` otherwise. */
	readonly detail: string;
	/** How many files a truncated listing did name. `0` for every other refusal. */
	readonly listed: number;
	/** When the hourly budget starts again, for `'rate-limited'`. `null` when GitHub did not say. */
	readonly resetAt: Date | null;

	constructor(refusal: RemoteTreeRefusal, detail = '', listed = 0, resetAt: Date | null = null) {
		super(`The file list could not be read: ${refusal}.`);
		this.name = 'RemoteTreeRefusedError';
		this.refusal = refusal;
		this.detail = detail;
		this.listed = listed;
		this.resetAt = resetAt;
	}
}

/**
 * A path as URL segments.
 *
 * Per segment, so the path structure survives, and encoded, because a `#` in a file name is a
 * fragment that silently truncates the request into one for a different file.
 *
 * ⚠ **Not for a branch on the API host**, where the ref is one path parameter and a `/` in it would
 * address a different endpoint — see {@link readRemoteTree}. It is right for a branch on the raw
 * host, whose URL is literally `{owner}/{repository}/{branch}/{path}` and which resolves a branch
 * name containing a slash across those segments itself.
 */
export const urlPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/**
 * A GET of the git database, with every status this module has a refusal for.
 *
 * The `Authorization` header is **omitted rather than sent empty** for an anonymous read, as the
 * publish engine's own API wrapper omits it: GitHub answers 401 to a `Bearer` with nothing after it,
 * where it answers a public repository's tree to a request carrying no header at all.
 */
async function githubGet(
	fetchFn: FetchFn | undefined,
	url: string,
	token: string | null
): Promise<Response> {
	const request = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
	let response: Response;
	try {
		response = await request(url, {
			headers: {
				Accept: 'application/vnd.github+json',
				...(token === null ? {} : { Authorization: `Bearer ${token}` })
			}
		});
	} catch (cause) {
		throw new RemoteTreeRefusedError(
			'unreachable',
			cause instanceof Error ? cause.message : String(cause)
		);
	}

	// ⚠ 409 `Git Repository is empty.` is a repository with no commits, which is not 404 and needs its
	// own sentence: there is nothing wrong with the address, there is simply nothing published there
	// yet. Reported as a missing repository it sends the user off to check a name that is fine.
	if (response.status === 409) throw new RemoteTreeRefusedError('empty');
	if (response.status === 404) throw new RemoteTreeRefusedError('no-repository');
	// ⚠ **A 403 is two different situations and the remaining count is what separates them.** GitHub
	// answers 403 both to a repository that needs a credential and to an anonymous reader who has
	// spent the hourly 60 requests their IP address is allowed — and the second is the ordinary case
	// on a shared campus connection. A missing header is deliberately *not* a spent budget: the count
	// is `null` when the response did not expose it, and only an explicit nought is a wait.
	if (response.status === 403 && headerNumber(response.headers, 'X-RateLimit-Remaining') === 0) {
		const reset = headerNumber(response.headers, 'X-RateLimit-Reset');
		throw new RemoteTreeRefusedError(
			'rate-limited',
			'',
			0,
			reset !== null && reset > 0 ? new Date(reset * 1000) : null
		);
	}
	// ⚠ **A private repository is nowhere in this branch, and cannot be.** GitHub answers 404 rather
	// than 401 to a read of a repository the caller may not see, so `'no-repository'` above covers a
	// missing repository *and* a private one — which is why the sentences its callers write offer a
	// sign-in instead of asserting the address is wrong. A 401 or 403 here is a credential GitHub will
	// not act on, or a permission it does not carry.
	if (response.status === 401 || response.status === 403) {
		throw new RemoteTreeRefusedError('not-public');
	}
	if (!response.ok) {
		throw new RemoteTreeRefusedError('refused', await problemOf(response));
	}
	return response;
}

/**
 * The commit a public branch stands at, from one unauthenticated ref read.
 *
 * ⚠ **No `Authorization` header, and none may be added *here*** — see {@link readRemoteTree}. A
 * private repository's branch is {@link readSignedInRemoteHeadCommit}'s.
 *
 * **The evidence an Import's provenance records**: a repository, a Project directory
 * and a branch say which Project was copied, and only the commit says which *state* of it. The tree
 * listing cannot answer this — `/git/trees/{ref}` reports the tree object's own hash, which is not a
 * commit and names no history — so it is a second request, and it is why an Import spends one more of
 * the sixty an anonymous reader gets per hour than a Review does.
 *
 * ⚠ **The branch can move between this and the tree listing**, and nothing here can prevent that.
 * What catches it is the blob SHA check every downloaded file goes through: a Project whose bytes
 * changed under the Import is refused rather than installed with a commit that does not describe it.
 *
 * @throws RemoteTreeRefusedError for a repository that cannot be read, and for a branch that is not
 *   there — `'no-repository'`, which is what GitHub answers for a missing ref
 */
export async function readRemoteHeadCommit(
	remote: RemoteTreeReference,
	fetchFn: FetchFn | undefined
): Promise<string> {
	return headCommitOf(remote, fetchFn, null);
}

/**
 * The same, read as the signed-in author — the only way to read a private repository's branch.
 *
 * The token is required rather than nullable, for the reason this module's header gives: with one
 * shared nullable parameter the signed-out door would be one edit away from sending a credential.
 *
 * @throws RemoteTreeRefusedError for a repository that cannot be read, and for a branch that is not
 *   there
 */
export async function readSignedInRemoteHeadCommit(
	remote: RemoteTreeReference,
	token: string,
	fetchFn: FetchFn | undefined
): Promise<string> {
	return headCommitOf(remote, fetchFn, token);
}

async function headCommitOf(
	remote: RemoteTreeReference,
	fetchFn: FetchFn | undefined,
	token: string | null
): Promise<string> {
	// ⚠ The branch is spelled **per segment** here, unlike `/git/trees/{ref}`: this path continues
	// after `heads/`, so a branch of `feature/x` is two segments of it and an encoded slash is a ref
	// GitHub does not have.
	const url =
		`${GITHUB_API_ORIGIN}/repos/${urlPath(remote.owner)}/${urlPath(remote.repository)}` +
		`/git/ref/heads/${urlPath(remote.branch)}`;

	const response = await githubGet(fetchFn, url, token);
	const body = (await response.json().catch(() => ({}))) as { object?: { sha?: unknown } };
	const sha = body.object?.sha;
	// An answer that is this endpoint's shape but carries no SHA is refused rather than recorded as an
	// empty commit: provenance that says a Project came from nowhere in particular is worse than an
	// Import that did not happen.
	if (typeof sha !== 'string' || sha === '') {
		throw new RemoteTreeRefusedError('refused', 'the branch reported no commit');
	}
	return sha;
}

/**
 * When a commit was made, or `null` where GitHub would not say.
 *
 * ⚠ **It never throws, and that is the whole of its contract.** This answers a *date beside a
 * question*, never whether a Sync may go ahead — so a rate limit, a proxy that mangles the response
 * and a repository that has moved all come back as "no date", and the question is asked without one
 * rather than the Sync refusing over a decoration.
 */
export async function readRemoteCommitDate(
	remote: RemoteTreeReference,
	commit: string,
	fetchFn: FetchFn | undefined
): Promise<Date | null> {
	const url =
		`${GITHUB_API_ORIGIN}/repos/${urlPath(remote.owner)}/${urlPath(remote.repository)}` +
		`/git/commits/${urlPath(commit)}`;
	try {
		const response = await githubGet(fetchFn, url, null);
		const body = (await response.json()) as {
			committer?: { date?: unknown };
			author?: { date?: unknown };
		};
		const date = body.committer?.date ?? body.author?.date;
		if (typeof date !== 'string') return null;
		const at = new Date(date);
		return Number.isNaN(at.getTime()) ? null : at;
	} catch {
		return null;
	}
}

/**
 * Every file the branch's tip holds, from one unauthenticated tree listing.
 *
 * ⚠ **No `Authorization` header, and none may be added *here*.** Reading a public repository is
 * anonymous, which is what lets a student with no GitHub account seed a Workspace from their
 * instructor's Remote (ADR-0031): the signed-out door and a Review both read this way. A private
 * repository is {@link readSignedInRemoteTree}'s, and the two are separate functions so that
 * widening one cannot widen the other.
 *
 * @throws RemoteTreeRefusedError for a repository that cannot be read, and for a truncated listing
 */
export async function readRemoteTree(
	remote: RemoteTreeReference,
	fetchFn: FetchFn | undefined
): Promise<RemoteBlob[]> {
	return treeOf(remote, fetchFn, null);
}

/**
 * The same, read as the signed-in author — the only way to list a private repository.
 *
 * The token is required rather than nullable, for the reason this module's header gives.
 *
 * @throws RemoteTreeRefusedError for a repository that cannot be read, and for a truncated listing
 */
export async function readSignedInRemoteTree(
	remote: RemoteTreeReference,
	token: string,
	fetchFn: FetchFn | undefined
): Promise<RemoteBlob[]> {
	return treeOf(remote, fetchFn, token);
}

async function treeOf(
	remote: RemoteTreeReference,
	fetchFn: FetchFn | undefined,
	token: string | null
): Promise<RemoteBlob[]> {
	// ⚠ The branch is **one** encoded path parameter here, unlike on the raw host. `/git/trees/{ref}`
	// takes a single segment, so a branch of `feature/x` spelled per segment would ask for
	// `/git/trees/feature/x` — a path this endpoint does not have at all, and one whose failure says
	// nothing about branches.
	const url =
		`${GITHUB_API_ORIGIN}/repos/${urlPath(remote.owner)}/${urlPath(remote.repository)}` +
		`/git/trees/${encodeURIComponent(remote.branch)}?recursive=1`;

	const response = await githubGet(fetchFn, url, token);

	const body = (await response.json().catch(() => ({}))) as {
		tree?: unknown;
		truncated?: unknown;
	};
	// `Array.isArray` rather than `?? []`: a `tree` that is a string is iterable, and one that is a
	// number is not iterable at all — so an answer that is JSON but not this endpoint's would either
	// walk it character by character or throw a `TypeError` out of a function whose whole job is to
	// turn a bad answer into a refusal.
	const listed = (Array.isArray(body.tree) ? body.tree : []) as readonly {
		path?: unknown;
		sha?: unknown;
		type?: unknown;
		size?: unknown;
	}[];

	// Blobs only. A `tree` entry is a directory, implied by the paths beneath it; a `commit` entry is
	// a gitlink, whose bytes live in another repository and cannot be fetched from this one.
	const blobs: RemoteBlob[] = [];
	for (const entry of listed) {
		if (entry.type !== 'blob') continue;
		if (typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue;
		blobs.push({
			path: entry.path,
			sha: entry.sha,
			bytes: typeof entry.size === 'number' ? entry.size : 0
		});
	}

	// ⚠ **A truncated listing answers 200**, so nothing throws and nothing logs. Refused for the reason
	// a short listing is refused everywhere here: proceeding would take the part GitHub happened to
	// mention and hand the user a Workspace with most of a pyramid silently missing — a Project that
	// opens, draws a map with holes in it, and says nothing at all about why. Counted after the blobs
	// are extracted, so the number a caller quotes is files rather than tree rows.
	if (body.truncated === true) throw new RemoteTreeRefusedError('truncated', '', blobs.length);

	return blobs;
}

/** GitHub's own words for a refusal, which are more useful than a status code alone. */
async function problemOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body?.message === 'string' ? body.message : response.statusText;
	} catch {
		return response.statusText;
	}
}
