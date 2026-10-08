import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { rejection } from '../test-support.js';
import { createFakeGitHub } from './fake-github.js';
import { urlPath } from './github-api.js';
import { ATLAS as REMOTE } from './remote-test-support.js';
import { RemoteTreeRefusedError, readRemoteHeadCommit, readRemoteTree } from './remote-tree.js';

const holding = (tree: Record<string, string>) => createFakeGitHub({ ...REMOTE, tree });

function answering(response: () => Response) {
	const asked: { url: string; init: RequestInit | undefined }[] = [];
	const fetch: FetchFn = (input, init) => {
		asked.push({ url: String(input), init });
		return Promise.resolve(response());
	};
	return { fetch, asked };
}

const jsonResponse = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {}
): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});

const refusal = (fetchFn: FetchFn): Promise<RemoteTreeRefusedError> =>
	rejection(RemoteTreeRefusedError, readRemoteTree(REMOTE, fetchFn));

const refusalTo = (status: number, message: string, headers: Record<string, string> = {}) =>
	refusal(answering(() => jsonResponse({ message }, status, headers)).fetch);

describe('reading a public repository’s file list', () => {
	it('asks one unauthenticated recursive listing, and sends no credential', async () => {
		const { fetch, asked } = answering(() => jsonResponse({ tree: [], truncated: false }));

		await readRemoteTree(REMOTE, fetch);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.url).toBe('https://api.github.com/repos/ada/atlas/git/trees/main?recursive=1');
		expect(new Headers(asked[0]?.init?.headers).has('authorization')).toBe(false);
	});

	it('spells a branch with a slash in it as one path parameter', async () => {
		const { fetch, asked } = answering(() => jsonResponse({ tree: [] }));

		await readRemoteTree({ ...REMOTE, branch: 'feature/x' }, fetch);

		expect(asked[0]?.url).toContain('/git/trees/feature%2Fx?recursive=1');
		expect(urlPath('feature/x')).toBe('feature/x');
	});

	it('keeps the blobs, with their sizes, and nothing else the tree lists', async () => {
		const { fetch } = answering(() =>
			jsonResponse({
				tree: [
					{ path: 'images', type: 'tree', sha: 'aaa' },
					{ path: 'images/map-1/info.json', type: 'blob', sha: 'bbb', size: 42 },
					{ path: 'vendor/theme', type: 'commit', sha: 'ccc' }
				]
			})
		);

		expect(await readRemoteTree(REMOTE, fetch)).toEqual([
			{ path: 'images/map-1/info.json', sha: 'bbb', bytes: 42 }
		]);
	});

	it('skips an entry with no usable path or sha, and counts a missing size as nought', async () => {
		const { fetch } = answering(() =>
			jsonResponse({
				tree: [
					{ path: 42, type: 'blob', sha: 'aaa', size: 1 },
					{ path: 'CNAME', type: 'blob', size: 1 },
					{ path: 'README.md', type: 'blob', sha: 'ddd' }
				]
			})
		);

		expect(await readRemoteTree(REMOTE, fetch)).toEqual([
			{ path: 'README.md', sha: 'ddd', bytes: 0 }
		]);
	});

	it('reads an answer that is not this endpoint’s as an empty listing rather than throwing', async () => {
		for (const body of ['<html>not json at all</html>', '{"tree":"nonsense"}', '{}', '[]']) {
			const { fetch } = answering(
				() => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
			);
			expect(await readRemoteTree(REMOTE, fetch)).toEqual([]);
		}
	});
});

describe('what the listing refuses', () => {
	it.each([
		['a repository with no commits, which is 409 and not 404', 409, {}, 'empty'],
		['a repository GitHub says is not there', 404, {}, 'no-repository'],
		['a repository that demands a credential', 401, {}, 'not-public'],
		['a repository that demands a credential', 403, {}, 'not-public'],
		[
			'a 403 with requests still left, which is the private repository after all',
			403,
			{ 'X-RateLimit-Remaining': '4999', 'X-RateLimit-Reset': '1800000000' },
			'not-public'
		],
		['a 403 whose headers are hidden, which is not a spent budget', 403, {}, 'not-public']
	])('%s (%i)', async (_, status, headers, expected) => {
		expect((await refusalTo(status, 'Bad credentials', headers)).refusal).toBe(expected);
	});

	it.each([
		[
			'the anonymous hourly limit, told apart by the count from a refused credential',
			{ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800000000' },
			new Date(1_800_000_000 * 1000)
		],
		[
			'a rate limit with no reset time, which is still a rate limit',
			{ 'X-RateLimit-Remaining': '0' },
			null
		]
	])('%s', async (_, headers, resetAt) => {
		const cause = await refusalTo(403, 'API rate limit exceeded', headers);
		expect([cause.refusal, cause.resetAt]).toEqual(['rate-limited', resetAt]);
	});

	it('anything else GitHub said, quoting GitHub’s own words', async () => {
		const cause = await refusalTo(500, 'Server Error');
		expect([cause.refusal, cause.detail]).toEqual(['refused', 'Server Error']);
	});

	it('a refusal with no message, falling back to the status GitHub gave it', async () => {
		for (const body of ['not json', JSON.stringify({ error: 'nope' })]) {
			const { fetch } = answering(
				() => new Response(body, { status: 502, statusText: 'Bad Gateway' })
			);
			const cause = await refusal(fetch);
			expect(cause.refusal).toBe('refused');
			expect(cause.detail).toBe('Bad Gateway');
		}
	});

	it('a request that never got an answer, carrying what the browser said', async () => {
		const failing = vi.fn(async () => {
			throw new TypeError('Failed to fetch');
		});

		const cause = await refusal(failing as unknown as FetchFn);
		expect(cause.refusal).toBe('unreachable');
		expect(cause.detail).toBe('Failed to fetch');
	});

	it('a truncated listing, counting the files it did name', async () => {
		const { fetch } = answering(() =>
			jsonResponse({
				truncated: true,
				tree: [
					{ path: 'images', type: 'tree', sha: 'aaa' },
					{ path: 'a.json', type: 'blob', sha: 'bbb', size: 1 },
					{ path: 'b.json', type: 'blob', sha: 'ccc', size: 1 }
				]
			})
		);

		const cause = await refusal(fetch);
		expect(cause.refusal).toBe('truncated');
		expect(cause.listed).toBe(2);
	});
});

describe('against the shared fake GitHub', () => {
	it('lists what a repository holds', async () => {
		const fake = await holding({ 'index.html': '<!doctype html>', 'amsterdam/project.json': '{}' });
		const blobs = await readRemoteTree(REMOTE, fake.fetch);
		expect(blobs.map((blob) => blob.path).sort()).toEqual(['amsterdam/project.json', 'index.html']);
		expect(blobs.every((blob) => blob.sha !== '' && blob.bytes > 0)).toBe(true);
	});

	it('meets the fake’s spent budget as a rate limit, ahead of any credential question', async () => {
		const fake = await holding({ 'index.html': '<!doctype html>' });
		fake.rateLimit = { remaining: 0, reset: 1_800_000_000 };

		const cause = await refusal(fake.fetch);
		expect(cause.refusal).toBe('rate-limited');
		expect(cause.resetAt).toEqual(new Date(1_800_000_000 * 1000));
	});
});

describe('reading the commit a public branch stands at', () => {
	it('answers the branch’s commit, and sends no credential', async () => {
		const fake = await holding({ 'index.html': '<!doctype html>' });
		expect(await readRemoteHeadCommit(REMOTE, fake.fetch)).toBe(fake.head());
	});

	it('spells a branch with a slash in it per segment, as this endpoint takes it', async () => {
		const { fetch, asked } = answering(() =>
			jsonResponse({ object: { sha: 'a1b2c3', type: 'commit' } })
		);

		await readRemoteHeadCommit({ ...REMOTE, branch: 'teaching/spring-2026' }, fetch);

		expect(asked[0]?.url).toContain('/git/ref/heads/teaching/spring-2026');
		expect(asked[0]?.init?.headers).not.toHaveProperty('Authorization');
	});

	it.each([
		['an answer that names no commit', jsonResponse({ object: {} }), 'refused'],
		[
			'a branch GitHub does not have, as it refuses a missing repository',
			jsonResponse({ message: 'Not Found' }, 404),
			'no-repository'
		]
	])('refuses %s', async (_, response, expected) => {
		const { fetch } = answering(() => response);

		expect(
			(await rejection(RemoteTreeRefusedError, readRemoteHeadCommit(REMOTE, fetch))).refusal
		).toBe(expected);
	});
});
