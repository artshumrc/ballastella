// Downloading a public repository's published Workspace into a new one: the transfer half of Open a
// Workspace from GitHub (ADR-0031, ADR-0032, ADR-0038).
//
// **The transfer, and not the relationship.** What is here reads a repository and fills a directory.
// Which Workspace of this installation that repository already belongs to, and what evidence a
// successful transfer is entitled to record, are `open-workspace-from-github.ts`'s — so nothing here
// consults or writes installation-local metadata, and a transfer that stops part way cannot have left
// a relationship behind for it to have to undo.
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
//   GET https://api.github.com/repos/{owner}/{repo}/git/ref/heads/{branch}          → the commit
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
// no Pages build at all — so an Open works on a repository published thirty seconds ago.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OWNED NAMESPACE, AND NOT THE REPOSITORY
//
// This downloads what {@link isOwnedPath} calls ours and nothing else, so a `CNAME`, a `README.md`,
// a `LICENSE`, `.github/workflows/**` and a `docs/` folder are left where they are.
//
// ⚠ **That is a rule about *publishing*, applied here because an Open is where the hazard starts.**
// Anything this downloads becomes ordinary Workspace content, and `planRemotePublish` sends every
// Workspace file — so a file dragged in from outside the namespace is authored content of every
// later publish. The student who opens an instructor's repository, binds to their own and presses
// Publish would find their own `CNAME` overwritten with the instructor's domain and their
// `README.md` replaced (SPEC story 17). That is exactly the "full mirror" ADR-0033 rejected,
// arriving through the transfer rather than through the namespace rule — so the predicate is
// imported rather than restated, and there is no second copy of it to drift.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// RESTORE'S SEMANTICS, WITH A DIFFERENT SOURCE OF BYTES
//
// A new named Workspace, filled, and handed back for the caller to adopt. Never a merge into an
// existing Workspace and never an overwrite of one (ADR-0024) — so, exactly as in
// `restore-workspace-tar.ts`, this takes the *means of making* a destination rather than a store to
// write into, and manifests are written last so an interrupted transfer leaves orphaned files rather
// than a Project that lists on the hub with half its Layers missing.
//
// ⚠ **Unlike a restore, a failure does not discard what has been written**, and that is the one
// deliberate divergence. This is as expensive as a first publish — thousands of files for one
// Map Image — so throwing the partial Workspace away would make every interruption cost the
// whole download again. What makes keeping it safe is {@link cloneFromRemote}'s resume: every file
// already present whose blob SHA matches the tree's is skipped, so running it again against the same
// destination finishes the job rather than repeating it. Every refusal but the three raised after the
// destination is opened happens *before* it, so those leave nothing behind at all — and what makes
// the exceptions safe is that nothing here records a relationship: a partial destination is a
// directory no synchronization has heard of, which no publish and no status will act on.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// VALIDATED WHOLE, BEFORE THE CALLER MAY ADOPT IT
//
// SPEC: an Open establishes a Baseline *only* once the complete Workspace is valid. So the last thing
// this does is ask the Workspace's own invariants of what arrived — through `compareWorkspace`, which
// is ticket 09's one implementation of them, rather than a second reading of the same rules. A
// Project whose `project.json` names a Layer the Remote never published, an Alignment for a Map Image
// that is not there, or a Project written by a newer Ballastella is refused here, so the caller never
// gets the chance to record evidence about a Workspace that cannot be opened.

import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { alignmentImageId } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import { isProjectManifest } from '../transfer/restore-workspace-tar.js';
import type { EstimateStorage, OpenRestoreDestination } from '../transfer/restore-workspace-tar.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_RAW_ORIGIN, describeReset } from './github-api.js';
import { isOwnedPath, projectDirectories } from './synchronization-paths.js';
import { compareWorkspace } from './synchronization-planner.js';
import {
	RemoteTreeRefusedError,
	readRemoteHeadCommit,
	readRemoteTree,
	urlPath,
	type RemoteBlob
} from './remote-tree.js';
import { DEFAULT_REMOTE_BRANCH, REMOTE_BINDING_PATH, describeRemote } from './remote-binding.js';
import type { RemoteRelationship } from './synchronization-metadata.js';

/** The repository this reads from. No branch selection UI: it is the Remote's default. */
export type CloneReference = {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
};

/** Why the transfer did not finish. See {@link CloneRefusedError} for what each leaves behind. */
export type CloneRefusal =
	/** No such public repository, or one no anonymous reader can see — which look the same. */
	| 'no-repository'
	/** The repository holds no commits, so there is nothing in it to open. */
	| 'empty'
	/**
	 * GitHub's hourly limit for anonymous readers is used up. Nothing is wrong with the repository.
	 *
	 * Separate from `'no-repository'` because the remedy is waiting rather than asking somebody to
	 * change a setting — see `remote-tree.ts`'s `'rate-limited'` for why the two arrive as the
	 * same status.
	 */
	| 'rate-limited'
	/** GitHub could only list part of the file list, so the Workspace would silently be incomplete. */
	| 'truncated'
	/** There is not enough room in the browser's storage to hold it. */
	| 'insufficient-quota'
	/**
	 * A file the tree listed could not be fetched, or arrived as bytes the tree did not name.
	 *
	 * One of the three refusals that happen **after** bytes have been written. It says something
	 * different about what is left behind — see {@link CloneRefusedError}.
	 */
	| 'incomplete'
	/**
	 * Everything arrived, and what arrived would not be a Workspace this app can open.
	 *
	 * A Layer naming a file the Remote never published, or an Alignment left for a Map Image that is
	 * not there. Refused rather than handed back, so no caller can record evidence about a Workspace
	 * whose Projects will not open.
	 */
	| 'invalid'
	/** A Project on the Remote was written by a newer Ballastella, so this build cannot judge it. */
	| 'unsupported'
	/** Anything else GitHub said, or a request that never got an answer. */
	| 'refused';

/** What a refusal leaves on this computer, which is the half of the sentence a user acts on. */
type CloneRemains = 'nothing' | 'partial';

/** A transfer that will not finish, with a message for the person who asked for it. */
export class CloneRefusedError extends Error {
	readonly refusal: CloneRefusal;

	/**
	 * @param remains defaults to `'nothing'`, which every refusal raised before the destination is
	 *   opened leaves — that is most of them, and the order in {@link cloneFromRemote} is what makes
	 *   it true rather than a claim made here.
	 */
	constructor(refusal: CloneRefusal, message: string, remains: CloneRemains = 'nothing') {
		super(
			`${message} ${
				remains === 'nothing'
					? 'Nothing has been downloaded.'
					: 'The Workspace it was filling has been left in place with the files that had ' +
						'already arrived, and nothing else on this computer has been changed.'
			}`
		);
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

/** What the transfer did, in the numbers and the evidence a caller has to act on. */
export interface WorkspaceClone {
	/** The name the new Workspace got, which the caller now has to switch to. */
	readonly workspaceName: string;
	/**
	 * The repository it was read from — the one the user named, never one read off the wire.
	 *
	 * ⚠ **Nothing here binds anything.** The published tree can carry a `remote.json` of its own,
	 * and on a fork or a mirror that document names the repository the *publisher* pushed to. It is
	 * filtered out of the download entirely (see {@link readCloneTree}) and the relationship is the
	 * caller's to record from this, against the repository the user actually chose.
	 */
	readonly remote: RemoteRelationship;
	/**
	 * The commit the branch stood at, which is the state this transfer describes.
	 *
	 * The other half of a Synchronization Baseline: {@link source} says which paths and SHAs, and this
	 * says *when*. Read from the ref rather than from the tree listing, which reports the tree
	 * object's own hash and names no history.
	 */
	readonly commit: string;
	/**
	 * Every **source** path that arrived, and the blob SHA it was verified against.
	 *
	 * ⚠ **Verified rather than listed**, which is the whole distinction SPEC draws for the Baseline:
	 * every entry here was either fetched and hashed against the tree's SHA, or found already on disk
	 * with those exact bytes. Published output — the viewer, `.nojekyll`, `remote.json` — is
	 * deliberately absent (ticket 02): it is generated, so it is never source drift and never part of
	 * what the two sides are said to have shared.
	 */
	readonly source: ReadonlyMap<string, string>;
	/** Every file the Remote's tree holds for this Workspace. */
	readonly totalFiles: number;
	/** How many were fetched, which is fewer than {@link totalFiles} on a resumed Open. */
	readonly downloadedFiles: number;
	/** How many were already here with the right bytes, and so were not fetched again. */
	readonly skippedFiles: number;
	readonly totalBytes: number;
	/** The Project directories that now list on the hub. */
	readonly projects: readonly string[];
	/**
	 * Paths the Remote holds that were deliberately **not** written, and are not counted above.
	 *
	 * Empty for a download into a fresh Workspace, which is every first Open. A *resumed* one can put
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
 * Download a public repository's published Workspace into a new one.
 *
 * The order is the design, and it is the order that makes most refusals free:
 *
 * 1. **The file list**, unauthenticated, in one request. A truncated answer is refused here.
 * 2. **The commit**, one more anonymous request, spent only on a repository that answered the first.
 * 3. **The quota check**, against the byte total the listing itself reports.
 * 4. **The destination is opened** — and only now does anything exist that could be left behind.
 * 5. **Every file is fetched and written**, skipping what is already here with the right bytes.
 * 6. **Manifests last**, so a Project appears on the hub only once it is whole.
 * 7. **The whole result is validated**, so a Workspace that would not open is refused rather than
 *    handed back for a caller to adopt and record a Baseline about.
 *
 * @param open makes the Workspace to fill; see {@link OpenRestoreDestination}. Hand it one that
 *   creates a new Workspace for a first Open, or one that reopens a partly-filled Workspace to
 *   resume an interrupted one.
 * @throws CloneRefusedError for every refusal there is; the three raised after step 4 leave the
 *   partly-filled destination in place, which is a directory no synchronization has heard of
 */
export async function cloneFromRemote(
	open: OpenRestoreDestination,
	options: CloneFromRemoteOptions
): Promise<WorkspaceClone> {
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote = { ...options.remote, branch };

	const entries = await readCloneTree(remote, options.fetch);
	// ⚠ **A second request, spent only on a repository that answered the first**, exactly as an
	// Import's is: a repository that is missing, private, empty or rate-limited is refused without
	// spending one more of the sixty an anonymous reader gets per hour. The branch can move between
	// the two, and what catches that is the blob-SHA check every file below goes through.
	let commit: string;
	try {
		commit = await readRemoteHeadCommit(remote, options.fetch);
	} catch (cause) {
		throw asCloneRefusal(remote, cause);
	}
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
	// back from being *downloaded* as well as from being written — an interrupted download has then not
	// spent a request on a file it would have had to write last anyway.
	const files = entries.filter((entry) => !isProjectManifest(entry.path));
	const manifests = entries.filter((entry) => isProjectManifest(entry.path));

	const declined: string[] = [];
	let downloaded = 0;
	let skipped = 0;
	let bytes = 0;
	// Declined files counted too, because progress is "how many of the listed files are dealt with"
	// rather than "how many arrived": leaving them out ends the count below the total the same call
	// reports, on a download that finished and said so.
	const report = (path: string | null): void =>
		options.onProgress?.({
			files: downloaded + skipped + declined.length,
			totalFiles: entries.length,
			bytes,
			totalBytes,
			path
		});

	report(null);
	for (const entry of [...files, ...manifests]) {
		// ⚠ **The resume, and the whole reason this is bearable to interrupt.** The tree gave a blob
		// SHA per path, so what is already on disk can be checked against it without asking GitHub
		// anything — one local read and one hash against a request for a pyramid tile. `gitBlobSha` is
		// ticket 01's function used in the other direction; there is deliberately no second hash here.
		if (await alreadyHere(destination.store, entry)) {
			skipped += 1;
			bytes += entry.bytes;
			report(entry.path);
			continue;
		}
		// ⚠ A file listed and then unreadable — deleted between the listing and the fetch, or a branch
		// moved under it — arrives here as the HTTP store's own error, which says nothing about
		// opening a Workspace and reaches the dialog as a raw sentence. Given the shape every other refusal here
		// has, so that what the user sees is a refusal rather than a stack trace's first line.
		let content: Bytes;
		try {
			content = await source.read(entry.path);
		} catch (cause) {
			throw new CloneRefusedError(
				'incomplete',
				missingFileMessage(remote, entry.path, cause),
				'partial'
			);
		}
		// ⚠ **The bytes are checked against the SHA they were listed with.** It is the same hash the
		// resume above turns on, over bytes already in memory, so it costs almost nothing —
		// and without it a proxy or a cache serving a rewritten copy produces a Workspace that is
		// silently wrong *and* whose files the resume will then skip for ever, because a later run
		// compares them against nothing.
		if ((await gitBlobSha(content)) !== entry.sha) {
			throw new CloneRefusedError('incomplete', corruptFileMessage(remote, entry.path), 'partial');
		}
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

	// ⚠ **Validated whole, and only now.** The Workspace's own invariants are asked of everything that
	// arrived — a Layer's file, an Alignment's Map Image, a `project.json` this build can read — so a
	// Remote that would open as a broken Workspace is refused *before* the caller adopts it or records
	// a Baseline about it. `compareWorkspace` is ticket 09's one reading of those rules; a second
	// reading here is how the Update and the Open come to disagree about what a valid Workspace is.
	const verified = await verifiedSource(remote, destination.store, entries, manifests, declined);

	const projects = manifests.map((entry) => entry.path.slice(0, -PROJECT_FILE_NAME.length - 1));

	return {
		workspaceName: destination.name,
		remote: { owner: remote.owner, repository: remote.repository, branch },
		commit,
		source: verified,
		totalFiles: entries.length,
		downloadedFiles: downloaded,
		skippedFiles: skipped,
		totalBytes,
		projects,
		declined,
		notice:
			`Opened ${describeRemote(remote)} into a new Workspace called “${destination.name}”. Your ` +
			`other Workspaces have not been touched. This installation now keeps ${describeRemote(remote)} ` +
			`as this Workspace's Remote, and has recorded what the two of them hold in common — ` +
			`publishing to it needs a sign-in that may push there.` +
			(declined.length === 0
				? ''
				: ` ${declined.length} ${declined.length === 1 ? 'Alignment' : 'Alignments'} on the ` +
					`Remote ${declined.length === 1 ? 'was' : 'were'} not downloaded, because this ` +
					`Workspace already had one for the same Map Image: ${declined.join(', ')}.`)
	};
}

/**
 * The source paths and SHAs of what arrived, having asked the Workspace's invariants of the whole.
 *
 * Both answers come out of one call to `compareWorkspace`: the source classification (ticket 02) that
 * keeps the viewer's own files out of a Baseline, and the graph verdict (ticket 09) that decides
 * whether this is a Workspace at all. The same inventory is given as both sides of the comparison
 * because there is nothing to compare — no Baseline exists yet, and what is wanted is the *prospective*
 * path set, which for a first Open is exactly what the Remote holds.
 *
 * @throws CloneRefusedError `'invalid'` or `'unsupported'`, leaving the destination in place
 */
async function verifiedSource(
	remote: Required<CloneReference>,
	store: ProjectStore,
	entries: readonly CloneEntry[],
	manifests: readonly CloneEntry[],
	declined: readonly string[]
): Promise<ReadonlyMap<string, string>> {
	// Read back off disk rather than kept from the download: on a resumed Open the manifest may have
	// been skipped, so the bytes never passed through this call at all.
	const projectFiles = new Map<string, Uint8Array>();
	for (const manifest of manifests) {
		const bytes = await store.read(manifest.path).catch(() => null);
		if (bytes !== null) projectFiles.set(manifest.sha, bytes);
	}

	const inventory = entries.map((entry) => ({ path: entry.path, sha: entry.sha }));
	const comparison = compareWorkspace({
		local: inventory,
		remote: inventory,
		baseline: null,
		projectFiles
	});

	if (comparison.graph.outcome === 'failed') {
		const unsupported = comparison.graph.failures.find((failure) => failure.kind === 'unsupported');
		throw new CloneRefusedError(
			unsupported ? 'unsupported' : 'invalid',
			unsupported
				? unsupportedMessage(remote, unsupported.path)
				: unjudgeableMessage(
						remote,
						comparison.graph.failures.map((failure) => failure.detail)
					),
			'partial'
		);
	}
	if (comparison.graph.outcome === 'invalid') {
		throw new CloneRefusedError(
			'invalid',
			invalidMessage(
				remote,
				comparison.graph.violations.map((violation) => violation.detail)
			),
			'partial'
		);
	}

	// `paths` is the source classification of the inventory, so the viewer's own files are already
	// out. `local` is the SHA either side carried, which is the same one on both.
	//
	// ⚠ **A declined Alignment is left out.** The Remote's bytes for it were never written — the
	// Workspace kept the Alignment it already had for that Map Image — so recording the Remote's SHA
	// would be a Baseline claiming the two sides share bytes that are not here, and the first status
	// check would read `Up to date` over an Alignment GitHub has never seen (SPEC story 99). Absent, it
	// is an unattributable path, which is what it is.
	const withheld = new Set(declined);
	const source = new Map<string, string>();
	for (const path of comparison.paths) {
		if (path.local !== null && !withheld.has(path.path)) source.set(path.path, path.local);
	}
	return source;
}

/**
 * Every file of the Remote's this is to bring down.
 *
 * The listing itself is `readRemoteTree`'s, shared with the Review so that two readers of one tree
 * cannot come to disagree about what a repository holds; what is here is the half that is this module's
 * own — the owned-namespace filter, and the sentences.
 *
 * @throws CloneRefusedError for a repository that cannot be read, and for a truncated listing
 */
async function readCloneTree(
	remote: Required<CloneReference>,
	fetchFn: FetchFn | undefined
): Promise<CloneEntry[]> {
	let blobs: readonly RemoteBlob[];
	try {
		blobs = await readRemoteTree(remote, fetchFn);
	} catch (cause) {
		throw asCloneRefusal(remote, cause);
	}

	// ⚠ **The namespace rule, asked of the Remote's own tree** — the same question and the same
	// answer a publish to this repository would give (ADR-0033), because it is the same function.
	// Everything outside it is the publisher's own work on their own repository: a `README.md` they
	// wrote on github.com, a `CNAME` carrying their cited address, the workflow that deploys their
	// Pages site. Downloaded, all of it would become *this* Workspace's content and be published as
	// the opener's own — see this module's header.
	const projects = projectDirectories(blobs.map((entry) => entry.path));

	return blobs.flatMap<CloneEntry>((entry) =>
		// ⚠ **`remote.json` is left where it is, and nothing here writes one** (SPEC story 80). The
		// relationship is installation-local metadata recorded by `open-workspace-from-github.ts` for
		// the repository the user actually selected; the copy inside a published tree is the *source's*
		// claim about itself, so a fork's names the repository it was forked from. Downloaded it would
		// be a Publish-owned file this Workspace never wrote, pushed back on the next publish as though
		// it had.
		entry.path !== REMOTE_BINDING_PATH && isOwnedPath(entry.path, projects)
			? [{ ...entry, path: entry.path as StorePath }]
			: []
	);
}

/**
 * A file list that could not be had, said in this module's own words.
 *
 * The kinds are the shared reader's and the sentences are this module's, which is the whole of why
 * `remote-tree.ts` carries no message: a Review refuses the same seven things and has to say
 * different things about them. `not-public` and `no-repository` both come out as
 * {@link CloneRefusal} `'no-repository'` — from a browser with no credential they are one situation
 * with two GitHub statuses — and the two sentences differ because only one of them can be acted on.
 */
function asCloneRefusal(remote: Required<CloneReference>, cause: unknown): CloneRefusedError {
	if (!(cause instanceof RemoteTreeRefusedError)) {
		return new CloneRefusedError('refused', unreachableMessage(remote, cause));
	}
	switch (cause.refusal) {
		case 'no-repository':
			return new CloneRefusedError('no-repository', noRepositoryMessage(remote));
		case 'not-public':
			return new CloneRefusedError('no-repository', notPublicMessage(remote));
		case 'rate-limited':
			return new CloneRefusedError('rate-limited', rateLimitedMessage(remote, cause.resetAt));
		case 'empty':
			return new CloneRefusedError('empty', emptyMessage(remote));
		case 'truncated':
			return new CloneRefusedError('truncated', truncatedMessage(cause.listed, remote));
		case 'unreachable':
			return new CloneRefusedError('refused', unreachableMessage(remote, cause.detail));
		case 'refused':
			return new CloneRefusedError('refused', refusedMessage(remote, cause.detail));
	}
}

/**
 * Refuse a download there is no room for, **before the destination exists**.
 *
 * ADR-0024 already requires this of a restore and the argument is the same one: OPFS shares the
 * origin's quota, a second Workspace can fail at eighty per cent, and refusing legibly beforehand
 * beats discovering it half way through a pyramid. Silent when the browser will not answer, because
 * refusing over an unavailable quota API would refuse every Open on Safari.
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
 * Write one downloaded file, sending an Alignment through the one writer (ticket 18, ADR-0023).
 *
 * Routed for the reason `restore-workspace-tar.ts` gives at length, and it is the same situation: the
 * path arrives as *data* — an entry in somebody else's tree — so neither the `AlignmentPath` brand
 * nor `scripts/check-alignment-writers.mjs` can see it, and "the download writes Alignments with the generic
 * writer" would be a true statement about the codebase that the next person reads as permission.
 *
 * `intent: 'create'` always writes into a fresh Workspace, which is every first Open. On a *resumed*
 * one it can decline — an Alignment already on disk whose bytes differ from the Remote's — and that
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

// ── What the refusals say ─────────────────────────────────────────────────────────────────────

function noRepositoryMessage(remote: CloneReference): string {
	return (
		`GitHub has no public repository at ${describeRemote(remote)}. Check the owner and the ` +
		`repository name — the two parts after github.com in the address bar. Opening a Workspace ` +
		`reads a repository without signing in, so a private one looks exactly like a missing one from ` +
		`here; if it is private, whoever published it has to make it public first.`
	);
}

function notPublicMessage(remote: CloneReference): string {
	return (
		`GitHub would not let this page read ${describeRemote(remote)} without signing in, so it is ` +
		`not a public repository. Opening a Workspace from GitHub is deliberately an anonymous ` +
		`operation — it needs no account and no token — so a private repository cannot be opened at ` +
		`all. Whoever published it has to make it public, or send you a Backup instead.`
	);
}

/**
 * The hourly limit, said as a wait rather than as a fault in the repository.
 *
 * ⚠ **It names the limit as *anonymous* and the address as *shared*, because both are what make it
 * legible.** An Open signs in to nothing, so the budget is GitHub's 60 requests an hour per IP
 * address rather than a personal one — which means the person reading this may have made no requests
 * at all and is sharing a campus NAT with a class doing the same thing at the same time (SPEC story
 * 48). Without that, the honest reading of "rate limit" is "I did something too many times".
 */
function rateLimitedMessage(remote: CloneReference, resetAt: Date | null): string {
	const at = describeReset(resetAt);
	return (
		`GitHub's hourly limit for anonymous readers has been used up, so ${describeRemote(remote)} ` +
		`could not be listed. Nothing is wrong with the address and nothing is wrong with that ` +
		`repository — opening a Workspace reads GitHub without signing in, and that allows 60 requests ` +
		`an hour for each internet connection, so on a shared one — a university network, a ` +
		`classroom — everybody's reading counts together. ` +
		`${at === '' ? 'Wait until the limit resets and try again' : `Try again after ${at}, when the limit resets`}.`
	);
}

function emptyMessage(remote: CloneReference): string {
	return (
		`${describeRemote(remote)} exists but has nothing in it yet — no files, no branches, nothing ` +
		`to open. Nothing is wrong with the address. If somebody told you they had published there, ` +
		`ask them to press Publish once.`
	);
}

function truncatedMessage(listed: number, remote: CloneReference): string {
	return (
		`GitHub could only list the first ${listed} files in ${describeRemote(remote)}, so Ballastella ` +
		`cannot know what the rest of them are. Downloading anyway would hand you a Workspace with ` +
		`most of a Map Image silently missing — a Project that opens and draws a map full of ` +
		`holes — so nothing has been downloaded. That repository has to hold fewer files before a ` +
		`Workspace can be opened from it.`
	);
}

function refusedMessage(remote: CloneReference, detail: string): string {
	return `GitHub refused to list ${describeRemote(remote)}: ${detail}.`;
}

function missingFileMessage(remote: CloneReference, path: string, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`${describeRemote(remote)} listed ${path}, but it could not be downloaded: ${detail}. A file ` +
		`can be deleted, or a branch moved, while a download is running — so this one has stopped ` +
		`rather than hand you a Workspace with a file silently missing. Opening it again picks up ` +
		`where this stopped.`
	);
}

function invalidMessage(remote: CloneReference, details: readonly string[]): string {
	return (
		`Everything ${describeRemote(remote)} lists arrived, but together it does not make a Workspace ` +
		`this app can open: ${details.join(' ')} That is a fault in what was published rather than in ` +
		`the transfer, so nothing has been adopted — whoever published it has to press Publish again ` +
		`from a Workspace that opens.`
	);
}

function unsupportedMessage(remote: CloneReference, path: string): string {
	return (
		`${path} in ${describeRemote(remote)} was written by a newer version of Ballastella than this ` +
		`one, so this browser cannot tell whether the rest of the Workspace is complete. Update ` +
		`Ballastella and open it again; opening it with this version could silently drop work its ` +
		`author can see.`
	);
}

function unjudgeableMessage(remote: CloneReference, details: readonly string[]): string {
	return (
		`Everything ${describeRemote(remote)} lists arrived, but it could not be checked over: ` +
		`${details.join(' ')} Nothing has been adopted, because a Workspace that cannot be checked is ` +
		`one this app cannot promise to open.`
	);
}

function corruptFileMessage(remote: CloneReference, path: string): string {
	return (
		`${path} arrived from ${describeRemote(remote)} as different bytes from the ones its file list ` +
		`named, so the download has stopped rather than keep a file it cannot vouch for. Something ` +
		`between this browser and GitHub — a proxy, or a cache — served a rewritten copy. Opening it ` +
		`again fetches that file afresh.`
	);
}

function unreachableMessage(remote: CloneReference, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`GitHub could not be reached, so ${describeRemote(remote)} could not be read. The browser ` +
		`reported: ${detail}. This is about the connection rather than about that repository, and ` +
		`everything you already have is still saved on this computer.`
	);
}
