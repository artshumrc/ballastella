// Downloading a published Workspace out of a public repository, into a new one (ADR-0031, ADR-0032).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT SENDS NO CREDENTIAL, AND THAT IS THE FEATURE RATHER THAN A SHORTCUT
//
// A public repository's file list and its bytes are readable with no token at all, so a student with
// no GitHub account can seed a Workspace from their instructor's Remote. Nothing here takes a
// `token`, builds an `Authorization` header, or reads the credential store — and none of those may
// be added. Doing so would make an account a prerequisite for the one operation in this epic that
// needs none, and it would do it silently: the flow would go on working for everybody who had
// already signed in.
//
// Private repositories are therefore out, and the refusal says so rather than reporting GitHub's
// 404 as a missing repository.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO HOSTS, AND NEITHER IS `codeload`
//
//   GET https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1  → the file list
//   GET https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}            → the bytes
//
// ⚠ **`GET /repos/{o}/{r}/tarball/{ref}` must not be reached for.** It redirects to
// `codeload.github.com`, which answers `access-control-allow-origin: https://render.githubusercontent.com`
// — a specific origin rather than `*` — so a browser fetch is blocked. It is the obvious approach,
// `restore-workspace-tar.ts` already exists to receive a tar, and it fails only at runtime with a
// CORS error that says nothing about why. ADR-0031 records this so nobody spends a session
// rediscovering it.
//
// The bytes come from `raw.githubusercontent.com` rather than from the Remote's Pages site. Both
// would serve them, but raw reads the branch tip instead of a possibly-stale Pages deploy and needs
// no Pages build at all — so a Clone works on a repository published thirty seconds ago.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// RESTORE'S SEMANTICS, WITH A DIFFERENT SOURCE OF BYTES
//
// A new named Workspace, filled, switched to. Never a merge into an existing Workspace and never an
// overwrite of one (ADR-0024) — so, exactly as in `restore-workspace-tar.ts`, this takes the *means
// of making* a destination rather than a store to write into, and manifests are written last so an
// interrupted Clone leaves orphaned files rather than a Project that lists on the hub with half its
// Layers missing.
//
// ⚠ **Unlike a restore, a failure does not discard what has been written**, and that is the one
// deliberate divergence. A Clone is as expensive as a first publish — thousands of files for one
// Historical Map — so throwing the partial Workspace away would make every interruption cost the
// whole download again. What makes keeping it safe is {@link cloneFromRemote}'s resume: every file
// already present whose blob SHA matches the tree's is skipped, so running it again against the same
// destination finishes the job rather than repeating it. Both refusals happen *before* the
// destination is opened, so a refused Clone still leaves nothing behind at all.

import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import { isProjectManifest } from '../transfer/restore-workspace-tar.js';
import type { EstimateStorage, OpenRestoreDestination } from '../transfer/restore-workspace-tar.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';
import {
	DEFAULT_REMOTE_BRANCH,
	REMOTE_BINDING_FORMAT_VERSION,
	REMOTE_BINDING_PATH,
	describeRemote,
	writeRemoteBinding,
	type RemoteBinding
} from './remote-binding.js';

/** The repository a Clone reads from. No branch selection UI: it is the Remote's default. */
export type CloneReference = {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
};

/** Why a Clone did not happen, with nothing written and no Workspace made. */
export type CloneRefusal =
	/** No such public repository, or one no anonymous reader can see — which look the same. */
	| 'no-repository'
	/** The repository holds no commits, so there is nothing in it to clone. */
	| 'empty'
	/** GitHub could only list part of the file list, so a Clone would silently be incomplete. */
	| 'truncated'
	/** There is not enough room in the browser's storage to hold it. */
	| 'insufficient-quota'
	/** Anything else GitHub said, or a request that never got an answer. */
	| 'refused';

/** A Clone that will not happen, with a message for the person who asked for it. */
export class CloneRefusedError extends Error {
	readonly refusal: CloneRefusal;

	constructor(refusal: CloneRefusal, message: string) {
		super(`${message} Nothing has been downloaded.`);
		this.name = 'CloneRefusedError';
		this.refusal = refusal;
	}
}

export type CloneFromRemoteOptions = {
	readonly remote: CloneReference;
	/** Defaulting to the page's own, as the publish engine and the HTTP store already do. */
	readonly fetch?: FetchFn;
	readonly onProgress?: TransferProgressListener;
	readonly estimateStorage?: EstimateStorage;
};

/** What a Clone did, in the numbers a caller has to report. */
export interface WorkspaceClone {
	/** The name the new Workspace got, which the caller now has to switch to. */
	readonly workspaceName: string;
	/** The Remote it is bound to — the repository the user named, not one read off the wire. */
	readonly remote: RemoteBinding;
	/** Every file the Remote's tree holds for this Workspace. */
	readonly totalFiles: number;
	/** How many were fetched, which is fewer than {@link totalFiles} on a resumed Clone. */
	readonly downloadedFiles: number;
	/** How many were already here with the right bytes, and so were not fetched again. */
	readonly skippedFiles: number;
	readonly totalBytes: number;
	/** The Project directories that now list on the hub. */
	readonly projects: readonly string[];
	/**
	 * Paths the Remote holds that were deliberately **not** written, and are not counted above.
	 *
	 * Empty for a Clone into a fresh Workspace, which is every first Clone. A *resumed* Clone can put
	 * something here: an `alignments/<id>.json` already on disk with different bytes is kept over the
	 * one on the Remote, because ADR-0023 makes the one already here the safe one. Reported rather
	 * than swallowed, for `restore-workspace-tar.ts`'s reason — a transfer that quietly delivers less
	 * than it was given is the exact failure that whole format change escaped.
	 */
	readonly declined: readonly string[];
	/** What the user has to be told, in the words they should see. */
	readonly notice: string;
}

/** One file the Remote holds, as the tree listing reports it. */
type CloneEntry = {
	readonly path: StorePath;
	readonly sha: string;
	readonly bytes: number;
};

/**
 * A path as URL segments.
 *
 * Per segment, so the path structure survives, and encoded, because a `#` in a file name is a
 * fragment that silently truncates the request into one for a different file.
 */
const urlPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/**
 * Clone a public repository's published Workspace into a new one.
 *
 * The order is the design, and it is the order that makes both refusals free:
 *
 * 1. **The file list**, unauthenticated, in one request. A truncated answer is refused here.
 * 2. **The quota check**, against the byte total the listing itself reports.
 * 3. **The destination is opened** — and only now does anything exist that could be left behind.
 * 4. **Every file is fetched and written**, skipping what is already here with the right bytes.
 * 5. **Manifests last**, so a Project appears on the hub only once it is whole.
 * 6. **The binding is written** for the repository the user named.
 *
 * @param open makes the Workspace to fill; see {@link OpenRestoreDestination}. Hand it one that
 *   creates a new Workspace for a first Clone, or one that reopens a partly-filled Workspace to
 *   resume an interrupted one.
 * @throws CloneRefusedError before the destination is opened, for every refusal there is
 */
export async function cloneFromRemote(
	open: OpenRestoreDestination,
	options: CloneFromRemoteOptions
): Promise<WorkspaceClone> {
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote = { ...options.remote, branch };

	const entries = await readCloneTree(remote, options.fetch);
	const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
	await assertRoomToClone(totalBytes, options.estimateStorage);

	const destination = await open(remote.repository);
	const source = createHttpProjectStore({
		resolve: (path) =>
			`${GITHUB_RAW_ORIGIN}/${urlPath(remote.owner)}/${urlPath(remote.repository)}/` +
			`${urlPath(branch)}/${urlPath(path)}`,
		// Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is
		// not the same as an absent property, and the store's default is "the page's own `fetch`".
		...(options.fetch === undefined ? {} : { fetch: options.fetch })
	});

	// Manifests are held to the end for `restore-workspace-tar.ts`'s reason, and here they are held
	// back from being *downloaded* as well as from being written — an interrupted Clone has then not
	// spent a request on a file it would have had to write last anyway.
	const files = entries.filter((entry) => !isProjectManifest(entry.path));
	const manifests = entries.filter((entry) => isProjectManifest(entry.path));

	const declined: string[] = [];
	let downloaded = 0;
	let skipped = 0;
	let bytes = 0;
	const report = (path: string | null): void =>
		options.onProgress?.({
			files: downloaded + skipped,
			totalFiles: entries.length,
			bytes,
			totalBytes,
			path
		});

	report(null);
	for (const entry of [...files, ...manifests]) {
		// ⚠ **The resume, and the whole reason a Clone is bearable to interrupt.** The tree gave a blob
		// SHA per path, so what is already on disk can be checked against it without asking GitHub
		// anything — one local read and one hash against a request for a pyramid tile. `gitBlobSha` is
		// ticket 01's function used in the other direction; there is deliberately no second hash here.
		if (await alreadyHere(destination.store, entry)) {
			skipped += 1;
			bytes += entry.bytes;
			report(entry.path);
			continue;
		}
		const content = await source.read(entry.path);
		if ((await writeCloned(destination.store, entry.path, content)) === 'declined') {
			declined.push(entry.path);
			report(entry.path);
			continue;
		}
		downloaded += 1;
		bytes += content.byteLength;
		report(entry.path);
	}
	report(null);

	// ⚠ **Written from what the user named, and never from what came down the wire.** The tree can
	// carry a `remote.json` of its own — the binding is published deliberately (ADR-0033) — and on a
	// fork or a mirror that document names the repository the *publisher* pushed to, which is not the
	// one this Clone read. So it is filtered out of the download entirely and written here instead.
	//
	// The binding is provenance rather than permission (ADR-0032): a Reader who cloned somebody else's
	// Workspace gets a bound Workspace and discovers at publish time that they cannot push, which
	// costs nothing and is the honest record of where the work came from.
	const binding: RemoteBinding = {
		formatVersion: REMOTE_BINDING_FORMAT_VERSION,
		owner: remote.owner,
		repository: remote.repository,
		branch
	};
	await writeRemoteBinding(destination.store, destination.name, binding);

	const projects = manifests
		.map((entry) => entry.path)
		.filter((path) => !declined.includes(path))
		.map((path) => path.slice(0, -PROJECT_FILE_NAME.length - 1));

	return {
		workspaceName: destination.name,
		remote: binding,
		totalFiles: entries.length,
		downloadedFiles: downloaded,
		skippedFiles: skipped,
		totalBytes,
		projects,
		declined,
		notice:
			`Cloned ${describeRemote(remote)} into a new Workspace called “${destination.name}”. Your ` +
			`other Workspaces have not been touched. It is bound to ${describeRemote(remote)}, which ` +
			`records where it came from — publishing to it needs a sign-in that may push there.` +
			(declined.length === 0
				? ''
				: ` ${declined.length} ${declined.length === 1 ? 'Alignment' : 'Alignments'} on the ` +
					`Remote ${declined.length === 1 ? 'was' : 'were'} not downloaded, because this ` +
					`Workspace already had one for the same Historical Map: ${declined.join(', ')}.`)
	};
}

/**
 * Every file the branch's tip holds, from one unauthenticated tree listing.
 *
 * @throws CloneRefusedError for a repository that cannot be read, and for a truncated listing
 */
async function readCloneTree(
	remote: Required<CloneReference>,
	fetchFn: FetchFn | undefined
): Promise<CloneEntry[]> {
	const request = fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const url =
		`${GITHUB_API_ORIGIN}/repos/${urlPath(remote.owner)}/${urlPath(remote.repository)}` +
		`/git/trees/${urlPath(remote.branch)}?recursive=1`;

	let response: Response;
	try {
		// No `Authorization` header, by design — see this module's header. `Accept` only.
		response = await request(url, { headers: { Accept: 'application/vnd.github+json' } });
	} catch (cause) {
		throw new CloneRefusedError('refused', unreachableMessage(remote, cause));
	}

	// ⚠ 409 `Git Repository is empty.` is a repository with no commits, which is not 404 and needs its
	// own sentence: there is nothing wrong with the address, there is simply nothing published there
	// yet. Reported as a missing repository it sends the user off to check a name that is fine.
	if (response.status === 409) throw new CloneRefusedError('empty', emptyMessage(remote));
	if (response.status === 404) {
		throw new CloneRefusedError('no-repository', noRepositoryMessage(remote));
	}
	if (response.status === 401 || response.status === 403) {
		throw new CloneRefusedError('no-repository', notPublicMessage(remote));
	}
	if (!response.ok) {
		throw new CloneRefusedError('refused', refusedMessage(remote, await problemOf(response)));
	}

	const body = (await response.json().catch(() => ({}))) as {
		tree?: { path?: unknown; sha?: unknown; type?: unknown; size?: unknown }[];
		truncated?: unknown;
	};
	const listed = body.tree ?? [];

	// ⚠ **A truncated listing answers 200**, so nothing throws and nothing logs. Ticket 02's reason,
	// pointing the other way: proceeding would download the part GitHub happened to mention and hand
	// the user a Workspace with most of a pyramid silently missing — a Project that opens, draws a
	// map with holes in it, and says nothing at all about why.
	if (body.truncated === true) {
		const files = listed.filter((entry) => entry.type === 'blob').length;
		throw new CloneRefusedError('truncated', truncatedMessage(files, remote));
	}

	return listed.flatMap<CloneEntry>((entry) =>
		// Blobs only. A `tree` entry is a directory, implied by the paths beneath it; a `commit` entry
		// is a gitlink, whose bytes live in another repository and cannot be fetched from this one.
		entry.type === 'blob' && typeof entry.path === 'string' && typeof entry.sha === 'string'
			? // The binding is written from what the user named rather than downloaded — see
				// {@link cloneFromRemote} — so it is not part of the file list at all.
				entry.path === REMOTE_BINDING_PATH
				? []
				: [
						{
							path: entry.path as StorePath,
							sha: entry.sha,
							bytes: typeof entry.size === 'number' ? entry.size : 0
						}
					]
			: []
	);
}

/**
 * Refuse a Clone there is no room for, **before the destination exists**.
 *
 * ADR-0024 already requires this of a restore and the argument is the same one: OPFS shares the
 * origin's quota, a second Workspace can fail at eighty per cent, and refusing legibly beforehand
 * beats discovering it half way through a pyramid. Silent when the browser will not answer, because
 * refusing over an unavailable quota API would refuse every Clone on Safari.
 *
 * The byte total is the tree's own, which is an honest bound: git reports each blob's size, nothing
 * on this path is compressed, and no file is written that the listing did not name.
 */
async function assertRoomToClone(
	needed: number,
	estimateStorage: EstimateStorage | undefined
): Promise<void> {
	if (!estimateStorage) return;
	const estimate = await estimateStorage().catch(() => null);
	const quota = estimate?.quota;
	const usage = estimate?.usage;
	if (typeof quota !== 'number' || typeof usage !== 'number') return;

	const free = quota - usage;
	if (free >= needed) return;

	throw new CloneRefusedError(
		'insufficient-quota',
		`This Workspace needs about ${describeBytes(needed)} and there is ${describeBytes(
			Math.max(0, free)
		)} free — ${describeBytes(usage)} of the ${describeBytes(quota)} this browser allows is ` +
			`already in use. Delete a Workspace you no longer need, or free space on this device, and ` +
			`try again.`
	);
}

/** Whether the destination already holds exactly the bytes the Remote's tree names. */
async function alreadyHere(store: ProjectStore, entry: CloneEntry): Promise<boolean> {
	const bytes = await store.read(entry.path).catch(() => null);
	return bytes !== null && (await gitBlobSha(bytes)) === entry.sha;
}

/**
 * Write one cloned file, sending an Alignment through the one writer (ticket 18, ADR-0023).
 *
 * Routed for the reason `restore-workspace-tar.ts` gives at length, and it is the same situation: the
 * path arrives as *data* — an entry in somebody else's tree — so neither the `AlignmentPath` brand
 * nor `scripts/check-alignment-writers.mjs` can see it, and "clone writes Alignments with the generic
 * writer" would be a true statement about the codebase that the next person reads as permission.
 *
 * `intent: 'create'` always writes into a fresh Workspace, which is every first Clone. On a *resumed*
 * Clone it can decline — an Alignment already on disk whose bytes differ from the Remote's — and that
 * is ADR-0023's safe direction: Control Points somebody has already placed are kept.
 *
 * @returns `'written'`, or `'declined'` when the destination already had an Alignment for that map
 */
async function writeCloned(
	store: ProjectStore,
	path: StorePath,
	bytes: Bytes
): Promise<'written' | 'declined'> {
	const imageId = alignmentImageId(path);
	if (imageId === null) {
		await store.write(path, bytes);
		return 'written';
	}
	const outcome = await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{ imageId, bytes, write: { intent: 'create' } }
	);
	return outcome === 'written' ? 'written' : 'declined';
}

/** The image id of `alignments/<id>.json`, or `null` for anything else. */
function alignmentImageId(path: string): string | null {
	const segments = path.split('/');
	if (segments.length !== 2 || segments[0] !== ALIGNMENT_DIRECTORY) return null;
	const name = segments[1] ?? '';
	return name.endsWith('.json') && name.length > '.json'.length
		? name.slice(0, -'.json'.length)
		: null;
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

// ── What the refusals say ─────────────────────────────────────────────────────────────────────

function noRepositoryMessage(remote: CloneReference): string {
	return (
		`GitHub has no public repository at ${describeRemote(remote)}. Check the owner and the ` +
		`repository name — the two parts after github.com in the address bar. Cloning reads a ` +
		`repository without signing in, so a private one looks exactly like a missing one from here; ` +
		`if it is private, whoever published it has to make it public first.`
	);
}

function notPublicMessage(remote: CloneReference): string {
	return (
		`GitHub would not let this page read ${describeRemote(remote)} without signing in, so it is ` +
		`not a public repository. Cloning is deliberately an anonymous operation — it needs no ` +
		`account and no token — so a private repository cannot be cloned at all. Whoever published it ` +
		`has to make it public, or send you a Backup instead.`
	);
}

function emptyMessage(remote: CloneReference): string {
	return (
		`${describeRemote(remote)} exists but has nothing in it yet — no files, no branches, nothing ` +
		`to clone. Nothing is wrong with the address. If somebody told you they had published there, ` +
		`ask them to press Publish once.`
	);
}

function truncatedMessage(listed: number, remote: CloneReference): string {
	return (
		`GitHub could only list the first ${listed} files in ${describeRemote(remote)}, so this Clone ` +
		`cannot know what the rest of them are. Downloading anyway would hand you a Workspace with ` +
		`most of a Historical Map silently missing — a Project that opens and draws a map full of ` +
		`holes — so nothing has been downloaded. That repository has to hold fewer files before it ` +
		`can be cloned.`
	);
}

function refusedMessage(remote: CloneReference, detail: string): string {
	return `GitHub refused to list ${describeRemote(remote)}: ${detail}.`;
}

function unreachableMessage(remote: CloneReference, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`GitHub could not be reached, so ${describeRemote(remote)} could not be read. The browser ` +
		`reported: ${detail}. This is about the connection rather than about that repository, and ` +
		`everything you already have is still saved on this computer.`
	);
}
