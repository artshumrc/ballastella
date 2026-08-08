import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX } from '../store/project-store.js';
import { newMapLayer } from './layer.js';
import { imageInfoPath } from './image-files.js';
import { ProjectFormatTooNewError } from './project-file.js';
import { DeletedProjects } from '../autosave/deleted-projects.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import {
	ReservedDirectoryNameError,
	Workspace,
	hoistedImageId,
	isReservedDirectoryName,
	toDirectoryName
} from './workspace.js';

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
					updatedAt: '2026-06-01T00:00:00.000Z',
					problem: null
				},
				{ directory: 'older', name: 'Older', updatedAt: '2026-01-01T00:00:00.000Z', problem: null }
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
					updatedAt: '',
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
		 * ⚠ **The whole of ticket 21, and why `--repeat-each=20` on the e2e was 4 flaky in 20.**
		 *
		 * A deletion is as asynchronous as an edit and had none of ticket 20's protection: it lists,
		 * deletes each file, then reclaims — and a document being unloaded runs none of those
		 * continuations. The store below stalls on the **first** of them, which is where the browser
		 * measurement said the real failure stopped.
		 *
		 * What is asserted is not that the deletion finishes — it cannot, the page is gone — but that
		 * the *gesture* was written down synchronously, so the next startup can carry it out. That is
		 * the discrimination the application actually has: “the user deleted this Project”, not “this
		 * Project's files are not there right now”, which is a guess and is the shape of the two fresh
		 * data-loss paths ticket 20's first cut opened.
		 */
		it('writes the gesture down before its first await, so a lost page does not lose it', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const stalled = new MemoryProjectStore();
			// A store that never answers, standing in for a page that stops running its continuations.
			stalled.list = () => new Promise<never>(() => undefined);
			const halted = new Workspace(stalled, { deleted });

			void halted.deleteProject('amsterdam-1625');

			// Synchronously, in the same turn as the call: there is no `await` between these two lines.
			expect(deleted.pending()).toEqual(['amsterdam-1625']);
		});

		/**
		 * The counterpart to the test above, and the reason the record is not a tombstone: it is
		 * dropped the moment the removal it names has actually happened, so in ordinary use nothing
		 * accumulates and no startup does work that has already been done. Dropped **after** the
		 * removal resolved, never beside it — nothing is reported done that was not done.
		 */
		it('forgets the record once the removal has actually happened', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const recording = new Workspace(store, { deleted });
			const doomed = await recording.createProject('Amsterdam 1625');

			await recording.deleteProject(doomed.directory);

			expect(deleted.pending()).toEqual([]);
			expect(deleted.has(doomed.directory)).toBe(false);
		});

		it('finishes at the next startup a deletion the page did not live long enough to finish', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const doomed = await workspace.createProject('Amsterdam 1625');
			await store.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			const kept = await workspace.createProject('Boston 1775');
			// Exactly what the interrupted page left behind: the record, and every file still there.
			deleted.record(doomed.directory);

			// A new session over the same Workspace and the same record — a reload.
			const restarted = new Workspace(store, { deleted });
			const outcome = await restarted.finishInterruptedDeletions();

			expect(outcome).toEqual({ finished: [doomed.directory], unfinished: [] });
			expect(await store.list('')).toEqual([`${kept.directory}/project.json`]);
			// And the record goes with it, so the next startup does no work and — more to the point —
			// cannot delete a Project that later takes the same folder name.
			expect(deleted.pending()).toEqual([]);
		});

		it('keeps a deletion it could not finish, and names it rather than counting it', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			deleted.record('amsterdam-1625');

			const unreachable = new Workspace(MemoryProjectStore.unreachable(), { deleted });
			const outcome = await unreachable.finishInterruptedDeletions();

			// Kept, for the same reason `replayJournal` keeps a failed write: an unplugged drive must
			// cost a delay, never the gesture.
			expect(outcome).toEqual({ finished: [], unfinished: ['amsterdam-1625'] });
			expect(deleted.pending()).toEqual(['amsterdam-1625']);
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
			const recording = new Workspace(store, { deleted });
			const doomed = await recording.createProject('Amsterdam 1625');
			await recording.deleteProject(doomed.directory);
			// As if the deletion had finished on disk but the record had not been dropped.
			deleted.record(doomed.directory);

			const replacement = await recording.createProject('Amsterdam 1625');

			expect(replacement.directory).toBe(doomed.directory);
			expect(deleted.pending()).toEqual([]);
			// And the startup that follows leaves it alone, which is the failure being prevented.
			await recording.finishInterruptedDeletions();
			expect(await store.list('')).toEqual([`${replacement.directory}/project.json`]);
		});

		it('drops the record when a duplicate claims the folder name', async () => {
			const deleted = new DeletedProjects(new FakeJournalStorage(), 'opfs:My Workspace');
			const recording = new Workspace(store, { deleted });
			const original = await recording.createProject('Amsterdam 1625');
			deleted.record('amsterdam-1625-copy');

			const copy = await recording.duplicateProject(original.directory);

			expect(copy.directory).toBe('amsterdam-1625-copy');
			expect(deleted.pending()).toEqual([]);
		});

		it('takes the half-finished writes with it, so nothing survives on disk', async () => {
			const doomed = await workspace.createProject('Amsterdam 1625');
			// What a tab that died between the two steps of an atomic write leaves. `list` cannot
			// report it and `delete` cannot be handed it, so before `reclaimAbandonedWrites` the
			// "deleted" Project's directory survived permanently — outside the `list` + `size` totals
			// tickets 15 and 16 need, and in ticket 12's real folder a dotfile committed to git.
			store.plant(
				`${doomed.directory}/.project.json.abandoned${TEMP_PATH_SUFFIX}`,
				new TextEncoder().encode('half a document')
			);

			await workspace.deleteProject(doomed.directory);

			expect([...store.snapshot().keys()]).toEqual([]);
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
// ADR-0023: HISTORICAL MAPS AND ALIGNMENTS BELONG TO THE WORKSPACE
//
// The whole of the storage move, asserted against files. "After this sequence of actions the store
// contains these files with this content" is not a proxy for the behaviour here — the user's folder
// *is* the product (SPEC, Testing Decisions), and what moved is which files exist and where.

describe('the Workspace’s shared Historical Maps (ADR-0023)', () => {
	let store: MemoryProjectStore;
	let workspace: Workspace;

	const encode = (text: string) => new TextEncoder().encode(text);

	/** One Historical Map in the Workspace: a pyramid and the Alignment that places it. */
	const addHistoricalMap = async (imageId: string, tile = 'tile bytes') => {
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
		await addHistoricalMap('floride-1657');
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

		// Both Projects name the same Historical Map, and each keeps its own presentation of it.
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

	// SPEC story 66: tidying up one piece of work must not cost the material. The map was prepared once
	// and may be the only copy of a pyramid that took minutes to tile and gigabytes to hold.
	it('leaves every Historical Map and Alignment in place when a Project is deleted', async () => {
		await addHistoricalMap('floride-1657');
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
		// pool, where deleting that Project would take every Project's Historical Maps with it.
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

	// ADR-0023's split of an archive path, which since ticket 14 is the bundle reader's rather than
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
			// And anything that does not name a Historical Map is not hoisted to a path its name does not
			// describe: a bare directory entry, a nested Alignment, a name that is only the extension.
			expect(hoistedImageId('images/floride-1657')).toBeNull();
			expect(hoistedImageId('images/')).toBeNull();
			expect(hoistedImageId('alignments/nested/a.json')).toBeNull();
			expect(hoistedImageId('alignments/.json')).toBeNull();
			expect(hoistedImageId('alignments/a.geojson')).toBeNull();
		});
	});
});
