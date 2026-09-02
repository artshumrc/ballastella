import { describe, expect, it, vi } from 'vitest';

import { FakeMetadataStorage } from './fake-metadata-storage.js';
import { LocalChangeIndex, checkSourceStatus } from './local-change-index.js';
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
import type { SynchronizationBaseline } from './synchronization-metadata.js';
import type { SourceStatus } from './synchronization-planner.js';

// Three claims are being held to account here, and each is one a plausible implementation gets wrong
// in a way no user would ever see reported.
//
//   1. **A check observes.** It lists Remote metadata and touches nothing else: no file bytes, no
//      Workspace read or write, and above all no Baseline. A check that recorded what it saw would
//      turn somebody else's afternoon into this machine's own evidence.
//   2. **A check is bounded.** Window focus is not a rare event, so a burst of them must share one
//      listing, and an authenticated session must not spend its hourly budget on status.
//   3. **A failed check is not agreement.** The last determination stays visible with the failure
//      beside it, and the words never become `In sync` or `Cannot tell`.

const ATLAS = { owner: 'ada', repository: 'atlas', branch: 'main' };
const WORKSPACE = 'opfs:Marking 2026';
const TOKEN = 'github_pat_11ABCDE0000abcdefghijklmnop';

const baseline = (files: Iterable<[string, string]>): SynchronizationBaseline => ({
	remote: ATLAS,
	commit: 'c0ffee',
	files: new Map(files)
});

const index = (storage: FakeMetadataStorage) =>
	new LocalChangeIndex(storage, WORKSPACE, { flushInterval: 0 });

/** A determination, for a checker whose transport is not what is under test. */
const determined = (
	status: SourceStatus,
	publishedSiteStale: readonly string[] = [],
	requested = true
): RemoteStatusObservation => ({ outcome: 'determined', status, publishedSiteStale, requested });

/** A clock a test moves by hand, so the throttle is asserted rather than waited for. */
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
	// The six determinations are words, and one of them is the word for "there is no trustworthy
	// evidence" — which a control showing nothing would render as safety.
	it('gives every one of the five a distinct sentence a reader can act on', () => {
		expect(REMOTE_STATUS_LABELS).toEqual({
			'in-sync': 'In sync',
			'changes-to-send': 'Changes to send',
			'changes-to-get': 'Changes to get',
			'changes-both-ways': 'Changes both ways',
			'cannot-tell': 'Cannot tell'
		});
		expect(new Set(Object.values(REMOTE_STATUS_LABELS)).size).toBe(5);
	});

	// ⚠ **There is no Conflict determination and there must not be one** (ADR-0046). A Sync resolves
	// a contested path into a copy or a question, so what the badge has to say about one is which
	// directions have work outstanding — which is both of them.
	it('has no word for a Conflict, because a Conflict is not a state of the Workspace', () => {
		expect(Object.keys(REMOTE_STATUS_LABELS)).not.toContain('conflict');
		expect(Object.values(REMOTE_STATUS_LABELS).join(' ').toLowerCase()).not.toContain('conflict');
	});

	// ⚠ Git's vocabulary describes a graph the scholar never sees, and *connected* reports a
	// relationship rather than whether the work is anywhere but this machine (ADR-0044).
	it('reaches for none of the words the glossary refuses', () => {
		const words = [...Object.values(REMOTE_STATUS_LABELS), REMOTE_STATUS_UNCHECKED]
			.join(' ')
			.toLowerCase();
		for (const refused of ['ahead', 'behind', 'up to date', 'connected', 'published', 'dirty']) {
			expect(words).not.toContain(refused);
		}
	});
});

describe('readRemoteInventory', () => {
	it('lists a public Remote with no credential at all', async () => {
		const github = await createFakeGitHub({
			owner: ATLAS.owner,
			repository: ATLAS.repository,
			tree: { 'README.md': '# Atlas\n', 'atlas/project.json': '{}' }
		});
		const sent: (string | undefined)[] = [];

		const inventory = await readRemoteInventory({
			remote: ATLAS,
			token: null,
			fetch: (input, init) => {
				sent.push(new Headers(init?.headers).get('Authorization') ?? undefined);
				return github.fetch(String(input), init);
			}
		});

		expect(inventory.map((entry) => entry.path).sort()).toEqual([
			'README.md',
			'atlas/project.json'
		]);
		// ⚠ **The whole point of the signed-out check.** An anonymous check that quietly sent a held
		// credential would go on working for everybody who had already signed in and fail only for the
		// student it exists for.
		expect(sent).toEqual([undefined]);
	});

	it('lists a Remote with a credential, and asks for no file bytes', async () => {
		const github = await createFakeGitHub({
			owner: ATLAS.owner,
			repository: ATLAS.repository,
			tree: { 'atlas/project.json': '{}' }
		});
		const asked: string[] = [];

		const inventory = await readRemoteInventory({
			remote: ATLAS,
			token: TOKEN,
			fetch: (input, init) => {
				asked.push(new URL(String(input)).pathname);
				return github.fetch(String(input), init);
			}
		});

		expect(inventory.map((entry) => entry.path)).toEqual(['atlas/project.json']);
		// One request, and it is a tree listing. No `/git/blobs`, and nothing on the raw host: a status
		// check transfers no files, so it cannot change either side.
		expect(asked).toEqual([`/repos/${ATLAS.owner}/${ATLAS.repository}/git/trees/main`]);
		expect(github.rawGets).toBe(0);
		expect(github.blobPosts).toBe(0);
	});

	it('is an empty inventory for a repository with no commits', async () => {
		const github = await createFakeGitHub({
			owner: ATLAS.owner,
			repository: ATLAS.repository
		});

		expect(
			await readRemoteInventory({
				remote: ATLAS,
				token: TOKEN,
				fetch: (input, init) => github.fetch(String(input), init)
			})
		).toEqual([]);
	});

	it('refuses a truncated listing rather than reading it as a Remote that lost files', async () => {
		const github = await createFakeGitHub({
			owner: ATLAS.owner,
			repository: ATLAS.repository,
			tree: { 'a.json': '{}', 'b.json': '{}', 'c.json': '{}' }
		});
		github.truncateAfter = 1;

		await expect(
			readRemoteInventory({
				remote: ATLAS,
				token: TOKEN,
				fetch: (input, init) => github.fetch(String(input), init)
			})
		).rejects.toMatchObject({ refusal: 'truncated' });
	});

	it('tells a spent hourly budget from a credential GitHub will not take', async () => {
		const spent = new Response('{"message":"rate limit"}', {
			status: 403,
			headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '1800000000' }
		});
		await expect(
			readRemoteInventory({ remote: ATLAS, token: TOKEN, fetch: async () => spent })
		).rejects.toMatchObject({ refusal: 'rate-limited' });

		await expect(
			readRemoteInventory({
				remote: ATLAS,
				token: TOKEN,
				fetch: async () => new Response('{}', { status: 401 })
			})
		).rejects.toMatchObject({ refusal: 'credential' });
	});

	it('says a network that never answered is not a status', async () => {
		const failure = await readRemoteInventory({
			remote: ATLAS,
			token: TOKEN,
			fetch: () => Promise.reject(new Error('Failed to fetch'))
		}).catch((cause: unknown) => cause);

		expect(failure).toBeInstanceOf(RemoteStatusUnavailableError);
		expect((failure as RemoteStatusUnavailableError).refusal).toBe('unreachable');
		// Every refusal ends by saying what the status on screen now means, because a scholar who reads
		// only the first half must not read it as "nothing has changed".
		expect((failure as RemoteStatusUnavailableError).message).toContain(
			'the last one Ballastella was able to work out'
		);
	});
});

describe('a successful check', () => {
	it('reads no local byte and moves no Baseline', async () => {
		const workspace = new MemoryProjectStore();
		const storage = new FakeMetadataStorage();
		const changes = index(storage);
		const managed = new ManagedProjectStore(workspace, changes);
		await managed.write('atlas/project.json', new TextEncoder().encode('{}'));
		await managed.flushChanges();

		const github = await createFakeGitHub({
			owner: ATLAS.owner,
			repository: ATLAS.repository,
			tree: { 'atlas/project.json': '{}' }
		});
		const before = new Map(storage.records);

		// Any access at all fails where it happens, which is a clearer report than a count at the end.
		// `read` covers hashing: there is no way to hash a file this store holds without asking for it.
		const refuse = (name: 'read' | 'list' | 'size' | 'write' | 'delete') =>
			vi.spyOn(workspace, name).mockImplementation(() => {
				throw new Error(`an observational check must not call ${name}`);
			});
		const spies = [
			refuse('read'),
			refuse('list'),
			refuse('size'),
			refuse('write'),
			refuse('delete')
		];
		const put = vi.spyOn(storage, 'put');

		const found = await checkSourceStatus({
			changes: managed,
			remote: await readRemoteInventory({
				remote: ATLAS,
				token: TOKEN,
				fetch: (input, init) => github.fetch(String(input), init)
			}),
			baseline: baseline([['atlas/project.json', await blobShaOf(github, 'atlas/project.json')]])
		});

		expect(found.status).toBe('changes-to-send');
		for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		// No durable record was written at all, so no Baseline and no index can have advanced, which is
		// the reason a check cannot hide drift.
		expect(put).not.toHaveBeenCalled();
		expect(storage.records).toEqual(before);
		// And nothing arrived on the Remote either.
		expect(github.blobPosts).toBe(0);
		expect(github.rawGets).toBe(0);
	});

	it('is Cannot tell without a Baseline, which is a determination and not a failure', async () => {
		const storage = new FakeMetadataStorage();
		const found = await checkSourceStatus({
			changes: index(storage),
			remote: [{ path: 'atlas/project.json', sha: 'r1' }],
			baseline: null
		});

		expect(found.status).toBe('cannot-tell');
		expect(REMOTE_STATUS_LABELS[found.status]).toBe('Cannot tell');
	});

	it('reports Publish-owned drift as staleness, leaving the source status In sync', async () => {
		const storage = new FakeMetadataStorage();

		const found = await checkSourceStatus({
			changes: index(storage),
			remote: [
				{ path: 'atlas/project.json', sha: 's1' },
				// A site another editor version rebuilt: different chunk names, identical scholarship.
				{ path: 'index.html', sha: 'newer' },
				{ path: '_app/immutable/entry/start.js', sha: 'newer' }
			],
			// A Baseline carrying generated output as well as source, so it is evidence about both.
			baseline: baseline([
				['atlas/project.json', 's1'],
				['index.html', 'ours'],
				['_app/immutable/entry/start.js', 'ours']
			])
		});

		expect(found.status).toBe('in-sync');
		expect(found.publishedSiteStale).toEqual(['_app/immutable/entry/start.js', 'index.html']);
	});

	it('claims no staleness where the Baseline is no evidence about generated output', async () => {
		const storage = new FakeMetadataStorage();

		const found = await checkSourceStatus({
			changes: index(storage),
			remote: [
				{ path: 'atlas/project.json', sha: 's1' },
				{ path: 'index.html', sha: 'published' }
			],
			// What an Open and a Publish both record: source paths only (ADR-0038). The Workspace holds
			// the site's files too, so calling every one of them drift would be a long and wrong notice.
			baseline: baseline([['atlas/project.json', 's1']])
		});

		expect(found.status).toBe('in-sync');
		expect(found.publishedSiteStale).toEqual([]);
	});
});

describe('RemoteStatusChecker', () => {
	/** A checker over a scripted observer, with a clock the test owns. */
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

	it('keeps the determination and the moment it was reached', async () => {
		const clock = testClock(5_000);
		const { checker } = checkerOver(async () => determined('changes-to-send'), clock);

		await checker.check('open');

		expect(checker.state.status).toBe('changes-to-send');
		expect(checker.state.at).toBe(5_000);
		expect(checker.state.failure).toBe('');
		expect(checker.state.checking).toBe(false);
	});

	it('announces that a check is running, and then that it is not', async () => {
		let release: (() => void) | undefined;
		const { checker, seen } = checkerOver(
			() =>
				new Promise<RemoteStatusObservation>((resolve) => {
					release = () => resolve(determined('in-sync'));
				})
		);

		const running = checker.check('open');
		expect(seen.map((state) => state.checking)).toEqual([true]);
		release?.();
		await running;

		expect(seen.map((state) => state.checking)).toEqual([true, false]);
	});

	it('shares one listing between callers inside a check already running', async () => {
		let release: (() => void) | undefined;
		let listings = 0;
		const { checker } = checkerOver(() => {
			listings += 1;
			return new Promise<RemoteStatusObservation>((resolve) => {
				release = () => resolve(determined('in-sync'));
			});
		});

		const first = checker.check('open');
		const second = checker.check('focus');
		const third = checker.check('focus');
		release?.();
		await Promise.all([first, second, third]);

		expect(listings).toBe(1);
	});

	it('keeps two automatic checks a bounded interval apart', async () => {
		const clock = testClock();
		let listings = 0;
		const { checker } = checkerOver(async () => {
			listings += 1;
			return determined('in-sync');
		}, clock);

		await checker.check('open');
		expect(listings).toBe(1);

		// Every switch back to the tab is a focus event, and a scholar comparing a facsimile produces
		// dozens a minute. None of them may reach GitHub.
		for (let focus = 0; focus < 20; focus += 1) {
			clock.advance(1_000);
			await checker.check('focus');
		}
		expect(listings).toBe(1);

		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');
		expect(listings).toBe(2);
	});

	it('does not spend the interval on a determination that cost no request', async () => {
		const clock = testClock();
		let checks = 0;
		const { checker } = checkerOver(async () => {
			checks += 1;
			// `Cannot tell` is settled from the Baseline's absence, so it asks GitHub nothing — and must
			// not hold off the check that follows the transfer which gives the Workspace a Baseline.
			return checks === 1 ? determined('cannot-tell', [], false) : determined('in-sync');
		}, clock);

		await checker.check('open');
		expect(checker.state.status).toBe('cannot-tell');

		await checker.check('focus');
		expect(checks).toBe(2);
		expect(checker.state.status).toBe('in-sync');

		// The one that did ask closes the window behind it.
		await checker.check('focus');
		expect(checks).toBe(2);
	});

	it('runs an explicit check whatever the interval says', async () => {
		const clock = testClock();
		let listings = 0;
		const { checker } = checkerOver(async () => {
			listings += 1;
			return determined('in-sync');
		}, clock);

		await checker.check('open');
		await checker.check('focus');
		await checker.check('explicit');

		// The focus was inside the window and the gesture was not: a user who presses a button is
		// answered, because the alternative is a control that does nothing when pressed.
		expect(listings).toBe(2);
	});

	it('makes no request at all for a check the caller will not attempt', async () => {
		const clock = testClock();
		const triggers: string[] = [];
		const { checker, seen } = checkerOver((trigger) => {
			triggers.push(trigger);
			// What a signed-out session answers an automatic trigger with: no listing, and no progress
			// announced for a check that was never going to happen.
			return trigger === 'explicit' ? Promise.resolve(determined('in-sync')) : null;
		}, clock);

		await checker.check('open');
		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');

		expect(seen).toEqual([]);
		expect(checker.state.status).toBeNull();

		await checker.check('explicit');
		expect(triggers).toEqual(['open', 'focus', 'explicit']);
		expect(checker.state.status).toBe('in-sync');
	});

	it('does not spend the interval on a check that turned out not to be attempted', async () => {
		const clock = testClock();
		let attempt = 0;
		const { checker, seen } = checkerOver(async () => {
			attempt += 1;
			// The order that matters: nothing was asked of GitHub first, and then something was.
			return attempt === 1 ? { outcome: 'not-attempted' as const } : determined('in-sync');
		}, clock);

		await checker.check('open');
		expect(checker.state.status).toBeNull();
		expect(checker.state.failure).toBe('');

		// The window belongs to attempts that happened, so this one is not held off by the one that
		// did nothing — otherwise a Workspace opened while signed out would stay unchecked for a minute
		// after signing in.
		await checker.check('focus');
		expect(attempt).toBe(2);
		expect(checker.state.status).toBe('in-sync');

		// And this one is, because the check before it did reach GitHub.
		await checker.check('focus');
		expect(attempt).toBe(2);
		expect(seen.at(-1)?.checking).toBe(false);
	});

	it('keeps the last successful status when a later check fails, and says the check failed', async () => {
		const clock = testClock();
		let attempt = 0;
		const { checker } = checkerOver(async () => {
			attempt += 1;
			if (attempt === 1) return determined('changes-to-send', ['index.html']);
			throw new RemoteStatusUnavailableError('unreachable', 'GitHub could not be reached.');
		}, clock);

		await checker.check('open');
		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');

		// ⚠ **The whole rule about a failed check, in one assertion.** A failure is never `In sync`
		// and never `Cannot tell`: the last thing this browser worked out stays, with the failure beside
		// it.
		expect(checker.state.status).toBe('changes-to-send');
		expect(checker.state.at).toBe(1_000);
		expect(checker.state.publishedSiteStale).toEqual(['index.html']);
		expect(checker.state.failure).toBe('GitHub could not be reached.');
		expect(checker.state.checking).toBe(false);
	});

	it('clears a failure once a check succeeds again', async () => {
		const clock = testClock();
		let attempt = 0;
		const { checker } = checkerOver(async () => {
			attempt += 1;
			if (attempt === 1) throw new Error('offline');
			return determined('in-sync');
		}, clock);

		await checker.check('open');
		expect(checker.state.failure).toBe('offline');
		expect(checker.state.status).toBeNull();

		clock.advance(AUTOMATIC_CHECK_INTERVAL_MS);
		await checker.check('focus');

		expect(checker.state.failure).toBe('');
		expect(checker.state.status).toBe('in-sync');
	});

	it('cannot render one Workspace’s result after the Workspace has been left', async () => {
		let release: ((observation: RemoteStatusObservation) => void) | undefined;
		const { checker, seen } = checkerOver(
			() =>
				new Promise<RemoteStatusObservation>((resolve) => {
					release = resolve;
				})
		);

		const running = checker.check('open');
		// The switch: one click, while a listing of a large tree is still in flight.
		checker.close();
		release?.(determined('changes-both-ways'));
		await running;

		// The arriving Workspace's control must not be handed the Workspace the user left.
		expect(checker.state.status).toBeNull();
		expect(seen.at(-1)?.status ?? null).toBeNull();
		// And a check asked for after the switch does nothing rather than starting one.
		await checker.check('explicit');
		expect(checker.state.status).toBeNull();
	});

	it('does not let a failure from a Workspace already left reach the next one', async () => {
		let reject: ((cause: unknown) => void) | undefined;
		const { checker } = checkerOver(
			() =>
				new Promise<RemoteStatusObservation>((_resolve, deny) => {
					reject = deny;
				})
		);

		const running = checker.check('open');
		checker.close();
		reject?.(new RemoteStatusUnavailableError('unreachable', 'GitHub could not be reached.'));
		await running;

		expect(checker.state.failure).toBe('');
	});
});

/** The blob SHA the fake gave one of its files, so a Baseline can agree with it exactly. */
async function blobShaOf(
	github: Awaited<ReturnType<typeof createFakeGitHub>>,
	path: string
): Promise<string> {
	const response = await github.fetch(
		`https://api.github.com/repos/${ATLAS.owner}/${ATLAS.repository}/git/trees/main?recursive=1`,
		{ headers: { Authorization: `Bearer ${TOKEN}` } }
	);
	const body = (await response.json()) as { tree: { path: string; sha: string }[] };
	const entry = body.tree.find((held) => held.path === path);
	if (entry === undefined) throw new Error(`the fake has no ${path}`);
	return entry.sha;
}
