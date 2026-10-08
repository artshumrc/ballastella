import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { EditHistory } from '../undo/edit-history.js';
import { Autosave, installFlushOnHide } from './autosave.js';
import {
	JOURNAL_FORMAT_VERSION,
	JournalFullError,
	JournalUnavailableError,
	WriteAheadJournal,
	discardJournal,
	fingerprintOf,
	forgetHeldCopy,
	readHeldCopies,
	journalledWorkspaces,
	readJournal,
	type JournalStorage
} from './journal.js';
import { FakeJournalStorage } from './fake-journal-storage.js';
import { decode, encode, rejection } from '../test-support.js';

const journalledTexts = (storage: JournalStorage, workspace = 'W') =>
	readJournal(storage, workspace).entries.map((entry) => decode(entry.bytes));
const journalledPaths = (storage: JournalStorage) =>
	readJournal(storage, 'W').entries.map((entry) => entry.path);
const baselineIn = (storage: JournalStorage) => readJournal(storage, 'W').entries[0]?.held;
const KEY = 'ballastella.journal.W/a%2Fproject.json';

class FakeStorage extends FakeJournalStorage {
	limit = Number.POSITIVE_INFINITY;
	refuseRemoval = false;
	refusal: unknown = null;

	override setItem(key: string, value: string): void {
		if (this.refusal !== null) throw this.refusal;
		const others = [...this.items].reduce(
			(total, [at, held]) => total + (at === key ? 0 : at.length + held.length),
			0
		);
		if (others + key.length + value.length > this.limit) {
			throw new DOMException('exceeded the quota', 'QuotaExceededError');
		}
		super.setItem(key, value);
	}

	override removeItem(key: string): void {
		if (this.refuseRemoval) throw new DOMException('cannot remove', 'InvalidStateError');
		super.removeItem(key);
	}
}

describe('WriteAheadJournal', () => {
	let storage: FakeStorage;

	beforeEach(() => {
		storage = new FakeStorage();
	});

	it('holds bytes under a key naming the Workspace as well as the path', () => {
		new WriteAheadJournal(storage, 'Marking 2026').record('a/project.json', encode('one'));

		expect(readJournal(storage, 'Marking 2026').entries).toEqual([
			{
				workspace: 'Marking 2026',
				path: 'a/project.json',
				bytes: encode('one'),
				at: expect.any(String),
				held: null
			}
		]);
	});

	it('keeps Workspaces apart when names differ only by a separator, or are not Latin', () => {
		new WriteAheadJournal(storage, 'a/b').record('c.json', encode('left'));
		new WriteAheadJournal(storage, 'a').record('b/c.json', encode('right'));
		new WriteAheadJournal(storage, 'Карта 1625 (2)').record('a/project.json', encode('x'));

		expect(journalledTexts(storage, 'a/b')).toEqual(['left']);
		expect(journalledTexts(storage, 'a')).toEqual(['right']);
		expect(journalledTexts(storage, 'Карта 1625 (2)')).toEqual(['x']);
		expect(journalledWorkspaces(storage)).toContain('Карта 1625 (2)');
	});

	it('round-trips bytes that are not text, at a size that needs chunked encoding', () => {
		const bytes = new Uint8Array(200_000).map((_, at) => (at * 7) % 256);

		new WriteAheadJournal(storage, 'W').record('a/big.bin', bytes as Uint8Array<ArrayBuffer>);

		expect(readJournal(storage, 'W').entries[0]?.bytes).toEqual(bytes);
	});

	it('forgets one path, or everything under a prefix as a deletion needs, and leaves the rest', () => {
		const journal = new WriteAheadJournal(storage, 'W');
		for (const path of [
			'a/project.json',
			'a/annotations/l.geojson',
			'b/project.json',
			'c/x.json'
		]) {
			journal.record(path, encode(path));
		}

		journal.forget('c/x.json');
		expect(journalledPaths(storage)).not.toContain('c/x.json');
		expect(journal.forgetUnder('a/')).toBe(2);
		expect(journalledPaths(storage)).toEqual(['b/project.json']);
	});

	it('discards one Workspace and no other', () => {
		new WriteAheadJournal(storage, 'W').record('a/project.json', encode('one'));
		new WriteAheadJournal(storage, 'X').record('a/project.json', encode('two'));

		expect(discardJournal(storage, 'W')).toBe(1);
		expect(journalledWorkspaces(storage)).toEqual(['X']);
	});

	describe('fingerprintOf', () => {
		const of = (text: string) => fingerprintOf(encode(text) as Bytes);

		it('is stable, and separates a string from one it prefixes by length and by hash', () => {
			expect(of('the edit that stranded')).toBe(of('the edit that stranded'));
			expect(of('v1')).not.toBe(of('v2'));
			expect(of('v1-long')).not.toBe(of('v1-long-baseline'));
			expect(of('v1-long').split('-')[0]).not.toBe(of('v1-long-baseline').split('-')[0]);
		});

		it('is a short constant of two rounds from different bases, not a copy of the payload', () => {
			const [, hash = ''] = of('a scholar’s Annotations').split('-');
			expect(hash).toHaveLength(16);
			expect(hash.slice(0, 8)).not.toBe(hash.slice(8));
			expect(
				[encode(''), new Uint8Array(30_000), new Uint8Array(5_000_000)].map(
					(bytes) => fingerprintOf(bytes as Bytes).length
				)
			).toEqual([18, 20, 22]);
		});
	});

	describe('copies a replay declined', () => {
		const HELD = 'ballastella.held.';
		const heldKeys = () => [...storage.items.keys()].filter((key) => key.startsWith(HELD));
		const hold = (journal: WriteAheadJournal, text: string, path = 'a/project.json') =>
			journal.hold(path, encode(text), '', 'x');

		it('says nothing was set aside when the browser has no room for it', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', encode('the edit that stranded'));
			vi.spyOn(storage, 'setItem').mockImplementation(() => {
				throw new DOMException('full', 'QuotaExceededError');
			});

			expect(hold(journal, 'the edit that stranded')).toBeNull();
			expect(heldKeys()).toEqual([]);
			vi.restoreAllMocks();
			expect(journalledTexts(storage)).toEqual(['the edit that stranded']);
		});

		it('refuses past the cap without discarding what it holds, re-holding one not counting', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			const held = ['one', 'two', 'three'].map((text) => hold(journal, text));

			expect(held.every((copy) => copy !== null)).toBe(true);
			expect(hold(journal, 'two')).not.toBeNull();
			expect(hold(journal, 'four')).toBeNull();
			const texts = readHeldCopies(storage, 'W').copies.map((copy) => decode(copy.bytes));
			expect(texts.sort()).toEqual(['one', 'three', 'two']);
		});

		it('reports a damaged copy and discards it, rather than leaving it holding room', () => {
			storage.items.set(`${HELD}W/abc%2Fa%2Fproject.json`, 'not json at all');

			const { copies, problems } = readHeldCopies(storage, 'W');

			expect(copies).toEqual([]);
			expect(problems.map((problem) => [problem.reason, problem.kept])).toEqual([
				['unreadable', false]
			]);
			expect(problems[0]?.detail).toContain('a/project.json');
			expect(heldKeys()).toEqual([]);
		});

		it('is thrown away only by the fingerprint it is named with', () => {
			hold(new WriteAheadJournal(storage, 'W'), 'the edit that stranded');

			expect(forgetHeldCopy(storage, 'W', 'a/project.json', 'not-its-fingerprint')).toBe(false);
			expect(readHeldCopies(storage, 'W').copies).toHaveLength(1);
		});

		it("is never read out of another Workspace's, which it makes findable for reclaiming", () => {
			hold(new WriteAheadJournal(storage, 'Teaching'), 'typed in Teaching');

			expect(readHeldCopies(storage, 'Marking 2026').copies).toEqual([]);
			expect(readHeldCopies(storage, 'Teaching').copies).toHaveLength(1);
			expect(journalledWorkspaces(storage)).toEqual(['Teaching']);
		});

		it('goes when the user discards its Workspace’s journal', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', encode('pending'));
			hold(journal, 'declined', 'a/other.json');

			expect(discardJournal(storage, 'W')).toBe(2);
			expect(readHeldCopies(storage, 'W').copies).toEqual([]);
			expect(readJournal(storage, 'W').entries).toEqual([]);
		});
	});

	describe('what the store held when the entry was made', () => {
		it('takes the bytes a forget said the store had, through later edits and a restart', () => {
			const v1 = fingerprintOf(encode('v1'));
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', encode('v1'));
			journal.forget('a/project.json');

			journal.record('a/project.json', encode('v2'));
			expect(baselineIn(storage)).toBe(v1);
			journal.record('a/project.json', encode('v3'));
			expect(baselineIn(storage)).toBe(v1);
			new WriteAheadJournal(storage, 'W').record('a/project.json', encode('v4'));
			expect(baselineIn(storage)).toBe(v1);
		});

		it('reads an unusable one as no baseline rather than as a damaged entry', () => {
			for (const [dir, held] of [
				['a', ''],
				['b', 17]
			]) {
				storage.items.set(
					`ballastella.journal.W/${dir}%2Fproject.json`,
					JSON.stringify({ formatVersion: 1, at: '', bytes: 'AAA=', held })
				);
			}

			const { entries, problems } = readJournal(storage, 'W');

			expect(problems).toEqual([]);
			expect(entries.map((entry) => entry.held)).toEqual([null, null]);
			expect(entries[0]?.bytes).toEqual(new Uint8Array([0, 0]));
		});

		it('has none at all until a write to that path has succeeded, restarts included', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			for (const text of ['e1', 'e2', 'e3']) journal.record('a/project.json', encode(text));
			expect(baselineIn(storage)).toBeNull();

			new WriteAheadJournal(storage, 'W').record('a/project.json', encode('e4'));
			expect(baselineIn(storage)).toBeNull();
		});

		it('files nothing when the entry it is dropping will not decode', () => {
			storage.items.set(
				KEY,
				JSON.stringify({ formatVersion: 1, at: '', bytes: '!! not base64 !!' })
			);
			const journal = new WriteAheadJournal(storage, 'W');

			journal.forget('a/project.json');
			journal.record('a/project.json', encode('the next edit'));

			expect(baselineIn(storage)).toBeNull();
		});

		it('loses to a fact learned while the read that carries it was in flight', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', encode('v1'));
			const at = journal.mark();
			journal.forget('a/project.json');
			journal.observe('a/project.json', encode('what the read saw, before'), at);

			journal.record('a/project.json', encode('v2'));

			expect(baselineIn(storage)).toBe(fingerprintOf(encode('v1')));
		});

		it('goes when a deletion sweeps the path, rather than outliving it in memory', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', encode('the deleted Project'));
			journal.forget('a/project.json');
			journal.forgetUnder('a/');

			journal.record('a/project.json', encode('the new Project of the same name'));

			expect(baselineIn(storage)).toBeNull();
		});

		it('costs a fingerprint rather than a second copy of the bytes', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			const payload = new Uint8Array(30_000).fill(7) as Bytes;
			journal.record('a/project.json', payload);
			const withoutBaseline = storage.items.get(KEY)?.length ?? 0;
			journal.forget('a/project.json');

			journal.record('a/project.json', payload);

			expect(baselineIn(storage)).not.toBeNull();
			expect((storage.items.get(KEY)?.length ?? 0) - withoutBaseline).toBeLessThan(64);
		});
	});

	describe('when the browser refuses the write', () => {
		it('throws rather than truncating, naming the file as the application does and its size', async () => {
			storage.limit = 10;
			const cause = await rejection(JournalFullError, () =>
				new WriteAheadJournal(storage, 'W').record(
					'amsterdam-1625/annotations/routes.geojson',
					encode('x'.repeat(2048))
				)
			);
			expect([cause.path, cause.size]).toEqual(['amsterdam-1625/annotations/routes.geojson', 2048]);
			for (const part of ['“routes.geojson”', '“amsterdam-1625”', '2 KB']) {
				expect(cause.message).toContain(part);
			}
			expect(cause.message).not.toContain('2048 bytes');
			expect(readJournal(storage, 'W').entries).toEqual([]);
		});

		it('leaves the entry already stored exactly where it is, there being nowhere else for it', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/x.json', encode('the last state that fitted'));
			storage.limit = 60;

			expect(() => journal.record('a/x.json', encode('x'.repeat(500)))).toThrow(JournalFullError);
			expect(journalledTexts(storage)).toEqual(['the last state that fitted']);
		});

		it('does not report a refusal when what is stored is already these exact bytes', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			const bytes = encode('half a keystroke ago');
			journal.record('a/x.json', bytes);
			storage.limit = 1;

			expect(() => journal.record('a/x.json', bytes)).not.toThrow();
			expect(journalledTexts(storage)).toEqual(['half a keystroke ago']);
		});

		it('tells a full quota apart from storage that will not write at all', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			storage.refusal = new DOMException('the operation is insecure', 'SecurityError');

			expect(() => journal.record('a/x.json', encode('x'))).toThrow(JournalUnavailableError);
			expect(() => journal.record('a/x.json', encode('x'))).toThrow(/site data is blocked/);
		});
	});
});

describe('readJournal', () => {
	let storage: FakeStorage;

	beforeEach(() => {
		storage = new FakeStorage();
	});

	it('refuses an entry from a newer version and leaves it exactly where it is', () => {
		storage.items.set(
			KEY,
			JSON.stringify({ formatVersion: JOURNAL_FORMAT_VERSION + 1, at: '', bytes: 'AAA=' })
		);

		expect(readJournal(storage, 'W')).toEqual({
			entries: [],
			problems: [
				{
					key: KEY,
					reason: 'from-a-newer-version',
					kept: true,
					detail: expect.stringContaining('newer version')
				}
			]
		});
		expect(storage.items.has(KEY)).toBe(true);
	});

	it.each([
		['does not parse', 'not json at all'],
		[
			'holds bytes that are not base64',
			JSON.stringify({ formatVersion: 1, at: '', bytes: 'not base64 ***' })
		]
	])('reports an entry that %s, and says it discarded it', (_, held) => {
		storage.items.set(KEY, held);

		expect(readJournal(storage, 'W')).toEqual({
			entries: [],
			problems: [
				{
					key: KEY,
					reason: 'unreadable',
					kept: false,
					detail: expect.stringContaining('a/project.json')
				}
			]
		});
		expect(storage.items.size).toBe(0);
	});

	it('says so when a damaged entry could not even be removed, rather than claiming it went', () => {
		storage.items.set(KEY, '{');
		storage.refuseRemoval = true;

		expect(readJournal(storage, 'W').problems[0]?.kept).toBe(true);
	});

	it('leaves keys this module did not write alone', () => {
		storage.items.set('ballastella.workspace', 'Marking 2026');

		expect(readJournal(storage, 'W')).toEqual({ entries: [], problems: [] });
		expect(storage.items.get('ballastella.workspace')).toBe('Marking 2026');
	});
});

describe('Autosave with a journal (ADR-0017 rule 3)', () => {
	let storage: FakeStorage;
	let store: MemoryProjectStore;
	let autosave: Autosave;
	let refusals: unknown[];

	beforeEach(() => {
		vi.useFakeTimers();
		storage = new FakeStorage();
		store = new MemoryProjectStore();
		refusals = [];
		autosave = new Autosave(store, {
			debounceMs: 400,
			journal: new WriteAheadJournal(storage, 'W'),
			onJournalRefused: (problem) => refusals.push(problem)
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('has the bytes on disk before the debounce, and drops them once the store has them', async () => {
		autosave.queue('a/project.json', encode('renamed'));
		expect(journalledTexts(storage)).toEqual(['renamed']);

		await vi.advanceTimersByTimeAsync(400);

		expect(readJournal(storage, 'W').entries).toEqual([]);
		expect(decode(await store.read('a/project.json'))).toBe('renamed');
	});

	it('keeps the entry when the store rejected, so the bytes are still there to replay', async () => {
		vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));

		await expect(autosave.commit('a/project.json', encode('renamed'))).rejects.toThrow(
			'the disk is full'
		);

		expect(journalledTexts(storage)).toEqual(['renamed']);
	});

	it('keeps the newer bytes when an edit lands while the write is in flight', async () => {
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const real = store.write.bind(store);
		let calls = 0;
		vi.spyOn(store, 'write').mockImplementation(async (path, bytes) => {
			calls += 1;
			if (calls > 1) return new Promise<void>(() => {});
			await held;
			await real(path, bytes);
		});

		void autosave.commit('a/project.json', encode('first'));
		autosave.queue('a/project.json', encode('second'));
		release();
		await vi.advanceTimersByTimeAsync(0);

		expect(calls).toBe(2);
		expect(journalledTexts(storage)).toEqual(['second']);
	});

	it('reports a refusal and its end to the app, and still saves the refused edit', async () => {
		storage.limit = 200;
		autosave.queue('a/x.geojson', encode('x'.repeat(500)));
		expect(refusals).toEqual([expect.any(JournalFullError)]);
		await vi.advanceTimersByTimeAsync(400);
		expect(decode(await store.read('a/x.geojson'))).toBe('x'.repeat(500));

		storage.limit = Number.POSITIVE_INFINITY;
		autosave.queue('a/x.geojson', encode('small'));
		expect(refusals).toEqual([expect.any(JournalFullError), null]);
	});

	it("does not let one file's refusal be cleared by another file's success", () => {
		storage.limit = 400;
		autosave.queue('a/huge.geojson', encode('x'.repeat(500)));
		autosave.queue('a/project.json', encode('tiny'));

		expect(refusals).toEqual([expect.any(JournalFullError)]);
	});

	it('writes nothing at all when no journal was supplied', () => {
		new Autosave(store, { debounceMs: 400 }).queue('a/project.json', encode('renamed'));

		expect(storage.items.size).toBe(0);
	});
});

describe('undoing a Step across a save (ADR-0039)', () => {
	it('leaves the journal holding what was put back, never the deletion', async () => {
		const storage = new FakeStorage();
		const store = new MemoryProjectStore();
		const autosave = new Autosave(store, {
			debounceMs: 10_000,
			journal: new WriteAheadJournal(storage, 'W')
		});
		const path = 'a/annotations/l.geojson';
		const held = '{"features":[ANNOTATION]}';
		await store.write(path, encode(held));

		const history = new EditHistory({
			flush: () => autosave.flush(),
			read: (at) => store.read(at).catch(() => null),
			writeBack: (at, bytes) => (bytes === null ? store.delete(at) : autosave.commit(at, bytes))
		});

		await history.step('Undo delete of this Annotation', [path], () =>
			autosave.commit(path, encode('{"features":[]}'))
		);
		expect(decode(await store.read(path))).toBe('{"features":[]}');

		vi.spyOn(store, 'write').mockImplementation(() => new Promise<void>(() => {}));

		void history.undo();

		await vi.waitFor(() => expect(journalledTexts(storage)).toEqual([held]));
	});
});

describe('installFlushOnHide', () => {
	class FakeTarget {
		readonly listeners = new Map<string, EventListener>();
		addEventListener(type: string, listener: EventListener) {
			this.listeners.set(type, listener);
		}
		removeEventListener(type: string) {
			this.listeners.delete(type);
		}
		fire(type: string) {
			this.listeners.get(type)?.(new Event(type));
		}
	}

	const setup = ({ stalled = false } = {}) => {
		const storage = new FakeStorage();
		const store = new MemoryProjectStore();
		if (stalled) vi.spyOn(store, 'write').mockImplementation(() => new Promise<void>(() => {}));
		const autosave = new Autosave(store, {
			debounceMs: 10_000,
			journal: new WriteAheadJournal(storage, 'W')
		});
		const doc = new FakeTarget() as FakeTarget & { visibilityState: DocumentVisibilityState };
		doc.visibilityState = 'visible';
		const win = new FakeTarget();
		const uninstall = installFlushOnHide(autosave, {
			document: doc as unknown as Document,
			window: win as unknown as Window
		});
		return { storage, store, autosave, doc, win, uninstall };
	};

	const hides: [string, (page: ReturnType<typeof setup>) => void][] = [
		['pagehide', ({ win }) => win.fire('pagehide')],
		[
			'the page becoming hidden',
			({ doc }) => {
				doc.visibilityState = 'hidden';
				doc.fire('visibilitychange');
			}
		]
	];

	it.each(hides)('flushes on %s', async (_, hide) => {
		const page = setup();
		page.autosave.queue('p/project.json', encode('a'));

		hide(page);
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(await page.store.list('')).toEqual(['p/project.json']);
	});

	it.each(hides)('keeps a pending edit on %s though the store write never completes', (_, hide) => {
		const page = setup({ stalled: true });
		page.autosave.queue('a/project.json', encode('half a keystroke ago'));

		hide(page);

		expect(journalledTexts(page.storage)).toEqual(['half a keystroke ago']);
	});

	it('does not flush when the page merely becomes visible again', async () => {
		const { store, autosave, doc } = setup();
		autosave.queue('p/project.json', encode('a'));

		doc.fire('visibilitychange');

		expect(await store.list('')).toEqual([]);
	});

	it('never listens for beforeunload, which mobile browsers ignore, and removes its listeners', () => {
		const { doc, win, uninstall } = setup();
		const listening = () => [...doc.listeners.keys(), ...win.listeners.keys()];

		expect(listening()).toEqual(['visibilitychange', 'pagehide']);
		uninstall();
		expect(listening()).toEqual([]);
	});

	it('records on pagehide what the edit itself could not fit', () => {
		const { storage, autosave, win } = setup({ stalled: true });
		storage.limit = 30;
		autosave.queue('a/project.json', encode('x'.repeat(400)));
		expect(readJournal(storage, 'W').entries).toEqual([]);

		storage.limit = Number.POSITIVE_INFINITY;
		win.fire('pagehide');

		expect(journalledTexts(storage)).toEqual(['x'.repeat(400)]);
	});
});
