import { describe, expect, it } from 'vitest';

import { DeletedProjects } from './deleted-projects.js';
import { FakeJournalStorage } from './fake-journal-storage.js';
import { WriteAheadJournal, discardJournal, journalledWorkspaces } from './journal.js';
import type { StorePath } from '../store/project-store.js';

const storeAndRecord = (workspace = 'opfs:My Workspace') => {
	const storage = new FakeJournalStorage();
	return { storage, deleted: new DeletedProjects(storage, workspace) };
};

describe('DeletedProjects', () => {
	it('remembers, answers, and forgets one Project', () => {
		const { deleted } = storeAndRecord();

		expect(deleted.has('amsterdam-1625')).toBe(false);
		expect(deleted.record('amsterdam-1625')).toBe(true);
		expect(deleted.has('amsterdam-1625')).toBe(true);
		expect(deleted.pending()).toEqual(['amsterdam-1625']);

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

		marking.record('amsterdam-1625');

		expect(teaching.has('amsterdam-1625')).toBe(false);
		expect(teaching.pending()).toEqual([]);
		expect(marking.pending()).toEqual(['amsterdam-1625']);
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

		slashed.record('c');

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
		new DeletedProjects(storage, 'opfs:Marking 2026').record('amsterdam-1625');

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

		expect(deleted.record('amsterdam-1625')).toBe(false);
		expect(deleted.has('amsterdam-1625')).toBe(false);
	});

	it('sorts what it answers, so a startup does the same work in the same order', () => {
		const { deleted } = storeAndRecord();
		for (const directory of ['zutphen-1600', 'amsterdam-1625', 'boston-1775']) {
			deleted.record(directory);
		}
		expect(deleted.pending()).toEqual(['amsterdam-1625', 'boston-1775', 'zutphen-1600']);
	});
});
