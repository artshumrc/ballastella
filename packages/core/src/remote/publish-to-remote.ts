// Publishing a Workspace to its Remote: one tree, one commit, one ref (ADR-0031, ADR-0032, ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// BESIDE `publish/publish.ts`, NOT INSTEAD OF IT
//
// Local publish writes the viewer's files into the Workspace; this uploads the Workspace. The two
// are deliberately not folded together: `publishSite` reaches no network at all, and putting a
// request inside it would make every one of its assertions about a folder depend on a host.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// NOTHING IS VISIBLE UNTIL THE REF MOVES
//
// Blobs, then one tree, then one commit, then the ref. Every step before the last is invisible to a
// Reader, so an interrupted publish — a spent rate-limit budget, a closed laptop — leaves the site
// exactly as it was rather than half replaced (SPEC story 16). That is also why a refusal is worth
// making early: `planRemotePublish` posts nothing, so every refusal it raises costs a Reader
// nothing at all.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// IT KNOWS NOTHING ABOUT WHERE THE TOKEN CAME FROM
//
// An opaque bearer string and a `fetch` shim, and no import that could tell a pasted personal access
// token from one the broker exchanged for a code (ADR-0031). There is no `if (authMethod === …)`
// here or below here, and there must not be.

import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	workspaceSize,
	type WorkspaceSize
} from '../project/workspace-size.js';
import { topLevelSegment, type Bytes, type ProjectStore } from '../store/project-store.js';
import { JEKYLL_OFF_MARKER, isViewerFile } from '../transfer/viewer-files.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_API_ORIGIN } from './github-api.js';
import { REMOTE_BINDING_PATH } from './remote-binding.js';

/**
 * The most files a publish will put in one commit.
 *
 * Well under the 100 000 entries at which `GET /git/trees/{ref}?recursive=1` truncates, because the
 * *other* half of that endpoint's limit is a 7 MB response and a path is not a fixed number of bytes
 * — so the entry count is a ceiling that arrives early rather than a threshold to sit against
 * (ADR-0031, ADR-0033). A Historical Map pyramid is what reaches it: `MAX_INGEST_PIXELS` is the
 * measured decode ceiling, and one image at it is roughly 11 000 tiles, so four such maps are here.
 */
export const MAX_PUBLISHED_FILES = 40_000;

/** The repository a Workspace is published to. Ticket 03 owns where this comes from. */
export type RemoteRepository = {
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
};

/** One path in a tree, as the Remote reports it and as a publish posts it back. */
export type RemoteTreeEntry = {
	readonly path: string;
	readonly sha: string;
	/** git's file mode, carried unchanged for a path preserved from the Remote. */
	readonly mode: string;
	readonly bytes: number;
};

/** One Workspace file the commit will hold. */
export type PlannedRemoteFile = {
	readonly path: string;
	/** The blob SHA git gives its bytes, computed here so the upload can be skipped. */
	readonly sha: string;
	readonly bytes: number;
	/** The Remote already holds this blob, so it needs no `POST /git/blobs`. */
	readonly onRemote: boolean;
	/** Written by the publish rather than read from the Workspace — the `.nojekyll` marker. */
	readonly authored: boolean;
};

/**
 * Something a scholar should read before pressing the button.
 *
 * The third axis, files, is a refusal rather than a warning and so has no kind here — see
 * {@link MAX_PUBLISHED_FILES} and {@link RemotePublishRefusedError}.
 */
export type RemotePublishWarning = {
	readonly kind: 'hosting-limit' | 'request-budget';
	readonly message: string;
};

/**
 * A file the local publish will write into the Workspace before the upload runs.
 *
 * {@link ViewerBundleFile} is one structurally, which is the point: the local plan already
 * enumerates exactly these — `index.html`, `_app/**`, `ballastella-site.json`, and the Base Map's
 * glyphs and sprites when the author asks for them.
 */
export type PendingLocalFile = {
	readonly path: string;
	readonly bytes: number;
};

/** What a publish is about to send, worked out before a single blob is posted. */
export type RemotePublishPlan = {
	/** The commit the new one will parent onto, or `null` for a repository with no ref yet. */
	readonly head: string | null;
	/**
	 * Every file the Workspace **already holds** that the commit will hold, sorted by path.
	 *
	 * The ones the local publish is about to add are {@link pending}, and they are not here because
	 * this is also the list {@link publishToRemote} reads bytes for: a path with nothing behind it yet
	 * is not a path to `store.read`.
	 */
	readonly files: readonly PlannedRemoteFile[];
	/**
	 * What the local publish will write into the Workspace first, and it does not hold yet.
	 *
	 * ⚠ **Counted into {@link uploads}, {@link uploadBytes}, {@link bytes}, {@link unchanged} and the
	 * warnings, because a first publish is exactly where those numbers matter and exactly where they
	 * would otherwise be wrong.** The dialog forecasts before it writes — decision 2 of `PublishDialog`
	 * settles the address before anything is written at all — so at the moment the three budgets are
	 * shown, the viewer bundle and the Base Map's five megabytes are not in the Workspace and every
	 * one of the three would quote a total missing them.
	 *
	 * Each is counted as one blob it does not have: their bytes have never been hashed here, and a
	 * forecast that guessed they were already on the Remote would understate in the direction that
	 * ends at a rate limit 300 files in.
	 */
	readonly pending: readonly PendingLocalFile[];
	/** Paths on the Remote outside the owned namespace, carried into the new tree untouched. */
	readonly preserved: readonly RemoteTreeEntry[];
	/**
	 * Whether the Remote's tree already holds exactly what this publish would write.
	 *
	 * ⚠ **Path *and* blob, both ways round.** {@link PlannedRemoteFile.onRemote} is a question about
	 * bytes — *does the Remote hold this blob anywhere* — so a Workspace whose every file is `onRemote`
	 * may still be a Workspace one Project has been deleted from, or one whose two blank tiles have
	 * swapped places. This compares the whole `path → blob` map in both directions, which is the only
	 * form of the question a caller can offer a scholar the sentence "nothing needed changing" on.
	 *
	 * It is a fact for the *caller* to act on and changes nothing here: {@link publishToRemote} still
	 * writes its tree, its commit and its ref when it is handed such a plan, because a caller may have
	 * reason to move the branch anyway and an engine that silently declined would be the harder thing
	 * to reason about. Publishing nothing is done by not calling it.
	 */
	readonly unchanged: boolean;
	/**
	 * How many blobs need uploading, and what they weigh: the two numbers a user wants.
	 *
	 * Blobs, not paths — two paths holding the same bytes are one `POST /git/blobs` between them.
	 */
	readonly uploads: number;
	readonly uploadBytes: number;
	/** What the Workspace holds now, from `ProjectStore#size` and never from reading a tile. */
	readonly workspace: WorkspaceSize;
	/** What the Published Site will weigh: the Workspace plus everything preserved. */
	readonly bytes: number;
	/** GitHub's hourly budget as the last response reported it, or `null` if it said nothing. */
	readonly requestsRemaining: number | null;
	readonly requestsResetAt: Date | null;
	readonly warnings: readonly RemotePublishWarning[];
};

/** Publishing was refused, before anything was sent. */
export class RemotePublishRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RemotePublishRefusedError';
	}
}

/** The Remote turned a request down, part way through or at the start. */
export class RemotePublishFailedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RemotePublishFailedError';
	}
}

/**
 * GitHub would not look at the credential at all: 401.
 *
 * ⚠ **Its own class because it is the one failure whose remedy is a sign-in rather than a repository.**
 * Rights are read when a Remote is bound and when a token is pasted, and at no other moment — so what
 * the bar means by "Signed in to GitHub" is *a credential is held*, never *a credential still works*,
 * and a token that has since expired, been revoked, or had its repository access withdrawn reads as
 * signed in indefinitely. Collapsed into {@link RemotePublishFailedError} the scholar meets
 * "GitHub refused this publish: Bad credentials" and goes off to check a repository that is perfectly
 * fine. Told apart, the caller can say the sign-in has expired, offer the paste, and forget the
 * credential — which is where this epic settled the question rather than re-checking the rights on
 * every dialog (ticket 04).
 *
 * Every publish asks GitHub a credentialed question before it sends a byte —
 * {@link planRemotePublish}'s first request is one — so this reaches a user with the Remote untouched
 * whenever it is the credential rather than the network that has changed.
 */
export class RemotePublishCredentialError extends RemotePublishFailedError {
	constructor(message: string) {
		super(message);
		this.name = 'RemotePublishCredentialError';
	}
}

/**
 * Which request a refusal arrived on.
 *
 * A budget spent at `POST /git/trees` is not a stop part way through the upload — every blob landed
 * — so "after 9 of 9 files" would describe a phase that in fact completed.
 */
export type RemotePublishPhase = 'blobs' | 'tree' | 'commit' | 'ref';

/**
 * The hourly budget ran out part way through, and the publish stopped rather than retrying.
 *
 * A distinct error because it is the one interruption with a remedy that is only waiting.
 *
 * ⚠ **It is not resumable, and must not say it is.** The blobs already posted are loose objects in
 * no tree, so the next plan's tree listing cannot see them; `plan.files` is sorted and deterministic,
 * so the next attempt re-posts the same paths and stops in the same place. Nothing was published,
 * the ref did not move, and publishing again after {@link resetAt} starts the upload over.
 */
export class RemotePublishRateLimitedError extends RemotePublishFailedError {
	readonly phase: RemotePublishPhase;
	/** How many files reached the Remote before the budget ran out. */
	readonly filesSent: number;
	readonly totalFiles: number;
	readonly resetAt: Date | null;

	constructor(
		phase: RemotePublishPhase,
		filesSent: number,
		totalFiles: number,
		resetAt: Date | null
	) {
		super(rateLimitMessage(phase, filesSent, totalFiles, resetAt));
		this.name = 'RemotePublishRateLimitedError';
		this.phase = phase;
		this.filesSent = filesSent;
		this.totalFiles = totalFiles;
		this.resetAt = resetAt;
	}
}

export type RemotePublishOptions = {
	/**
	 * An opaque bearer credential. Where it came from is not this module's business (ADR-0031):
	 * a pasted fine-grained token and a broker-exchanged one are the same string here.
	 */
	readonly token: string;
	readonly remote: RemoteRepository;
	/** Defaulting to the page's own, as the HTTP store and the place lookup already do. */
	readonly fetch?: FetchFn;
};

export type PlanRemotePublishOptions = RemotePublishOptions & {
	/**
	 * What the local publish will write into the Workspace before the upload runs — see
	 * {@link RemotePublishPlan.pending}. Paths the Workspace already holds are ignored, so handing
	 * the whole of a local plan's file list is right on a second publish as well as on a first.
	 */
	readonly pending?: readonly PendingLocalFile[];
};

export type PublishToRemoteOptions = RemotePublishOptions & {
	/**
	 * ⚠ **A plan made after the local publish has written, never the forecast the user was shown.**
	 * Only {@link RemotePublishPlan.files} is uploaded, so a plan still carrying
	 * {@link RemotePublishPlan.pending} would commit a site with no `index.html` in it — see
	 * `EditorSession.publishToRemote`, which re-plans for exactly this reason.
	 */
	readonly plan: RemotePublishPlan;
	readonly onProgress?: (seen: {
		readonly files: number;
		readonly totalFiles: number;
		readonly requestsRemaining: number | null;
	}) => void;
};

/** git's mode for an ordinary file, which is every path this writes. */
const BLOB_MODE = '100644';

/** git's mode for a submodule: a `type: 'commit'` entry, pointing at a commit in another repository. */
const GITLINK_MODE = '160000';

/**
 * The requests a publish makes beyond the blobs: one tree, one commit, one ref move.
 *
 * Small, and exactly the reason to count it. A plan within three of the remaining budget uploads
 * every blob and then meets the 403 at `POST /git/trees` — a stop at the most expensive moment
 * possible, after all the bytes and before anything is visible.
 */
const REQUESTS_BEYOND_BLOBS = 3;

const EMPTY_FILE: Bytes = new Uint8Array(0);

/** The one message every publish commit carries. One branch, one commit per publish (SPEC). */
const COMMIT_MESSAGE = 'Publish from Ballastella';

// ── The owned namespace (ADR-0033) ────────────────────────────────────────────────────────────

const OWNED_DIRECTORIES = [`${IMAGE_DIRECTORY}/`, `${ALIGNMENT_DIRECTORY}/`];

/**
 * Every top-level directory **the Remote** holds a `project.json` in.
 *
 * ⚠ **The Remote's tree, never the local Workspace's.** That is the whole of how a Project deleted
 * here is recognised as ours and removed there with its pyramid: it is gone locally, so only the
 * Remote can still say it was a Project. Asked of the Workspace instead, a deleted Project's
 * directory would fall outside the namespace and be preserved forever — ADR-0033's "additive only"
 * leak, arriving through the back door.
 *
 * Exported for `clone-from-remote.ts`, which asks the same question of the same kind of tree.
 */
export function remoteProjectDirectories(paths: Iterable<string>): Set<string> {
	const directories = new Set<string>();
	for (const path of paths) {
		const [directory, name, ...deeper] = path.split('/');
		if (directory !== undefined && name === PROJECT_FILE_NAME && deeper.length === 0) {
			directories.add(directory);
		}
	}
	return directories;
}

/**
 * Whether a path on the Remote is one a publish may add to, replace, or delete (ADR-0033).
 *
 * Inside it the Remote becomes exactly the Workspace. Outside it nothing is touched, which is why a
 * scholar's `CNAME` survives — publish over it once and their cited address quietly moves back to a
 * `github.io` URL, and the next publish does it again after they fix it.
 *
 * ⚠ **Exported so that a Clone reads exactly this rule, and there is deliberately no second copy of
 * it** (`clone-from-remote.ts`). The two halves have to agree or the namespace leaks: a Clone that
 * brought down a path this predicate excludes would make it Workspace content, and the next publish
 * from that Workspace would push somebody else's `CNAME`, `README.md` and workflows into the
 * cloner's own repository as though the cloner had written them.
 */
export function isOwnedPath(path: string, remoteProjects: ReadonlySet<string>): boolean {
	if (isViewerFile(path)) return true;
	// The binding document is inside the published tree deliberately (ADR-0033), so it is ours to
	// replace and ours to remove: a Workspace that has been unbound must not leave a stale one there.
	if (path === REMOTE_BINDING_PATH) return true;
	if (OWNED_DIRECTORIES.some((directory) => path.startsWith(directory))) return true;
	return path.includes('/') && remoteProjects.has(topLevelSegment(path));
}

// ── The transport ─────────────────────────────────────────────────────────────────────────────

type Budget = { remaining: number | null; resetAt: Date | null };

/**
 * A header's number, or `null` when it is absent or unreadable.
 *
 * ⚠ `Headers#get` answers `null` for a header that is not there and `Number(null)` is `0`, which
 * `Number.isFinite` accepts — so a response carrying no budget header would otherwise read as a
 * budget of nought: a warning that GitHub allows no more requests this hour, and every later 403,
 * including a token with no `contents: write`, reported as a rate limit that waiting would fix.
 */
function headerNumber(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

/**
 * A branch name as URL path segments.
 *
 * Per segment, because `refs/heads/one/two` is a branch called `one/two` and an encoded slash names
 * a different ref — but a `#` in a branch name is a fragment that silently truncates the request, and
 * git allows one.
 */
const branchPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

type RemoteApi = {
	/** What the last response said is left of the hourly budget, and when it resets. */
	readonly budget: Budget;
	/** Carried so a refusal can name the repository it was refused about. */
	readonly remote: RemoteRepository;
	call(path: string, init?: RequestInit): Promise<Response>;
};

function createRemoteApi(options: RemotePublishOptions, budget: Budget): RemoteApi {
	const request = options.fetch ?? ((input, init) => fetch(input, init));
	const base = `${GITHUB_API_ORIGIN}/repos/${options.remote.owner}/${options.remote.repository}`;

	return {
		budget,
		remote: options.remote,
		async call(path, init = {}) {
			const response = await request(`${base}${path}`, {
				...init,
				headers: {
					Accept: 'application/vnd.github+json',
					Authorization: `Bearer ${options.token}`,
					...init.headers
				}
			});
			// Read rather than inferred, and read from every response: `api.github.com` names both in
			// `access-control-expose-headers`, so the browser can see what it has left (ADR-0031).
			const remaining = headerNumber(response.headers, 'X-RateLimit-Remaining');
			if (remaining !== null) budget.remaining = remaining;
			const reset = headerNumber(response.headers, 'X-RateLimit-Reset');
			if (reset !== null && reset > 0) budget.resetAt = new Date(reset * 1000);
			return response;
		}
	};
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

/**
 * The error a refused request becomes.
 *
 * A spent budget is told apart from every other 403 by the remaining count, which is what GitHub
 * itself sends: the status is the same, and the two need different sentences because only one of
 * them is fixed by waiting. A 401 is told apart from both, because its remedy is a new sign-in and
 * not a repository — see {@link RemotePublishCredentialError}.
 */
async function failureFrom(
	response: Response,
	api: RemoteApi,
	phase: RemotePublishPhase,
	sent: number,
	total: number
): Promise<RemotePublishFailedError> {
	if (response.status === 401) {
		return new RemotePublishCredentialError(
			expiredCredentialMessage(api.remote, phase, sent, total)
		);
	}
	if (response.status === 403 && api.budget.remaining === 0) {
		return new RemotePublishRateLimitedError(phase, sent, total, api.budget.resetAt);
	}
	return new RemotePublishFailedError(
		`GitHub refused this publish: ${await problemOf(response)}. ` +
			`${describeProgress(phase, sent, total)}. Nothing on your Published Site has changed — a ` +
			`publish is only visible once all of it has arrived.`
	);
}

/** The `sha` a created object answers with. */
async function shaOf(response: Response): Promise<string> {
	const body = (await response.json()) as { sha?: unknown };
	if (typeof body.sha !== 'string') {
		throw new RemotePublishFailedError(
			'GitHub accepted an object without naming it, so this publish cannot be completed. ' +
				'Nothing on your Published Site has changed.'
		);
	}
	return body.sha;
}

/**
 * Base64 as `POST /git/blobs` takes it.
 *
 * Chunked because spreading a whole pyramid tile into `String.fromCodePoint` is a `RangeError`
 * somewhere past 64k arguments, and a tile is exactly the content this uploads.
 */
function encodeBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCodePoint(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
}

/**
 * The branch's current commit, or `null` when the repository has no ref at all.
 *
 * @throws RemotePublishRefusedError when there is no such repository, or none this token can see
 */
async function readHead(api: RemoteApi, remote: RemoteRepository): Promise<string | null> {
	const response = await api.call(`/git/ref/heads/${branchPath(remote.branch)}`);
	// ⚠ **409 `Git Repository is empty.` is how GitHub reports a repository with no commits**, and it
	// is not 404. That is the repository `github.com/new` makes when the scholar leaves the README
	// unticked — the sequence ticket 03's "create the repository" link walks them through — so read as
	// an ordinary refusal it kills the *first* publish, the one publish nobody can have got wrong yet.
	if (response.status === 409) return null;
	if (response.status === 404) {
		// ⚠ GitHub answers 404 for a repository that does not exist *and* for one the credential
		// cannot see, so a typo'd name and a revoked token look exactly like an empty repository here.
		// Left unasked, both are planned as a full upload with no warning and surface at the first blob
		// as "GitHub refused this publish: Not Found". One request buys the difference, before anything
		// is sent. This is legibility at plan time, not the bind-time rights check (ticket 03).
		const repository = await api.call('');
		if (repository.status === 404) {
			throw new RemotePublishRefusedError(noRepositoryMessage(remote));
		}
		if (!repository.ok) throw await failureFrom(repository, api, 'blobs', 0, 0);
		return null;
	}
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);
	const body = (await response.json()) as { object?: { sha?: unknown } };
	const sha = body.object?.sha;
	return typeof sha === 'string' ? sha : null;
}

/**
 * Every path the Remote's commit holds, with the SHA that says whether we already have it.
 *
 * Listed at the **commit** rather than at the branch, so the file list and the parent cannot come
 * from two different commits if somebody pushes between the two calls.
 *
 * @throws RemotePublishRefusedError when the listing came back truncated
 */
async function readRemoteTree(
	api: RemoteApi,
	remote: RemoteRepository,
	commit: string
): Promise<RemoteTreeEntry[]> {
	const response = await api.call(`/git/trees/${commit}?recursive=1`);
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);

	const body = (await response.json()) as {
		tree?: { path?: string; sha?: string; mode?: string; type?: string; size?: number }[];
		truncated?: boolean;
	};
	const entries = body.tree ?? [];

	// ⚠ A truncated listing answers **200**, so nothing throws and nothing logs. Proceeding would
	// re-upload everything the listing did not mention and then write a commit missing most of the
	// Workspace — ADR-0024's zip disaster in a new costume, arriving on a scholar's public site.
	if (body.truncated === true) {
		// The count the refusal quotes is files, not entries: a recursive listing carries one entry per
		// directory as well, and quoting those would tell a scholar to delete files they do not have.
		const files = entries.filter((entry) => entry.type === 'blob').length;
		throw new RemotePublishRefusedError(truncatedMessage(files, remote));
	}

	// Blobs and gitlinks, never `tree` entries: a directory is implied by the paths beneath it and
	// posting one back is a different bug. A submodule matches no rule in the owned namespace, so it
	// is preserve-by-default (ADR-0033) — dropped here it would be silently deleted by every publish.
	return entries.flatMap<RemoteTreeEntry>((entry) =>
		(entry.type === 'blob' || entry.type === 'commit') &&
		typeof entry.path === 'string' &&
		typeof entry.sha === 'string'
			? [
					{
						path: entry.path,
						sha: entry.sha,
						mode: entry.mode ?? (entry.type === 'commit' ? GITLINK_MODE : BLOB_MODE),
						bytes: entry.size ?? 0
					}
				]
			: []
	);
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────

/**
 * The files needing a `POST /git/blobs`: one per distinct blob, in path order.
 *
 * ⚠ **Deduplicated by SHA, not merely by what the Remote holds.** Two paths can carry the same bytes
 * — every blank pyramid tile is byte-identical to every other, and so is every empty file — and a
 * blob posted twice spends two of the hourly requests ADR-0033 singles out for one object. Both the
 * plan's count and the upload loop read this, so the number warned about is the number sent.
 */
function blobsToUpload(files: readonly PlannedRemoteFile[]): PlannedRemoteFile[] {
	const seen = new Set<string>();
	const uploads: PlannedRemoteFile[] = [];
	for (const file of files) {
		if (file.onRemote || seen.has(file.sha)) continue;
		seen.add(file.sha);
		uploads.push(file);
	}
	return uploads;
}

/**
 * Work out what a publish would send, and everything the scholar has to be told first.
 *
 * Separate from {@link publishToRemote} because the numbers are only useful *before* the upload
 * starts — "how many files and how many bytes" is a decision about whether to wait (SPEC story 9),
 * and the three budgets bind at different moments (ADR-0033). It posts nothing at all, so both
 * refusals below reach the user with the Remote untouched.
 *
 * @throws RemotePublishRefusedError above {@link MAX_PUBLISHED_FILES} files, or on a truncated tree
 */
export async function planRemotePublish(
	store: ProjectStore,
	options: PlanRemotePublishOptions
): Promise<RemotePublishPlan> {
	const api = createRemoteApi(options, { remaining: null, resetAt: null });

	// Counted before anything is read or fetched, the pattern `tileBudget` sets: a Workspace past the
	// ceiling must not be hashed file by file on its way to being refused.
	const workspace = await workspaceSize(store);
	if (workspace.files > MAX_PUBLISHED_FILES) {
		throw new RemotePublishRefusedError(tooManyFilesMessage(workspace.files));
	}

	const head = await readHead(api, options.remote);
	const remote = head === null ? [] : await readRemoteTree(api, options.remote, head);

	const onRemote = new Set(remote.map((entry) => entry.sha));
	const projects = remoteProjectDirectories(remote.map((entry) => entry.path));

	const paths = await store.list('');
	const held = new Set<string>(paths);
	const files: PlannedRemoteFile[] = [];
	for (const path of paths) {
		const bytes = await store.read(path);
		const sha = await gitBlobSha(bytes);
		files.push({
			path,
			sha,
			bytes: bytes.byteLength,
			onRemote: onRemote.has(sha),
			authored: false
		});
	}

	// **Written into every commit, whether or not the Workspace holds one** (ADR-0033). Jekyll drops
	// every path beginning with `_`, the viewer bundle lives in `_app/`, and the site that needs the
	// file is the author's own repository — a publish is the hand that pushes it.
	if (!held.has(JEKYLL_OFF_MARKER)) {
		const sha = await gitBlobSha(EMPTY_FILE);
		files.push({
			path: JEKYLL_OFF_MARKER,
			sha,
			bytes: 0,
			onRemote: onRemote.has(sha),
			authored: true
		});
	}
	files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

	// What the local publish will add, minus whatever it is about to overwrite: a second publish
	// rewrites the whole viewer over the copy already in the Workspace, so its file list arrives here
	// almost entirely held and adds nothing to any of the three budgets.
	//
	// The {@link MAX_PUBLISHED_FILES} refusal above is deliberately *not* re-made against this total.
	// It is a statement about the Workspace, which is the half a scholar can act on, and it is made
	// before a byte is read — the pattern `tileBudget` sets.
	const planned = new Set(files.map((file) => file.path));
	const pending = (options.pending ?? []).filter((file) => !planned.has(file.path));
	const pendingBytes = pending.reduce((sum, file) => sum + file.bytes, 0);

	// Outside the owned namespace, and not something the Workspace is sending anyway. This is the
	// half that keeps a `CNAME`, a `README.md`, and a `docs/` folder the scholar added.
	const preserved = remote.filter(
		(entry) => !held.has(entry.path) && !isOwnedPath(entry.path, projects)
	);
	const preservedBytes = preserved.reduce((sum, entry) => sum + entry.bytes, 0);

	const uploaded = blobsToUpload(files);
	const uploads = uploaded.length + pending.length;
	const uploadBytes = uploaded.reduce((sum, file) => sum + file.bytes, pendingBytes);

	const warnings: RemotePublishWarning[] = [];
	if (crossesHostingLimit(workspace.bytes, preservedBytes + pendingBytes)) {
		warnings.push({
			kind: 'hosting-limit',
			message: hostingLimitMessage(workspace.bytes + preservedBytes + pendingBytes)
		});
	}
	if (api.budget.remaining !== null && uploads + REQUESTS_BEYOND_BLOBS > api.budget.remaining) {
		warnings.push({
			kind: 'request-budget',
			message: requestBudgetMessage(uploads, api.budget.remaining, api.budget.resetAt)
		});
	}

	// The tree this publish would post, path by path, against the one the Remote holds. Compared by
	// size *and* entry, so a Remote holding one extra owned path — a Project deleted here since the
	// last publish — is a difference rather than a subset that looks like a match.
	const wouldWrite = new Map<string, string>([
		...preserved.map((entry) => [entry.path, entry.sha] as const),
		...files.map((file) => [file.path, file.sha] as const)
	]);
	const unchanged =
		head !== null &&
		// A file the publish is about to write into the Workspace is a file the Remote is about to
		// gain, whatever the two trees look like now.
		pending.length === 0 &&
		remote.length === wouldWrite.size &&
		remote.every((entry) => wouldWrite.get(entry.path) === entry.sha);

	return {
		head,
		files,
		pending,
		preserved,
		unchanged,
		uploads,
		uploadBytes,
		workspace,
		bytes: workspace.bytes + preservedBytes + pendingBytes,
		requestsRemaining: api.budget.remaining,
		requestsResetAt: api.budget.resetAt,
		warnings
	};
}

// ── The publish ───────────────────────────────────────────────────────────────────────────────

/**
 * Send the Workspace to its Remote, and move the branch to a commit holding it.
 *
 * Blobs the Remote already has are not sent, which is what makes a second publish take seconds
 * rather than an hour: the plan computed each file's blob SHA locally, and a SHA already in the
 * Remote's tree is bytes already there (SPEC story 15).
 *
 * @returns the new commit, and the publish manifest — `path → blob SHA` for the whole tree, which a
 *   caller persists so the next publish can tell its own work from somebody else's (ticket 05)
 * @throws RemotePublishRateLimitedError when the hourly budget runs out part way through
 */
export async function publishToRemote(
	store: ProjectStore,
	options: PublishToRemoteOptions
): Promise<{ readonly commit: string; readonly manifest: ReadonlyMap<string, string> }> {
	const { plan, remote } = options;
	// Seeded from the plan rather than started at `null`, so a progress line has the budget to show
	// from its first report rather than after its first upload.
	const api = createRemoteApi(options, {
		remaining: plan.requestsRemaining,
		resetAt: plan.requestsResetAt
	});

	// ⚠ **The publish pass is authoritative; the plan is a forecast.** This editor autosaves
	// continuously and a pyramid upload runs for minutes, so a file the plan hashed can be different
	// bytes by the time it is sent — and deciding what to upload from the plan's `onRemote` flag, then
	// committing the plan's SHA, fails two silent ways. Either the old blob is not on the Remote and
	// `POST /git/trees` 422s *after every blob has been uploaded*, or the old blob **is** there from a
	// previous publish, the commit succeeds, and the Published Site serves the pre-edit content while
	// the publish reports success. So every file is re-read here, hashed again, and the tree is built
	// from what was actually sent.
	const held = new Set([
		...plan.files.filter((file) => file.onRemote).map((file) => file.sha),
		...plan.preserved.map((entry) => entry.sha)
	]);
	// The plan's count is what the user was shown before pressing the button, so it stays the
	// denominator. A file edited mid-publish can push the numerator past it, and "10 of 9" is a worse
	// answer to a scholar than a forecast that turned out one short.
	const forecast = blobsToUpload(plan.files).length;
	let sent = 0;
	const total = () => Math.max(forecast, sent);
	const report = () =>
		options.onProgress?.({
			files: sent,
			totalFiles: total(),
			requestsRemaining: api.budget.remaining
		});

	report();
	const entries: RemoteTreeEntry[] = [...plan.preserved];
	for (const file of plan.files) {
		const bytes = file.authored ? EMPTY_FILE : await store.read(file.path);
		const computed = await gitBlobSha(bytes);
		let sha = computed;
		if (!held.has(computed)) {
			const response = await api.call('/git/blobs', {
				method: 'POST',
				body: JSON.stringify({ content: encodeBase64(bytes), encoding: 'base64' })
			});
			// No retry loop. A budget that has run out is not a transient failure, and hammering it is
			// how a scholar's token gets a secondary rate limit on top of the one they already met.
			if (!response.ok) throw await failureFrom(response, api, 'blobs', sent, total());
			// The name GitHub gave the object it stored is what the tree has to point at.
			sha = await shaOf(response);
			// Both, so a second path holding the same bytes is still one `POST /git/blobs` between them
			// (ADR-0033's request budget) whichever spelling of the SHA it is recognised by.
			held.add(computed);
			held.add(sha);
			sent += 1;
			report();
		}
		entries.push({ path: file.path, sha, mode: BLOB_MODE, bytes: bytes.byteLength });
	}

	// The whole tree, never a `base_tree`. An incremental tree posted against the Remote's own would
	// keep every path this publish means to delete — a deleted Project's pyramid still counted
	// against the hosting budget, and no assertion on the resulting tree could explain why.
	const tree = await api.call('/git/trees', {
		method: 'POST',
		body: JSON.stringify({
			tree: entries.map((entry) => ({
				path: entry.path,
				mode: entry.mode,
				// A submodule preserved from the Remote is a `commit` entry, not a blob.
				type: entry.mode === GITLINK_MODE ? 'commit' : 'blob',
				sha: entry.sha
			}))
		})
	});
	if (!tree.ok) throw await failureFrom(tree, api, 'tree', sent, total());

	const commit = await api.call('/git/commits', {
		method: 'POST',
		body: JSON.stringify({
			message: COMMIT_MESSAGE,
			tree: await shaOf(tree),
			// Parented onto whatever the branch held, so a commit the scholar made on github.com is
			// still in the history afterwards. An orphan here would be a force push over their work.
			parents: plan.head === null ? [] : [plan.head]
		})
	});
	if (!commit.ok) throw await failureFrom(commit, api, 'commit', sent, total());
	const commitSha = await shaOf(commit);

	// The one moment anything becomes visible. An empty repository has no ref and gets one created.
	const moved =
		plan.head === null
			? await api.call('/git/refs', {
					method: 'POST',
					body: JSON.stringify({ ref: `refs/heads/${remote.branch}`, sha: commitSha })
				})
			: await api.call(`/git/refs/heads/${branchPath(remote.branch)}`, {
					method: 'PATCH',
					body: JSON.stringify({ sha: commitSha, force: false })
				});
	if (!moved.ok) throw await failureFrom(moved, api, 'ref', sent, total());

	return {
		commit: commitSha,
		manifest: new Map(entries.map((entry) => [entry.path, entry.sha]))
	};
}

// ── What the refusals and the warnings say ────────────────────────────────────────────────────

/** A clock time a person reads, or `''` when the Remote never said when the budget resets. */
const describeReset = (resetAt: Date | null): string =>
	resetAt === null
		? ''
		: resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function truncatedMessage(listed: number, remote: RemoteRepository): string {
	return (
		`GitHub could only list the first ${listed} files in ${remote.owner}/${remote.repository}, so ` +
		`it cannot say which of your files are already there. Publishing anyway would send everything ` +
		`again and then leave a site with most of a Historical Map silently missing, so nothing has ` +
		`been sent. This repository has to hold fewer files before it can be published to: deleting ` +
		`Historical Maps no Project uses is usually where the count is.`
	);
}

function tooManyFilesMessage(files: number): string {
	return (
		`This Workspace holds ${files} files, and ${MAX_PUBLISHED_FILES} is the most that can be ` +
		`published to GitHub in one go — past that, GitHub stops listing a repository's files and a ` +
		`publish can no longer tell what is already there. Nothing has been sent. A Historical Map's ` +
		`tiles are almost always what the count is: deleting one no Project uses, or referencing a ` +
		`very large sheet from its library rather than copying it, is the way down.`
	);
}

function hostingLimitMessage(bytes: number): string {
	return (
		`Your Published Site would hold ${describeBytes(bytes)}, past the ` +
		`${describeBytes(STATIC_HOSTING_LIMIT_BYTES)} GitHub Pages will publish. This is a cliff ` +
		`rather than a slowdown: the push may well fail outright. Offline Base Map tiles are usually ` +
		`what the bytes are — they are about 152 kB each — and Historical Maps no Project uses are the ` +
		`other place to look.`
	);
}

function noRepositoryMessage(remote: RemoteRepository): string {
	return (
		`GitHub has no repository at ${remote.owner}/${remote.repository}, or none this sign-in can ` +
		`see, so there is nothing to publish to and nothing has been sent. Check the owner and the ` +
		`repository name, and that the account you signed in with still has access to it — a private ` +
		`repository looks exactly like a missing one to somebody who cannot open it.`
	);
}

/**
 * What a 401 says, which is about the sign-in and never about the repository.
 *
 * It names no permission to go and tick, because a 401 is GitHub declining to look at the credential
 * at all — a token that has expired, been revoked, or had this repository removed from it. A token
 * that is fine and lacks `contents: write` answers 403 and is
 * {@link RemotePublishFailedError}'s sentence instead.
 */
function expiredCredentialMessage(
	remote: RemoteRepository,
	phase: RemotePublishPhase,
	sent: number,
	total: number
): string {
	// ⚠ **"Nothing has been sent" and "8 of 40 files had been sent" cannot both be on screen.** They
	// were, because this is raised at the first credentialed request *and* part way through an upload.
	// The load-bearing half is the Published Site, which is untouched either way — nothing is visible
	// until the ref moves — so that is what the sentence claims, and the blobs are reported as what
	// they are: loose objects in no tree, which the next publish sends again.
	return (
		`Your GitHub sign-in has expired, so this publish stopped and your Published Site is exactly ` +
		`as it was. ${describeProgress(phase, sent, total)}. A token that has been revoked, or that has ` +
		`had ${remote.owner}/${remote.repository} taken off it, looks exactly like an expired one from ` +
		`here. Sign in again with a fine-grained personal access token that has “Contents: Read and ` +
		`write” for that repository, and publish again.`
	);
}

/** What the publish had got through when a request was refused, for both failure sentences. */
const PHASE_WORK: Record<Exclude<RemotePublishPhase, 'blobs'>, string> = {
	tree: 'building the tree it would commit',
	commit: 'writing the commit',
	ref: 'moving the branch to the new commit'
};

function describeProgress(phase: RemotePublishPhase, sent: number, total: number): string {
	if (phase === 'blobs') {
		return sent === 0 ? 'Nothing had been sent' : `${sent} of ${total} files had been sent`;
	}
	const files =
		total === 0 ? 'There were no new files to send' : `All ${total} files had been sent`;
	return `${files}, and the publish was ${PHASE_WORK[phase]}`;
}

function requestBudgetMessage(uploads: number, remaining: number, resetAt: Date | null): string {
	const at = describeReset(resetAt);
	// The tree, the commit, and the ref move are counted with the blobs: a plan three short of the
	// budget uploads everything and then meets the 403 at the tree, having spent all of it for nothing.
	const total = uploads + REQUESTS_BEYOND_BLOBS;
	return (
		`Publishing sends ${uploads} new files and then writes the commit holding them, ${total} ` +
		`requests in all, and GitHub allows ${remaining} more requests this hour. It will stop part ` +
		`way through, and nothing will have been published when it does: your Published Site stays ` +
		`exactly as it is until the whole of a publish has arrived. Publishing again ` +
		`${at === '' ? 'once the budget resets' : `after ${at}, when the budget resets,`} starts the ` +
		`upload again from the beginning.`
	);
}

function rateLimitMessage(
	phase: RemotePublishPhase,
	filesSent: number,
	totalFiles: number,
	resetAt: Date | null
): string {
	const at = describeReset(resetAt);
	// ⚠ It does not offer to resume, because it cannot. The blobs already posted are loose objects in
	// no tree, so the next publish's tree listing cannot see them and will send them again.
	return (
		`GitHub's hourly request budget ran out. ${describeProgress(phase, filesSent, totalFiles)}. ` +
		`Nothing has been published: the branch has not moved and your Published Site is exactly as it ` +
		`was. Publishing again ` +
		`${at === '' ? 'once the budget resets' : `after ${at}, when the budget resets,`} starts the ` +
		`upload again from the beginning.`
	);
}
