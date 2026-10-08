import { beforeEach, describe, expect, it } from 'vitest';

import { decode, encode } from '../test-support.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub, type FakeTreeEntry } from './fake-github.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';

const base64 = (bytes: Uint8Array) => {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCodePoint(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
};

const repository = `${GITHUB_API_ORIGIN}/repos/ada/atlas`;

const call = (github: FakeGitHub, url: string, init: RequestInit = {}) =>
	github.fetch(url, { ...init, headers: { Authorization: 'Bearer ghp_a-token' } });

const send = (github: FakeGitHub, method: string, path: string, body: unknown) =>
	call(github, `${repository}/${path}`, { method, body: JSON.stringify(body) });

const postBlob = (github: FakeGitHub, bytes: Uint8Array) =>
	send(github, 'POST', 'git/blobs', { content: base64(bytes), encoding: 'base64' });

const enablePages = (github: FakeGitHub) =>
	send(github, 'POST', 'pages', { source: { branch: 'main', path: '/' } });

const blobTree = (entries: [string, unknown][]) => ({
	tree: entries.map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha }))
});

async function commitThrough(
	github: FakeGitHub,
	files: Record<string, Uint8Array>
): Promise<{ readonly commit: string; readonly blobs: Map<string, string> }> {
	const blobs = new Map<string, string>();
	for (const [path, bytes] of Object.entries(files)) {
		blobs.set(path, ((await (await postBlob(github, bytes)).json()) as { sha: string }).sha);
	}
	const tree = await send(github, 'POST', 'git/trees', blobTree([...blobs]));
	const { sha: treeSha } = (await tree.json()) as { sha: string };
	const commit = await send(github, 'POST', 'git/commits', {
		message: 'Sync',
		tree: treeSha,
		parents: [github.head()]
	});
	const { sha: commitSha } = (await commit.json()) as { sha: string };
	const moved = await send(github, 'PATCH', 'git/refs/heads/main', {
		sha: commitSha,
		force: false
	});
	expect(moved.ok).toBe(true);
	return { commit: commitSha, blobs };
}

const listTree = async (github: FakeGitHub, ref = 'main', query = '?recursive=1') => {
	const response = await call(github, `${repository}/git/trees/${ref}${query}`);
	return {
		response,
		body: (await response.json()) as { sha: string; tree: FakeTreeEntry[]; truncated: boolean }
	};
};

const texts = (github: FakeGitHub, ref?: string) =>
	[...github.files(ref)].map(([path, bytes]) => [path, decode(bytes)]);

describe('the fake GitHub', () => {
	let github: FakeGitHub;

	beforeEach(async () => {
		github = await createFakeGitHub({
			owner: 'ada',
			repository: 'atlas',
			tree: { 'README.md': '# Atlas\n', CNAME: 'atlas.example\n' }
		});
	});

	describe('the object store', () => {
		it('reads a starting tree back, then the bytes written through blob, tree, commit and ref', async () => {
			expect(texts(github)).toEqual([
				['CNAME', 'atlas.example\n'],
				['README.md', '# Atlas\n']
			]);

			await commitThrough(github, {
				'index.html': encode('<!doctype html>'),
				'images/one/info.json': encode('{"width":700}')
			});

			expect(texts(github)).toEqual([
				['images/one/info.json', '{"width":700}'],
				['index.html', '<!doctype html>']
			]);
		});

		it('answers the poster, and lists in the tree, the SHA the blob utility computes', async () => {
			const bytes = encode('<!doctype html>');
			const { blobs } = await commitThrough(github, { 'index.html': bytes });

			const { body } = await listTree(github);
			const sha = await gitBlobSha(bytes);
			expect(blobs.get('index.html')).toBe(sha);
			expect(body.tree.find((candidate) => candidate.path === 'index.html')).toEqual({
				path: 'index.html',
				mode: '100644',
				type: 'blob',
				sha,
				size: bytes.byteLength
			});
		});

		it('lists the directories a path implies when recursive, and only top-level entries otherwise', async () => {
			await commitThrough(github, {
				'index.html': encode('x'),
				'images/one/info.json': encode('{}')
			});

			const recursive = (await listTree(github)).body.tree;
			const topLevel = (await listTree(github, 'main', '')).body.tree;
			expect(recursive.filter((entry) => entry.type === 'tree').map((entry) => entry.path)).toEqual(
				['images', 'images/one']
			);
			expect(topLevel.map((entry) => entry.path)).toEqual(['images', 'index.html']);
		});

		it('serves committed bytes from the raw host with no token, counting the reads it refuses too', async () => {
			await commitThrough(github, { 'images/one/info.json': encode('{"width":700}') });
			const before = github.rawGets;

			const response = await github.fetch(
				`${GITHUB_RAW_ORIGIN}/ada/atlas/main/images/one/info.json`
			);
			await github.fetch(`${GITHUB_RAW_ORIGIN}/ada/atlas/main/nowhere.txt`);

			expect(response.status).toBe(200);
			expect(decode(new Uint8Array(await response.arrayBuffer()))).toBe('{"width":700}');
			expect(github.rawGets - before).toBe(2);
		});

		it('counts blob posts, so "the second send uploaded nothing" needs no call order', async () => {
			await commitThrough(github, { 'a.txt': encode('a'), 'b.txt': encode('b') });
			const afterFirst = github.blobPosts;

			const { body } = await listTree(github);
			const held = new Map(body.tree.map((entry) => [entry.path, entry.sha]));
			const tree = await send(
				github,
				'POST',
				'git/trees',
				blobTree(['a.txt', 'b.txt'].map((path) => [path, held.get(path)]))
			);

			expect([afterFirst, tree.status, github.blobPosts]).toEqual([2, 201, 2]);
		});

		it('records the commit chain newest first, and reads an earlier commit’s files', async () => {
			const seeded = github.head();
			const first = await commitThrough(github, { 'a.txt': encode('a') });
			const second = await commitThrough(github, { 'b.txt': encode('b') });

			expect([github.head(), github.history()]).toEqual([
				second.commit,
				[second.commit, first.commit, seeded]
			]);
			expect([texts(github, first.commit), texts(github)]).toEqual([
				[['a.txt', 'a']],
				[['b.txt', 'b']]
			]);
		});

		it('answers the branch ref with the commit a send has to parent onto', async () => {
			const { commit } = await commitThrough(github, { 'a.txt': encode('a') });

			const response = await call(github, `${repository}/git/ref/heads/main`);

			expect(await response.json()).toEqual({
				ref: 'refs/heads/main',
				object: { sha: commit, type: 'commit' }
			});
		});

		it('leaves the Remote’s tree alone until the ref moves', async () => {
			const before = github.head();

			for (const bytes of [encode('one'), encode('two')]) await postBlob(github, bytes);
			expect([github.head(), [...github.files().keys()]]).toEqual([before, ['CNAME', 'README.md']]);
		});
	});

	describe('the failures the engine has to handle', () => {
		it('reports a truncated tree, cut short at the entry the test asks for', async () => {
			github.truncateAfter = 1;

			const { body } = await listTree(github);
			expect([body.truncated, body.tree.length]).toEqual([true, 1]);
		});

		it('spends one request of the budget per API call, then refuses naming the reset', async () => {
			github.rateLimit = { remaining: 2, reset: 1_800_000_000 };

			const first = await call(github, repository);
			const second = await call(github, repository);
			const third = await call(github, repository);
			expect([
				first.status,
				second.status,
				third.status,
				third.headers.get('X-RateLimit-Remaining'),
				third.headers.get('X-RateLimit-Reset')
			]).toEqual([200, 200, 403, '0', '1800000000']);
		});

		it('answers 403 to every git write when the token cannot push', async () => {
			github.refuseWrites = true;

			const blob = await postBlob(github, encode('a'));
			const ref = await send(github, 'PATCH', 'git/refs/heads/main', {
				sha: github.head(),
				force: false
			});

			expect([blob.status, ref.status, github.blobPosts]).toEqual([403, 403, 1]);
		});

		it('reports the rights the repository grants, and nothing to a read carrying no credential', async () => {
			github.permissions = { push: false, admin: false };

			const response = await call(github, repository);
			const anonymous = await github.fetch(repository);
			expect(await response.json()).toEqual({ permissions: { push: false, admin: false } });
			expect([anonymous.status, await anonymous.json()]).toEqual([200, {}]);
		});

		it('enables Pages once, and says so the second time', async () => {
			const first = await enablePages(github);
			const second = await enablePages(github);
			expect([first.status, second.status, github.pagesEnabled]).toEqual([201, 409, true]);
		});

		it('answers 409 “Git Repository is empty.” to a repository with no commits, and Pages 422', async () => {
			const empty = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });
			const tree = await call(empty, `${repository}/git/trees/main?recursive=1`);
			const ref = await call(empty, `${repository}/git/ref/heads/main`);
			const blob = await postBlob(empty, new Uint8Array());
			const pages = await enablePages(empty);

			expect([tree.status, ref.status, blob.status, empty.head(), empty.history()]).toEqual([
				409,
				409,
				409,
				null,
				[]
			]);
			for (const refused of [ref, blob]) {
				expect(await refused.json()).toEqual({ message: 'Git Repository is empty.' });
			}
			expect([pages.status, empty.pagesEnabled]).toEqual([422, false]);
		});

		it('refuses Pages with a 403 for a token that has no Pages permission', async () => {
			github.refusePages = true;

			const response = await enablePages(github);
			expect([response.status, github.pagesEnabled]).toEqual([403, false]);
		});

		it('answers 401 to a credential it will not accept, wherever it is sent', async () => {
			github.rejectCredential = true;

			const metadata = await call(github, repository);
			const pages = await enablePages(github);
			expect([metadata.status, pages.status]).toEqual([401, 401]);
		});

		it('takes its first commit through the Contents API, and opens the git database with it', async () => {
			const empty = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

			const opened = await send(empty, 'PUT', 'contents/.nojekyll', {
				message: 'Sync',
				content: '',
				branch: 'main'
			});
			expect(opened.status).toBe(201);
			await commitThrough(empty, { 'index.html': encode('<!doctype html>') });

			expect([...empty.files().keys()]).toEqual(['index.html']);
		});
	});

	describe('the edge of what it implements', () => {
		it.each<[string, number, (github: FakeGitHub) => Promise<Response>]>([
			[
				'a raw path the commit does not hold',
				404,
				(github) => github.fetch(`${GITHUB_RAW_ORIGIN}/ada/atlas/main/nowhere.txt`)
			],
			[
				'a branch the repository does not have',
				404,
				(github) => call(github, `${repository}/git/ref/heads/no-such-branch`)
			],
			[
				'a path it does not implement',
				404,
				(github) => send(github, 'POST', 'git/tags', { tag: 'v1' })
			],
			[
				'another repository',
				404,
				(github) => call(github, `${GITHUB_API_ORIGIN}/repos/ada/other/git/trees/main`)
			],
			[
				'a host that is not GitHub',
				404,
				(github) => github.fetch('https://example.invalid/repos/ada/atlas')
			],
			[
				'an API write carrying no token',
				401,
				(github) => github.fetch(`${repository}/git/blobs`, { method: 'POST', body: '{}' })
			],
			[
				'a tree built on base_tree rather than merged silently',
				400,
				(github) => send(github, 'POST', 'git/trees', { base_tree: 'whatever', tree: [] })
			],
			[
				'a tree entry naming a blob it has never been given',
				422,
				(github) => send(github, 'POST', 'git/trees', blobTree([['a.txt', '0'.repeat(40)]]))
			],
			[
				'enabling Pages that is already enabled',
				409,
				(github) => {
					github.pagesEnabled = true;
					return enablePages(github);
				}
			],
			[
				'an unauthenticated read while a credential is being rejected',
				200,
				(github) => {
					github.rejectCredential = true;
					return github.fetch(`${repository}/git/trees/main?recursive=1`);
				}
			]
		])('answers %s with %i', async (_description, status, request) => {
			expect((await request(github)).status).toBe(status);
		});

		it('lists a public repository’s tree with no token at all', async () => {
			const response = await github.fetch(`${repository}/git/trees/main?recursive=1`);
			const { tree } = (await response.json()) as { tree: FakeTreeEntry[] };

			expect([response.status, tree.map((entry) => entry.path)]).toEqual([
				200,
				['CNAME', 'README.md']
			]);
		});

		it('carries the rate-limit headers on every response, refusals included', async () => {
			const responses = [
				await call(github, repository),
				await call(github, `${repository}/git/trees/main?recursive=1`),
				await call(github, `${repository}/git/tags`, { method: 'POST', body: '{}' }),
				await github.fetch(`${GITHUB_RAW_ORIGIN}/ada/atlas/main/README.md`),
				await github.fetch(`${GITHUB_RAW_ORIGIN}/ada/atlas/main/nowhere.txt`),
				await github.fetch('https://example.invalid/anything')
			];

			for (const response of responses) {
				expect(response.headers.get('X-RateLimit-Remaining')).toMatch(/^\d+$/);
				expect(response.headers.get('X-RateLimit-Reset')).toMatch(/^\d+$/);
			}
		});
	});
});

describe('the repositories an author has granted the App', () => {
	let github: FakeGitHub;

	beforeEach(async () => {
		github = await createFakeGitHub({
			owner: 'ada',
			repository: 'atlas',
			grants: {
				installationId: 42,
				account: 'ada',
				repositories: [
					{ owner: 'ada', repository: 'atlas', push: true, admin: true },
					{ owner: 'ada', repository: 'notes', push: false, private: true }
				]
			}
		});
	});

	const installations = `${GITHUB_API_ORIGIN}/user/installations`;
	const listing = async (github: FakeGitHub, query = '') =>
		(await (await call(github, `${installations}/42/repositories${query}`)).json()) as {
			total_count: number;
			repositories: { full_name: string }[];
		};

	it('reports the installation and what it holds', async () => {
		const listed = await (await call(github, installations)).json();
		expect(listed).toEqual({
			total_count: 1,
			installations: [
				{
					id: 42,
					account: { login: 'ada', type: 'User' },
					target_id: 1_000_042,
					target_type: 'User',
					repository_selection: 'selected'
				}
			]
		});

		expect(await listing(github)).toEqual({
			total_count: 2,
			repositories: [
				{
					id: 1,
					name: 'atlas',
					full_name: 'ada/atlas',
					private: false,
					permissions: { push: true, admin: true }
				},
				{
					id: 2,
					name: 'notes',
					full_name: 'ada/notes',
					private: true,
					permissions: { push: false, admin: false }
				}
			]
		});
	});

	it('cuts the listing the way per_page and page cut it, counting the whole and running out', async () => {
		const second = await listing(github, '?per_page=1&page=2');
		expect([second.total_count, second.repositories.map((one) => one.full_name)]).toEqual([
			2,
			['ada/notes']
		]);
		expect(await listing(github, '?per_page=1&page=3')).toEqual({
			total_count: 2,
			repositories: []
		});
	});

	it('returns a repository granted after the fact', async () => {
		github.grant({ owner: 'ada', repository: 'harbour', push: true });

		const { total_count, repositories } = await listing(github);
		expect(total_count).toBe(3);
		expect(repositories.map((one) => one.full_name)).toContain('ada/harbour');
	});

	it.each([
		['a read carrying no credential', 401, (github: FakeGitHub) => github.fetch(installations)],
		[
			'an installation it does not hold',
			404,
			(github: FakeGitHub) => call(github, `${installations}/7/repositories`)
		],
		[
			'a path beneath /user it does not model',
			404,
			(github: FakeGitHub) => call(github, `${GITHUB_API_ORIGIN}/user/repos`)
		]
	])('answers %s with %i', async (_description, status, request) => {
		expect((await request(github)).status).toBe(status);
	});

	it('reports no installations until the first grant makes one on a fake configured without', async () => {
		const nothing = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });
		const none = await call(nothing, installations);
		expect([none.status, await none.json()]).toEqual([200, { total_count: 0, installations: [] }]);

		nothing.grant({ owner: 'ada', repository: 'atlas', push: true });

		const listed = (await (await call(nothing, installations)).json()) as {
			installations: { id: number }[];
		};
		const held = await call(
			nothing,
			`${installations}/${listed.installations.at(0)?.id}/repositories`
		);

		expect((await held.json()) as { total_count: number }).toMatchObject({ total_count: 1 });
	});
});
