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

import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	workspaceSize,
	type WorkspaceSize
} from '../project/workspace-size.js';
import type { Bytes, ProjectStore } from '../store/project-store.js';
import { JEKYLL_OFF_MARKER } from '../transfer/viewer-files.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_API_ORIGIN, describeReset, rateLimitOf } from './github-api.js';
import { classifyInventory, recognisedProjectDirectories } from './synchronization-paths.js';
import { planWorkspacePublish } from './synchronization-planner.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import type { PlanRefusal } from './synchronization-planner.js';

/**
 * The most files a publish will put in one commit.
 *
 * Well under the 100 000 entries at which `GET /git/trees/{ref}?recursive=1` truncates, because the
 * *other* half of that endpoint's limit is a 7 MB response and a path is not a fixed number of bytes
 * — so the entry count is a ceiling that arrives early rather than a threshold to sit against
 * (ADR-0031, ADR-0033). A Map Image pyramid is what reaches it: `MAX_INGEST_PIXELS` is the
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
 * Why an ordinary publish will not go ahead without being told to replace what is there (ADR-0038).
 *
 * One refusal with two remedies, never a per-file choice and never a merge: three-way merging
 * `project.json`, a GeoJSON or an Alignment is the collision ADR-0024 refuses to answer, and there
 * is no honest resolution for two Alignments of one sheet.
 *
 * ⚠ **The reason is {@link planWorkspacePublish}'s, not a second vocabulary.** The passive Remote
 * Status, Update's refusals and this one are the same three-way table asked the same question, and a
 * spelling of its own here is how the bar comes to say `Update available` while the dialog says
 * nothing is wrong.
 */
export type RemotePublishConflict = {
	readonly reason: PlanRefusal;
	/** The source paths at stake, sorted. Naming them is the whole of the reporting: there is no diff. */
	readonly paths: readonly string[];
	/** The refusal, in the words the user should see, naming the files and both remedies. */
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
	 * The Workspace's source namespace, `path -> blob SHA`: the Baseline a success may record.
	 *
	 * ⚠ **Source only, and the exclusion is the point.** A Publish regenerates its own viewer output
	 * and mirrors it, so recording `_app/**` and `index.html` as shared *source* would make every
	 * chunk name another editor version writes look like inbound scholarship (SPEC stories 120, 145).
	 * Generated differences are Published Site staleness and nothing else.
	 *
	 * It is a forecast like the rest of the plan; {@link publishToRemote} records the SHAs it actually
	 * sent, and uses this only to know which of them are source.
	 */
	readonly source: ReadonlyMap<string, string>;
	/** Owned source paths the Remote holds that this publish takes down, sorted. */
	readonly removed: readonly string[];
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
	 * Why this publish would overwrite work this Workspace has never seen, or `null` (ADR-0033).
	 *
	 * ⚠ **A fact on the plan rather than a throw, because the refusal has a remedy the plan itself
	 * carries out.** "Publish anyway, replacing it" is one of the two remedies the user is offered,
	 * and raising this at plan time would make taking it mean planning again — a second tree listing,
	 * against a Remote that may have moved between the two, so the paths named in the refusal would
	 * not be the paths replaced by the act of accepting it. {@link publishToRemote} is where the
	 * refusal binds: it will not send a byte while this is set unless
	 * {@link PublishToRemoteOptions.replace} says to.
	 */
	readonly conflict: RemotePublishConflict | null;
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
	/**
	 * What this installation last saw this Workspace and this Remote share, or `null` for *we cannot
	 * say* (ADR-0038).
	 *
	 * ⚠ **Evidence about a Remote, and the caller has to have checked it is about *this* one.**
	 * `SynchronizationMetadata.readBaseline` takes the repository and answers `null` for a record
	 * naming another, so handing it that record is safe; one assembled any other way is a claim this
	 * engine cannot validate and would act on.
	 *
	 * ⚠ **It must be built from what a transfer actually *wrote*, never from what a tree *listed*.** A
	 * partial download that recorded the whole listing would make every path it never fetched look
	 * like a path this machine had seen — and the refusal below would then bless the deletion of all
	 * of them as a legitimate removal, which is most of somebody's site taken down by an interrupted
	 * transfer.
	 *
	 * Absent or `null` is the honest answer for a first publish, for a Baseline lost with browser
	 * storage, and for one written about a different repository — and it is refused rather than
	 * guessed at: see {@link PlanRefusal}'s `unknown-history`.
	 */
	readonly baseline?: SynchronizationBaseline | null;
};

export type PublishToRemoteOptions = RemotePublishOptions & {
	/**
	 * ⚠ **A plan made after the local publish has written, never the forecast the user was shown.**
	 * Only {@link RemotePublishPlan.files} is uploaded, so a plan still carrying
	 * {@link RemotePublishPlan.pending} would commit a site with no `index.html` in it — see
	 * `EditorSession.publishToRemote`, which re-plans for exactly this reason.
	 */
	readonly plan: RemotePublishPlan;
	/**
	 * Go ahead even though {@link RemotePublishPlan.conflict} is set: *publish anyway, replacing it*.
	 *
	 * ⚠ **The default refuses, and the refusal lives here rather than only in the interface.** A
	 * caller that never looked at `conflict` would otherwise overwrite another machine's afternoon in
	 * silence, which is the failure this whole check exists for. Safe to offer because ADR-0033's
	 * owned namespace preserves everything outside itself: the only thing a replace can destroy is
	 * other Ballastella work, which is what lets the refusal name files rather than say "the remote
	 * has moved".
	 *
	 * ⚠ **`true` means "replace whatever *this* plan found", so it is only honest from a caller
	 * holding the plan the user actually read.** An interface that forecasts, publishes locally, and
	 * then plans again — which `EditorSession.publishToRemote` must, or it would commit a site with no
	 * `index.html` — is not that caller: a large publish runs for minutes, and a scholar who agreed to
	 * replacing one `notes.json` would silently authorise deleting a Project another machine published
	 * in the meantime. `force: false` on the ref move does not catch it, because the second plan is
	 * built on the new head and its commit is a legitimate fast-forward.
	 *
	 * So such a caller passes **the paths of the conflict it showed**, and this refuses when the plan's
	 * conflict is not a subset of them — the consent is about a set of files, and a set that has grown
	 * is a set nobody has consented to.
	 */
	readonly replace?: boolean | readonly string[];
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

// ── The transport ─────────────────────────────────────────────────────────────────────────────

type Budget = { remaining: number | null; resetAt: Date | null };

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
			// `access-control-expose-headers`, so the browser can see what it has left (ADR-0031). Kept
			// from the last response that said anything, so a response with the headers stripped leaves
			// the budget as it was rather than blanking it.
			const said = rateLimitOf(response.headers);
			if (said.remaining !== null) budget.remaining = said.remaining;
			if (said.resetAt !== null) budget.resetAt = said.resetAt;
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
 * Establish that this repository exists and that this credential may push to it (SPEC story 106).
 *
 * ⚠ **A publish's first request, before the tree is listed and long before a blob is sent.** Every
 * request the forecast makes is a GET, so a credential with `Contents: Read` and nothing else plans
 * perfectly and meets its 403 at the first blob — after the local publish has written the whole
 * website into the Workspace and after minutes of uploading a pyramid. The rights are read when a
 * Remote is bound and when a token is pasted and at no other moment, so neither answers the question
 * *now*: an account whose access was withdrawn this morning still reads as signed in.
 *
 * It also subsumes the repository-existence probe the ref read used to make on a 404: GitHub answers
 * 404 for a repository that does not exist **and** for one the credential cannot see, so a typo'd
 * name and a revoked token would otherwise be planned as a full upload with no warning.
 *
 * @throws RemotePublishRefusedError when there is no such repository, or the account cannot push
 */
async function assertPushable(api: RemoteApi, remote: RemoteRepository): Promise<void> {
	const response = await api.call('');
	if (response.status === 404) throw new RemotePublishRefusedError(noRepositoryMessage(remote));
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);
	const body = (await response.json().catch(() => ({}))) as { permissions?: { push?: unknown } };
	// `false` for a token with no write permission **and** for a response carrying no `permissions` at
	// all, exactly as `readRemoteRights` reads it. Both mean this publish cannot complete.
	if (body.permissions?.push !== true) throw new RemotePublishRefusedError(readOnlyMessage(remote));
}

/**
 * The branch's current commit, or `null` when the repository has no ref at all.
 *
 * Called after {@link assertPushable}, so a 404 here is a branch this repository has not got rather
 * than a repository nobody can see.
 */
async function readHead(api: RemoteApi, remote: RemoteRepository): Promise<string | null> {
	const response = await api.call(`/git/ref/heads/${branchPath(remote.branch)}`);
	// ⚠ **409 `Git Repository is empty.` is how GitHub reports a repository with no commits**, and it
	// is not 404. That is the repository `github.com/new` makes when the scholar leaves the README
	// unticked — the sequence ticket 03's "create the repository" link walks them through — so read as
	// an ordinary refusal it kills the *first* publish, the one publish nobody can have got wrong yet.
	if (response.status === 409) return null;
	// A repository proven to exist a request ago, so this is a branch it does not hold yet.
	if (response.status === 404) return null;
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);
	const body = (await response.json()) as { object?: { sha?: unknown } };
	const sha = body.object?.sha;
	return typeof sha === 'string' ? sha : null;
}

/**
 * Give a repository with no commits its branch, and answer the commit that now heads it.
 *
 * ⚠ **The Git Data API cannot do this.** `POST /git/blobs`, `/git/trees` and `/git/commits` all
 * answer 409 `Git Repository is empty.` until a repository holds one commit — the same refusal the
 * ref read gets — so there is no order of those three calls that opens an empty repository. The
 * Contents API is the exception, and it is what github.com's own "create a new file" button uses.
 *
 * `.nojekyll` is what gets written, because it is the one file the publish has to put there anyway
 * (ADR-0006): without it Pages hands the whole site to Jekyll, which drops `_app/`, and the reader
 * gets a blank page. So the seed is not scaffolding to be cleaned up later — it is the first of this
 * publish's own files, arriving one commit early.
 *
 * The commit it makes is the parent of the publish's own, so the history reads as a repository that
 * was opened and then published into, and nothing is force-pushed over.
 *
 * @throws RemotePublishRefusedError when GitHub refuses to open the repository
 */
async function seedEmptyRepository(
	api: RemoteApi,
	remote: RemoteRepository,
	sent: number,
	total: () => number
): Promise<string> {
	const response = await api.call(`/contents/${JEKYLL_OFF_MARKER}`, {
		method: 'PUT',
		body: JSON.stringify({
			message: COMMIT_MESSAGE,
			// An empty file: `.nojekyll`'s content is its existence. Base64 of nothing is nothing.
			content: '',
			branch: remote.branch
		})
	});
	if (!response.ok) throw await failureFrom(response, api, 'blobs', sent, total());
	const body = (await response.json()) as { commit?: { sha?: unknown } };
	const sha = body.commit?.sha;
	if (typeof sha !== 'string' || sha === '') {
		throw new RemotePublishRefusedError(
			`GitHub opened ${remote.owner}/${remote.repository} but did not say which commit it made, ` +
				`so this publish has nothing to build on. Try publishing again.`
		);
	}
	return sha;
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
 * Whether an ordinary publish may go ahead, and what to say when it may not (ADR-0038).
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE DECISION IS `planWorkspacePublish`'S. WHAT IS DONE HERE IS THE WORDING FOR IT.        │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * A publish that refused whenever the branch's head had moved would refuse after the scholar edited
 * their own `README.md` on github.com — a file no publish here touches. ADR-0033 names that and
 * refuses it, and the reason is behavioural rather than aesthetic: a check that cries wolf is a
 * check people learn to force through, and the one time it is right is then the one time it is
 * dismissed. So the question is asked per source path against the Baseline, by the one
 * implementation of SPEC's table that the Remote Status control and Update from GitHub also read.
 *
 * ⚠ **A deletion is the destructive half, and only the Baseline licenses it.** A source path this
 * publish would *not* write is a path the mirror removes — a Project deleted here since the last
 * publish, whose whole pyramid goes with it. That is right when the Baseline says this machine put
 * the file there, and it is the loss the refusal exists to prevent when it does not: a Workspace
 * missing paths it has never seen would otherwise take the whole of somebody's site down with one
 * press. Which is why no Baseline is `unknown-history` rather than *nothing was there*.
 */
function refusalOf(
	refused: { readonly reason: PlanRefusal; readonly paths: readonly string[] },
	removed: readonly string[],
	remote: RemoteRepository
): RemotePublishConflict {
	const paths = [...refused.paths].sort();
	const message =
		refused.reason === 'unknown-history'
			? cannotTellMessage(remote, paths.length, removed)
			: refused.reason === 'conflict'
				? bothSidesMessage(remote, paths)
				: remoteChangesMessage(remote, paths, refused.reason === 'changes-on-both-sides');
	return { reason: refused.reason, paths, message };
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

	// Before the tree listing, and long before a blob: SPEC story 106.
	await assertPushable(api, options.remote);

	const head = await readHead(api, options.remote);
	const remote = head === null ? [] : await readRemoteTree(api, options.remote, head);

	const onRemote = new Set(remote.map((entry) => entry.sha));

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

	// The union of all three inventories, exactly as `compareSource` takes it: a Project deleted here
	// is still recognised as ours from the Remote or the Baseline, so its whole directory stays inside
	// the owned namespace and its pyramid is removed rather than silently preserved forever.
	const projects = recognisedProjectDirectories({
		local: files.map((file) => file.path),
		remote: remote.map((entry) => entry.path),
		baseline: options.baseline?.files.keys() ?? []
	});

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

	// Outside Ballastella's namespace, and not something the Workspace is sending anyway. This is the
	// half that keeps a `CNAME`, a `README.md`, and a `docs/` folder the scholar added.
	const preserved = classifyInventory(remote, projects).outside.filter(
		(entry) => !held.has(entry.path)
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

	// ⚠ **The decision, asked of ticket 09's planner and asked twice on purpose.** The first call is
	// the ordinary Publish and answers whether it may go ahead; the second is the Publish anyway,
	// which never refuses and is therefore the one that can say what either mode would settle. Both
	// are pure over the same three inventories, so this costs no request and cannot disagree with the
	// Remote Status on the bar.
	//
	// The pending viewer files are deliberately absent from `local`: every one of them is Publish-owned
	// output, which is not source and cannot be inbound change or a Conflict (SPEC story 120).
	const comparison = {
		local: files.map((file) => ({ path: file.path, sha: file.sha })),
		remote: remote.map((entry) => ({ path: entry.path, sha: entry.sha })),
		baseline: options.baseline ?? null
	};
	const ordinary = planWorkspacePublish(comparison);
	const anyway = planWorkspacePublish(comparison, { replace: true });
	const settled = anyway.outcome === 'planned' ? anyway.plan : null;

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
		source: settled?.advances ?? new Map<string, string>(),
		removed: settled?.removed ?? [],
		conflict:
			ordinary.outcome === 'refused'
				? refusalOf(ordinary, settled?.removed ?? [], options.remote)
				: null,
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
 * ⚠ **The Baseline it returns is built from what was actually sent**, entry by entry, as the loop
 * below fills `written` — never from the plan and never from the tree the Remote listed. A record
 * assembled from a listing would claim paths a stopped publish never reached, and the next publish
 * would read that claim as permission to delete them. That is why `plan.preserved` goes into the
 * *tree* and not into the Baseline: its SHAs come straight from the listing, and nothing here has
 * seen their bytes. Harmless while a preserved path is outside Ballastella's namespace by
 * construction — and it stops being harmless the moment a path changes hands, when the Remote gains
 * a `project.json` for a directory whose files were preserved last time and those unverified SHAs
 * become licence to delete them.
 *
 * ⚠ **Generated output is sent and is not recorded**, which is the one asymmetry here (SPEC stories
 * 120, 145). The commit holds `index.html` and the whole of `_app/**` because a Published Site needs
 * them; the source Baseline holds neither, because a chunk name another editor version writes is
 * staleness to republish and never scholarship somebody changed.
 *
 * @returns the new commit; the source Baseline a caller persists so the next transfer can tell its
 *   own work from somebody else's; and the source paths whose local-change marks that Baseline now
 *   accounts for
 * @throws RemotePublishRefusedError when the plan carries a conflict `replace` does not cover
 * @throws RemotePublishRateLimitedError when the hourly budget runs out part way through
 */
export async function publishToRemote(
	store: ProjectStore,
	options: PublishToRemoteOptions
): Promise<{
	readonly commit: string;
	readonly baseline: ReadonlyMap<string, string>;
	readonly shared: readonly string[];
}> {
	const { plan, remote } = options;
	// Before anything is read, hashed, or sent — see {@link PublishToRemoteOptions.replace}.
	if (plan.conflict !== null) {
		const agreed = options.replace;
		if (agreed === undefined || agreed === false) {
			throw new RemotePublishRefusedError(plan.conflict.message);
		}
		if (agreed !== true) {
			const consented = new Set(agreed);
			const unseen = plan.conflict.paths.filter((path) => !consented.has(path));
			if (unseen.length > 0) {
				throw new RemotePublishRefusedError(movedSinceAgreedMessage(remote, unseen));
			}
		}
	}
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

	// ⚠ **The Git Data API refuses everything until a repository has one commit.** `POST /git/blobs`
	// answers 409 `Git Repository is empty.` exactly as the ref read does, so a repository made the way
	// this tool tells a scholar to make it — `github.com/new` with nothing ticked — cannot be published
	// into at all: the refusal arrives at the first blob, after the plan has promised it would work.
	// The Contents API is the one endpoint that does write to an empty repository, and it is how
	// github.com's own "create a new file" works. So the branch is brought into being with the file
	// that has to be there anyway, and the publish proceeds as it does for every later one.
	const head = plan.head === null ? await seedEmptyRepository(api, remote, sent, total) : plan.head;

	report();
	/** What this publish put there, path by path — the tree's other half and the whole manifest. */
	const written: RemoteTreeEntry[] = [];
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
		written.push({ path: file.path, sha, mode: BLOB_MODE, bytes: bytes.byteLength });
	}

	// The whole tree, never a `base_tree`. An incremental tree posted against the Remote's own would
	// keep every path this publish means to delete — a deleted Project's pyramid still counted
	// against the hosting budget, and no assertion on the resulting tree could explain why.
	const tree = await api.call('/git/trees', {
		method: 'POST',
		body: JSON.stringify({
			tree: [...plan.preserved, ...written].map((entry) => ({
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
			// On a first publish that parent is the seed commit above, which exists for the same reason.
			parents: [head]
		})
	});
	if (!commit.ok) throw await failureFrom(commit, api, 'commit', sent, total());
	const commitSha = await shaOf(commit);

	// The one moment anything becomes visible. The branch always exists by now — an empty repository
	// was given one by `seedEmptyRepository` before the first blob was sent — so this is always a move.
	const moved = await api.call(`/git/refs/heads/${branchPath(remote.branch)}`, {
		method: 'PATCH',
		body: JSON.stringify({ sha: commitSha, force: false })
	});
	if (!moved.ok) throw await failureFrom(moved, api, 'ref', sent, total());

	const baseline = new Map(
		written.filter((entry) => plan.source.has(entry.path)).map((entry) => [entry.path, entry.sha])
	);
	return {
		commit: commitSha,
		baseline,
		// ⚠ **The removals belong here too.** A Project deleted in this Workspace is a `deleted` mark
		// the index holds and a path the Baseline no longer carries, so a caller clearing only the
		// Baseline's own keys would leave the mark standing for a path neither side has any more.
		shared: [...baseline.keys(), ...plan.removed].sort()
	};
}

// ── What the refusals and the warnings say ────────────────────────────────────────────────────

function truncatedMessage(listed: number, remote: RemoteRepository): string {
	return (
		`GitHub could only list the first ${listed} files in ${remote.owner}/${remote.repository}, so ` +
		`it cannot say which of your files are already there. Publishing anyway would send everything ` +
		`again and then leave a site with most of a Map Image silently missing, so nothing has ` +
		`been sent. This repository has to hold fewer files before it can be published to: deleting ` +
		`Map Images no Project uses is usually where the count is.`
	);
}

/** How many paths a refusal names before it starts counting instead. */
const NAMED_PATHS = 6;

/**
 * The paths, as a sentence.
 *
 * Capped, because the count that reaches this can be a whole pyramid: eleven thousand file names is
 * not a list anybody reads, and it would bury the two remedies underneath it. Naming the paths is
 * the whole of the reporting either way — there is no diff and no per-file choice (SPEC "Out of
 * scope" item 3).
 */
function describePaths(paths: readonly string[]): string {
	const named = paths.slice(0, NAMED_PATHS).join(', ');
	const rest = paths.length - NAMED_PATHS;
	return rest > 0 ? `${named}, and ${rest} more` : named;
}

/**
 * The two ways on, said the same way in both refusals.
 *
 * ⚠ **"Publish anyway" is safe to offer, and the last sentence is why.** ADR-0033's owned namespace
 * preserves everything outside itself, so the only thing a replace can destroy is other Ballastella
 * work — which is what lets this be specific rather than a generic "the remote has moved", and what
 * stops a scholar reading it as a threat to the `CNAME` their published address depends on.
 *
 * ⚠ **It promises about paths this Workspace does not hold, and not about names.** A publish sends
 * everything `store.list('')` answers, so a folder-backed Workspace holding its own `README.md`,
 * `CNAME` or workflow publishes it like any other file — outside the owned namespace, so the
 * refusal above would not have flagged it either. Said as "a README is left alone" this reassurance
 * is false for exactly the scholar who would be most annoyed by it, and it is load-bearing for the
 * "publish anyway" decision, so it says what is actually true instead.
 */
function remedies(remote: RemoteRepository): string {
	const where = `${remote.owner}/${remote.repository}`;
	return (
		`There are two ways on. Open ${where} from GitHub into a new Workspace to see what is on it — ` +
		`that never overwrites or merges anything, so this Workspace is left exactly as it is. Or ` +
		`publish anyway, replacing what is there with this Workspace. Either way, nothing in ${where} that this ` +
		`Workspace has no file for is touched: a README, a CNAME, or a workflow you added on GitHub is ` +
		`left exactly as it is.`
	);
}

/**
 * What a credential that may read and not write says (SPEC story 106).
 *
 * ⚠ **It is a refusal rather than a warning, and it arrives before the local publish runs.** The
 * same news said at sign-in is a notice beside a Publish button that still works — every request a
 * forecast makes is a GET — and the 403 then arrives at the first blob, with the whole website
 * already written into the Workspace and nothing on the Remote to show for it.
 */
function readOnlyMessage(remote: RemoteRepository): string {
	const where = `${remote.owner}/${remote.repository}`;
	return (
		`The GitHub account you are signed in with can read ${where} but cannot push to it, so this ` +
		`publish would stop part way through and nothing has been sent. Sign in again with a ` +
		`fine-grained personal access token that has “Contents: Read and write” for ${where}, or ask ` +
		`whoever owns it for write access. Update from GitHub needs no write access at all, so ` +
		`bringing that repository's work into this Workspace still works.`
	);
}

/**
 * What Remote source change says, naming the files it is about.
 *
 * Files rather than "the remote has changed", because the two remedies need a scholar to be able to
 * recognise the work: "somebody has published here" is not something they can weigh, and
 * `amsterdam-1625/annotations/notes.json` is.
 *
 * ⚠ **The first remedy is Update from GitHub, not a Clone** (SPEC story 133). Bringing the Remote's
 * work in is the whole point of the refusal: it leaves this Workspace's own unpublished changes
 * alone, and publishing afterwards sends a Remote that is the complete current Workspace rather than
 * one missing an afternoon.
 */
function remoteChangesMessage(
	remote: RemoteRepository,
	paths: readonly string[],
	alsoLocal: boolean
): string {
	const count = paths.length;
	return (
		`${remote.owner}/${remote.repository} holds ${count === 1 ? 'a change' : `${count} changes`} ` +
		`this Workspace has not taken in yet, so publishing now would replace work done somewhere ` +
		`else — from another computer, or by somebody else. Nothing has been sent. ` +
		`${count === 1 ? 'It is' : 'They are'}: ${describePaths(paths)}. Update from GitHub first — ` +
		`that brings ${count === 1 ? 'it' : 'them'} in and leaves this Workspace's own unpublished ` +
		`work alone${alsoLocal ? ', and there is some of that here' : ''} — and then publish, so that ` +
		`${remote.owner}/${remote.repository} becomes the whole of this Workspace rather than a state ` +
		`missing somebody's afternoon. Or publish anyway, replacing what is there with this Workspace. ` +
		`Either way, nothing in ${remote.owner}/${remote.repository} that this Workspace has no file ` +
		`for is touched: a README, a CNAME, or a workflow you added on GitHub is left exactly as it is.`
	);
}

/**
 * What a path changed on both sides says.
 *
 * ⚠ **Update is not offered, because Update refuses this too.** A Conflict is the one row of SPEC's
 * table with no safe inbound answer — Ballastella will not choose between two versions of an
 * Annotation or two Alignments of one sheet (ADR-0024) — so the only way on from here is the
 * deliberate local-wins replacement, and saying "Update first" would send the author round a loop.
 */
function bothSidesMessage(remote: RemoteRepository, paths: readonly string[]): string {
	const where = `${remote.owner}/${remote.repository}`;
	const count = paths.length;
	return (
		`${count === 1 ? 'One file has' : `${count} files have`} been changed both here and on ` +
		`${where} since the two last shared state: ${describePaths(paths)}. Ballastella will not ` +
		`choose between two versions of your work, so nothing has been sent and Update from GitHub ` +
		`will refuse this for the same reason. Open ${where} in a new Workspace to see what is there ` +
		`— that changes nothing on either side — or publish anyway, replacing what is there with this ` +
		`Workspace. Either way, nothing in ${where} that this Workspace has no file for is touched.`
	);
}

/**
 * What a Remote that moved between the offer and the acceptance says.
 *
 * ⚠ **It names only the files that were *not* agreed to**, because that is the whole of the news. A
 * scholar who pressed "publish anyway, replacing it" over one Annotation has read a refusal already,
 * and repeating the paths they accepted would bury the ones they did not under a list they have
 * decided about. The remedy is one press: publishing again forecasts against what is on the Remote
 * now, and the refusal that follows is about the set they can actually consent to.
 */
function movedSinceAgreedMessage(remote: RemoteRepository, unseen: readonly string[]): string {
	const where = `${remote.owner}/${remote.repository}`;
	const count = unseen.length;
	return (
		`${where} changed while this publish was being prepared, so it has stopped rather than replace ` +
		`something you were never shown. You agreed to replace what was on it a moment ago; since ` +
		`then ${count === 1 ? 'another file has' : `${count} more files have`} arrived that ` +
		`${count === 1 ? 'was' : 'were'} not part of that: ${describePaths(unseen)}. Nothing has been ` +
		`sent and your Published Site is exactly as it was. Publish again to see what is there now — ` +
		`the same two ways on will be offered, about the files that are actually at stake.`
	);
}

/**
 * What no manifest says: that we cannot tell, and — from the deletion count — how alarmed to be.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ ONE SENTENCE CANNOT SERVE BOTH READERS, SO THE NUMBER OF DELETIONS CHOOSES BETWEEN THEM.      │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Every Workspace cloned from a Remote is in this state until it has published once, and so is every
 * Workspace whose browser storage has been cleared — so one reader has done nothing wrong and is
 * looking at a refusal on the first press of a button. Said as an alarm it reads as data loss, and a
 * scholar who meets an alarm that was wrong learns to press through the next one (story 24).
 *
 * The other reader is a partial Clone, a second machine, or a stale Backup, and for them publishing
 * takes work down. `removed` is what separates the two and it is not a guess: after a *complete*
 * Open it is empty by construction, because every owned path on the Remote is a path the Workspace
 * holds or the local publish is about to write. So a plain sentence when nothing would go, and a
 * warning naming the count and the paths when something would — which is the half the old wording
 * left out altogether, while "publish over" said *overwrite* about files that would be deleted.
 *
 * @param files how many owned paths the Remote holds in all
 * @param removed the owned paths this publish would delete, sorted
 */
function cannotTellMessage(
	remote: RemoteRepository,
	files: number,
	removed: readonly string[]
): string {
	const where = `${remote.owner}/${remote.repository}`;
	const one = files === 1;
	const opening =
		`This Workspace has not published to ${where} from this browser before, so there is no record ` +
		`here of what was last sent there — and ${where} already holds ${files} ` +
		`${one ? 'file' : 'files'} this app publishes. Nothing has been sent, because nothing here can ` +
		`tell whether ${one ? 'it is' : 'they are'} an older copy of this Workspace's work or newer ` +
		`work from somewhere else.`;

	if (removed.length === 0) {
		return (
			`${opening} Publishing would replace ${one ? 'it' : 'every one of them'} with this ` +
			`Workspace's own copy, and take nothing down: this Workspace has a file for ` +
			`${one ? 'it' : 'each of them'}. That is the ordinary state of a Workspace opened from ` +
			`${where}, one published from another computer, and one whose browser storage has been ` +
			`cleared since — it is not a sign that anything has gone wrong. ${remedies(remote)}`
		);
	}

	const count = removed.length;
	return (
		`${opening} ${count === 1 ? 'One of them is' : `${count} of them are`} not in this Workspace ` +
		`at all, so publishing would delete ${count === 1 ? 'it' : 'them'} from ${where}: ` +
		`${describePaths(removed)}. That is what a Workspace that was opened only part of the way, or ` +
		`that has not caught up with another computer, looks like from here — and it is also what a ` +
		`Project deliberately deleted here looks like, which is why this is a refusal rather than a ` +
		`guess. ${remedies(remote)}`
	);
}

function tooManyFilesMessage(files: number): string {
	return (
		`This Workspace holds ${files} files, and ${MAX_PUBLISHED_FILES} is the most that can be ` +
		`published to GitHub in one go — past that, GitHub stops listing a repository's files and a ` +
		`publish can no longer tell what is already there. Nothing has been sent. A Map Image's ` +
		`tiles are almost always what the count is: deleting one no Project uses, or referencing a ` +
		`very large sheet from its library rather than copying it, is the way down.`
	);
}

function hostingLimitMessage(bytes: number): string {
	return (
		`Your Published Site would hold ${describeBytes(bytes)}, past the ` +
		`${describeBytes(STATIC_HOSTING_LIMIT_BYTES)} GitHub Pages will publish. This is a cliff ` +
		`rather than a slowdown: the push may well fail outright. Offline Base Map tiles are usually ` +
		`what the bytes are — they are about 152 kB each — and Map Images no Project uses are the ` +
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
