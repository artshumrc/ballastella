import { beforeEach, describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { rejection } from '../test-support.js';
import {
	PAGES_POLL_DELAYS,
	RemoteBindRefusedError,
	awaitRemotePages,
	bindWorkspaceToRemote,
	disableRemotePages,
	enableRemotePages,
	guidedPagesStep,
	pagesSettingsUrl,
	readRemoteRights,
	shareLinksWithdrawalMessage,
	withdrawalNotRecordedMessage
} from './bind-remote.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';
import { ATLAS as REMOTE, atlasWithReadme } from './remote-test-support.js';

const TOKEN = 'github_pat_11ABCDE0000abcdefghij';
const github = atlasWithReadme;
const SETTINGS_URL = 'https://github.com/ada/atlas/settings/pages';
const BRANCH_STEP = [/Settings → Pages/, /Deploy from a branch/, /“main”/, /\/ \(root\)/];

const via = <T extends object = object>(fetch: FetchFn, overrides = {} as T) => ({
	token: TOKEN,
	remote: REMOTE,
	fetch,
	...overrides
});

const offline: FetchFn = () => Promise.reject(new TypeError('Failed to fetch'));

const counting = (fake: FakeGitHub) => {
	const seen: { input: string; authorization: string | null }[] = [];
	const fetch: FetchFn = (input, init) => {
		seen.push({
			input: String(input),
			authorization: new Headers(init?.headers).get('Authorization')
		});
		return fake.fetch(input, init);
	};
	return { fetch, seen };
};

const rejectingCredential = async (): Promise<FetchFn> => {
	const remote = await github();
	remote.rejectCredential = true;
	return remote.fetch;
};

const reviewCopy = (): MemoryProjectStore => {
	const store = new MemoryProjectStore();
	store.plant(
		REVIEW_MARK_PATH,
		serialiseReviewMark({
			formatVersion: REVIEW_MARK_FORMAT_VERSION,
			project: 'Amsterdam 1625',
			directory: 'amsterdam-1625',
			openedAt: '2026-08-08T09:00:00.000Z',
			origin: null
		})
	);
	return store;
};

describe('the rights check that happens at bind, not after four thousand tiles (ADR-0033)', () => {
	it.each([
		['a credential that may push', TOKEN, true, true],
		['a credential that may not', TOKEN, false, false],
		['no push rights when GitHub said nothing about them', '', true, false]
	])('reports %s', async (_what, token, push, canPush) => {
		const remote = await github();
		if (!push) remote.permissions = { push: false, admin: false };

		expect(await readRemoteRights(via(remote.fetch, { token }))).toEqual({ canPush });
	});

	it.each([
		[
			'a credential GitHub will not accept, and says the token was not kept',
			rejectingCredential,
			REMOTE,
			'credential',
			/would not accept that token.*has not been kept/s
		],
		[
			'a repository that is not there, and says a private one looks the same',
			async () => (await github()).fetch,
			{ owner: 'ada', repository: 'not-a-repository' },
			'no-repository',
			/private repository looks exactly like a missing one/
		]
	])('refuses %s', async (_what, fetch, remote, refusal, message) => {
		const cause = await rejection(
			RemoteBindRefusedError,
			readRemoteRights(via(await fetch(), { remote }))
		);
		expect(cause.refusal).toBe(refusal);
		expect(cause.message).toMatch(message);
	});

	it('says a network failure is the connection rather than a missing repository', async () => {
		await expect(readRemoteRights(via(offline))).rejects.toThrow(
			/could not be reached.*still saved on this computer/s
		);
	});
});

describe('turning Pages on, whose failure is a step rather than an error', () => {
	it.each([false, true])('turns it on when permitted (already enabled: %s)', async (already) => {
		const remote = await github();
		remote.pagesEnabled = already;

		expect(await enableRemotePages(via(remote.fetch))).toEqual({
			enabled: true,
			next: 'none',
			instruction: '',
			settingsUrl: '',
			branch: ''
		});
		expect(remote.pagesEnabled).toBe(true);
	});

	it('names both permissions and hands over the exact screen, branch and folder when it could not', async () => {
		const remote = await github();
		remote.refusePages = true;

		const outcome = await enableRemotePages(via(remote.fetch));
		expect(outcome).toMatchObject({
			enabled: false,
			next: 'guided',
			settingsUrl: SETTINGS_URL,
			branch: 'main'
		});
		for (const said of [
			/Pages: Read and write/,
			/Administration: Read and write/,
			...BRANCH_STEP
		]) {
			expect(outcome.instruction).toMatch(said);
		}
	});

	it('hands over the same step with nothing asked of GitHub, as the author’s own setting', () => {
		const outcome = guidedPagesStep(REMOTE);
		expect(outcome).toMatchObject({
			enabled: false,
			next: 'guided',
			settingsUrl: SETTINGS_URL,
			branch: 'main'
		});
		for (const said of [
			/one setting you make yourself/,
			/Administration: Read and write/,
			...BRANCH_STEP
		]) {
			expect(outcome.instruction).toMatch(said);
		}
		expect(outcome.instruction).not.toMatch(/this credential does not have/);
	});

	it('says the repository is empty rather than blaming the token, when there is no branch', async () => {
		const remote = await createFakeGitHub({ owner: REMOTE.owner, repository: REMOTE.repository });
		const outcome = await enableRemotePages(via(remote.fetch));
		expect([outcome.enabled, outcome.next]).toEqual([false, 'sync-first']);
		expect(outcome.instruction).toMatch(/repository is empty/);
		expect(outcome.instruction).toMatch(/Sync once/);
		expect(outcome.instruction).not.toMatch(
			/does not have|Pages: Read and write|Administration: Read and write/
		);
	});

	it('never throws, even when GitHub cannot be reached at all', async () => {
		const outcome = await enableRemotePages(via(offline));
		expect([outcome.enabled, outcome.next]).toEqual([false, 'guided']);
		expect(outcome.instruction).toMatch(/Settings → Pages/);
	});
});

describe('checking again until the site answers', () => {
	const waited: number[] = [];
	const wait = async (milliseconds: number) => void waited.push(milliseconds);

	beforeEach(() => {
		waited.length = 0;
	});

	it('answers at once when the site is already there, waiting for nothing', async () => {
		const remote = await github();
		remote.pagesEnabled = true;

		const outcome = await awaitRemotePages(via(remote.fetch, { wait }));
		expect([outcome.enabled, outcome.next, waited]).toEqual([true, 'none', []]);
	});

	it('keeps asking while the answer is “not yet”, and carries on the moment it is not', async () => {
		const remote = await github();
		let asks = 0;
		const answering: FetchFn = (input, init) => {
			if (String(input).endsWith('/pages') && ++asks === 3) remote.pagesEnabled = true;
			return remote.fetch(input, init);
		};

		const outcome = await awaitRemotePages(via(answering, { wait }));
		expect([outcome.enabled, asks, waited]).toEqual([true, 3, [...PAGES_POLL_DELAYS.slice(1, 3)]]);
	});

	it('gives up on the guided step rather than polling forever', async () => {
		const remote = await github();
		const outcome = await awaitRemotePages(via(remote.fetch, { wait }));
		expect([outcome.enabled, outcome.next, outcome.settingsUrl]).toEqual([
			false,
			'guided',
			SETTINGS_URL
		]);
		expect(waited.length).toBe(PAGES_POLL_DELAYS.length - 1);
	});

	it('never throws when GitHub cannot be reached at all', async () => {
		expect((await awaitRemotePages(via(offline, { wait }))).enabled).toBe(false);
	});
});

describe('withdrawing Share Links', () => {
	it.each([
		['takes the site down', true],
		['treats a repository with no site as the state it wanted', false]
	])('%s', async (_what, live) => {
		const remote = await github();
		remote.pagesEnabled = live;

		expect(await disableRemotePages(via(remote.fetch))).toEqual({ disabled: true, notice: '' });
		expect(remote.pagesEnabled).toBe(false);
	});

	it('never throws, and says the site may still answer when GitHub refused', async () => {
		const remote = await github();
		remote.pagesEnabled = true;
		remote.refusePages = true;

		const withdrawal = await disableRemotePages(via(remote.fetch));
		expect(withdrawal.disabled).toBe(false);
		expect(withdrawal.notice).toMatch(/may still answer/);
		expect(withdrawal.notice).toMatch(/your own work is untouched/i);
		expect(withdrawal.notice).toContain(pagesSettingsUrl(REMOTE));
	});

	it.each([
		[
			'what cannot be undone, and what is untouched',
			shareLinksWithdrawalMessage,
			[
				/already given out stops working/,
				/cache/,
				/forked/,
				/cannot make anything unseen/i,
				/repository and your own files are untouched/
			]
		],
		[
			'that the next Sync puts the site back when the request could not be kept',
			withdrawalNotRecordedMessage,
			[
				/ada\/atlas/,
				/put the viewer's files back/,
				/browser storage may be full/,
				/Withdraw Share Links again/
			]
		]
	])('says plainly %s', (_what, message, said) => {
		for (const words of said) expect(message(REMOTE)).toMatch(words);
	});
});

describe('connecting a Workspace', () => {
	it('answers the repository with its one branch resolved unasked, and the rights, leaving Pages and the store alone', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();
		const outcome = await bindWorkspaceToRemote(
			store,
			'My Workspace',
			via(remote.fetch, { remote: { owner: 'ada', repository: 'atlas' } })
		);
		expect(outcome).toMatchObject({
			canPush: true,
			rightsNotice: '',
			remote: { owner: 'ada', repository: 'atlas', branch: 'main' }
		});
		expect([remote.pagesEnabled, await store.list('')]).toEqual([false, []]);
	});

	it('binds without a word about Pages when the credential could not have turned it on', async () => {
		const remote = await github();
		remote.refusePages = true;

		const outcome = await bindWorkspaceToRemote(
			new MemoryProjectStore(),
			'My Workspace',
			via(remote.fetch)
		);
		expect(outcome).not.toHaveProperty('pages');
		expect(outcome.rightsNotice).toBe('');
	});

	it('still connects when the credential cannot push, and says so plainly', async () => {
		const remote = await github();
		remote.permissions = { push: false, admin: false };

		const outcome = await bindWorkspaceToRemote(
			new MemoryProjectStore(),
			'My Workspace',
			via(remote.fetch)
		);
		expect([outcome.canPush, outcome.remote.repository]).toEqual([false, 'atlas']);
		expect(outcome.rightsNotice).toMatch(/cannot push to ada\/atlas/);
		expect(outcome.rightsNotice).toMatch(/Contents: Read and write/);
	});

	it('writes nothing when GitHub refuses the credential', async () => {
		const store = new MemoryProjectStore();

		await expect(
			bindWorkspaceToRemote(
				store,
				'My Workspace',
				via(await rejectingCredential(), { token: 'ghp_expired' })
			)
		).rejects.toThrow(RemoteBindRefusedError);

		expect(await store.list('')).toEqual([]);
	});
});

describe('connecting a Workspace with nobody signed in', () => {
	it('connects to a public repository claiming no push rights, and sends no Authorization header', async () => {
		const store = new MemoryProjectStore();
		const watched = counting(await github());

		const outcome = await bindWorkspaceToRemote(
			store,
			'My Workspace',
			via(watched.fetch, { token: null })
		);

		expect(outcome).toMatchObject({
			canPush: false,
			rightsNotice: '',
			remote: { owner: 'ada', repository: 'atlas', branch: 'main' }
		});
		expect(await store.list('')).toEqual([]);
		const sent = watched.seen.map((one) => one.authorization);
		expect(sent).not.toEqual([]);
		expect(sent.every((one) => one === null)).toBe(true);
	});

	it('names the sign-in as the remedy when GitHub answers nothing at that address', async () => {
		const remote = await github();

		const refusal = await rejection(
			RemoteBindRefusedError,
			bindWorkspaceToRemote(
				new MemoryProjectStore(),
				'My Workspace',
				via(remote.fetch, { token: null, remote: { owner: 'ada', repository: 'private-atlas' } })
			)
		);

		expect(refusal.refusal).toBe('no-repository');
		expect(refusal.message).toMatch(/no public repository at ada\/private-atlas/);
		expect(refusal.message).toMatch(/sign in/i);
	});
});

describe('a Review Workspace can never be bound', () => {
	it.each([
		['is refused before a single request is made', TOKEN],
		['is refused with no credential either, so anonymity is not a way round it', null]
	])('%s', async (_, token) => {
		const remote = await github();
		const counted = counting(remote);

		await expect(
			bindWorkspaceToRemote(reviewCopy(), 'assignment 7', via(counted.fetch, { token }))
		).rejects.toThrow(ReviewWorkspaceError);

		expect(counted.seen).toEqual([]);
		expect(remote.pagesEnabled).toBe(false);
	});
});

describe('binding to a Remote whatever Projects it already carries', () => {
	const siteRecord = (...projects: { directory: string; name: string }[]): string =>
		JSON.stringify({
			formatVersion: 2,
			viewerVersion: 'test',
			publishedAt: '2026-08-01T09:00:00.000Z',
			projects: projects.map((project) => ({ ...project, onFrontPage: true })),
			baseMap: { entries: [] },
			baseMapBundled: false,
			baseMapAssetsBundled: false,
			baseMapCaches: []
		});

	const alreadySent = (): Promise<FakeGitHub> =>
		createFakeGitHub({
			owner: REMOTE.owner,
			repository: REMOTE.repository,
			tree: {
				'README.md': '# Atlas\n',
				'ballastella-site.json': siteRecord(
					{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' },
					{ directory: 'florida-1657', name: 'Florida 1657' }
				),
				'amsterdam-1625/project.json': '{"formatVersion":1,"name":"Amsterdam 1625"}',
				'florida-1657/project.json': '{"formatVersion":1,"name":"Florida 1657"}'
			}
		});

	it.each([
		['carrying Projects this Workspace has not got', alreadySent],
		['nothing has ever been sent to', github]
	])('connects to a Remote %s, reading nothing but the repository itself', async (_what, fake) => {
		const store = new MemoryProjectStore();
		store.plant('amsterdam-1625/project.json', new TextEncoder().encode('{"formatVersion":1}'));
		const counted = counting(await fake());

		const outcome = await bindWorkspaceToRemote(store, 'atlas', via(counted.fetch));

		expect(outcome.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
		expect(counted.seen.filter((one) => one.input.includes('raw.githubusercontent.com'))).toEqual(
			[]
		);
	});
});
