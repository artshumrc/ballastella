// Downloading **one Project** out of a public repository, into a Review Workspace (ADR-0024,
// ADR-0031, ADR-0032).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE BUNDLE PATH WITH A DIFFERENT SOURCE OF BYTES, AND THE REFUSAL IS HALF THE POINT
//
// `open-project-bundle.ts` reads a Project out of a tar into a throwaway Workspace of its own; this
// reads one out of somebody's Remote into the same kind of Workspace. What arrives is unbound,
// unpublishable, and carries the banner that says so, because the reason has not changed with the
// transport: under ADR-0023 there is one Alignment per Historical Map in a Workspace, so importing a
// colleague's Project into the user's own would either overwrite an Alignment two of their own
// Projects are drawn by, or be refused (ADR-0024, "Why handoff cannot merge"). A new way to *fetch*
// the Project does not make a third answer available.
//
// ⚠ **There is no promotion out of the result, by any affordance, in any dialog.** That is not an
// omission to be filled in later — it is the fence that makes the rest coherent, and this module is
// the most likely place for it to be helpfully reintroduced. A scholar who wants a colleague's map
// in their own research adds the map themselves.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A SIBLING OF THE CLONE, AND WHERE IT DELIBERATELY DIVERGES
//
// The file list, the two hosts, the anonymity and the blob-SHA check are `clone-from-remote.ts`'s and
// are shared rather than restated — the listing through `remote-tree.ts`, the namespace question
// through `remoteProjectDirectories`, the byte check through `gitBlobSha`. Four things differ, and
// each is a decision rather than an accident:
//
//   1. **The unit is one Project's closure, not the owned namespace.** From the tree it takes
//      `<dir>/**`, and — by reading that Project's Layers — the `images/<id>/**` and
//      `alignments/<id>.json` those Layers name. A Workspace-shared Historical Map no Layer of this
//      Project references does not travel, which is the same rule `export-project-bundle.ts` applies
//      and the whole difference between a handoff and a backup. That closure is *inside* the owned
//      namespace by construction, so `isOwnedPath` is not applied as a filter here: every path it
//      takes is either under a directory `remoteProjectDirectories` named or under `images/` or
//      `alignments/`. `review-from-remote.test.ts` asserts the containment rather than this module
//      claiming it.
//   2. **Nothing is written and no `remote.json` is made.** A Clone binds what it made, last, as
//      provenance. A Review Workspace is bound to nothing at all: `writeRemoteBinding` would refuse
//      it (ticket 03), and so this never asks.
//   3. **A failure discards the whole Review Workspace**, where a Clone keeps its partial one. A
//      Clone is resumable and as expensive as a first publish, so keeping what arrived is what makes
//      an interruption bearable. A review copy is a thing you throw away when you have finished
//      looking at it; there is no resume to protect, and every refusal here can therefore end on the
//      bundle's sentence — *nothing has been opened*.
//   4. **The manifest is read before the destination exists.** A tar has no index, so
//      `openProjectBundle` cannot know which Project it is holding until it has walked the archive
//      into a Workspace it may then have to discard. A tree *is* an index, so `project.json` is
//      fetched first, from which the closure and the quota figure both follow — which means the
//      refusals below all land before a Workspace has been made, and the mark is written once,
//      complete, rather than twice.
//
// ⚠ **The Remote's paths are the Workspace's paths, and nothing is re-rooted.** A published tree is
// a Workspace laid out as ADR-0008 lays one out, so `<dir>/project.json` and `images/<id>/info.json`
// land at exactly the names they had. The bundle's hoisting rules (`hoistedImageId`) exist because a
// *bundle* is Project-relative; there is nothing for them to do here, and applying them would be a
// second answer to where the shared pool lives.

import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { ALIGNMENT_DIRECTORY, alignmentPath } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { imageDirectory } from '../project/image-files.js';
import {
	BALLASTELLA_CANONICAL_URL,
	ProjectFormatTooNewError,
	parseProjectFile,
	projectFilePath,
	type ProjectFile
} from '../project/project-file.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { describeBytes } from '../project/workspace-size.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import type { OpenReviewDestination, ReviewDestination } from '../transfer/open-project-bundle.js';
import type { EstimateStorage } from '../transfer/restore-workspace-tar.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import { isViewerFile } from '../transfer/viewer-files.js';
import { gitBlobSha } from './blob-sha.js';
import type { CloneReference } from './clone-from-remote.js';
import { GITHUB_RAW_ORIGIN } from './github-api.js';
import { remoteProjectDirectories } from './publish-to-remote.js';
import { RemoteTreeRefusedError, readRemoteTree, urlPath, type RemoteBlob } from './remote-tree.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote } from './remote-binding.js';

/**
 * Which Project on which Remote to review.
 *
 * The repository half is {@link CloneReference} unchanged — the same three fields with the same
 * meanings and the same default branch — because it is the same question asked of the same host.
 * What a Review adds is the field that makes it a different operation.
 */
export type ReviewReference = CloneReference & {
	/**
	 * The Project's directory on the Remote, which is a Project's identity (ADR-0008).
	 *
	 * Untrusted: it is what a user typed. Nothing is derived from it until it has been found among
	 * the directories the Remote's own tree holds a `project.json` in, so a `..` or a name with a
	 * slash in it is a {@link ReviewRefusal} `'no-project'` rather than a path.
	 */
	readonly project: string;
};

/** Why a Review did not happen. Every one of them leaves nothing on this computer. */
export type ReviewRefusal =
	/** No such public repository, or one no anonymous reader can see — which look the same. */
	| 'no-repository'
	/** The repository holds no commits, so there is nothing in it to review. */
	| 'empty'
	/** GitHub could only list part of the file list, so a Review would silently be incomplete. */
	| 'truncated'
	/** The repository is readable and holds no Project by that name. */
	| 'no-project'
	/** There is not enough room in the browser's storage to hold it. */
	| 'insufficient-quota'
	/** A file the tree listed could not be fetched, or arrived as bytes the tree did not name. */
	| 'incomplete'
	/** Anything else GitHub said, or a request that never got an answer. */
	| 'refused';

/**
 * A Review that will not happen, with a message for the person who asked for it.
 *
 * ⚠ **Every one of them ends on the same sentence, and unlike the Clone's that is unconditional.**
 * A refusal before the Review Workspace is made has left nothing behind because there is nothing to
 * leave; one after it has left nothing behind because {@link reviewFromRemote} discards the whole
 * Workspace on its way out. The Clone's equivalent has to say which of the two happened, because a
 * Clone deliberately keeps what it downloaded.
 */
export class ReviewRefusedError extends Error {
	readonly refusal: ReviewRefusal;

	constructor(refusal: ReviewRefusal, message: string) {
		super(`${message} Nothing has been opened.`);
		this.name = 'ReviewRefusedError';
		this.refusal = refusal;
	}
}

export type ReviewFromRemoteOptions = {
	readonly remote: ReviewReference;
	/** Defaulting to the page's own, as the publish engine and the HTTP store already do. */
	readonly fetch?: FetchFn;
	readonly onProgress?: TransferProgressListener;
	readonly estimateStorage?: EstimateStorage;
	/** The clock, injectable so the mark's `openedAt` is assertable. */
	readonly now?: () => Date;
};

/** What a Review did, in the numbers and words a caller has to report. */
export interface ReviewedProject {
	/** The Review Workspace it landed in, which the caller now has to switch to. */
	readonly workspaceName: string;
	/** The Project's directory inside it, for the `?p=` the caller navigates to. */
	readonly directory: string;
	/** The manifest, parsed. What the banner names. */
	readonly project: ProjectFile;
	/** How many files were written, `project.json` included. */
	readonly totalFiles: number;
	readonly totalBytes: number;
	/** What the user has to be told, in the words they should see. */
	readonly notice: string;
}

/** One file the Remote holds that this Review is to bring down. */
type ReviewEntry = RemoteBlob & { readonly path: StorePath };

/**
 * Read one Project out of a public repository into a **new Review Workspace**.
 *
 * The order is the design, and it is what makes every refusal free:
 *
 * 1. **The file list**, unauthenticated, in one request. A truncated answer is refused here.
 * 2. **The named Project is found in it**, or refused with the names the Remote does hold.
 * 3. **`project.json` is fetched and parsed**, so ADR-0010's refusal of a Project from the future
 *    lands while there is still nothing to throw away — and so the Layers can say what else travels.
 * 4. **The closure is gathered**, and the quota checked against the byte total the listing reports.
 * 5. **The Review Workspace is created, and marked, before a single Project byte lands.** The mark
 *    is what makes the banner appear; written last, an interrupted Review would leave a Workspace
 *    full of somebody else's work looking exactly like the user's own.
 * 6. **Every file is fetched, checked against the SHA the tree named, and written.**
 * 7. **`project.json` last**, per the discipline every transfer path here keeps: a Workspace's list
 *    of Projects *is* whichever directories hold one (ADR-0008), so an interrupted Review leaves a
 *    directory of orphaned files rather than a Project that lists and opens with half its Layers
 *    missing.
 * 8. **Anything that fails after step 5 discards the whole Review Workspace**, which is what makes
 *    the refusals' closing sentence true.
 *
 * @param open makes the throwaway Workspace to fill, and the way to throw it away again
 * @throws ReviewRefusedError with nothing opened and no Workspace left behind
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function reviewFromRemote(
	open: OpenReviewDestination,
	options: ReviewFromRemoteOptions
): Promise<ReviewedProject> {
	const now = options.now ?? (() => new Date());
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote = { ...options.remote, branch };

	const blobs = await readReviewTree(remote, options.fetch);
	const { directory, manifest: manifestEntry } = findProject(remote, blobs);

	const source = createHttpProjectStore({
		resolve: (path) =>
			`${GITHUB_RAW_ORIGIN}/${urlPath(remote.owner)}/${urlPath(remote.repository)}/` +
			`${urlPath(branch)}/${urlPath(path)}`,
		// Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is
		// not the same as an absent property, and the store's default is "the page's own `fetch`".
		...(options.fetch === undefined ? {} : { fetch: options.fetch })
	});
	const read = async (entry: ReviewEntry): Promise<Bytes> => {
		let content: Bytes;
		try {
			content = await source.read(entry.path);
		} catch (cause) {
			throw new ReviewRefusedError('incomplete', missingFileMessage(remote, entry.path, cause));
		}
		// ⚠ **The bytes are checked against the SHA they were listed with**, which costs a Review
		// almost nothing: it is one hash over bytes already in memory. Without it a proxy or a cache
		// serving a rewritten copy produces a review copy that is silently not what the author
		// published — and a reviewer's whole job is to say what the author published.
		if ((await gitBlobSha(content)) !== entry.sha) {
			throw new ReviewRefusedError('incomplete', corruptFileMessage(remote, entry.path));
		}
		return content;
	};

	const manifestBytes = await read(manifestEntry);
	const project = readManifest(manifestBytes);

	const wanted = gather(blobs, directory, project);
	const totalBytes = wanted.reduce((sum, entry) => sum + entry.bytes, 0) + manifestEntry.bytes;
	await assertRoomToReview(totalBytes, options.estimateStorage);

	let destination: ReviewDestination | null = null;
	try {
		destination = await open(remote.repository);
		const store = destination.store;
		// The mark, before anything else — see step 5. Complete on the first write, unlike the
		// bundle's: the manifest has already been read, so the Project's display name is known.
		await store.write(
			REVIEW_MARK_PATH,
			serialiseReviewMark({
				formatVersion: REVIEW_MARK_FORMAT_VERSION,
				project: project.name || directory,
				directory,
				openedAt: now().toISOString()
			})
		);

		let files = 0;
		let bytes = 0;
		const total = wanted.length + 1;
		const report = (path: string | null): void =>
			options.onProgress?.({ files, totalFiles: total, bytes, totalBytes, path });

		report(null);
		for (const entry of wanted) {
			const content = await read(entry);
			await writeReviewed(store, entry.path, content);
			files += 1;
			bytes += content.byteLength;
			report(entry.path);
		}

		// Last, and only now. Everything it names is already on disk, so the moment the Project lists
		// on the hub is the moment it is whole.
		await store.write(projectFilePath(directory) as StorePath, manifestBytes);
		files += 1;
		bytes += manifestBytes.byteLength;
		report(null);

		return {
			workspaceName: destination.name,
			directory,
			project,
			totalFiles: files,
			totalBytes: bytes,
			notice:
				`Opened “${project.name || directory}” from ${describeRemote(remote)} into a review copy ` +
				`called “${destination.name}”. It is a throwaway Workspace: your own Workspaces have not ` +
				`been touched, nothing here can be copied into them, and discarding this one removes ` +
				`everything in it.`
		};
	} catch (cause) {
		// What makes "Nothing has been opened" true. A discard that itself fails must not replace the
		// reason the Review was refused: the user needs to know what went wrong far more than they need
		// to know that cleaning up after it also did.
		if (destination) await destination.discard().catch(() => undefined);
		throw cause;
	}
}

/** The Remote's whole file list, with the refusals said in a Review's words. */
async function readReviewTree(
	remote: Required<ReviewReference>,
	fetchFn: FetchFn | undefined
): Promise<readonly RemoteBlob[]> {
	try {
		return await readRemoteTree(remote, fetchFn);
	} catch (cause) {
		if (!(cause instanceof RemoteTreeRefusedError)) {
			throw new ReviewRefusedError('refused', unreachableMessage(remote, cause));
		}
		switch (cause.refusal) {
			case 'no-repository':
				throw new ReviewRefusedError('no-repository', noRepositoryMessage(remote));
			case 'not-public':
				throw new ReviewRefusedError('no-repository', notPublicMessage(remote));
			case 'empty':
				throw new ReviewRefusedError('empty', emptyMessage(remote));
			case 'truncated':
				throw new ReviewRefusedError('truncated', truncatedMessage(cause.listed, remote));
			case 'unreachable':
				throw new ReviewRefusedError('refused', unreachableMessage(remote, cause.detail));
			case 'refused':
				throw new ReviewRefusedError('refused', refusedMessage(remote, cause.detail));
		}
	}
}

/**
 * The Project the user named and its manifest, having established the Remote really holds one.
 *
 * ⚠ **`remoteProjectDirectories` rather than "does `<dir>/project.json` exist"**, so that this asks
 * the same question of the same kind of tree as the publish and the Clone do — and so that the
 * refusal can name the alternatives, which is the difference between a message a scholar can act on
 * and one that tells them a folder they were sent is not there.
 *
 * It is also the whole of the path validation. The answer is a set of top-level directory names read
 * out of the tree, so a `project` of `../secrets` or `images` is simply not in it.
 */
function findProject(
	remote: Required<ReviewReference>,
	blobs: readonly RemoteBlob[]
): { directory: string; manifest: ReviewEntry } {
	const projects = remoteProjectDirectories(blobs.map((entry) => entry.path));
	const manifest = projects.has(remote.project)
		? blobs.find((entry) => entry.path === projectFilePath(remote.project))
		: undefined;
	if (manifest === undefined) {
		throw new ReviewRefusedError('no-project', noProjectMessage(remote, [...projects].sort()));
	}
	return { directory: remote.project, manifest: { ...manifest, path: manifest.path as StorePath } };
}

/**
 * The Project's own files, and the shared material its Layers reference. Nothing else.
 *
 * **The same closure `export-project-bundle.ts` gathers, asked of a tree instead of a store**, which
 * is what makes a Project reviewed from a Remote hold what the same Project handed over as a bundle
 * would. One `images/<id>/` per referenced Historical Map rather than the whole of `images/`,
 * because a Workspace holds a shared pool (ADR-0023) and a reviewer has no business receiving a
 * pyramid no Layer of the Project they were sent points at.
 *
 * A Layer whose image the Remote does not hold contributes nothing rather than failing. Publishing a
 * Project whose pyramid never made it is the author's mistake to see, and refusing the Review over it
 * would leave the reviewer unable to read the Annotations that *are* there — where opening it shows
 * them a Layer that draws nothing, which is what the Layer card already says.
 *
 * `project.json` is not among these: it has been read already and is written last.
 */
function gather(
	blobs: readonly RemoteBlob[],
	directory: string,
	project: ProjectFile
): ReviewEntry[] {
	const prefix = `${directory}/`;
	const manifest = projectFilePath(directory);

	const wanted: ReviewEntry[] = [];
	for (const entry of blobs) {
		if (!entry.path.startsWith(prefix) || entry.path === manifest) continue;
		// ⚠ The predicate is asked of the **Project-relative** name, which is what it is a predicate
		// about, and it is the same one the exporter asks. A published Project directory holds
		// `annotations/` and nothing else, so this removes nothing today — but a Workspace made by
		// unpacking a Published Site into a Project folder has the viewer's own files inside it
		// (ADR-0006), and those are publishing's rather than the author's.
		if (isViewerFile(entry.path.slice(prefix.length))) continue;
		wanted.push({ ...entry, path: entry.path as StorePath });
	}

	for (const imageId of referencedImageIds(project)) {
		const images = `${imageDirectory(imageId)}/`;
		for (const entry of blobs) {
			if (entry.path === alignmentPath(imageId) || entry.path.startsWith(images)) {
				wanted.push({ ...entry, path: entry.path as StorePath });
			}
		}
	}
	return wanted;
}

/**
 * The Historical Maps this Project's Layers draw, in the order they are first named.
 *
 * A map Layer is the only kind that references one: an Annotation Layer's `geojsonRef` is
 * Project-relative and is therefore already under `<dir>/`, and a Layer kind this build has never
 * heard of is not asked, because this build cannot know that a foreign kind's `imageId` names a
 * Historical Map at all — the same judgement `open-project-bundle.ts` makes about the same field.
 */
function referencedImageIds(project: ProjectFile): string[] {
	return [
		...new Set(
			project.layers.flatMap((layer) =>
				layer.kind === 'map' && layer.imageId !== '' ? [layer.imageId] : []
			)
		)
	];
}

/**
 * Parse the manifest, re-ending ADR-0010's refusal for this path.
 *
 * The same class and the same `formatVersion`, so everything catching it still does; only the
 * closing sentence changes, from a promise about a local Project — which does not exist here — to
 * the one every other refusal on this path makes.
 */
function readManifest(bytes: Bytes): ProjectFile {
	try {
		return parseProjectFile(bytes);
	} catch (cause) {
		if (cause instanceof ProjectFormatTooNewError) {
			throw new ProjectFormatTooNewError(
				cause.formatVersion,
				BALLASTELLA_CANONICAL_URL,
				'Nothing has been opened.'
			);
		}
		throw cause;
	}
}

/**
 * Write one reviewed file, sending an Alignment through the one writer (ticket 18, ADR-0023).
 *
 * Routed for the reason `clone-from-remote.ts` and `open-project-bundle.ts` both give at length, and
 * it is the same situation: the path arrives as *data* — an entry in somebody else's tree — so
 * neither the `AlignmentPath` brand nor `scripts/check-alignment-writers.mjs` can see it, and "the
 * Review writes Alignments with the generic writer" would be a true statement about the codebase
 * that the next person reads as permission.
 *
 * The destination is made by this call and is empty, so `intent: 'create'` always writes and the
 * decline `writeAlignmentBytes` can answer is unreachable from here — which is why there is nothing
 * for the caller to report, unlike a resumed Clone.
 */
async function writeReviewed(store: ProjectStore, path: StorePath, bytes: Bytes): Promise<void> {
	const imageId = alignmentImageId(path);
	if (imageId === null) {
		await store.write(path, bytes);
		return;
	}
	await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{ imageId, bytes, write: { intent: 'create' } }
	);
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

/**
 * Refuse a Review there is no room for, **before the Review Workspace exists**.
 *
 * `clone-from-remote.ts`'s argument, and ADR-0024's: OPFS shares the origin's quota, a teacher with
 * six review copies open can fail at eighty per cent, and refusing legibly beforehand beats
 * discovering it half way through a pyramid. Silent when the browser will not answer, because
 * refusing over an unavailable quota API would refuse every Review on Safari.
 *
 * The byte total is the tree's own over the closure alone — this Project's files, not the
 * repository's — which is an honest bound: git reports each blob's size, nothing here is compressed,
 * and no file is written that the listing did not name.
 */
async function assertRoomToReview(
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

	throw new ReviewRefusedError(
		'insufficient-quota',
		`This Project needs about ${describeBytes(needed)} and there is ${describeBytes(
			Math.max(0, free)
		)} free — ${describeBytes(usage)} of the ${describeBytes(quota)} this browser allows is ` +
			`already in use. Discard a review copy you have finished with, delete a Workspace you no ` +
			`longer need, or free space on this device, and try again.`
	);
}

// ── What the refusals say ─────────────────────────────────────────────────────────────────────

type Named = { readonly owner: string; readonly repository: string };

function noRepositoryMessage(remote: Named): string {
	return (
		`GitHub has no public repository at ${describeRemote(remote)}. Check the owner and the ` +
		`repository name — the two parts after github.com in the address bar. Reviewing reads a ` +
		`repository without signing in, so a private one looks exactly like a missing one from here; ` +
		`if it is private, whoever published it has to make it public first.`
	);
}

function notPublicMessage(remote: Named): string {
	return (
		`GitHub would not let this page read ${describeRemote(remote)} without signing in, so it is ` +
		`not a public repository. Reviewing is deliberately an anonymous operation — it needs no ` +
		`account and no token — so a private repository cannot be read at all. Whoever published it ` +
		`has to make it public, or send you the Project as a bundle instead.`
	);
}

function emptyMessage(remote: Named): string {
	return (
		`${describeRemote(remote)} exists but has nothing in it yet — no files, no branches, no ` +
		`Projects. Nothing is wrong with the address. If somebody told you they had published there, ` +
		`ask them to press Publish once.`
	);
}

/**
 * The Project is not there, with the ones that are.
 *
 * ⚠ **It names them.** A Project's identity is its folder name (ADR-0008), which is not what a
 * scholar was told when a colleague said "look at my Amsterdam one" — so the likeliest reason to be
 * here is a right repository and a wrong folder, and listing what it holds is the whole remedy.
 */
function noProjectMessage(
	remote: Named & { readonly project: string },
	projects: readonly string[]
): string {
	const holds =
		projects.length === 0
			? `It holds no Projects at all, so there is nothing there to review yet.`
			: `It holds ${projects.length === 1 ? 'one Project' : `${projects.length} Projects`}: ` +
				`${projects.join(', ')}.`;
	return (
		`${describeRemote(remote)} has no Project in a folder called “${remote.project}”. ${holds} A Project's ` +
		`folder is the part after the site's address in the link you were sent, which is not always ` +
		`what the Project calls itself.`
	);
}

function truncatedMessage(listed: number, remote: Named): string {
	return (
		`GitHub could only list the first ${listed} files in ${describeRemote(remote)}, so this ` +
		`Review cannot know what the rest of them are. Opening it anyway would hand you a review copy ` +
		`with most of a Historical Map silently missing — a Project that opens and draws a map full of ` +
		`holes — so nothing has been read. That repository has to hold fewer files before a Project in ` +
		`it can be reviewed.`
	);
}

function refusedMessage(remote: Named, detail: string): string {
	return `GitHub refused to list ${describeRemote(remote)}: ${detail}.`;
}

function missingFileMessage(remote: Named, path: string, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`${describeRemote(remote)} listed ${path}, but it could not be downloaded: ${detail}. A file ` +
		`can be deleted, or a branch moved, while a Review is running — so this one has stopped rather ` +
		`than show you a Project with a file silently missing. Opening it again starts afresh.`
	);
}

function corruptFileMessage(remote: Named, path: string): string {
	return (
		`${path} arrived from ${describeRemote(remote)} as different bytes from the ones its file list ` +
		`named, so this Review has stopped rather than show you work its author may not have ` +
		`published. Something between this browser and GitHub — a proxy, or a cache — served a ` +
		`rewritten copy. Opening it again starts afresh.`
	);
}

function unreachableMessage(remote: Named, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`GitHub could not be reached, so ${describeRemote(remote)} could not be read. The browser ` +
		`reported: ${detail}. This is about the connection rather than about that repository, and ` +
		`everything you already have is still saved on this computer.`
	);
}
