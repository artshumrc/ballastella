import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryProjectStore } from '../store/memory-project-store.js';
import type { Bytes } from '../store/project-store.js';
import { EditHistory } from '../undo/edit-history.js';
import { Autosave } from './autosave.js';
import { installFlushOnHide } from './flush-on-hide.js';
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

const utf8 = new TextEncoder();
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

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
	 * rather than read from the store, because `record` is synchronous by contract. These pin what the
	 * derivation must get right and what it costs; `replay.test.ts` drives what it is for.
	 */
	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE FINGERPRINT ITSELF (round 5, finding D)
	 *
	 * ⚠ **Every other reference to it in this repository compares it against itself** —
	 * `expect(held).toBe(fingerprintOf(x))` — which is satisfied by any pure function, including one
	 * that ignores its input. `replay.ts` decides whether to write a scholar's file on an equality
	 * between two of these, so the properties the docblock claims are the guarantee, and they are
	 * driven here against literals rather than against the function.
	 */
	describe('fingerprintOf', () => {
		const of = (text: string) => fingerprintOf(utf8.encode(text) as Bytes);

		it('is stable for the same bytes and differs for different ones', () => {
			expect(of('the edit that stranded')).toBe(of('the edit that stranded'));
			expect(of('v1')).not.toBe(of('v2'));
		});

		it('separates a string from one it is a prefix of, by length as well as by hash', () => {
			// The length is in front for this: the cheapest disagreement to detect is a file that grew,
			// and a hash whose rounds happened to agree would otherwise let it through.
			expect(of('v1-long')).not.toBe(of('v1-long-baseline'));
			expect(of('v1-long').split('-')[0]).not.toBe(of('v1-long-baseline').split('-')[0]);
		});

		it('runs two rounds from different bases rather than one twice', () => {
			// A second round identical to the first is 32 bits pretending to be 64. Read off the shape
			// rather than the value: the two halves of the hash must not be the same eight hex digits.
			const [, hash = ''] = of('a scholar’s Annotations').split('-');
			expect(hash).toHaveLength(16);
			expect(hash.slice(0, 8)).not.toBe(hash.slice(8));
		});

		it('is a short constant beside the payload, not a copy of it', () => {
			// Why it is a fingerprint at all. It grows with the *digits* of the length and nothing else.
			expect(of('').length).toBe(18);
			expect(fingerprintOf(new Uint8Array(30_000) as Bytes).length).toBe(20);
			expect(fingerprintOf(new Uint8Array(5_000_000) as Bytes).length).toBe(22);
		});
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE HELD NAMESPACE'S LIFECYCLE (round 6)
	 *
	 * The store of copies a replay declined. Five pieces of it shipped with no named kill, which is
	 * how a namespace that nothing prunes and nothing reports becomes a leak nobody can see.
	 */
	describe('copies a replay declined', () => {
		const HELD = 'ballastella.held.';
		const heldKeys = () => [...storage.items.keys()].filter((key) => key.startsWith(HELD));

		it('says nothing was set aside when the browser has no room for it', () => {
			// ⚠ **The refusal that reported success** (round 6, finding A). `hold` answered with the same
			// fingerprint whether it stored anything or not, so a full origin produced "It has been
			// kept" beside a button to throw away a copy that did not exist.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('the edit that stranded'));
			vi.spyOn(storage, 'setItem').mockImplementation(() => {
				throw new DOMException('full', 'QuotaExceededError');
			});

			const copy = journal.hold('a/project.json', utf8.encode('the edit that stranded'), '', 'x');

			expect(copy).toBeNull();
			expect(heldKeys()).toEqual([]);
			// And the entry it failed to protect is exactly where it was: a refusal must never be the
			// thing that destroys the bytes it could not keep.
			vi.restoreAllMocks();
			expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([
				'the edit that stranded'
			]);
		});

		it('refuses past the cap rather than taking more room, and does not discard what it holds', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			const held = ['one', 'two', 'three'].map((text) =>
				journal.hold('a/project.json', utf8.encode(text), '', 'x')
			);

			const beyond = journal.hold('a/project.json', utf8.encode('four'), '', 'x');

			expect(held.every((copy) => copy !== null)).toBe(true);
			expect(beyond).toBeNull();
			// Nothing already held was dropped to make room for it.
			expect(
				readHeldCopies(storage, 'W')
					.copies.map((copy) => text(copy.bytes))
					.sort()
			).toEqual(['one', 'three', 'two']);
		});

		it('does not count re-holding a copy it already has against the cap', () => {
			// The ordinary case of a startup meeting a decline it has already made.
			const journal = new WriteAheadJournal(storage, 'W');
			for (const text of ['one', 'two', 'three']) {
				journal.hold('a/project.json', utf8.encode(text), '', 'x');
			}

			expect(journal.hold('a/project.json', utf8.encode('two'), '', 'x')).not.toBeNull();
		});

		it('reports a damaged copy and discards it, rather than leaving it holding room', () => {
			// Unlike an entry, a copy nobody can read still counts against the cap and still occupies
			// the quota, so swallowing it spent room on bytes nobody could ever recover.
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
			// ⚠ The kill the headline of the last round did not have: a wrong identity must destroy
			// nothing, which no test using a *correct* fingerprint can discriminate against.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.hold('a/project.json', utf8.encode('the edit that stranded'), '', 'x');

			expect(forgetHeldCopy(storage, 'W', 'a/project.json', 'not-its-fingerprint')).toBe(false);

			expect(readHeldCopies(storage, 'W').copies).toHaveLength(1);
		});

		it("is never read out of another Workspace's", () => {
			// The same binding the class has, on the free function that ranges over the prefix.
			new WriteAheadJournal(storage, 'Teaching').hold(
				'a/project.json',
				utf8.encode('typed in Teaching'),
				'',
				'x'
			);

			expect(readHeldCopies(storage, 'Marking 2026').copies).toEqual([]);
			expect(readHeldCopies(storage, 'Teaching').copies).toHaveLength(1);
		});

		it('makes its Workspace findable, so its room can be reclaimed', () => {
			// A Workspace nobody reopens can hold nothing *but* these, and one missing from this list is
			// one the user is never offered a way to reclaim.
			new WriteAheadJournal(storage, 'Abandoned').hold('a/x.json', utf8.encode('x'), '', 'x');

			expect(journalledWorkspaces(storage)).toEqual(['Abandoned']);
		});

		it('goes when the user discards its Workspace’s journal', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('pending'));
			journal.hold('a/other.json', utf8.encode('declined'), '', 'x');

			expect(discardJournal(storage, 'W')).toBe(2);

			expect(readHeldCopies(storage, 'W').copies).toEqual([]);
			expect(readJournal(storage, 'W').entries).toEqual([]);
		});
	});

	describe('what the store held when the entry was made', () => {
		it('takes the bytes a forget said the store had', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('v1'));
			// The store took them, which is the one thing `forget` means.
			journal.forget('a/project.json');

			journal.record('a/project.json', utf8.encode('v2'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBe(fingerprintOf(utf8.encode('v1')));
		});

		it('does not move it to bytes the store has not taken', () => {
			// Two edits inside one debounce window: the store still holds what it held before either
			// of them, so the baseline must be neither of their bytes.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('v1'));
			journal.forget('a/project.json');

			journal.record('a/project.json', utf8.encode('v2'));
			journal.record('a/project.json', utf8.encode('v3'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBe(fingerprintOf(utf8.encode('v1')));
		});

		it('survives a restart, because it is carried by the entry rather than by the object', () => {
			const before = new WriteAheadJournal(storage, 'W');
			before.record('a/project.json', utf8.encode('v1'));
			before.forget('a/project.json');
			before.record('a/project.json', utf8.encode('v2'));

			// A new session, with nothing in memory: the entry that is already there is the source.
			new WriteAheadJournal(storage, 'W').record('a/project.json', utf8.encode('v3'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBe(fingerprintOf(utf8.encode('v1')));
		});

		it('reads an unusable one as no baseline rather than as a damaged entry', () => {
			// The entry's own bytes are intact, and refusing it over its baseline would cost the user
			// an edit to save a check. `replay.ts` then behaves as it did before the field existed.
			storage.items.set(
				'ballastella.journal.W/a%2Fproject.json',
				JSON.stringify({ formatVersion: 1, at: '', bytes: 'AAA=', held: '' })
			);
			storage.items.set(
				'ballastella.journal.W/b%2Fproject.json',
				JSON.stringify({ formatVersion: 1, at: '', bytes: 'AAA=', held: 17 })
			);

			const { entries, problems } = readJournal(storage, 'W');

			expect(problems).toEqual([]);
			expect(entries.map((entry) => entry.held)).toEqual([null, null]);
			expect(entries[0]?.bytes).toEqual(new Uint8Array([0, 0]));
		});

		/**
		 * ⚠ **The scope of "no baseline", pinned, because prose about it was wrong twice.**
		 *
		 * It is not "the first edit to a path". `forget` is the only writer of a baseline and
		 * `Autosave` calls it only after a store write has **succeeded**, so a path whose writes are
		 * failing — the case the journal exists for — never gets one, however many edits are made and
		 * however many times the tab is reopened.
		 */
		it('has none at all until a write to that path has succeeded, restarts included', () => {
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('e1'));
			journal.record('a/project.json', utf8.encode('e2'));
			journal.record('a/project.json', utf8.encode('e3'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBeNull();

			// A new tab, meeting the entry the last one left behind.
			new WriteAheadJournal(storage, 'W').record('a/project.json', utf8.encode('e4'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBeNull();
		});

		it('files nothing when the entry it is dropping will not decode', () => {
			// ⚠ A payload that cannot be read says nothing about what the store holds. Filing a
			// fingerprint of zero bytes would assert that the store holds an empty file — a fact nobody
			// established — and `replay.ts` would then refuse the next stranded edit against it.
			storage.items.set(
				'ballastella.journal.W/a%2Fproject.json',
				JSON.stringify({ formatVersion: 1, at: '', bytes: '!! not base64 !!' })
			);
			const journal = new WriteAheadJournal(storage, 'W');

			journal.forget('a/project.json');
			journal.record('a/project.json', utf8.encode('the next edit'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBeNull();
		});

		it('loses to a fact learned while the read that carries it was in flight', () => {
			// ⚠ **The race three docblocks claimed did not exist** (round 5, finding C). `observe` is fed
			// by reads already in flight when a save lands — `readLayerFeatures` and `readAnnotations`
			// name the same file, so a redraw overlapping a debounced `writeAnnotations` is the ordinary
			// shape. Without the token the stale read filed the *previous* content as the baseline, and
			// the next stranded edit was refused with "that file has been changed since": false, and in
			// exactly the case the journal exists for.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('v1'));
			const at = journal.mark(); // a read begins
			journal.forget('a/project.json'); // the store takes v1 while it is in flight
			journal.observe('a/project.json', utf8.encode('what the read saw, before'), at);

			journal.record('a/project.json', utf8.encode('v2'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBe(fingerprintOf(utf8.encode('v1')));
		});

		it('goes when a deletion sweeps the path, rather than outliving it in memory', () => {
			// ⚠ The memo is consulted *before* the stored entry, so `forgetUnder` removing the entry and
			// leaving the memo would make the memo the only surviving source — describing a Project the
			// user has just deleted. `project.json` is a fixed path, so a new Project of the same folder
			// name lands on it and would have its first rescue refused.
			const journal = new WriteAheadJournal(storage, 'W');
			journal.record('a/project.json', utf8.encode('the deleted Project'));
			journal.forget('a/project.json');
			journal.forgetUnder('a/');

			journal.record('a/project.json', utf8.encode('the new Project of the same name'));

			expect(readJournal(storage, 'W').entries[0]?.held).toBeNull();
		});

		it('costs a fingerprint rather than a second copy of the bytes', () => {
			// ⚠ An earlier draft stored the base64 of the store's content, which doubled every entry's
			// `localStorage` footprint — and ADR-0017 already says an Annotation collection can exceed
			// the origin budget on its own, where a refusal is a user-visible loss of protection. The
			// envelope must grow by a constant, not by the payload.
			const journal = new WriteAheadJournal(storage, 'W');
			const payload = new Uint8Array(30_000).fill(7) as Bytes;
			journal.record('a/project.json', payload);
			const withoutBaseline = storage.items.get('ballastella.journal.W/a%2Fproject.json')?.length;
			journal.forget('a/project.json');

			journal.record('a/project.json', payload);

			const withBaseline = storage.items.get('ballastella.journal.W/a%2Fproject.json')?.length;
			expect(readJournal(storage, 'W').entries[0]?.held).not.toBeNull();
			expect((withBaseline ?? 0) - (withoutBaseline ?? 0)).toBeLessThan(64);
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
 * An Edit History's undo, against the journal (ADR-0039, ticket 20 constraint 5).
 *
 * ⚠ **This is the test the e2e version was mistaken for.** `editor-workspace.e2e.ts` types a name
 * and types it back, which is a re-edit and not a Step at all — review caught that, and it left the
 * actual claim ("a replayed journal entry cannot resurrect an edit the user undid before leaving")
 * resting on a reading of the code rather than on anything red.
 *
 * The mechanism is exercised for real here: a genuine `EditHistory` whose `writeBack` goes through
 * the same `Autosave` as every other edit, against a store whose writes **stop settling** the moment
 * the undo is pressed — which is the only state in which the journal is what carries the file, and
 * therefore the only state in which the question has an answer.
 */
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
		await store.write(path, utf8.encode(held));

		const history = new EditHistory({
			flush: () => autosave.flush(),
			read: async (at) => {
				try {
					return await store.read(at);
				} catch {
					return null;
				}
			},
			// The session's routing, in miniature: a write-back is an ordinary edit and goes through the
			// same `Autosave`, which is the whole reason the journal has anything to say about it.
			writeBack: (at, bytes) => (bytes === null ? store.delete(at) : autosave.commit(at, bytes))
		});

		// The deletion, exactly as the editor performs it: one Step, whose gesture writes the
		// collection without the Annotation.
		await history.step('Undo delete of this Annotation', [path], () =>
			autosave.commit(path, utf8.encode('{"features":[]}'))
		);
		expect(text(await store.read(path))).toBe('{"features":[]}');

		// Nothing lands from here on, so whatever is in the journal is what a reload would put back.
		// Mocked *after* the Step rather than before it: `step` flushes and reads either side of the
		// gesture, and a write that never settles would leave it with no after-image to hold.
		vi.spyOn(store, 'write').mockImplementation(() => new Promise<void>(() => {}));

		// Not awaited: the undo's own store write never settles either, which is the point.
		void history.undo();

		// The journal holds one entry per path and the last write wins, in it exactly as in the store.
		// Were it otherwise, a scholar who deleted an Annotation, took it back, and closed the tab
		// would find it deleted again at the next startup.
		await vi.waitFor(() =>
			expect(readJournal(storage, 'W').entries.map((entry) => text(entry.bytes))).toEqual([held])
		);
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
