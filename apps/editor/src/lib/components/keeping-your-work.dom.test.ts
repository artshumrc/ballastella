import { afterEach, describe, expect, test } from 'vitest';

import type { StorageDurability } from '@ballastella/core';

import {
	absent,
	at,
	inMain,
	press,
	settle,
	show,
	takeDown,
	textOf
} from '$lib/test-support/dom.js';

import KeepingYourWorkHarness from './KeepingYourWorkHarness.svelte';
import { FakeStorage, backup } from './keeping-your-work-fake.svelte.js';

afterEach(takeDown);

function open(over: Partial<FakeStorage> = {}, installed = false): FakeStorage {
	const storage = Object.assign(new FakeStorage(), over);
	show(KeepingYourWorkHarness, { storage, installed }, inMain());
	return storage;
}

const text = (testid: string): string => textOf(at(testid));

async function pressAndSettle(testid: string): Promise<void> {
	press(testid);
	await settle();
}

async function pick(fileName: string): Promise<void> {
	const input = at('restore-file');
	Object.defineProperty(input, 'files', {
		value: [new File([new Uint8Array([1])], fileName)],
		configurable: true
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

const answers = (
	persisted: boolean | undefined,
	permission: PermissionState | undefined,
	ephemeral = false,
	canChooseFolder = true
): Partial<FakeStorage> => ({
	canChooseFolder,
	storageAnswers: { persisted, permission, ephemeral }
});

const DURABILITY: Record<StorageDurability['kind'], Partial<FakeStorage>> = {
	granted: answers(true, 'granted'),
	'can-ask': answers(false, 'prompt', false, false),
	'install-to-keep': answers(false, 'prompt'),
	'seven-day': answers(false, undefined, false, false),
	ephemeral: answers(false, 'prompt', true),
	unknown: answers(undefined, undefined)
};

const KINDS = Object.keys(DURABILITY) as StorageDurability['kind'][];

describe('backing up and restoring', () => {
	test('names the file the Backup was written to, and what it holds', async () => {
		open();

		await pressAndSettle('back-up-workspace');

		expect(text('transfer-outcome')).toBe('Backed up 4 files, 2.0 kB, to “My Workspace.tar”.');
		expect(absent('transfer-progress')).toBe(true);
	});

	test('says what a normalised name will restore as', async () => {
		open({ backupAnswer: backup({ displayName: "Dave's maps", workspaceName: 'Dave s maps' }) });

		await pressAndSettle('back-up-workspace');

		expect(text('transfer-outcome')).toContain('will make a Workspace called “Dave s maps”');
	});

	test('reports what a Restore made, in the words core chose', async () => {
		open();

		await pick('My Workspace.tar');

		expect(text('transfer-outcome')).toContain('Restored 4 files into a new Workspace');
		expect(absent('transfer-problem')).toBe(true);
	});

	test('shows a refused Restore in its own words, and as an alert', async () => {
		const refusal = 'That file is not a Ballastella backup, so no Workspace has been made.';
		open({ restoreAnswer: new Error(refusal) });

		await pick('holiday.jpg');

		expect(text('transfer-problem')).toBe(refusal);
		expect(at('transfer-problem').closest('[role="alert"]')).toBeTruthy();
		expect(text('transfer-outcome')).toBe('');
	});

	test('says nothing when the file picker is closed without choosing', async () => {
		open();
		at('restore-file').dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		expect(text('transfer-outcome')).toBe('');
		expect(absent('transfer-problem')).toBe(true);
	});

	test.each([
		[
			'a review copy',
			{ review: { formatVersion: 1, project: 'A', directory: 'a', openedAt: '', origin: null } },
			'no-backup-in-review',
			'review copy of somebody else'
		],
		[
			'a Workspace that has not opened',
			{ unavailable: 'An Import that did not finish could not be resolved.' },
			'no-backup-unrecovered',
			'has not opened yet'
		]
	] as const)('withholds a Backup from %s, with its own sentence', (_, over, testid, sentence) => {
		open(over);
		expect(absent('back-up-workspace')).toBe(true);
		expect(text(testid)).toContain(sentence);
		expect(at('restore-workspace')).toBeTruthy();
	});
});

describe('moving this Workspace into a folder', () => {
	test('offers the move for a browser Workspace, and says what it leaves behind', async () => {
		const storage = open();
		expect(text('workspace-storage-place')).toBe('My Workspace');
		await pressAndSettle('move-into-folder');

		expect(text('transfer-outcome')).toContain('is now in the folder “maps”');
		expect(storage.backing).toBe('browser');
	});

	test('offers no move from a folder Workspace, and names the folder instead', () => {
		open({ backing: 'folder', folderName: 'maps' });
		expect(absent('move-into-folder')).toBe(true);
		expect(text('workspace-folder-place')).toBe('maps');
	});

	test('names no kind at all on a browser that cannot open folders', () => {
		open({ canChooseFolder: false });
		expect(absent('move-into-folder')).toBe(true);
		expect(absent('workspace-storage-place')).toBe(true);
		expect(document.body.textContent).not.toContain('Move this Workspace');
		expect(document.body.textContent).not.toContain("Where this Workspace's files are");
	});

	test('says why a folder was not used, and that nothing moved', async () => {
		open({
			moveAnswer: new Error(
				'That folder already holds files, so “My Workspace” was not moved into it.'
			)
		});

		await pressAndSettle('move-into-folder');

		expect(text('transfer-problem')).toContain('was not moved into it');
		expect(at('transfer-problem').closest('[role="alert"]')).toBeTruthy();
	});

	test('says nothing at all when the picker is closed without choosing', async () => {
		open({ moveAnswer: '' });

		await pressAndSettle('move-into-folder');

		expect(text('transfer-outcome')).toBe('');
		expect(absent('transfer-problem')).toBe(true);
	});
});

describe('unsaved changes with nowhere to go', () => {
	const held = (over: Partial<FakeStorage> = {}): FakeStorage =>
		open({ orphanedJournals: ['opfs:Marking 2026'], ...over });

	test('names the Workspaces the way the author knows them, never by the journal key', () => {
		held({ orphanedJournals: ['opfs:Marking 2026', 'folder:6f2a'] });
		const said = text('orphaned-journals');
		expect(said).toContain('Marking 2026');
		expect(said).not.toContain('opfs:');
	});

	test('throws one away only when asked, and says what went', () => {
		const storage = held();
		expect(storage.discarded).toEqual([]);
		press('discard-orphaned-journal');
		expect(storage.discarded).toEqual(['opfs:Marking 2026']);
		expect(text('discard-outcome')).toBe(
			'Threw away 2 unsaved changes held for “Marking 2026”. Nothing in any Workspace was touched.'
		);
		expect(absent('orphaned-journals')).toBe(true);
	});

	test.each([
		[
			'names an unfinished deletion as one, beside any unsaved edit',
			1,
			'1 unsaved change and 1 unfinished deletion'
		],
		[
			'says somebody else had already cleared it rather than reporting nothing',
			0,
			'something else had already cleared it'
		]
	])('%s', (_, count, said) => {
		held({ discardAnswer: { edits: count, deletions: count } });
		press('discard-orphaned-journal');
		expect(text('discard-outcome')).toContain(said);
	});

	test('says nothing about them when there are none', () => {
		open();
		expect(absent('orphaned-journals')).toBe(true);
		expect(text('discard-outcome')).toBe('');
	});
});

describe('what the browser promised about keeping the work', () => {
	const browser = (kind: StorageDurability['kind'], installed = false): FakeStorage =>
		open(DURABILITY[kind], installed);

	test('a folder Workspace is told only how installing retains its folder permission', () => {
		open({ ...DURABILITY['install-to-keep'], backing: 'folder' });

		expect(text('folder-workspace-install-advice')).toBe(
			'Install Ballastella to let your browser keep permission to access this Workspace folder between visits.'
		);
		expect(absent('durability')).toBe(true);
		expect(at('install-offer')).toBeTruthy();
	});

	test('every state has a line of its own', () => {
		const lines = new Set<string>();
		for (const kind of KINDS) {
			browser(kind);
			lines.add(text('durability-lead'));
			takeDown();
		}
		expect(lines.size).toBe(6);
		for (const line of lines) expect(line.length).toBeGreaterThan(0);
	});

	test.each(KINDS)(
		'%s says its detail unpressed only if seven-day, and suggests turning off no privacy setting',
		(kind) => {
			browser(kind);
			if (kind === 'seven-day') {
				expect(at('durability-detail')).toBeTruthy();
				expect(absent('durability-learn-more')).toBe(true);
			} else {
				expect(absent('durability-detail'), `${kind} showed its detail unasked`).toBe(true);
				expect(at('durability-learn-more').getAttribute('aria-expanded')).toBe('false');
				press('durability-learn-more');
			}
			const said = `${text('durability-lead')} ${text('durability-detail')}`.toLowerCase();
			for (const forbidden of [
				'tracking prevention',
				'prevent cross-site tracking',
				'turn off',
				'switch off',
				'disable'
			]) {
				expect(said, `${kind} suggested “${forbidden}”`).not.toContain(forbidden);
			}
		}
	);

	test('a grant is reported plainly and once, without interrupting', () => {
		browser('granted');
		expect(text('durability-lead')).toContain('Kept');
		expect(at('durability-lead').closest('[role="alert"]')).toBe(null);
	});

	test('a Chromium-shaped browser is told, beside the offer, that installing makes the promise', () => {
		browser('install-to-keep');
		expect(text('durability-lead')).toContain('Installing Ballastella');
		expect(at('install-offer')).toBeTruthy();
		press('durability-learn-more');
		expect(at('durability-learn-more').getAttribute('aria-expanded')).toBe('true');
		const panel = at('durability-detail');
		expect(at('durability-learn-more').getAttribute('aria-controls')).toBe(panel.id);
		expect(panel.id).not.toBe('');
		expect(text('durability-detail')).toContain('installed application');
		expect(absent('keep-storage')).toBe(true);
		press('durability-learn-more');
		expect(absent('durability-detail')).toBe(true);
	});

	test('a Firefox-shaped browser is offered its own prompt and what it buys, then told of the grant', async () => {
		const storage = browser('can-ask');
		press('durability-learn-more');
		const detail = text('durability-detail');
		expect(detail).toContain('10 GB');
		expect(detail).toContain('half this disk');
		expect(storage.asked).toBe(0);
		await pressAndSettle('keep-storage');

		expect(storage.asked).toBe(1);
		expect(text('durability-lead')).toContain('Kept');
		expect(storage.storageAnswers?.persisted).toBe(true);
	});

	test('the WebKit line names the seven days, what counts as a visit, and the order to install in', () => {
		browser('seven-day');
		const said = `${text('durability-lead')} ${text('durability-detail')}`;
		expect(said).toContain('seven days');
		expect(said).toMatch(/tap, a click or a keypress/);
		expect(said).toContain('scrolling does not');
		expect(said).toContain('Home Screen');
		expect(said).toMatch(/before you bring in large maps/);
		expect(said).toMatch(/starts empty/);
	});

	test('a private window is told its work will not survive the session', () => {
		browser('ephemeral');
		expect(text('durability-lead')).toContain('will not survive closing it');
		press('durability-learn-more');
		expect(text('durability-detail')).toContain('private window');
	});

	test('says nothing before the browser has answered', () => {
		open({ storageAnswers: null });
		expect(absent('durability')).toBe(true);
	});

	test('an installed application is not told to install', () => {
		browser('install-to-keep');
		expect(text('durability-lead')).toContain('Installing Ballastella');
		takeDown();
		const storage = browser('install-to-keep', true);
		expect(text('durability-lead')).not.toContain('Installing Ballastella');
		expect(storage.storageAnswers?.persisted).toBe(false);
	});
});

describe('a transfer under way, with the keyboard still in the tab order', () => {
	const busyControls = ['back-up-workspace', 'restore-workspace', 'move-into-folder'] as const;

	test('announces per-file progress, every busy control focusable, and starts nothing more', () => {
		const storage = open({ progressSteps: 7 });
		press('back-up-workspace');
		expect(text('transfer-progress')).toBe('Backing up “My Workspace”… 7 of 7 files.');
		expect(storage.transfers).toBe(1);

		for (const testId of busyControls) {
			const control = at(testId) as HTMLButtonElement;
			expect(control.disabled).toBe(false);
			expect(control.getAttribute('aria-disabled')).toBe('true');
			control.focus();
			expect(document.activeElement).toBe(control);
		}
		for (const testId of busyControls) press(testId);
		expect(storage.transfers).toBe(1);
	});
});
