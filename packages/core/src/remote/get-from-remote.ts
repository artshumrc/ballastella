import { eachInTurn } from '../each-in-turn.js';
import { isProjectManifest } from '../project/project-file.js';
import { describeBytes } from '../project/workspace-size.js';
import {
	messageOf,
	readIfPresent,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import { storageRoom, type EstimateStorage } from '../store/persistent-storage.js';
import { gitBlobSha } from './blob-sha.js';
import { authorisedFetch, describeReset, verifiedReader } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote, type RemoteReference } from './remote-binding.js';
import {
	RemoteTreeRefusedError,
	readRemoteHeadCommit,
	readRemoteTree,
	type RemoteBlob
} from './remote-tree.js';
import { count } from './shared-remote.js';
import {
	describeGraphFailure,
	describeGraphViolations,
	planWorkspaceSync,
	validateProspectiveWorkspace
} from './synchronization-planner.js';
import { resolveConflicts, type AlignmentChoice } from './conflict-resolution.js';
import {
	UPDATE_BEFORE_DIRECTORY,
	UPDATE_TRANSACTION_PATH,
	UpdateRefusedError,
	recoverWorkspaceUpdate,
	writeInbound,
	writeUpdate
} from './update-transaction.js';
import type { FetchFn } from '../injection/store-image-fetch.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import type { RemoteRelationship, SynchronizationBaseline } from './synchronization-metadata.js';
import type {
	GraphVerdict,
	InventoryEntry,
	PathChoice,
	WorkspaceSyncPlan
} from './synchronization-planner.js';
import type { ConflictCopy, ConflictResolution } from './conflict-resolution.js';

interface GetFromRemoteOptions {
	readonly remote: RemoteReference;
	readonly token: string | null;
	readonly baseline: SynchronizationBaseline | null;
	readonly fetch?: FetchFn;
	readonly onProgress?: TransferProgressListener;
	readonly estimateStorage?: EstimateStorage;
	readonly now?: () => Date;
	readonly transaction?: () => string;
	readonly workspace?: string;
	readonly alignmentChoices?: ReadonlyMap<string, AlignmentChoice>;
	readonly mintLayerId?: () => string;
}

export interface WorkspaceUpdate {
	readonly remote: RemoteRelationship;
	readonly commit: string;
	readonly added: readonly string[];
	readonly replaced: readonly string[];
	readonly removed: readonly string[];
	readonly retained: readonly string[];
	readonly copies: readonly ConflictCopy[];
	readonly unansweredAlignments: readonly string[];
	readonly totalFiles: number;
	readonly totalBytes: number;
	readonly baseline: ReadonlyMap<string, string>;
	readonly shared: readonly string[];
	readonly notice: string;
}

type PlannedFile = {
	readonly path: StorePath;
	readonly sha: string;
	readonly bytes: number;
	readonly effect: 'add' | 'replace';
	readonly fetched: Bytes | null;
	readonly answered?: boolean;
};

export const UPDATE_DOWNLOAD_CONCURRENCY = 6;

export async function getFromRemote(
	store: ProjectStore,
	options: GetFromRemoteOptions
): Promise<WorkspaceUpdate> {
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote: RemoteRelationship = { ...options.remote, branch };

	await recoverWorkspaceUpdate(store);

	const { token } = options;
	const refuse = (cause: unknown): never => {
		throw asUpdateRefusal(remote, token, cause);
	};
	const commit = await readRemoteHeadCommit(remote, options.fetch, token).catch(refuse);
	const blobs = await readRemoteTree({ ...remote, branch: commit }, options.fetch, token).catch(
		refuse
	);
	const listed = new Map(blobs.map((blob) => [blob.path, blob]));
	const local = await hashWorkspace(store);
	const localShas = new Map(local.map((entry) => [entry.path, entry.sha]));
	const inventory = { local, remote: blobs.map(({ path, sha }) => ({ path, sha })) };
	const planned = planWorkspaceSync({ ...inventory, baseline: options.baseline });
	assertGettable(remote, planned.comparison.graph);

	const rawFetch = token === null ? options.fetch : authorisedFetch(options.fetch, token);
	const read = verifiedReader(remote, commit, rawFetch, {
		missing: (path, cause) =>
			new UpdateRefusedError('incomplete', missingFileMessage(remote, path, cause), {
				paths: [path]
			}),
		corrupt: (path) =>
			new UpdateRefusedError('incomplete', corruptFileMessage(remote, path), { paths: [path] })
	});

	const manifests = await prospectiveManifests(store, read, planned, localShas);
	const plan = planWorkspaceSync({
		...inventory,
		baseline: options.baseline,
		projectFiles: manifests.byShaOnly
	});
	assertGettable(remote, plan.comparison.graph);

	const files: PlannedFile[] = plan.toGet.changes
		.filter((change): change is PathChoice & { sha: string } => change.sha !== null)
		.map((change) => ({
			path: change.path as StorePath,
			sha: change.sha,
			bytes: listed.get(change.path)?.bytes ?? 0,
			effect: change.effect === 'replace' ? 'replace' : 'add',
			fetched: manifests.byPath.get(change.path) ?? null
		}));

	const resolution = await resolveConflicts({
		conflicts: plan.conflicts,
		remote: blobs.map((blob) => blob.path),
		local: local.map((entry) => entry.path),
		...(options.baseline === null ? {} : { baseline: [...options.baseline.files.keys()] }),
		readRemote: (path) => read(path, listed.get(path)?.sha ?? ''),
		readManifest: async (path) =>
			manifests.byPath.get(path) ?? (await store.read(path as StorePath)),
		...(options.mintLayerId === undefined ? {} : { mintLayerId: options.mintLayerId })
	});
	const answered = await answerAlignments(read, listed, localShas, resolution, options);
	files.push(...copiedFiles(resolution, localShas), ...answered.files);

	assertProspectiveWorkspace(remote, plan, files, manifests.byShaOnly);
	const removals = plan.toGet.removed.map((path) => path as StorePath);

	await assertRoomToUpdate(store, files, removals, options.estimateStorage);
	const transferred = await transfer(store, read, files, removals, commit, options);
	const settled = new Map<string, string>();
	for (const path of [...resolution.settled, ...answered.settled]) {
		const sha = listed.get(path)?.sha;
		if (sha !== undefined) settled.set(path, sha);
	}

	return {
		remote,
		commit,
		added: pathsWith(files, 'add'),
		replaced: pathsWith(files, 'replace'),
		removed: removals,
		retained: plan.retained,
		copies: resolution.copies,
		unansweredAlignments: answered.unanswered,
		totalFiles: files.length,
		totalBytes: transferred,
		baseline: advancedBaseline(options.baseline, plan, settled),
		// A settled path is not shared: the file there is still the author's own, still to be sent.
		shared: [...plan.toGet.advances.keys(), ...plan.toGet.retires].sort(),
		notice: updateNotice(remote, plan, files, removals, resolution)
	};
}

const pathsWith = (files: readonly PlannedFile[], effect: PlannedFile['effect']): StorePath[] =>
	files
		.filter((file) => file.effect === effect)
		.map((file) => file.path)
		.sort();

function copiedFiles(
	resolution: ConflictResolution,
	localShas: ReadonlyMap<string, string>
): PlannedFile[] {
	return resolution.files.map((file) => ({
		path: file.path as StorePath,
		sha: localShas.get(file.path) ?? '',
		bytes: file.bytes.byteLength,
		effect: file.effect,
		fetched: file.bytes
	}));
}

type VerifiedRead = (path: string, sha: string) => Promise<Bytes>;

async function answerAlignments(
	read: VerifiedRead,
	listed: ReadonlyMap<string, RemoteBlob>,
	localShas: ReadonlyMap<string, string>,
	resolution: ConflictResolution,
	options: GetFromRemoteOptions
): Promise<{ files: PlannedFile[]; settled: string[]; unanswered: string[] }> {
	const files: PlannedFile[] = [];
	const settled: string[] = [];
	const unanswered: string[] = [];
	for (const contested of resolution.alignments) {
		const choice = options.alignmentChoices?.get(contested.path);
		if (choice === undefined) {
			unanswered.push(contested.path);
			continue;
		}
		settled.push(contested.path);
		if (choice === 'keep-mine') continue;
		const blob = listed.get(contested.path);
		if (blob === undefined) continue;
		files.push({
			path: contested.path as StorePath,
			sha: blob.sha,
			bytes: blob.bytes,
			effect: localShas.has(contested.path) ? 'replace' : 'add',
			fetched: await read(contested.path, blob.sha),
			answered: true
		});
	}
	return { files, settled, unanswered };
}

function advancedBaseline(
	previous: SynchronizationBaseline | null,
	plan: WorkspaceSyncPlan,
	settled: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
	const files = new Map(previous?.files ?? []);
	for (const path of plan.toGet.retires) files.delete(path);
	for (const [path, sha] of plan.toGet.advances) files.set(path, sha);
	for (const [path, sha] of settled) files.set(path, sha);
	return files;
}

function assertProspectiveWorkspace(
	remote: RemoteRelationship,
	plan: WorkspaceSyncPlan,
	files: readonly PlannedFile[],
	manifests: ReadonlyMap<string, Bytes>
): void {
	const prospective = new Map(plan.prospective);
	const bySha = new Map(manifests);
	for (const file of files) {
		const sha = file.sha === '' ? `written:${file.path}` : file.sha;
		prospective.set(file.path, sha);
		if (file.fetched !== null) bySha.set(sha, file.fetched);
	}
	assertGettable(remote, validateProspectiveWorkspace(prospective, bySha));
}

async function hashWorkspace(store: ProjectStore): Promise<InventoryEntry[]> {
	let paths: readonly StorePath[];
	try {
		paths = await store.list('');
	} catch (cause) {
		throw new UpdateRefusedError('unreadable', unreadableWorkspaceMessage(cause));
	}
	const inventory: InventoryEntry[] = [];
	for (const path of paths) {
		if (path === UPDATE_TRANSACTION_PATH || path.startsWith(UPDATE_BEFORE_DIRECTORY)) continue;
		const bytes = await readIfPresent(store, path).catch((cause: unknown) => {
			throw new UpdateRefusedError('unreadable', unreadableWorkspaceMessage(cause), {
				paths: [path]
			});
		});
		if (bytes !== null) inventory.push({ path, sha: await gitBlobSha(bytes) });
	}
	return inventory;
}

async function prospectiveManifests(
	store: ProjectStore,
	read: VerifiedRead,
	plan: WorkspaceSyncPlan,
	localShas: ReadonlyMap<string, string>
): Promise<{ byShaOnly: Map<string, Bytes>; byPath: Map<string, Bytes> }> {
	const prospective = new Map(localShas);
	for (const change of plan.toGet.changes) {
		if (change.sha === null) prospective.delete(change.path);
		else prospective.set(change.path, change.sha);
	}

	const byShaOnly = new Map<string, Bytes>();
	const byPath = new Map<string, Bytes>();
	for (const [path, sha] of prospective) {
		if (!isProjectManifest(path)) continue;
		if (localShas.get(path) === sha) {
			const bytes = await store.read(path).catch(() => null);
			if (bytes !== null) byShaOnly.set(sha, bytes);
			continue;
		}
		const bytes = await read(path, sha);
		byShaOnly.set(sha, bytes);
		byPath.set(path, bytes);
	}
	return { byShaOnly, byPath };
}

async function assertRoomToUpdate(
	store: ProjectStore,
	files: readonly PlannedFile[],
	removals: readonly StorePath[],
	estimateStorage: EstimateStorage | undefined
): Promise<void> {
	const room = await storageRoom(estimateStorage);
	if (room === null) return;
	let needed = 0;
	for (const file of files) {
		needed += file.bytes;
		if (file.effect === 'replace') needed += await store.size(file.path).catch(() => 0);
	}
	for (const path of removals) needed += await store.size(path).catch(() => 0);
	const { free } = room;
	if (free >= needed) return;

	throw new UpdateRefusedError(
		'insufficient-quota',
		`This get needs about ${describeBytes(needed)} — the files coming from GitHub, and a copy ` +
			`of each file it replaces or removes so it can be undone — and there is ${describeBytes(
				Math.max(0, free)
			)} free. Nothing has been changed. Delete a Workspace you no longer need, or free space on ` +
			`this device, and try again.`
	);
}

async function transfer(
	store: ProjectStore,
	read: VerifiedRead,
	files: readonly PlannedFile[],
	removals: readonly StorePath[],
	commit: string,
	options: GetFromRemoteOptions
): Promise<number> {
	const planned = {
		transaction: options.transaction?.() ?? crypto.randomUUID(),
		workspace: options.workspace ?? '',
		commit,
		added: pathsWith(files, 'add'),
		replaced: files.filter((file) => file.effect === 'replace').map((file) => file.path),
		deleted: removals,
		startedAt: (options.now?.() ?? new Date()).toISOString()
	};
	const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
	let written = 0;
	let bytes = 0;
	const report = (path: string | null): void =>
		options.onProgress?.({ files: written, totalFiles: files.length, bytes, totalBytes, path });

	report(null);
	await writeUpdate(store, planned, async () => {
		await eachInTurn(files, UPDATE_DOWNLOAD_CONCURRENCY, async (file) => {
			const content = file.fetched ?? (await read(file.path, file.sha));
			await writeInbound(
				store,
				file.path,
				content,
				file.answered === true ? 'answered' : file.effect
			);
			written += 1;
			bytes += content.byteLength;
			report(file.path);
		});
		report(null);
	});
	return bytes;
}

function asUpdateRefusal(
	remote: RemoteRelationship,
	token: string | null,
	cause: unknown
): UpdateRefusedError {
	const named = describeRemote(remote);
	if (!(cause instanceof RemoteTreeRefusedError)) {
		return new UpdateRefusedError('refused', unreachableMessage(remote, cause));
	}
	switch (cause.refusal) {
		case 'no-repository':
			return new UpdateRefusedError(
				'no-repository',
				token === null
					? `Getting reads GitHub without signing in, and from there ${named} could not be read ` +
							`at all — which is what both a private repository and a missing one look like. If it ` +
							`is private, sign in to GitHub and get again: a private repository can only be read ` +
							`by somebody it has been shared with. Otherwise check the address. Nothing in this ` +
							`Workspace has been changed — your work is all still here.`
					: `GitHub has no repository at ${named} that this sign-in can see, so there is nothing ` +
							`to get. Nothing in this Workspace has been changed — your work is all still here.`
			);
		case 'not-public':
			return new UpdateRefusedError(
				'no-repository',
				token === null
					? `GitHub would not let this page read ${named} without signing in. Sign in to GitHub ` +
							`and get again. Nothing has been changed.`
					: `GitHub would not let this sign-in read ${named}. Sign in again, or ask whoever owns ` +
							`${named} for access to it. Nothing has been changed.`
			);
		case 'rate-limited': {
			const at = describeReset(cause.resetAt);
			return new UpdateRefusedError(
				'rate-limited',
				token === null
					? `GitHub's hourly limit for anonymous readers has been used up, so ${named} could not ` +
							`be read. Nothing is wrong with it: getting without signing in allows 60 requests an ` +
							`hour for each internet connection, so on a shared one — a university network, a ` +
							`classroom — everybody's reading counts together. Signing in to GitHub raises the ` +
							`limit. ` +
							`${at === '' ? 'Or wait until it resets and try again' : `Or try again after ${at}`}. ` +
							`Nothing has been changed.`
					: `GitHub's hourly request limit is used up, so ${named} could not be read. ` +
							`${at === '' ? 'Wait until the limit resets and try again' : `Try again after ${at}`}. ` +
							`Nothing has been changed.`
			);
		}
		case 'empty':
			return new UpdateRefusedError(
				'empty',
				`${named} has nothing in it — no files, no branches, nothing to bring down. Nothing has ` +
					`been changed.`
			);
		case 'truncated':
			return new UpdateRefusedError(
				'truncated',
				`GitHub could only list the first ${cause.listed} files in ${named}, so Ballastella ` +
					`cannot know what the rest of them are. Updating from a partial list would take some ` +
					`of somebody's work and silently treat the rest as deleted, so nothing has been ` +
					`changed. That repository has to hold fewer files before it can be updated from.`
			);
		case 'unreachable':
			return new UpdateRefusedError('refused', unreachableMessage(remote, cause.detail));
		case 'refused':
			return new UpdateRefusedError(
				'refused',
				`GitHub refused to read ${named}: ${cause.detail}. Nothing has been changed.`
			);
	}
}

function assertGettable(remote: RemoteRelationship, graph: GraphVerdict): void {
	const named = describeRemote(remote);
	if (graph.outcome === 'failed') {
		const unsupported = graph.failures.find((failure) => failure.kind === 'unsupported');
		throw new UpdateRefusedError(
			unsupported ? 'unsupported' : 'invalid',
			unsupported
				? `${unsupported.path} on ${named} was written by a newer version of Ballastella than ` +
						`this one, so this browser cannot tell whether the result would be complete. Update ` +
						`Ballastella and try again; updating with this version could silently drop work its ` +
						`author can see. Nothing has been changed.`
				: `What ${named} holds could not be checked over: ${describeGraphFailure(graph.failures)} ` +
						`Nothing has been changed, because a result this app cannot check is one it cannot ` +
						`promise to open.`,
			{ paths: graph.failures.map((failure) => failure.path).sort() }
		);
	}
	if (graph.outcome === 'invalid') {
		throw new UpdateRefusedError('invalid', describeGraphViolations(graph.violations), {
			paths: graph.violations.map((violation) => violation.path).sort()
		});
	}
}

const missingFileMessage = (remote: RemoteRelationship, path: string, cause: unknown): string =>
	`${describeRemote(remote)} listed ${path}, but it could not be downloaded: ${messageOf(cause)}. The ` +
	`get has stopped rather than leave this Workspace holding half of somebody's changes, and ` +
	`everything it had already written has been put back exactly as it was.`;

const corruptFileMessage = (remote: RemoteRelationship, path: string): string =>
	`${path} arrived from ${describeRemote(remote)} as different bytes from the ones its file list ` +
	`named, so the get has stopped rather than keep a file it cannot vouch for. Something ` +
	`between this browser and GitHub — a proxy, or a cache — served a rewritten copy. Everything ` +
	`this get had already written has been put back, and trying again fetches that file afresh.`;

const unreadableWorkspaceMessage = (cause: unknown): string =>
	`Getting from GitHub reads every file in this Workspace first, so that a change made outside ` +
	`Ballastella is never mistaken for one of GitHub's — and this Workspace could not be read: ` +
	`${messageOf(cause)}. Nothing has been changed.`;

const unreachableMessage = (remote: RemoteRelationship, cause: unknown): string =>
	`GitHub could not be reached, so ${describeRemote(remote)} could not be read. The browser ` +
	`reported: ${messageOf(cause)}. This is about the connection rather than about that repository, and ` +
	`everything in this Workspace is exactly as it was.`;

function updateNotice(
	remote: RemoteRelationship,
	plan: WorkspaceSyncPlan,
	files: readonly PlannedFile[],
	removals: readonly StorePath[],
	resolution: ConflictResolution
): string {
	const named = describeRemote(remote);
	const copied = describeConflictCopies(resolution.copies);
	if (files.length === 0 && removals.length === 0) {
		return (
			`${named} holds nothing this Workspace does not already have, so nothing has been ` +
			`downloaded.` +
			(plan.retained.length === 0
				? ''
				: ` Your own ${count(plan.retained.length, 'unsent change')} ` +
					`${plan.retained.length === 1 ? 'is' : 'are'} still here to send.`) +
			copied
		);
	}
	const retained =
		plan.retained.length === 0
			? ''
			: ` Your own ${count(plan.retained.length, 'unsent change')} ` +
				`${plan.retained.length === 1 ? 'was' : 'were'} left untouched and ` +
				`${plan.retained.length === 1 ? 'is' : 'are'} still there to send.`;
	if (files.length === 0) {
		return (
			`Removed ${count(removals.length, 'file')} from this Workspace, which ${named} no longer ` +
			`has. Nothing has been sent: ${named} is exactly as it was.${retained}${copied}`
		);
	}
	const added = files.filter((file) => file.effect === 'add').length;
	const replaced = files.length - added;
	const brought = [
		added === 0 ? '' : count(added, 'new file'),
		replaced === 0 ? '' : count(replaced, 'changed file')
	]
		.filter((part) => part !== '')
		.join(' and ');
	const took =
		removals.length === 0 ? '' : ` Removed ${count(removals.length, 'file')} GitHub no longer has.`;
	return (
		`Brought ${brought} into this Workspace from ${named}.${took} Nothing has been sent: ` +
		`${named} is exactly as it was.${retained}${copied}`
	);
}

function describeConflictCopies(copies: readonly ConflictCopy[]): string {
	if (copies.length === 0) return '';
	const named = copies
		.map((copy) =>
			copy.kind === 'layer' ? `the Layer “${copy.name}”` : `the Project “${copy.name}”`
		)
		.join(', ');
	return (
		` ${copies.length === 1 ? 'One thing had' : `${copies.length} things had`} been changed here ` +
		`and on GitHub since the two last agreed, so GitHub's version of ` +
		`${copies.length === 1 ? 'it' : 'each'} is now here as well: ${named}. Nothing has been ` +
		`combined — look at both and delete the one you do not want.`
	);
}
