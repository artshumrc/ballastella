import { UNCHECKED_REMOTE_STATUS } from '@ballastella/core';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { connectSequence } from '$lib/connect-sequence.svelte.js';
import {
	absent,
	at,
	inMain,
	press,
	said,
	settle,
	show,
	takeDown,
	textOf
} from '$lib/test-support/dom.js';

import WorkspaceRemote from './WorkspaceRemote.svelte';
import { FakeStorage, pagesGuided } from './connect-to-github-fake.svelte.js';
import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

afterEach(() => {
	takeDown();
	connectSequence.open = false;
});

const ATLAS = { owner: 'ada', repository: 'atlas', branch: 'main' };
const SETTINGS = 'https://github.com/ada/atlas/settings/pages';
let onclose: ReturnType<typeof vi.fn<() => void>>;

async function open(storage: FakeStorage): Promise<FakeStorage> {
	onclose = vi.fn<() => void>();
	show(WorkspaceRemote, { storage: storage as unknown as WorkspaceStorage, onclose }, inMain());
	await settle();
	return storage;
}

const connected = (over: Partial<FakeStorage> = {}): FakeStorage =>
	Object.assign(new FakeStorage(), {
		signedIn: true,
		identity: 'ada',
		credential: 'a-credential-this-component-never-renders',
		bound: ATLAS,
		...over
	});

const signedOut = (): FakeStorage => Object.assign(new FakeStorage(), { bound: ATLAS });
const text = (testid: string): string => textOf(at(testid));

async function pressAndSettle(...testids: string[]): Promise<void> {
	for (const testid of testids) {
		press(testid);
		await settle();
	}
}

test('a Workspace with no repository renders nothing at all', async () => {
	await open(new FakeStorage());
	expect(absent('workspace-remote')).toBe(true);
});

describe('the repository this Workspace belongs to', () => {
	test('names it, its site address, the shared limit, and the missing agreement in words', async () => {
		await open(connected());
		expect(text('workspace-remote-repository')).toContain('ada/atlas');
		expect(text('remote-baseline')).toContain('Cannot tell what has changed');
		expect(text('published-site-address')).toBe('https://ada.github.io/atlas/');
		const limit = text('shared-remote-limit');
		expect(limit).toContain('different Projects at the same time');
		expect(limit).toContain('cannot both do is align the same Map Image');
	});

	test('states what this Workspace and GitHub last agreed on', async () => {
		const files = new Map([
			['amsterdam-1625/project.json', 'aaaa'],
			['base-map/style.json', 'aaaa']
		]);
		await open(connected({ baseline: { remote: ATLAS, commit: 'c0ffeec0ffee', files } }));
		expect(text('remote-baseline')).toContain('c0ffeec0ffee');
		expect(text('remote-baseline')).toContain('2 files');
	});

	test('names the domain root for the account’s own site repository', async () => {
		await open(connected({ bound: { owner: 'Ada', repository: 'Ada.github.io', branch: 'main' } }));
		expect(text('published-site-address')).toBe('https://ada.github.io/');
	});

	test('puts the address on the clipboard', async () => {
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
		await open(connected());

		await pressAndSettle('copy-published-site-address');

		expect(writeText).toHaveBeenCalledWith('https://ada.github.io/atlas/');
		expect(text('copied-address')).toContain('clipboard');
	});
});

describe('a Remote that may not be the author’s to send to', () => {
	test('says sending needs a sign-in, and offers nothing that needs one, while signed out', async () => {
		const storage = await open(signedOut());
		expect(text('send-needs-sign-in')).toContain('needs you to be signed in to GitHub');
		expect(absent('read-only-remote')).toBe(true);
		expect(absent('enable-pages')).toBe(true);
		expect(storage.rightsReads).toBe(0);
		expect(said()).not.toContain('write access');
	});

	test('states the read-only relationship once GitHub has said so, and offers the way on', async () => {
		await open(connected({ rightsAnswer: { canPush: false } }));
		expect(text('read-only-remote')).toContain('you cannot send to it');
		expect(at('change-repository')).toBeTruthy();
		expect(at('shared-remote-limit')).toBeTruthy();
		expect(absent('send-needs-sign-in')).toBe(true);
	});

	test('leaves the ordinary state as it was where the author may send, asking Pages nothing', async () => {
		const storage = await open(connected());
		expect(absent('read-only-remote')).toBe(true);
		expect(absent('send-needs-sign-in')).toBe(true);
		expect(storage.rightsReads).toBe(1);
		expect(at('enable-pages')).toBeTruthy();
		expect(storage.pagesAsks).toBe(0);
		for (const id of ['pages-notice', 'pages-setup-by-hand', 'pages-settings-button']) {
			expect(absent(id)).toBe(true);
		}
		expect(absent('withdraw-share-links')).toBe(true);
	});

	test('says nothing and withdraws nothing when the rights could not be read', async () => {
		const storage = await open(
			connected({ rightsAnswer: new Error('GitHub could not be reached.') })
		);
		expect(absent('read-only-remote')).toBe(true);
		expect(absent('workspace-remote-problem')).toBe(true);
		expect(storage.rightsReads).toBe(1);
	});
});

describe('letting other people see it, which is a later act', () => {
	const REFUSAL =
		'GitHub Pages could not be turned on for ada/atlas — that needs both “Pages: Read and ' +
		'write” and “Administration: Read and write”, and this credential does not have them.';

	const refused = (over: Partial<FakeStorage> = {}) =>
		connected({ pagesAnswer: pagesGuided(REFUSAL), ...over });

	test('links directly to the author’s GitHub Pages setting before the press', async () => {
		await open(connected({ pagesSetupByHand: true }));
		expect(text('pages-setup-by-hand')).toBe(
			'GitHub Pages is one setting you turn on yourself. Then turn Share Links on here.'
		);
		expect(at('pages-settings-button')).toHaveAttribute('href', SETTINGS);
		expect(at('enable-pages')).toBeTruthy();
	});

	test('asks for it once when pressed, and says the site will answer', async () => {
		const storage = await open(connected());
		await pressAndSettle('enable-pages');
		expect(storage.pagesAsks).toBe(1);
		expect(text('pages-enabled')).toContain('can now open your map there');
		expect(absent('enable-pages')).toBe(true);
	});

	test.each([
		{ seen: 'already has a site', over: { shareLinks: true } },
		{
			seen: 'Remote was seen to carry a site',
			over: { status: { ...UNCHECKED_REMOTE_STATUS, shareLinks: true } }
		}
	])('offers withdrawal rather than the press where the $seen', async ({ over }) => {
		const storage = await open(connected(over));
		expect(at('withdraw-share-links')).toBeTruthy();
		expect(absent('enable-pages')).toBe(true);
		expect(storage.pagesAsks).toBe(0);
		expect(storage.checks).toBe(0);
	});

	test('renders the refusal with the settings screen, branch and folder, and stays connected', async () => {
		await open(refused());
		await pressAndSettle('enable-pages');

		const notice = text('pages-notice');
		expect(notice).toContain('Pages: Read and write');
		expect(notice).toContain('Administration: Read and write');
		expect(at('workspace-remote-repository')).toBeTruthy();
		expect(at('pages-settings-link')).toHaveAttribute('href', SETTINGS);
		expect(text('pages-branch')).toBe('main');
		expect(textOf(at('pages-notice').parentElement)).toContain('/ (root)');
	});

	test('polls on Check again, and carries on when the site answers', async () => {
		const storage = await open(refused());
		await pressAndSettle('enable-pages', 'check-pages');
		expect(storage.pagesChecks).toBe(1);
		expect(text('pages-enabled')).toContain('can now open your map there');
		expect(absent('check-pages')).toBe(true);
	});

	test('leaves the guided step in place when the site still does not answer', async () => {
		await open(refused({ checkAnswer: pagesGuided(REFUSAL) }));
		await pressAndSettle('enable-pages', 'check-pages');
		expect(at('check-pages')).toBeTruthy();
		expect(text('pages-notice')).toContain('Administration: Read and write');
	});

	test('reports an empty repository as needing a Sync, with nothing to go and change', async () => {
		const instruction =
			'GitHub Pages is not on yet for ada/atlas, because the repository is empty. Nothing is ' +
			'wrong with your token and nothing needs fixing. Sync once: that makes the branch.';
		await open(
			connected({
				pagesAnswer: {
					enabled: false,
					next: 'sync-first',
					instruction,
					settingsUrl: SETTINGS,
					branch: 'main'
				}
			})
		);

		await pressAndSettle('enable-pages');

		expect(text('pages-notice')).toContain('repository is empty');
		expect(text('pages-notice')).not.toContain('Administration');
		expect(absent('check-pages')).toBe(true);
		expect(absent('pages-settings-link')).toBe(true);
	});

	test('says why it could not be asked at all, and stays connected', async () => {
		await open(connected({ pagesAnswer: new Error('Sign in with GitHub first.') }));
		await pressAndSettle('enable-pages');
		expect(text('workspace-remote-problem')).toContain('Sign in with GitHub first.');
		expect(at('workspace-remote-repository')).toBeTruthy();
	});
});

describe('withdrawing Share Links', () => {
	async function askingToWithdraw(over: Partial<FakeStorage> = {}): Promise<FakeStorage> {
		const storage = await open(connected({ shareLinks: true, ...over }));
		press('withdraw-share-links');
		flushSync();
		return storage;
	}

	test('says plainly what cannot be undone, and does nothing when the author keeps them', async () => {
		const storage = await askingToWithdraw();
		const warning = text('withdraw-warning');
		for (const phrase of [
			'already given out stops working',
			'cache',
			'forked',
			'repository and your own files are untouched'
		]) {
			expect(warning).toContain(phrase);
		}
		press('withdraw-share-links-cancel');
		flushSync();
		expect(storage.pagesWithdrawals).toBe(0);
		expect(at('withdraw-share-links')).toBeTruthy();
	});

	test('withdraws on the confirmation, and offers Share Links again', async () => {
		const storage = await askingToWithdraw();
		await pressAndSettle('withdraw-share-links-confirm');
		expect(storage.pagesWithdrawals).toBe(1);
		expect(at('enable-pages')).toBeTruthy();
		expect(absent('withdraw-share-links')).toBe(true);
	});

	test('does not put the site back from the Remote it has not been removed from yet', async () => {
		const storage = await askingToWithdraw({
			shareLinks: false,
			status: { ...UNCHECKED_REMOTE_STATUS, shareLinks: true }
		});

		await pressAndSettle('withdraw-share-links-confirm');
		storage.status = { ...UNCHECKED_REMOTE_STATUS, status: 'in-sync', shareLinks: true };
		await settle();

		expect(storage.pagesWithdrawals).toBe(1);
		expect(absent('withdraw-share-links')).toBe(true);
		expect(at('enable-pages')).toBeTruthy();
	});

	test('says the site may still answer when GitHub would not take it down', async () => {
		const notice = 'GitHub would not turn the site off for ada/atlas, so it may still answer.';
		await askingToWithdraw({ withdrawalAnswer: { disabled: false, notice } });
		await pressAndSettle('withdraw-share-links-confirm');
		expect(text('withdrawal-notice')).toContain('may still answer');
	});
});

describe('the gestures on the standing relationship', () => {
	test('asks for a check, and gets out of the way of the answer', async () => {
		const storage = await open(connected());
		await pressAndSettle('check-remote-status');
		expect(storage.checks).toBe(1);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test('says a check already running with aria-disabled, and keeps it in the tab order', async () => {
		const storage = await open(
			connected({ status: { ...UNCHECKED_REMOTE_STATUS, checking: true } })
		);

		expect(at('check-remote-status')).toHaveAttribute('aria-disabled', 'true');
		expect(at('check-remote-status').hasAttribute('disabled')).toBe(false);
		press('check-remote-status');
		expect(storage.checks).toBe(0);
		expect(onclose).not.toHaveBeenCalled();
	});

	test('takes the author back to the guided sequence for a different repository', async () => {
		await open(connected());
		press('change-repository');
		expect(connectSequence.open).toBe(true);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test('gives the repository up once, says what changed, and leaves nothing behind', async () => {
		const storage = await open(connected());
		await pressAndSettle('unbind-remote');
		expect(text('workspace-remote-notice')).toContain('no longer syncs with ada/atlas');
		expect(text('workspace-remote-notice')).toContain('Nothing there has been changed');
		expect(storage.unbinds).toBe(1);
		expect(storage.bound).toBeNull();
		expect(absent('workspace-remote')).toBe(true);
		expect(onclose).not.toHaveBeenCalled();
	});

	test('uses `disabled` on no control, busy or not', async () => {
		await open(connected({ pagesAnswer: new Error('GitHub would not answer') }));
		expect(document.body.querySelectorAll('[disabled]')).toHaveLength(0);
		press('enable-pages');
		expect(at('enable-pages')).toHaveAttribute('aria-disabled', 'true');
		expect(document.body.querySelectorAll('[disabled]')).toHaveLength(0);
		await settle();
	});
});
