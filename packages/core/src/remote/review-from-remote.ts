import { writeArrivedFile } from '../alignment/alignment-file.js';
import { alignmentPath } from '../alignment/alignment.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import { IMAGE_DIRECTORY, imageDirectory, imageInfoPath } from '../project/image-files.js';
import { parseProjectFile, projectFilePath, type ProjectFile } from '../project/project-file.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { imageDescriptionPaths } from '../remote-iiif/referenced-image.js';
import { messageOf, type StorePath } from '../store/project-store.js';
import { layerReferences } from '../project/layer.js';
import type {
	OpenReviewDestination,
	ReviewDestination
} from '../transfer/project-import-source.js';
import type { EstimateStorage } from '../store/persistent-storage.js';
import { storageShortfall, type TransferProgressListener } from '../transfer/transfer.js';
import { isViewerFile } from '../transfer/viewer-files.js';
import { describeReset, verifiedReader } from './github-api.js';
import { projectDirectories } from './synchronization-paths.js';
import {
	RemoteTreeRefusedError,
	readRemoteHeadCommit,
	readRemoteTree,
	type RemoteBlob
} from './remote-tree.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote, type RemoteReference } from './remote-binding.js';

export type ReviewReference = RemoteReference & {
	readonly project: string;
};

type ReviewRefusal =
	| 'no-repository'
	| 'rate-limited'
	| 'empty'
	| 'truncated'
	| 'no-project'
	| 'insufficient-quota'
	| 'incomplete'
	| 'refused';

export class ReviewRefusedError extends Error {
	override readonly name = 'ReviewRefusedError';
	constructor(
		readonly refusal: ReviewRefusal,
		message: string
	) {
		super(`${message} Nothing has been opened.`);
	}
}

interface UnmetReference {
	readonly reference: string;
	readonly layer: string;
	readonly kind: 'image' | 'annotation';
}

export interface ReviewedProject {
	readonly workspaceName: string;
	readonly directory: string;
	readonly project: ProjectFile;
	readonly totalFiles: number;
	readonly totalBytes: number;
	readonly unmet: readonly UnmetReference[];
	readonly notice: string;
}

type ReviewEntry = RemoteBlob & { readonly path: StorePath };

export async function reviewFromRemote(
	open: OpenReviewDestination,
	options: {
		readonly remote: ReviewReference;
		readonly fetch?: FetchFn;
		readonly onProgress?: TransferProgressListener;
		readonly estimateStorage?: EstimateStorage;
		readonly now?: () => Date;
	}
): Promise<ReviewedProject> {
	const now = options.now ?? (() => new Date());
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote = { ...options.remote, branch };
	const blobs = await readReviewTree(remote, options.fetch);
	const { directory, manifest: manifestEntry } = findProject(remote, blobs);

	const read = verifiedReader(remote, branch, options.fetch, {
		missing: (path, cause) =>
			new ReviewRefusedError('incomplete', missingFileMessage(remote, path, cause)),
		corrupt: (path) => new ReviewRefusedError('incomplete', corruptFileMessage(remote, path))
	});

	const manifestBytes = await read(manifestEntry.path, manifestEntry.sha);
	const project = parseProjectFile(manifestBytes, 'Nothing has been opened.');

	const { wanted, unmet } = gather(blobs, directory, project);
	const totalBytes = wanted.reduce((sum, entry) => sum + entry.bytes, 0) + manifestEntry.bytes;
	await assertRoomToReview(totalBytes, options.estimateStorage);

	let destination: ReviewDestination | null = null;
	try {
		destination = await open(remote.repository);
		const store = destination.store;
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
			const content = await read(entry.path, entry.sha);
			if ((await writeArrivedFile(store, entry.path, content)) === 'declined') {
				throw new ReviewRefusedError('incomplete', declinedFileMessage(entry.path));
			}
			files += 1;
			bytes += content.byteLength;
			report(entry.path);
		}

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
		if (destination) await destination.discard().catch(() => undefined);
		throw cause;
	}
}

export const readReviewTree = (
	remote: Required<ReviewReference>,
	fetchFn: FetchFn | undefined
): Promise<readonly RemoteBlob[]> =>
	readRemoteTree(remote, fetchFn).catch((cause: unknown) => {
		throw reviewRefusalFor(cause, remote);
	});

export const readReviewHeadCommit = (
	remote: Required<ReviewReference>,
	fetchFn: FetchFn | undefined
): Promise<string> =>
	readRemoteHeadCommit(remote, fetchFn).catch((cause: unknown) => {
		throw reviewRefusalFor(cause, remote);
	});

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

function gather(
	blobs: readonly RemoteBlob[],
	directory: string,
	project: ProjectFile
): { wanted: readonly ReviewEntry[]; unmet: readonly UnmetReference[] } {
	const prefix = `${directory}/`;
	const manifest = projectFilePath(directory);
	const wanted: ReviewEntry[] = [];
	const inProject = new Set<string>();
	const byImage = new Map<string, ReviewEntry[]>();
	const byPath = new Map<string, ReviewEntry>();

	for (const blob of blobs) {
		const entry: ReviewEntry = { ...blob, path: blob.path as StorePath };
		if (blob.path.startsWith(prefix)) {
			if (blob.path === manifest) continue;
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
		for (const reference of layerReferences(layer)) {
			if (reference === '') continue;
			if (!inProject.has(`${prefix}${reference}`)) {
				unmet.push({ reference: `${prefix}${reference}`, layer: named, kind: 'annotation' });
			}
		}

		if (layer.kind !== 'map' || layer.imageId === '') continue;
		const files = byImage.get(layer.imageId) ?? [];
		const described = imageDescriptionPaths(layer.imageId);
		if (!files.some((entry) => described.includes(entry.path))) {
			unmet.push({
				reference:
					files.length === 0 ? `${imageDirectory(layer.imageId)}/` : imageInfoPath(layer.imageId),
				layer: named,
				kind: 'image'
			});
			continue;
		}
		if (taken.has(layer.imageId)) continue;
		taken.add(layer.imageId);
		wanted.push(...files);
		const alignment = byPath.get(alignmentPath(layer.imageId));
		if (alignment !== undefined) wanted.push(alignment);
	}

	return { wanted, unmet };
}

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

async function assertRoomToReview(
	needed: number,
	estimateStorage: EstimateStorage | undefined
): Promise<void> {
	const short = await storageShortfall(needed, estimateStorage);
	if (short === null) return;
	throw new ReviewRefusedError(
		'insufficient-quota',
		`This Project ${short} Discard a review copy you have finished with, delete a Workspace you ` +
			`no longer need, or free space on this device, and try again.`
	);
}

const noRepositoryMessage = (remote: RemoteReference): string =>
	`GitHub has no public repository at ${describeRemote(remote)}. Check the owner and the ` +
	`repository name — the two parts after github.com in the address bar. Reviewing reads a ` +
	`repository without signing in, so a private one looks exactly like a missing one from here; ` +
	`if it is private, whoever owns it has to make it public first.`;

const notPublicMessage = (remote: RemoteReference): string =>
	`GitHub would not let this page read ${describeRemote(remote)} without signing in, so it is ` +
	`not a public repository. Reviewing is deliberately an anonymous operation — it needs no ` +
	`account and no token — so a private repository cannot be read at all. Whoever owns it ` +
	`has to make it public, or send you the Project as a bundle instead.`;

function rateLimitedMessage(remote: RemoteReference, resetAt: Date | null): string {
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

const emptyMessage = (remote: RemoteReference): string =>
	`${describeRemote(remote)} exists but has nothing in it yet — no files, no branches, no ` +
	`Projects. Nothing is wrong with the address. If somebody told you their work was there, ` +
	`ask them to Sync once.`;

function noProjectMessage(
	remote: RemoteReference & { readonly project: string },
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

const truncatedMessage = (listed: number, remote: RemoteReference): string =>
	`GitHub could only list the first ${listed} files in ${describeRemote(remote)}, so this ` +
	`Review cannot know what the rest of them are. Opening it anyway would hand you a review copy ` +
	`with most of a Map Image silently missing — a Project that opens and draws a map full of ` +
	`holes — so nothing has been read. That repository has to hold fewer files before a Project in ` +
	`it can be reviewed.`;

function refusedMessage(remote: RemoteReference, detail: string): string {
	return `GitHub refused to list ${describeRemote(remote)}: ${detail}.`;
}

const missingFileMessage = (remote: RemoteReference, path: string, cause: unknown): string =>
	`${describeRemote(remote)} listed ${path}, but it could not be downloaded: ${messageOf(cause)}. A file ` +
	`can be deleted, or a branch moved, while a Review is running — so this one has stopped rather ` +
	`than show you a Project with a file silently missing. Opening it again starts afresh.`;

const declinedFileMessage = (path: string): string =>
	`${path} could not be written into the review copy, because something was already there. A ` +
	`review copy is made empty and filled once, so this should not be possible — and going on would ` +
	`show you a Project whose file list says it is whole.`;

const corruptFileMessage = (remote: RemoteReference, path: string): string =>
	`${path} arrived from ${describeRemote(remote)} as different bytes from the ones its file list ` +
	`named, so this Review has stopped rather than show you work its author may not have ` +
	`sent. Something between this browser and GitHub — a proxy, or a cache — served a ` +
	`rewritten copy. Opening it again starts afresh.`;

const unreachableMessage = (remote: RemoteReference, cause: unknown): string =>
	`GitHub could not be reached, so ${describeRemote(remote)} could not be read. The browser ` +
	`reported: ${messageOf(cause)}. This is about the connection rather than about that repository, and ` +
	`everything you already have is still saved on this computer.`;
