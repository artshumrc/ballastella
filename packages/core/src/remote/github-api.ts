import type { FetchFn } from '../injection/store-image-fetch.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import type { RemoteReference } from './remote-binding.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';

function headerNumber(headers: Headers, name: string): number | null {
	const raw = headers.get(name);
	if (raw === null || raw.trim() === '') return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

export type RateLimit = {
	readonly remaining: number | null;
	readonly resetAt: Date | null;
};

// Readable only because api.github.com lists both headers in access-control-expose-headers.
export function rateLimitOf(headers: Headers): RateLimit {
	const reset = headerNumber(headers, 'X-RateLimit-Reset');
	return {
		remaining: headerNumber(headers, 'X-RateLimit-Remaining'),
		resetAt: reset !== null && reset > 0 ? new Date(reset * 1000) : null
	};
}

export const describeReset = (resetAt: Date | null): string =>
	resetAt === null
		? ''
		: resetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

export const urlPath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

export const repoApiUrl = (remote: RemoteReference): string =>
	`${GITHUB_API_ORIGIN}/repos/${urlPath(remote.owner)}/${urlPath(remote.repository)}`;

const rawUrl = (remote: RemoteReference, ref: string, path: string): string =>
	`${GITHUB_RAW_ORIGIN}/${urlPath(remote.owner)}/${urlPath(remote.repository)}/` +
	`${urlPath(ref)}/${urlPath(path)}`;

export function authorisedFetch(
	fetchFn: FetchFn | undefined,
	token: string | null,
	headers: Record<string, string> = {}
): FetchFn {
	const request = fetchFn ?? ((input, init) => fetch(input, init));
	return (input, init = {}) =>
		request(input, {
			...init,
			headers: {
				...headers,
				...(token === null ? {} : { Authorization: `Bearer ${token}` }),
				...(init.headers as Record<string, string> | undefined)
			}
		});
}

export const githubFetch = (fetchFn: FetchFn | undefined, token: string | null): FetchFn =>
	authorisedFetch(fetchFn, token, { Accept: 'application/vnd.github+json' });

export async function problemOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body?.message === 'string' ? body.message : response.statusText;
	} catch {
		return response.statusText;
	}
}

type TreeEntry = {
	readonly path: string;
	readonly sha: string;
	readonly type: unknown;
	readonly mode: string | null;
	readonly size: number;
};

export function parseTree(body: unknown): { entries: TreeEntry[]; truncated: boolean } {
	const { tree, truncated } = (body ?? {}) as { tree?: unknown; truncated?: unknown };
	const listed = (Array.isArray(tree) ? tree : []) as readonly Record<string, unknown>[];
	return {
		entries: listed.flatMap(({ path, sha, type, mode, size }) =>
			typeof path === 'string' && typeof sha === 'string'
				? [
						{
							path,
							sha,
							type,
							mode: typeof mode === 'string' ? mode : null,
							size: typeof size === 'number' ? size : 0
						}
					]
				: []
		),
		truncated: truncated === true
	};
}

export function rawReader(
	remote: RemoteReference,
	ref: string,
	fetchFn: FetchFn | undefined
): (path: string) => Promise<Bytes> {
	const source = createHttpProjectStore({
		resolve: (path) => rawUrl(remote, ref, path),
		...(fetchFn === undefined ? {} : { fetch: fetchFn })
	});
	return (path) => source.read(path as StorePath);
}

export function verifiedReader(
	remote: RemoteReference,
	ref: string,
	fetchFn: FetchFn | undefined,
	refuse: { missing(path: string, cause: unknown): Error; corrupt(path: string): Error }
): (path: string, sha: string) => Promise<Bytes> {
	const read = rawReader(remote, ref, fetchFn);
	return async (path, sha) => {
		const content = await read(path).catch((cause: unknown) => {
			throw refuse.missing(path, cause);
		});
		if ((await gitBlobSha(content)) !== sha) throw refuse.corrupt(path);
		return content;
	};
}
