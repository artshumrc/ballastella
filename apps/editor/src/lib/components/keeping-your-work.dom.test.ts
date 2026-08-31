// What Workspace Home says about keeping the work: a Backup, a Restore, what the browser promised,
// the offer that answers it, unsaved changes with nowhere to go, and the way into a folder.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE, AND WHAT DELIBERATELY DID NOT
//
// All six were in the Workspace settings dialog ADR-0042 deletes, and every claim about which of
// them is offered, what each says and what a refusal reads as was asserted by booting the built
// editor and opening that dialog. None of that scenery was load-bearing: each sentence is composed
// from what `WorkspaceStorage` answers and nothing else.
//
// ⚠ **What did not move.**
//
// - **That a Backup is really one tar of the real Workspace, and that restoring it makes a real new
//   OPFS Workspace.** Bytes; `packages/core`'s `workspace-tar.test.ts` and `e2e/editor-backup`'s.
// - **That the move really copies every file into a real granted folder.** A real
//   `FileSystemDirectoryHandle` comes only from a user gesture in a real browser;
//   `e2e/editor-folder-workspace` asserts the store snapshot before and after, and
//   `copy-workspace-files.test.ts` asserts the copy itself.
// - **What the browser actually answered about persistence, and whether it can be installed.** Both
//   are real browser state; `e2e/editor-pwa`'s.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import type { StorageDurability } from '@ballastella/core';

import KeepingYourWorkHarness from './KeepingYourWorkHarness.svelte';
import { FakeStorage, backup } from './keeping-your-work-fake.svelte.js';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted, { outro: false });
	mounted = undefined;
	document.body.innerHTML = '';
});

function open(storage: FakeStorage, installed = false): FakeStorage {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(KeepingYourWorkHarness, { target: main, props: { storage, installed } });
	flushSync();
	return storage;
}

/** Take the screen down, so a loop over the six states is six screens and not one. */
function close(): void {
	if (mounted) unmount(mounted, { outro: false });
	mounted = undefined;
	document.body.innerHTML = '';
}

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

const absent = (testId: string): boolean =>
	document.querySelector(`[data-testid="${testId}"]`) === null;

const text = (element: Element | null | undefined): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const press = (testId: string): void => {
	at(testId).click();
	flushSync();
};

/**
 * Choose a file in the restore input, as somebody picking a backup would.
 *
 * The input is off-screen rather than `hidden` so that it is focusable and reachable by role, and
 * happy-dom lets a test put a `File` on it — which is the whole of what the browser's own picker
 * does before the `change` the component listens for.
 */
async function pick(fileName: string): Promise<void> {
	const input = at('restore-file');
	Object.defineProperty(input, 'files', {
		value: [new File([new Uint8Array([1])], fileName)],
		configurable: true
	});
	input.dispatchEvent(new Event('change', { bubbles: true }));
	await settle();
}

/** Let the injected transfer settle, and render what it answered. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
	flushSync();
}

/** A review copy: somebody else's work, in a Workspace built to be thrown away. */
function reviewing(): FakeStorage {
	const storage = new FakeStorage();
	storage.review = {
		formatVersion: 1,
		project: 'Amsterdam 1625',
		directory: 'amsterdam-1625',
		openedAt: '2026-01-01T00:00:00.000Z',
		origin: null
	};
	return storage;
}

/**
 * A browser whose capability answers add up to `kind`.
 *
 * ⚠ **Built from capabilities, never from a name.** These are the same five inputs the real
 * `WorkspaceStorage` supplies, and which of the six they mean is `deriveStorageDurability`'s to
 * decide — exhausted at Seam 1 in `packages/core`'s `storage-durability.test.ts`. What this file
 * asserts is the *sentence*: that each state has one of its own, that only one of them is up front,
 * and that the advice in it is true for the browser it is about.
 */
function browser(kind: StorageDurability['kind']): FakeStorage {
	const storage = new FakeStorage();
	storage.canChooseFolder = true;
	switch (kind) {
		case 'granted':
			storage.storageAnswers = { persisted: true, permission: 'granted', ephemeral: false };
			break;
		// Firefox-shaped: a permission to give, and no File System Access.
		case 'can-ask':
			storage.canChooseFolder = false;
			storage.storageAnswers = { persisted: false, permission: 'prompt', ephemeral: false };
			break;
		// Chromium-shaped: a permission that exists, File System Access, and not installed.
		case 'install-to-keep':
			storage.storageAnswers = { persisted: false, permission: 'prompt', ephemeral: false };
			break;
		// WebKit: the `persistent-storage` permission name is not known at all.
		case 'seven-day':
			storage.canChooseFolder = false;
			storage.storageAnswers = { persisted: false, permission: undefined, ephemeral: false };
			break;
		case 'ephemeral':
			storage.storageAnswers = { persisted: false, permission: 'prompt', ephemeral: true };
			break;
		case 'unknown':
			storage.storageAnswers = { persisted: undefined, permission: undefined, ephemeral: false };
			break;
	}
	return storage;
}

describe('backing up and restoring', () => {
	test('names the file the Backup was written to, and what it holds', async () => {
		open(new FakeStorage());

		press('back-up-workspace');
		await settle();

		expect(text(at('transfer-outcome'))).toBe('Backed up 4 files, 2.0 kB, to “My Workspace.tar”.');
		expect(absent('transfer-progress')).toBe(true);
	});

	// A folder Workspace's name is the operating system's, and a Workspace name cannot hold
	// everything a folder name can — so what the archive will restore as is said rather than left as
	// a surprise in the Downloads folder.
	test('says what a normalised name will restore as', async () => {
		const storage = open(new FakeStorage());
		storage.backupAnswer = backup({ displayName: "Dave's maps", workspaceName: 'Dave s maps' });

		press('back-up-workspace');
		await settle();

		expect(text(at('transfer-outcome'))).toContain('will make a Workspace called “Dave s maps”');
	});

	test('announces per-file progress while the transfer runs', async () => {
		const storage = open(new FakeStorage());
		// Never resolved, so the line the scholar watches is what is on screen rather than a frame
		// between two renders.
		storage.backupAnswer = backup();
		storage.progressSteps = 7;

		press('back-up-workspace');

		expect(text(at('transfer-progress'))).toBe('Backing up “My Workspace”… 7 of 7 files.');
	});

	test('reports what a Restore made, in the words core chose', async () => {
		open(new FakeStorage());

		await pick('My Workspace.tar');

		expect(text(at('transfer-outcome'))).toContain('Restored 4 files into a new Workspace');
		expect(absent('transfer-problem')).toBe(true);
	});

	// ADR-0010's refusal of a newer `formatVersion`, and every other refusal on the read path, is
	// core's sentence shown unaltered — and it is an alert, because its text is inserted at the
	// moment it first exists.
	test('shows a refused Restore in its own words, and as an alert', async () => {
		const storage = open(new FakeStorage());
		storage.restoreAnswer = new Error(
			'That file is not a Ballastella backup, so no Workspace has been made.'
		);

		await pick('holiday.jpg');

		expect(text(at('transfer-problem'))).toBe(
			'That file is not a Ballastella backup, so no Workspace has been made.'
		);
		expect(at('transfer-problem').closest('[role="alert"]')).toBeTruthy();
		expect(text(at('transfer-outcome'))).toBe('');
	});

	// A `change` with no file at all is a picker closed, which is a cancelled gesture.
	test('says nothing when the file picker is closed without choosing', async () => {
		open(new FakeStorage());

		at('restore-file').dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		expect(text(at('transfer-outcome'))).toBe('');
		expect(absent('transfer-problem')).toBe(true);
	});

	// ADR-0024: an archive of somebody else's work in the author's Downloads folder is
	// indistinguishable from a backup of their own. Absent rather than present and refused, with the
	// reason in visible text — and restoring still works, because it lands in a Workspace of the
	// reviewer's own.
	test('withholds a Backup from a review copy, with its own sentence', () => {
		open(reviewing());

		expect(absent('back-up-workspace')).toBe(true);
		expect(text(at('no-backup-in-review'))).toContain('review copy of somebody else');
		expect(at('restore-workspace')).toBeTruthy();
	});

	// The other withholding, for a sharper reason: an archive holding half an Import is one the
	// author restores months later believing it whole.
	test('withholds a Backup from a Workspace that has not opened, with its own sentence', () => {
		const storage = new FakeStorage();
		storage.unavailable = 'An Import that did not finish could not be resolved.';
		open(storage);

		expect(absent('back-up-workspace')).toBe(true);
		expect(text(at('no-backup-unrecovered'))).toContain('has not opened yet');
		expect(at('restore-workspace')).toBeTruthy();
	});
});

describe('moving this Workspace into a folder', () => {
	test('offers the move for a browser Workspace, and says what it leaves behind', async () => {
		const storage = open(new FakeStorage());

		expect(text(at('workspace-storage-place'))).toBe('My Workspace');
		press('move-into-folder');
		await settle();

		expect(text(at('transfer-outcome'))).toContain('is now in the folder “maps”');
		expect(storage.backing).toBe('browser');
	});

	// The one-way part: a Workspace that is already in a folder is where it was going, so there is
	// nothing to offer — and *Use browser storage instead* is the roster's job now.
	test('offers no move from a folder Workspace, and names the folder instead', () => {
		const storage = new FakeStorage();
		storage.backing = 'folder';
		storage.folderName = 'maps';
		open(storage);

		expect(absent('move-into-folder')).toBe(true);
		expect(text(at('workspace-folder-place'))).toBe('maps');
	});

	// ADR-0042: where the File System Access API is absent the choice is not offered and the *kind*
	// is never named — a Workspace is simply a Workspace.
	test('names no kind at all on a browser that cannot open folders', () => {
		const storage = new FakeStorage();
		storage.canChooseFolder = false;
		open(storage);

		expect(absent('move-into-folder')).toBe(true);
		expect(absent('workspace-storage-place')).toBe(true);
		expect(document.body.textContent).not.toContain('Move this Workspace');
		expect(document.body.textContent).not.toContain("Where this Workspace's files are");
	});

	test('says why a folder was not used, and that nothing moved', async () => {
		const storage = open(new FakeStorage());
		storage.moveAnswer = new Error(
			'That folder already holds files, so “My Workspace” was not moved into it.'
		);

		press('move-into-folder');
		await settle();

		expect(text(at('transfer-problem'))).toContain('was not moved into it');
		expect(at('transfer-problem').closest('[role="alert"]')).toBeTruthy();
	});

	// A cancelled gesture is not a failure and needs no message.
	test('says nothing at all when the picker is closed without choosing', async () => {
		const storage = open(new FakeStorage());
		storage.moveAnswer = '';

		press('move-into-folder');
		await settle();

		expect(text(at('transfer-outcome'))).toBe('');
		expect(absent('transfer-problem')).toBe(true);
	});
});

describe('unsaved changes with nowhere to go', () => {
	test('names the Workspaces the way the author knows them, never by the journal key', () => {
		const storage = new FakeStorage();
		storage.orphanedJournals = ['opfs:Marking 2026', 'folder:6f2a'];
		open(storage);

		const said = text(at('orphaned-journals'));
		expect(said).toContain('Marking 2026');
		expect(said).not.toContain('opfs:');
	});

	test('throws one away only when asked, and says what went', () => {
		const storage = new FakeStorage();
		storage.orphanedJournals = ['opfs:Marking 2026'];
		open(storage);

		expect(storage.discarded).toEqual([]);
		press('discard-orphaned-journal');

		expect(storage.discarded).toEqual(['opfs:Marking 2026']);
		expect(text(at('discard-outcome'))).toBe(
			'Threw away 2 unsaved changes held for “Marking 2026”. Nothing in any Workspace was touched.'
		);
		expect(absent('orphaned-journals')).toBe(true);
	});

	// Edits and deletions are separate things: summed, a Workspace holding only the second was
	// reported as "1 unsaved change", which is false in both nouns.
	test('names an unfinished deletion as one, beside any unsaved edit', () => {
		const storage = new FakeStorage();
		storage.orphanedJournals = ['opfs:Marking 2026'];
		storage.discardAnswer = { edits: 1, deletions: 1 };
		open(storage);

		press('discard-orphaned-journal');

		expect(text(at('discard-outcome'))).toContain('1 unsaved change and 1 unfinished deletion');
	});

	// The empty arm: a second tab having cleared them between the list being built and this press.
	// "Threw away 0 unsaved changes" reads as a failure of the button rather than as somebody else
	// having got there first.
	test('says somebody else had already cleared it rather than reporting nothing', () => {
		const storage = new FakeStorage();
		storage.orphanedJournals = ['opfs:Marking 2026'];
		storage.discardAnswer = { edits: 0, deletions: 0 };
		open(storage);

		press('discard-orphaned-journal');

		expect(text(at('discard-outcome'))).toContain('something else had already cleared it');
	});

	test('says nothing about them when there are none', () => {
		open(new FakeStorage());

		expect(absent('orphaned-journals')).toBe(true);
		expect(text(at('discard-outcome'))).toBe('');
	});
});

describe('what the browser promised about keeping the work', () => {
	const KINDS: StorageDurability['kind'][] = [
		'granted',
		'can-ask',
		'install-to-keep',
		'seven-day',
		'ephemeral',
		'unknown'
	];

	// One short line per state, and six different lines: a scholar is told which of the six they are
	// in, and no two of them read the same.
	test('every state has a line of its own', () => {
		const lines = new Set<string>();
		for (const kind of KINDS) {
			open(browser(kind));
			lines.add(text(at('durability-lead')));
			close();
		}
		expect(lines.size).toBe(6);
		for (const line of lines) expect(line.length).toBeGreaterThan(0);
	});

	// ⚠ The claim the WebKit finding turns on. Everywhere else the detail is behind a press; there it
	// is not, because a scholar who never presses it loses everything they have after seven days.
	test('only the seven-day state says its detail without being pressed', () => {
		for (const kind of KINDS) {
			open(browser(kind));
			if (kind === 'seven-day') {
				expect(at('durability-detail')).toBeTruthy();
				expect(absent('durability-learn-more')).toBe(true);
			} else {
				expect(absent('durability-detail'), `${kind} showed its detail unasked`).toBe(true);
				expect(at('durability-learn-more').getAttribute('aria-expanded')).toBe('false');
			}
			close();
		}
	});

	// A disclosure is a disclosure: a button that says whether it is expanded, and that names the
	// panel it controls (ADR-0016 bans `<details>`; the WAI-ARIA disclosure button is what is left).
	test('the detail is a disclosure that says whether it is showing', () => {
		open(browser('install-to-keep'));

		press('durability-learn-more');
		expect(at('durability-learn-more').getAttribute('aria-expanded')).toBe('true');
		const panel = at('durability-detail');
		expect(at('durability-learn-more').getAttribute('aria-controls')).toBe(panel.id);
		expect(panel.id).not.toBe('');

		press('durability-learn-more');
		expect(absent('durability-detail')).toBe(true);
	});

	// A resolved worry stops occupying the screen: it is said, plainly, and it is one line.
	test('a grant is reported plainly and once, without interrupting', () => {
		open(browser('granted'));

		expect(text(at('durability-lead'))).toContain('Kept');
		expect(at('durability-lead').closest('[role="alert"]')).toBe(null);
	});

	// Chromium answers `persist()` from its own heuristics and opens no dialog, so the only lever is
	// installing — and saying "the browser will ask" there would be advice for a prompt that never
	// comes.
	test('a Chromium-shaped browser is told installing is what makes the promise', () => {
		open(browser('install-to-keep'));

		expect(text(at('durability-lead'))).toContain('Installing Ballastella');
		press('durability-learn-more');
		expect(text(at('durability-detail'))).toContain('installed application');
		// And it is not offered a control for a prompt this browser will never show.
		expect(absent('keep-storage')).toBe(true);
	});

	// Firefox is the one engine that really asks, and granting raises its ceiling as well as
	// protecting the work — both halves are what makes saying yes worth it.
	test('a Firefox-shaped browser is offered the browser’s own prompt, and what it buys', () => {
		const storage = open(browser('can-ask'));

		press('durability-learn-more');
		const detail = text(at('durability-detail'));
		expect(detail).toContain('10 GB');
		expect(detail).toContain('half this disk');

		expect(storage.asked).toBe(0);
		press('keep-storage');
		expect(storage.asked).toBe(1);
	});

	// The press is what asks — `persist()` is what opens Firefox's prompt, so it must not have been
	// called on the way to drawing the screen (ADR-0012: do not nag).
	test('nothing asks the browser for the grant until the author presses', () => {
		const storage = open(browser('can-ask'));
		press('durability-learn-more');

		expect(storage.asked).toBe(0);
	});

	test('the grant, once given, is reported where it was asked for', async () => {
		const storage = open(browser('can-ask'));
		press('durability-learn-more');
		press('keep-storage');
		await settle();

		expect(text(at('durability-lead'))).toContain('Kept');
		expect(storage.storageAnswers?.persisted).toBe(true);
	});

	// ⚠ The WebKit copy, clause by clause. Each of these is a rule a scholar has to be able to
	// satisfy, and the epic's stories name them individually because a paraphrase loses one.
	test('the WebKit line names the seven days, what counts as a visit, and the order to install in', () => {
		open(browser('seven-day'));

		const said = `${text(at('durability-lead'))} ${text(at('durability-detail'))}`;
		expect(said).toContain('seven days');
		expect(said).toMatch(/tap, a click or a keypress/);
		expect(said).toContain('scrolling does not');
		expect(said).toContain('Home Screen');
		expect(said).toMatch(/before you bring in large maps/);
		expect(said).toMatch(/starts empty/);
	});

	test('a private window is told its work will not survive the session', () => {
		open(browser('ephemeral'));

		expect(text(at('durability-lead'))).toContain('will not survive closing it');
		press('durability-learn-more');
		expect(text(at('durability-detail'))).toContain('private window');
	});

	// The one answer that depends on no browser, so it is in every state — the granted one included,
	// because a promise about this browser is not a promise about this disk.
	test('a backup is offered in every state', () => {
		for (const kind of KINDS) {
			open(browser(kind));
			if (kind !== 'seven-day') press('durability-learn-more');
			expect(text(at('download-backup')), `${kind} offered no backup`).toContain(
				'Download a Backup'
			);
			close();
		}
	});

	test('that backup is a real one', async () => {
		const storage = open(browser('granted'));
		press('durability-learn-more');
		press('download-backup');
		await settle();

		expect(text(at('transfer-outcome'))).toContain('“My Workspace.tar”');
		expect(storage.backupAnswer).not.toBeInstanceOf(Error);
	});

	// ⚠ **Never advise turning a privacy protection off.** It would remove WebKit's seven-day
	// deletion, and it also makes `persist()` fail for everybody, because the exemption set comes out
	// of ITP's own store. Asserted over every state's copy at once, because the temptation is
	// specifically in the WebKit one.
	test('no state suggests turning off a privacy setting', () => {
		for (const kind of KINDS) {
			open(browser(kind));
			if (kind !== 'seven-day') press('durability-learn-more');
			const said = `${text(at('durability-lead'))} ${text(at('durability-detail'))}`.toLowerCase();
			for (const forbidden of [
				'tracking prevention',
				'prevent cross-site tracking',
				'turn off',
				'switch off',
				'disable'
			]) {
				expect(said, `${kind} suggested “${forbidden}”`).not.toContain(forbidden);
			}
			close();
		}
	});

	// Nothing is said at all until the browser has answered, rather than a wrong reassurance shown
	// while the read is in flight.
	test('says nothing before the browser has answered', () => {
		const storage = new FakeStorage();
		storage.storageAnswers = null;
		open(storage);

		expect(absent('durability')).toBe(true);
	});

	// Whether Ballastella is installed is not the store's to know, and it changes while this screen is
	// open: installing from the offer below turns the Chromium grant, and the sentence above it has to
	// follow without a reload.
	test('an installed application is not told to install', () => {
		open(browser('install-to-keep'));
		expect(text(at('durability-lead'))).toContain('Installing Ballastella');
		close();

		const storage = open(browser('install-to-keep'), true);
		expect(text(at('durability-lead'))).not.toContain('Installing Ballastella');
		// And the browser's own answer is unchanged: what moved is the lever, not the grant.
		expect(storage.storageAnswers?.persisted).toBe(false);
	});

	// The install offer is the remedy two of those states name, and it is beside them rather than in a
	// dialog of its own (ADR-0012, ADR-0042).
	test('offers installing beside the sentence it answers', () => {
		open(browser('install-to-keep'));

		expect(at('install-offer')).toBeTruthy();
	});
});

/**
 * A control that is busy keeps its place in the tab order (user story 130, WCAG 2.4.3).
 *
 * ⚠ **`disabled` is the wrong spelling and the reason is not stylistic.** A `disabled` button is
 * removed from the tab order the instant it is pressed, so the keyboard user who pressed it is
 * dropped on `<body>` for the length of a transfer that may run for minutes — and they cannot even
 * tab back to the progress line, because the control they were on is no longer a stop. Every other
 * busy control in the application is `aria-disabled` with a guarded handler, and these three are the
 * ones this file holds to it.
 *
 * The refusal has to be in the handler as well as in the attribute: `aria-disabled` is a statement
 * to the accessibility tree and nothing more, so a focusable control still answers `Enter`.
 */
describe('a transfer under way, with the keyboard still in the tab order', () => {
	/** The three controls a transfer makes busy, and the press that starts one. */
	const busyControls = ['back-up-workspace', 'restore-workspace', 'move-into-folder'] as const;

	test('every control a transfer makes busy stays focusable rather than disabled', () => {
		const storage = open(new FakeStorage());
		// Never settled, so *busy* is the state on screen rather than a frame between two renders.
		storage.progressSteps = 7;
		press('back-up-workspace');

		for (const testId of busyControls) {
			const control = at(testId) as HTMLButtonElement;
			expect(control.disabled).toBe(false);
			expect(control.getAttribute('aria-disabled')).toBe('true');
			control.focus();
			expect(document.activeElement).toBe(control);
		}
	});

	test('pressing one again while it is busy starts nothing', () => {
		const storage = open(new FakeStorage());
		storage.progressSteps = 7;

		press('back-up-workspace');
		expect(storage.transfers).toBe(1);

		for (const testId of busyControls) press(testId);
		expect(storage.transfers).toBe(1);
	});

	// The Backup offered inside the storage warning is the same act by a second control, and its own
	// copy of it — so it is the same claim in the one state that renders it.
	test('the Backup inside the storage warning is busy the same way', () => {
		const storage = open(browser('seven-day'));
		storage.progressSteps = 7;

		press('download-backup');
		expect(storage.transfers).toBe(1);

		const control = at('download-backup') as HTMLButtonElement;
		expect(control.disabled).toBe(false);
		expect(control.getAttribute('aria-disabled')).toBe('true');
		press('download-backup');
		expect(storage.transfers).toBe(1);
	});
});
