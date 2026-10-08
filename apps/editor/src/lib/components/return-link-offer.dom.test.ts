import type { ReturnLink } from '@ballastella/core';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { connectSequence } from '$lib/connect-sequence.svelte.js';
import { absent, at, inMain, said, show, takeDown } from '$lib/test-support/dom.js';

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

function fakeStorage(importTarget: ImportTarget | null = TARGET) {
	const calls = {
		importRemoteProject: vi.fn(async () => ({
			name: 'Amsterdam 1625',
			directory: 'amsterdam-1625',
			workspace: 'Harbour maps'
		})),
		reviewFrom: vi.fn(async () => ({ notice: 'Reviewing Amsterdam 1625 in atlas.' })),
		connectNewWorkspaceTo: vi.fn(async () => ({
			notice: '“atlas” is a new Workspace for ada/atlas.'
		}))
	};
	const storage = {
		transfer: null,
		get importTarget() {
			return importTarget;
		},
		github: {
			get credential(): string {
				throw new Error('the offer read a credential');
			}
		},
		...calls
	};
	return { storage: storage as unknown as WorkspaceStorage, ...calls };
}

afterEach(() => {
	takeDown();
	connectSequence.syncOpen = false;
});

function offer(link: ReturnLink, storage: WorkspaceStorage, ondismiss = vi.fn()): typeof ondismiss {
	show(ReturnLinkOffer, { storage, link, ondismiss }, inMain());
	return ondismiss;
}

const press = async (testId: string): Promise<void> => {
	at(testId).click();
	await vi.waitFor(() => {
		flushSync();
		at('return-link-outcome');
	});
};

describe('a link naming one Project on a site', () => {
	test('offers Import into the named Workspace, a review copy, and a way out', () => {
		const { storage } = fakeStorage();

		offer(REVIEW, storage);
		expect(at('import-return-link').textContent).toContain('Harbour maps');
		expect(at('accept-return-link').textContent).toContain('review copy');
		expect(at('dismiss-return-link')).toBeTruthy();
		expect(said()).toContain('Nothing has been downloaded yet');
		expect(said()).toContain('amsterdam-1625');
		expect(said()).toContain('ada/atlas');
	});

	test('Imports that Project into the Workspace the offer named, focusing the line that says so, and reports the directory on close', async () => {
		const { storage, importRemoteProject, reviewFrom } = fakeStorage();
		const ondismiss = offer(REVIEW, storage);

		await press('import-return-link');

		expect(importRemoteProject).toHaveBeenCalledWith(
			{ owner: 'ada', repository: 'atlas', project: 'amsterdam-1625' },
			TARGET
		);
		expect(reviewFrom).not.toHaveBeenCalled();
		expect(at('return-link-outcome').textContent).toContain('Amsterdam 1625');
		expect(at('return-link-outcome').textContent).toContain('Harbour maps');
		expect(document.activeElement).toBe(at('return-link-outcome'));
		expect(ondismiss).not.toHaveBeenCalled();

		at('dismiss-return-link').click();
		flushSync();
		expect(ondismiss).toHaveBeenCalledWith({ reason: 'imported', directory: 'amsterdam-1625' });
	});

	test('opens a review copy instead when that is the choice pressed, focusing the line naming it', async () => {
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
		expect(document.activeElement).toBe(at('return-link-outcome'));
	});

	test('declining calls neither choice, and lands on the editor’s own landmark', () => {
		const { storage, importRemoteProject, reviewFrom } = fakeStorage();
		const ondismiss = offer(REVIEW, storage);
		at('dismiss-return-link').click();
		flushSync();
		expect(ondismiss).toHaveBeenCalledWith({ reason: 'declined' });
		expect(importRemoteProject).not.toHaveBeenCalled();
		expect(reviewFrom).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(document.querySelector('main'));
		expect(document.activeElement).not.toBe(document.body);
	});

	test('offers only the review copy when nothing may be Imported into', () => {
		const { storage } = fakeStorage(null);

		offer(REVIEW, storage);
		expect(absent('import-return-link')).toBe(true);
		expect(at('accept-return-link').textContent).toContain('review copy');
	});
});

describe('focus after a press, which the press itself unmounts', () => {
	test('a refusal is an alert, and leaves focus on the choice that was pressed', async () => {
		const { storage, importRemoteProject } = fakeStorage();
		importRemoteProject.mockRejectedValue(
			new Error('There is no Project called “amsterdam-1625” on ada/atlas.')
		);
		offer(REVIEW, storage);
		const pressed = at('import-return-link');
		pressed.focus();
		pressed.click();
		await vi.waitFor(() => {
			flushSync();
			at('return-link-problem');
		});

		expect(at('return-link-problem').closest('[role="alert"]')).toBeTruthy();
		expect(at('return-link-problem').textContent).toContain('Project');
		expect(document.activeElement).toBe(pressed);
	});
});

describe('a link naming a whole repository', () => {
	test('makes a Workspace and connects it, and offers nothing about Import', async () => {
		const { storage, connectNewWorkspaceTo, importRemoteProject } = fakeStorage();

		offer(CLONE, storage);
		expect(absent('import-return-link')).toBe(true);
		expect(at('accept-return-link').textContent).toContain('Make a Workspace and connect it');

		await press('accept-return-link');

		expect(connectNewWorkspaceTo).toHaveBeenCalledWith({ owner: 'ada', repository: 'atlas' });
		expect(importRemoteProject).not.toHaveBeenCalled();
		expect(connectSequence.syncOpen).toBe(true);
	});
});
