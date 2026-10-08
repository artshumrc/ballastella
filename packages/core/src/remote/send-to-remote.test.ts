import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { STATIC_HOSTING_LIMIT_BYTES } from '../project/workspace-size.js';
import type { MemoryProjectStore } from '../store/memory-project-store.js';
import { decode, encode, rejection, seeded } from '../test-support.js';
import { withdrawShareLinks } from '../published-site/published-site.js';
import { gitBlobSha } from './blob-sha.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import {
	ATLAS as REMOTE,
	SMALL_WORKSPACE,
	atlasWithReadme,
	inventory,
	remoteText
} from './remote-test-support.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import {
	MAX_SENT_FILES,
	RemoteSendCredentialError,
	RemoteSendFailedError,
	RemoteSendRateLimitedError,
	RemoteSendRefusedError,
	planRemoteSend,
	sendToRemote,
	type RemoteSendPlan
} from './send-to-remote.js';

const TOKEN = 'ghp_a-token';

const shared = (result: {
	commit: string;
	baseline: ReadonlyMap<string, string>;
}): SynchronizationBaseline => ({ remote: REMOTE, commit: result.commit, files: result.baseline });

const planFor = (
	store: MemoryProjectStore,
	github: FakeGitHub,
	extra: Partial<Parameters<typeof planRemoteSend>[1]> = {}
) => planRemoteSend(store, { token: TOKEN, remote: REMOTE, fetch: github.fetch, ...extra });

const sendPlan = (
	store: MemoryProjectStore,
	github: FakeGitHub,
	plan: RemoteSendPlan,
	extra: Partial<Parameters<typeof sendToRemote>[1]> = {}
) => sendToRemote(store, { token: TOKEN, remote: REMOTE, plan, fetch: github.fetch, ...extra });

const send = async (
	store: MemoryProjectStore,
	github: FakeGitHub,
	baseline: SynchronizationBaseline | null = null
) => {
	const plan = await planFor(store, github, { baseline });
	return { ...(await sendPlan(store, github, plan)), plan };
};

const claimingEverythingOnTheRemote = async (
	github: FakeGitHub
): Promise<SynchronizationBaseline> => ({
	remote: REMOTE,
	commit: github.head() ?? 'seeded',
	files: new Map((await inventory(github)).map(({ path, sha }) => [path, sha]))
});

const withoutBudgetHeaders =
	(github: FakeGitHub): FetchFn =>
	async (input, init) => {
		const response = await github.fetch(input, init);
		const headers = new Headers(response.headers);
		headers.delete('X-RateLimit-Remaining');
		headers.delete('X-RateLimit-Reset');
		return new Response(response.body, { status: response.status, headers });
	};

const SITE = { 'ballastella-site.json': '{"formatVersion":2,"projects":[]}' };
const smallWorkspace = () => seeded(SMALL_WORKSPACE);

const small = async (tree: Record<string, string> | null = { 'README.md': '# Atlas\n' }) => ({
	store: await smallWorkspace(),
	github: await createFakeGitHub(
		tree === null ? { owner: REMOTE.owner, repository: REMOTE.repository } : { ...REMOTE, tree }
	)
});

const NOTES = 'amsterdam-1625/annotations/notes.json';
const notesWith = (id: string) => `{"type":"FeatureCollection","features":[{"id":"${id}"}]}`;
const FLORIDA = {
	'florida-1657/project.json': '{"formatVersion":1,"name":"Florida"}',
	'florida-1657/annotations/notes.json': '{"type":"FeatureCollection","features":[]}'
};
const FLORIDA_PATHS = ['florida-1657/annotations/notes.json', 'florida-1657/project.json'];
const paths = (github: FakeGitHub, ref?: string) => [...github.files(ref).keys()];
describe('sending a Workspace to its Remote', () => {
	it('sends every Workspace file at its Workspace-relative path, and `.nojekyll` with it', async () => {
		const { store, github } = await small({});

		await send(store, github);

		expect(paths(github)).toEqual([
			'.nojekyll',
			'_app/immutable/entry/start.AAAA.js',
			'alignments/blaeu.json',
			NOTES,
			'amsterdam-1625/project.json',
			'ballastella-site.json',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg',
			'images/blaeu/info.json',
			'index.html'
		]);
		expect(remoteText(github, 'images/blaeu/info.json')).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
	});

	it('sends an offline Base Map’s tiles along with everything else', async () => {
		const store = await seeded({
			'index.html': '<!doctype html>',
			'base-map/tiles/amsterdam-3f2a/12/2094/1339.mvt': 'mvt-bytes',
			'base-map/tiles/amsterdam-3f2a/12/2095/1339.mvt': 'more-mvt-bytes'
		});
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		await send(store, github);

		expect(paths(github).filter((path) => path.startsWith('base-map/'))).toEqual([
			'base-map/tiles/amsterdam-3f2a/12/2094/1339.mvt',
			'base-map/tiles/amsterdam-3f2a/12/2095/1339.mvt'
		]);
	});

	it('opens an empty repository and sends into it', async () => {
		const store = await seeded({ ...SITE, 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas' });

		const { commit } = await send(store, github);

		const history = github.history();
		expect([github.head(), history.length, paths(github)]).toEqual([
			commit,
			2,
			['.nojekyll', 'ballastella-site.json', 'index.html']
		]);
		expect(history[0]).toBe(commit);
		expect(paths(github, history[1])).toEqual(['.nojekyll']);
	});
});

const SECOND_PUBLISH_PATHS = [
	'.nojekyll',
	'README.md',
	'_app/immutable/entry/start.AAAA.js',
	'alignments/blaeu.json',
	NOTES,
	'amsterdam-1625/project.json',
	'ballastella-site.json',
	'images/blaeu/0,0,256,256/256,256/0/default.jpg',
	'images/blaeu/info.json',
	'index.html'
];

describe('a second send', () => {
	it('sends no blob at all when nothing changed, and still moves the ref', async () => {
		const { store, github } = await small();
		const first = await send(store, github);
		const posted = github.blobPosts;

		const plan = await planFor(store, github);
		expect([plan.unchanged, plan.uploads]).toEqual([true, 0]);

		const second = await send(store, github, shared(first));
		expect([github.blobPosts - posted, second.commit === first.commit]).toEqual([0, false]);
		expect([github.head(), github.history().length]).toEqual([second.commit, 3]);
		expect(paths(github)).toEqual(SECOND_PUBLISH_PATHS);
		expect(remoteText(github, 'images/blaeu/info.json')).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
	});

	it('plans as changed when a Project has been deleted here, which no blob count can see', async () => {
		const { store, github } = await small();
		const first = await send(store, github);
		await store.delete('amsterdam-1625/project.json');
		await store.delete(NOTES);

		const plan = await planFor(store, github, { baseline: shared(first) });
		expect([plan.unchanged, plan.uploads]).toEqual([false, 0]);
	});

	it('sends exactly one blob when one Annotation changed', async () => {
		const { store, github } = await small();
		const first = await send(store, github);
		const posted = github.blobPosts;

		await store.write(NOTES, encode(notesWith('a1')));
		const { plan } = await send(store, github, shared(first));

		expect([github.blobPosts - posted, plan.conflicts]).toEqual([1, []]);
		expect(remoteText(github, NOTES)).toBe(notesWith('a1'));
		expect(paths(github)).toEqual(SECOND_PUBLISH_PATHS);
		expect(remoteText(github, 'images/blaeu/info.json')).toBe(
			'{"id":"https://unset.invalid/blaeu"}'
		);
		expect(remoteText(github, 'README.md')).toBe('# Atlas\n');
	});

	it('commits the bytes it actually sent when a file changes during the send', async () => {
		const { store, github } = await small({});
		const first = await send(store, github);
		const plan = await planFor(store, github, { baseline: shared(first) });
		await store.write(NOTES, encode(notesWith('typed-while-uploading')));
		await sendPlan(store, github, plan);

		expect(remoteText(github, NOTES)).toBe(notesWith('typed-while-uploading'));
	});

	it('uploads a file the plan thought unchanged when its bytes have moved on', async () => {
		const store = await seeded({ ...SITE, 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		const first = await send(store, github);
		const posted = github.blobPosts;
		const read = store.read.bind(store);
		let readsOfIndex = 0;
		vi.spyOn(store, 'read').mockImplementation(async (path) => {
			if (path !== 'index.html') return read(path);
			readsOfIndex += 1;
			return readsOfIndex > 1 ? encode('<!doctype html><title>Atlas</title>') : read(path);
		});

		const plan = await planFor(store, github, { baseline: shared(first) });
		await sendPlan(store, github, plan);

		expect(plan.uploads).toBe(0);
		expect(github.blobPosts - posted).toBe(1);
		expect(remoteText(github, 'index.html')).toBe('<!doctype html><title>Atlas</title>');
	});

	it('posts one blob for two paths holding the same bytes', async () => {
		const store = await seeded({
			...SITE,
			'index.html': '<!doctype html>',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'blank-tile',
			'images/blaeu/0,256,256,256/256,256/0/default.jpg': 'blank-tile'
		});
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		const plan = await planFor(store, github);
		await sendPlan(store, github, plan);

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
	it('carries a CNAME, a README, a docs folder and a submodule through, recording none of them', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				CNAME: 'atlas.example\n',
				'README.md': '# Atlas\n',
				'docs/guide.md': 'How to read this edition\n'
			},
			submodules: { theme: 'f'.repeat(40) }
		});

		const { baseline } = await send(store, github);

		expect(['CNAME', 'README.md', 'docs/guide.md'].map((path) => remoteText(github, path))).toEqual(
			['atlas.example\n', '# Atlas\n', 'How to read this edition\n']
		);
		expect([...github.gitlinks()]).toEqual([['theme', 'f'.repeat(40)]]);
		expect([...baseline.keys()].sort()).toEqual([
			'alignments/blaeu.json',
			NOTES,
			'amsterdam-1625/project.json',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg',
			'images/blaeu/info.json'
		]);
		expect(paths(github)).toContain('index.html');
	});

	it('removes a Project the Remote still has and the Workspace does not, with its pyramid', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: {
				...FLORIDA,
				CNAME: 'atlas.example\n',
				'images/moll/info.json': '{"id":"https://unset.invalid/moll"}',
				'images/moll/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
				'alignments/moll.json': '{"type":"Annotation"}'
			}
		});

		await send(store, github, await claimingEverythingOnTheRemote(github));

		const sent = paths(github);
		expect(
			sent.filter((path) => path.startsWith('florida-1657/') || path.includes('moll'))
		).toEqual([]);
		expect(sent).toEqual(expect.arrayContaining(['CNAME', 'amsterdam-1625/project.json']));
	});

	it('removes the site-owned output a previous site left and this one does not write', async () => {
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

		await send(store, github, await claimingEverythingOnTheRemote(github));

		expect(paths(github)).toEqual([
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

const SOURCE_PATHS = [
	'alignments/blaeu.json',
	NOTES,
	'amsterdam-1625/project.json',
	'images/blaeu/0,0,256,256/256,256/0/default.jpg',
	'images/blaeu/info.json'
];

describe('the owned namespace when Share Links are not asked for (ADR-0045)', () => {
	const workOnly = () =>
		seeded({
			'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
			[NOTES]: '{"type":"FeatureCollection","features":[]}',
			'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}',
			'images/blaeu/0,0,256,256/256,256/0/default.jpg': 'jpeg-bytes',
			'alignments/blaeu.json': '{"type":"Annotation"}'
		});

	it('sends the source namespace and nothing else', async () => {
		const store = await workOnly();
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });

		const { plan } = await send(store, github);

		expect(plan.files.map((file) => file.path)).toEqual(SOURCE_PATHS);
		expect(paths(github)).toEqual(SOURCE_PATHS);
	});

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

		const { plan } = await send(store, github);

		expect([plan.removed, plan.conflicts]).toEqual([[], []]);
		expect(paths(github)).toEqual(
			expect.arrayContaining(['index.html', '_app/immutable/entry/start.OLD.js'])
		);
	});

	it('opens an empty repository with the marker and does not commit it', async () => {
		const store = await workOnly();
		const github = await createFakeGitHub({ owner: REMOTE.owner, repository: REMOTE.repository });

		const { plan } = await send(store, github);

		expect(plan.files.map((file) => file.path)).not.toContain('.nojekyll');
		expect(paths(github)).not.toContain('.nojekyll');
		expect(paths(github, github.history()[1] ?? '')).toEqual(['.nojekyll']);
	});
});

describe('the owned namespace once Share Links are asked for (ADR-0045)', () => {
	it('removes the viewer set once withdrawn, no source file with it, then leaves the repository alone', async () => {
		const { store, github } = await small({});
		const first = await send(store, github);

		await withdrawShareLinks(store);
		const second = await send(store, github, shared(first));

		expect(paths(github)).toEqual(['.nojekyll', ...SOURCE_PATHS]);
		expect(second.plan.conflicts).toEqual([]);

		const { plan } = await send(store, github, shared(second));
		expect(plan.unchanged).toBe(true);
		expect(plan.files.map((file) => file.path)).not.toContain('.nojekyll');
	});

	it.each([
		{
			where: 'neither side carries a site',
			shareLinks: false,
			setup: async () => ({
				store: await seeded({ 'amsterdam-1625/project.json': '{}' }),
				github: await createFakeGitHub({ ...REMOTE, tree: {} })
			})
		},
		{
			where: 'the Workspace carries one the Remote has not got yet',
			shareLinks: true,
			setup: () => small({})
		},
		{
			where: 'only the Remote carries one',
			shareLinks: true,
			setup: async () => {
				const { store, github } = await small({});
				await send(store, github);
				await withdrawShareLinks(store);
				return { store, github };
			}
		}
	])('plans Share Links as $shareLinks where $where', async ({ shareLinks, setup }) => {
		const { store, github } = await setup();
		expect((await planFor(store, github)).shareLinks).toBe(shareLinks);
	});
});

describe('the refusals, both of which cost the Remote nothing', () => {
	it('refuses a truncated tree, quoting the file count, before any blob is posted', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({
			...REMOTE,
			tree: { CNAME: 'atlas.example\n', 'README.md': '# Atlas\n', 'docs/guide.md': 'How to\n' }
		});
		github.truncateAfter = 3;
		const before = github.head();

		const raised = await rejection(RemoteSendRefusedError, planFor(store, github));
		expect(raised.message).toMatch(/\b2 files\b/);
		expect([github.blobPosts, github.head()]).toEqual([0, before]);
	});

	it('refuses a repository GitHub cannot show it, rather than planning it as an empty one', async () => {
		const store = await smallWorkspace();
		const github = await createFakeGitHub({ owner: 'ada', repository: 'atlas', tree: {} });

		const raised = await rejection(
			RemoteSendRefusedError,
			planFor(store, github, { remote: { owner: 'ada', repository: 'atals', branch: 'main' } })
		);
		expect(raised.message).toMatch(/ada\/atals/);
		expect(github.blobPosts).toBe(0);
	});

	it('plans a first send to a repository with no commits as a change rather than refusing it', async () => {
		const { store, github } = await small(null);

		const plan = await planFor(store, github);
		expect([plan.head, plan.unchanged, plan.uploads, plan.preserved]).toEqual([null, false, 9, []]);
	});

	it('refuses a Workspace of more files than a send can list, quoting both numbers', async () => {
		const { store, github } = await small({});
		const listed = Array.from({ length: MAX_SENT_FILES + 1 }, (_, at) => `images/x/${at}.jpg`);
		vi.spyOn(store, 'list').mockResolvedValue(listed);
		vi.spyOn(store, 'size').mockResolvedValue(10);
		const read = vi.spyOn(store, 'read');

		const raised = await rejection(RemoteSendRefusedError, planFor(store, github));
		expect(raised.message).toMatch(/40001 files/);
		expect(raised.message).toMatch(/40000/);
		expect([read.mock.calls.length, github.blobPosts]).toEqual([0, 0]);
	});
});

describe('the three budgets (ADR-0033)', () => {
	it('warns when the site would pass the static-hosting limit', async () => {
		const { store, github } = await small({});
		vi.spyOn(store, 'size').mockResolvedValue(STATIC_HOSTING_LIMIT_BYTES / 4);

		const plan = await planFor(store, github);
		expect(plan.warnings.map((warning) => warning.kind)).toEqual(['hosting-limit']);
		expect(plan.warnings[0]?.message).toContain('2.0 GB');
		expect(plan.warnings[0]?.message).toContain('1.0 GB');
	});

	it.each([
		{ remaining: 5, left: 2 },
		{ remaining: 12, left: 9 }
	])(
		'warns when the blobs, tree, commit and ref move outnumber $remaining requests, naming the reset',
		async ({ remaining, left }) => {
			const { store, github } = await small({});
			github.rateLimit = { remaining, reset: 1_800_000_000 };

			const plan = await planFor(store, github);
			expect([plan.uploads, plan.requestsRemaining]).toEqual([9, left]);
			expect(plan.warnings.map((warning) => warning.kind)).toEqual(['request-budget']);
			const message = plan.warnings[0]?.message;
			for (const fragment of ['9 new files', '12 requests in all', `${left} more requests`]) {
				expect(message).toContain(fragment);
			}
			expect(message).toMatch(/\d{1,2}:\d{2}/);
		}
	);

	it('reads an absent rate-limit header as unknown rather than as a budget of nought', async () => {
		const { store, github } = await small({});

		const plan = await planFor(store, github, { fetch: withoutBudgetHeaders(github) });
		expect([plan.requestsRemaining, plan.requestsResetAt, plan.warnings]).toEqual([null, null, []]);
	});

	describe('what the local site write is about to add', () => {
		const beforeTheFirstSend = async () => ({
			store: await seeded({
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}',
				'images/blaeu/info.json': '{"id":"https://unset.invalid/blaeu"}'
			}),
			github: await createFakeGitHub({ ...REMOTE, tree: {} })
		});

		const website = [
			{ path: 'index.html', bytes: 400 },
			{ path: '_app/immutable/entry/start.AAAA.js', bytes: 2_000 },
			{ path: 'ballastella-site.json', bytes: 300 },
			{ path: 'base-map/fonts/Noto/0-255.pbf', bytes: 5_000_000 }
		];

		it('counts into the files, the bytes and the blobs it will need', async () => {
			const { store, github } = await beforeTheFirstSend();
			const bare = await planFor(store, github);
			const whole = await planFor(store, github, { pending: website });
			expect([bare.pending.length, bare.uploads, whole.uploads]).toEqual([0, 2, 7]);
			expect(whole.bytes - bare.bytes).toBe(5_002_700);
			expect(whole.uploadBytes - bare.uploadBytes).toBe(5_002_700);
			expect(whole.pending.map((file) => file.path)).toEqual(website.map((file) => file.path));
		});

		it('warns about the hour’s budget on a count the website is in', async () => {
			const { store, github } = await beforeTheFirstSend();
			github.rateLimit = { remaining: 8, reset: 1_800_000_000 };

			const plan = await planFor(store, github, { pending: website });
			expect(plan.warnings.map((warning) => warning.kind)).toEqual(['request-budget']);
			expect(plan.warnings[0]?.message).toContain('7 new files');
			expect(plan.warnings[0]?.message).toContain('10 requests in all');
		});

		it('is not "nothing needs changing" when a website is about to arrive', async () => {
			const { store, github } = await small();
			await send(store, github);

			const plan = await planFor(store, github, { pending: [...website] });

			expect([plan.unchanged, plan.pending.map((file) => file.path)]).toEqual([
				false,
				['base-map/fonts/Noto/0-255.pbf']
			]);
		});

		it('ignores what the Workspace already holds', async () => {
			const { store, github } = await small();
			await send(store, github);

			const plan = await planFor(store, github, {
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
		const { store, github } = await small({});

		const plan = await planFor(store, github);
		expect([plan.warnings, plan.workspace.files, plan.uploads]).toEqual([[], 8, 9]);
	});
});

describe('a budget spent part way through', () => {
	it('stops, says how many files went and when it resets, and leaves the ref where it was', async () => {
		const { store, github } = await small();
		const plan = await planFor(store, github);
		const before = github.head();
		github.rateLimit = { remaining: 2, reset: 1_800_000_000 };
		const seen: number[] = [];

		const raised = await rejection(
			RemoteSendRateLimitedError,
			sendPlan(store, github, plan, { onProgress: (progress) => seen.push(progress.files) })
		);

		expect([raised.filesSent, raised.totalFiles, raised.resetAt?.getTime()]).toEqual([
			2, 9, 1_800_000_000_000
		]);
		expect(raised.message).toContain('2 of 9 files');
		expect(raised.message).toMatch(/\d{1,2}:\d{2}/);
		expect(raised.message).toContain('starts the upload again from the beginning');
		expect(raised.message).not.toMatch(/only what is left|picks up where|already sent are kept/);
		expect([github.head(), paths(github)]).toEqual([before, ['README.md']]);
		expect(seen).toEqual([0, 1, 2]);
	});

	it('names the tree rather than the upload when the budget runs out after the last blob', async () => {
		const { store, github } = await small();
		const plan = await planFor(store, github);
		const before = github.head();
		github.rateLimit = { remaining: 9, reset: 1_800_000_000 };

		const raised = await rejection(RemoteSendRateLimitedError, sendPlan(store, github, plan));
		expect([raised.phase, raised.filesSent, raised.totalFiles]).toEqual(['tree', 9, 9]);
		expect(raised.message).toContain('All 9 files had been sent');
		expect(raised.message).toContain('building the tree');
		expect([github.head(), paths(github)]).toEqual([before, ['README.md']]);
	});

	it('tells a credential GitHub will not look at apart from a repository it will not write', async () => {
		const { store, github } = await small();
		github.rejectCredential = true;

		const raised = await rejection(RemoteSendCredentialError, planFor(store, github));
		expect(raised.message).toContain('sign-in has expired');
		expect(raised.message).toContain('ada/atlas');
		expect(github.blobPosts).toBe(0);
	});

	it('reports a 403 with no budget header as a refusal, not as a wait for the reset', async () => {
		const { store, github } = await small();
		const fetch = withoutBudgetHeaders(github);
		const plan = await planFor(store, github, { fetch });
		github.refuseWrites = true;

		const raised = await rejection(RemoteSendFailedError, sendPlan(store, github, plan, { fetch }));
		expect(raised).not.toBeInstanceOf(RemoteSendRateLimitedError);
		expect(raised.message).toContain('Resource not accessible by personal access token');
	});
});

const AFTERNOON = notesWith('a-whole-afternoon');

const florida = (github: FakeGitHub) =>
	paths(github).filter((path) => path.startsWith('florida-1657/'));

describe('a send against a Remote that has moved', () => {
	const afternoonOnTheOtherMachine = async () => {
		const desktop = await smallWorkspace();
		const laptop = await smallWorkspace();
		const github = await atlasWithReadme();
		const first = await send(desktop, github);
		await desktop.write(NOTES, encode(AFTERNOON));
		await send(desktop, github, shared(first));

		return { github, laptop, lastSeen: shared(first) };
	};

	it('leaves the other machine’s work unrecorded, offers it to get, and sends its own work', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();
		await laptop.write('amsterdam-1625/project.json', encode('{"formatVersion":1,"name":"Mine"}'));

		const plan = await planFor(laptop, github, { baseline: lastSeen });
		const sent = await sendPlan(laptop, github, plan);

		expect([plan.conflicts, plan.leftAlone]).toEqual([[], [NOTES]]);
		expect(plan.incoming).toEqual([
			{ path: NOTES, sha: await gitBlobSha(encode(AFTERNOON)), effect: 'replace' }
		]);
		expect(remoteText(github, NOTES)).toBe(AFTERNOON);
		expect(remoteText(github, 'amsterdam-1625/project.json')).toBe(
			'{"formatVersion":1,"name":"Mine"}'
		);
		expect(sent.baseline.has(NOTES)).toBe(false);
		expect([...sent.baseline.keys()]).toContain('amsterdam-1625/project.json');
	});

	it('overwrites the repository when told to, replacing what was there', async () => {
		const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();

		const plan = await planFor(laptop, github, { baseline: lastSeen });
		await sendPlan(laptop, github, plan, { overwrite: true });

		expect(remoteText(github, NOTES)).toBe('{"type":"FeatureCollection","features":[]}');
		expect(remoteText(github, 'README.md')).toBe('# Atlas\n');
	});

	describe('one path changed on both sides', () => {
		const contested = async () => {
			const { github, laptop, lastSeen } = await afternoonOnTheOtherMachine();
			await laptop.write(NOTES, encode(notesWith('my-afternoon')));
			await laptop.write('amsterdam-1625/annotations/canals.json', encode('{"canals":true}'));
			return { github, laptop, plan: await planFor(laptop, github, { baseline: lastSeen }) };
		};

		it('is reported, and the send goes ahead with everything else', async () => {
			const { github, laptop, plan } = await contested();
			expect(plan.conflicts.map((row) => row.path)).toEqual([NOTES]);

			await sendPlan(laptop, github, plan);

			expect(remoteText(github, NOTES)).toBe(AFTERNOON);
			expect(remoteText(github, 'amsterdam-1625/annotations/canals.json')).toBe('{"canals":true}');
		});

		it('goes through once the author asks to overwrite the repository', async () => {
			const { github, laptop, plan } = await contested();

			await sendPlan(laptop, github, plan, { overwrite: true });

			expect(remoteText(github, NOTES)).toBe(notesWith('my-afternoon'));
		});
	});

	describe('a Project on the Remote this Workspace has never had', () => {
		const aProjectFromSomewhereElse = async () => {
			const { store, github } = await small();
			const first = await send(store, github);
			await github.commitFiles(FLORIDA);
			return { store, github, lastSeen: shared(first) };
		};

		it('is left alone by a send, and listed as work to get', async () => {
			const { store, github, lastSeen } = await aProjectFromSomewhereElse();

			const plan = await planFor(store, github, { baseline: lastSeen });
			await sendPlan(store, github, plan);

			expect([plan.conflicts, plan.removed]).toEqual([[], []]);
			expect(plan.incoming.map((choice) => choice.path)).toEqual(FLORIDA_PATHS);
			expect(florida(github)).toEqual(FLORIDA_PATHS);
		});

		it('is removed once the scholar asks to overwrite the repository', async () => {
			const { store, github, lastSeen } = await aProjectFromSomewhereElse();

			const plan = await planFor(store, github, { baseline: lastSeen });
			expect(plan.overwrites).toEqual(FLORIDA_PATHS);
			await sendPlan(store, github, plan, { overwrite: true });

			expect(florida(github)).toEqual([]);
			expect(remoteText(github, 'README.md')).toBe('# Atlas\n');
		});

		it('is removed by a send once the Baseline records it, which is a deletion here', async () => {
			const { store, github } = await aProjectFromSomewhereElse();

			const plan = await planFor(store, github, {
				baseline: await claimingEverythingOnTheRemote(github)
			});
			await sendPlan(store, github, plan);

			expect(plan.removed).toEqual(FLORIDA_PATHS);
			expect(florida(github)).toEqual([]);
		});
	});

	describe('an agreement to overwrite, carried across a re-plan', () => {
		const somebodyElsesProject = async () => {
			const { store, github } = await small();
			const first = await send(store, github);
			await github.commitFiles({
				'florida-1657/project.json': FLORIDA['florida-1657/project.json']
			});
			const lastSeen = shared(first);
			return {
				store,
				github,
				lastSeen,
				shown: await planFor(store, github, { baseline: lastSeen })
			};
		};

		it('goes ahead when the second plan takes down exactly what was agreed to', async () => {
			const { store, github, lastSeen, shown } = await somebodyElsesProject();
			const again = await planFor(store, github, { baseline: lastSeen });
			await sendPlan(store, github, again, { overwrite: shown.overwrites });

			expect(paths(github)).not.toContain('florida-1657/project.json');
		});

		it('refuses when the Remote gained a Project between the offer and the acceptance', async () => {
			const { store, github, lastSeen, shown } = await somebodyElsesProject();

			await github.commitFiles({ 'delft/project.json': '{"formatVersion":1,"name":"Delft"}' });
			const head = github.head();
			const again = await planFor(store, github, { baseline: lastSeen });

			const raised = await rejection(
				RemoteSendRefusedError,
				sendPlan(store, github, again, { overwrite: shown.overwrites })
			);

			expect(raised.message).toContain('delft/project.json');
			expect(raised.message).not.toContain('florida-1657/project.json');
			expect(github.head()).toBe(head);
			expect(paths(github)).toContain('delft/project.json');
		});
	});

	describe('an account that cannot push', () => {
		it('is refused a plan made in order to send', async () => {
			const { store, github } = await small();
			github.permissions = { push: false, admin: false };

			const raised = await rejection(RemoteSendRefusedError, planFor(store, github));
			expect(raised.message).toContain('cannot push to it');
		});

		it('is given the comparison when the plan is only being read', async () => {
			const { store, github } = await small({
				'README.md': '# Atlas\n',
				'florida-1657/project.json': FLORIDA['florida-1657/project.json']
			});
			github.permissions = { push: false, admin: false };

			const plan = await planFor(store, github, { baseline: null, sending: false });
			expect(plan.incoming.map((choice) => choice.path)).toEqual(['florida-1657/project.json']);
		});
	});

	it('is not triggered by a file changed outside the owned namespace', async () => {
		const { store, github } = await small();
		const first = await send(store, github);

		await github.commitFiles({ 'README.md': '# Atlas\n\nA collection of city plans.\n' });
		await store.write(NOTES, encode(notesWith('a1')));
		await send(store, github, shared(first));

		expect(remoteText(github, NOTES)).toBe(notesWith('a1'));
		expect(remoteText(github, 'README.md')).toBe('# Atlas\n\nA collection of city plans.\n');
	});

	describe('with no Baseline at all', () => {
		it.each(['', '# mine\n'])(
			'overwrites a site-owned marker holding %j, without calling it a source change',
			async (marker) => {
				const { store, github } = await small({ '.nojekyll': marker });

				const plan = await planFor(store, github, { baseline: null });
				await sendPlan(store, github, plan);

				expect(plan.conflicts).toEqual([]);
				expect(remoteText(github, '.nojekyll')).toBe('');
			}
		);

		it('establishes a Baseline where the two source namespaces are already equal', async () => {
			const { store, github } = await small();
			await send(store, github);

			const plan = await planFor(store, github, { baseline: null });
			const recorded = await sendPlan(store, github, plan);
			expect(plan.conflicts).toEqual([]);
			expect([...recorded.baseline.keys()]).toContain('amsterdam-1625/project.json');
		});

		it('leaves a Remote it cannot attribute exactly as it is, and refuses nothing over it', async () => {
			const { store, github } = await small({ 'README.md': '# Atlas\n', ...FLORIDA });

			const plan = await planFor(store, github, { baseline: null });
			await sendPlan(store, github, plan);

			expect([plan.conflicts, plan.removed]).toEqual([[], []]);
			expect(florida(github)).toEqual(FLORIDA_PATHS);
			expect(paths(github)).toContain('amsterdam-1625/project.json');
			expect(remoteText(github, 'README.md')).toBe('# Atlas\n');
		});

		it("names a file the two sides hold differently, and leaves the Remote's copy alone", async () => {
			const { store, github } = await small();
			await send(store, github);
			await github.commitFiles({
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam, revised"}'
			});

			const plan = await planFor(store, github, { baseline: null });
			await sendPlan(store, github, plan);

			expect(plan.conflicts.map((row) => row.path)).toEqual(['amsterdam-1625/project.json']);
			expect(remoteText(github, 'amsterdam-1625/project.json')).toBe(
				'{"formatVersion":1,"name":"Amsterdam, revised"}'
			);
		});

		it('does not read the website the Remote already serves as source it cannot attribute', async () => {
			const project = { 'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam"}' };
			const store = await seeded(project);
			const github = await createFakeGitHub({
				...REMOTE,
				tree: { ...project, ...SITE, 'index.html': '<!doctype html>' }
			});

			const plan = await planFor(store, github, {
				baseline: null,
				pending: [
					{ path: 'index.html', bytes: 400 },
					{ path: 'ballastella-site.json', bytes: 300 }
				]
			});

			expect(plan.conflicts).toEqual([]);
		});
	});
});

describe('the Jekyll marker every send writes', () => {
	const rootPaths = (github: FakeGitHub, commit: string): string[] =>
		paths(github, commit).filter((path) => !path.includes('/'));

	it('is at the root of every commit a send writes, and of no commit it did not', async () => {
		const store = await smallWorkspace();
		expect(await store.list('')).not.toContain('.nojekyll');
		const github = await atlasWithReadme();
		const ancestor = github.head() ?? '';
		const first = await send(store, github);
		const second = await send(store, github, shared(first));
		expect(github.history()).toEqual([second.commit, first.commit, ancestor]);
		expect([rootPaths(github, first.commit), rootPaths(github, second.commit)]).toEqual([
			['.nojekyll', 'README.md', 'ballastella-site.json', 'index.html'],
			['.nojekyll', 'README.md', 'ballastella-site.json', 'index.html']
		]);
		expect(github.files(first.commit).get('.nojekyll')?.byteLength).toBe(0);
		expect(rootPaths(github, ancestor)).toEqual(['README.md']);
	});

	it('is planned once when the Workspace already holds one, rather than twice', async () => {
		const store = await seeded({ ...SITE, '.nojekyll': '', 'index.html': '<!doctype html>' });
		const github = await createFakeGitHub({ ...REMOTE, tree: {} });
		const plan = await planFor(store, github);

		expect(plan.files.map((file) => [file.path, file.authored])).toEqual([
			['.nojekyll', false],
			['ballastella-site.json', false],
			['index.html', false]
		]);
	});
});
