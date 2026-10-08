import type { FetchFn } from '../injection/store-image-fetch.js';
import { messageOf } from '../store/project-store.js';
import type { RemoteRepository } from './remote-binding.js';
import {
	githubFetch,
	parseTree,
	problemOf,
	rateLimitOf,
	repoApiUrl,
	urlPath
} from './github-api.js';

export type RemoteBlob = {
	readonly path: string;
	readonly sha: string;
	readonly bytes: number;
};

type RemoteTreeRefusal =
	| 'no-repository'
	| 'not-public'
	| 'rate-limited'
	| 'empty'
	| 'truncated'
	| 'unreachable'
	| 'refused';

export class RemoteTreeRefusedError extends Error {
	override readonly name = 'RemoteTreeRefusedError';
	constructor(
		readonly refusal: RemoteTreeRefusal,
		readonly detail = '',
		readonly listed = 0,
		readonly resetAt: Date | null = null
	) {
		super(`The file list could not be read: ${refusal}.`);
	}
}

async function githubGet(
	fetchFn: FetchFn | undefined,
	url: string,
	token: string | null
): Promise<Response> {
	const response = await githubFetch(
		fetchFn,
		token
	)(url).catch((cause: unknown) => {
		throw new RemoteTreeRefusedError('unreachable', messageOf(cause));
	});

	if (response.status === 409) throw new RemoteTreeRefusedError('empty');
	if (response.status === 404) throw new RemoteTreeRefusedError('no-repository');
	const budget = rateLimitOf(response.headers);
	if (response.status === 403 && budget.remaining === 0) {
		throw new RemoteTreeRefusedError('rate-limited', '', 0, budget.resetAt);
	}
	if (response.status === 401 || response.status === 403) {
		throw new RemoteTreeRefusedError('not-public');
	}
	if (!response.ok) throw new RemoteTreeRefusedError('refused', await problemOf(response));
	return response;
}

export async function readRemoteHeadCommit(
	remote: RemoteRepository,
	fetchFn: FetchFn | undefined,
	token: string | null = null
): Promise<string> {
	const url = `${repoApiUrl(remote)}/git/ref/heads/${urlPath(remote.branch)}`;
	const response = await githubGet(fetchFn, url, token);
	const body = (await response.json().catch(() => ({}))) as { object?: { sha?: unknown } };
	const sha = body.object?.sha;
	if (typeof sha !== 'string' || sha === '') {
		throw new RemoteTreeRefusedError('refused', 'the branch reported no commit');
	}
	return sha;
}

// Never throws: the date only sits beside a question, so any failure is just no date.
export async function readRemoteCommitDate(
	remote: RemoteRepository,
	commit: string,
	fetchFn: FetchFn | undefined
): Promise<Date | null> {
	try {
		const response = await githubGet(
			fetchFn,
			`${repoApiUrl(remote)}/git/commits/${urlPath(commit)}`,
			null
		);
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

export async function readRemoteTree(
	remote: RemoteRepository,
	fetchFn: FetchFn | undefined,
	token: string | null = null
): Promise<RemoteBlob[]> {
	const url = `${repoApiUrl(remote)}/git/trees/${encodeURIComponent(remote.branch)}?recursive=1`;
	const response = await githubGet(fetchFn, url, token);
	const { entries, truncated } = parseTree(await response.json().catch(() => ({})));
	const blobs = entries
		.filter((entry) => entry.type === 'blob')
		.map(({ path, sha, size }) => ({ path, sha, bytes: size }));
	if (truncated) throw new RemoteTreeRefusedError('truncated', '', blobs.length);
	return blobs;
}
