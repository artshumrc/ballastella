import type { ComponentProps } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { at, one, press, settle, show, takeDown, textOf } from '$lib/test-support/dom';

import ProjectSharingHarness from './ProjectSharingHarness.svelte';

let clipboard: string[];

beforeEach(() => {
	clipboard = [];
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: vi.fn(async (text: string) => void clipboard.push(text)) }
	});
});

afterEach(takeDown);

const section = (props: ComponentProps<typeof ProjectSharingHarness> = {}): void =>
	show(ProjectSharingHarness, props);

const toggle = (): HTMLInputElement => {
	const found = one('on-front-page-amsterdam-1625');
	if (!(found instanceof HTMLInputElement)) throw new Error('no front-page toggle');
	return found;
};

const text = (testid: string): string => textOf(one(testid));

describe('Show on Front Page', () => {
	test('is off for a Project nobody has listed, and names the Project it is about', () => {
		section();
		expect(toggle().checked).toBe(false);
		expect(toggle().getAttribute('aria-label')).toBe('Show on Front Page — Amsterdam 1625');
	});

	test('reads the Project’s own choice, and reports the one a press asks for', () => {
		const asked: boolean[] = [];
		section({ onFrontPage: true, onwrite: (on) => asked.push(on) });
		expect(toggle().checked).toBe(true);
		press('on-front-page-amsterdam-1625');
		expect(asked).toEqual([false]);
		expect(toggle().checked).toBe(false);
	});

	test('is settable with no Remote, no Share Links and no address at all', () => {
		const asked: boolean[] = [];
		section({ shareLinks: false, link: '', onwrite: (on) => asked.push(on) });
		press('on-front-page-amsterdam-1625');
		expect(asked).toEqual([true]);
	});

	test('says the front page does not exist yet only where the Workspace has no Share Links', () => {
		section({ shareLinks: false });
		expect(text('no-front-page-yet')).toContain('no front page yet');
		takeDown();
		section({ shareLinks: true });
		expect(one('no-front-page-yet')).toBeNull();
	});

	test('says the choice is not privacy, and calls the Project neither private nor hidden', () => {
		section();
		const said = text('front-page-settings').toLowerCase();
		expect(said).toContain('not privacy');
		expect(said).not.toContain('private');
		expect(said).not.toContain('hidden');
		expect(said).not.toContain('publish');
	});
});

describe('Share Project', () => {
	test('copies the link at once for a Project whose work is on GitHub, handing over `?p=` and nothing else', async () => {
		section({ shareLinks: true });
		press('share-project');
		await settle();

		expect(clipboard).toEqual(['https://ada.github.io/atlas/?p=amsterdam-1625']);
		expect(text('share-project-said')).toContain('clipboard');
		expect(one('share-needs-share-links')).toBeNull();
		expect(one('share-unsent')).toBeNull();
		expect(text('share-project-link')).toMatch(/\?p=amsterdam-1625$/);
		expect(text('share-project-settings').toLowerCase()).not.toContain('private');
	});

	test('does not copy a link while GitHub Pages is unavailable', async () => {
		section({
			shareLinks: true,
			unsent: false,
			verifyShareLinks: async () => 'GitHub Pages is not on for ada/atlas.'
		});

		press('share-project');
		await settle();

		expect(clipboard).toEqual([]);
		expect(text('share-project-said')).toContain('GitHub Pages is not on');
	});

	test('shows the address as text, and says so when the clipboard is refused', async () => {
		vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('blocked'));
		section({ shareLinks: true });
		press('share-project');
		await settle();

		expect(text('share-project-link')).toBe('https://ada.github.io/atlas/?p=amsterdam-1625');
		expect(text('share-project-said')).toContain('clipboard');
		expect(text('share-project-said')).toContain('by hand');
	});

	test('offers the setup where the Workspace has no Share Links, rather than refusing', async () => {
		section({ shareLinks: false });
		press('share-project');
		expect(text('share-needs-share-links')).toContain('no Share Links yet');
		expect(clipboard).toEqual([]);
	});

	test('continues to the link once Share Links are on', async () => {
		section({ shareLinks: false, unsent: false });
		press('share-project');
		press('enable-share-links');
		await settle();

		expect(clipboard).toEqual(['https://ada.github.io/atlas/?p=amsterdam-1625']);
		expect(one('share-needs-share-links')).toBeNull();
	});

	test('leaves the offer standing, with the reason, where GitHub refused', async () => {
		section({
			shareLinks: false,
			enableShareLinks: async () => {
				throw new Error('GitHub would not turn Pages on for this repository.');
			}
		});

		press('share-project');
		press('enable-share-links');
		await settle();

		expect(text('share-project-said')).toContain('would not turn Pages on');
		expect(one('share-needs-share-links')).not.toBeNull();
		expect(clipboard).toEqual([]);
	});

	test('asks about unsent work after the setup, rather than copying over it', async () => {
		section({ shareLinks: false, unsent: true });
		press('share-project');
		press('enable-share-links');
		await settle();

		expect(one('share-unsent')).not.toBeNull();
		expect(clipboard).toEqual([]);
	});

	test('offers the Sync first for a Project with work GitHub has not got, and says what a Reader would see', () => {
		section({ shareLinks: true, unsent: true });
		press('share-project');
		expect(text('share-reader-would-see')).toContain('work GitHub has not got');
		expect(text('share-reader-would-see')).toContain('nothing at all');
		expect(at('sync-and-copy-link')).toBeTruthy();
		expect(at('copy-link-anyway')).toBeTruthy();
	});

	test.each([
		['sends and then copies, when the Sync is the answer', 'sync-and-copy-link', 1],
		['copies the link anyway on the second press', 'copy-link-anyway', 0]
	])('%s', async (_, choice, sent) => {
		let sends = 0;
		section({
			shareLinks: true,
			unsent: true,
			send: async () => {
				sends += 1;
			}
		});

		press('share-project');
		press(choice);
		await settle();

		expect(sends).toBe(sent);
		expect(clipboard).toEqual(['https://ada.github.io/atlas/?p=amsterdam-1625']);
		expect(one('share-unsent')).toBeNull();
	});

	test('copies nothing where the send refused, and says why', async () => {
		section({
			shareLinks: true,
			unsent: true,
			send: async () => {
				throw new Error('GitHub’s hourly request budget is spent. Nothing was sent.');
			}
		});

		press('share-project');
		press('sync-and-copy-link');
		await settle();

		expect(clipboard).toEqual([]);
		expect(text('share-project-said')).toContain('request budget is spent');
	});
});
