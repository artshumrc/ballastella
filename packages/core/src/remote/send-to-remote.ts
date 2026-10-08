import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	workspaceSize,
	type WorkspaceSize
} from '../project/workspace-size.js';
import { encodeBase64, type Bytes, type ProjectStore } from '../store/project-store.js';
import { JEKYLL_OFF_MARKER, carriesPublishedSite } from '../transfer/viewer-files.js';
import { gitBlobSha } from './blob-sha.js';
import {
	describeReset,
	githubFetch,
	parseTree,
	problemOf,
	rateLimitOf,
	repoApiUrl,
	urlPath
} from './github-api.js';
import { describeRemote, type RemoteRepository } from './remote-binding.js';
import { byPath, isOwnedPath, recognisedProjectDirectories } from './synchronization-paths.js';
import { planWorkspaceSync } from './synchronization-planner.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import type { PathChoice, SourcePath } from './synchronization-planner.js';

export const MAX_SENT_FILES = 40_000;

type RemoteTreeEntry = {
	readonly path: string;
	readonly sha: string;
	readonly mode: string;
	readonly bytes: number;
};

type PlannedRemoteFile = {
	readonly path: string;
	readonly sha: string;
	readonly bytes: number;
	readonly onRemote: boolean;
	readonly authored: boolean;
};

type RemoteSendWarning = {
	readonly kind: 'hosting-limit' | 'request-budget';
	readonly message: string;
};

export type PendingLocalFile = {
	readonly path: string;
	readonly bytes: number;
};

export type RemoteSendPlan = {
	readonly head: string | null;
	readonly files: readonly PlannedRemoteFile[];
	readonly pending: readonly PendingLocalFile[];
	readonly preserved: readonly RemoteTreeEntry[];
	readonly source: ReadonlyMap<string, string>;
	readonly removed: readonly string[];
	readonly retained: readonly RemoteTreeEntry[];
	readonly leftAlone: readonly string[];
	readonly incoming: readonly PathChoice[];
	readonly outgoing: readonly PathChoice[];
	readonly conflicts: readonly SourcePath[];
	readonly overwrites: readonly string[];
	readonly overwriteSource: ReadonlyMap<string, string>;
	readonly unchanged: boolean;
	readonly shareLinks: boolean;
	readonly uploads: number;
	readonly uploadBytes: number;
	readonly workspace: WorkspaceSize;
	readonly bytes: number;
	readonly requestsRemaining: number | null;
	readonly requestsResetAt: Date | null;
	readonly warnings: readonly RemoteSendWarning[];
};

export class RemoteSendRefusedError extends Error {
	override readonly name = 'RemoteSendRefusedError';
}

export class RemoteSendFailedError extends Error {
	override readonly name: string = 'RemoteSendFailedError';
}

export class RemoteSendCredentialError extends RemoteSendFailedError {
	override readonly name = 'RemoteSendCredentialError';
}

type RemoteSendPhase = 'blobs' | 'tree' | 'commit' | 'ref';

export class RemoteSendRateLimitedError extends RemoteSendFailedError {
	override readonly name = 'RemoteSendRateLimitedError';
	constructor(
		readonly phase: RemoteSendPhase,
		readonly filesSent: number,
		readonly totalFiles: number,
		readonly resetAt: Date | null
	) {
		super(rateLimitMessage(phase, filesSent, totalFiles, resetAt));
	}
}

type RemoteSendOptions = {
	readonly token: string;
	readonly remote: RemoteRepository;
	readonly fetch?: FetchFn;
};

type PlanRemoteSendOptions = Omit<RemoteSendOptions, 'token'> & {
	readonly token: string | null;
	readonly pending?: readonly PendingLocalFile[];
	readonly baseline?: SynchronizationBaseline | null;
	readonly sending?: boolean;
};

export type SendToRemoteOptions = RemoteSendOptions & {
	readonly plan: RemoteSendPlan;
	readonly overwrite?: boolean | readonly string[];
	readonly onProgress?: (seen: {
		readonly files: number;
		readonly totalFiles: number;
		readonly requestsRemaining: number | null;
	}) => void;
};

const BLOB_MODE = '100644';
const GITLINK_MODE = '160000';
export const REQUESTS_BEYOND_BLOBS = 3;
const EMPTY_FILE: Bytes = new Uint8Array(0);
const COMMIT_MESSAGE = 'Sync from Ballastella';

type Budget = { remaining: number | null; resetAt: Date | null };

type RemoteApi = {
	readonly budget: Budget;
	readonly remote: RemoteRepository;
	call(path: string, init?: RequestInit): Promise<Response>;
};

function createRemoteApi(options: PlanRemoteSendOptions, budget: Budget): RemoteApi {
	const request = githubFetch(options.fetch, options.token);
	const base = repoApiUrl(options.remote);

	return {
		budget,
		remote: options.remote,
		async call(path, init) {
			const response = await request(`${base}${path}`, init);
			const said = rateLimitOf(response.headers);
			if (said.remaining !== null) budget.remaining = said.remaining;
			if (said.resetAt !== null) budget.resetAt = said.resetAt;
			return response;
		}
	};
}

async function failureFrom(
	response: Response,
	api: RemoteApi,
	phase: RemoteSendPhase,
	sent: number,
	total: number
): Promise<RemoteSendFailedError> {
	if (response.status === 401) {
		return new RemoteSendCredentialError(expiredCredentialMessage(api.remote, phase, sent, total));
	}
	if (response.status === 403 && api.budget.remaining === 0) {
		return new RemoteSendRateLimitedError(phase, sent, total, api.budget.resetAt);
	}
	return new RemoteSendFailedError(
		`GitHub refused this send: ${await problemOf(response)}. ` +
			`${describeProgress(phase, sent, total)}. Nothing on your Published Site has changed — a ` +
			`send is only visible once all of it has arrived.`
	);
}

async function shaOf(response: Response): Promise<string> {
	const body = (await response.json()) as { sha?: unknown };
	if (typeof body.sha !== 'string') {
		throw new RemoteSendFailedError(
			'GitHub accepted an object without naming it, so this send cannot be completed. ' +
				'Nothing on your Published Site has changed.'
		);
	}
	return body.sha;
}

async function assertPushable(
	api: RemoteApi,
	remote: RemoteRepository,
	sending: boolean
): Promise<void> {
	const response = await api.call('');
	if (response.status === 404) throw new RemoteSendRefusedError(noRepositoryMessage(remote));
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);
	if (!sending) return;
	const body = (await response.json().catch(() => ({}))) as { permissions?: { push?: unknown } };
	if (body.permissions?.push !== true) throw new RemoteSendRefusedError(readOnlyMessage(remote));
}

async function readHead(api: RemoteApi, remote: RemoteRepository): Promise<string | null> {
	const response = await api.call(`/git/ref/heads/${urlPath(remote.branch)}`);
	if (response.status === 409 || response.status === 404) return null;
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);
	const body = (await response.json()) as { object?: { sha?: unknown } };
	const sha = body.object?.sha;
	return typeof sha === 'string' ? sha : null;
}

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
			content: '',
			branch: remote.branch
		})
	});
	if (!response.ok) throw await failureFrom(response, api, 'blobs', sent, total());
	const body = (await response.json()) as { commit?: { sha?: unknown } };
	const sha = body.commit?.sha;
	if (typeof sha !== 'string' || sha === '') {
		throw new RemoteSendRefusedError(
			`GitHub opened ${describeRemote(remote)} but did not say which commit it made, ` +
				`so this send has nothing to build on. Try sending again.`
		);
	}
	return sha;
}

async function readRemoteTree(
	api: RemoteApi,
	remote: RemoteRepository,
	commit: string
): Promise<RemoteTreeEntry[]> {
	const response = await api.call(`/git/trees/${commit}?recursive=1`);
	if (!response.ok) throw await failureFrom(response, api, 'blobs', 0, 0);

	const { entries, truncated } = parseTree(await response.json());
	if (truncated) {
		const files = entries.filter((entry) => entry.type === 'blob').length;
		throw new RemoteSendRefusedError(truncatedMessage(files, remote));
	}

	return entries
		.filter((entry) => entry.type === 'blob' || entry.type === 'commit')
		.map((entry) => ({
			path: entry.path,
			sha: entry.sha,
			mode: entry.mode ?? (entry.type === 'commit' ? GITLINK_MODE : BLOB_MODE),
			bytes: entry.size
		}));
}

// By SHA, not path: identical bytes at two paths (blank tiles, empty files) are one blob.
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

export async function planRemoteSend(
	store: ProjectStore,
	options: PlanRemoteSendOptions
): Promise<RemoteSendPlan> {
	const api = createRemoteApi(options, { remaining: null, resetAt: null });
	const workspace = await workspaceSize(store);
	if (workspace.files > MAX_SENT_FILES) {
		throw new RemoteSendRefusedError(tooManyFilesMessage(workspace.files));
	}

	await assertPushable(api, options.remote, options.sending !== false);

	const head = await readHead(api, options.remote);
	const remote = head === null ? [] : await readRemoteTree(api, options.remote, head);
	const onRemote = new Set(remote.map((entry) => entry.sha));
	const paths = await store.list('');
	const held = new Set<string>(paths);

	const projects = recognisedProjectDirectories({
		local: paths,
		remote: remote.map((entry) => entry.path),
		baseline: options.baseline?.files.keys() ?? []
	});

	const shareLinks =
		carriesPublishedSite(paths) ||
		carriesPublishedSite((options.pending ?? []).map((file) => file.path)) ||
		carriesPublishedSite(remote.map((entry) => entry.path));
	const owned = (path: string): boolean => isOwnedPath(path, projects, shareLinks);
	const marker = shareLinks && !held.has(JEKYLL_OFF_MARKER) ? [JEKYLL_OFF_MARKER] : [];
	const files: PlannedRemoteFile[] = [];
	for (const path of [...paths.filter(owned), ...marker]) {
		const authored = !held.has(path);
		const bytes = authored ? EMPTY_FILE : await store.read(path);
		const sha = await gitBlobSha(bytes);
		files.push({ path, sha, bytes: bytes.byteLength, onRemote: onRemote.has(sha), authored });
	}
	files.sort(byPath);

	const settled = planWorkspaceSync({
		local: files.map((file) => ({ path: file.path, sha: file.sha })),
		remote: remote.map((entry) => ({ path: entry.path, sha: entry.sha })),
		baseline: options.baseline ?? null
	});

	const listed = new Map(remote.map((entry) => [entry.path, entry] as const));
	const retained = settled.leftAlone.flatMap((path) => {
		const entry = listed.get(path);
		return entry === undefined ? [] : [entry];
	});

	const leftAlone = new Set(settled.leftAlone);
	const planned = new Set(files.map((file) => file.path));
	const pending = (options.pending ?? []).filter((file) => !planned.has(file.path));
	const pendingBytes = pending.reduce((sum, file) => sum + file.bytes, 0);
	const preserved = remote.filter((entry) => !owned(entry.path) && !planned.has(entry.path));
	const preservedBytes = preserved.reduce((sum, entry) => sum + entry.bytes, 0);
	const uploaded = blobsToUpload(files);
	const uploads = uploaded.length + pending.length;
	const uploadBytes = uploaded.reduce((sum, file) => sum + file.bytes, pendingBytes);
	const warnings: RemoteSendWarning[] = [];
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

	const wouldWrite = new Map<string, string>([
		...preserved.map((entry) => [entry.path, entry.sha] as const),
		...retained.map((entry) => [entry.path, entry.sha] as const),
		...files
			.filter((file) => !leftAlone.has(file.path))
			.map((file) => [file.path, file.sha] as const)
	]);
	const unchanged =
		head !== null &&
		pending.length === 0 &&
		remote.length === wouldWrite.size &&
		remote.every((entry) => wouldWrite.get(entry.path) === entry.sha);

	return {
		head,
		files,
		pending,
		preserved,
		retained,
		leftAlone: settled.leftAlone,
		incoming: settled.toGet.changes,
		outgoing: settled.toSend.changes,
		conflicts: settled.conflicts,
		unchanged,
		shareLinks,
		source: settled.toSend.advances,
		removed: settled.toSend.removed,
		overwrites: settled.toOverwrite.removed,
		overwriteSource: settled.toOverwrite.advances,
		uploads,
		uploadBytes,
		workspace,
		bytes: workspace.bytes + preservedBytes + pendingBytes,
		requestsRemaining: api.budget.remaining,
		requestsResetAt: api.budget.resetAt,
		warnings
	};
}

export async function sendToRemote(
	store: ProjectStore,
	options: SendToRemoteOptions
): Promise<{
	readonly commit: string;
	readonly baseline: ReadonlyMap<string, string>;
	readonly shared: readonly string[];
}> {
	const { plan, remote } = options;
	const overwriting = options.overwrite !== undefined && options.overwrite !== false;
	if (overwriting && options.overwrite !== true) {
		const consented = new Set(options.overwrite);
		const unseen = plan.overwrites.filter((path) => !consented.has(path));
		if (unseen.length > 0) {
			throw new RemoteSendRefusedError(movedSinceAgreedMessage(remote, unseen));
		}
	}
	const removed = overwriting ? plan.overwrites : plan.removed;
	const leftAlone = new Set(plan.leftAlone);
	const sending = overwriting ? plan.files : plan.files.filter((file) => !leftAlone.has(file.path));
	const api = createRemoteApi(options, {
		remaining: plan.requestsRemaining,
		resetAt: plan.requestsResetAt
	});

	const held = new Set([
		...sending.filter((file) => file.onRemote).map((file) => file.sha),
		...plan.preserved.map((entry) => entry.sha),
		...plan.retained.map((entry) => entry.sha)
	]);
	const forecast = blobsToUpload(sending).length;
	let sent = 0;
	const total = () => Math.max(forecast, sent);
	const report = () =>
		options.onProgress?.({
			files: sent,
			totalFiles: total(),
			requestsRemaining: api.budget.remaining
		});

	const head = plan.head === null ? await seedEmptyRepository(api, remote, sent, total) : plan.head;
	report();
	const written: RemoteTreeEntry[] = [];
	for (const file of sending) {
		const bytes = file.authored ? EMPTY_FILE : await store.read(file.path);
		const computed = await gitBlobSha(bytes);
		let sha = computed;
		if (!held.has(computed)) {
			const response = await api.call('/git/blobs', {
				method: 'POST',
				body: JSON.stringify({ content: encodeBase64(bytes), encoding: 'base64' })
			});
			if (!response.ok) throw await failureFrom(response, api, 'blobs', sent, total());
			sha = await shaOf(response);
			held.add(computed);
			held.add(sha);
			sent += 1;
			report();
		}
		written.push({ path: file.path, sha, mode: BLOB_MODE, bytes: bytes.byteLength });
	}

	const tree = await api.call('/git/trees', {
		method: 'POST',
		body: JSON.stringify({
			tree: [...plan.preserved, ...(overwriting ? [] : plan.retained), ...written].map((entry) => ({
				path: entry.path,
				mode: entry.mode,
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
			// An orphan here would be a force push over their work.
			parents: [head]
		})
	});
	if (!commit.ok) throw await failureFrom(commit, api, 'commit', sent, total());
	const commitSha = await shaOf(commit);

	const moved = await api.call(`/git/refs/heads/${urlPath(remote.branch)}`, {
		method: 'PATCH',
		body: JSON.stringify({ sha: commitSha, force: false })
	});
	if (!moved.ok) throw await failureFrom(moved, api, 'ref', sent, total());
	const recording = overwriting ? plan.overwriteSource : plan.source;
	const baseline = new Map(
		written.filter((entry) => recording.has(entry.path)).map((entry) => [entry.path, entry.sha])
	);
	return {
		commit: commitSha,
		baseline,
		shared: [...baseline.keys(), ...removed].sort()
	};
}

const truncatedMessage = (listed: number, remote: RemoteRepository): string =>
	`GitHub could only list the first ${listed} files in ${describeRemote(remote)}, so ` +
	`it cannot say which of your files are already there. Sending anyway would send everything ` +
	`again and then leave a site with most of a Map Image silently missing, so nothing has ` +
	`been sent. This repository has to hold fewer files before it can be sent to: deleting ` +
	`Map Images no Project uses is usually where the count is.`;

const NAMED_PATHS = 6;

function describePaths(paths: readonly string[]): string {
	const named = paths.slice(0, NAMED_PATHS).join(', ');
	const rest = paths.length - NAMED_PATHS;
	return rest > 0 ? `${named}, and ${rest} more` : named;
}

function readOnlyMessage(remote: RemoteRepository): string {
	const where = describeRemote(remote);
	return (
		`The GitHub account you are signed in with can read ${where} but cannot push to it, so this ` +
		`send would stop part way through and nothing has been sent. Sign in again with a ` +
		`fine-grained personal access token that has “Contents: Read and write” for ${where}, or ask ` +
		`whoever owns it for write access. Getting a repository's changes needs no write access at ` +
		`all, so bringing its work into this Workspace still works.`
	);
}

function movedSinceAgreedMessage(remote: RemoteRepository, unseen: readonly string[]): string {
	const where = describeRemote(remote);
	const count = unseen.length;
	return (
		`${where} changed while this send was being prepared, so it has stopped rather than replace ` +
		`something you were never shown. You agreed to replace what was on it a moment ago; since ` +
		`then ${count === 1 ? 'another file has' : `${count} more files have`} arrived that ` +
		`${count === 1 ? 'was' : 'were'} not part of that: ${describePaths(unseen)}. Nothing has been ` +
		`sent and your Published Site is exactly as it was. Send again to see what is there now — ` +
		`the same two ways on will be offered, about the files that are actually at stake.`
	);
}

const tooManyFilesMessage = (files: number): string =>
	`This Workspace holds ${files} files, and ${MAX_SENT_FILES} is the most that can be ` +
	`sent to GitHub in one go — past that, GitHub stops listing a repository's files and a ` +
	`send can no longer tell what is already there. Nothing has been sent. A Map Image's ` +
	`tiles are almost always what the count is: deleting one no Project uses, or referencing a ` +
	`very large sheet from its library rather than copying it, is the way down.`;

const hostingLimitMessage = (bytes: number): string =>
	`Your Published Site would hold ${describeBytes(bytes)}, past the ` +
	`${describeBytes(STATIC_HOSTING_LIMIT_BYTES)} GitHub Pages will serve. This is a cliff ` +
	`rather than a slowdown: the push may well fail outright. Offline Base Map tiles are usually ` +
	`what the bytes are — they are about 152 kB each — and Map Images no Project uses are the ` +
	`other place to look.`;

const noRepositoryMessage = (remote: RemoteRepository): string =>
	`GitHub has no repository at ${describeRemote(remote)}, or none this sign-in can ` +
	`see, so there is nothing to send to and nothing has been sent. Check the owner and the ` +
	`repository name, and that the account you signed in with still has access to it — a private ` +
	`repository looks exactly like a missing one to somebody who cannot open it.`;

const expiredCredentialMessage = (
	remote: RemoteRepository,
	phase: RemoteSendPhase,
	sent: number,
	total: number
): string =>
	`Your GitHub sign-in has expired, so this send stopped and your Published Site is exactly ` +
	`as it was. ${describeProgress(phase, sent, total)}. A token that has been revoked, or that has ` +
	`had ${describeRemote(remote)} taken off it, looks exactly like an expired one from ` +
	`here. Sign in again with a fine-grained personal access token that has “Contents: Read and ` +
	`write” for that repository, and send again.`;

const PHASE_WORK: Record<Exclude<RemoteSendPhase, 'blobs'>, string> = {
	tree: 'building the tree it would commit',
	commit: 'writing the commit',
	ref: 'moving the branch to the new commit'
};

function describeProgress(phase: RemoteSendPhase, sent: number, total: number): string {
	if (phase === 'blobs') {
		return sent === 0 ? 'Nothing had been sent' : `${sent} of ${total} files had been sent`;
	}
	const files =
		total === 0 ? 'There were no new files to send' : `All ${total} files had been sent`;
	return `${files}, and the send was ${PHASE_WORK[phase]}`;
}

const untilReset = (resetAt: Date | null): string => {
	const at = describeReset(resetAt);
	return at === '' ? 'once the budget resets' : `after ${at}, when the budget resets,`;
};

function requestBudgetMessage(uploads: number, remaining: number, resetAt: Date | null): string {
	const total = uploads + REQUESTS_BEYOND_BLOBS;
	return (
		`Sending sends ${uploads} new files and then writes the commit holding them, ${total} ` +
		`requests in all, and GitHub allows ${remaining} more requests this hour. It will stop part ` +
		`way through, and nothing will have been sent when it does: your Published Site stays ` +
		`exactly as it is until the whole of a send has arrived. Sending again ` +
		`${untilReset(resetAt)} starts the ` +
		`upload again from the beginning.`
	);
}

function rateLimitMessage(
	phase: RemoteSendPhase,
	filesSent: number,
	totalFiles: number,
	resetAt: Date | null
): string {
	return (
		`GitHub's hourly request budget ran out. ${describeProgress(phase, filesSent, totalFiles)}. ` +
		`Nothing has been sent: the branch has not moved and your Published Site is exactly as it ` +
		`was. Sending again ` +
		`${untilReset(resetAt)} starts the ` +
		`upload again from the beginning.`
	);
}
