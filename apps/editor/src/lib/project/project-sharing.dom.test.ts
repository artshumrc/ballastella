// The two controls a Project's own settings carry, asserted against the section rather than the app.
//
// ⚠ **What stays in `e2e/` is everything this section cannot answer alone**: that it is really
// rendered inside the Project settings dialog, that the toggle really writes `project.json`, and
// that the link really opens the Project on a real site. Handed its props by the test, it cannot
// fail for a wiring reason at all — and *which bytes end up where* is `packages/core`'s, where the
// serialisation inversion and `projectRemoteReach` are asserted against a store.

import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import ProjectSharingHarness from './ProjectSharingHarness.svelte';

let mounted: Record<string, unknown> | undefined;
/** Everything the page put on the clipboard, in order. */
let clipboard: string[];

beforeEach(() => {
	clipboard = [];
	// jsdom has no clipboard at all, so the section's one platform call is the thing to stand up.
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: { writeText: vi.fn(async (text: string) => void clipboard.push(text)) }
	});
});

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const section = (props: ComponentProps<typeof ProjectSharingHarness> = {}): void => {
	mounted = mount(ProjectSharingHarness, { target: document.body, props });
	flushSync();
};

const at = (testid: string): HTMLElement | null =>
	document.querySelector(`[data-testid="${testid}"]`);

const shown = (testid: string): HTMLElement => {
	const found = at(testid);
	if (found === null) throw new Error(`no [data-testid="${testid}"] on screen`);
	return found;
};

const toggle = (): HTMLInputElement => {
	const found = at('on-front-page-amsterdam-1625');
	if (!(found instanceof HTMLInputElement)) throw new Error('no front-page toggle');
	return found;
};

const text = (testid: string): string =>
	(at(testid)?.textContent ?? '').replace(/\s+/g, ' ').trim();

const press = (testid: string): void => {
	shown(testid).click();
	flushSync();
};

/** Every microtask a press takes: the callback, and the clipboard write inside it. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
	flushSync();
}

describe('Show on Front Page', () => {
	// Story 68: a Project is on a front page because somebody put it there.
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

	// ⚠ **Story 69: nowhere else.** The claim this section is the only place is a `grep`, not a test;
	// what is asserted here is that this place works with nothing else in hand.
	test('is settable with no Remote, no Share Links and no address at all', () => {
		const asked: boolean[] = [];
		section({ shareLinks: false, link: '', onwrite: (on) => asked.push(on) });

		press('on-front-page-amsterdam-1625');

		expect(asked).toEqual([true]);
	});

	// Story 71: recording the intention early is free, and nobody should be left waiting for a page
	// that does not exist.
	test('says the front page does not exist yet where the Workspace has no Share Links', () => {
		section({ shareLinks: false });

		expect(text('no-front-page-yet')).toContain('no front page yet');
	});

	test('says nothing of the kind once the Workspace has Share Links', () => {
		section({ shareLinks: true });

		expect(at('no-front-page-yet')).toBeNull();
	});

	// ⚠ **Not privacy, said beside the control.** A scholar with embargoed material acts on the
	// reading the interface invites, and the words "private", "hidden" and "unpublished" invite the
	// wrong one (ADR-0045).
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
	// Stories 72 and 73: the link is the whole of what is handed over, and it does not depend on the
	// front page.
	test('copies the link at once for a Project whose work is on GitHub', async () => {
		section({ shareLinks: true, unsent: false, onFrontPage: false });

		press('share-project');
		await settle();

		expect(clipboard).toEqual(['https://ada.github.io/atlas/?p=amsterdam-1625']);
		expect(text('share-project-said')).toContain('clipboard');
		expect(at('share-needs-share-links')).toBeNull();
		expect(at('share-unsent')).toBeNull();
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

	// The address is readable as text too: a browser that refuses the clipboard must not leave the
	// author with no way to get what they asked for.
	test('shows the address as text, and says so when the clipboard is refused', async () => {
		vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('blocked'));
		section({ shareLinks: true });

		press('share-project');
		await settle();

		expect(text('share-project-link')).toBe('https://ada.github.io/atlas/?p=amsterdam-1625');
		expect(text('share-project-said')).toContain('clipboard');
		expect(text('share-project-said')).toContain('by hand');
	});

	// ⚠ **Story 74: the answer to the request is the thing that was asked for.** A refusal here sends
	// an author to another dialog to find a press they did not know existed.
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
		expect(at('share-needs-share-links')).toBeNull();
	});

	test('leaves the offer standing, with the reason, where GitHub refused', async () => {
		section({
			shareLinks: false,
			enableShareLinks: async () => 'GitHub would not turn Pages on for this repository.'
		});

		press('share-project');
		press('enable-share-links');
		await settle();

		expect(text('share-project-said')).toContain('would not turn Pages on');
		expect(at('share-needs-share-links')).not.toBeNull();
		expect(clipboard).toEqual([]);
	});

	// Turning Share Links on writes the reading site into the Workspace, so there is always something
	// to send afterwards: the setup answer falls through to the unsent question rather than past it.
	test('asks about unsent work after the setup, rather than copying over it', async () => {
		section({ shareLinks: false, unsent: true });

		press('share-project');
		press('enable-share-links');
		await settle();

		expect(at('share-unsent')).not.toBeNull();
		expect(clipboard).toEqual([]);
	});

	// Stories 75 and 77: a link to last week is worse than a wait, and the choice is informed.
	test('offers the Sync first for a Project with work GitHub has not got, and says what a Reader would see', () => {
		section({ shareLinks: true, unsent: true });

		press('share-project');

		expect(text('share-reader-would-see')).toContain('work GitHub has not got');
		expect(text('share-reader-would-see')).toContain('nothing at all');
		expect(shown('sync-and-copy-link')).toBeTruthy();
		expect(shown('copy-link-anyway')).toBeTruthy();
	});

	test('sends and then copies, when the Sync is the answer', async () => {
		let sends = 0;
		section({
			shareLinks: true,
			unsent: true,
			send: async () => {
				sends += 1;
				return '';
			}
		});

		press('share-project');
		press('sync-and-copy-link');
		await settle();

		expect(sends).toBe(1);
		expect(clipboard).toEqual(['https://ada.github.io/atlas/?p=amsterdam-1625']);
		expect(at('share-unsent')).toBeNull();
	});

	// ⚠ **A refused send must not hand over the link anyway**, or the press has done the opposite of
	// what its label promised.
	test('copies nothing where the send refused, and says why', async () => {
		section({
			shareLinks: true,
			unsent: true,
			send: async () => 'GitHub’s hourly request budget is spent. Nothing was sent.'
		});

		press('share-project');
		press('sync-and-copy-link');
		await settle();

		expect(clipboard).toEqual([]);
		expect(text('share-project-said')).toContain('request budget is spent');
	});

	// Story 76: not blocked when they know what they are doing.
	test('copies the link anyway on the second press', async () => {
		let sends = 0;
		section({
			shareLinks: true,
			unsent: true,
			send: async () => {
				sends += 1;
				return '';
			}
		});

		press('share-project');
		press('copy-link-anyway');
		await settle();

		expect(sends).toBe(0);
		expect(clipboard).toEqual(['https://ada.github.io/atlas/?p=amsterdam-1625']);
	});

	// ⚠ **Nothing unguessable, and nothing that could be read as a secret** (ADR-0045). Calling the
	// link private is the failure mode the ADR exists to prevent.
	test('hands over `?p=` and nothing else', async () => {
		section({ shareLinks: true });

		press('share-project');
		await settle();

		expect(text('share-project-link')).toMatch(/\?p=amsterdam-1625$/);
		expect(text('share-project-settings').toLowerCase()).not.toContain('private');
	});
});
