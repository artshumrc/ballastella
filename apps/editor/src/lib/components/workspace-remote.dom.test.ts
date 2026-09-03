// The repository a Workspace belongs to, on the Workspace's own row, at Seam 1c.
//
// ⚠ **The standing relationship, which is what a connection comes to rest as** (ADR-0042,
// ADR-0044). The guided sequence is the way in and ends at the connection; everything that is true
// afterwards — the repository, the Baseline, Share Links, a different repository, giving this one
// up — is a setting of this Workspace and is here.
//
// ⚠ **The fake storage is reactive on purpose**, for `connect-to-github.dom.test.ts`'s reason: what
// this surface says is a reading of the storage rather than of anything a press returned, so a fake
// whose `remote` and `signedIn` were plain fields could not falsify it.
//
// ⚠ **What is deliberately not here.** That `POST /pages` degrades to a sentence naming both the
// permissions GitHub requires, that a withdrawal names what it cannot undo, and what the rights
// check asks are `bind-remote.ts`'s at Seam 1 against the shared fake GitHub. That the application
// mounts this on the roster row's dialog is `e2e/editor-github-signin.e2e.ts`'s.

import { UNCHECKED_REMOTE_STATUS, type SynchronizationBaseline } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { connectSequence } from '$lib/connect-sequence.svelte.js';

import WorkspaceRemote from './WorkspaceRemote.svelte';
import { FakeStorage, pagesGuided } from './connect-to-github-fake.svelte.js';
import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	connectSequence.open = false;
});

type Opened = {
	readonly storage: FakeStorage;
	/** Every time the surface asked the dialog it is inside to close. */
	readonly onclose: ReturnType<typeof vi.fn>;
};

/** Mount the section over a Workspace in whatever state the caller has put the fake into. */
function open(storage: FakeStorage): Opened {
	const onclose = vi.fn();
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(WorkspaceRemote, {
		target: main,
		props: { storage: storage as unknown as WorkspaceStorage, onclose }
	});
	flushSync();
	return { storage, onclose };
}

/** Somebody signed in, whose Workspace belongs to `owner/repository`. */
function connected(owner = 'ada', repository = 'atlas'): FakeStorage {
	const storage = new FakeStorage();
	storage.signedIn = true;
	storage.identity = 'ada';
	storage.credential = 'a-credential-this-component-never-renders';
	storage.remote = { owner, repository, branch: 'main' };
	return storage;
}

/** The same Workspace with nobody signed in: a public repository connected on this computer. */
function signedOut(): FakeStorage {
	const storage = new FakeStorage();
	storage.remote = { owner: 'ada', repository: 'atlas', branch: 'main' };
	return storage;
}

/**
 * Let the injected reads and the Share Links acts settle, and render what they answered.
 *
 * The turn count is a depth rather than a duration, for the reason the sequence's own suite gives.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
	flushSync();
}

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

const absent = (testId: string): boolean =>
	document.querySelector(`[data-testid="${testId}"]`) === null;

/** An element's words with the template's own line breaks collapsed. */
const text = (element: Element | null | undefined): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const said = (): string => text(document.body);

const press = (testId: string): void => {
	at(testId).click();
	flushSync();
};

// ⚠ **A Workspace that belongs to no repository has nothing to say here**, and the bar offers the
// action instead. A section about a relationship that does not exist is a status about nothing.
describe('a Workspace with no repository', () => {
	test('renders nothing at all', () => {
		open(new FakeStorage());

		expect(absent('workspace-remote')).toBe(true);
	});
});

describe('the repository this Workspace belongs to', () => {
	const baseline = (files: readonly string[]): SynchronizationBaseline => ({
		remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
		commit: 'c0ffeec0ffee',
		files: new Map(files.map((path) => [path, 'aaaa']))
	});

	test('names it', () => {
		open(connected());

		expect(text(at('workspace-remote-repository'))).toContain('ada/atlas');
	});

	test('states what this Workspace and GitHub last agreed on', () => {
		const storage = connected();
		storage.baseline = baseline(['amsterdam-1625/project.json', 'base-map/style.json']);
		open(storage);

		expect(text(at('remote-baseline'))).toContain('c0ffeec0ffee');
		expect(text(at('remote-baseline'))).toContain('2 files');
	});

	// ⚠ **`Cannot tell` is a determination rather than a silence** (ADR-0044). A Workspace whose
	// Remote nothing here has evidence about must not read as one that agrees with it.
	test('says so in words when there is no record of an agreement', () => {
		open(connected());

		expect(text(at('remote-baseline'))).toContain('Cannot tell what has changed');
	});

	// The address is the thing an assignment actually asked for.
	test('names the address a Published Site will answer at', () => {
		open(connected());

		expect(text(at('published-site-address'))).toBe('https://ada.github.io/atlas/');
	});

	// ⚠ **A person's own `<login>.github.io` repository is served at the domain root**, so the folder
	// form of the address would name a page that answers nothing.
	test('names the domain root for the account’s own site repository', () => {
		open(connected('Ada', 'Ada.github.io'));

		expect(text(at('published-site-address'))).toBe('https://ada.github.io/');
	});

	// Pasting it into a submission form is the use, and the visible text is what a browser that
	// refuses the clipboard leaves behind.
	test('puts the address on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		open(connected());

		press('copy-published-site-address');
		await settle();

		expect(writeText).toHaveBeenCalledWith('https://ada.github.io/atlas/');
		expect(text(at('copied-address'))).toContain('clipboard');
	});

	// ⚠ **The boundary stated up front rather than met as a Conflict.** Two Alignments of one sheet
	// are a question for the author (ADR-0046), so this is a limit rather than a defect — and a limit
	// discovered at the end of an afternoon is the same sentence one afternoon later.
	test('states the one thing two people cannot both do, before either of them does it', () => {
		open(connected());

		const limit = text(at('shared-remote-limit'));
		expect(limit).toContain('different Projects at the same time');
		expect(limit).toContain('cannot both do is align the same Map Image');
	});

	test('states it whether or not anybody may send there', async () => {
		const storage = connected();
		storage.rightsAnswer = { canPush: false };
		open(storage);
		await settle();

		expect(at('shared-remote-limit')).toBeTruthy();
	});

	// ⚠ **No transfer is offered here** (ADR-0044). The bar's one control opens the Sync modal, which
	// reads both sides and shows what it found before it moves a byte; a second press to the same
	// place, in a settings dialog, is the shape ADR-0042 exists to refuse.
	test('offers no transfer of its own', async () => {
		const opened = open(connected());
		await settle();

		expect(absent('connect-sync')).toBe(true);
		expect(opened.storage.updates).toBe(0);
	});
});

// ⚠ **A Remote may be somebody else's, and this says only what is known about that** (ADR-0044).
// Push rights cannot be read without a credential, so there are three states rather than two, and
// the middle one — signed out — is the one that must claim nothing at all.
describe('a Remote that may not be the author’s to send to', () => {
	// ⚠ **The second assertion is the whole of this.** Nothing may be claimed about rights from an
	// absent credential — not that the author may send, and not that they may not — and the only way
	// to hold that is for the question never to be asked.
	test('says sending needs a sign-in, and nothing about rights, while signed out', async () => {
		const storage = signedOut();
		open(storage);
		await settle();

		expect(text(at('send-needs-sign-in'))).toContain('needs you to be signed in to GitHub');
		expect(absent('read-only-remote')).toBe(true);
		expect(storage.rightsReads).toBe(0);
		expect(said()).not.toContain('write access');
	});

	test('states the read-only relationship once GitHub has said so, and offers the way on', async () => {
		const storage = connected();
		storage.rightsAnswer = { canPush: false };
		open(storage);
		await settle();

		expect(text(at('read-only-remote'))).toContain('you cannot send to it');
		// The way forward is on the same screen as the limitation.
		expect(at('change-repository')).toBeTruthy();
		expect(absent('send-needs-sign-in')).toBe(true);
	});

	test('leaves the ordinary state exactly as it was where the author may send', async () => {
		const storage = connected();
		open(storage);
		await settle();

		expect(absent('read-only-remote')).toBe(true);
		expect(absent('send-needs-sign-in')).toBe(true);
		expect(storage.rightsReads).toBe(1);
	});

	// ⚠ **A read that failed is not an answer.** Withdrawing a send affordance over a network blip
	// would deny a send the author is entitled to make, and the send engine checks the permission
	// itself before a byte moves — so the ordinary state stands and nothing unprompted is said.
	test('says nothing and withdraws nothing when the rights could not be read', async () => {
		const storage = connected();
		storage.rightsAnswer = new Error('GitHub could not be reached.');
		open(storage);
		await settle();

		expect(absent('read-only-remote')).toBe(true);
		expect(absent('workspace-remote-problem')).toBe(true);
		// ⚠ **Once, and the guard has to be separate from the answer for it to be once.** `rights`
		// stays `null` after a failure, so an effect guarded on it alone asks again the moment the
		// request settles — one `GET` per microtask for as long as GitHub is unreachable.
		expect(storage.rightsReads).toBe(1);
	});
});

// ⚠ **A Remote is a place the work lives before it is a site anybody reads** (ADR-0045).
// Share Links are asked for here, once, and never during a connection — and the refusal is a *step*
// rather than an error: the screen, the branch, the folder, and a Check again that polls until the
// site answers. The sentences themselves are `bind-remote.ts`'s at Seam 1; what is here is that a
// press asks for it, that each outcome is rendered with the control it needs, and that nothing asks
// before the press.
describe('letting other people see it, which is a later act', () => {
	/** GitHub's ordinary refusal, which is what ADR-0040 buys by not asking for `Administration`. */
	const REFUSAL =
		'GitHub Pages could not be turned on for ada/atlas — that needs both “Pages: Read and ' +
		'write” and “Administration: Read and write”, and this credential does not have them.';

	// Every one of the three presses is a request to GitHub, so signed out the offer would be a
	// control that can only refuse.
	test('is not offered to somebody who is not signed in', async () => {
		open(signedOut());
		await settle();

		expect(absent('enable-pages')).toBe(true);
	});

	test('is offered here, and asks GitHub nothing until it is pressed', async () => {
		const storage = connected();
		open(storage);
		await settle();

		expect(at('enable-pages')).toBeTruthy();
		expect(storage.pagesAsks).toBe(0);
		expect(absent('pages-notice')).toBe(true);
	});

	test('asks for it once when pressed, and says the site will answer', async () => {
		const storage = connected();
		open(storage);
		await settle();

		press('enable-pages');
		await settle();

		expect(storage.pagesAsks).toBe(1);
		expect(text(at('pages-enabled'))).toContain('can now open your map there');
		// Done once and done: the offer goes, because pressing it again asks GitHub to turn on
		// something that is already on.
		expect(absent('enable-pages')).toBe(true);
	});

	// ⚠ **A Workspace that already carries a site is never offered the press again.** Share Links are
	// the site record's presence and nothing else (ADR-0045), so the offer is a reading of the
	// Workspace rather than of what happened in this session.
	test('offers withdrawal rather than the press for a Workspace that already has a site', async () => {
		const storage = connected();
		storage.shareLinks = true;
		open(storage);
		await settle();

		expect(absent('enable-pages')).toBe(true);
		expect(at('withdraw-share-links')).toBeTruthy();
		expect(storage.pagesAsks).toBe(0);
	});

	// ⚠ **Either side's tree** (ADR-0045). A get brings the source namespace and nothing else, so
	// this Workspace carries no viewer files while the Remote it came from serves a live site — and
	// offering the setup there says the address answers nothing over a site people are reading, with
	// withdrawal out of reach on the machine the author is sitting at (story 65).
	test('offers withdrawal on a Workspace whose Remote was seen to carry a site', async () => {
		const storage = connected();
		storage.remoteStatusState = { ...UNCHECKED_REMOTE_STATUS, shareLinks: true };
		open(storage);
		await settle();

		expect(at('withdraw-share-links')).toBeTruthy();
		expect(absent('enable-pages')).toBe(true);
		// The evidence was already in hand: the status check that listed the tree had been paid for.
		expect(storage.pagesAsks).toBe(0);
		expect(storage.checks).toBe(0);
	});

	// The other direction, and the one this must not trade for: before a check has looked, the answer
	// is the Workspace's own files.
	test('offers the setup where nothing has seen a site on either side', async () => {
		const storage = connected();
		open(storage);
		await settle();

		expect(at('enable-pages')).toBeTruthy();
		expect(absent('withdraw-share-links')).toBe(true);
	});

	// ⚠ **Both permissions, and the guided step stays.** ADR-0040 refuses `Administration` for the
	// App, so this is the ordinary answer rather than a rare one.
	test('renders the refusal, and stays connected', async () => {
		const storage = connected();
		storage.pagesAnswer = pagesGuided(REFUSAL);
		open(storage);
		await settle();

		press('enable-pages');
		await settle();

		const notice = text(at('pages-notice'));
		expect(notice).toContain('Pages: Read and write');
		expect(notice).toContain('Administration: Read and write');
		expect(at('workspace-remote-repository')).toBeTruthy();
	});

	// ⚠ **One click and not a search** (story 59): the screen, the branch and the folder are handed
	// over. The link is the outcome's own, so nothing here can build an address the sentence beside it
	// disagrees with.
	test('hands over the settings screen, the branch and the folder', async () => {
		const storage = connected();
		storage.pagesAnswer = pagesGuided(REFUSAL);
		open(storage);
		await settle();

		press('enable-pages');
		await settle();

		expect(at('pages-settings-link')).toHaveAttribute(
			'href',
			'https://github.com/ada/atlas/settings/pages'
		);
		expect(text(at('pages-branch'))).toBe('main');
		expect(text(at('pages-notice')?.parentElement)).toContain('/ (root)');
	});

	// ⚠ **The waiting and the verifying are ours** (story 60). The author changes one setting on
	// github.com; one press polls until the site answers and then carries on by itself.
	test('polls on Check again, and carries on when the site answers', async () => {
		const storage = connected();
		storage.pagesAnswer = pagesGuided(REFUSAL);
		open(storage);
		await settle();
		press('enable-pages');
		await settle();

		expect(at('check-pages')).toBeTruthy();
		press('check-pages');
		await settle();

		expect(storage.pagesChecks).toBe(1);
		expect(text(at('pages-enabled'))).toContain('can now open your map there');
		expect(absent('check-pages')).toBe(true);
	});

	// A poll that came back "not yet" leaves the author on the same screen, which is a screen they can
	// press again — never a refusal whose only sequel is Close.
	test('leaves the guided step in place when the site still does not answer', async () => {
		const storage = connected();
		storage.pagesAnswer = pagesGuided(REFUSAL);
		storage.checkAnswer = pagesGuided(REFUSAL);
		open(storage);
		await settle();
		press('enable-pages');
		await settle();

		press('check-pages');
		await settle();

		expect(at('check-pages')).toBeTruthy();
		expect(text(at('pages-notice'))).toContain('Administration: Read and write');
	});

	// ⚠ **An empty repository is a Sync away from being fine, and is never reported as a permission
	// problem** (story 61). There is nothing to check again for, because nothing has been asked of the
	// author — so the guided step's controls are absent.
	test('reports an empty repository as needing a Sync, with nothing to go and change', async () => {
		const storage = connected();
		storage.pagesAnswer = {
			enabled: false,
			next: 'sync-first',
			instruction:
				'GitHub Pages is not on yet for ada/atlas, because the repository is empty. Nothing is ' +
				'wrong with your token and nothing needs fixing. Sync once: that makes the branch.',
			settingsUrl: 'https://github.com/ada/atlas/settings/pages',
			branch: 'main'
		};
		open(storage);
		await settle();

		press('enable-pages');
		await settle();

		expect(text(at('pages-notice'))).toContain('repository is empty');
		expect(text(at('pages-notice'))).not.toContain('Administration');
		expect(absent('check-pages')).toBe(true);
		expect(absent('pages-settings-link')).toBe(true);
	});

	// The one thing the Share Links acts throw over is a credential that is not there, and it is a
	// refusal about this press rather than about the connection, which stands.
	test('says why it could not be asked at all, and stays connected', async () => {
		const storage = connected();
		storage.pagesAnswer = new Error('Sign in with GitHub first.');
		open(storage);
		await settle();

		press('enable-pages');
		await settle();

		expect(text(at('workspace-remote-problem'))).toContain('Sign in with GitHub first.');
		expect(at('workspace-remote-repository')).toBeTruthy();
	});
});

// ⚠ **Withdrawal is not a way to take the work back, and is never presented as one** (ADR-0045, stories 65-67).
describe('withdrawing Share Links', () => {
	function withSite(): FakeStorage {
		const storage = connected();
		storage.shareLinks = true;
		return storage;
	}

	// ⚠ **The three things it cannot promise, before the press that does it.** A scholar who reads
	// "turn the site off" as "make it unseen" will act on that reading.
	test('says plainly what cannot be undone before it happens', async () => {
		const storage = withSite();
		open(storage);
		await settle();

		press('withdraw-share-links');
		flushSync();

		const warning = text(at('withdraw-warning'));
		expect(warning).toContain('already given out stops working');
		expect(warning).toContain('cache');
		expect(warning).toContain('forked');
		expect(warning).toContain('repository and your own files are untouched');
		// Nothing has happened yet: the warning is a question, not a report.
		expect(storage.pagesWithdrawals).toBe(0);
	});

	// ⚠ **The recorded request is what the Remote's own copy stops meaning a site.** It goes on the
	// next Sync, so between the press and that Sync the Remote still carries the viewer set — which
	// is byte for byte what a Workspace just got from a shared repository looks like.
	test('does not put the site back from the Remote it has not been removed from yet', async () => {
		const storage = connected();
		storage.remoteStatusState = { ...UNCHECKED_REMOTE_STATUS, shareLinks: true };
		open(storage);
		await settle();

		press('withdraw-share-links');
		flushSync();
		press('withdraw-share-links-confirm');
		await settle();
		// The check that follows still lists the viewer set, because the Sync that removes it has not
		// happened. Only the recorded asking tells this apart from a Workspace freshly got.
		storage.remoteStatusState = { ...UNCHECKED_REMOTE_STATUS, status: 'in-sync', shareLinks: true };
		await settle();

		expect(storage.pagesWithdrawals).toBe(1);
		expect(absent('withdraw-share-links')).toBe(true);
		expect(at('enable-pages')).toBeTruthy();
	});

	test('does nothing at all when the author keeps them', async () => {
		const storage = withSite();
		open(storage);
		await settle();
		press('withdraw-share-links');
		flushSync();

		press('withdraw-share-links-cancel');
		flushSync();

		expect(storage.pagesWithdrawals).toBe(0);
		expect(at('withdraw-share-links')).toBeTruthy();
	});

	test('withdraws on the confirmation, and offers Share Links again', async () => {
		const storage = withSite();
		open(storage);
		await settle();
		press('withdraw-share-links');
		flushSync();

		press('withdraw-share-links-confirm');
		await settle();

		expect(storage.pagesWithdrawals).toBe(1);
		expect(at('enable-pages')).toBeTruthy();
		expect(absent('withdraw-share-links')).toBe(true);
	});

	// GitHub refusing to take the site down is a sentence rather than an error: the viewer still
	// leaves the repository on the next Sync, and the author is told what is left to do by hand.
	test('says the site may still answer when GitHub would not take it down', async () => {
		const storage = withSite();
		storage.withdrawalAnswer = {
			disabled: false,
			notice: 'GitHub would not turn the site off for ada/atlas, so it may still answer.'
		};
		open(storage);
		await settle();
		press('withdraw-share-links');
		flushSync();

		press('withdraw-share-links-confirm');
		await settle();

		expect(text(at('withdrawal-notice'))).toContain('may still answer');
	});
});

describe('the gestures on the standing relationship', () => {
	// ⚠ **The determination is the badge's and is said in exactly one place.** A check made behind a
	// `showModal()` dialog would put its own result out of sight, because everything outside such a
	// dialog is inert — so the press closes this first.
	test('asks for a check, and gets out of the way of the answer', async () => {
		const opened = open(connected());

		press('check-remote-status');
		await settle();

		expect(opened.storage.checks).toBe(1);
		expect(opened.onclose).toHaveBeenCalledTimes(1);
	});

	// ⚠ **`aria-disabled`, never `disabled`.** A `disabled` button leaves the tab order the instant it
	// is pressed, dropping a keyboard user to `<body>` (WCAG 2.4.3).
	test('says a check already running with aria-disabled, and keeps it in the tab order', () => {
		const storage = connected();
		storage.remoteStatusState = { ...storage.remoteStatusState, checking: true };
		const opened = open(storage);

		expect(at('check-remote-status')).toHaveAttribute('aria-disabled', 'true');
		expect(at('check-remote-status').hasAttribute('disabled')).toBe(false);

		press('check-remote-status');

		expect(opened.storage.checks).toBe(0);
		expect(opened.onclose).not.toHaveBeenCalled();
	});

	// ⚠ **Connecting once is not permanent, and there is one place a repository is chosen** — the
	// guided sequence. This is the way back to it rather than a second copy of the choice.
	test('takes the author back to the guided sequence for a different repository', () => {
		const opened = open(connected());

		press('change-repository');

		expect(connectSequence.open).toBe(true);
		expect(opened.onclose).toHaveBeenCalledTimes(1);
	});

	// ⚠ **The only caller of `unbindRemote` there is.** Only this computer forgets: nothing on GitHub
	// is deleted, which the sentence the press leaves behind says.
	test('gives the repository up, once, and says what was and was not changed', async () => {
		const opened = open(connected());

		press('unbind-remote');
		await settle();

		expect(opened.storage.unbinds).toBe(1);
		expect(opened.storage.remote).toBeNull();
		expect(text(at('workspace-remote-notice'))).toContain('no longer syncs with ada/atlas');
		expect(text(at('workspace-remote-notice'))).toContain('Nothing there has been changed');
	});

	// A Workspace that has given its repository up has no relationship to describe, and the bar
	// offers the action instead.
	test('leaves nothing behind about a repository this Workspace no longer has', async () => {
		const opened = open(connected());

		press('unbind-remote');
		await settle();

		expect(absent('workspace-remote')).toBe(true);
		expect(opened.onclose).not.toHaveBeenCalled();
	});

	test('uses `disabled` on no control, busy or not', async () => {
		const storage = connected();
		storage.pagesAnswer = new Error('GitHub would not answer');
		open(storage);
		// The Share Links offer is an asked-for reading of both sides (ADR-0045), so it arrives one
		// turn after the section does.
		await settle();

		expect(document.body.querySelectorAll('[disabled]')).toHaveLength(0);

		press('enable-pages');
		expect(at('enable-pages')).toHaveAttribute('aria-disabled', 'true');
		expect(document.body.querySelectorAll('[disabled]')).toHaveLength(0);
		await settle();
	});
});
