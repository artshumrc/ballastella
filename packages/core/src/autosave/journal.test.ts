import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Annotation } from '../annotation/annotation.js';
import { UndoSlot } from '../undo/undo.js';
import { Autosave } from './autosave.js';
import { installFlushOnHide } from './flush-on-hide.js';
import {
	JOURNAL_FORMAT_VERSION,
	JournalFullError,
	JournalUnavailableError,
	WriteAheadJournal,
	discardJournal,
	journalledWorkspaces,
	readJournal,
	type JournalStorage
} from './journal.js';

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The Annotation an undo record carries. Its contents are irrelevant here; its presence is not. */
const ANNOTATION = {
	type: 'Feature',
	id: 'a1',
	geometry: { type: 'Point', coordinates: [0, 0] },
	properties: {}
} as unknown as Annotation;

/**
 * A `localStorage` that can be made to refuse, and whose contents are inspectable.
 *
 * A fake rather than the real thing because the branch that matters most here — the quota refusal —
 * cannot be provoked in any browser on demand, and a test that cannot reach it is a test that would
 * stay green with the refusal handling deleted.
 */
class FakeStorage implements JournalStorage {
	readonly items = new Map<string, string>();
	/** Bytes above which `setItem` throws, as a browser's quota does. */
	limit = Number.POSITIVE_INFINITY;
	/** Set to make even a removal fail, which a wedged storage really does. */
	refuseRemoval = false;
	/** Thrown from every `setItem`, whatever its size — Safari with site data blocked. */
	refusal: unknown = null;

	get length(): number {
		return this.items.size;
	}
	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null;
	}
	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}
	setItem(key: string, value: string): void {
		if (this.refusal !== null) throw this.refusal;
		const others = [...this.items].reduce(
			(total, [at, held]) => total + (at === key ? 0 : at.length + held.length),
			0
		);
		if (others + key.length + value.length > this.limit) {
			throw new DOMException('exceeded the quota', 'QuotaExceededError');
		}
		this.items.set(key, value);
	}
	removeItem(key: string): void {
		if (this.refuseRemoval) throw new DOMException('cannot remove', 'InvalidStateError');
		this.items.delete(key);
	}
}

describe('WriteAheadJournal', () => {
	let storage: FakeStorage;

	beforeEach(() => {
		storage = new FakeStorage();
	});

	it('holds bytes under a key naming the Workspace as well as the path', () => {
		new WriteAheadJournal(storage, 'Marking 2026').record('a/project.json', utf8.encode('one'));

		const { entries } = readJournal(storage, 'Marking 2026');
		expect(entries).toEqual([
			{
				workspace: 'Marking 2026',
				path: 'a/project.json',
				bytes: utf8.encode('one'),
				at: expect.any(String),
				// No baseline: nothing has told this journal what the store holds for the path, which is
				// what the first edit to it in a session looks like (ticket 07).
				held: null
			}
		]);
	});

	it('keeps two Workspaces apart, even when their names differ only by a separator', () => {
		// The specimen the encoding exists for: raw concatenation would make these one key.
		new WriteAheadJournal(storage, 'a/b').record('c.json', utf8.encode('left'));
		new WriteAheadJournal(storage, 'a').record('b/c.json', utf8.encode('right'));

		expect(readJournal(storage, 'a/b').entries.map((entry) => text(entry.bytes))).toEqual(['left']);
		expect(readJournal(storage, 'a').entries.map((entry) => text(entry.bytes))).toEqual(['right']);
	});

	it('carries a Workspace name in a non-Latin script through unchanged', () => {
		new WriteAheadJournal(storage, 'Карта 1625 (2)').record('a/project.json', utf8.encode('x'));

		expect(journalledWorkspaces(storage)).toEqual(['Карта 1625 (2)']);
		expect(readJournal(storage, 'Карта 1625 (2)').entries).toHaveLength(1);
	});

	it('round-trips bytes that are not text, at a size that needs chunked encoding', () => {
		const bytes = new Uint8Array(200_000);
		for (let at = 0; at < bytes.length; at += 1) bytes[at] = (at * 7) % 256;

		new WriteAheadJournal(storage, 'W').record('a/big.bin', bytes as Uint8Array<ArrayBuffer>);

		expect(readJournal(storage, 'W').entries[0]?.bytes).toEqual(bytes);
	});

	it('forgets one path and leaves the others', () => {
		const journal = new WriteAheadJournal(storage, 'W');
		journal.record('a/project.json', utf8.encode('one'));
		journal.record('b/project.json', utf8.encode('two'));

		journal.forget('a/project.json');

		expect(readJournal(storage, 'W').entries.map((entry) => entry.path)).toEqual([
			'b/project.json'
		]);
	});

	/**
	 * The baseline an entry is recorded against (ticket 07).
	 *
	 * It is what lets `replayJournal` tell a stranded write from a revert, and it is derived here
	 * rather than read from the store, because `record` is synchronous by contract. The four tests
	 * are the four things that derivation has to get right; `replay.test.ts` drives what it is for.
	 */
	describe('what the store held when the entry was made', () => {
		it('takes the bytes a forget said the store had', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('v1'));
			// The store took them, which is the one thing `forget` means.
			journal.forget('a/project.json');

			journal.record('a/project.json', utf8.encode('v2'));

			expect(readJournal(storage, 'W').entries[0]?.held).toEqual(utf8.encode('v1'));
		});

		it('does not move it to bytes the store has not taken', () => {
			// Two edits inside one debounce window: the store still holds what it held before either
			// of them, so the baseline must be neither of their bytes.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('v1'));
			journal.forget('a/project.json');

			journal.record('a/project.json', utf8.encode('v2'));
			journal.record('a/project.json', utf8.encode('v3'));

			expect(readJournal(storage, 'W').entries[0]?.held).toEqual(utf8.encode('v1'));
		});

		it('survives a restart, because it is carried by the entry rather than by the object', () => {
			const before = new WriteAheadJournal(storage, 'W');
			before.record('a/project.json', utf8.encode('v1'));
			before.forget('a/project.json');
			before.record('a/project.json', utf8.encode('v2'));

			// A new session, with nothing in memory: the entry that is already there is the source.
			new WriteAheadJournal(storage, 'W').record('a/project.json', utf8.encode('v3'));

			expect(readJournal(storage, 'W').entries[0]?.held).toEqual(utf8.encode('v1'));
		});

		it('reads an undecodable one as no baseline rather than as a damaged entry', () => {
			// The entry's own bytes are intact, and refusing it over its baseline would cost the user
			// an edit to save a check. `replay.ts` then behaves as it did before the field existed.
			storage.items.set(
				'ballastella.journal.W/a%2Fproject.json',
				JSON.stringify({ formatVersion: 1, at: '', bytes: 'AAA=', held: '!! not base64 !!' })
			);

			const { entries, problems } = readJournal(storage, 'W');

			expect(problems).toEqual([]);
			expect(entries[0]?.held).toBeNull();
			expect(entries[0]?.bytes).toEqual(new Uint8Array([0, 0]));
		});
	});

	it('forgets everything under a prefix, which is what a deletion needs', () => {
		const journal = new WriteAheadJournal(storage, 'W');
		journal.record('a/project.json', utf8.encode('one'));
		journal.record('a/annotations/l.geojson', utf8.encode('two'));
		journal.record('b/project.json', utf8.encode('three'));

		expect(journal.forgetUnder('a/')).toBe(2);
		expect(readJournal(storage, 'W').entries.map((entry) => entry.path)).toEqual([
			'b/project.json'
		]);
	});

	it('discards one Workspace and no other', () => {
		new WriteAheadJournal(storage, 'W').record('a/project.json', utf8.encode('one'));
		new WriteAheadJournal(storage, 'X').record('a/project.json', utf8.encode('two'));

		expect(discardJournal(storage, 'W')).toBe(1);
		expect(journalledWorkspaces(storage)).toEqual(['X']);
	});

	describe('when the browser refuses the write', () => {
		it('throws, naming the file and its size, rather than truncating', () => {
			storage.limit = 40;

			expect(() =>
				new WriteAheadJournal(storage, 'W').record('a/x.json', utf8.encode('x'.repeat(500)))
			).toThrow(JournalFullError);
			expect(readJournal(storage, 'W').entries).toEqual([]);
		});

		it('leaves the entry already stored exactly where it is', () => {
			// ⚠ An earlier draft removed it, arguing an older entry is worse than none. Review found
			// that false in the two cases below, and the entry only exists at all because the store has
			// not taken those bytes — so keeping it can only move the file toward a state the user
			// reached.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/x.json', utf8.encode('the last state that fitted'));
			storage.limit = 60;

			expect(() => journal.record('a/x.json', utf8.encode('x'.repeat(500)))).toThrow(
				JournalFullError
			);

			expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
				'the last state that fitted'
			]);
		});

		it('does not report a refusal when what is stored is already these exact bytes', () => {
			// The `capture()` case, and the one that made the old policy destructive: `pagehide`
			// re-records bytes that have not changed, and if the quota filled in between, the old
			// policy threw *and deleted a complete, valid rescue copy* at the moment it was needed.
			const journal = new WriteAheadJournal(storage, 'W');
			const bytes = utf8.encode('half a keystroke ago');
			journal.record('a/x.json', bytes);
			storage.limit = 1;

			expect(() => journal.record('a/x.json', bytes)).not.toThrow();
			expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
				'half a keystroke ago'
			]);
		});

		it('keeps the entry of a write that failed, which is when there is nowhere else for it', () => {
			// The second false assumption in the old policy: it reasoned that the store write would
			// still happen. An entry is only still here *because* the store has not taken those bytes.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/x.json', utf8.encode('the edit the disk refused'));
			storage.limit = 60;

			expect(() => journal.record('a/x.json', utf8.encode('y'.repeat(400)))).toThrow();

			expect(readJournal(storage, 'W').entries).toHaveLength(1);
		});

		it('tells a full quota apart from storage that will not write at all', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			// Safari with cookies blocked: the read-only probe passes, every write is refused, and the
			// remedy is a browser setting rather than clearing other sites' data.
			storage.refusal = new DOMException('the operation is insecure', 'SecurityError');

			expect(() => journal.record('a/x.json', utf8.encode('x'))).toThrow(JournalUnavailableError);
			expect(() => journal.record('a/x.json', utf8.encode('x'))).toThrow(/site data is blocked/);
		});

		it('names the file the way the application names it, not as a store path', () => {
			storage.limit = 10;
			try {
				new WriteAheadJournal(storage, 'W').record(
					'amsterdam-1625/annotations/routes.geojson',
					utf8.encode('x'.repeat(2048))
				);
				expect.unreachable('record should have thrown');
			} catch (cause) {
				expect(cause).toBeInstanceOf(JournalFullError);
				expect((cause as JournalFullError).path).toBe('amsterdam-1625/annotations/routes.geojson');
				expect((cause as JournalFullError).size).toBe(2048);
				// ADR-0017 asks the refusal to name the file and its size. A raw `StorePath` and a raw
				// byte count satisfy that literally and read as a stack trace.
				expect((cause as JournalFullError).message).toContain('“routes.geojson”');
				expect((cause as JournalFullError).message).toContain('“amsterdam-1625”');
				expect((cause as JournalFullError).message).toContain('2 KB');
				expect((cause as JournalFullError).message).not.toContain('2048 bytes');
			}
		});
	});
});

describe('readJournal', () => {
	let storage: FakeStorage;

	beforeEach(() => {
		storage = new FakeStorage();
	});

	it('refuses an entry from a newer version and leaves it exactly where it is (story 114)', () => {
		storage.items.set(
			'ballastella.journal.W/a%2Fproject.json',
			JSON.stringify({ formatVersion: JOURNAL_FORMAT_VERSION + 1, at: '', bytes: 'AAA=' })
		);

		const { entries, problems } = readJournal(storage, 'W');

		expect(entries).toEqual([]);
		expect(problems).toEqual([
			{
				key: 'ballastella.journal.W/a%2Fproject.json',
				reason: 'from-a-newer-version',
				kept: true,
				detail: expect.stringContaining('newer version')
			}
		]);
		// Left alone, not discarded: the build that wrote it can still recover it.
		expect(storage.items.has('ballastella.journal.W/a%2Fproject.json')).toBe(true);
	});

	it('reports an entry that does not parse, and says it discarded it', () => {
		storage.items.set('ballastella.journal.W/a%2Fproject.json', 'not json at all');

		const { entries, problems } = readJournal(storage, 'W');

		expect(entries).toEqual([]);
		expect(problems).toEqual([
			{
				key: 'ballastella.journal.W/a%2Fproject.json',
				reason: 'unreadable',
				kept: false,
				detail: expect.stringContaining('a/project.json')
			}
		]);
		expect(storage.items.size).toBe(0);
	});

	it('reports an entry whose bytes are not base64', () => {
		storage.items.set(
			'ballastella.journal.W/a%2Fproject.json',
			JSON.stringify({ formatVersion: 1, at: '', bytes: 'not base64 ***' })
		);

		expect(readJournal(storage, 'W').problems.map((problem) => problem.reason)).toEqual([
			'unreadable'
		]);
	});

	it('says so when a damaged entry could not even be removed, rather than claiming it went', () => {
		storage.items.set('ballastella.journal.W/a%2Fproject.json', '{');
		storage.refuseRemoval = true;

		expect(readJournal(storage, 'W').problems[0]?.kept).toBe(true);
	});

	it('leaves keys this module did not write alone', () => {
		storage.items.set('ballastella.workspace', 'Marking 2026');

		expect(readJournal(storage, 'W')).toEqual({ entries: [], problems: [] });
		expect(storage.items.get('ballastella.workspace')).toBe('Marking 2026');
	});
});

describe('Autosave with a journal (ADR-0017 rule 3, as amended by ticket 20)', () => {
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

	it('has the bytes on disk before the debounce has run at all', () => {
		autosave.queue('a/project.json', utf8.encode('renamed'));

		// No timer advanced, nothing awaited: this is the synchronous guarantee, and it is the only
		// thing an unloading document will finish.
		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
			'renamed'
		]);
	});

	it('drops the entry once the store has the bytes', async () => {
		autosave.queue('a/project.json', utf8.encode('renamed'));
		await vi.advanceTimersByTimeAsync(400);

		expect(readJournal(storage, 'W').entries).toEqual([]);
		expect(text(await store.read('a/project.json'))).toBe('renamed');
	});

	it('keeps the entry when the store rejected, so the bytes are still there to replay', async () => {
		vi.spyOn(store, 'write').mockRejectedValue(new Error('the disk is full'));

		await expect(autosave.commit('a/project.json', utf8.encode('renamed'))).rejects.toThrow(
			'the disk is full'
		);

		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
			'renamed'
		]);
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
			if (calls > 1) {
				// The second write never settles, so the assertion below can only be satisfied by the
				// journal still holding `second` — not by the drain loop having got round to writing it.
				await new Promise<void>(() => {});
				return;
			}
			await held;
			await real(path, bytes);
		});

		// Deliberately not awaited: the drain loop cannot finish, which is the state under test.
		void autosave.commit('a/project.json', utf8.encode('first'));
		autosave.queue('a/project.json', utf8.encode('second'));
		release();
		await vi.advanceTimersByTimeAsync(0);

		// The write that completed carried `first`; `second` is the newer edit, recorded before that
		// completion, and it must survive the `forget` the completion performs.
		expect(calls).toBe(2);
		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual(['second']);
	});

	it('reports a refusal to the app, and its end, so the user can be told', () => {
		storage.limit = 200;
		autosave.queue('a/x.geojson', utf8.encode('x'.repeat(500)));
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toBeInstanceOf(JournalFullError);

		storage.limit = Number.POSITIVE_INFINITY;
		autosave.queue('a/x.geojson', utf8.encode('small'));
		expect(refusals).toEqual([expect.any(JournalFullError), null]);
	});

	it("does not let one file's refusal be cleared by another file's success", () => {
		storage.limit = 400;
		autosave.queue('a/huge.geojson', utf8.encode('x'.repeat(500)));
		expect(refusals).toHaveLength(1);

		autosave.queue('a/project.json', utf8.encode('tiny'));

		// Still refused: the huge file is still unprotected, and a "you are covered" message here is
		// the lie ADR-0017 rule 5 exists to prevent.
		expect(refusals).toHaveLength(1);
	});

	it('still saves the edit when the journal refused it — a lost guarantee is not a lost edit', async () => {
		storage.limit = 200;
		autosave.queue('a/project.json', utf8.encode('x'.repeat(500)));
		await vi.advanceTimersByTimeAsync(400);

		expect(text(await store.read('a/project.json'))).toBe('x'.repeat(500));
	});

	it('writes nothing at all when no journal was supplied', () => {
		const unprotected = new Autosave(store, { debounceMs: 400 });
		unprotected.queue('a/project.json', utf8.encode('renamed'));

		expect(storage.items.size).toBe(0);
	});
});

/**
 * ⚠ **What this describe proves, and what it does not.**
 *
 * The first two tests prove the *outcome*: a pending edit is on disk when the page goes away, even
 * though the store write can never complete. They do **not** prove that `Autosave.capture` is what
 * put it there — `queue` already journalled it, so both stay green with the `capture()` call in
 * `installFlushOnHide` deleted. Verified by deleting it; that is why this note exists rather than a
 * claim that the listener was tested.
 *
 * The third test is the one that pins `capture` down, by making the queue-time record fail and the
 * capture-time one succeed. It is red with that call removed.
 */
/**
 * ADR-0014's single-level undo, against the journal (ticket 20 constraint 5).
 *
 * ⚠ **This is the test the e2e version was mistaken for.** `editor-workspace.e2e.ts` types a name
 * and types it back, which is a re-edit and not `UndoSlot` at all — review caught that, and it left
 * the actual claim ("a replayed journal entry cannot resurrect an edit the user undid before
 * leaving") resting on a reading of the code rather than on anything red.
 *
 * The mechanism is exercised for real here: a genuine `UndoSlot` holding a genuine restore closure
 * that goes through the same `Autosave`, against a store whose writes **never settle** — which is
 * the only state in which the journal is what carries the file, and therefore the only state in
 * which the question has an answer.
 */
describe('single-level undo across a save (ADR-0014)', () => {
	it('leaves the journal holding what was restored, never the deletion', async () => {
		const storage = new FakeStorage();
		const store = new MemoryProjectStore();
		// Nothing lands, so whatever is in the journal is what a reload would put back.
		vi.spyOn(store, 'write').mockImplementation(() => new Promise<void>(() => {}));
		const autosave = new Autosave(store, {
			debounceMs: 10_000,
			journal: new WriteAheadJournal(storage, 'W')
		});
		const path = 'a/annotations/l.geojson';
		const undo = new UndoSlot();

		// The deletion, exactly as the editor performs it: write the collection without the
		// Annotation, and offer the way back.
		void autosave.commit(path, utf8.encode('{"features":[]}'));
		undo.offer({ kind: 'annotation-deleted', layerId: 'l', at: 0, annotation: ANNOTATION }, () =>
			autosave.commit(path, utf8.encode('{"features":[ANNOTATION]}'))
		);
		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
			'{"features":[]}'
		]);

		// Not awaited: the restore's own store write never settles either, which is the point.
		void undo.take()?.();
		await Promise.resolve();

		// The journal holds one entry per path and the last write wins, in it exactly as in the store.
		// Were it otherwise, a scholar who deleted an Annotation, took it back, and closed the tab
		// would find it deleted again at the next startup.
		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
			'{"features":[ANNOTATION]}'
		]);
	});
});

describe('installFlushOnHide captures synchronously (ticket 20)', () => {
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

	/**
	 * A store whose writes **never settle**, which is what an unloading document sees.
	 *
	 * This is the whole point of the test. `flush` is not slow in a real browser — it was measured at
	 * 32 ms — but the continuation after `await store.write(…)` does not run once the document is
	 * going away, and a promise that never resolves is the only faithful way to say that in Node.
	 * With it, an assertion that the bytes survived can only be satisfied by something synchronous.
	 */
	const setup = () => {
		const storage = new FakeStorage();
		const store = new MemoryProjectStore();
		vi.spyOn(store, 'write').mockImplementation(() => new Promise<void>(() => {}));
		const autosave = new Autosave(store, {
			debounceMs: 10_000,
			journal: new WriteAheadJournal(storage, 'W')
		});
		const doc = new FakeTarget() as FakeTarget & { visibilityState: DocumentVisibilityState };
		doc.visibilityState = 'visible';
		const win = new FakeTarget();
		installFlushOnHide(autosave, {
			document: doc as unknown as Document,
			window: win as unknown as Window
		});
		return { storage, autosave, doc, win };
	};

	it('keeps a pending edit on pagehide even though the store write never completes', () => {
		const { storage, autosave, win } = setup();
		autosave.queue('a/project.json', utf8.encode('half a keystroke ago'));

		win.fire('pagehide');

		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
			'half a keystroke ago'
		]);
	});

	it('does the same when the page merely becomes hidden', () => {
		const { storage, autosave, doc } = setup();
		autosave.queue('a/project.json', utf8.encode('a'));

		doc.visibilityState = 'hidden';
		doc.fire('visibilitychange');

		expect(readJournal(storage, 'W').entries).toHaveLength(1);
	});

	it('records on pagehide what the edit itself could not fit', () => {
		// The case that is `capture`'s alone. The quota was full when the edit was made and has room
		// by the time the page goes away — another tab closing, a site's data cleared. Without the
		// synchronous `capture()` in the listener, this edit is simply gone.
		const { storage, autosave, win } = setup();
		storage.limit = 30;
		autosave.queue('a/project.json', utf8.encode('x'.repeat(400)));
		expect(readJournal(storage, 'W').entries).toEqual([]);

		storage.limit = Number.POSITIVE_INFINITY;
		win.fire('pagehide');

		expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
			'x'.repeat(400)
		]);
	});
});
