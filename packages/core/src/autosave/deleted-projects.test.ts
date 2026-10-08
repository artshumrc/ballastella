import { describe, expect, it } from 'vitest';

import { DeletedProjects, discardDeletions, workspacesWithDeletions } from './deleted-projects.js';
import { FakeJournalStorage } from './fake-journal-storage.js';
import { WriteAheadJournal, discardJournal, journalledWorkspaces } from './journal.js';
import type { StorePath } from '../store/project-store.js';

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
		expect(deleted.pending()).toEqual([{ directory: 'amsterdam-1625', was: WAS }]);

		deleted.forget('amsterdam-1625');
		expect(deleted.has('amsterdam-1625')).toBe(false);
		expect(deleted.pending()).toEqual([]);
	});

	it('forgets a Project it never held, without complaint', () => {
		const { deleted } = storeAndRecord();
		expect(() => deleted.forget('never-existed')).not.toThrow();
	});

	it('does not let one Workspace’s deletion be seen by another', () => {
		const storage = new FakeJournalStorage();
		const marking = new DeletedProjects(storage, 'opfs:Marking 2026');
		const teaching = new DeletedProjects(storage, 'opfs:Teaching');

		marking.record('amsterdam-1625', WAS);

		expect(teaching.has('amsterdam-1625')).toBe(false);
		expect(teaching.pending()).toEqual([]);
		expect(marking.pending().map((record) => record.directory)).toEqual(['amsterdam-1625']);
	});

	it('keeps a Workspace whose name contains the separator distinct', () => {
		const storage = new FakeJournalStorage();
		const slashed = new DeletedProjects(storage, 'a/b');
		const plain = new DeletedProjects(storage, 'a');

		slashed.record('c', WAS);

		expect(plain.has('b/c')).toBe(false);
		expect(plain.pending()).toEqual([]);
	});

	it('is invisible to the write-ahead journal’s own whole-origin walks', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:Marking 2026').record('amsterdam-1625', WAS);

		expect(journalledWorkspaces(storage)).toEqual([]);
		expect(discardJournal(storage, 'opfs:Marking 2026')).toBe(0);
	});

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
	it('answers null for a gesture whose target was never written down', () => {
		const { deleted } = storeAndRecord();

		deleted.record('amsterdam-1625', null);

		expect(deleted.pending()).toEqual([{ directory: 'amsterdam-1625', was: null }]);
		expect(deleted.has('amsterdam-1625')).toBe(true);
	});

	it.each([
		[
			'a value it cannot parse, rather than as permission',
			'{"formatVersion":1,"at":"2026-08-08T09:00:0'
		],
		['a half-shaped record', JSON.stringify({ formatVersion: 1, at: 'x', was: { name: 'A' } })],
		[
			'a record written to another format',
			JSON.stringify({ formatVersion: 2, at: 'x', was: { name: 'A', updatedAt: 'B' } })
		]
	])('reads %s as no evidence', (_, value) => {
		const storage = new FakeJournalStorage();
		const deleted = new DeletedProjects(storage, 'opfs:My Workspace');
		deleted.record('amsterdam-1625', WAS);
		const [key] = [...storage.items.keys()];
		storage.items.set(key as string, value);

		expect(deleted.pending()).toEqual([{ directory: 'amsterdam-1625', was: null }]);
		expect(deleted.has('amsterdam-1625')).toBe(true);
	});
});

describe('a storage that will not answer', () => {
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

	it('answers no evidence when a key enumerates but its value cannot be read', () => {
		const storage = new FakeJournalStorage();
		new DeletedProjects(storage, 'opfs:My Workspace').record('amsterdam-1625', WAS);
		storage.getItem = () => {
			throw new DOMException('blocked', 'SecurityError');
		};

		expect(new DeletedProjects(storage, 'opfs:My Workspace').pending()).toEqual([
			{ directory: 'amsterdam-1625', was: null }
		]);
	});
});

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

	it('neither sees nor sweeps the write-ahead journal’s entries', () => {
		const storage = new FakeJournalStorage();
		new WriteAheadJournal(storage, 'opfs:Marking 2026').record(
			'amsterdam-1625/project.json' as StorePath,
			new Uint8Array([1])
		);

		expect(new DeletedProjects(storage, 'opfs:Marking 2026').pending()).toEqual([]);
		expect(workspacesWithDeletions(storage)).toEqual([]);
		expect(discardDeletions(storage, 'opfs:Marking 2026')).toBe(0);
		expect(journalledWorkspaces(storage)).toEqual(['opfs:Marking 2026']);
	});
});
