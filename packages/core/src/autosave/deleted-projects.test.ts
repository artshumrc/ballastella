import { describe, expect, it } from 'vitest';

import { DeletedProjects, discardDeletions, workspacesWithDeletions } from './deleted-projects.js';
import { FakeJournalStorage } from './fake-journal-storage.js';
import { WriteAheadJournal, discardJournal, journalledWorkspaces } from './journal.js';
import type { StorePath } from '../store/project-store.js';

/** What the hub was rendering when the user pressed Delete. See `DeletionRecord.was`. */
const WAS = { name: 'Amsterdam 1625', updatedAt: '2026-08-08T09:00:00.000Z' };

const storeAndRecord = (workspace = 'opfs:My Workspace') => {
	const storage = new FakeJournalStorage();
	return { storage, deleted: new DeletedProjects(storage, workspace) };
};

describe('DeletedProjects', () => {
	it('remembers, answers, and forgets one Project', () => {
		const { deleted } = storeAndRecord();

		expect(deleted.has('amsterdam-1625')).toBe(false);
		expect(deleted.record('amsterdam-1625', WAS)).toBe(true);
		expect(deleted.has('amsterdam-1625')).toBe(true);
		expect(deleted.pending()).toEqual([
			{ directory: 'amsterdam-1625', at: expect.any(String), was: WAS }
		]);

		deleted.forget('amsterdam-1625');
		expect(deleted.has('amsterdam-1625')).toBe(false);
		expect(deleted.pending()).toEqual([]);
	});

	it('forgets a Project it never held, without complaint', () => {
		const { deleted } = storeAndRecord();
		expect(() => deleted.forget('never-existed')).not.toThrow();
	});

	/**
	 * ⚠ **The reason this is bound to a Workspace at construction** (ticket 12, ticket 21).
	 *
	 * The OPFS root holds several named Workspaces and one click switches between them. A record
	 * keyed by directory alone would let a deletion performed in "Marking 2026" be finished, at the
	 * next startup, against a same-named Project in whichever Workspace happened to be open.
	 */
	it('does not let one Workspace’s deletion be seen by another', () => {
		const storage = new FakeJournalStorage();
		const marking = new DeletedProjects(storage, 'opfs:Marking 2026');
		const teaching = new DeletedProjects(storage, 'opfs:Teaching');

		marking.record('amsterdam-1625', WAS);

		expect(teaching.has('amsterdam-1625')).toBe(false);
		expect(teaching.pending()).toEqual([]);
		expect(marking.pending().map((record) => record.directory)).toEqual(['amsterdam-1625']);
	});

	/**
	 * A Workspace name is arbitrary user text and may contain the separator. Unencoded, a Workspace
	 * called `a/b` and a Workspace called `a` holding a Project `b` would produce the same key —
	 * which is one Workspace's deletion carried out in another's, the failure above by another route.
	 */
	it('keeps a Workspace whose name contains the separator distinct', () => {
		const storage = new FakeJournalStorage();
		const slashed = new DeletedProjects(storage, 'a/b');
		const plain = new DeletedProjects(storage, 'a');

		slashed.record('c', WAS);

		expect(plain.has('b/c')).toBe(false);
		expect(plain.pending()).toEqual([]);
	});

	/**
	 * ⚠ **Not under the write-ahead journal's prefix, and this is what holds that apart.**
	 *
	 * `journalledWorkspaces` and `discardJournal` walk `ballastella.journal.` and treat everything
	 * under it as an unsaved edit. A deletion record living there would be listed to the user as
	 * unsaved work in a Workspace they had left, and thrown away by the button offering to discard
	 * those — which would silently turn an unfinished deletion into a Project that comes back.
	 */
	it('is invisible to the write-ahead journal’s own whole-origin walks', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:Marking 2026').record('amsterdam-1625', WAS);

		expect(journalledWorkspaces(storage)).toEqual([]);
		expect(discardJournal(storage, 'opfs:Marking 2026')).toBe(0);
	});

	/** And the converse, so neither walk can quietly start eating the other's keys. */
	it('does not see the write-ahead journal’s entries', () => {
		const storage = new FakeJournalStorage();
		new WriteAheadJournal(storage, 'opfs:Marking 2026').record(
			'amsterdam-1625/project.json' as StorePath,
			new Uint8Array([1, 2, 3])
		);

		expect(new DeletedProjects(storage, 'opfs:Marking 2026').pending()).toEqual([]);
	});

	/**
	 * A browser that will not store anything — a private window with site data blocked — is a browser
	 * where this protection is genuinely unavailable, exactly as the write-ahead journal is.
	 * Answered rather than swallowed, and never thrown: a storage that refuses must not stop a user
	 * deleting a Project. What is lost is the *completion* of an interrupted deletion, which is what
	 * the state was before this module existed.
	 */
	it('says so when the browser will not hold the record, and does not throw', () => {
		const storage = new FakeJournalStorage();
		storage.setItem = () => {
			throw new DOMException('blocked', 'SecurityError');
		};
		const deleted = new DeletedProjects(storage, 'opfs:My Workspace');

		expect(deleted.record('amsterdam-1625', WAS)).toBe(false);
		expect(deleted.has('amsterdam-1625')).toBe(false);
	});

	it('sorts what it answers, so a startup does the same work in the same order', () => {
		const { deleted } = storeAndRecord();
		for (const directory of ['zutphen-1600', 'amsterdam-1625', 'boston-1775']) {
			deleted.record(directory, WAS);
		}
		expect(deleted.pending().map((record) => record.directory)).toEqual([
			'amsterdam-1625',
			'boston-1775',
			'zutphen-1600'
		]);
	});
});

describe('the evidence a deletion record carries', () => {
	/**
	 * ⚠ **The reason `was` exists at all** (ticket 21, review 2).
	 *
	 * `Workspace.finishInterruptedDeletions` is the one step of the recovery chain that *destroys*
	 * files, and the folder name it is keyed by is not unique: a folder Workspace's key is
	 * `folder:<folder name>`, because the browser offers a page no stable identifier for a picked
	 * directory (ADR-0017). So the record has to say what it was aimed at, or a deletion in one
	 * `maps` folder is a recursive delete in another.
	 */
	it('carries what the Project was, so a later startup can check it is the same one', () => {
		const { deleted } = storeAndRecord();

		deleted.record('amsterdam-1625', WAS);

		expect(deleted.pending()[0]?.was).toEqual(WAS);
	});

	/**
	 * `null` is a real state, not a default: it is the answer for a caller that did not know what it
	 * was deleting, and it licenses **no** removal. The record still refuses a replay, which is
	 * additive and safe; `Workspace` is where the destructive half insists on more.
	 */
	it('answers null for a gesture whose target was never written down', () => {
		const { deleted } = storeAndRecord();

		deleted.record('amsterdam-1625', null);

		expect(deleted.pending()).toEqual([
			{ directory: 'amsterdam-1625', at: expect.any(String), was: null }
		]);
		expect(deleted.has('amsterdam-1625')).toBe(true);
	});

	/**
	 * A value truncated by a full `localStorage`, or written by a build that is not this one. The
	 * safe direction is "no evidence" — never "no `was` field, so go ahead and delete".
	 */
	it('reads a value it cannot parse as no evidence rather than as permission', () => {
		const storage = new FakeJournalStorage();
		const deleted = new DeletedProjects(storage, 'opfs:My Workspace');
		deleted.record('amsterdam-1625', WAS);
		const [key] = [...storage.items.keys()];
		storage.items.set(key as string, '{"formatVersion":1,"at":"2026-08-08T09:00:0');

		expect(deleted.pending()).toEqual([{ directory: 'amsterdam-1625', at: '', was: null }]);
	});

	/** The same rule for a value that parses but says something else. */
	it('reads a half-shaped record as no evidence', () => {
		const storage = new FakeJournalStorage();
		const deleted = new DeletedProjects(storage, 'opfs:My Workspace');
		deleted.record('amsterdam-1625', WAS);
		const [key] = [...storage.items.keys()];
		storage.items.set(
			key as string,
			JSON.stringify({ formatVersion: 1, at: 'x', was: { name: 'A' } })
		);

		expect(deleted.pending()[0]).toEqual({ directory: 'amsterdam-1625', at: 'x', was: null });
	});
});

describe('a storage that will not answer', () => {
	/**
	 * Safari with cookies blocked answers reads and rejects writes; a locked-down private window can
	 * throw from any of it. Both error paths lead the same way — the direction that leaves the user's
	 * files where they are.
	 */
	it('reads an unreadable storage as “no record”, not as a deletion', () => {
		const storage = new FakeJournalStorage();
		storage.getItem = () => {
			throw new DOMException('blocked', 'SecurityError');
		};

		expect(new DeletedProjects(storage, 'opfs:My Workspace').has('amsterdam-1625')).toBe(false);
	});

	it('answers no pending deletions when the storage cannot even be enumerated', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:My Workspace').record('amsterdam-1625', WAS);
		Object.defineProperty(storage, 'length', {
			get() {
				throw new DOMException('blocked', 'SecurityError');
			}
		});

		expect(new DeletedProjects(storage, 'opfs:My Workspace').pending()).toEqual([]);
	});

	/** And one whose keys read but whose values do not: a record with no evidence, never a licence. */
	it('answers no evidence when a key enumerates but its value cannot be read', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:My Workspace').record('amsterdam-1625', WAS);
		storage.getItem = () => {
			throw new DOMException('blocked', 'SecurityError');
		};

		expect(new DeletedProjects(storage, 'opfs:My Workspace').pending()).toEqual([
			{ directory: 'amsterdam-1625', at: '', was: null }
		]);
	});
});

/**
 * ⚠ **The sweep the first cut did not have** (ticket 21, review 2).
 *
 * `WorkspaceStorage.#removeWorkspace` discards a deleted Workspace's journal with the reason written
 * on the spot: entries that outlive their Workspace are "put back into somebody else's work under a
 * name they happened to reuse". A deletion record has the same key shape and the same reuse hazard,
 * and its effect is destructive rather than additive — and it was swept by nothing and invisible to
 * the orphan report offered beside the journal keys in the same 5 MB.
 */
describe('seeing and sweeping records across every Workspace', () => {
	it('names every Workspace holding an unfinished deletion, sorted', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:Teaching').record('boston-1775', WAS);
		new DeletedProjects(storage, 'folder:maps').record('amsterdam-1625', WAS);

		expect(workspacesWithDeletions(storage)).toEqual(['folder:maps', 'opfs:Teaching']);
	});

	it('discards one Workspace’s records and counts them, leaving every other alone', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:Teaching').record('boston-1775', WAS);
		const marking = new DeletedProjects(storage, 'opfs:Marking 2026');
		marking.record('amsterdam-1625', WAS);
		marking.record('zutphen-1600', WAS);

		expect(discardDeletions(storage, 'opfs:Marking 2026')).toBe(2);

		expect(marking.pending()).toEqual([]);
		expect(workspacesWithDeletions(storage)).toEqual(['opfs:Teaching']);
	});

	/** It must not eat the write-ahead journal's keys, which live under a different prefix. */
	it('leaves the write-ahead journal alone', () => {
		const storage = new FakeJournalStorage();
		new WriteAheadJournal(storage, 'opfs:Marking 2026').record(
			'amsterdam-1625/project.json' as StorePath,
			new Uint8Array([1])
		);

		expect(workspacesWithDeletions(storage)).toEqual([]);
		expect(discardDeletions(storage, 'opfs:Marking 2026')).toBe(0);
		expect(journalledWorkspaces(storage)).toEqual(['opfs:Marking 2026']);
	});
});
