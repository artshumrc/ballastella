// The one file listing, read directly, because most of what it does is a reading of answers no
// caller can produce.
//
// `clone-from-remote.test.ts` and `review-from-remote.test.ts` drive this through the shared fake and
// assert the *sentences* their callers write. What is here is the half the fake cannot reach: a body
// that is not JSON, a `tree` that is not an array, a status neither reader has a name for, and the
// 403 that is a spent anonymous budget rather than a private repository.

import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { createFakeGitHub } from './fake-github.js';
import {
	RemoteTreeRefusedError,
	readRemoteHeadCommit,
	readRemoteTree,
	urlPath
} from './remote-tree.js';

const REMOTE = { owner: 'ada', repository: 'atlas', branch: 'main' };

/** One canned answer to whatever is asked, with the request kept for inspection. */
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

const refusal = async (fetchFn: FetchFn): Promise<RemoteTreeRefusedError> => {
	const cause = await readRemoteTree(REMOTE, fetchFn).catch((thrown: unknown) => thrown);
	expect(cause).toBeInstanceOf(RemoteTreeRefusedError);
	return cause as RemoteTreeRefusedError;
};

describe('reading a public repository’s file list', () => {
	it('asks one unauthenticated recursive listing, and sends no credential', async () => {
		// ⚠ The anonymity is the feature (ADR-0031): a student with no GitHub account reads their
		// instructor's repository, so an `Authorization` header added here would make an account a
		// prerequisite silently — everybody already signed in would go on working.
		const { fetch, asked } = answering(() => jsonResponse({ tree: [], truncated: false }));

		await readRemoteTree(REMOTE, fetch);

		expect(asked).toHaveLength(1);
		expect(asked[0]?.url).toBe('https://api.github.com/repos/ada/atlas/git/trees/main?recursive=1');
		expect(new Headers(asked[0]?.init?.headers).has('authorization')).toBe(false);
	});

	it('spells a branch with a slash in it as one path parameter', async () => {
		// `/git/trees/{ref}` takes a single segment, so `feature/x` spelled per segment would ask for a
		// path this endpoint does not have — and its failure would say nothing about branches.
		const { fetch, asked } = answering(() => jsonResponse({ tree: [] }));

		await readRemoteTree({ ...REMOTE, branch: 'feature/x' }, fetch);

		expect(asked[0]?.url).toContain('/git/trees/feature%2Fx?recursive=1');
		// Where the raw host wants the opposite, which is why the two are different functions.
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
		// Nothing here is the app's own document: it is whatever the host sent, so an entry that cannot
		// be addressed or checked is dropped rather than becoming a path built out of `undefined`.
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
		// A proxy's sign-in page, a captive portal, a `tree` that is a string: none of them is a file
		// list, and a `TypeError` out of the function whose whole job is to turn a bad answer into a
		// refusal is the one outcome no caller can say anything useful about.
		for (const body of ['<html>not json at all</html>', '{"tree":"nonsense"}', '{}', '[]']) {
			const { fetch } = answering(
				() => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
			);
			expect(await readRemoteTree(REMOTE, fetch)).toEqual([]);
		}
	});
});

describe('what the listing refuses', () => {
	it('a repository with no commits, which is 409 and not 404', async () => {
		// Reported as a missing repository it sends the user off to check an address that is fine.
		const { fetch } = answering(() => jsonResponse({ message: 'Git Repository is empty.' }, 409));

		expect((await refusal(fetch)).refusal).toBe('empty');
	});

	it('a repository GitHub says is not there', async () => {
		const { fetch } = answering(() => jsonResponse({ message: 'Not Found' }, 404));

		expect((await refusal(fetch)).refusal).toBe('no-repository');
	});

	it('a repository that demands a credential', async () => {
		for (const status of [401, 403]) {
			const { fetch } = answering(() => jsonResponse({ message: 'Bad credentials' }, status));
			expect((await refusal(fetch)).refusal).toBe('not-public');
		}
	});

	it('the anonymous hourly limit, told apart by the count from a refused credential', async () => {
		// ⚠ **60 requests an hour per IP address, answered 403 — the same status a credential GitHub
		// will not act on gives.** A class of students on one campus connection all reading their
		// instructor's repository spends that between them, and reported as "not public" it tells a
		// room full of people to change a setting on a repository none of them own.
		const { fetch } = answering(() =>
			jsonResponse({ message: 'API rate limit exceeded' }, 403, {
				'X-RateLimit-Remaining': '0',
				'X-RateLimit-Reset': '1800000000'
			})
		);

		const cause = await refusal(fetch);
		expect(cause.refusal).toBe('rate-limited');
		expect(cause.resetAt).toEqual(new Date(1_800_000_000 * 1000));
	});

	it('a 403 with requests still left, which is the private repository after all', async () => {
		const { fetch } = answering(() =>
			jsonResponse({ message: 'Must have admin rights' }, 403, {
				'X-RateLimit-Remaining': '4999',
				'X-RateLimit-Reset': '1800000000'
			})
		);

		expect((await refusal(fetch)).refusal).toBe('not-public');
	});

	it('a 403 whose headers are hidden, which is not a spent budget', async () => {
		// ⚠ A cross-origin response whose headers were not exposed arrives with every one of them
		// hidden, and `Number(null)` is `0` — so a missing count read as nought would report every
		// private repository as a rate limit that waiting would fix.
		const { fetch } = answering(() => jsonResponse({ message: 'Bad credentials' }, 403));

		expect((await refusal(fetch)).refusal).toBe('not-public');
	});

	it('a rate limit with no reset time, which is still a rate limit', async () => {
		const { fetch } = answering(() =>
			jsonResponse({ message: 'API rate limit exceeded' }, 403, { 'X-RateLimit-Remaining': '0' })
		);

		const cause = await refusal(fetch);
		expect(cause.refusal).toBe('rate-limited');
		expect(cause.resetAt).toBeNull();
	});

	it('anything else GitHub said, quoting GitHub’s own words', async () => {
		const { fetch } = answering(() => jsonResponse({ message: 'Server Error' }, 500));

		const cause = await refusal(fetch);
		expect(cause.refusal).toBe('refused');
		expect(cause.detail).toBe('Server Error');
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
		// ⚠ **A truncated listing answers 200**, so nothing throws and nothing logs. The count is of
		// blobs rather than tree rows, because that is the number a caller quotes at a user.
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
	it('lists what a published repository holds', async () => {
		const fake = await createFakeGitHub({
			owner: REMOTE.owner,
			repository: REMOTE.repository,
			tree: { 'index.html': '<!doctype html>', 'amsterdam/project.json': '{}' }
		});

		const blobs = await readRemoteTree(REMOTE, fake.fetch);

		expect(blobs.map((blob) => blob.path).sort()).toEqual(['amsterdam/project.json', 'index.html']);
		expect(blobs.every((blob) => blob.sha !== '' && blob.bytes > 0)).toBe(true);
	});

	it('meets the fake’s spent budget as a rate limit, ahead of any credential question', async () => {
		// The fake answers 403 to *every* API request once the budget is gone, before it looks at a
		// token — which is what makes it the anonymous reader's 403 rather than a permission's.
		const fake = await createFakeGitHub({
			owner: REMOTE.owner,
			repository: REMOTE.repository,
			tree: { 'index.html': '<!doctype html>' }
		});
		fake.rateLimit = { remaining: 0, reset: 1_800_000_000 };

		const cause = await refusal(fake.fetch);
		expect(cause.refusal).toBe('rate-limited');
		expect(cause.resetAt).toEqual(new Date(1_800_000_000 * 1000));
	});
});

// The commit an Import records as the state it copied. One request, anonymous, and
// the tree listing cannot answer it: `/git/trees/{ref}` reports the tree object's hash, which names
// no history.
describe('reading the commit a public branch stands at', () => {
	it('answers the branch’s commit, and sends no credential', async () => {
		const fake = await createFakeGitHub({
			owner: REMOTE.owner,
			repository: REMOTE.repository,
			tree: { 'index.html': '<!doctype html>' }
		});

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

	// An answer of this endpoint's shape with nothing in it. Refused rather than recorded as an empty
	// commit: provenance saying a Project came from no particular state is worse than an Import that
	// did not happen.
	it('refuses an answer that names no commit', async () => {
		const { fetch } = answering(() => jsonResponse({ object: {} }));

		const cause = await readRemoteHeadCommit(REMOTE, fetch).catch((thrown: unknown) => thrown);

		expect(cause).toBeInstanceOf(RemoteTreeRefusedError);
		expect((cause as RemoteTreeRefusedError).refusal).toBe('refused');
	});

	it('refuses a branch GitHub does not have, as it refuses a missing repository', async () => {
		const { fetch } = answering(() => jsonResponse({ message: 'Not Found' }, 404));

		const cause = await readRemoteHeadCommit(REMOTE, fetch).catch((thrown: unknown) => thrown);

		expect((cause as RemoteTreeRefusedError).refusal).toBe('no-repository');
	});
});
