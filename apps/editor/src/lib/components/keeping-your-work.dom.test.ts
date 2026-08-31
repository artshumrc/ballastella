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

import KeepingYourWorkHarness from './KeepingYourWorkHarness.svelte';
import { FakeStorage, backup } from './keeping-your-work-fake.svelte.js';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted, { outro: false });
	mounted = undefined;
	document.body.innerHTML = '';
});

function open(storage: FakeStorage): FakeStorage {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(KeepingYourWorkHarness, { target: main, props: { storage } });
	flushSync();
	return storage;
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

describe('what the browser promised, and the offer that answers it', () => {
	test('reports a grant plainly and once', () => {
		open(new FakeStorage());

		expect(text(at('persistence-granted'))).toContain('will not clear your Workspace');
		expect(at('persistence-granted').closest('[role="alert"]')).toBe(null);
	});

	// A refusal means everything in browser storage is evictable under disk pressure, and on Firefox,
	// Safari and iPadOS browser storage is the only Workspace there is.
	//
	// ⚠ **Said, and not as an `alert`.** It is true before the screen is drawn rather than inserted
	// when it happens, which is what CONTRIBUTING's mandated-method table reserves `role="alert"`
	// for — and an assertive region standing here permanently would be a second one beside every
	// refusal this screen actually raises.
	test('reports a refusal in words, without interrupting', () => {
		const storage = new FakeStorage();
		storage.persistence = 'refused';
		open(storage);

		expect(text(at('persistence-refused'))).toContain('may clear your Workspace');
		expect(at('persistence-refused').closest('[role="alert"]')).toBe(null);
	});

	test('says a browser that will not answer has not answered', () => {
		const storage = new FakeStorage();
		storage.persistence = 'unsupported';
		open(storage);

		expect(text(at('persistence-unsupported'))).toContain('will not say');
	});

	// The install offer is the remedy the sentence above names, and it is beside it rather than in a
	// dialog of its own (ADR-0012, ADR-0042).
	test('offers installing beside the sentence it answers', () => {
		open(new FakeStorage());

		expect(at('install-offer')).toBeTruthy();
	});
});
