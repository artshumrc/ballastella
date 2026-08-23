// What a Published Site's link offers before it is answered (SPEC stories 72–76).
//
// ⚠ **The subject is the offer, not the transfer.** What arrives when a choice is pressed is
// `remote-project-source.ts`'s and `review-from-remote.ts`'s at Seam 1, and that the applications
// really write it into real OPFS is `e2e/editor-review-remote.e2e.ts`'s. What only this seam can
// say cheaply is which choices a link raises, which Workspace the Import one names, and that
// declining calls nothing at all — three claims per link kind, and none of them needs a browser.

import type { ReturnLink } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import type { ImportTarget, WorkspaceStorage } from '../workspace-storage.svelte.js';
import ReturnLinkOffer from './ReturnLinkOffer.svelte';

const REVIEW: ReturnLink = {
	kind: 'review',
	owner: 'ada',
	repository: 'atlas',
	project: 'amsterdam-1625'
};

const CLONE: ReturnLink = { kind: 'clone', owner: 'ada', repository: 'atlas' };

const TARGET: ImportTarget = { name: 'Harbour maps', key: 'opfs:Harbour maps' };

/**
 * The four members the offer reads, and a tripwire on the one it may never read.
 *
 * ⚠ **`credential` throws rather than answering.** Both Project choices are anonymous (SPEC story
 * 6), and a component that consulted the store would behave differently for somebody who happened
 * to be signed in — which no test that signs in first would ever show. So the assertion is that the
 * member is never touched, and the fake is what makes touching it visible.
 */
function fakeStorage(importTarget: ImportTarget | null = TARGET) {
	const calls = {
		importRemoteProject: vi.fn(async () => ({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625',
			workspace: 'Harbour maps'
		})),
		reviewFrom: vi.fn(async () => ({ notice: 'Reviewing Amsterdam 1625 in atlas.' })),
		openFromGitHub: vi.fn(async () => ({ notice: 'Opened ada/atlas.' }))
	};
	const storage = {
		transfer: null,
		get importTarget() {
			return importTarget;
		},
		get credential(): string {
			throw new Error('the offer read a credential');
		},
		...calls
	};
	return { storage: storage as unknown as WorkspaceStorage, ...calls };
}

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

function offer(link: ReturnLink, storage: WorkspaceStorage, ondismiss = vi.fn()): typeof ondismiss {
	mounted = mount(ReturnLinkOffer, { target: document.body, props: { storage, link, ondismiss } });
	flushSync();
	return ondismiss;
}

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

const absent = (testId: string): boolean =>
	document.querySelector(`[data-testid="${testId}"]`) === null;

const said = (): string => (document.body.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Press a choice and wait for what it resolved to, which is the only thing that ends the wait. */
const press = async (testId: string): Promise<void> => {
	at(testId).click();
	await vi.waitFor(() => {
		flushSync();
		at('return-link-outcome');
	});
};

describe('a link naming one published Project', () => {
	// SPEC stories 74 and 75: two deliberate outcomes, not one accept and a footnote.
	test('offers Import into the named Workspace, a review copy, and a way out', () => {
		const { storage } = fakeStorage();

		offer(REVIEW, storage);

		expect(at('import-return-link').textContent).toContain('Harbour maps');
		expect(at('accept-return-link').textContent).toContain('review copy');
		expect(at('dismiss-return-link')).toBeTruthy();
		// Story 73: an offer, before anything is downloaded, and it says so.
		expect(said()).toContain('Nothing has been downloaded yet');
		expect(said()).toContain('amsterdam-1625');
		expect(said()).toContain('ada/atlas');
	});

	test('Imports that Project into the Workspace the offer named', async () => {
		const { storage, importRemoteProject, reviewFrom } = fakeStorage();
		const ondismiss = offer(REVIEW, storage);

		await press('import-return-link');

		expect(importRemoteProject).toHaveBeenCalledWith(
			{ owner: 'ada', repository: 'atlas', project: 'amsterdam-1625' },
			TARGET
		);
		expect(reviewFrom).not.toHaveBeenCalled();
		// What arrived and where, because an allocated name is not always the name on the link.
		expect(at('return-link-outcome').textContent).toContain('Amsterdam 1625');
		expect(at('return-link-outcome').textContent).toContain('Harbour maps');
		expect(ondismiss).not.toHaveBeenCalled();
	});

	/**
	 * The Project the Import allocated, handed back so the route can show it.
	 *
	 * An Import into a Workspace that already holds a Project of that name allocates a different
	 * directory, and the link's `?p=` then names nothing here — so the directory travels rather than
	 * the route guessing from the link.
	 */
	test('reports the directory it allocated when the offer is closed', async () => {
		const { storage } = fakeStorage();
		const ondismiss = offer(REVIEW, storage);

		await press('import-return-link');
		at('dismiss-return-link').click();
		flushSync();

		expect(ondismiss).toHaveBeenCalledWith({ reason: 'imported', directory: 'amsterdam-1625' });
	});

	test('opens a review copy instead when that is the choice pressed', async () => {
		const { storage, importRemoteProject, reviewFrom } = fakeStorage();

		offer(REVIEW, storage);
		await press('accept-return-link');

		expect(reviewFrom).toHaveBeenCalledWith({
			owner: 'ada',
			repository: 'atlas',
			project: 'amsterdam-1625'
		});
		expect(importRemoteProject).not.toHaveBeenCalled();
		expect(at('return-link-outcome').textContent).toContain('Reviewing Amsterdam 1625');
	});

	// Story 76: turning it down downloads nothing and changes nothing.
	test('declining calls neither choice', () => {
		const { storage, importRemoteProject, reviewFrom } = fakeStorage();
		const ondismiss = offer(REVIEW, storage);

		at('dismiss-return-link').click();
		flushSync();

		expect(ondismiss).toHaveBeenCalledWith({ reason: 'declined' });
		expect(importRemoteProject).not.toHaveBeenCalled();
		expect(reviewFrom).not.toHaveBeenCalled();
	});

	/**
	 * Inside a Review Workspace there is no ordinary Workspace to Import into, so the choice is not
	 * offered rather than offered and refused. Reviewing is still a working answer.
	 */
	test('offers only the review copy when nothing may be Imported into', () => {
		const { storage } = fakeStorage(null);

		offer(REVIEW, storage);

		expect(absent('import-return-link')).toBe(true);
		expect(at('accept-return-link').textContent).toContain('review copy');
	});
});

describe('a link naming a whole repository', () => {
	// Story 77: the Workspace-level invitation is one operation and keeps its own words.
	test('offers to open a Workspace from GitHub, and nothing about Import', async () => {
		const { storage, openFromGitHub, importRemoteProject } = fakeStorage();

		offer(CLONE, storage);

		expect(absent('import-return-link')).toBe(true);
		expect(at('accept-return-link').textContent).toContain('Open a Workspace from GitHub');

		await press('accept-return-link');

		expect(openFromGitHub).toHaveBeenCalledWith({ owner: 'ada', repository: 'atlas' });
		expect(importRemoteProject).not.toHaveBeenCalled();
	});
});
