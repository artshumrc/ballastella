import { describe, expect, it, vi } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { checkSourceStatus } from './local-change-index.js';
import { ManagedProjectStore } from '../store/managed-project-store.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import {
	AUTOMATIC_CHECK_INTERVAL_MS,
	REMOTE_STATUS_LABELS,
	REMOTE_STATUS_UNCHECKED,
	RemoteStatusChecker,
	RemoteStatusUnavailableError,
	readRemoteInventory,
	type RemoteStatusObservation,
	type RemoteStatusState
} from './remote-status.js';
import { createFakeGitHub } from './fake-github.js';
import {
	ATLAS,
	baselineWith as baseline,
	changeIndex as index,
	shas
} from './remote-test-support.js';
import { rejection } from '../test-support.js';
import type { SourceStatus } from './synchronization-planner.js';

const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

const inventoryOver = (fetch: FetchFn, token: string | null = TOKEN) =>
	readRemoteInventory({ remote: ATLAS, token, fetch });

const determined = (
	status: SourceStatus,
	publishedSiteStale: readonly string[] = [],
	requested = true,
	shareLinks = false
): RemoteStatusObservation => ({
	outcome: 'determined',
	status,
	publishedSiteStale,
	requested,
	shareLinks
});

function testClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
	let at = start;
	return {
		now: () => at,
		advance: (ms) => {
			at += ms;
		}
	};
}

describe('the Remote Status a scholar reads', () => {
	it('gives each of the five a distinct sentence, none a Conflict or a word the glossary refuses', () => {
		expect(REMOTE_STATUS_LABELS).toEqual({
			'in-sync': 'In sync',
			'changes-to-send': 'Changes to send',
			'changes-to-get': 'Changes to get',
			'changes-both-ways': 'Changes both ways',
			'cannot-tell': 'Cannot tell'
		});
		const words = [...Object.values(REMOTE_STATUS_LABELS), REMOTE_STATUS_UNCHECKED]
			.join(' ')
			.toLowerCase();
		for (const refused of ['conflict', 'ahead', 'behind', 'up to date', 'bound', 'sent', 'dirty']) {
			expect(words).not.toContain(refused);
		}
	});
});

describe('readRemoteInventory', () => {
	it.each([
		['a public Remote with no credential at all', null],
		['a Remote with a credential', TOKEN]
	])('lists %s, asking for no file bytes', async (_case, token) => {
		const github = await createFakeGitHub({
			...ATLAS,
			tree: { 'README.md': '# Atlas\n', 'atlas/project.json': '{}' }
		});
		const asked: { path: string; authorized: boolean }[] = [];

		const inventory = await inventoryOver((input, init) => {
			asked.push({
				path: new URL(String(input)).pathname,
				authorized: new Headers(init?.headers).has('Authorization')
			});
			return github.fetch(String(input), init);
		}, token);

		expect(inventory.map((entry) => entry.path).sort()).toEqual([
			'README.md',
			'atlas/project.json'
		]);
		expect(asked).toEqual([
			{
				path: `/repos/${ATLAS.owner}/${ATLAS.repository}/git/trees/main`,
				authorized: token !== null
			}
		]);
		expect([github.rawGets, github.blobPosts]).toEqual([0, 0]);
	});

	it('is an empty inventory for a repository with no commits', async () => {
		const github = await createFakeGitHub(ATLAS);
		expect(await inventoryOver(github.fetch)).toEqual([]);
	});

	it.each([
		[
			'a truncated listing, rather than read it as a Remote that lost files',
			async (): Promise<FetchFn> => {
				const github = await createFakeGitHub({
					...ATLAS,
					tree: { 'a.json': '{}', 'b.json': '{}', 'c.json': '{}' }
				});
				github.truncateAfter = 1;
				return github.fetch;
			},
			'truncated',
			''
		],
		[
			'a spent hourly budget',
			async (): Promise<FetchFn> => async () =>
				new Response('{"message":"rate limit"}', {
					status: 403,
					headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800000000' }
				}),
			'rate-limited',
			''
		],
		[
			'a credential GitHub will not take',
			async (): Promise<FetchFn> => async () => new Response('{}', { status: 401 }),
			'credential',
			''
		],
		[
			'a network that never answered, which is not a status',
			async (): Promise<FetchFn> => () => Promise.reject(new Error('Failed to fetch')),
			'unreachable',
			'the last one Ballastella was able to work out'
		]
	])('refuses %s', async (_case, fetchFor, refusal, message) => {
		const failure = await rejection(RemoteStatusUnavailableError, inventoryOver(await fetchFor()));

		expect(failure.refusal).toBe(refusal);
		expect(failure.message).toContain(message);
	});
});

describe('a successful check', () => {
	it('reads no local byte and moves no Baseline', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const managed = new ManagedProjectStore(workspace, index(storage));
		await managed.write('atlas/project.json', new TextEncoder().encode('{}'));
		await managed.flushChanges();

		const github = await createFakeGitHub({ ...ATLAS, tree: { 'atlas/project.json': '{}' } });
		const before = new Map(storage.records);

		const spies = (['read', 'list', 'size', 'write', 'delete'] as const).map((name) =>
			vi.spyOn(workspace, name).mockImplementation(() => {
				throw new Error(`an observational check must not call ${name}`);
			})
		);
		const put = vi.spyOn(storage, 'put');

		const found = await checkSourceStatus({
			changes: managed,
			remote: await inventoryOver(github.fetch),
			baseline: baseline(await shas({ 'atlas/project.json': '{}' }))
		});

		expect(found.status).toBe('changes-to-send');
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		expect(put).not.toHaveBeenCalled();
		expect(storage.records).toEqual(before);
		expect([github.blobPosts, github.rawGets]).toEqual([0, 0]);
	});

	const PROJECT = { path: 'atlas/project.json', sha: 's1' };

	it.each([
		[
			'Cannot tell without a Baseline, which is a determination and not a failure',
			[{ path: 'atlas/project.json', sha: 'r1' }],
			null,
			{ status: 'cannot-tell' }
		],
		[
			'site-owned drift as staleness, leaving the source status In sync',
			[
				PROJECT,
				{ path: 'index.html', sha: 'newer' },
				{ path: '_app/immutable/entry/start.js', sha: 'newer' }
			],
			baseline([
				['atlas/project.json', 's1'],
				['index.html', 'ours'],
				['_app/immutable/entry/start.js', 'ours']
			]),
			{
				status: 'in-sync',
				publishedSiteStale: ['_app/immutable/entry/start.js', 'index.html'],
				shareLinks: false
			}
		],
		[
			'no staleness where the Baseline is no evidence about generated output',
			[PROJECT, { path: 'index.html', sha: 'site-write' }],
			baseline([['atlas/project.json', 's1']]),
			{ status: 'in-sync', publishedSiteStale: [], shareLinks: false }
		],
		[
			'share links where the Remote itself carries a Published Site',
			[PROJECT, { path: 'ballastella-site.json', sha: 'site' }],
			baseline([['atlas/project.json', 's1']]),
			{ status: 'in-sync', shareLinks: true }
		]
	])('reports %s', async (_case, remote, from, expected) => {
		const found = await checkSourceStatus({
			changes: index(new FakeMetadataStorage()),
			remote,
			baseline: from
		});

		expect(found).toMatchObject(expected);
	});
});

describe('RemoteStatusChecker', () => {
	function checkerOver(
		observe: (trigger: 'open' | 'focus' | 'explicit') => Promise<RemoteStatusObservation> | null,
		clock = testClock()
	) {
		const seen: RemoteStatusState[] = [];
		const checker = new RemoteStatusChecker({
			observe,
			now: clock.now,
			onChange: (state) => seen.push(state)
		});
		return { checker, seen, clock };
	}

	function held() {
		let settle!: {
			resolve: (observation: RemoteStatusObservation) => void;
			reject: (cause: unknown) => void;
		};
		const promise = new Promise<RemoteStatusObservation>((resolve, reject) => {
			settle = { resolve, reject };
		});
		return { promise, ...settle };
	}

	it('announces a running check, then keeps the determination and the moment it was reached', async () => {
		const pending = held();
		const { checker, seen } = checkerOver(() => pending.promise, testClock(5_000));

		const running = checker.check('open');
		expect(seen.map((state) => state.checking)).toEqual([true]);
		pending.resolve(determined('changes-to-send'));
		await running;

		expect(seen.map((state) => state.checking)).toEqual([true, false]);
		expect(checker.state).toMatchObject({
			status: 'changes-to-send',
			at: 5_000,
			failure: '',
			checking: false
		});
	});

	it('shares one listing between callers inside a check already running', async () => {
		const pending = held();
		let listings = 0;
		const { checker } = checkerOver(() => {
			listings += 1;
			return pending.promise;
		});

		const checks = [checker.check('open'), checker.check('focus'), checker.check('focus')];
		pending.resolve(determined('in-sync'));
		await Promise.all(checks);

		expect(listings).toBe(1);
	});

	it('keeps two automatic checks a bounded interval apart, and runs an explicit one regardless', async () => {
		let listings = 0;
		const { checker, clock } = checkerOver(async () => {
			listings += 1;
			return determined('in-sync');
		});

		await checker.check('open');
		for (let focus = 0; focus < 20; focus += 1) {
			clock.advance(1_000);
			await checker.check('focus');
		}
		expect(listings).toBe(1);

		await checker.check('explicit');
		expect(listings).toBe(2);

		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');
		expect(listings).toBe(3);
	});

	it.each([
		['a determination that cost no request', determined('cannot-tell', [], false), 'cannot-tell'],
		['a check that turned out not to be attempted', { outcome: 'not-attempted' as const }, null]
	])('does not spend the interval on %s', async (_case, first, status) => {
		let checks = 0;
		const { checker, seen } = checkerOver(async () => {
			checks += 1;
			return checks === 1 ? first : determined('in-sync');
		});

		await checker.check('open');
		expect([checker.state.status, checker.state.failure]).toEqual([status, '']);

		await checker.check('focus');
		expect([checks, checker.state.status]).toEqual([2, 'in-sync']);

		await checker.check('focus');
		expect(checks).toBe(2);
		expect(seen.at(-1)?.checking).toBe(false);
	});

	it('makes no request at all for a check the caller will not attempt', async () => {
		const triggers: string[] = [];
		const { checker, seen, clock } = checkerOver((trigger) => {
			triggers.push(trigger);
			return trigger === 'explicit' ? Promise.resolve(determined('in-sync')) : null;
		});

		await checker.check('open');
		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');

		expect(seen).toEqual([]);
		expect(checker.state.status).toBeNull();

		await checker.check('explicit');
		expect(triggers).toEqual(['open', 'focus', 'explicit']);
		expect(checker.state.status).toBe('in-sync');
	});

	it('clears a failure on success, and keeps the last success when a later check fails', async () => {
		let attempt = 0;
		const { checker, clock } = checkerOver(async () => {
			attempt += 1;
			if (attempt === 1) throw new Error('offline');
			if (attempt === 2) return determined('changes-to-send', ['index.html'], true, true);
			throw new RemoteStatusUnavailableError('unreachable', 'GitHub could not be reached.');
		});

		await checker.check('open');
		expect([checker.state.failure, checker.state.status]).toEqual(['offline', null]);

		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');
		expect([checker.state.failure, checker.state.status]).toEqual(['', 'changes-to-send']);

		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');
		expect(checker.state).toMatchObject({
			status: 'changes-to-send',
			at: 1_000 + AUTOMATIC_CHECK_INTERVAL_MS,
			publishedSiteStale: ['index.html'],
			failure: 'GitHub could not be reached.',
			shareLinks: true,
			checking: false
		});
	});

	it.each([
		[
			'result',
			(pending: ReturnType<typeof held>) => pending.resolve(determined('changes-both-ways'))
		],
		[
			'failure',
			(pending: ReturnType<typeof held>) =>
				pending.reject(
					new RemoteStatusUnavailableError('unreachable', 'GitHub could not be reached.')
				)
		]
	])('cannot render a %s from a Workspace already left', async (_case, settle) => {
		const pending = held();
		const { checker, seen } = checkerOver(() => pending.promise);

		const running = checker.check('open');
		checker.close();
		settle(pending);
		await running;

		expect([checker.state.status, checker.state.failure]).toEqual([null, '']);
		expect(seen.at(-1)?.status ?? null).toBeNull();
		await checker.check('explicit');
		expect(checker.state.status).toBeNull();
	});
});
