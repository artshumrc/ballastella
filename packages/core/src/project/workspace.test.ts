import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX } from '../store/project-store.js';
import { newMapLayer } from './layer.js';
import { imageInfoPath } from './image-files.js';
import { ProjectFormatTooNewError, newProjectFile } from './project-file.js';
import { DeletedProjects } from '../autosave/deleted-projects.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import {
	ReservedDirectoryNameError,
	Workspace,
	deletionsAreNoteworthy,
	hoistedImageId,
	isReservedDirectoryName,
	toDirectoryName
} from './workspace.js';

/** Stand-in for what the hub was rendering when Delete was pressed. See `DeletionRecord.was`. */
const WAS = { name: 'Amsterdam 1625', updatedAt: '2026-08-08T09:00:00.000Z' };

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const readJson = async (store: MemoryProjectStore, path: string) =>
	JSON.parse(decode(await store.read(path)));

/** SHA-256 of every file under a prefix, so "nothing was written" is provable. */
async function hashTree(store: MemoryProjectStore, prefix: string): Promise<Map<string, string>> {
	const hashes = new Map<string, string>();
	for (const path of await store.list(prefix)) {
		const digest = await crypto.subtle.digest('SHA-256', await store.read(path));
		hashes.set(
			path,
			[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
		);
	}
	return hashes;
}

describe('Workspace', () => {
	let store: MemoryProjectStore;
	let clock: Date;
	let workspace: Workspace;

	beforeEach(() => {
		store = new MemoryProjectStore();
		clock = new Date('2026-01-01T00:00:00.000Z');
		workspace = new Workspace(store, { now: () => clock });
	});

	describe('creating a Project', () => {
		it('writes project.json into a directory named after the display name', async () => {
			const created = await workspace.createProject('Amsterdam 1625');

			expect(created.directory).toBe('amsterdam-1625');
			expect(await store.list('')).toEqual(['amsterdam-1625/project.json']);
			expect(await readJson(store, 'amsterdam-1625/project.json')).toEqual({
				formatVersion: 1,
				name: 'Amsterdam 1625',
				updatedAt: '2026-01-01T00:00:00.000Z',
				layers: [],
				baseMap: null
			});
		});

		it('gives a second Project of the same name its own directory', async () => {
			const first = await workspace.createProject('Amsterdam 1625');
			const second = await workspace.createProject('Amsterdam 1625');

			expect([first.directory, second.directory]).toEqual(['amsterdam-1625', 'amsterdam-1625-2']);
			expect(second.name).toBe('Amsterdam 1625');
		});

		it('names an untitled Project rather than writing an empty one', async () => {
			const created = await workspace.createProject('   ');

			expect(created.name).toBe('Untitled Project');
			expect(created.directory).toBe('untitled-project');
		});
	});

	describe('listing Projects', () => {
		it('reports each Project’s name and when it was last touched, newest first', async () => {
			clock = new Date('2026-01-01T00:00:00.000Z');
			await workspace.createProject('Older');
			clock = new Date('2026-06-01T00:00:00.000Z');
			await workspace.createProject('Newer');

			expect(await workspace.listProjects()).toEqual([
				{
					directory: 'newer',
					name: 'Newer',
					description: '',
					updatedAt: '2026-06-01T00:00:00.000Z',
					onFrontPage: false,
					problem: null
				},
				{
					directory: 'older',
					name: 'Older',
					description: '',
					updatedAt: '2026-01-01T00:00:00.000Z',
					onFrontPage: false,
					problem: null
				}
			]);
		});

		it('ignores directories that hold no project.json', async () => {
			await store.write('not-a-project/notes.txt', new TextEncoder().encode('hello'));
			await workspace.createProject('Real');

			expect((await workspace.listProjects()).map((p) => p.directory)).toEqual(['real']);
		});

		it('still lists a Project from a newer version of the app, marked as such', async () => {
			await store.write(
				'from-the-future/project.json',
				new TextEncoder().encode('{"formatVersion":2,"name":"Tomorrow"}')
			);

			expect(await workspace.listProjects()).toEqual([
				{
					directory: 'from-the-future',
					name: 'from-the-future',
					description: '',
					updatedAt: '',
					onFrontPage: false,
					problem: 'format-too-new'
				}
			]);
		});

		it('propagates an unreachable workspace instead of pretending it is empty', async () => {
			const unreachable = new Workspace(MemoryProjectStore.unreachable());

			await expect(unreachable.listProjects()).rejects.toThrow('Workspace not reachable');
		});
	});

	describe('opening a Project', () => {
		it('refuses a formatVersion this build does not understand', async () => {
			await store.write(
				'from-the-future/project.json',
				new TextEncoder().encode('{"formatVersion":2,"name":"Tomorrow"}')
			);

			await expect(workspace.readProject('from-the-future')).rejects.toThrow(
				ProjectFormatTooNewError
			);
		});

		it('leaves a refused Project’s file untouched', async () => {
			const original = '{"formatVersion":2,"name":"Tomorrow","layers":["something new"]}';
			await store.write('from-the-future/project.json', new TextEncoder().encode(original));
			const before = await hashTree(store, 'from-the-future/');

			await workspace.readProject('from-the-future').catch(() => undefined);
			await workspace.listProjects();

			expect(await hashTree(store, 'from-the-future/')).toEqual(before);
			expect(decode(await store.read('from-the-future/project.json'))).toBe(original);
		});

		/**
		 * ─────────────────────────────────────────────────────────────────────────────────────
		 * WHAT THE STORE HELD, REPORTED FROM THE READ THAT ALREADY HAPPENS
		 *
		 * The write-ahead journal has to record what an edit was made *against*, and it cannot ask the
		 * store: `WriteAheadJournal.record` is synchronous by contract, and `Autosave` learns what the
		 * store holds only from an acknowledged write, which is the case that already worked. Opening
		 * a Project is the moment the bytes are in hand for nothing.
		 */
		describe('what the store held, told to whoever is listening', () => {
			const RAW_MANIFEST = '{"formatVersion":1,"name":"Amsterdam 1625","layers":[],"baseMap":null}';

			it('takes its token before the read, so a save in flight is not undone by it', async () => {
				// ⚠ **The ordering that a "no race" claim in three docblocks asserted and nothing checked**
				// (round 5, finding C). What a read carries is evidence about the moment it *began*; a
				// store write landing while it is in flight leaves that evidence stale, and filing it as
				// current refuses the next stranded edit with a sentence that is not true.
				//
				// Driven rather than asserted as an ordering of calls: the counter is advanced *during*
				// the read, standing in for the save that lands mid-flight, so a token taken afterwards
				// comes back later than the fact it is supposed to predate. Asserting "mark, then
				// observe" would pass either way, which is the shape this whole ticket keeps meeting.
				await store.write('amsterdam-1625/project.json', new TextEncoder().encode(RAW_MANIFEST));
				let counter = 0;
				const tokens: number[] = [];
				const read = store.read.bind(store);
				store.read = async (path) => {
					const bytes = await read(path);
					counter += 10;
					return bytes;
				};
				const watched = new Workspace(store, {
					now: () => clock,
					observer: {
						mark: () => {
							counter += 1;
							return counter;
						},
						observe: (_path, _bytes, at) => tokens.push(at)
					}
				});

				await watched.readProject('amsterdam-1625');

				// 1, taken before the read. Taken afterwards it would be 12, and would outrank the save.
				expect(tokens).toEqual([1]);
			});

			it('reports the bytes it read, before parsing them', async () => {
				const raw = RAW_MANIFEST;
				await store.write('amsterdam-1625/project.json', new TextEncoder().encode(raw));
				const seen: [string, string][] = [];
				const watched = new Workspace(store, {
					now: () => clock,
					observer: { mark: () => 1, observe: (path, bytes) => seen.push([path, decode(bytes)]) }
				});

				await watched.readProject('amsterdam-1625');

				// ⚠ The bytes, not a re-serialisation of the parsed model. A journal baseline is a
				// fingerprint of what is on disk, and `serialiseProjectFile` stamps `updatedAt` — so a
				// model round trip would report content the store has never held and refuse the rescue
				// it exists to permit.
				expect(seen).toEqual([['amsterdam-1625/project.json', raw]]);
			});

			it('says nothing when there was nothing to read', async () => {
				// An absent or unreadable file tells nobody what the store holds, and a guess in either
				// direction is worse than the "cannot tell which is newer" this exists to avoid.
				const seen: string[] = [];
				const watched = new Workspace(store, {
					now: () => clock,
					observer: { mark: () => 1, observe: (path) => seen.push(path) }
				});

				await watched.readProject('never-existed').catch(() => undefined);

				expect(seen).toEqual([]);
			});

			it('reports a manifest this build refuses to parse, because the store does hold it', async () => {
				// ⚠ **A failed *read* and a failed *parse* are not the same event**, and the difference
				// decides this. Nothing can be said about bytes that never arrived; these arrived
				// perfectly and are exactly what the store holds. A Project from a newer version cannot
				// be opened, so no edit of it can strand — but `annotations/` beside it can, and the
				// report costs nothing either way.
				await store.write(
					'from-the-future/project.json',
					new TextEncoder().encode('{"formatVersion":2,"name":"Tomorrow"}')
				);
				const seen: string[] = [];
				const watched = new Workspace(store, {
					now: () => clock,
					observer: { mark: () => 1, observe: (path) => seen.push(path) }
				});

				await watched.readProject('from-the-future').catch(() => undefined);

				expect(seen).toEqual(['from-the-future/project.json']);
			});
		});

		it('writes nothing at all when a Project is opened and closed without an edit', async () => {
			// ADR-0010: merely looking at last year's work must not produce a diff in a git
			// working tree or sync a rewrite to another machine.
			const { directory } = await workspace.createProject('Amsterdam 1625');
			await store.write(
				`${directory}/annotations/one.geojson`,
				new TextEncoder().encode('{"w":1}')
			);
			const before = await hashTree(store, `${directory}/`);

			const autosave = new Autosave(store);
			const session = new Workspace(store, { autosave, now: () => clock });
			const write = vi.spyOn(store, 'write');

			await session.readProject(directory);
			await autosave.flush();

			expect(write).not.toHaveBeenCalled();
			expect(await hashTree(store, `${directory}/`)).toEqual(before);
		});
	});

	describe('renaming a Project', () => {
		it('changes the display name in project.json', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');
			clock = new Date('2026-02-02T00:00:00.000Z');

			await workspace.renameProject(directory, 'Amsterdam, 1625');

			const file = await readJson(store, `${directory}/project.json`);
			expect(file.name).toBe('Amsterdam, 1625');
			expect(file.updatedAt).toBe('2026-02-02T00:00:00.000Z');
		});

		it('leaves the directory alone, so a shared `?p=` link keeps working', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');

			await workspace.renameProject(directory, 'Something Else Entirely');

			expect(await store.list('')).toEqual(['amsterdam-1625/project.json']);
		});

		it('succeeds when the new display name is already another Project’s', async () => {
			const first = await workspace.createProject('Amsterdam 1625');
			const second = await workspace.createProject('Boston 1775');

			await workspace.renameProject(second.directory, 'Amsterdam 1625');

			const projects = await workspace.listProjects();
			expect(projects.map((p) => p.name)).toEqual(['Amsterdam 1625', 'Amsterdam 1625']);
			expect(new Set(projects.map((p) => p.directory))).toEqual(
				new Set([first.directory, second.directory])
			);
		});

		it('keeps everything else in the file', async () => {
			await store.write(
				'p/project.json',
				new TextEncoder().encode('{"formatVersion":1,"name":"Old","baseMap":"protomaps-light"}')
			);

			await workspace.renameProject('p', 'New');

			expect(await readJson(store, 'p/project.json')).toMatchObject({
				name: 'New',
				baseMap: 'protomaps-light'
			});
		});
	});

	/**
	 * The Front Page choice, from the Workspace's side (ADR-0032).
	 *
	 * The state a hub renders and the state a publish records both come from `project.json`, through
	 * `listProjects`. Nothing caches it, which is what makes "the choice survives a reload" a property
	 * of the file rather than of the page.
	 */
	describe('choosing whether a Project is on the Front Page', () => {
		it('starts off it, so turning a site on exposes nothing nobody listed', async () => {
			const created = await workspace.createProject('Amsterdam 1625');

			expect(created.onFrontPage).toBe(false);
			expect((await workspace.listProjects())[0]?.onFrontPage).toBe(false);
		});

		it('puts a Project on and takes it back off, in the file the list is read from', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');

			expect((await workspace.setProjectOnFrontPage(directory, true)).onFrontPage).toBe(true);
			expect(await readJson(store, `${directory}/project.json`)).toMatchObject({
				onFrontPage: true
			});
			expect((await workspace.listProjects())[0]?.onFrontPage).toBe(true);

			// Off again removes the field rather than writing `false`: absence *is* off, so a Project
			// nobody has listed keeps the bytes it would have had if it had never been listed.
			expect((await workspace.setProjectOnFrontPage(directory, false)).onFrontPage).toBe(false);
			expect(await readJson(store, `${directory}/project.json`)).not.toHaveProperty('onFrontPage');
			expect((await workspace.listProjects())[0]?.onFrontPage).toBe(false);
		});

		/**
		 * Every other file of the Project, and every other field of the manifest: the choice decides one
		 * list and touches nothing else, which is the whole of what the control promises the user.
		 *
		 * ⚠ **`toEqual`, not `toMatchObject`, and the clock has moved.** `updatedAt` is what the hub is
		 * sorted by and what publishing writes the Front Page in the order of, so a stamp here jumps the
		 * row to the top under the cursor that just clicked it and reorders the site — which ADR-0045
		 * leaves alone. A `toMatchObject` assertion passes straight through that, which is how it was
		 * missed; naming the whole object is what makes the absence of a stamp an assertion.
		 */
		it('changes nothing else about the Project, not even when it was last touched', async () => {
			await store.write(
				'p/project.json',
				new TextEncoder().encode(
					'{"formatVersion":1,"name":"Old","updatedAt":"2026-01-01T00:00:00.000Z",' +
						'"baseMap":"protomaps-light"}'
				)
			);
			await store.write('p/annotations/a.geojson', new TextEncoder().encode('{"w":1}'));
			clock = new Date('2026-09-09T09:09:09.000Z');

			await workspace.setProjectOnFrontPage('p', true);

			expect(await readJson(store, 'p/project.json')).toEqual({
				formatVersion: 1,
				name: 'Old',
				updatedAt: '2026-01-01T00:00:00.000Z',
				layers: [],
				baseMap: 'protomaps-light',
				onFrontPage: true
			});
			expect((await workspace.listProjects())[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
			expect(await store.list('p/')).toEqual(['p/annotations/a.geojson', 'p/project.json']);
		});

		/**
		 * ⚠ **A Project this build cannot parse still gets to say where it belongs** (ADR-0045).
		 *
		 * The reason `CURRENT_FORMAT_VERSION` was not bumped for this field is that the field is
		 * version-independent: a manifest from a newer build says `"onFrontPage": true` in the same
		 * plain way, and this build can read that one key whatever it makes of the rest. Dropping the
		 * Project off the list instead would take a colleague's Project off their own front page over a
		 * `formatVersion` this build did not like.
		 */
		it('honours the choice in a manifest this build cannot otherwise read', async () => {
			await store.write(
				'from-the-future/project.json',
				new TextEncoder().encode('{"formatVersion":99,"name":"Later","onFrontPage":true}')
			);

			expect(await workspace.listProjects()).toEqual([
				{
					directory: 'from-the-future',
					name: 'from-the-future',
					description: '',
					updatedAt: '',
					onFrontPage: true,
					problem: 'format-too-new'
				}
			]);
		});

		// Nothing readable to go on defaults to off, which is the same answer an absent field gets: a
		// Project whose manifest will not open holds no evidence that anybody asked for it to be offered.
		it('leaves a manifest that is not JSON at all off the Front Page', async () => {
			await store.write('broken/project.json', new TextEncoder().encode('{ not json'));

			expect((await workspace.listProjects())[0]).toEqual({
				directory: 'broken',
				name: 'broken',
				description: '',
				updatedAt: '',
				onFrontPage: false,
				problem: 'unreadable'
			});
		});

		// A duplicate is a new Project, and a new Project is on nobody's front page: the copy has to be
		// put there deliberately, exactly as the original was.
		it('does not travel with a duplicate', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');
			await workspace.setProjectOnFrontPage(directory, true);

			expect((await workspace.duplicateProject(directory)).onFrontPage).toBe(false);
		});
	});

	describe('duplicating a Project', () => {
		it('copies every file into a new directory', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');
			await store.write(
				`${directory}/annotations/one.geojson`,
				new TextEncoder().encode('{"w":1}')
			);
			await store.write(
				`${directory}/annotations/a.geojson`,
				new TextEncoder().encode('{"type":"FeatureCollection","features":[]}')
			);

			const copy = await workspace.duplicateProject(directory);

			expect(await store.list(`${copy.directory}/`)).toEqual([
				'amsterdam-1625-copy/annotations/a.geojson',
				'amsterdam-1625-copy/annotations/one.geojson',
				'amsterdam-1625-copy/project.json'
			]);
			expect(decode(await store.read(`${copy.directory}/annotations/one.geojson`))).toBe('{"w":1}');
		});

		it('leaves the original alone', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');
			const before = await hashTree(store, `${directory}/`);

			await workspace.duplicateProject(directory);

			expect(await hashTree(store, `${directory}/`)).toEqual(before);
		});

		it('marks the copy as one', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');

			expect((await workspace.duplicateProject(directory)).name).toBe('Amsterdam 1625 (copy)');
		});
	});

	describe('deleting a Project', () => {
		it('removes every file in it and nothing else', async () => {
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			const kept = await workspace.createProject('Boston 1775');

			await workspace.deleteProject(doomed.directory);

			expect(await store.list('')).toEqual([`${kept.directory}/project.json`]);
			expect((await workspace.listProjects()).map((p) => p.directory)).toEqual([kept.directory]);
		});

		/**
		 * ⚠ **Why `--repeat-each=20` on the e2e was 4 flaky in 20.**
		 *
		 * A deletion is as asynchronous as an edit and had none of the journal's protection: it lists,
		 * deletes each file, then reclaims — and a document being unloaded runs none of those
		 * continuations. The store below stalls on the **first** of them, which is where the browser
		 * measurement said the real failure stopped.
		 *
		 * What is asserted is not that the deletion finishes — it cannot, the page is gone — but that
		 * the *gesture* was written down synchronously, so the next startup can carry it out. That is
		 * the discrimination the application actually has: “the user deleted this Project”, not “this
		 * Project's files are not there right now”, which is a guess and is the shape of the two fresh
		 * data-loss paths this recovery chain has opened before.
		 */
		it('writes the gesture down before its first await, so a lost page does not lose it', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const stalled = new MemoryProjectStore();
			// A store that never answers, standing in for a page that stops running its continuations.
			stalled.list = () => new Promise<never>(() => undefined);
			const halted = new Workspace(stalled, { deleted, identity: 'this-browser' });

			void halted.deleteProject('amsterdam-1625', WAS);

			// Synchronously, in the same turn as the call: there is no `await` between these two lines.
			expect(deleted.pending()).toEqual([{ directory: 'amsterdam-1625', was: WAS }]);
		});

		/**
		 * The counterpart to the test above, and the reason the record is not a tombstone: it is
		 * dropped the moment the removal it names has actually happened, so in ordinary use nothing
		 * accumulates and no startup does work that has already been done. Dropped **after** the
		 * removal resolved, never beside it — nothing is reported done that was not done.
		 */
		it('forgets the record once the removal has actually happened', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const recording = new Workspace(store, { deleted, identity: 'this-browser' });
			const doomed = await recording.createProject('Amsterdam 1625');

			await recording.deleteProject(doomed.directory, doomed);

			expect(deleted.pending()).toEqual([]);
			expect(deleted.has(doomed.directory)).toBe(false);
		});

		/**
		 * ⚠ **A write the store already has is not guaranteed to settle, and round 3 made this method
		 * wait for one** (round 4). A folder whose grant was revoked mid-write, or an OPFS handle a
		 * second tab tore down, leaves `store.write` pending with nothing to reject it — and before
		 * round 3 `abandon` was synchronous and the removal ran regardless. Unbounded, this is a
		 * Delete button that never finishes, with the Project still on screen.
		 *
		 * Two things have to be true, and the second is the one that is easy to get wrong: the
		 * deletion happens anyway — the user asked — **and the record is kept**, because the write
		 * that was still out there may land after the listing and put `project.json` back. Dropping
		 * the record there would be the round-3 defect exactly, reintroduced by its own fix.
		 */
		it('deletes anyway when a write will not settle, and keeps the record because it might land', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const stuck = new MemoryProjectStore();
			const autosave = new Autosave(stuck, { debounceMs: 1, inFlightWaitMs: 10 });
			const recording = new Workspace(stuck, { autosave, deleted, identity: 'this-browser' });
			const doomed = await recording.createProject('Amsterdam 1625');
			// A rename whose debounce has fired: the store has the bytes and is never going to answer.
			stuck.write = () => new Promise<never>(() => undefined);
			autosave.queue(`${doomed.directory}/project.json`, new Uint8Array([1]));
			await new Promise((resolve) => setTimeout(resolve, 5));

			await recording.deleteProject(doomed.directory, doomed);

			expect(await stuck.list('')).toEqual([]);
			// Kept: the next startup finds either nothing and drops it, or the manifest that write put
			// back and finishes the job.
			expect(deleted.has(doomed.directory)).toBe(true);
		});

		it('finishes at the next startup a deletion the page did not live long enough to finish', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			const kept = await workspace.createProject('Boston 1775');
			// Exactly what the interrupted page left behind: the record, and every file still there.
			deleted.record(doomed.directory, doomed);

			// A new session over the same Workspace and the same record — a reload.
			const restarted = new Workspace(store, { deleted, identity: 'this-browser' });
			const outcome = await restarted.finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: [doomed.directory], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual([`${kept.directory}/project.json`]);
			// And the record goes with it, so the next startup does no work and — more to the point —
			// cannot delete a Project that later takes the same folder name.
			expect(deleted.pending()).toEqual([]);
		});

		it('keeps a deletion it could not finish, and names it rather than counting it', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			deleted.record('amsterdam-1625', WAS);

			const unreachable = new Workspace(MemoryProjectStore.unreachable(), { deleted });
			const outcome = await unreachable.finishInterruptedDeletions();

			// Kept, for the same reason `replayJournal` keeps a failed write: an unplugged drive must
			// cost a delay, never the gesture. An unreachable store is `unfinished` and never
			// `refused`: "could not be asked" is not "asked, and the answer was no".
			expect(outcome).toEqual({ finished: [], refused: [], unfinished: ['amsterdam-1625'] });
			expect(deleted.pending().map((record) => record.directory)).toEqual(['amsterdam-1625']);
		});

		/**
		 * ⚠ **The fresh data-loss path this ticket could have opened, closed.**
		 *
		 * A record that outlived its Project would be a gesture aimed at a folder name, and folder
		 * names are reusable. Without this, the next startup after making “Amsterdam 1625” again would
		 * read the old record and delete the *new* Project. `Workspace.#claim` drops it synchronously,
		 * with no `await` between there and the write that creates the Project — an await in between
		 * is the same window in miniature.
		 */
		it('drops the record when a new Project claims the deleted one’s folder name', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const recording = new Workspace(store, { deleted, identity: 'this-browser' });
			const doomed = await recording.createProject('Amsterdam 1625');
			await recording.deleteProject(doomed.directory, doomed);
			// As if the deletion had finished on disk but the record had not been dropped.
			deleted.record(doomed.directory, doomed);

			const replacement = await recording.createProject('Amsterdam 1625');

			expect(replacement.directory).toBe(doomed.directory);
			expect(deleted.pending()).toEqual([]);
			// And the startup that follows leaves it alone, which is the failure being prevented.
			await recording.finishInterruptedDeletions();
			expect(await store.list('')).toEqual([`${replacement.directory}/project.json`]);
		});

		it('drops the record when a duplicate claims the folder name', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const recording = new Workspace(store, { deleted, identity: 'this-browser' });
			const original = await recording.createProject('Amsterdam 1625');
			deleted.record('amsterdam-1625-copy', WAS);

			const copy = await recording.duplicateProject(original.directory);

			expect(copy.directory).toBe('amsterdam-1625-copy');
			expect(deleted.pending()).toEqual([]);
		});

		it('takes the half-finished writes with it, so nothing survives on disk', async () => {
			const doomed = await workspace.createProject('Amsterdam 1625');
			// What a tab that died between the two steps of an atomic write leaves. `list` cannot
			// report it and `delete` cannot be handed it, so before `reclaimAbandonedWrites` the
			// "deleted" Project's directory survived permanently — outside the `list` + `size` totals
			// the hosting warning is judged against, and in a real folder a dotfile committed to git.
			store.plant(
				`${doomed.directory}/.project.json.abandoned${TEMP_PATH_SUFFIX}`,
				new TextEncoder().encode('half a document')
			);

			await workspace.deleteProject(doomed.directory);

			expect([...store.snapshot().keys()]).toEqual([]);
		});

		/**
		 * ⚠ **The deletion's manifest goes last, and the whole precondition rests on it.**
		 *
		 * `project.json` is the only evidence `finishInterruptedDeletions` has that the directory in
		 * front of it is the Project the user deleted. Removed first, an interrupted deletion would be
		 * left with a record it can no longer justify and files it may no longer take. Last, the
		 * invariant is simple: while an interrupted deletion has anything left to remove, it still has
		 * its manifest.
		 */
		it('removes the manifest last, so an interrupted deletion keeps its evidence', async () => {
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			await store.write(`${doomed.directory}/zzz-last-alphabetically.json`, new Uint8Array([1]));
			const order: string[] = [];
			const real = store.delete.bind(store);
			store.delete = async (path) => {
				order.push(path);
				return real(path);
			};

			await workspace.deleteProject(doomed.directory, doomed);

			expect(order.at(-1)).toBe(`${doomed.directory}/project.json`);
			expect(order).toHaveLength(3);
		});

		/**
		 * The contract's "cut off midway" case, seeded rather than reasoned about. `#removeEverythingIn`
		 * is idempotent and shared by both routes, so this is delivered by construction — but nothing
		 * seeded a *genuinely* half-removed directory, and "delivered by construction" is the claim a
		 * test is cheapest to make and most embarrassing to be wrong about.
		 */
		it('finishes a deletion that had already removed half the Project', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			await store.write(`${doomed.directory}/annotations/two.geojson`, new Uint8Array([1]));
			// Exactly the disk an interrupted deletion leaves: one file already gone, the manifest
			// still there because it goes last, and the record still saying what was asked for.
			await store.delete(`${doomed.directory}/annotations/one.geojson`);
			deleted.record(doomed.directory, doomed);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: [doomed.directory], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual([]);
		});

		/**
		 * ⚠ **THE WORSE DATA-LOSS PATH THE FIRST CUT OF THIS TICKET OPENED, CLOSED.**
		 *
		 * A folder Workspace's key is `folder:<folder name>` — the folder's *name*, because the browser
		 * offers a page no stable identifier for a picked directory. ADR-0017 records that collision
		 * and *bounds* it: a wrong-Workspace **replay** can only write into a Project whose
		 * `project.json` is already there, so its worst case is one overwritten file the user is told
		 * about. `finishInterruptedDeletions` had no precondition at all, so its worst case was a
		 * recursive delete of somebody else's Project — reachable entirely inside documented
		 * behaviour, because ADR-0023 explicitly invites synced folders and second checkouts:
		 *
		 *   delete `amsterdam-1625` in folder Workspace `maps` on a laptop → torn down in the 20%
		 *   window this ticket exists for → record left → open a *different* folder also called `maps`
		 *   → that folder's `amsterdam-1625` and everything in it goes, before the listing renders.
		 *
		 * The key shape where the binding is not unique was the one shape the suite did not exercise.
		 */
		it('refuses to finish a deletion against a different Project in a same-named folder', async () => {
			const storage = new FakeJournalStorage();
			// The laptop: a folder Workspace called `maps`, and a deletion that never finished.
			new DeletedProjects(storage, 'folder:maps').record('amsterdam-1625', {
				name: 'Amsterdam 1625',
				updatedAt: '2026-08-08T09:00:00.000Z'
			});

			// The external drive: a *different* folder, also called `maps`, holding a Project that
			// happens to have the same folder name. Everything in it is somebody's real work.
			const other = new MemoryProjectStore();
			// Seeded rather than created through this Workspace: it has been sitting on that drive for
			// months, which is the whole point — `#claim` never saw it and has nothing to say about it.
			const theirs = new Workspace(other, {
				deleted: new DeletedProjects(storage, 'folder:maps'),
				identity: 'a-name-anywhere'
			});
			await theirs.writeProject(
				'amsterdam-1625',
				newProjectFile('Amsterdam 1625', new Date('2026-08-01T00:00:00.000Z'))
			);
			await other.write('amsterdam-1625/annotations/theirs.geojson', new Uint8Array([9]));

			const outcome = await theirs.finishInterruptedDeletions();

			expect(outcome.finished).toEqual([]);
			expect(outcome.unfinished).toEqual([]);
			expect(outcome.refused).toEqual([
				{
					directory: 'amsterdam-1625',
					detail: expect.stringContaining('will not remove it on its own')
				}
			]);
			// Not one byte, and the Project still lists.
			expect(await other.list('')).toEqual([
				'amsterdam-1625/annotations/theirs.geojson',
				'amsterdam-1625/project.json'
			]);
			// And the record is kept, not swallowed: the Workspace it belongs to may still turn up.
			expect(new DeletedProjects(storage, 'folder:maps').has('amsterdam-1625')).toBe(true);
		});

		/**
		 * ⚠ **THE CASE THAT KILLED THE CONTENT CHECK, AND IT IS THE SCENARIO THE TICKET NAMES.**
		 *
		 * Review 2 replaced "no precondition" with "the manifest must still say what the record says",
		 * and wrote that the bound left was *"a Project whose manifest is still byte-for-byte the one
		 * the user deleted"*. That sentence is true and it is the defect: **a copy IS byte-for-byte
		 * the one the user deleted.** Dropbox, Drive, rsync, `cp -a` and a zip all reproduce
		 * `project.json` exactly, and ADR-0010 guarantees that opening a Project writes nothing, so
		 * the copy *stays* identical. Every field the record carries matches, so every comparison of
		 * the directory's contents says "remove", and the backup is destroyed.
		 *
		 * No further field fixes it, which is why the answer is {@link WorkspaceIdentity} — the key,
		 * not the contents. Seeded here as a literal byte-for-byte copy so that it is the *same*
		 * Project and not a lookalike: nothing in the store can tell these two apart, and that is the
		 * point being pinned.
		 */
		it('refuses to finish a deletion against a byte-identical copy of the deleted Project', async () => {
			const storage = new FakeJournalStorage();
			// The laptop, in a folder Workspace called `maps`. The user deletes it and the page dies.
			const laptop = new MemoryProjectStore();
			const theirs = new Workspace(laptop, { now: () => clock });
			const doomed = await theirs.createProject('Amsterdam 1625');
			await laptop.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			new DeletedProjects(storage, 'folder:maps').record(doomed.directory, doomed);

			// The backup drive: the same folder name, and inside it a byte-for-byte copy — same
			// display name, same `updatedAt`, same annotations. It is the same Project, copied.
			const backup = new MemoryProjectStore();
			for (const path of await laptop.list('')) {
				await backup.write(path, await laptop.read(path));
			}
			const opened = new Workspace(backup, {
				deleted: new DeletedProjects(storage, 'folder:maps'),
				identity: 'a-name-anywhere'
			});

			const outcome = await opened.finishInterruptedDeletions();

			expect(outcome.finished).toEqual([]);
			// Not one byte of the backup, though every comparison a content check could make matches.
			expect(await backup.list('')).toEqual([
				`${doomed.directory}/annotations/one.geojson`,
				`${doomed.directory}/project.json`
			]);
			expect(outcome.refused.map((entry) => entry.detail)).toEqual([
				expect.stringContaining('will not remove it on its own')
			]);
		});

		/**
		 * The other half: in a Workspace whose key *does* name one place, the very same record is
		 * carried out. Without this the test above would be satisfied by never finishing anything, and
		 * the defect the durable record exists for would be back.
		 */
		it('finishes the same deletion in a Workspace whose key names one place', async () => {
			const storage = new FakeJournalStorage();
			const deleted = new DeletedProjects(storage, 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			deleted.record(doomed.directory, doomed);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: [doomed.directory], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual([]);
		});

		/**
		 * ⚠ **`PathNotFoundError` from `readProject` means the *manifest* is missing, not the
		 * directory** — and this branch read it as "the directory is empty, so removing everything in
		 * it removes nothing". It then listed the directory and deleted **everything it found**, and
		 * reported it to the user as a deletion carried out, because `removed > 0`.
		 *
		 * Reachable with nothing exotic: a Drive or Dropbox folder mid-sync where the GeoJSON has
		 * landed and the manifest has not, a partial checkout, or any directory of that name that was
		 * never a Project. The old test seeded an **empty** store, so the branch was only ever
		 * exercised against nothing — it could not have failed.
		 *
		 * `project.json` goes last precisely so its absence means "the removal reached the end", and
		 * the only honest reading of that is: there is nothing to do. The record is dropped and
		 * nothing is said.
		 */
		/**
		 * ⚠ **THE ROUND'S HEADLINE CLAIM, AND NOTHING PINNED IT.**
		 *
		 * "A caller that has not said which it is has not established identity, and the default is the
		 * one that destroys nothing" was a sentence in a comment: every test passed an explicit
		 * `identity`, production passes one, and flipping the default to `'this-browser'` left the
		 * whole suite green. That is the same shape — a bound asserted in prose and nowhere else —
		 * that both previous rounds of this ticket were about.
		 *
		 * The record here **matches** and the store is reachable, so every other precondition says
		 * "remove". The default is the only thing standing between this Project and a recursive
		 * delete.
		 */
		it('finishes nothing unattended for a caller that did not say what the Workspace is', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			deleted.record(doomed.directory, doomed);

			// No `identity`. This is the future caller the comment is addressed to.
			const outcome = await new Workspace(store, { deleted }).finishInterruptedDeletions();

			expect(outcome.finished).toEqual([]);
			expect(outcome.refused.map((entry) => entry.directory)).toEqual([doomed.directory]);
			expect(await store.list('')).toEqual([
				`${doomed.directory}/annotations/one.geojson`,
				`${doomed.directory}/project.json`
			]);
		});

		it('removes nothing from a directory that has files and no manifest', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			// Mid-sync: the annotations are here and `project.json` is not.
			await store.write('amsterdam-1625/annotations/one.geojson', new Uint8Array([1]));
			await store.write('amsterdam-1625/annotations/two.geojson', new Uint8Array([2]));
			// And a half-finished write beside them, which is the one thing this branch *does* remove:
			// this application's own temporary file, under a path this application wrote, unambiguous
			// wherever the directory came from. Asserted here because nothing else asserts it — and
			// `#adopt` sweeping the whole Workspace first is an ordering in the app that no test and
			// no type pins, which is the argument `#claim`'s comment had to stop making.
			store.plant(
				`amsterdam-1625/.project.json.abandoned${TEMP_PATH_SUFFIX}`,
				new TextEncoder().encode('half a document')
			);
			deleted.record('amsterdam-1625', WAS);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: [], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual([
				'amsterdam-1625/annotations/one.geojson',
				'amsterdam-1625/annotations/two.geojson'
			]);
			// The two real files are untouched, and the temporary one is gone: `snapshot` sees what
			// `list` hides.
			expect([...store.snapshot().keys()].sort()).toEqual([
				'amsterdam-1625/annotations/one.geojson',
				'amsterdam-1625/annotations/two.geojson'
			]);
			// And the record goes, so this is not a warning the user meets at every startup for ever.
			expect(deleted.pending()).toEqual([]);
		});

		/**
		 * ⚠ **A Project with an empty display name could never have its deletion finished**, and its
		 * record leaked for ever. `#summarise` published `file.name || directory` and the deletion
		 * check compared the raw `file.name`, so the two disagreed about exactly one Project: the one
		 * whose manifest carries no name, which `parseProjectFile` renders as `''` and which a
		 * hand-editable folder Workspace can hold. It was refused at every startup, and the sentence
		 * the user was shown read `is now “”`.
		 */
		it('finishes the deletion of a Project whose manifest carries no name', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			await store.write(
				'amsterdam-1625/project.json',
				new TextEncoder().encode(
					JSON.stringify({ formatVersion: 1, updatedAt: '2026-08-01T00:00:00.000Z' })
				)
			);
			const [nameless] = await workspace.listProjects();
			// Exactly what the hub was rendering when the user pressed Delete.
			expect(nameless?.name).toBe('amsterdam-1625');
			deleted.record('amsterdam-1625', nameless!);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: ['amsterdam-1625'], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual([]);
		});

		/**
		 * The same refusal, for the case that made `#claim` insufficient: it fires from `createProject`
		 * and `duplicateProject` and never from merely **opening** an existing Project. So a Project
		 * whose deletion could not be finished stayed listed, could be reopened and edited, and a later
		 * startup would delete it under the user. Its `updatedAt` has moved, so this is the same check.
		 */
		it('refuses to finish a deletion against a Project the user has since edited', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const recording = new Workspace(store, {
				deleted,
				identity: 'this-browser',
				now: () => clock
			});
			const doomed = await recording.createProject('Amsterdam 1625');
			deleted.record(doomed.directory, doomed);
			clock = new Date('2027-01-01T00:00:00.000Z');
			await recording.renameProject(doomed.directory, 'Amsterdam 1625, revisited');

			const outcome = await recording.finishInterruptedDeletions();

			expect(outcome.refused.map((entry) => entry.directory)).toEqual([doomed.directory]);
			expect((await recording.listProjects()).map((project) => project.name)).toEqual([
				'Amsterdam 1625, revisited'
			]);
		});

		/**
		 * A record with no evidence is a gesture whose target was never written down — a caller that
		 * did not know, or a `localStorage` value truncated by a full quota. It still refuses a replay,
		 * which is additive; it removes nothing, because this is the destructive step.
		 */
		it('refuses to finish a deletion whose record does not say what it was aimed at', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			deleted.record(doomed.directory, null);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome.refused.map((entry) => entry.directory)).toEqual([doomed.directory]);
			expect(await store.list('')).toEqual([`${doomed.directory}/project.json`]);
		});

		/**
		 * A manifest that is there and will not read is still a Project the hub lists and offers Delete
		 * on (ADR-0010), so an interrupted deletion of one has to be finishable — and `#summarise`
		 * renders both of its problems as the directory name with an empty `updatedAt`, which is what
		 * the record captured.
		 *
		 * ⚠ **This comparison establishes nothing about *which* Project**, and the second cut of this
		 * ticket leaned on it as though it did: two folders of the same name, both holding a Project
		 * whose manifest is too new for this build — the likely case, not the unlikely one, since it
		 * takes one newer build to write both — compare equal on the only field either has. It is
		 * sound here for one reason: the key already said this is the directory the gesture was made
		 * in. See the `'a-name-anywhere'` tests above.
		 */
		it('finishes a deletion of a Project whose manifest was already unreadable', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			await store.write('amsterdam-1625/project.json', new TextEncoder().encode('not json'));
			const [broken] = await workspace.listProjects();
			deleted.record('amsterdam-1625', broken!);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: ['amsterdam-1625'], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual([]);
		});

		/** And the same unreadable manifest refuses a record that named a Project which *could* be read. */
		it('refuses when the manifest cannot be read and the record named a readable Project', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			await store.write('amsterdam-1625/project.json', new TextEncoder().encode('not json'));
			deleted.record('amsterdam-1625', WAS);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome.refused.map((entry) => entry.directory)).toEqual(['amsterdam-1625']);
			expect(await store.list('')).toEqual(['amsterdam-1625/project.json']);
		});

		/**
		 * Nothing writes such a record today — `createProject` refuses a reserved name and
		 * `missingOwner` skips them — but this is the one operation in the chain that would act on it,
		 * and `images/` holds every Project's Map Images (ADR-0023). The guard is on the
		 * operation rather than on the writers, for the reason `#removeWorkspace`'s is.
		 *
		 * ⚠ **Said once and then dropped**, which the first spelling did not do. Nothing expires a
		 * record, `#claim` drops one only on create or duplicate, and `discardOrphanedJournal` reaches
		 * only Workspaces that are *not* the one showing the refusal — so a kept record here is a
		 * warning at every startup for the rest of the Workspace's life with no gesture that ends it.
		 * Keeping it buys nothing: a reserved name can never have been a Project at any startup.
		 */
		it('refuses a deletion naming one of the Workspace’s own directories, and drops the note', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			await store.write('images/abc/info.json', new Uint8Array([1]));
			deleted.record('images', { name: 'images', updatedAt: '' });

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome.refused.map((entry) => entry.directory)).toEqual(['images']);
			expect(await store.list('')).toEqual(['images/abc/info.json']);
			// Once, not for ever.
			expect(deleted.pending()).toEqual([]);
		});

		/**
		 * The counterpart, and the reason the drop above is narrow: a refusal that *can* be resolved by
		 * the user keeps its record. The Project is still here and deleting it again finishes the job;
		 * dropping the note would lose a real deletion the user asked for.
		 */
		it('keeps the note behind a refusal the user can still act on', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			deleted.record(doomed.directory, null);

			await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(deleted.has(doomed.directory)).toBe(true);
		});

		/**
		 * The ordinary case, and the one that must **not** be reported: the removal did finish and only
		 * the note saying so was lost. Nothing was taken, so nothing is named — the destructive side of
		 * `replayJournal`'s "nothing is reported as restored that was not written".
		 */
		it('says nothing about a record whose Project had already gone', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			deleted.record('amsterdam-1625', WAS);

			const outcome = await new Workspace(store, {
				deleted,
				identity: 'this-browser'
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: [], refused: [], unfinished: [] });
			expect(deleted.pending()).toEqual([]);
		});

		/**
		 * ⚠ **All three lists are worth telling the user about, and two of them were asserted
		 * nowhere.** `deletionsAreNoteworthy` is the gate on whether the recovery panel appears at
		 * all, so a version of it reading only `finished` would silence every refusal and every
		 * deletion that could not be carried out — which, since review 3, is the *whole* of what a
		 * folder Workspace ever reports. The panel would simply never appear there.
		 */
		describe('whether a startup’s deletions are worth saying', () => {
			const nothing = { finished: [], refused: [], unfinished: [] };

			it('says nothing when a startup found nothing to do', () => {
				expect(deletionsAreNoteworthy(nothing)).toBe(false);
			});

			it('speaks up for a deletion it carried out', () => {
				expect(deletionsAreNoteworthy({ ...nothing, finished: ['amsterdam-1625'] })).toBe(true);
			});

			it('speaks up for a deletion it refused, which is the one that removed nothing', () => {
				expect(
					deletionsAreNoteworthy({
						...nothing,
						refused: [{ directory: 'amsterdam-1625', detail: 'Nothing was removed.' }]
					})
				).toBe(true);
			});

			it('speaks up for a deletion it could not carry out yet', () => {
				expect(deletionsAreNoteworthy({ ...nothing, unfinished: ['amsterdam-1625'] })).toBe(true);
			});
		});

		/**
		 * ⚠ **`#claim`'s safety does not rest on `finishInterruptedDeletions` having run first**, which
		 * its comment used to claim — true only because `WorkspaceStorage.#replayAndReport` happens to
		 * call it in that order, which no test and no type pins. So the order is inverted here.
		 */
		it('leaves a new Project alone even when the startup sweep has not run at all', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			deleted.record('amsterdam-1625', WAS);
			const recording = new Workspace(store, { deleted, identity: 'this-browser' });

			const replacement = await recording.createProject('Amsterdam 1625');
			const outcome = await recording.finishInterruptedDeletions();

			expect(replacement.directory).toBe('amsterdam-1625');
			expect(outcome).toEqual({ finished: [], refused: [], unfinished: [] });
			expect(await store.list('')).toEqual(['amsterdam-1625/project.json']);
		});

		/**
		 * ⚠ **A second refusal, not the first one wearing a hat** (ADR-0017).
		 *
		 * `record` answers "is this durable" and the answer was being dropped. Two real browsers reach
		 * it — a `localStorage` full of one enormous Annotation collection, and Safari with cookies
		 * blocked, where reads answer and every write rejects — and in both the deletion is back to
		 * being only as durable as the tab. The comment that used to stand in for this said
		 * `protectionWarning`'s sibling "already says so in words"; it does not.
		 */
		it('says so when the browser will not write the deletion down, and deletes anyway', async () => {
			const storage = new FakeJournalStorage();
			storage.setItem = () => {
				throw new DOMException('blocked', 'SecurityError');
			};
			const refused: string[] = [];
			const recording = new Workspace(store, {
				deleted: new DeletedProjects(storage, 'opfs:My Workspace'),
				onDeletionNotRecorded: (directory) => refused.push(directory)
			});
			const doomed = await recording.createProject('Amsterdam 1625');

			await recording.deleteProject(doomed.directory, doomed);

			expect(refused).toEqual([doomed.directory]);
			// A browser that will not hold a note must not stop a user deleting a Project.
			expect(await store.list('')).toEqual([]);
		});
	});

	describe('routing writes through autosave', () => {
		it('coalesces a debounced rename and writes once', async () => {
			vi.useFakeTimers();
			try {
				const autosave = new Autosave(store, { debounceMs: 400 });
				const via = new Workspace(store, { autosave, now: () => clock });
				const { directory } = await via.createProject('Amsterdam 1625');
				const write = vi.spyOn(store, 'write');

				await via.renameProject(directory, 'A', { debounce: true });
				await via.renameProject(directory, 'Am', { debounce: true });
				await via.renameProject(directory, 'Ams', { debounce: true });
				await vi.advanceTimersByTimeAsync(400);

				expect(write).toHaveBeenCalledTimes(1);
				expect((await readJson(store, `${directory}/project.json`)).name).toBe('Ams');
			} finally {
				vi.useRealTimers();
			}
		});

		it('reports a rejected write to its caller rather than resolving', async () => {
			// The app awaits this and updates the screen from it. While autosave resolved on failure,
			// a rename that never reached the disk was a success all the way up to the UI.
			const autosave = new Autosave(store, { debounceMs: 400 });
			const via = new Workspace(store, { autosave, now: () => clock });
			const { directory } = await via.createProject('Amsterdam 1625');
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));

			await expect(via.renameProject(directory, 'Amsterdam 1626')).rejects.toThrow(
				'quota exceeded'
			);

			expect((await readJson(store, `${directory}/project.json`)).name).toBe('Amsterdam 1625');
		});

		it('writes a discrete action immediately, so a closed tab cannot lose it', async () => {
			const autosave = new Autosave(store, { debounceMs: 10_000 });
			const via = new Workspace(store, { autosave, now: () => clock });

			const created = await via.createProject('Amsterdam 1625');

			expect(await store.list('')).toEqual([`${created.directory}/project.json`]);
		});
	});
});

describe('toDirectoryName', () => {
	it.each([
		['Amsterdam 1625', 'amsterdam-1625'],
		['Amsterdam, 1625!', 'amsterdam-1625'],
		['  spaced  out  ', 'spaced-out'],
		['Ångström & Étude', 'angstrom-etude'],
		['UPPER', 'upper'],
		['---', 'project'],
		['日本語', 'project'],
		['a'.repeat(200), 'a'.repeat(64)]
	])('turns %j into %j', (displayName, expected) => {
		expect(toDirectoryName(displayName)).toBe(expected);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ADR-0023: MAP IMAGES AND ALIGNMENTS BELONG TO THE WORKSPACE
//
// The whole of the storage move, asserted against files. "After this sequence of actions the store
// contains these files with this content" is not a proxy for the behaviour here — the user's folder
// *is* the product (CONTRIBUTING.md's testing decisions), and what moved is which files exist and
// where.

describe('the Workspace’s shared Map Images (ADR-0023)', () => {
	let store: MemoryProjectStore;
	let workspace: Workspace;

	const encode = (text: string) => new TextEncoder().encode(text);

	/** One Map Image in the Workspace: a pyramid and the Alignment that places it. */
	const addMapImage = async (imageId: string, tile = 'tile bytes') => {
		await store.write(imageInfoPath(imageId), encode(`{"id":"https://unset.invalid/${imageId}"}`));
		await store.write(`images/${imageId}/0,0,256,256/256,256/0/default.jpg`, encode(tile));
		await seedAlignmentFixture(store, imageId, encode(`{"type":"Annotation","id":"${imageId}"}`));
	};

	beforeEach(() => {
		store = new MemoryProjectStore();
		workspace = new Workspace(store, { now: () => new Date('2026-01-01T00:00:00.000Z') });
	});

	// The behaviour the whole ticket exists to demonstrate. Two Projects, two Layers with their own ids
	// and their own display state, one `imageId` — and therefore **one pyramid and one Alignment on
	// disk**, which is the difference between a semester's work publishing and failing under ADR-0008's
	// ~1 GB budget.
	it('lets two Projects hold a map Layer for the same image, with one pyramid on disk', async () => {
		await addMapImage('floride-1657');
		const mine = await workspace.createProject('My reading');
		const theirs = await workspace.createProject('Course copy');

		for (const [directory, name, opacity] of [
			[mine.directory, 'The 1657 survey', 1],
			[theirs.directory, 'Background sheet', 0.4]
		] as const) {
			const file = await workspace.readProject(directory);
			await workspace.writeProject(directory, {
				...file,
				layers: [
					{ ...newMapLayer({ id: `l-${directory}`, name, imageId: 'floride-1657' }), opacity }
				]
			});
		}

		// Both Projects name the same Map Image, and each keeps its own presentation of it.
		const layers = await Promise.all(
			[mine, theirs].map(async (project) => (await workspace.readProject(project.directory)).layers)
		);
		expect(layers.map((stack) => stack[0])).toMatchObject([
			{ imageId: 'floride-1657', name: 'The 1657 survey', opacity: 1 },
			{ imageId: 'floride-1657', name: 'Background sheet', opacity: 0.4 }
		]);

		// And there is exactly one pyramid and one Alignment, at the Workspace root — no copy inside
		// either Project directory.
		expect(await store.list('images/')).toEqual([
			'images/floride-1657/0,0,256,256/256,256/0/default.jpg',
			'images/floride-1657/info.json'
		]);
		expect(await store.list('alignments/')).toEqual(['alignments/floride-1657.json']);
		for (const project of [mine, theirs]) {
			expect(await store.list(`${project.directory}/`)).toEqual([
				`${project.directory}/project.json`
			]);
		}
	});

	// Tidying up one piece of work must not cost the material. The map was prepared once and may be the
	// only copy of a pyramid that took minutes to tile and gigabytes to hold.
	it('leaves every Map Image and Alignment in place when a Project is deleted', async () => {
		await addMapImage('floride-1657');
		const doomed = await workspace.createProject('A false start');
		const file = await workspace.readProject(doomed.directory);
		await workspace.writeProject(doomed.directory, {
			...file,
			layers: [newMapLayer({ id: 'l1', name: 'The 1657 survey', imageId: 'floride-1657' })]
		});
		const shared = await hashTree(store, 'images/');
		const alignments = await hashTree(store, 'alignments/');

		await workspace.deleteProject(doomed.directory);

		expect(await store.list(`${doomed.directory}/`)).toEqual([]);
		expect(await hashTree(store, 'images/')).toEqual(shared);
		expect(await hashTree(store, 'alignments/')).toEqual(alignments);
	});

	describe('the reserved directory names', () => {
		// `toDirectoryName('Images')` is `images`, so this is reachable by naming a Project rather than by
		// contriving anything — and a Project that landed there would put `project.json` inside the shared
		// pool, where deleting that Project would take every Project's Map Images with it.
		it.each([
			['Images', 'images'],
			['Alignments', 'alignments'],
			['Base Map', 'base-map'],
			['images', 'images'],
			// Case, because APFS and NTFS are both case-insensitive: `getDirectoryHandle('IMAGES')` hands
			// back the existing `images` on the backend most users have.
			['IMAGES', 'images'],
			['bAsE mAp', 'base-map'],
			// Unicode composition, because APFS folds it too. Both spellings of "Ímages" reduce to `images`.
			['\u00cdmages', 'images'],
			['I\u0301mages', 'images']
		])('refuses a Project called %j, naming the reservation', async (displayName, folder) => {
			const failure = await workspace.createProject(displayName).catch((cause) => cause);

			expect(failure).toBeInstanceOf(ReservedDirectoryNameError);
			expect(failure.directory).toBe(folder);
			// The sentence has to name the reservation rather than only refusing: the user typed a perfectly
			// reasonable display name and `toDirectoryName` is what turned it into a collision.
			expect(failure.message).toContain(folder);
			expect(failure.message).toContain('reserved');
			// Refused at creation, so nothing is written at all.
			expect(await store.list('')).toEqual([]);
		});

		it('folds case and Unicode composition, like the collision check', () => {
			expect(isReservedDirectoryName('images')).toBe(true);
			expect(isReservedDirectoryName('IMAGES')).toBe(true);
			expect(isReservedDirectoryName('base-map')).toBe(true);
			expect(isReservedDirectoryName('image')).toBe(false);
			expect(isReservedDirectoryName('images-2')).toBe(false);
			expect(isReservedDirectoryName('my-images')).toBe(false);
		});
	});

	// ADR-0023's split of an archive path, which is the bundle reader's rather than
	// `Workspace`'s: a bundle opens into a Review Workspace and there is no path that writes one into
	// the user's own (ADR-0024). The function still lives here because it is a statement about what a
	// *Workspace* keeps at its root, and `open-project-bundle.ts` is its one caller.
	describe('hoisting an archive path', () => {
		it('splits an archive path the same way the importer does', () => {
			expect(hoistedImageId('images/floride-1657/info.json')).toBe('floride-1657');
			expect(hoistedImageId('images/floride-1657/0,0,256,256/256,256/0/default.jpg')).toBe(
				'floride-1657'
			);
			expect(hoistedImageId('alignments/floride-1657.json')).toBe('floride-1657');
			// The Project's own files stay inside it.
			expect(hoistedImageId('project.json')).toBeNull();
			expect(hoistedImageId('annotations/a.geojson')).toBeNull();
			// And anything that does not name a Map Image is not hoisted to a path its name does not
			// describe: a bare directory entry, a nested Alignment, a name that is only the extension.
			expect(hoistedImageId('images/floride-1657')).toBeNull();
			expect(hoistedImageId('images/')).toBeNull();
			expect(hoistedImageId('alignments/nested/a.json')).toBeNull();
			expect(hoistedImageId('alignments/.json')).toBeNull();
			expect(hoistedImageId('alignments/a.geojson')).toBeNull();
		});
	});
});
