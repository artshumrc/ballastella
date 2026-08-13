import { beforeEach, describe, expect, it } from 'vitest';

import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub, type FakeTreeEntry } from './fake-github.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';

const utf8 = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
// Chunked because spreading a whole pyramid tile into `String.fromCodePoint` is a `RangeError`
// somewhere past 64k arguments, and a tile is the content this fake exists for.
const base64 = (bytes: Uint8Array) => {
	let binary = '';
	for (let at = 0; at < bytes.length; at += 0x8000) {
		binary += String.fromCodePoint(...bytes.subarray(at, at + 0x8000));
	}
	return btoa(binary);
};

const repository = `${GITHUB_API_ORIGIN}/repos/ada/atlas`;

/**
 * An API call carrying a token, because the fake answers 401 to a write without one.
 *
 * Reads are answered unauthenticated — a public repository needs no credential — and the raw host is
 * called through `github.fetch` directly throughout, since a test that sent a token there would hide
 * a Clone doing the same.
 */
const call = (github: FakeGitHub, url: string, init: RequestInit = {}) =>
	github.fetch(url, { ...init, headers: { Authorization: 'Bearer ghp_a-token' } });

/**
 * The blob/tree/commit/ref sequence a publish makes, driven through the fake's own `fetch`.
 *
 * Written out longhand rather than hidden behind a helper the fake exports, because these five
 * calls in this order are the thing under test: a fixture that offered a `publish()` shortcut would
 * be asserting its own shortcut.
 */
async function commitThrough(
	github: FakeGitHub,
	files: Record<string, Uint8Array>,
	options: { readonly branch?: string; readonly message?: string } = {}
): Promise<{ readonly commit: string; readonly blobs: Map<string, string> }> {
	const branch = options.branch ?? 'main';
	const blobs = new Map<string, string>();

	for (const [path, bytes] of Object.entries(files)) {
		const posted = await call(github, `${repository}/git/blobs`, {
			method: 'POST',
			body: JSON.stringify({ content: base64(bytes), encoding: 'base64' })
		});
		const { sha } = (await posted.json()) as { sha: string };
		blobs.set(path, sha);
	}

	const tree = await call(github, `${repository}/git/trees`, {
		method: 'POST',
		body: JSON.stringify({
			tree: [...blobs].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha }))
		})
	});
	const { sha: treeSha } = (await tree.json()) as { sha: string };

	const head = github.head(branch);
	const commit = await call(github, `${repository}/git/commits`, {
		method: 'POST',
		body: JSON.stringify({
			message: options.message ?? 'Publish',
			tree: treeSha,
			parents: head === null ? [] : [head]
		})
	});
	const { sha: commitSha } = (await commit.json()) as { sha: string };

	const moved =
		head === null
			? await call(github, `${repository}/git/refs`, {
					method: 'POST',
					body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitSha })
				})
			: await call(github, `${repository}/git/refs/heads/${branch}`, {
					method: 'PATCH',
					body: JSON.stringify({ sha: commitSha, force: false })
				});
	expect(moved.ok).toBe(true);

	return { commit: commitSha, blobs };
}

const listTree = async (github: FakeGitHub, ref = 'main', query = '?recursive=1') => {
	const response = await call(github, `${repository}/git/trees/${ref}${query}`);
	return {
		response,
		body: (await response.json()) as {
			sha: string;
			tree: FakeTreeEntry[];
			truncated: boolean;
		}
	};
};

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
		it('reads a starting tree back at its paths', () => {
			expect([...github.files()].map(([path, bytes]) => [path, decode(bytes)])).toEqual([
				['CNAME', 'atlas.example\n'],
				['README.md', '# Atlas\n']
			]);
		});

		it('round-trips bytes written through blob, tree, commit and ref', async () => {
			await commitThrough(github, {
				'index.html': utf8('<!doctype html>'),
				'images/one/info.json': utf8('{"width":700}')
			});

			expect([...github.files()].map(([path, bytes]) => [path, decode(bytes)])).toEqual([
				['images/one/info.json', '{"width":700}'],
				['index.html', '<!doctype html>']
			]);
		});

		it('reports, for each path, the SHA the blob utility computes for those same bytes', async () => {
			const bytes = utf8('<!doctype html>');
			await commitThrough(github, { 'index.html': bytes });

			const { body } = await listTree(github);
			const entry = body.tree.find((candidate) => candidate.path === 'index.html');

			expect(entry).toEqual({
				path: 'index.html',
				mode: '100644',
				type: 'blob',
				sha: await gitBlobSha(bytes),
				size: bytes.byteLength
			});
		});

		it('answers the same blob SHA to the poster as it reports in the tree', async () => {
			const { blobs } = await commitThrough(github, { 'a.txt': utf8('a') });
			expect(blobs.get('a.txt')).toBe(await gitBlobSha(utf8('a')));
		});

		it('lists the directories a path implies, so a client that reads every entry as a file is caught', async () => {
			await commitThrough(github, { 'images/one/info.json': utf8('{}') });

			const { body } = await listTree(github);
			expect(body.tree.filter((entry) => entry.type === 'tree').map((entry) => entry.path)).toEqual(
				['images', 'images/one']
			);
		});

		it('lists only top-level entries when the request is not recursive', async () => {
			await commitThrough(github, { 'index.html': utf8('x'), 'images/one/info.json': utf8('{}') });

			const { body } = await listTree(github, 'main', '');
			expect(body.tree.map((entry) => entry.path)).toEqual(['images', 'index.html']);
		});

		it('serves the committed bytes from the raw host', async () => {
			await commitThrough(github, { 'images/one/info.json': utf8('{"width":700}') });

			const response = await github.fetch(
				`${GITHUB_RAW_ORIGIN}/ada/atlas/main/images/one/info.json`
			);

			expect(decode(new Uint8Array(await response.arrayBuffer()))).toBe('{"width":700}');
		});

		it('answers 404 from the raw host for a path the commit does not hold', async () => {
			const response = await github.fetch(`${GITHUB_RAW_ORIGIN}/ada/atlas/main/nowhere.txt`);
			expect(response.status).toBe(404);
		});

		it('counts blob posts, so "the second publish uploaded nothing" needs no call order', async () => {
			await commitThrough(github, { 'a.txt': utf8('a'), 'b.txt': utf8('b') });
			const afterFirst = github.blobPosts;

			// The second publish reuses both SHAs and posts neither, exactly as the engine will.
			const { body } = await listTree(github);
			const held = new Map(body.tree.map((entry) => [entry.path, entry.sha]));
			const tree = await call(github, `${repository}/git/trees`, {
				method: 'POST',
				body: JSON.stringify({
					tree: ['a.txt', 'b.txt'].map((path) => ({
						path,
						mode: '100644',
						type: 'blob',
						sha: held.get(path)
					}))
				})
			});

			expect([afterFirst, tree.status, github.blobPosts]).toEqual([2, 201, 2]);
		});

		it('records the commit chain, newest first', async () => {
			// The seeded starting tree is a commit of its own, so the chain ends there.
			const seeded = github.head();
			const first = await commitThrough(github, { 'a.txt': utf8('a') });
			const second = await commitThrough(github, { 'a.txt': utf8('aa') });

			expect([github.head(), github.history()]).toEqual([
				second.commit,
				[second.commit, first.commit, seeded]
			]);
		});

		it('answers the branch ref with the commit a publish has to parent onto', async () => {
			const { commit } = await commitThrough(github, { 'a.txt': utf8('a') });

			const response = await call(github, `${repository}/git/ref/heads/main`);

			expect(await response.json()).toEqual({
				ref: 'refs/heads/main',
				object: { sha: commit, type: 'commit' }
			});
		});

		it('leaves the published tree alone until the ref moves', async () => {
			const before = github.head();

			for (const bytes of [utf8('one'), utf8('two')]) {
				await call(github, `${repository}/git/blobs`, {
					method: 'POST',
					body: JSON.stringify({ content: base64(bytes), encoding: 'base64' })
				});
			}

			expect([github.head(), [...github.files().keys()]]).toEqual([before, ['CNAME', 'README.md']]);
		});
	});

	describe('the failures the engine has to handle', () => {
		it('reports a truncated tree, cut short at the entry the test asks for', async () => {
			github.truncateAfter = 1;

			const { body } = await listTree(github);
			expect([body.truncated, body.tree.length]).toEqual([true, 1]);
		});

		it('refuses once the hourly budget is spent, naming the reset', async () => {
			github.rateLimit = { remaining: 0, reset: 1_800_000_000 };

			const response = await call(github, repository);

			expect([
				response.status,
				response.headers.get('X-RateLimit-Remaining'),
				response.headers.get('X-RateLimit-Reset')
			]).toEqual([403, '0', '1800000000']);
		});

		it('spends one request of the budget per API call', async () => {
			github.rateLimit = { remaining: 2, reset: 1_800_000_000 };

			const first = await call(github, repository);
			const second = await call(github, repository);
			const third = await call(github, repository);

			expect([first.status, second.status, third.status]).toEqual([200, 200, 403]);
		});

		it('answers 403 to every git write when the token cannot push', async () => {
			github.refuseWrites = true;

			const blob = await call(github, `${repository}/git/blobs`, {
				method: 'POST',
				body: JSON.stringify({ content: base64(utf8('a')), encoding: 'base64' })
			});
			const ref = await call(github, `${repository}/git/refs/heads/main`, {
				method: 'PATCH',
				body: JSON.stringify({ sha: github.head(), force: false })
			});

			// The refused post still counts: the point of 403-ing at blob time is that an engine
			// discovering it there has already spent the requests, and a counter that forgot them
			// would exonerate exactly the engine under suspicion.
			expect([blob.status, ref.status, github.blobPosts]).toEqual([403, 403, 1]);
		});

		it('reports the rights the repository grants', async () => {
			github.permissions = { push: false, admin: false };

			const response = await call(github, repository);
			expect(await response.json()).toEqual({ permissions: { push: false, admin: false } });
		});

		// ⚠ **The field that decides whether the scholar is told the credential cannot push.** GitHub
		// reports what *this caller* may do, so an anonymous read of a public repository carries no
		// `permissions` at all — and a fake that sent one anyway would answer "you may push" to a
		// request that sent no token.
		it('says nothing about rights to a read carrying no credential', async () => {
			const response = await github.fetch(repository);

			expect([response.status, await response.json()]).toEqual([200, {}]);
		});

		it('answers 409 from the Pages endpoint when Pages is already enabled', async () => {
			github.pagesEnabled = true;

			const response = await call(github, `${repository}/pages`, {
				method: 'POST',
				body: JSON.stringify({ source: { branch: 'main', path: '/' } })
			});

			expect(response.status).toBe(409);
		});

		it('enables Pages once, and says so the second time', async () => {
			const enable = () =>
				call(github, `${repository}/pages`, {
					method: 'POST',
					body: JSON.stringify({ source: { branch: 'main', path: '/' } })
				});

			const first = await enable();
			const second = await enable();

			expect([first.status, second.status, github.pagesEnabled]).toEqual([201, 409, true]);
		});

		// ⚠ **409, not 404**, and the status is the whole point of the test. A repository made at
		// `github.com/new` with no README has no commits, which is exactly what the "create it
		// yourself" link hands a scholar back from — and a publish that read this as an ordinary
		// failure would die at plan time on the one flow this epic walks a beginner through.
		it('answers 409 “Git Repository is empty.” for a repository with no commits', async () => {
			const empty = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

			const response = await call(empty, `${repository}/git/trees/main?recursive=1`);
			const ref = await call(empty, `${repository}/git/ref/heads/main`);

			expect([response.status, ref.status, empty.head(), empty.history()]).toEqual([
				409,
				409,
				null,
				[]
			]);
			expect(await ref.json()).toEqual({ message: 'Git Repository is empty.' });
		});

		// The other half of the pair: a repository that *has* branches and not this one is a 404, and
		// an engine that treated the two alike would plan a full upload against a typo'd branch.
		it('answers 404 for a branch a repository with commits does not have', async () => {
			const ref = await call(github, `${repository}/git/ref/heads/no-such-branch`);
			expect(ref.status).toBe(404);
		});

		it('refuses Pages when the source branch does not exist yet, with a 422', async () => {
			const empty = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

			const response = await call(empty, `${repository}/pages`, {
				method: 'POST',
				body: JSON.stringify({ source: { branch: 'main', path: '/' } })
			});

			expect([response.status, empty.pagesEnabled]).toEqual([422, false]);
		});

		it('refuses Pages with a 403 for a token that has no Pages permission', async () => {
			github.refusePages = true;

			const response = await call(github, `${repository}/pages`, {
				method: 'POST',
				body: JSON.stringify({ source: { branch: 'main', path: '/' } })
			});

			expect([response.status, github.pagesEnabled]).toEqual([403, false]);
		});

		it('answers 401 to a credential it will not accept, wherever it is sent', async () => {
			github.rejectCredential = true;

			const metadata = await call(github, repository);
			const pages = await call(github, `${repository}/pages`, {
				method: 'POST',
				body: JSON.stringify({ source: { branch: 'main', path: '/' } })
			});

			expect([metadata.status, pages.status]).toEqual([401, 401]);
		});

		// A revoked token in the tab does not close a public repository to a reader who sends none,
		// which is the flow a student with no GitHub account is promised (SPEC, Import).
		it('still answers an unauthenticated read while a credential is being rejected', async () => {
			github.rejectCredential = true;

			const response = await github.fetch(`${repository}/git/trees/main?recursive=1`);

			expect(response.status).toBe(200);
		});

		it('takes its first commit through a created ref', async () => {
			const empty = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

			await commitThrough(empty, { 'index.html': utf8('<!doctype html>') });

			expect([...empty.files().keys()]).toEqual(['index.html']);
		});
	});

	describe('the edge of what it implements', () => {
		it('answers 404 for a path it does not implement', async () => {
			const response = await call(github, `${repository}/git/tags`, {
				method: 'POST',
				body: JSON.stringify({ tag: 'v1' })
			});

			expect(response.status).toBe(404);
		});

		it('answers 404 for another repository', async () => {
			const response = await call(github, `${GITHUB_API_ORIGIN}/repos/ada/other/git/trees/main`);
			expect(response.status).toBe(404);
		});

		it('answers 404 for a host that is not GitHub', async () => {
			const response = await github.fetch('https://example.invalid/repos/ada/atlas');
			expect(response.status).toBe(404);
		});

		it('answers 401 to an API call carrying no token', async () => {
			const response = await github.fetch(`${repository}/git/blobs`, {
				method: 'POST',
				body: JSON.stringify({ content: base64(utf8('hello')), encoding: 'base64' })
			});

			expect(response.status).toBe(401);
		});

		// A public repository's file list is readable with no credential, and this epic depends on it:
		// Clone and Review are unauthenticated (SPEC, "Import: two operations, both unauthenticated"),
		// so a student with no GitHub account can open an instructor's Workspace. Pinned here rather
		// than in the ticket that needs it, because a gate that crept back would be found there.
		it('lists a public repository’s tree with no token at all', async () => {
			const response = await github.fetch(`${repository}/git/trees/main?recursive=1`);
			const { tree } = (await response.json()) as { tree: FakeTreeEntry[] };

			expect([response.status, tree.map((entry) => entry.path)]).toEqual([
				200,
				['CNAME', 'README.md']
			]);
		});

		it('reads the raw host with no token at all', async () => {
			await commitThrough(github, { 'README.md': utf8('# Atlas') });

			const response = await github.fetch(`${GITHUB_RAW_ORIGIN}/ada/atlas/main/README.md`);

			expect(response.status).toBe(200);
			expect(decode(new Uint8Array(await response.arrayBuffer()))).toBe('# Atlas');
		});

		it('refuses a tree built on base_tree rather than merging one silently', async () => {
			const response = await call(github, `${repository}/git/trees`, {
				method: 'POST',
				body: JSON.stringify({ base_tree: 'whatever', tree: [] })
			});

			expect(response.status).toBe(400);
		});

		it('refuses a tree entry naming a blob it has never been given', async () => {
			const response = await call(github, `${repository}/git/trees`, {
				method: 'POST',
				body: JSON.stringify({
					tree: [{ path: 'a.txt', mode: '100644', type: 'blob', sha: '0'.repeat(40) }]
				})
			});

			expect(response.status).toBe(422);
		});

		// The browser can read these at all only because `api.github.com` lists them in
		// `access-control-expose-headers`, and the engine reads the remaining budget as it goes — so a
		// response that carried none would be a budget the engine silently stopped tracking.
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
