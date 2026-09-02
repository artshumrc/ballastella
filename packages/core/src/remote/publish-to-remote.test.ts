import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { STATIC_HOSTING_LIMIT_BYTES } from '../project/workspace-size.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { withdrawShareLinks } from '../publish/publish.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
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

// The in-memory seam, and CONTRIBUTING.md's testing decision in as many words: *a good test here
// asserts what arrived at the Remote, not which calls were made.* Every failure mode here is silent
// and plausible — a truncated tree yields a commit missing most of a pyramid, an off-by-one in the
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

/** What a successful publish leaves this machine holding, as `readBaseline` would answer it. */
const shared = (result: {
	commit: string;
	baseline: ReadonlyMap<string, string>;
}): SynchronizationBaseline => ({ remote: REMOTE, commit: result.commit, files: result.baseline });

/**
 * Plan and publish in one go, which is what every caller does and what the criteria are about.
 *
 * `baseline` is what this machine last saw the two sides share. Left out it is *no record*, which is
 * right for a first publish and is what makes the refusal fire on a Remote already holding source
 * this app would publish over; a case about a *second* publish threads the first one's Baseline
 * through, exactly as `EditorSession` does with `SynchronizationMetadata`.
 */
const publish = async (
	store: MemoryProjectStore,
	github: FakeGitHub,
	baseline: SynchronizationBaseline | null = null
) => {
	const plan = await planRemotePublish(store, {
		token: TOKEN,
		remote: REMOTE,
		fetch: github.fetch,
		baseline
	});
	const result = await publishToRemote(store, {
		token: TOKEN,
		remote: REMOTE,
		plan,
		fetch: github.fetch
	});
	return { ...result, plan };
};

/**
 * A manifest claiming **everything** on the Remote as this machine's own work.
 *
 * ⚠ **The SHAs are genuine; the claim is the fake part, and the name says so.** They are computed by
 * the same function both sides of the wire use, so what this stands in for is not the hashing but the
 * *provenance*: it records every path present, whoever put it there. Handed a fake seeded with
 * another machine's Project it would assert that Project is ours and switch the conflict refusal off
 * — which is exactly the shape to beware of, a manifest built from a listing rather than from what
 * was written.
 *
 * Sound only where the fixture is a Remote this Workspace demonstrably wrote, which is its one use
 * below: a Project deleted here, whose removal there is the assertion.
 */
const claimingEverythingOnTheRemote = async (
	github: FakeGitHub
): Promise<SynchronizationBaseline> => {
	const files = new Map<string, string>();
	for (const [path, bytes] of github.files()) files.set(path, await gitBlobSha(bytes));
	return { remote: REMOTE, commit: github.head() ?? 'seeded', files };
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

/**
 * The site record, whose presence is what having Share Links means (ADR-0045).
 *
 * Spread into a fixture wherever the claim under test is about a Workspace that *has* asked for a
 * site — which, before this Epic, every fixture here silently assumed.
 */
const SITE = { 'ballastella-site.json': '{"formatVersion":2,"projects":[]}' };

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

	it('publishes an offline Base Map’s tiles along with everything else', async () => {
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

	// ⚠ **An empty repository refuses the Git Data API entirely**, `POST /git/blobs` included, so the
	// branch has to exist before the first blob is sent. The publish opens it through the Contents
	// API with `.nojekyll` — the file it must write anyway — and then commits onto that.
	it('opens an empty repository and publishes into it', async () => {
		const store = await seeded({ ...SITE, 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

		const { commit } = await publish(store, github);

		const history = github.history();
		expect([github.head(), history.length, [...github.files().keys()]]).toEqual([
			commit,
			// The seed, and the publish parented onto it. Nothing is force-pushed over.
			2,
			['.nojekyll', 'ballastella-site.json', 'index.html']
		]);
		expect(history[0]).toBe(commit);
		// The seed carried `.nojekyll` and nothing else: a Reader who arrived between the two commits
		// would find no half-published site, only a repository with the marker in it.
		expect([...github.files(history[1]).keys()]).toEqual(['.nojekyll']);
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

		const second = await publish(store, github, shared(first));

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
			const first = await publish(store, github);
			await store.delete('amsterdam-1625/project.json');
			await store.delete('amsterdam-1625/annotations/notes.json');

			// The Baseline threaded through, because it is what licenses the removal at all: with no
			// record of what the two last shared a send takes nothing down (ADR-0044).
			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: shared(first)
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
		await publish(store, github, shared(first));

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
			baseline: shared(first)
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
		const store = await seeded({ ...SITE, 'index.html': '<!doctype html>' });
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
			baseline: shared(first)
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
		// Map Image with margins — and a blob posted twice spends two of the one hourly budget
		// ADR-0033 singles out.
		const store = await seeded({
			...SITE,
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

		// Five paths, four blobs: the two tiles are one between them, beside `index.html`, the site
		// record, and the empty `.nojekyll`.
		expect([plan.files.length, plan.uploads, github.blobPosts]).toEqual([5, 4, 4]);
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

	// ⚠ **The Baseline is a claim of authorship, so it may hold only source this publish sent.** A
	// preserved path's SHA comes straight from the tree listing and nothing here has read its bytes —
	// harmless while a preserved path is outside the namespace by construction, and licence to delete
	// the moment a path changes hands: the Remote gains a `project.json` for a directory whose files
	// were preserved last time, and those unverified SHAs become this machine saying it put them
	// there. Generated output is sent and still absent, because a chunk name another editor version
	// writes is Published Site staleness and never changed scholarship.
	it('records the source it wrote, never what it carried through or generated', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: { 'README.md': '# Atlas\n', CNAME: 'atlas.example\n' }
		});

		const { baseline } = await publish(store, github);

		expect([...baseline.keys()].sort()).toEqual([
			'alignments/blaeu.json',
			'amsterdam-1625/annotations/notes.json',
			'amsterdam-1625/project.json',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg',
			'images/blaeu/info.json'
		]);
		// Preserved, committed, and unclaimed: on the Remote and not in the record. So is the site.
		expect([...github.files().keys()]).toEqual(expect.arrayContaining(['CNAME', 'index.html']));
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
				// Its Map Image, at the Workspace root because a pyramid is shared (ADR-0023).
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

	/**
	 * A site an older editor version left on the Remote is replaced, not accumulated beside.
	 *
	 * The chunk names in `_app/` are content hashes, so this is the ordinary state of a Remote two
	 * machines on different builds publish to — and Publish-owned output is exactly the class of path
	 * where being superseded is not a Conflict and not somebody's scholarship. The Workspace's cached
	 * tile is the control: it is inside `base-map/` and it is *source*, so it survives a republish
	 * that removes the glyphs beside it.
	 */
	it('removes the Publish-owned output a previous site left and this one does not write', async () => {
		const store = await seeded({
			...SITE,
			'index.html': '<!doctype html>',
			'_app/immutable/entry/start.AAAA.js': 'export const start = 1;',
			'base-map/tiles/9f8/12/2094/1330.mvt': 'tile-bytes',
			'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}'
		});
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				'README.md': '# Atlas\n',
				'_app/immutable/entry/start.OLD.js': 'export const start = 0;',
				'base-map/fonts/Noto Sans Regular/0-255.pbf': 'glyph-bytes',
				'robots.txt': 'User-agent: *\n'
			}
		});

		await publish(store, github, await claimingEverythingOnTheRemote(github));

		const paths = [...github.files().keys()];
		expect(paths).toEqual([
			'.nojekyll',
			'README.md',
			'_app/immutable/entry/start.AAAA.js',
			'amsterdam-1625/project.json',
			'ballastella-site.json',
			'base-map/tiles/9f8/12/2094/1330.mvt',
			'index.html'
		]);
	});
});

// ⚠ **A repository holds the work, and a site is asked for separately** (ADR-0045). Everything in
// this block is one question — *does the tree carry a `ballastella-site.json`* — asked of the
// Workspace and of the Remote, and never of a stored flag that could disagree with either.
describe('the owned namespace when Share Links are not asked for (ADR-0045)', () => {
	/** The Workspace as it is before anybody asks for a site: the scholar's own files and nothing else. */
	const workOnly = () =>
		seeded({
			'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
			'amsterdam-1625/annotations/notes.json': '{"type":"FeatureCollection","features":[]}',
			'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
			// alignment-write-is-the-fixture: an Alignment already in the Workspace, seeded so the publish has one to send
			'alignments/blaeu.json': '{"type":"Annotation"}'
		});

	// The whole of story 64: browsing the repository on github.com shows the scholar's work rather
	// than a build. No `index.html`, no `_app/`, no site record, and not even the Jekyll marker.
	it('sends the source namespace and nothing else', async () => {
		const store = await workOnly();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		const { plan } = await publish(store, github);

		expect(plan.files.map((file) => file.path)).toEqual([
			'alignments/blaeu.json',
			'amsterdam-1625/annotations/notes.json',
			'amsterdam-1625/project.json',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg',
			'images/blaeu/info.json'
		]);
		expect([...github.files().keys()]).toEqual(plan.files.map((file) => file.path));
	});

	// ⚠ **Neither sent nor removed.** A site somebody's fork left, or one an older build wrote before
	// this rule existed, is not this Workspace's to take down — and its presence is not a difference
	// anybody is told about.
	it('leaves a site already on the Remote exactly where it is', async () => {
		const store = await workOnly();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				'.nojekyll': '',
				'index.html': '<!doctype html>',
				'_app/immutable/entry/start.OLD.js': 'export const start = 0;'
			}
		});

		const { plan } = await publish(store, github);

		expect(plan.removed).toEqual([]);
		expect(plan.conflicts).toEqual([]);
		expect([...github.files().keys()]).toContain('index.html');
		expect([...github.files().keys()]).toContain('_app/immutable/entry/start.OLD.js');
	});

	// ⚠ **The seed is scaffolding here and a published file with Share Links, which is the one
	// difference between the two.** `PUT /contents/` is the only endpoint that writes to a repository
	// with no commits (ADR-0045), so the marker opens the branch one commit early — and then the
	// publish's own commit does not carry it, because a repository holding only work has no `_app/`
	// for Jekyll to drop. What a scholar browsing github.com sees is their own files.
	it('opens an empty repository with the marker and does not commit it', async () => {
		const store = await workOnly();
		const github = await createFakeGitHub({ owner: REMOTE.owner, repository: REMOTE.repository });

		const { plan } = await publish(store, github);

		expect(plan.files.map((file) => file.path)).not.toContain('.nojekyll');
		expect([...github.files().keys()]).not.toContain('.nojekyll');
		// It was there, in the commit that opened the branch: the scaffolding happened, and only the
		// publish parented onto it declines to carry it forward.
		expect([...github.files(github.history()[1] ?? '').keys()]).toEqual(['.nojekyll']);
	});
});

describe('the owned namespace once Share Links are asked for (ADR-0045)', () => {
	// Asking for Share Links writes the viewer into the Workspace; the next Sync is what carries it.
	it('sends the source namespace, the viewer file set, and the Jekyll marker', async () => {
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
	});

	// ⚠ **Withdrawal, asserted end to end at the seam that carries it out.** `withdrawShareLinks` has
	// taken the viewer out of the Workspace; the Remote still has it, which is what still makes this a
	// Workspace with Share Links — and so the mirror removes it. The scholar's files are the control.
	it('removes the viewer set the Workspace no longer holds, and no source file with it', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		const first = await publish(store, github);

		await withdrawShareLinks(store);
		const { plan } = await publish(store, github, shared(first));

		expect([...github.files().keys()]).toEqual([
			'.nojekyll',
			'alignments/blaeu.json',
			'amsterdam-1625/annotations/notes.json',
			'amsterdam-1625/project.json',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg',
			'images/blaeu/info.json'
		]);
		expect(plan.conflicts).toEqual([]);
	});

	// And then it stays withdrawn: the Remote no longer carries a site record, so the marker the last
	// commit still holds is preserved rather than re-authored, and nothing oscillates.
	it('leaves the repository alone on the Sync after a withdrawal', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		const first = await publish(store, github);
		await withdrawShareLinks(store);
		const second = await publish(store, github, shared(first));

		const { plan } = await publish(store, github, shared(second));

		expect(plan.unchanged).toBe(true);
		expect(plan.files.map((file) => file.path)).not.toContain('.nojekyll');
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
	// moment ago — which is precisely the repository the "create it yourself" link hands them back
	// from, and the only publish that cannot have gone wrong yet.
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
		// Five, of which the plan's own permission, ref and tree calls spend three.
		github.rateLimit = { remaining: 5, reset: 1_800_000_000 };

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect([plan.uploads, plan.requestsRemaining]).toEqual([9, 2]);
		expect(plan.warnings.map((warning) => warning.kind)).toEqual(['request-budget']);
		expect(plan.warnings[0]?.message).toContain('9 new files');
		expect(plan.warnings[0]?.message).toContain('2 more requests');
		// The reset is named rather than left as "later", which is the whole point of the warning.
		expect(plan.warnings[0]?.message).toMatch(/\d{1,2}:\d{2}/);
	});

	it('counts the tree, the commit and the ref move alongside the blobs', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		// Twelve, of which the plan's own permission, ref and tree calls spend three, leaving exactly
		// the nine blobs this Workspace sends. Room for every blob and none for the commit: uncounted,
		// this publish uploads all nine and then meets the 403 at `POST /git/trees` — the most
		// expensive possible place to stop, with the bytes spent and nothing visible.
		github.rateLimit = { remaining: 12, reset: 1_800_000_000 };

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
	 * ⚠ **The forecast runs before the local publish writes, which is the whole of the dialog's flow.**
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

			// Two files, because a Workspace with no site carries no `.nojekyll`: the marker exists to
			// stop Jekyll dropping `_app/`, and there is no `_app/` in a repository holding only work
			// (ADR-0045). The website's four make it seven, the marker among them.
			expect([bare.pending.length, bare.uploads, whole.uploads]).toEqual([0, 2, 7]);
			expect(whole.bytes - bare.bytes).toBe(5_002_700);
			expect(whole.uploadBytes - bare.uploadBytes).toBe(5_002_700);
			expect(whole.pending.map((file) => file.path)).toEqual(website.map((file) => file.path));
		});

		it('warns about the hour’s budget on a count the website is in', async () => {
			const store = await beforeTheFirstPublish();
			const github = await createFakeGitHub({ ...REMOTE, tree: {} });
			// Room for the two files the Workspace holds, the tree, the commit and the ref move — and
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
		// Nothing is visible on the Remote until the ref moves, and it did not.
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
		// ⚠ The stale-sign-in question. Rights are read at a bind and at a paste and at no other
		// moment, so a token that has since expired still reads "Signed in to GitHub" — and collapsed
		// into the general refusal it reaches the scholar as "GitHub refused this publish: Bad
		// credentials", sending them to check a repository that is fine. The remedy is a sign-in, and
		// the sentence has to say so.
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

// ── What a send is allowed to touch (ADR-0033, ADR-0044) ──────────────────────────────────────
//
// ⚠ **A comparison made the wrong way round overwrites another machine's Annotation, and no count
// of requests can see it.** So every case below asserts what is on the Remote afterwards — whose
// bytes are at the path, and whether the paths a Workspace does not have are still there — and the
// refusal's own words are asserted only where the words are the deliverable.
describe('a send against a Remote that has moved', () => {
	/**
	 * The desktop's afternoon, arriving on the Remote after the laptop last looked.
	 *
	 * Both Workspaces start as copies of one another with the same evidence about the Remote, which
	 * is what two machines bound to one repository are: the second was opened from the first, or the
	 * same Workspace restored from a Backup. Then one of them does an afternoon's work.
	 *
	 * @returns the fake, the laptop's Workspace, and the evidence the laptop still holds
	 */
	const afternoonOnTheOtherMachine = async () => {
		const desktop = await smallWorkspace();
		const laptop = await smallWorkspace();
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });

		const first = await publish(desktop, github);
		await desktop.write(
			'amsterdam-1625/annotations/notes.json',
			encode('{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}')
		);
		await publish(desktop, github, shared(first));

		return { github, laptop, lastSeen: shared(first) };
	};

	const laptopPlan = (
		laptop: MemoryProjectStore,
		github: FakeGitHub,
		lastSeen: SynchronizationBaseline
	) =>
		planRemotePublish(laptop, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch,
			baseline: lastSeen
		});

	// ⚠ **The single most important behaviour in this file.** Sending is not refused any more, and it
	// is not a refusal that protects the desktop's afternoon: the path is simply not one this send
	// touches, and the resulting tree is where that is asserted.
	it('leaves the other machine’s work exactly as it is, and offers it to get instead', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const plan = await laptopPlan(laptop, github, lastSeen);
		await publishToRemote(laptop, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		expect(plan.conflicts).toEqual([]);
		expect(plan.leftAlone).toEqual(['amsterdam-1625/annotations/notes.json']);
		// The half that matters: the desktop's afternoon is still there, byte for byte, after a
		// completed send from a laptop that has never seen it.
		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		);
		// And it is in the other column, which is where the author can act on it.
		expect(plan.incoming).toEqual([
			{
				path: 'amsterdam-1625/annotations/notes.json',
				sha: await gitBlobSha(
					encode('{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}')
				),
				effect: 'replace'
			}
		]);
	});

	it('does not record the path it left alone, so it still reads as work to get', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const plan = await laptopPlan(laptop, github, lastSeen);
		const sent = await publishToRemote(laptop, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch: github.fetch
		});

		// The Baseline a send may record covers what it wrote and nothing else. Claiming the path it
		// left alone would report the desktop's afternoon as already agreed with.
		expect(sent.baseline.has('amsterdam-1625/annotations/notes.json')).toBe(false);
		expect([...sent.baseline.keys()]).toContain('amsterdam-1625/project.json');
	});

	it('sends the Workspace’s own outstanding work in the same commit', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();
		// The laptop's own afternoon, at a different path from the desktop's.
		await laptop.write('amsterdam-1625/project.json', encode('{"formatVersion":1,"name":"Mine"}'));

		const plan = await laptopPlan(laptop, github, lastSeen);
		await publishToRemote(laptop, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		// Story 32's easy half: changes on both sides at different paths both survive one Sync.
		expect(decode(github.files().get('amsterdam-1625/project.json') ?? EMPTY)).toBe(
			'{"formatVersion":1,"name":"Mine"}'
		);
		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
		);
	});

	it('overwrites the repository when told to, replacing what was there', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const plan = await laptopPlan(laptop, github, lastSeen);
		await publishToRemote(laptop, {
			token: TOKEN,
			remote: REMOTE,
			plan,
			fetch: github.fetch,
			overwrite: true
		});

		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[]}'
		);
		// Overwriting is still ADR-0033's mirror and not a force push: everything outside the owned
		// namespace survives it exactly as it survives an ordinary send.
		expect(decode(github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
	});

	// ⚠ **A contested path stops nothing** (ADR-0046). A send neither writes it nor removes it —
	// the Remote's version stays exactly where it is — and the *get* is what resolves it, into a copy
	// the scholar can look at. What this describe fences is that a send does not quietly overwrite it
	// and does not refuse the rest of the Sync over it.
	describe('one path changed on both sides', () => {
		const contested = async () => {
			const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();
			await laptop.write(
				'amsterdam-1625/annotations/notes.json',
				encode('{"type":"FeatureCollection","features":[{"id":"my-afternoon"}]}')
			);
			await laptop.write('amsterdam-1625/annotations/canals.json', encode('{"canals":true}'));
			return { github, laptop, lastSeen };
		};

		it('is reported, and the send goes ahead with everything else', async () => {
			const { github, laptop, lastSeen } = await contested();

			const plan = await laptopPlan(laptop, github, lastSeen);
			expect(plan.conflicts.map((row) => row.path)).toEqual([
				'amsterdam-1625/annotations/notes.json'
			]);

			await publishToRemote(laptop, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

			// The other machine's afternoon is still there, untouched — a send does not choose between
			// two versions of the scholar's work.
			expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
				'{"type":"FeatureCollection","features":[{"id":"a-whole-afternoon"}]}'
			);
			// And the file that was not contested went, which is the whole point of not stopping.
			expect(decode(github.files().get('amsterdam-1625/annotations/canals.json') ?? EMPTY)).toBe(
				'{"canals":true}'
			);
		});

		it('goes through once the author asks to overwrite the repository', async () => {
			const { github, laptop, lastSeen } = await contested();

			const plan = await laptopPlan(laptop, github, lastSeen);
			await publishToRemote(laptop, {
				token: TOKEN,
				remote: REMOTE,
				plan,
				fetch: github.fetch,
				overwrite: true
			});

			expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
				'{"type":"FeatureCollection","features":[{"id":"my-afternoon"}]}'
			);
		});
	});

	// ⚠ **A send that would *delete*, which is the destructive half of the same comparison.** An
	// owned path on the Remote that the Baseline recorded and this Workspace no longer has is a path
	// the mirror removes; one the Baseline never recorded is somebody else's. Turn the
	// Baseline-narrowing into a no-op and the second test below is the one that fails.
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
			return { store, github, lastSeen: shared(first) };
		};

		it('is left alone by a send, and listed as work to get', async () => {
			const { store, github, lastSeen } = await aProjectFromSomewhereElse();

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: lastSeen
			});
			await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

			// Absent from the Baseline and absent here, so the Remote gained them: `inbound`, which is
			// what makes them somebody else's rather than ours to remove.
			expect(plan.conflicts).toEqual([]);
			expect(plan.removed).toEqual([]);
			expect(plan.incoming.map((choice) => choice.path)).toEqual([
				'florida-1657/annotations/notes.json',
				'florida-1657/project.json'
			]);
			// The assertion the rule exists for: the Project is still there, whole, after a completed
			// send from a Workspace that has never held it.
			expect([...github.files().keys()].filter((path) => path.startsWith('florida-1657/'))).toEqual(
				['florida-1657/annotations/notes.json', 'florida-1657/project.json']
			);
		});

		it('is removed once the scholar asks to overwrite the repository', async () => {
			const { store, github, lastSeen } = await aProjectFromSomewhereElse();

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: lastSeen
			});
			// Named before it is carried out, which is the whole of what makes the mode safe to offer.
			expect(plan.overwrites).toEqual([
				'florida-1657/annotations/notes.json',
				'florida-1657/project.json'
			]);
			await publishToRemote(store, {
				token: TOKEN,
				remote: REMOTE,
				plan,
				fetch: github.fetch,
				overwrite: true
			});

			expect([...github.files().keys()].filter((path) => path.startsWith('florida-1657/'))).toEqual(
				[]
			);
			expect(decode(github.files().get('README.md') ?? EMPTY)).toBe('# Atlas\n');
		});

		it('is removed by a send once the Baseline records it, which is a deletion here', async () => {
			const { store, github } = await aProjectFromSomewhereElse();
			// The Workspace gets the Project, agrees with the Remote about it, and then deletes it.
			const agreed = await claimingEverythingOnTheRemote(github);
			await store.write(
				'florida-1657/project.json',
				encode('{"formatVersion":1,"name":"Florida"}')
			);
			await store.write(
				'florida-1657/annotations/notes.json',
				encode('{"type":"FeatureCollection","features":[]}')
			);
			await store.delete('florida-1657/project.json');
			await store.delete('florida-1657/annotations/notes.json');

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: agreed
			});
			await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

			expect(plan.removed).toEqual([
				'florida-1657/annotations/notes.json',
				'florida-1657/project.json'
			]);
			expect([...github.files().keys()].filter((path) => path.startsWith('florida-1657/'))).toEqual(
				[]
			);
		});
	});

	// ⚠ **The consent is about a set of files, not about a moment.** An interface that forecasts,
	// publishes locally and then plans again — which `EditorSession.publishToRemote` must, or it would
	// commit a site with no `index.html` — hands this a plan the scholar never read. A bare `true`
	// would apply their answer about one Project to whatever the second listing found, and the ref
	// move cannot catch it: the second plan is parented on the new head, so its commit is an ordinary
	// fast-forward.
	describe('an agreement to overwrite, carried across a re-plan', () => {
		/** A Remote holding a Project this Workspace has never had, which an overwrite takes down. */
		const somebodyElsesProject = async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			const first = await publish(store, github);
			await github.commitFiles({
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}'
			});
			return { store, github, lastSeen: shared(first) };
		};

		const planFor = (store: MemoryProjectStore, github: FakeGitHub, at: SynchronizationBaseline) =>
			planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: at
			});

		it('goes ahead when the second plan takes down exactly what was agreed to', async () => {
			const { store, github, lastSeen } = await somebodyElsesProject();
			const shown = await planFor(store, github, lastSeen);

			const again = await planFor(store, github, lastSeen);
			await publishToRemote(store, {
				token: TOKEN,
				remote: REMOTE,
				plan: again,
				fetch: github.fetch,
				overwrite: shown.overwrites
			});

			expect([...github.files().keys()]).not.toContain('florida-1657/project.json');
		});

		it('refuses when the Remote gained a Project between the offer and the acceptance', async () => {
			const { store, github, lastSeen } = await somebodyElsesProject();
			const shown = await planFor(store, github, lastSeen);

			// The window is the local publish and the upload, which on a large Workspace is minutes.
			await github.commitFiles({ 'delft/project.json': '{"formatVersion":1,"name":"Delft"}' });
			const head = github.head();
			const again = await planFor(store, github, lastSeen);

			const raised = await publishToRemote(store, {
				token: TOKEN,
				remote: REMOTE,
				plan: again,
				fetch: github.fetch,
				overwrite: shown.overwrites
			}).catch((cause: unknown) => cause);

			expect(raised).toBeInstanceOf(RemotePublishRefusedError);
			// It names what was *not* agreed to, and not the file that was: the scholar has decided about
			// that one already, and repeating it would bury the news underneath it.
			expect((raised as Error).message).toContain('delft/project.json');
			expect((raised as Error).message).not.toContain('florida-1657/project.json');
			// And the Project nobody was shown is still there, on a branch that never moved.
			expect(github.head()).toBe(head);
			expect([...github.files().keys()]).toContain('delft/project.json');
		});
	});

	// ⚠ **A collaborator who cannot write still gets the comparison** (ADR-0044). Refusing to plan at
	// all would leave a read-only reader looking at nothing where the *To get* column should be; what
	// their account cannot do is answered by leaving the send affordances off the screen.
	describe('an account that cannot push', () => {
		it('is refused a plan made in order to send', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			github.permissions = { push: false, admin: false };

			const raised = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch
			}).catch((cause: unknown) => cause);

			expect(raised).toBeInstanceOf(RemotePublishRefusedError);
			expect((raised as Error).message).toContain('cannot push to it');
		});

		it('is given the comparison when the plan is only being read', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({
				...REMOTE,
				tree: {
					'README.md': '# Atlas\n',
					'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}'
				}
			});
			github.permissions = { push: false, admin: false };

			const plan = await planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: null,
				sending: false
			});

			expect(plan.incoming.map((choice) => choice.path)).toEqual(['florida-1657/project.json']);
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
		await publish(store, github, shared(first));

		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"a1"}]}'
		);
		// And their edit is still theirs: preserved, not reverted to the copy the manifest saw.
		expect(decode(github.files().get('README.md') ?? EMPTY)).toBe(
			'# Atlas\n\nA collection of city plans.\n'
		);
	});

	it('replaces a path whose Remote SHA is the one the Baseline last saw', async () => {
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
			baseline: shared(first)
		});
		await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

		expect(plan.conflicts).toEqual([]);
		expect(decode(github.files().get('amsterdam-1625/annotations/notes.json') ?? EMPTY)).toBe(
			'{"type":"FeatureCollection","features":[{"id":"mine"}]}'
		);
	});

	describe('with no Baseline at all', () => {
		/** A plan made with no evidence about the Remote, which is what `Cannot tell` is. */
		const planWithNoEvidence = (store: MemoryProjectStore, github: FakeGitHub) =>
			planRemotePublish(store, {
				token: TOKEN,
				remote: REMOTE,
				fetch: github.fetch,
				baseline: null
			});

		// ⚠ **The publish's own seed must not read as somebody else's work.** An empty repository is
		// opened by writing `.nojekyll` through the Contents API, so a first publish that does not
		// finish leaves that one file behind with no Baseline beside it. `.nojekyll` is Publish-owned
		// output, so it is not source, cannot be inbound change, and is
		// rewritten by this publish like every other generated path.
		it('goes ahead against a Remote holding only the seed it wrote itself', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { '.nojekyll': '' } });

			expect((await planWithNoEvidence(store, github)).conflicts).toEqual([]);
		});

		// The same rule, and the case that most invites a special one: a `.nojekyll` somebody typed into
		// is still Publish-owned output, so it is overwritten rather than treated as scholarship this
		// Workspace has never seen. Generated output contributes Published Site staleness and nothing
		// else, which is what stops two editor versions refusing to publish at each other over chunk
		// names.
		it('overwrites a Publish-owned marker somebody edited, without calling it a source change', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { '.nojekyll': '# mine\n' } });

			const plan = await planWithNoEvidence(store, github);
			await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

			expect(plan.conflicts).toEqual([]);
			expect(decode(github.files().get('.nojekyll') ?? EMPTY)).toBe('');
		});

		// An empty side, or a deliberate Update or Publish plan whose two sides are byte-for-byte equal,
		// establishes a Baseline safely. This is the commonest case — a Workspace whose browser storage
		// was cleared, or the first publish from a complete Open — and refusing
		// it is a dead Publish button over a Remote that is already exactly this Workspace.
		it('establishes a Baseline where the two source namespaces are already equal', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);
			// The evidence is lost — a cleared browser, a second machine, a restored Backup. The
			// Workspace and the Remote still agree exactly; only what this machine knows has gone.

			const plan = await planWithNoEvidence(store, github);
			const recorded = await publishToRemote(store, {
				token: TOKEN,
				remote: REMOTE,
				plan,
				fetch: github.fetch
			});

			expect(plan.conflicts).toEqual([]);
			expect([...recorded.baseline.keys()]).toContain('amsterdam-1625/project.json');
		});

		// ⚠ **What used to be `unknown-history`, and what makes a first Sync safe.** With no record of
		// what the two last shared, nothing is removed in either direction and nothing is overwritten:
		// a path the two hold differently is the one Conflict a send refuses, and a path only one side
		// has is offered in the direction it is missing from.
		it('leaves a Remote it cannot attribute exactly as it is, and refuses nothing over it', async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({
				...REMOTE,
				tree: {
					'README.md': '# Atlas\n',
					'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}',
					'florida-1657/annotations/notes.json': '{"type":"FeatureCollection","features":[]}'
				}
			});

			const plan = await planWithNoEvidence(store, github);
			await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

			expect(plan.conflicts).toEqual([]);
			expect(plan.removed).toEqual([]);
			expect([...github.files().keys()].filter((path) => path.startsWith('florida-1657/'))).toEqual(
				['florida-1657/annotations/notes.json', 'florida-1657/project.json']
			);
			// And this Workspace's own work reached it in the same commit, which is the whole point of
			// retiring the refusal: connecting an existing Workspace to an existing repository works.
			expect([...github.files().keys()]).toContain('amsterdam-1625/project.json');
		});

		// ⚠ **A file both sides hold differently is reported and left alone, on both sides.** With no
		// record of what the two last shared it cannot be attributed to either, so a send neither
		// overwrites the Remote's copy nor removes it — the get is what makes the second copy.
		it("names a file the two sides hold differently, and leaves the Remote's copy alone", async () => {
			const store = await smallWorkspace();
			const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
			await publish(store, github);
			await github.commitFiles({
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam, revised"}'
			});

			const plan = await planWithNoEvidence(store, github);
			await publishToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch });

			expect(plan.conflicts.map((row) => row.path)).toEqual(['amsterdam-1625/project.json']);
			expect(decode(github.files().get('amsterdam-1625/project.json') ?? EMPTY)).toBe(
				'{"formatVersion":1,"name":"Amsterdam, revised"}'
			);
		});

		// The website the local publish is about to write is Publish-owned output on both sides, so it
		// is no part of the source comparison at all — which is what keeps the warning above away from
		// the *first* publish from a complete Open.
		it('does not read the website the Remote already serves as source it cannot attribute', async () => {
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
				baseline: null,
				pending: [
					{ path: 'index.html', bytes: 400 },
					{ path: 'ballastella-site.json', bytes: 300 }
				]
			});

			expect(plan.conflicts).toEqual([]);
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

// The `.nojekyll` decision asserted from the outside rather than trusted: *written by every publish,
// unconditionally*. The chain `scripts/check-nojekyll.mjs` follows ends here — in a repository this
// code writes to — so this is the last point at which the property can be checked at all. Its absence
// is a blank page on a scholar's own domain with the reason only in a browser console, and nothing in
// this repository's own deployment would ever show it.
describe('the Jekyll marker every publish writes', () => {
	/** A commit's root entries, which is the only place a branch deploy reads `.nojekyll` from. */
	const rootPaths = (github: FakeGitHub, commit: string): string[] =>
		[...github.files(commit).keys()].filter((path) => !path.includes('/'));

	it('is at the root of every commit a publish writes, and of no commit it did not', async () => {
		const store = await smallWorkspace();
		// The case the engine authors one for: nothing in the Workspace is called this.
		expect(await store.list('')).not.toContain('.nojekyll');
		const github = await createFakeGitHub({ ...REMOTE, tree: { 'README.md': '# Atlas\n' } });
		const ancestor = github.head() ?? '';

		const first = await publish(store, github);
		// The manifest a real second publish carries: without it the conflict check has no record of
		// this Remote and refuses, which is the conflict check's behaviour and not this test's subject.
		const second = await publish(store, github, shared(first));

		expect(github.history()).toEqual([second.commit, first.commit, ancestor]);
		expect([rootPaths(github, first.commit), rootPaths(github, second.commit)]).toEqual([
			['.nojekyll', 'README.md', 'ballastella-site.json', 'index.html'],
			['.nojekyll', 'README.md', 'ballastella-site.json', 'index.html']
		]);
		expect(github.files(first.commit).get('.nojekyll')?.byteLength).toBe(0);
		// ⚠ The positive control. A reader that answered the same for every commit would satisfy the
		// two assertions above, and a fence that cannot fail is `exit 0` spelled at length. The
		// ancestor is a commit this code did not write, and the same reader says it has no marker.
		expect(rootPaths(github, ancestor)).toEqual(['README.md']);
	});

	it('is planned once when the Workspace already holds one, rather than twice', async () => {
		// ⚠ Asserted on the **plan**, because the commit cannot answer this: a tree is a map, so a
		// second entry for the same path is gone before any reader of it can see one. The plan's file
		// list is what the upload loop walks and what the tree is built from, so a duplicate there is a
		// second read of the file and a second entry posted to `POST /git/trees` for the same path.
		const store = await seeded({ ...SITE, '.nojekyll': '', 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		const plan = await planRemotePublish(store, {
			token: TOKEN,
			remote: REMOTE,
			fetch: github.fetch
		});

		expect(plan.files.map((file) => file.path)).toEqual([
			'.nojekyll',
			'ballastella-site.json',
			'index.html'
		]);
		// And it is the Workspace's own file rather than an authored one standing beside it.
		expect(plan.files.map((file) => file.authored)).toEqual([false, false, false]);
	});
});
