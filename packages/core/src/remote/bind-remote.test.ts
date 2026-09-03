import { beforeEach, describe, expect, it } from 'vitest';

import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	REVIEW_MARK_FORMAT_VERSION,
	REVIEW_MARK_PATH,
	ReviewWorkspaceError,
	serialiseReviewMark
} from '../project/review-workspace.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import {
	PAGES_POLL_DELAYS,
	RemoteBindRefusedError,
	awaitRemotePages,
	bindWorkspaceToRemote,
	disableRemotePages,
	enableRemotePages,
	pagesSettingsUrl,
	readRemoteRights,
	shareLinksWithdrawalMessage,
	type RemoteReference
} from './bind-remote.js';
import { createFakeGitHub, type FakeGitHub } from './fake-github.js';

// The in-memory seam, against the one shared fake GitHub. What is asserted here is the *answer* —
// may this credential push, is the site on, what is the author owed next — rather than which requests
// were made, for the reason CONTRIBUTING.md gives: a test that counts calls passes over every one of
// the silent failures connecting can have.

const REMOTE: RemoteReference = { owner: 'ada', repository: 'atlas', branch: 'main' };
const TOKEN = 'github_pat_11ABCDE0000abcdefghij';

/**
 * The ordinary repository this suite binds to: public, with a `main` branch already on it.
 *
 * A starting tree rather than none, because a repository with no commits has no branch for Pages to
 * be pointed at and is its own case — {@link emptyRepository} below.
 */
const github = (): Promise<FakeGitHub> =>
	createFakeGitHub({
		owner: REMOTE.owner,
		repository: REMOTE.repository,
		tree: { 'README.md': '# Atlas\n' }
	});

/** A repository created a moment ago at `github.com/new`, with nothing in it and no branches. */
const emptyRepository = (): Promise<FakeGitHub> =>
	createFakeGitHub({ owner: REMOTE.owner, repository: REMOTE.repository });

/** A GitHub that will not accept the credential at all: an expired or revoked token. */
const rejectingCredential = async (): Promise<FetchFn> => {
	const remote = await github();
	remote.rejectCredential = true;
	return remote.fetch;
};

/** A Workspace that is a review copy of somebody else's Project (ADR-0024). */
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
	it('reports a credential that may push', async () => {
		const remote = await github();

		expect(await readRemoteRights({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual({
			canPush: true
		});
	});

	it('reports a credential that may not', async () => {
		const remote = await github();
		remote.permissions = { push: false, admin: false };

		expect(await readRemoteRights({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual({
			canPush: false
		});
	});

	// `permissions` appears only on an authenticated read, so a response without it is a read GitHub
	// answered for anybody. "Nobody said you may push" is the same answer as "you may not", and the
	// only question being asked is whether a send would be refused. Provoked by sending no
	// credential at all, which is the one way a real repository answers without the field.
	it('reports no push rights when GitHub said nothing about them', async () => {
		const remote = await github();

		expect(await readRemoteRights({ token: '', remote: REMOTE, fetch: remote.fetch })).toEqual({
			canPush: false
		});
	});

	it('refuses a credential GitHub will not accept, and says the token was not kept', async () => {
		await expect(
			readRemoteRights({ token: 'ghp_expired', remote: REMOTE, fetch: await rejectingCredential() })
		).rejects.toThrow(/would not accept that token.*has not been kept/s);
	});

	it('refuses a repository that is not there, and says a private one looks the same', async () => {
		const remote = await github();

		await expect(
			readRemoteRights({
				token: TOKEN,
				remote: { owner: 'ada', repository: 'not-a-repository' },
				fetch: remote.fetch
			})
		).rejects.toThrow(/private repository looks exactly like a missing one/);
	});

	it('tells the two refusals apart, so the screen can offer the right remedy', async () => {
		const remote = await github();
		const refusal = async (against: RemoteReference, fetch: FetchFn) =>
			readRemoteRights({ token: TOKEN, remote: against, fetch }).catch(
				(cause: unknown) => (cause as RemoteBindRefusedError).refusal
			);

		expect(await refusal(REMOTE, await rejectingCredential())).toBe('credential');
		expect(await refusal({ owner: 'ada', repository: 'nope' }, remote.fetch)).toBe('no-repository');
	});

	it('says a network failure is the connection rather than a missing repository', async () => {
		const offline = () => Promise.reject(new TypeError('Failed to fetch'));

		await expect(
			readRemoteRights({ token: TOKEN, remote: REMOTE, fetch: offline })
		).rejects.toThrow(/could not be reached.*still saved on this computer/s);
	});
});

// ⚠ **Four outcomes and no fifth, and none of them is a throw** (ADR-0045). A repository full of
// correct files that serves nothing is the failure this exists to avoid, and an error dialog is a
// worse one — so every answer here is a sentence and a next action.
describe('turning Pages on, whose failure is a step rather than an error', () => {
	it('turns it on when the credential is permitted to', async () => {
		const remote = await github();

		const outcome = await enableRemotePages({ token: TOKEN, remote: REMOTE, fetch: remote.fetch });

		expect(outcome).toEqual({
			enabled: true,
			next: 'none',
			instruction: '',
			settingsUrl: '',
			branch: ''
		});
		expect(remote.pagesEnabled).toBe(true);
	});

	// A scholar asking again on a second machine meets this every time, and it is success: the site
	// already serves.
	it('treats “already enabled” as success', async () => {
		const remote = await github();
		remote.pagesEnabled = true;

		const outcome = await enableRemotePages({ token: TOKEN, remote: REMOTE, fetch: remote.fetch });

		expect([outcome.enabled, outcome.next, outcome.instruction]).toEqual([true, 'none', '']);
	});

	// ⚠ **Both permissions, because `POST /pages` needs both.** GitHub requires `Pages: write` *and*
	// `Administration: write` together, and this App asks for neither — ADR-0040 refuses
	// `Administration` outright. A sentence naming only `Pages` sends a scholar to grant the one
	// permission they may already have granted, and leaves them there.
	it('names both permissions, the setting, the branch, and the folder when it could not', async () => {
		const remote = await github();
		remote.refusePages = true;

		const outcome = await enableRemotePages({ token: TOKEN, remote: REMOTE, fetch: remote.fetch });

		expect(outcome.enabled).toBe(false);
		expect(outcome.next).toBe('guided');
		expect(outcome.instruction).toMatch(/Pages: Read and write/);
		expect(outcome.instruction).toMatch(/Administration: Read and write/);
		expect(outcome.instruction).toMatch(/Settings → Pages/);
		expect(outcome.instruction).toMatch(/Deploy from a branch/);
		expect(outcome.instruction).toMatch(/“main”/);
		expect(outcome.instruction).toMatch(/\/ \(root\)/);
	});

	// ⚠ **The guided step is one click and not a search** — the screen, the branch, and the folder,
	// handed over rather than described. The link is on the outcome so that whoever renders it cannot
	// build a different one from the sentence beside it.
	it('hands over the exact screen and the exact branch, not a description of them', async () => {
		const remote = await github();
		remote.refusePages = true;

		const outcome = await enableRemotePages({ token: TOKEN, remote: REMOTE, fetch: remote.fetch });

		expect(outcome.settingsUrl).toBe('https://github.com/ada/atlas/settings/pages');
		expect(outcome.branch).toBe('main');
	});

	// ⚠ **A 422 is a repository with no branches, and saying "your token lacks Pages: write" there is
	// wrong twice**: it names a permission that is fine, and then tells the scholar to choose a branch
	// their repository does not have. It is the ordinary state of a repository made a moment ago at
	// `github.com/new`, which is the link the guided sequence hands them.
	it('says the repository is empty rather than blaming the token, when there is no branch', async () => {
		const remote = await emptyRepository();

		const outcome = await enableRemotePages({ token: TOKEN, remote: REMOTE, fetch: remote.fetch });

		expect(outcome.enabled).toBe(false);
		expect(outcome.next).toBe('sync-first');
		expect(outcome.instruction).toMatch(/repository is empty/);
		expect(outcome.instruction).toMatch(/Sync once/);
		expect(outcome.instruction).not.toMatch(
			/does not have|Pages: Read and write|Administration: Read and write/
		);
	});

	it('never throws, even when GitHub cannot be reached at all', async () => {
		const offline = () => Promise.reject(new TypeError('Failed to fetch'));

		const outcome = await enableRemotePages({ token: TOKEN, remote: REMOTE, fetch: offline });

		expect(outcome.enabled).toBe(false);
		expect(outcome.next).toBe('guided');
		expect(outcome.instruction).toMatch(/Settings → Pages/);
	});
});

// ⚠ **The waiting and the verifying are ours** (ADR-0045). The author does one thing on github.com;
// guessing when it took effect, and pressing until it does, is the avoidable half of the manual step.
describe('checking again until the site answers', () => {
	/** The poll's own clock, so the whole backoff sequence is a test costing milliseconds. */
	const waited: number[] = [];
	const wait = async (milliseconds: number) => {
		waited.push(milliseconds);
	};

	beforeEach(() => {
		waited.length = 0;
	});

	it('answers at once when the site is already there, waiting for nothing', async () => {
		const remote = await github();
		remote.pagesEnabled = true;

		const outcome = await awaitRemotePages({
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch,
			wait
		});

		expect([outcome.enabled, outcome.next]).toEqual([true, 'none']);
		expect(waited).toEqual([]);
	});

	it('keeps asking while the answer is “not yet”, and carries on the moment it is not', async () => {
		const remote = await github();
		let asks = 0;
		const answering = (input: Request | string | URL, init?: RequestInit) => {
			if (String(typeof input === 'string' ? input : (input as Request).url).endsWith('/pages')) {
				asks += 1;
				// The author presses Save on github.com between the second poll and the third.
				if (asks === 3) remote.pagesEnabled = true;
			}
			return remote.fetch(input, init);
		};

		const outcome = await awaitRemotePages({
			token: TOKEN,
			remote: REMOTE,
			fetch: answering,
			wait
		});

		expect(outcome.enabled).toBe(true);
		expect(asks).toBe(3);
		// Backed off rather than evenly spaced, and the first ask is immediate.
		expect(waited).toEqual([...PAGES_POLL_DELAYS.slice(1, 3)]);
	});

	// ⚠ **A press with a result, never a background job.** A poll that never gave up would leave the
	// author watching a spinner with nothing to act on, so it ends on the same guided step — which is
	// a screen they can press again.
	it('gives up on the guided step rather than polling forever', async () => {
		const remote = await github();

		const outcome = await awaitRemotePages({
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch,
			wait
		});

		expect([outcome.enabled, outcome.next]).toEqual([false, 'guided']);
		expect(outcome.settingsUrl).toBe('https://github.com/ada/atlas/settings/pages');
		expect(waited.length).toBe(PAGES_POLL_DELAYS.length - 1);
	});

	it('never throws when GitHub cannot be reached at all', async () => {
		const offline = () => Promise.reject(new TypeError('Failed to fetch'));

		const outcome = await awaitRemotePages({ token: TOKEN, remote: REMOTE, fetch: offline, wait });

		expect(outcome.enabled).toBe(false);
	});
});

// ⚠ **It is not a way to take the work back, and it is never presented as one** (ADR-0045).
describe('withdrawing Share Links', () => {
	it('takes the site down', async () => {
		const remote = await github();
		remote.pagesEnabled = true;

		const withdrawal = await disableRemotePages({
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(withdrawal).toEqual({ disabled: true, notice: '' });
		expect(remote.pagesEnabled).toBe(false);
	});

	// Withdrawing twice must not report the second attempt as a failure: a repository with no site is
	// the state being asked for.
	it('treats a repository with no site as the state it wanted', async () => {
		const remote = await github();

		expect(await disableRemotePages({ token: TOKEN, remote: REMOTE, fetch: remote.fetch })).toEqual(
			{ disabled: true, notice: '' }
		);
	});

	it('never throws, and says the site may still answer when GitHub refused', async () => {
		const remote = await github();
		remote.pagesEnabled = true;
		remote.refusePages = true;

		const withdrawal = await disableRemotePages({
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(withdrawal.disabled).toBe(false);
		expect(withdrawal.notice).toMatch(/may still answer/);
		expect(withdrawal.notice).toMatch(/your own work is untouched/i);
		expect(withdrawal.notice).toContain(pagesSettingsUrl(REMOTE));
	});

	// ⚠ **The three things it cannot promise, named before it happens.** A scholar who reads "turn the
	// site off" as "make it unseen" will act on that reading — with an embargoed photograph, or a
	// manuscript under a library's restriction.
	it('says plainly what cannot be undone, and what is untouched', () => {
		const said = shareLinksWithdrawalMessage(REMOTE);

		expect(said).toMatch(/already given out stops working/);
		expect(said).toMatch(/cache/);
		expect(said).toMatch(/forked/);
		expect(said).toMatch(/cannot make anything unseen/i);
		expect(said).toMatch(/repository and your own files are untouched/);
	});
});

describe('connecting a Workspace', () => {
	it('answers the repository with its branch resolved, and the rights with it', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();

		const outcome = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome.canPush).toBe(true);
		expect(outcome.rightsNotice).toBe('');
		expect(outcome.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
		// ⚠ **Nothing is written into the Workspace**, so a Workspace copied to another machine
		// arrives bound to nothing at all and no repository can claim it (ADR-0044).
		expect(await store.list('')).toEqual([]);
	});

	// ⚠ **A Remote is a place the work lives before it is a site anybody reads.** Turning Pages on is
	// a separate, later, optional act, so a bind that succeeds leaves the repository exactly as it
	// found it — and never answers a question about who may read this with a paragraph about a
	// permission.
	it('does not turn Pages on, so the repository is left as it was found', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();

		await bindWorkspaceToRemote(store, 'My Workspace', {
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(remote.pagesEnabled).toBe(false);
	});

	// The same claim where it would otherwise be loudest: a credential that cannot enable Pages binds
	// with nothing to say about Pages at all.
	it('binds without a word about Pages when the credential could not have turned it on', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();
		remote.refusePages = true;

		const outcome = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome).not.toHaveProperty('pages');
		expect(outcome.rightsNotice).toBe('');
	});

	it('resolves the branch to main without being asked, because there is one branch', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();

		const outcome = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: TOKEN,
			remote: { owner: 'ada', repository: 'atlas' },
			fetch: remote.fetch
		});

		expect(outcome.remote.branch).toBe('main');
	});

	// ADR-0033: the relationship is provenance, not permission. A reader who opened somebody's public
	// Workspace has a legitimate connected-but-unable-to-push state, and the thing that must not
	// happen is discovering the refusal after an upload.
	it('still connects when the credential cannot push, and says so plainly', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();
		remote.permissions = { push: false, admin: false };

		const outcome = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome.canPush).toBe(false);
		expect(outcome.rightsNotice).toMatch(/cannot push to ada\/atlas/);
		expect(outcome.rightsNotice).toMatch(/Contents: Read and write/);
		expect(outcome.remote.repository).toBe('atlas');
	});

	it('writes nothing when GitHub refuses the credential', async () => {
		const store = new MemoryProjectStore();

		await expect(
			bindWorkspaceToRemote(store, 'My Workspace', {
				token: 'ghp_expired',
				remote: REMOTE,
				fetch: await rejectingCredential()
			})
		).rejects.toThrow(RemoteBindRefusedError);

		expect(await store.list('')).toEqual([]);
	});
});

// ── Connecting with no credential at all (ADR-0044) ───────────────────────────────────────────
//
// ⚠ **The property this suite exists to hold is that getting needs no account.** A public
// repository is readable by anyone, so a student can seed a Workspace from their instructor's
// repository having signed up for nothing — and every request below carries no `Authorization`
// header, which the fake answers exactly as GitHub does.
describe('connecting a Workspace with nobody signed in', () => {
	it('connects to a public repository, so a student with no GitHub account can get from it', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();

		const outcome = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: null,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
		expect(await store.list('')).toEqual([]);
	});

	// ⚠ **`canPush: false` here means "nobody asked", and the empty notice is what says so.**
	// `noPushMessage` is a report that GitHub turned this author down, and nothing has been turned
	// down: the screen states that sending needs a sign-in instead (ADR-0044).
	it('claims nothing about push rights, because it could not have checked them', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();

		const outcome = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: null,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome.canPush).toBe(false);
		expect(outcome.rightsNotice).toBe('');
	});

	it('sends no Authorization header, so nothing about the reader reaches GitHub', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();
		const sent: (string | null)[] = [];
		const watched = (input: Request | string | URL, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			sent.push(headers.get('Authorization'));
			return remote.fetch(input, init);
		};

		await bindWorkspaceToRemote(store, 'My Workspace', {
			token: null,
			remote: REMOTE,
			fetch: watched
		});

		expect(sent).not.toEqual([]);
		expect(sent.every((one) => one === null)).toBe(true);
	});

	// A private repository and a missing one are one answer to somebody who has signed in to nothing,
	// and the sentence says so rather than sending them to check a name that is fine.
	it('names the sign-in as the remedy when GitHub answers nothing at that address', async () => {
		const store = new MemoryProjectStore();
		const remote = await github();

		const refusal = await bindWorkspaceToRemote(store, 'My Workspace', {
			token: null,
			remote: { owner: 'ada', repository: 'private-atlas' },
			fetch: remote.fetch
		}).catch((cause: unknown) => cause);

		expect(refusal).toBeInstanceOf(RemoteBindRefusedError);
		expect((refusal as RemoteBindRefusedError).refusal).toBe('no-repository');
		expect((refusal as Error).message).toMatch(/no public repository at ada\/private-atlas/);
		expect((refusal as Error).message).toMatch(/sign in/i);
	});
});

// ── A Review Workspace can never be bound (ADR-0024) ──────────────────────────────────────────
//
// Somebody else's Project in a throwaway Workspace, and putting it at your own address is promotion
// by another route. A hard refusal with a test, at this layer and at the app's.
describe('a Review Workspace can never be bound', () => {
	it('is refused before a single request is made', async () => {
		const store = reviewCopy();
		const remote = await github();
		// A fake that would answer perfectly well, so the refusal below is the domain rule rather than
		// a request that happened to fail. Counted because the rule is that a Review Workspace must not
		// reach a credential *at all*, and a rights check made with one and then discarded would satisfy
		// every other assertion here.
		let asked = 0;
		const counted = (input: Request | string | URL, init?: RequestInit) => {
			asked += 1;
			return remote.fetch(input, init);
		};

		await expect(
			bindWorkspaceToRemote(store, 'assignment 7', {
				token: TOKEN,
				remote: REMOTE,
				fetch: counted
			})
		).rejects.toThrow(ReviewWorkspaceError);

		expect(asked).toBe(0);
		expect(remote.pagesEnabled).toBe(false);
	});

	// ⚠ **The refusal is about the Workspace and not about the credential**, so taking the credential
	// away does not turn it into a permitted act: connecting anonymously is exactly what a Review
	// Workspace would otherwise be able to do unaided.
	it('is refused with no credential either, so anonymity is not a way round it', async () => {
		const store = reviewCopy();
		const remote = await github();
		let asked = 0;
		const counted = (input: Request | string | URL, init?: RequestInit) => {
			asked += 1;
			return remote.fetch(input, init);
		};

		await expect(
			bindWorkspaceToRemote(store, 'assignment 7', {
				token: null,
				remote: REMOTE,
				fetch: counted
			})
		).rejects.toThrow(ReviewWorkspaceError);

		expect(asked).toBe(0);
	});
});

// ── A Remote that already carries Ballastella work (ADR-0044) ─────────────────────────────────
//
// ⚠ **This used to be refused and is now the ordinary case.** ADR-0033's subset refusal existed
// because a first send would have deleted every Project the Workspace had not got. It cannot: a send
// removes only what the Synchronization Baseline recorded, so a Workspace with no Baseline removes
// nothing at all, and what the repository holds reads as work to get. Kept as a describe of its own
// because the case it names is the one the refusal was written for.
describe('binding to a Remote that already carries Projects this Workspace has not got', () => {
	/** A Workspace's site record, as it sits at the root of a Remote. */
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

	/** A Remote somebody has already sent two Projects to. */
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

	/** A Workspace holding the named Project directories and nothing else. */
	const holding = async (...directories: string[]): Promise<MemoryProjectStore> => {
		const store = new MemoryProjectStore();
		for (const directory of directories) {
			await store.write(
				`${directory}/project.json`,
				new TextEncoder().encode(`{"formatVersion":1,"name":"${directory}"}`)
			);
		}
		return store;
	};

	it('connects, so that an existing Workspace can be joined to an existing repository', async () => {
		const store = await holding('amsterdam-1625');
		const remote = await alreadySent();

		const outcome = await bindWorkspaceToRemote(store, 'atlas', {
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome.remote).toEqual({ owner: 'ada', repository: 'atlas', branch: 'main' });
	});

	// The refusal used to read the Remote's site record over the raw host to find out what it carried.
	// Nothing does now, and the request is worth asserting gone: it was a second read of a repository
	// the rights check has already established, on every connection anybody ever makes.
	it('reads nothing but the repository itself, whatever the Remote carries', async () => {
		const store = await holding('amsterdam-1625');
		const remote = await alreadySent();
		let raw = 0;
		const counted: typeof remote.fetch = async (input, init) => {
			if (String(input).includes('raw.githubusercontent.com')) raw += 1;
			return remote.fetch(input, init);
		};

		await bindWorkspaceToRemote(store, 'atlas', { token: TOKEN, remote: REMOTE, fetch: counted });

		expect(raw).toBe(0);
	});

	it('connects to a Remote nothing has ever been sent to', async () => {
		const store = await holding('amsterdam-1625');
		const remote = await github();

		const outcome = await bindWorkspaceToRemote(store, 'atlas', {
			token: TOKEN,
			remote: REMOTE,
			fetch: remote.fetch
		});

		expect(outcome.remote.repository).toBe('atlas');
	});
});
