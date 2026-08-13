import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { STATIC_HOSTING_LIMIT_BYTES } from '../project/workspace-size.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import {
	MAX_PUBLISHED_FILES,
	RemotePublishCredentialError,
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

/**
 * Plan and publish in one go, which is what every caller does and what the criteria are about.
 *
 * `manifest` is what this machine last saw on the Remote. Left out it is *no record*, which is right
 * for a first publish and is what makes the conflict refusal fire on a Remote already holding files
 * this app would publish over; a case about a *second* publish threads the first one's manifest
 * through, exactly as `EditorSession` does with `PublishManifests`.
 */
const publish = async (
	store: MemoryProjectStore,
	github: FakeGitHub,
	manifest: ReadonlyMap<string, string> | null = null
) => {
	const plan = await planRemotePublish(store, {
		token: TOKEN,
		remote: REMOTE,
		fetch: github.fetch,
		manifest
	});
	return publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });
};

/**
 * A manifest claiming **everything** on the Remote as this machine's own work.
 *
 * ⚠ **The SHAs are genuine; the claim is the fake part, and the name says so.** They are computed by
 * the same function both sides of the wire use, so what this stands in for is not the hashing but the
 * *provenance*: it records every path present, whoever put it there. Handed a fake seeded with
 * another machine's Project it would assert that Project is ours and switch the conflict refusal off
 * — which is exactly the shape ticket 07's carryover (a) warns about, a manifest built from a listing
 * rather than from what was written.
 *
 * Sound only where the fixture is a Remote this Workspace demonstrably wrote, which is its one use
 * below: a Project deleted here, whose removal there is the assertion.
 */
const claimingEverythingOnTheRemote = async (github: FakeGitHub): Promise<Map<string, string>> => {
	const seen = new Map<string, string>();
	for (const [path, bytes] of github.files()) seen.set(path, await gitBlobSha(bytes));
	return seen;
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

		const second = await publish(store, github, first.manifest);

		expect([github.blobPosts - posted, second.commit === first.commit]).toEqual([0, false]);
		expect([github.head(), github.history().length]).toEqual([second.commit, 3]);
		// The tree, not just the counter: an engine that committed an *empty* tree the second time
		// sends no blob and moves the ref too, and every other assertion here would pass over it.
		expect([...github.files().keys()]).toEqual(SECOND_PUBLISH_PATHS);
		expect(decode(github.files().get('images/blaeu/info.json') ?? EMPTY)).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
	});

	// ⚠ **The fact "nothing needed changing" is made of, and `onRemote` is not it.** `onRemote` asks
	// whether the Remote holds a file's *bytes* anywhere at all, so a Workspace whose every file is
	// `onRemote` may still be one a Project has been deleted from — the deletion is a path the Remote
	// holds and the Workspace does not, and no file-by-file question can see it. A caller offering a
	// scholar "nothing needed changing" and then not publishing has to be reading the whole tree.
	describe('the plan’s account of whether anything would change', () => {
		it('is unchanged when the Remote already holds exactly this Workspace', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch
			});

			expect([plan.unchanged, plan.uploads]).toEqual([true, 0]);
		});

		it('is changed when a Project has been deleted here, which no blob count can see', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);
			await store.delete('amsterdam-1625/project.json');
			await store.delete('amsterdam-1625/annotations/notes.json');

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch
			});

			// Every remaining file's bytes are on the Remote, so the upload is empty and the tree is not.
			expect([plan.unchanged, plan.uploads]).toEqual([false, 0]);
		});

		it('is changed for a first publish, where there is no tree to be the same as', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch
			});

			expect([plan.head, plan.unchanged]).toEqual([null, false]);
		});
	});

	it('sends exactly one blob when one Annotation changed', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const first = await publish(store, github);
		const posted = github.blobPosts;

		await store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"a1"}]}')
		);
		await publish(store, github, first.manifest);

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
		const first = await publish(store, github);

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch,
			manifest: first.manifest
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
		const first = await publish(store, github);

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
			fetch: github.fetch,
			manifest: first.manifest
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

	// ⚠ **The manifest is a claim of authorship, so it may hold only what this publish sent.** A
	// preserved path's SHA comes straight from the tree listing and nothing here has read its bytes —
	// harmless while a preserved path is non-owned by construction and the conflict check reads only
	// owned paths, and licence to delete the moment a path changes hands: the Remote gains a
	// `project.json` for a directory whose files were preserved last time, and those unverified SHAs
	// become this machine saying it put them there.
	it('records what it wrote and never what it merely carried through', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: { 'README.md': '# Atlas\n', CNAME: 'atlas.example\n' }
		});

		const { manifest } = await publish(store, github);

		expect([...manifest.keys()].sort()).toEqual([
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
		// Preserved, committed, and unclaimed: on the Remote and not in the record.
		expect([...github.files().keys()]).toContain('CNAME');
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

		// This machine put every one of those paths there, which is what makes removing them a
		// deletion rather than an overwrite of somebody else's work — see the conflict refusal.
		await publish(store, github, await claimingEverythingOnTheRemote(github));

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

	/**
	 * ⚠ **The forecast runs before the local publish writes, which is the whole of ticket 04's flow.**
	 * The dialog shows these three numbers and *then* writes `index.html`, `_app/**`,
	 * `ballastella-site.json` and — when the box is ticked — the Base Map's five megabytes into the
	 * Workspace. Counted only off the store as it stands, all three understate a first publish: the
	 * files line is short by the whole website, the byte line by its bytes, and the request warning by
	 * its blobs, which is the one that decides whether a scholar is told to wait for the reset.
	 */
	describe('what the local publish is about to write', () => {
		/** A Workspace with no website in it yet, which is what a first publish plans against. */
		const beforeTheFirstPublish = () =>
			seeded({
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
				'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}'
			});

		/** The viewer bundle and the Base Map's glyphs, as a local plan enumerates them. */
		const website = [
			{ path: 'index.html', bytes: 400 },
			{ path: '_app/immutable/entry/start.AAAA.js', bytes: 2_000 },
			{ path: 'ballastella-site.json', bytes: 300 },
			{ path: 'base-map/fonts/Noto/0-255.pbf', bytes: 5_000_000 }
		];

		it('counts into the files, the bytes and the blobs it will need', async () => {
			const store = await beforeTheFirstPublish();
			const github = await createFakeGitHub({ ...REMOTE, tree: {} });

			const bare = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch
			});
			const whole = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				pending: website
			});

			// Three files: the two the Workspace holds and the `.nojekyll` a publish authors.
			expect([bare.pending.length, bare.uploads, whole.uploads]).toEqual([0, 3, 7]);
			expect(whole.bytes - bare.bytes).toBe(5_002_700);
			expect(whole.uploadBytes - bare.uploadBytes).toBe(5_002_700);
			expect(whole.pending.map((file) => file.path)).toEqual(website.map((file) => file.path));
		});

		it('warns about the hour’s budget on a count the website is in', async () => {
			const store = await beforeTheFirstPublish();
			const github = await createFakeGitHub({ ...REMOTE, tree: {} });
			// Room for the three files the Workspace holds, the tree, the commit and the ref move — and
			// none for the website. Uncounted, this publish is forecast to fit and stops part way.
			github.rateLimit = { remaining: 8, reset: 1_800_000_000 };

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				pending: website
			});

			expect(plan.warnings.map((warning) => warning.kind)).toEqual(['request-budget']);
			expect(plan.warnings[0]?.message).toContain('7 new files');
			expect(plan.warnings[0]?.message).toContain('10 requests in all');
		});

		it('is not "nothing needs changing" when a website is about to arrive', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				pending: [...website]
			});

			expect([plan.unchanged, plan.pending.map((file) => file.path)]).toEqual([
				false,
				['base-map/fonts/Noto/0-255.pbf']
			]);
		});

		// A second publish rewrites the whole viewer over the copy already in the Workspace, so the
		// same list arrives held and adds nothing at all: "nothing needed changing" has to survive it.
		it('ignores what the Workspace already holds', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				// `.nojekyll` among them: a publish authors it, and the local plan lists it too.
				pending: [
					{ path: 'index.html', bytes: 400 },
					{ path: '.nojekyll', bytes: 0 },
					{ path: '_app/immutable/entry/start.AAAA.js', bytes: 2_000 }
				]
			});

			expect([plan.pending, plan.unchanged, plan.uploads]).toEqual([[], true, 0]);
		});
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

	it('tells a credential GitHub will not look at apart from a repository it will not write', async () => {
		// ⚠ The stale-sign-in question ticket 03 recorded and ticket 04 settled. Rights are read at a
		// bind and at a paste and at no other moment, so a token that has since expired still reads
		// "Signed in to GitHub" — and collapsed into the general refusal it reaches the scholar as
		// "GitHub refused this publish: Bad credentials", sending them to check a repository that is
		// fine. The remedy is a sign-in, and the sentence has to say so.
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		github.rejectCredential = true;

		const raised = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		}).catch((cause: unknown) => cause);

		expect(raised).toBeInstanceOf(RemotePublishCredentialError);
		expect((raised as Error).message).toContain('sign-in has expired');
		expect((raised as Error).message).toContain('ada/atlas');
		// It arrives before a byte is sent, because a publish asks GitHub a credentialed question
		// before it uploads anything — which is what makes "leave the label, let the refusal carry it"
		// a safe answer for a Workspace of four thousand tiles.
		expect(github.blobPosts).toBe(0);
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

// ── The conflict refusal (ADR-0033, "The publish manifest, and the two refusals") ──────────────
//
// ⚠ **A manifest compared the wrong way round overwrites another machine's Annotation, and no
// count of requests can see it.** So every case below asserts what is on the Remote afterwards —
// whose bytes are at the path, and whether the paths a Workspace does not have are still there —
// and the refusal's own words are asserted only where the words are the deliverable.
describe('a publish that would overwrite another machine', () => {
	/**
	 * The desktop's afternoon, arriving on the Remote after the laptop last looked.
	 *
	 * Both Workspaces start as copies of one another with the same evidence about the Remote, which
	 * is what two machines bound to one repository are: the second is a Clone of the first, or the
	 * same Workspace restored from a Backup. Then one of them does an afternoon's work.
	 *
	 * @returns the fake, the laptop's Workspace, and the evidence the laptop still holds
	 */
	const afternoonOnTheOtherMachine = async () => {
		const desktop = await smallWorkspace();
		const laptop = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });

		const shared = await publish(desktop, github);
		await desktop.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}')
		);
		await publish(desktop, github, shared.manifest);

		return { github, laptop, lastSeen: shared.manifest };
	};

	const laptopPlan = (
		laptop: MemoryProjectStore,
		github: FakeGitHub,
		lastSeen: ReadonlyMap<string, string>
	) =>
		planRemotePublish(laptop, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch,
			manifest: lastSeen
		});

	it('refuses, names the changed path, and leaves the other machine’s work on the Remote', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const plan = await laptopPlan(laptop, github, lastSeen);
		const posted = github.blobPosts;
		const head = github.head();

		expect([plan.conflict?.reason, plan.conflict?.paths]).toEqual([
			'changed',
			['amsterdam-1625/annotations/notes.json']
		]);
		await expect(
			publishToRemote(laptop, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch })
		).rejects.toBeInstanceOf(RemotePublishRefusedError);
		// The half that matters: the desktop's afternoon is still there, and the refusal cost the
		// Remote nothing at all — not a blob, not a commit, not a ref move.
		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		);
		expect([github.blobPosts - posted, github.head()]).toEqual([0, head]);
	});

	it('offers both remedies in the refusal, naming the file it is about', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const message = (await laptopPlan(laptop, github, lastSeen)).conflict?.message ?? '';

		expect(message).toContain('amsterdam-1625/annotations/notes.json');
		expect(message).toContain('Clone ada/atlas into a new Workspace');
		expect(message).toContain('publish anyway');
		// The sentence that makes the second remedy safe to press: the owned namespace preserves
		// everything outside itself, so nothing but this app's own files is at stake (ADR-0033).
		expect(message).toContain('CNAME');
		// ⚠ **And it promises about paths, never about names.** A publish sends everything the store
		// lists, so a folder-backed Workspace holding its own `README.md` or `CNAME` publishes it like
		// any other file — outside the owned namespace, so the refusal would not have flagged it either.
		// "A README is left alone" is false for exactly the scholar it would most annoy, and this
		// sentence is load-bearing for the decision it sits under.
		expect(message).toContain('has no file for');
		expect(message).not.toMatch(/anything else in the repository/);
	});

	it('publishes anyway when told to, replacing what was there', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const plan = await laptopPlan(laptop, github, lastSeen);
		await publishToRemote(laptop, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch: github.fetch,
			replace: true
		});

		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		// Replacing is still ADR-0033's mirror and not a force push: everything outside the owned
		// namespace survives a replace exactly as it survives an ordinary publish.
		expect(decode(github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
	});

	// ⚠ **A publish that would *delete*, which is the destructive half of the same comparison.** An
	// owned path on the Remote that this publish would not write is a path the mirror removes, and the
	// second filter is the only thing between "a Project deleted here goes there too" and "a Project
	// this Workspace has never had is taken down by somebody who cannot see it". Turn that filter into
	// a no-op and every other test in this file still passes.
	describe('a Project on the Remote this Workspace has never had', () => {
		/** A first publish, and then another machine adding a Project of its own. */
		const aProjectFromSomewhereElse = async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			const first = await publish(store, github);
			await github.commitFiles({
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}',
				'florida-1657/annotations/notes.json': '{"type":"FeatureCollection","features":[]}'
			});
			return { store, github, lastSeen: first.manifest };
		};

		it('is refused, and is still on the Remote afterwards', async () => {
			const { store, github, lastSeen } = await aProjectFromSomewhereElse();

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				manifest: lastSeen
			});

			// Neither what this publish would write — it writes nothing at those paths — nor what the
			// manifest last saw, which is what makes them somebody else's rather than ours to remove.
			expect([plan.conflict?.reason, plan.conflict?.paths]).toEqual([
				'changed',
				['florida-1657/annotations/notes.json', 'florida-1657/project.json']
			]);
			await expect(
				publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch })
			).rejects.toBeInstanceOf(RemotePublishRefusedError);
			// The assertion the refusal exists for: the Project is still there, whole.
			expect([...github.files().keys()].filter((path) => path.startsWith('florida-1657/'))).toEqual(
				['florida-1657/annotations/notes.json', 'florida-1657/project.json']
			);
		});

		it('is removed once the scholar says to replace it', async () => {
			const { store, github, lastSeen } = await aProjectFromSomewhereElse();

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				manifest: lastSeen
			});
			await publishToRemote(store, {
				token: TOKEN,
				remote: REMOTE,
				plan,
				fetch: github.fetch,
				replace: true
			});

			expect([...github.files().keys()].filter((path) => path.startsWith('florida-1657/'))).toEqual(
				[]
			);
			expect(decode(github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
		});
	});

	// ⚠ **The consent is about a set of files, not about a moment.** An interface that forecasts,
	// publishes locally and then plans again — which `EditorSession.publishToRemote` must, or it would
	// commit a site with no `index.html` — hands this a plan the scholar never read. A bare `true`
	// would apply their answer about one Annotation to whatever the second listing found, and the ref
	// move cannot catch it: the second plan is parented on the new head, so its commit is an ordinary
	// fast-forward.
	describe('an agreement to replace, carried across a re-plan', () => {
		it('goes ahead when the second plan’s conflict is the one that was agreed to', async () => {
			const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();
			const shown = await laptopPlan(laptop, github, lastSeen);

			const again = await laptopPlan(laptop, github, lastSeen);
			await publishToRemote(laptop, {
				token: TOKEN,
				remote: REMOTE,
				plan: again,
				fetch: github.fetch,
				replace: shown.conflict?.paths ?? []
			});

			expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
				'{"type":"FeatureCollection","features":[]}'
			);
		});

		it('refuses when the Remote gained a Project between the offer and the acceptance', async () => {
			const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();
			const shown = await laptopPlan(laptop, github, lastSeen);

			// The window is the local publish and the upload, which on a large Workspace is minutes.
			await github.commitFiles({
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}'
			});
			const head = github.head();
			const again = await laptopPlan(laptop, github, lastSeen);

			const raised = await publishToRemote(laptop, {
				token: TOKEN,
				remote: REMOTE,
				plan: again,
				fetch: github.fetch,
				replace: shown.conflict?.paths ?? []
			}).catch((cause: unknown) => cause);

			expect(raised).toBeInstanceOf(RemotePublishRefusedError);
			// It names what was *not* agreed to, and not the file that was: the scholar has decided about
			// that one already, and repeating it would bury the news underneath it.
			expect((raised as Error).message).toContain('florida-1657/project.json');
			expect((raised as Error).message).not.toContain('amsterdam-1625/annotations/notes.json');
			// And the Project nobody was shown is still there, on a branch that never moved.
			expect(github.head()).toBe(head);
			expect([...github.files().keys()]).toContain('florida-1657/project.json');
		});
	});

	// ADR-0033 rejects a bare commit-SHA comparison for exactly this: it refuses whenever *anything*
	// moved, and a check that cries wolf is one people learn to force through.
	it('is not triggered by a file changed outside the owned namespace', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const first = await publish(store, github);

		// The scholar edits their README on github.com, which no publish here has ever written.
		await github.commitFiles({ 'README.md': '# Atlas\n\nA collection of city plans.\n' });
		await store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"a1"}]}')
		);
		await publish(store, github, first.manifest);

		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a1"}]}'
		);
		// And their edit is still theirs: preserved, not reverted to the copy the manifest saw.
		expect(decode(github.files().get('README.md') ?? EMPTY)).toBe(
			'# Atlas\n\nA collection of city plans.\n'
		);
	});

	it('replaces a path whose Remote SHA is the one the manifest last saw', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const first = await publish(store, github);

		await store.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"mine"}]}')
		);
		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch,
			manifest: first.manifest
		});
		await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		expect(plan.conflict).toBeNull();
		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"mine"}]}'
		);
	});

	describe('with no manifest at all', () => {
		it('refuses a Remote whose owned namespace is not empty, saying we cannot tell', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);
			// The manifest is lost — a cleared browser, a second machine, a Workspace restored from a
			// Backup. The Workspace and the Remote are unchanged; only the evidence has gone.
			const posted = github.blobPosts;

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				manifest: null
			});

			expect(plan.conflict?.reason).toBe('unknown');
			expect(plan.conflict?.message).toContain('nothing here can tell');
			// Said as the ordinary state it is, because every Workspace cloned from a Remote is in it
			// until it has published once (story 24).
			expect(plan.conflict?.message).toContain('not a sign that anything has gone wrong');
			// ⚠ **And it does not threaten a deletion, because there is none.** Every owned path on the
			// Remote is one this Workspace holds, so nothing would come down — which is what makes the
			// plain wording honest here and is the fact that separates this reader from the one below.
			expect(plan.conflict?.message).toContain('take nothing down');
			expect(plan.conflict?.message).not.toMatch(/would delete/);
			await expect(
				publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch })
			).rejects.toBeInstanceOf(RemotePublishRefusedError);
			expect(github.blobPosts - posted).toBe(0);
		});

		// ⚠ **The same refusal, and the reader it must not be reassuring to.** With no manifest the two
		// cases are told apart by one number: how many owned paths on the Remote this publish would
		// neither write nor is about to write, which is how many it would *remove*. A partial Clone, a
		// second machine, and a stale Backup are all here and none of them is ordinary.
		it('names what would be taken down when the Remote holds work this Workspace has not got', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({
				...REMOTE,
				tree: {
					'README.md': '# Atlas\n',
					'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}',
					'florida-1657/annotations/notes.json': '{"type":"FeatureCollection","features":[]}'
				}
			});

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				manifest: null
			});

			expect(plan.conflict?.reason).toBe('unknown');
			expect(plan.conflict?.message).toContain('2 of them are not in this Workspace');
			expect(plan.conflict?.message).toContain('would delete');
			expect(plan.conflict?.message).toContain('florida-1657/project.json');
			// The reassurance the other reader gets is exactly what must not be said to this one.
			expect(plan.conflict?.message).not.toContain('not a sign that anything has gone wrong');
		});

		// The website the local publish is about to write is not a deletion, and counting it as one
		// would put the warning above in front of the *first* publish from a complete Clone — the one
		// press story 24 is entirely about.
		it('does not count the website about to be written as work it would take down', async () => {
			const store = await seeded({
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}'
			});
			const github = await createFakeGitHub({
				...REMOTE,
				tree: {
					'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
					'ballastella-site.json': '{"formatVersion":2,"projects":[]}',
					'index.html': '<!doctype html>'
				}
			});

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				manifest: null,
				pending: [
					{ path: 'index.html', bytes: 400 },
					{ path: 'ballastella-site.json', bytes: 300 }
				]
			});

			expect(plan.conflict?.reason).toBe('unknown');
			expect(plan.conflict?.message).toContain('not a sign that anything has gone wrong');
			expect(plan.conflict?.message).not.toMatch(/would delete/);
		});

		it('publishes to a repository with nothing of ours on it', async () => {
			const store = await smallWorkspace();
			// A `README.md` and nothing else: outside the owned namespace, so there is nothing here to
			// be uncertain about and a first publish must not be refused over it.
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });

			await publish(store, github);

			expect([...github.files().keys()]).toContain('amsterdam-1625/project.json');
			expect(decode(github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
		});

		it('publishes to a repository with no commits at all', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ owner: REMOTE.owner, repository: REMOTE.repository });

			await publish(store, github);

			expect([...github.files().keys()]).toContain('index.html');
		});
	});
});
