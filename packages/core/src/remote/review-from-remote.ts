// Downloading **one Project** out of a public repository, into a Review Workspace (ADR-0024,
// ADR-0031, ADR-0032, ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE BUNDLE PATH WITH A DIFFERENT SOURCE OF BYTES, AND THE REFUSAL IS HALF THE POINT
//
// `open-project-bundle.ts` reads a Project out of a tar into a throwaway Workspace of its own; this
// reads one out of somebody's Remote into the same kind of Workspace. What arrives is unbound,
// unpublishable, and carries the banner that says so, because the reason has not changed with the
// transport: a review copy is for reading somebody's work as they published it, and a Workspace that
// is thrown away afterwards is what makes every refusal on this path free.
//
// ⚠ **Nothing reached from here writes into a Workspace of the user's own, and this module is the
// most likely place for that to be helpfully introduced.** Copying a published Project into work the
// user owns is **Import** (ADR-0037), and it goes through `remote-project-source.ts` — a read-only
// source capability with no destination store on it — into the Import engine, which is the one thing
// allowed to hold a validated closure and a writable ordinary Workspace at the same time. What this
// module makes is a review copy: unbound, unpublishable, and discarded when the reviewer has
// finished.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A SIBLING OF THE CLONE, AND WHERE IT DELIBERATELY DIVERGES
//
// The file list, the two hosts, the anonymity and the blob-SHA check are `clone-from-remote.ts`'s and
// are shared rather than restated — the listing through `remote-tree.ts`, the namespace question
// through `projectDirectories`, the byte check through `gitBlobSha`. Four things differ, and
// each is a decision rather than an accident:
//
//   1. **The unit is one Project's closure, not the owned namespace.** From the tree it takes
//      `<dir>/**`, and — by reading that Project's Layers — the `images/<id>/**` and
//      `alignments/<id>.json` those Layers name. A Workspace-shared Map Image no Layer of this
//      Project references does not travel, which is the same rule `export-project-bundle.ts` applies
//      and the whole difference between a handoff and a backup. That closure is *inside* the owned
//      namespace by construction, so `isOwnedPath` is not applied as a filter here: every path it
//      takes is either under a directory `projectDirectories` named or under `images/` or
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
import { alignmentImageId, alignmentPath } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { IMAGE_DIRECTORY, imageDirectory } from '../project/image-files.js';
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
import { REFERENCED_IMAGE_FILE } from '../remote-iiif/referenced-image.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import type { Bytes, ProjectStore, StorePath } from '../store/project-store.js';
import { layerReferences } from '../transfer/open-project-bundle.js';
import type { OpenReviewDestination, ReviewDestination } from '../transfer/open-project-bundle.js';
import type { EstimateStorage } from '../transfer/restore-workspace-tar.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import { isViewerFile } from '../transfer/viewer-files.js';
import { gitBlobSha } from './blob-sha.js';
import type { CloneReference } from './clone-from-remote.js';
import { GITHUB_RAW_ORIGIN, describeReset } from './github-api.js';
import { projectDirectories } from './synchronization-paths.js';
import {
	RemoteTreeRefusedError,
	readRemoteHeadCommit,
	readRemoteTree,
	urlPath,
	type RemoteBlob
} from './remote-tree.js';
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
	/**
	 * GitHub's hourly limit for anonymous readers is used up. Nothing is wrong with the repository.
	 *
	 * Separate from `'no-repository'` because the remedy is waiting rather than asking somebody to
	 * change a setting — see `remote-tree.ts`'s `'rate-limited'` for why the two arrive as the
	 * same status, and why a class reviewing one instructor's repository is how a scholar gets here.
	 */
	| 'rate-limited'
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

/**
 * A file this Project's Layers name that the Remote does not hold.
 *
 * ⚠ **The Review does not refuse over one, and does not hide one either.** The bundle path refuses
 * the same situation by name (`assertReferencesPresent`), which it can because a bundle is one file
 * a sender can be asked to make again. A Remote is not: refusing would leave a reviewer unable to
 * read the Annotations that *did* arrive, over a pyramid whose absence is the author's mistake and
 * not theirs. So what arrives is everything there was, and this says what was not there.
 */
export interface UnmetReference {
	/** The path the Remote would have had to hold, as a reviewer could ask its author for it. */
	readonly reference: string;
	/** The Layer that needed it, named as the Layer card names it. */
	readonly layer: string;
	/** What will be missing on screen, which is what makes the notice's two sentences different. */
	readonly kind: 'image' | 'annotation';
}

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
	/**
	 * How many bytes were **written**, which is not what `WorkspaceClone.totalBytes` counts.
	 *
	 * A Clone reports the tree's own figure for everything it means to fetch, because a resumed Clone
	 * writes only some of it and the total a progress line counts towards must not move between runs.
	 * A Review always writes everything it fetches, once, so the honest figure is the one measured on
	 * the way past — and it is the figure the closing progress report ends on.
	 */
	readonly totalBytes: number;
	/**
	 * Files this Project's Layers name that the Remote did not hold, and that therefore did not come.
	 *
	 * Empty for a Project published whole, which is every ordinary one. Reported rather than
	 * swallowed, for `WorkspaceClone.declined`'s reason — a transfer that quietly delivers less
	 * than it was given is the exact failure `restore-workspace-tar.ts`'s whole format change escaped
	 * — and here the reviewer cannot discover it any other way: a Layer card has no missing-image
	 * state, so a map Layer whose pyramid never arrived draws blank and looks exactly like one nobody
	 * has aligned yet.
	 */
	readonly unmet: readonly UnmetReference[];
	/** What the user has to be told, in the words they should see. */
	readonly notice: string;
}

/** One file the Remote holds that a Review or an Import is to bring down. */
export type ReviewEntry = RemoteBlob & { readonly path: StorePath };

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
 *    A reference the Remote turns out not to hold does not stop this — it is carried out on
 *    {@link ReviewedProject.unmet} and named in the notice, for `gather`'s reason.
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

	const { wanted, unmet } = gather(blobs, directory, project);
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
				openedAt: now().toISOString(),
				origin: destination.origin
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
			// ⚠ **A decline is a refusal here rather than a file quietly left out**, which is the whole
			// difference between this and the Clone's resume. The destination is made by this call and is
			// empty, so `writeAlignmentBytes` cannot decline against it — but if it ever could, counting
			// the file as written would report a Review that delivered everything while an Alignment was
			// missing from the Workspace, which is the failure `unmet` exists to make impossible.
			if ((await writeReviewed(store, entry.path, content)) === 'declined') {
				throw new ReviewRefusedError('incomplete', declinedFileMessage(entry.path));
			}
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
			unmet,
			notice:
				`Opened “${project.name || directory}” from ${describeRemote(remote)} into a review copy ` +
				`called “${destination.name}”. It is a throwaway Workspace: your own Workspaces have not ` +
				`been touched, nothing here reaches one unless you ask for it with Import, and ` +
				`discarding this one removes everything in it.` +
				unmetSentence(unmet)
		};
	} catch (cause) {
		// What makes "Nothing has been opened" true. A discard that itself fails must not replace the
		// reason the Review was refused: the user needs to know what went wrong far more than they need
		// to know that cleaning up after it also did.
		if (destination) await destination.discard().catch(() => undefined);
		throw cause;
	}
}

/**
 * The Remote's whole file list, with the refusals said in a Review's words.
 *
 * Exported for `remote-project-source.ts`, which asks the same question of the same host for an
 * Import and needs the same sentences: two translations of GitHub's statuses is how a Review and an
 * Import come to tell a rate-limited class two different things about one repository.
 */
export async function readReviewTree(
	remote: Required<ReviewReference>,
	fetchFn: FetchFn | undefined
): Promise<readonly RemoteBlob[]> {
	try {
		return await readRemoteTree(remote, fetchFn);
	} catch (cause) {
		throw reviewRefusalFor(cause, remote);
	}
}

/**
 * The commit the Remote's branch stands at, with the refusals said in a Review's words.
 *
 * Exported for `remote-project-source.ts`: an Import records the commit it copied a Project from
 * (SPEC story 59), and a repository that cannot be read has to say the same thing here as it says
 * about the file list one request earlier.
 */
export async function readReviewHeadCommit(
	remote: Required<ReviewReference>,
	fetchFn: FetchFn | undefined
): Promise<string> {
	try {
		return await readRemoteHeadCommit(remote, fetchFn);
	} catch (cause) {
		throw reviewRefusalFor(cause, remote);
	}
}

/**
 * One reading of GitHub's statuses into a Review's sentences, for both of the reads above.
 *
 * Returned rather than thrown so the call sites read as `throw`, and written once because the
 * alternative is a Review and an Import telling a rate-limited class two different things about one
 * repository — the divergence this module's shared exports exist to prevent.
 */
function reviewRefusalFor(cause: unknown, remote: Required<ReviewReference>): ReviewRefusedError {
	if (!(cause instanceof RemoteTreeRefusedError)) {
		return new ReviewRefusedError('refused', unreachableMessage(remote, cause));
	}
	switch (cause.refusal) {
		case 'no-repository':
			return new ReviewRefusedError('no-repository', noRepositoryMessage(remote));
		case 'not-public':
			return new ReviewRefusedError('no-repository', notPublicMessage(remote));
		case 'rate-limited':
			return new ReviewRefusedError('rate-limited', rateLimitedMessage(remote, cause.resetAt));
		case 'empty':
			return new ReviewRefusedError('empty', emptyMessage(remote));
		case 'truncated':
			return new ReviewRefusedError('truncated', truncatedMessage(cause.listed, remote));
		case 'unreachable':
			return new ReviewRefusedError('refused', unreachableMessage(remote, cause.detail));
		case 'refused':
			return new ReviewRefusedError('refused', refusedMessage(remote, cause.detail));
	}
}

/**
 * The Project the user named and its manifest, having established the Remote really holds one.
 *
 * ⚠ **`projectDirectories` rather than "does `<dir>/project.json` exist"**, so that this asks
 * the same question of the same kind of tree as the publish and the Clone do — and so that the
 * refusal can name the alternatives, which is the difference between a message a scholar can act on
 * and one that tells them a folder they were sent is not there.
 *
 * It is also the whole of the path validation. The answer is a set of top-level directory names read
 * out of the tree, so a `project` of `../secrets` or `images` is simply not in it.
 *
 * Exported for `remote-project-source.ts`: an Import of a published Project has to find it in the same
 * tree, and it must be refused with the same sentence and the same list of alternatives.
 */
export function findProject(
	remote: Required<ReviewReference>,
	blobs: readonly RemoteBlob[]
): { directory: string; manifest: ReviewEntry } {
	const projects = projectDirectories(blobs.map((entry) => entry.path));
	const manifest = projects.has(remote.project)
		? blobs.find((entry) => entry.path === projectFilePath(remote.project))
		: undefined;
	if (manifest === undefined) {
		throw new ReviewRefusedError('no-project', noProjectMessage(remote, [...projects].sort()));
	}
	return { directory: remote.project, manifest: { ...manifest, path: manifest.path as StorePath } };
}

/** What a Review is to bring down, and what its Layers named that the Remote turned out not to hold. */
type Closure = {
	readonly wanted: readonly ReviewEntry[];
	readonly unmet: readonly UnmetReference[];
};

/**
 * The Project's own files, and the shared material its Layers reference. Nothing else.
 *
 * **The same closure `export-project-bundle.ts` gathers, asked of a tree instead of a store**, which
 * is what makes a Project reviewed from a Remote hold what the same Project handed over as a bundle
 * would. One `images/<id>/` per referenced Map Image rather than the whole of `images/`,
 * because a Workspace holds a shared pool (ADR-0023) and a reviewer has no business receiving a
 * pyramid no Layer of the Project they were sent points at.
 *
 * ⚠ **What the Remote does not hold is *reported*, never dropped, and never refused over.** The
 * bundle path refuses the same situation by name — `assertReferencesPresent`, "this bundle is missing
 * X, which the Layer Y needs to be drawn" — and it can, because a bundle is one file its sender can
 * be asked to make again. Refusing here would punish a reviewer for their author's publishing
 * mistake and leave them unable to read the Annotations that *did* arrive. Silently dropping it is
 * worse still: nothing on a Layer card says an image is missing, so the map Layer draws blank and is
 * indistinguishable from one nobody has aligned yet. So both loops below answer with what came *and*
 * with what did not, and {@link reviewFromRemote} says so in the notice.
 *
 * **One pass over the tree**, bucketed by what each path is under, rather than a scan per referenced
 * Map Image. A Project with fifty maps would otherwise walk a fifty-thousand-file listing fifty
 * times to find the same thing each time.
 *
 * `project.json` is not among these: it has been read already and is written last.
 */
function gather(blobs: readonly RemoteBlob[], directory: string, project: ProjectFile): Closure {
	const prefix = `${directory}/`;
	const manifest = projectFilePath(directory);

	const wanted: ReviewEntry[] = [];
	/** Everything under `<dir>/` that is travelling, so an Annotation's reference can be checked. */
	const inProject = new Set<string>();
	const byImage = new Map<string, ReviewEntry[]>();
	const byPath = new Map<string, ReviewEntry>();

	for (const blob of blobs) {
		const entry: ReviewEntry = { ...blob, path: blob.path as StorePath };
		if (blob.path.startsWith(prefix)) {
			if (blob.path === manifest) continue;
			// ⚠ The predicate is asked of the **Project-relative** name, which is what it is a predicate
			// about, and it is the same one the exporter asks. A published Project directory holds
			// `annotations/` and nothing else, so this removes nothing today — but a Workspace made by
			// unpacking a Published Site into a Project folder has the viewer's own files inside it
			// (ADR-0006), and those are publishing's rather than the author's.
			if (isViewerFile(blob.path.slice(prefix.length))) continue;
			inProject.add(blob.path);
			wanted.push(entry);
			continue;
		}
		const segments = blob.path.split('/');
		if (segments[0] === IMAGE_DIRECTORY && segments.length > 2) {
			const imageId = segments[1] ?? '';
			const held = byImage.get(imageId);
			if (held === undefined) byImage.set(imageId, [entry]);
			else held.push(entry);
			continue;
		}
		byPath.set(blob.path, entry);
	}

	const unmet: UnmetReference[] = [];
	const taken = new Set<string>();
	for (const layer of project.layers) {
		const named = layer.name || layer.id;
		// An Annotation Layer's `geojsonRef` is Project-relative, so what it names is under `<dir>/` and
		// has already been taken above if it is there at all. Asked through the bundle reader's own
		// collector so that a Layer kind added later cannot say one thing to a bundle and another here.
		for (const reference of layerReferences(layer)) {
			if (reference === '') continue;
			if (!inProject.has(`${prefix}${reference}`)) {
				unmet.push({ reference: `${prefix}${reference}`, layer: named, kind: 'annotation' });
			}
		}

		// A map Layer is the only kind asked about a Map Image. A kind this build has never heard
		// of is not, because this build cannot know that a foreign kind's `imageId` names one at all —
		// the same judgement `open-project-bundle.ts` makes about the same field.
		if (layer.kind !== 'map' || layer.imageId === '') continue;
		const files = byImage.get(layer.imageId) ?? [];
		const directoryOf = imageDirectory(layer.imageId);
		// **Two ways to be describable, because there are two kinds of image** (`assertReferencesPresent`
		// makes the same distinction): a local copy has the `info.json` that makes its pyramid readable,
		// a referenced one has `remote.json` because its tiles are on somebody else's server. A heap of
		// tiles with neither is a directory no client can open, so the image is missing whether or not
		// the directory exists — and its tiles are then not worth downloading.
		const readable = files.some(
			(entry) =>
				entry.path === `${directoryOf}/info.json` ||
				entry.path === `${directoryOf}/${REFERENCED_IMAGE_FILE}`
		);
		if (!readable) {
			unmet.push({
				reference: files.length === 0 ? `${directoryOf}/` : `${directoryOf}/info.json`,
				layer: named,
				kind: 'image'
			});
			continue;
		}
		if (taken.has(layer.imageId)) continue;
		taken.add(layer.imageId);
		wanted.push(...files);
		// ⚠ **An Alignment is wanted and never required.** A Map Image added to a Project is a
		// Layer from that moment, aligned or not (ADR-0023), so a Project in that ordinary state has no
		// `alignments/<id>.json` at all and its absence is not a missing reference.
		const alignment = byPath.get(alignmentPath(layer.imageId));
		if (alignment !== undefined) wanted.push(alignment);
	}

	return { wanted, unmet };
}

/**
 * What a review copy is missing, in the words a reviewer can take back to its author.
 *
 * Two sentences rather than one list, because the two lose different things: an image that did not
 * arrive is a Layer drawing nothing, and an Annotation document that did not arrive is a Layer with
 * no features in it. Both name the Layer, which is what a reviewer sees on screen, and the path,
 * which is what an author has to publish.
 */
function unmetSentence(unmet: readonly UnmetReference[]): string {
	if (unmet.length === 0) return '';
	const describe = (one: UnmetReference): string => `“${one.layer}” (${one.reference})`;
	const images = unmet.filter((one) => one.kind === 'image');
	const annotations = unmet.filter((one) => one.kind === 'annotation');
	const said: string[] = [];
	if (images.length > 0) {
		said.push(
			`${images.length} ${images.length === 1 ? 'Layer names a Map Image' : 'Layers name Map Images'} ` +
				`the Remote does not hold, so ${images.length === 1 ? 'it will' : 'they will'} draw nothing: ` +
				`${images.map(describe).join(', ')}`
		);
	}
	if (annotations.length > 0) {
		said.push(
			`${annotations.length} ${annotations.length === 1 ? 'Layer names an Annotation file' : 'Layers name Annotation files'} ` +
				`the Remote does not hold: ${annotations.map(describe).join(', ')}`
		);
	}
	return ` This review copy is incomplete, and what is missing was missing on the Remote: ${said.join('; ')}.`;
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
 * decline `writeAlignmentBytes` can answer is unreachable through {@link reviewFromRemote} — but it
 * is *answered* rather than discarded, because a caller that ignored it would count a file it did
 * not write. A resumed Clone reports its declines; a Review has nowhere to put one, so it refuses.
 *
 * @returns `'written'`, or `'declined'` when the destination already held an Alignment for that map
 */
async function writeReviewed(
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

/**
 * The hourly limit, said as a wait rather than as a fault in the repository.
 *
 * ⚠ **It names the limit as *anonymous* and the address as *shared*, and this path is where that
 * matters most.** Reviewing signs in to nothing, so the budget is GitHub's 60 requests an hour per IP
 * address — and the scenario SPEC story 48 describes is a class of students all reviewing their
 * instructor's Project from one campus connection, where the 61st reader meets this having made no
 * requests at all. Reported as a private repository it sends a room full of people to change a
 * setting on a repository none of them own.
 */
function rateLimitedMessage(remote: Named, resetAt: Date | null): string {
	const at = describeReset(resetAt);
	return (
		`GitHub's hourly limit for anonymous readers has been used up, so ${describeRemote(remote)} ` +
		`could not be read. Nothing is wrong with the address and nothing is wrong with that ` +
		`repository — reviewing reads GitHub without signing in, and that allows 60 requests an hour ` +
		`for each internet connection, so on a shared one — a university network, a classroom — ` +
		`everybody's reading counts together. ` +
		`${at === '' ? 'Wait until the limit resets and open it again' : `Open it again after ${at}, when the limit resets`}.`
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
		`with most of a Map Image silently missing — a Project that opens and draws a map full of ` +
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

/** A Workspace that was to be brand new and was not, which is a broken invariant rather than a fault. */
function declinedFileMessage(path: string): string {
	return (
		`${path} could not be written into the review copy, because something was already there. A ` +
		`review copy is made empty and filled once, so this should not be possible — and going on would ` +
		`show you a Project whose file list says it is whole.`
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
