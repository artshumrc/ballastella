import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { STATIC_HOSTING_LIMIT_BYTES } from '../project/workspace-size.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import {
	MAX_PUBLISHED_FILES,
	RemotePublishFailedError,
	RemotePublishRateLimitedError,
	RemotePublishRefusedError,
	planRemotePublish,
	publishToRemote,
	type RemoteRepository
} from './publish-to-remote.js';

// SPEC's Seam 1, and its testing decision in as many words: *a good test here asserts what arrived
// at the Remote, not which calls were made.* Every failure mode in this ticket is silent and
// plausible — a truncated tree yields a commit missing most of a pyramid, an off-by-one in the
// owned namespace deletes a `CNAME` — and a test counting requests passes over both. So the
// assertions below are on the fake's resulting tree: which paths exist, which bytes they hold, and
// which are gone.

const encode = (text: string): Bytes => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const EMPTY = new Uint8Array(0);

const REMOTE: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };
const TOKEN = 'ghp_a-token';

const seeded = async (files: Record<string, string>): Promise<MemoryProjectStore> => {
	const store = new MemoryProjectStore();
	for (const [path, content] of Object.entries(files)) {
		await store.write(path, encode(content));
	}
	return store;
};

/** Plan and publish in one go, which is what every caller does and what the criteria are about. */
const publish = async (store: MemoryProjectStore, github: FakeGitHub) => {
	const plan = await planRemotePublish(store, {
		token: TOKEN,
		remote: REMOTE,
		fetch: github.fetch
	});
	return publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });
};

/**
 * A Remote whose responses carry no rate-limit headers at all.
 *
 * Not exotic: a corporate proxy strips them, and nothing obliges a response to carry them. The
 * engine has to read that as *unknown*, because `Number(null)` is `0` and a budget silently read as
 * nought turns every later 403 into "wait for the reset".
 */
const withoutBudgetHeaders =
	(github: FakeGitHub): FetchFn =>
	async (input, init) => {
		const response = await github.fetch(input, init);
		const headers = new Headers(response.headers);
		headers.delete('X-RateLimit-Remaining');
		headers.delete('X-RateLimit-Reset');
		return new Response(response.body, { status: response.status, headers });
	};

/** A Workspace with one small Project, its shared pyramid, and a viewer already written into it. */
const smallWorkspace = () =>
	seeded({
		'ballastella-site.json': '{"formatVersion":2,"projects":[{"directory":"amsterdam-1625"}]}',
		'index.html': '<!doctype html>',
		'_app/immutable/entry/start.AAAA.js': 'export const start = 1;',
		'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
		'amsterdam-1625/annotations/notes.json': '{"type":"FeatureCollection","features":[]}',
		'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}',
		'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
		// alignment-write-is-the-fixture: an Alignment already in the Workspace, seeded so the publish has one to send; nothing here edits Control Points
		'alignments/blaeu.json': '{"type":"Annotation"}'
	});

describe('publishing a Workspace to its Remote', () => {
	it('sends every Workspace file at its Workspace-relative path, and `.nojekyll` with it', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		await publish(store, github);

		expect([...github.files().keys()]).toEqual([
			'.nojekyll',
			'_app/immutable/entry/start.AAAA.js',
			'alignments/blaeu.json',
			'amsterdam-1625/annotations/notes.json',
			'amsterdam-1625/project.json',
			'ballastella-site.json',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg',
			'images/blaeu/info.json',
			'index.html'
		]);
		expect(decode(github.files().get('images/blaeu/info.json') ?? new Uint8Array())).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
	});

	it('publishes an offline Base Map’s tiles along with everything else (SPEC story 62)', async () => {
		// `base-map/tiles/` is inside the owned namespace on purpose (ADR-0033): excluded, the folder
		// would say the site has geography and the Remote would not, and the two would disagree about
		// what the site is.
		const store = await seeded({
			'index.html': '<!doctype html>',
			'base-map/tiles/amsterdam-3f2a/12/2094/1339.mvt': 'mvt-bytes',
			'base-map/tiles/amsterdam-3f2a/12/2095/1339.mvt': 'more-mvt-bytes'
		});
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		await publish(store, github);

		expect([...github.files().keys()].filter((path) => path.startsWith('base-map/'))).toEqual([
			'base-map/tiles/amsterdam-3f2a/12/2094/1339.mvt',
			'base-map/tiles/amsterdam-3f2a/12/2095/1339.mvt'
		]);
	});

	it('creates the ref when the repository is empty', async () => {
		const store = await seeded({ 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

		const { commit } = await publish(store, github);

		expect([github.head(), github.history(), [...github.files().keys()]]).toEqual([
			commit,
			[commit],
			['.nojekyll', 'index.html']
		]);
	});
});

/** The whole of `smallWorkspace` on the Remote, plus the `README.md` those fixtures start with. */
const SECOND_PUBLISH_PATHS = [
	'.nojekyll',
	'README.md',
	'_app/immutable/entry/start.AAAA.js',
	'alignments/blaeu.json',
	'amsterdam-1625/annotations/notes.json',
	'amsterdam-1625/project.json',
	'ballastella-site.json',
	'images/blaeu/0,0,256,256/256,256/0/default.jpg',
	'images/blaeu/info.json',
	'index.html'
];

describe('a second publish', () => {
	it('sends no blob at all when nothing changed, and still moves the ref', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const first = await publish(store, github);
		const posted = github.blobPosts;

		const second = await publish(store, github);

		expect([github.blobPosts - posted, second.commit === first.commit]).toEqual([0, false]);
		expect([github.head(), github.history().length]).toEqual([second.commit, 3]);
		// The tree, not just the counter: an engine that committed an *empty* tree the second time
		// sends no blob and moves the ref too, and every other assertion here would pass over it.
		expect([...github.files().keys()]).toEqual(SECOND_PUBLISH_PATHS);
		expect(decode(github.files().get('images/blaeu/info.json') ?? EMPTY)).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
	});

	it('sends exactly one blob when one Annotation changed', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		await publish(store, github);
		const posted = github.blobPosts;

		await store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"a1"}]}')
		);
		await publish(store, github);

		expect(github.blobPosts - posted).toBe(1);
		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a1"}]}'
		);
		// The nine files that did not change are still there, at their bytes: uploading only what
		// changed and committing only what changed are the same mistake one step apart.
		expect([...github.files().keys()]).toEqual(SECOND_PUBLISH_PATHS);
		expect(decode(github.files().get('images/blaeu/info.json') ?? EMPTY)).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
		expect(decode(github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
	});

	// ⚠ **A file edited between the plan and the upload is the ordinary case, not a race to shrug at.**
	// This editor autosaves continuously and a pyramid upload runs for minutes. Committed under its
	// plan-time SHA the failure is silent in both directions: the blob is not on the Remote and
	// `POST /git/trees` 422s after every byte has been sent, or — worse, and what this test provokes —
	// the *old* blob is there from the first publish, the commit succeeds, and the site serves the
	// pre-edit content while the publish reports success.
	it('commits the bytes it actually sent when a file changes during the publish', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		await publish(store, github);

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});
		// The edit lands after the plan has hashed the file and before the publish reads it — which is
		// what the autosave the scholar cannot see does.
		await store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"typed-while-uploading"}]}')
		);
		await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"typed-while-uploading"}]}'
		);
	});

	it('uploads a file the plan thought unchanged when its bytes have moved on', async () => {
		// The other half: the plan marked this path `onRemote`, so an engine reading the plan's flag
		// never re-reads it at all. Provoked with a store that answers different bytes on the second
		// read of the path, which is what a save between the two passes amounts to.
		const store = await seeded({ 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		await publish(store, github);

		const posted = github.blobPosts;
		const read = store.read.bind(store);
		let readsOfIndex = 0;
		vi.spyOn(store, 'read').mockImplementation(async (path) => {
			if (path !== 'index.html') return read(path);
			readsOfIndex += 1;
			// The plan sees what the Remote already holds; the publish sees the save that happened in
			// between.
			return readsOfIndex > 1 ? encode('<!doctype html><title>Atlas</title>') : read(path);
		});

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});
		await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		expect(plan.uploads).toBe(0);

		expect(github.blobPosts - posted).toBe(1);
		expect(decode(github.files().get('index.html') ?? EMPTY)).toBe(
			'<!doctype html><title>Atlas</title>'
		);
	});

	it('posts one blob for two paths holding the same bytes', async () => {
		// Every blank pyramid tile is byte-identical to every other, so this is the ordinary case for a
		// Historical Map with margins — and a blob posted twice spends two of the one hourly budget
		// ADR-0033 singles out.
		const store = await seeded({
			'index.html': '<!doctype html>',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'blank-tile',
			'images/blaeu/0,256,256,256/256,256/0/default.jpg': 'blank-tile'
		});
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});
		await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		// Four paths, three blobs: the two tiles, `index.html`, and the empty `.nojekyll`.
		expect([plan.files.length, plan.uploads, github.blobPosts]).toEqual([4, 3, 3]);
		expect(
			[...github.files()]
				.filter(([path]) => path.startsWith('images/'))
				.map(([path, bytes]) => [path, decode(bytes)])
		).toEqual([
			['images/blaeu/0,0,256,256/256,256/0/default.jpg', 'blank-tile'],
			['images/blaeu/0,256,256,256/256,256/0/default.jpg', 'blank-tile']
		]);
	});
});

describe('the owned namespace (ADR-0033)', () => {
	it('carries a CNAME, a README, and a docs folder through untouched', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				CNAME: 'atlas.example\n',
				'README.md': '# Atlas\n',
				'docs/guide.md': 'How to read this edition\n'
			}
		});

		await publish(store, github);

		const files = github.files();
		expect([
			decode(files.get('CNAME') ?? EMPTY),
			decode(files.get('README.md') ?? EMPTY),
			decode(files.get('docs/guide.md') ?? EMPTY)
		]).toEqual(['atlas.example\n', '# Atlas\n', 'How to read this edition\n']);
	});

	it('carries a submodule the Remote holds into the new tree', async () => {
		// A gitlink is `type: 'commit'`, mode 160000, and matches no rule in the owned namespace, so it
		// is preserve-by-default — ADR-0033's one unconditional promise. A tree read filtered to blobs
		// drops it before `preserved` is computed, and every publish then deletes it silently.
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: { 'README.md': '# Atlas\n' },
			submodules: { theme: 'f'.repeat(40) }
		});

		await publish(store, github);

		expect([...github.gitlinks()]).toEqual([['theme', 'f'.repeat(40)]]);
		expect([...github.files().keys()]).toContain('README.md');
	});

	it('removes a Project the Remote still has and the Workspace does not, with its pyramid', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				CNAME: 'atlas.example\n',
				// A Project is a top-level directory holding a `project.json` and nothing else is
				// (ADR-0008), so this is how the Remote — not the Workspace — recognises it as ours.
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}',
				'florida-1657/annotations/notes.json': '{"type":"FeatureCollection"}',
				// Its Historical Map, at the Workspace root because a pyramid is shared (ADR-0023).
				'images/moll/info.json': '{"id":"https://unset.invalid/moll"}',
				'images/moll/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
				// alignment-write-is-the-fixture: the deleted map's Alignment as it still stands on the Remote, whose removal is the assertion
				'alignments/moll.json': '{"type":"Annotation"}'
			}
		});

		await publish(store, github);

		const paths = [...github.files().keys()];
		expect(paths.filter((path) => path.startsWith('florida-1657/'))).toEqual([]);
		expect(paths.filter((path) => path.includes('moll'))).toEqual([]);
		expect(paths).toContain('CNAME');
		expect(paths).toContain('amsterdam-1625/project.json');
	});
});

describe('the refusals, both of which cost the Remote nothing', () => {
	it('refuses a truncated tree, quoting the file count, before any blob is posted', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: { CNAME: 'atlas.example\n', 'README.md': '# Atlas\n', 'docs/guide.md': 'How to\n' }
		});
		// The real endpoint truncates at 100 000 entries or a 7 MB response and **answers 200**, so a
		// publish that did not look would upload everything again and commit a tree missing most of a
		// Workspace.
		github.truncateAfter = 3;
		const before = github.head();

		const refusal = planRemotePublish(store, { token: TOKEN, remote: REMOTE, fetch: github.fetch });

		await expect(refusal).rejects.toThrow(RemotePublishRefusedError);
		// Two, not three: a recursive listing carries an entry per directory as well, so the first
		// three entries here are `CNAME`, `README.md`, and the `docs` folder. The ticket asks for the
		// file count, and quoting the folder would tell a scholar to delete files they do not have.
		await expect(refusal).rejects.toThrow(/\b2 files\b/);
		expect([github.blobPosts, github.head()]).toEqual([0, before]);
	});

	it('refuses a repository GitHub cannot show it, rather than planning it as an empty one', async () => {
		// GitHub answers 404 both for a repository that does not exist and for one the token cannot
		// see, which is the same status an empty repository's missing ref gives. Read as empty, a
		// typo'd name is planned as a full upload with no warning and surfaces at the first blob POST.
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: {} });

		const refusal = planRemotePublish(store, {
			token: TOKEN,
			remote: { owner: 'ada', repository: 'atals', branch: 'main' },
			fetch: github.fetch
		});

		await expect(refusal).rejects.toThrow(RemotePublishRefusedError);
		await expect(refusal).rejects.toThrow(/ada\/atals/);
		expect(github.blobPosts).toBe(0);
	});

	// ⚠ **A repository with no commits answers 409 `Git Repository is empty.`, not 404**, and reading
	// that as an ordinary refusal kills the *first* publish to a repository the scholar created a
	// moment ago — which is precisely the repository the "create it yourself" link in ticket 03 hands
	// them back from, and the only publish that cannot have gone wrong yet.
	it('plans a first publish to a repository with no commits rather than refusing it', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect([plan.head, plan.uploads, plan.preserved]).toEqual([null, 9, []]);
	});

	it('refuses a Workspace of more files than a publish can list, quoting both numbers', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		// A spy rather than 40 001 real files: what is asserted is the ceiling and the sentence, not
		// the walk — and the point of counting first is that nothing is read on the way to a refusal.
		const paths = Array.from({ length: MAX_PUBLISHED_FILES + 1 }, (_, at) => `images/x/${at}.jpg`);
		vi.spyOn(store, 'list').mockResolvedValue(paths);
		vi.spyOn(store, 'size').mockResolvedValue(10);
		const read = vi.spyOn(store, 'read');

		const refusal = planRemotePublish(store, { token: TOKEN, remote: REMOTE, fetch: github.fetch });

		await expect(refusal).rejects.toThrow(RemotePublishRefusedError);
		await expect(refusal).rejects.toThrow(/40001 files/);
		await expect(refusal).rejects.toThrow(/40000/);
		expect([read.mock.calls.length, github.blobPosts]).toEqual([0, 0]);
	});
});

describe('the three budgets (ADR-0033)', () => {
	it('warns when the site would pass the static-hosting limit', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		// Offline Base Map tiles are file-cheap and byte-heavy — about 152 kB each — so the byte axis
		// is reached by a Workspace with very few files in it. Sized rather than allocated: the
		// arithmetic and the sentence are what is under test.
		vi.spyOn(store, 'size').mockResolvedValue(STATIC_HOSTING_LIMIT_BYTES / 4);

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect(plan.warnings.map((warning) => warning.kind)).toEqual(['hosting-limit']);
		expect(plan.warnings[0]?.message).toContain('2.0 GB');
		expect(plan.warnings[0]?.message).toContain('1.0 GB');
	});

	it('warns when the new blobs outnumber the requests left this hour, naming the reset', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		// Four, of which the plan's own ref and tree calls spend two.
		github.rateLimit = { remaining: 4, reset: 1_800_000_000 };

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect([plan.uploads, plan.requestsRemaining]).toEqual([9, 2]);
		expect(plan.warnings.map((warning) => warning.kind)).toEqual(['request-budget']);
		expect(plan.warnings[0]?.message).toContain('9 new files');
		expect(plan.warnings[0]?.message).toContain('2 more requests');
		// The reset is named rather than left as "later", which is the whole of story 11.
		expect(plan.warnings[0]?.message).toMatch(/\d{1,2}:\d{2}/);
	});

	it('counts the tree, the commit and the ref move alongside the blobs', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		// Eleven, of which the plan's own ref and tree calls spend two, leaving exactly the nine blobs
		// this Workspace sends. Room for every blob and none for the commit: uncounted, this publish
		// uploads all nine and then meets the 403 at `POST /git/trees` — the most expensive possible
		// place to stop, with the bytes spent and nothing visible.
		github.rateLimit = { remaining: 11, reset: 1_800_000_000 };

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect([plan.uploads, plan.requestsRemaining]).toEqual([9, 9]);
		expect(plan.warnings.map((warning) => warning.kind)).toEqual(['request-budget']);
		expect(plan.warnings[0]?.message).toContain('12 requests in all');
	});

	it('reads an absent rate-limit header as unknown rather than as a budget of nought', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: withoutBudgetHeaders(github)
		});

		// `Number(null)` is `0` and `Number.isFinite(0)` is `true`, so an unguarded read makes this
		// nought — and warns that GitHub allows no more requests at all this hour.
		expect([plan.requestsRemaining, plan.requestsResetAt, plan.warnings]).toEqual([null, null, []]);
	});

	it('says nothing about any of the three when a small Workspace has room', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect([plan.warnings, plan.workspace.files, plan.uploads]).toEqual([[], 8, 9]);
	});
});

describe('a budget spent part way through', () => {
	it('stops, says how many files went and when it resets, and leaves the ref where it was', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});
		const before = github.head();
		github.rateLimit = { remaining: 2, reset: 1_800_000_000 };
		const seen: number[] = [];

		const raised = await publishToRemote(store, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch: github.fetch,
			onProgress: (progress) => seen.push(progress.files)
		}).catch((cause: unknown) => cause);

		expect(raised).toBeInstanceOf(RemotePublishRateLimitedError);
		const error = raised as RemotePublishRateLimitedError;
		expect([error.filesSent, error.totalFiles, error.resetAt?.getTime()]).toEqual([
			2, 9, 1_800_000_000_000
		]);
		expect(error.message).toContain('2 of 9 files');
		expect(error.message).toMatch(/\d{1,2}:\d{2}/);
		// Nothing is visible on the Remote until the ref moves, and it did not (SPEC story 16).
		expect([github.head(), [...github.files().keys()]]).toEqual([before, ['README.md']]);
		expect(seen).toEqual([0, 1, 2]);
	});

	it('does not offer to pick up where it stopped, because it cannot', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});
		github.rateLimit = { remaining: 2, reset: 1_800_000_000 };

		const raised = (await publishToRemote(store, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch: github.fetch
		}).catch((cause: unknown) => cause)) as RemotePublishRateLimitedError;

		// The two blobs that landed are loose objects in no tree, so the next plan's tree listing
		// cannot see them and `plan.files` — sorted and deterministic — re-sends the same two first.
		expect(raised.message).toContain('starts the upload again from the beginning');
		expect(raised.message).not.toMatch(/only what is left|picks up where|already sent are kept/);
	});

	it('names the tree rather than the upload when the budget runs out after the last blob', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});
		const before = github.head();
		// Exactly the nine blobs and nothing for the commit, so every file lands and `POST /git/trees`
		// is the request refused. "Ran out after 9 of 9 files" would describe a phase that completed.
		github.rateLimit = { remaining: 9, reset: 1_800_000_000 };

		const raised = (await publishToRemote(store, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch: github.fetch
		}).catch((cause: unknown) => cause)) as RemotePublishRateLimitedError;

		expect(raised).toBeInstanceOf(RemotePublishRateLimitedError);
		expect([raised.phase, raised.filesSent, raised.totalFiles]).toEqual(['tree', 9, 9]);
		expect(raised.message).toContain('All 9 files had been sent');
		expect(raised.message).toContain('building the tree');
		expect([github.head(), [...github.files().keys()]]).toEqual([before, ['README.md']]);
	});

	it('reports a 403 with no budget header as a refusal, not as a wait for the reset', async () => {
		// A token without `contents: write`, or a SAML-blocked org, is a 403 too. Told apart by the
		// remaining count, an unreadable header makes that count nought and every such refusal reads
		// as a rate limit — telling a scholar to wait an hour for a reset that will not help.
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const fetch = withoutBudgetHeaders(github);
		const plan = await planRemotePublish(store, { token: TOKEN, remote: REMOTE, fetch });
		github.refuseWrites = true;

		const raised = await publishToRemote(store, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch
		}).catch((cause: unknown) => cause);

		expect(raised).toBeInstanceOf(RemotePublishFailedError);
		expect(raised).not.toBeInstanceOf(RemotePublishRateLimitedError);
		expect((raised as Error).message).toContain('Resource not accessible by personal access token');
	});
});
