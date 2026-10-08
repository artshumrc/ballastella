import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { seedAlignmentFixture } from '../alignment/alignment-fixture.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { TEMP_PATH_SUFFIX } from '../store/project-store.js';
import { decode, encode, rejection, seeded, snapshot } from '../test-support.js';
import { newMapLayer } from './layer.js';
import { imageInfoPath } from './image-files.js';
import { ProjectFormatTooNewError, newProjectFile } from './project-file.js';
import { DeletedProjects } from '../autosave/deleted-projects.js';
import { FakeJournalStorage } from '../autosave/fake-journal-storage.js';
import type { StoreContentObserver } from '../autosave/journal.js';
import {
	ReservedDirectoryNameError,
	Workspace,
	deletionsAreNoteworthy,
	hoistedImageId,
	isReservedDirectoryName,
	toDirectoryName,
	type ProjectSummary
} from './workspace.js';

const WAS = { name: 'Amsterdam 1625', updatedAt: '2026-08-08T09:00:00.000Z' };
const NOTHING = { finished: [], refused: [], unfinished: [] };
const FUTURE = '{"formatVersion":2,"name":"Tomorrow"}';
const PROJECT = 'amsterdam-1625/project.json';
const MANIFEST = '{"formatVersion":1,"name":"Amsterdam 1625","layers":[],"baseMap":null}';

const readJson = async (store: MemoryProjectStore, path: string) =>
	JSON.parse(decode(await store.read(path)));

const notes = (key = 'opfs:My Workspace', storage = new FakeJournalStorage()) =>
	new DeletedProjects(storage, key);

const unreadable = (
	directory: string,
	overrides: Partial<ProjectSummary> = {}
): ProjectSummary => ({
	directory,
	name: directory,
	description: '',
	updatedAt: '',
	onFrontPage: false,
	problem: 'unreadable',
	...overrides
});

describe('Workspace', () => {
	let store: MemoryProjectStore;
	let clock: Date;
	let workspace: Workspace;

	beforeEach(() => {
		store = new MemoryProjectStore();
		clock = new Date('2026-01-01T00:00:00.000Z');
		workspace = new Workspace(store, { now: () => clock });
	});

	const finish = (deleted: DeletedProjects) =>
		new Workspace(store, { deleted, identity: 'this-browser' }).finishInterruptedDeletions();

	const createWithAnnotation = async (on = workspace) => {
		const created = await on.createProject('Amsterdam 1625');
		await store.write(`${created.directory}/annotations/one.geojson`, new Uint8Array([1]));
		return created;
	};

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

		it('gives a same-named Project its own directory, and names an untitled one', async () => {
			const first = await workspace.createProject('Amsterdam 1625');
			const second = await workspace.createProject('Amsterdam 1625');
			expect([first.directory, second.directory]).toEqual(['amsterdam-1625', 'amsterdam-1625-2']);
			expect(second.name).toBe('Amsterdam 1625');
			expect(await workspace.createProject('   ')).toMatchObject({
				name: 'Untitled Project',
				directory: 'untitled-project'
			});
		});
	});

	describe('listing Projects', () => {
		it('reports each Project’s name and when it was last touched, newest first', async () => {
			await workspace.createProject('Older');
			clock = new Date('2026-06-01T00:00:00.000Z');
			await workspace.createProject('Newer');

			expect(await workspace.listProjects()).toEqual([
				unreadable('newer', {
					name: 'Newer',
					updatedAt: '2026-06-01T00:00:00.000Z',
					problem: null
				}),
				unreadable('older', { name: 'Older', updatedAt: '2026-01-01T00:00:00.000Z', problem: null })
			]);
		});

		it('ignores directories that hold no project.json', async () => {
			await store.write('not-a-project/notes.txt', encode('hello'));
			await workspace.createProject('Real');

			expect((await workspace.listProjects()).map((p) => p.directory)).toEqual(['real']);
		});

		it.each([
			[FUTURE, unreadable('p', { problem: 'format-too-new' })],
			[
				'{"formatVersion":99,"name":"Later","onFrontPage":true}',
				unreadable('p', { problem: 'format-too-new', onFrontPage: true })
			],
			['{ not json', unreadable('p')]
		])('still lists the Project in %s, marked as such', async (manifest, expected) => {
			await store.write('p/project.json', encode(manifest));

			expect(await workspace.listProjects()).toEqual([expected]);
		});

		it('propagates an unreachable workspace instead of pretending it is empty', async () => {
			const unreachable = new Workspace(MemoryProjectStore.unreachable());

			await expect(unreachable.listProjects()).rejects.toThrow('Workspace not reachable');
		});
	});

	describe('opening a Project', () => {
		it('refuses a formatVersion this build does not understand, and leaves the file untouched', async () => {
			const original = '{"formatVersion":2,"name":"Tomorrow","layers":["something new"]}';
			await store.write('from-the-future/project.json', encode(original));

			await rejection(ProjectFormatTooNewError, workspace.readProject('from-the-future'));
			await workspace.listProjects();

			expect(await snapshot(store)).toEqual({ 'from-the-future/project.json': original });
		});

		describe('what the store held, told to whoever is listening', () => {
			const watching = (observer: StoreContentObserver) =>
				new Workspace(store, { now: () => clock, observer });

			it('reports the bytes it read, with a token taken before the read so a save in flight survives', async () => {
				await store.write('amsterdam-1625/project.json', encode(MANIFEST));
				let counter = 0;
				const seen: [string, string, number][] = [];
				const read = store.read.bind(store);
				store.read = async (path) => {
					const bytes = await read(path);
					counter += 10;
					return bytes;
				};

				await watching({
					mark: () => (counter += 1),
					observe: (path, bytes, at) => seen.push([path, decode(bytes), at])
				}).readProject('amsterdam-1625');

				expect(seen).toEqual([['amsterdam-1625/project.json', MANIFEST, 1]]);
			});

			it('reports a manifest it refuses to parse, and nothing when there was nothing to read', async () => {
				await store.write('from-the-future/project.json', encode(FUTURE));
				const seen: string[] = [];
				const watched = watching({ mark: () => 1, observe: (path) => seen.push(path) });

				await watched.readProject('never-existed').catch(() => undefined);
				await watched.readProject('from-the-future').catch(() => undefined);

				expect(seen).toEqual(['from-the-future/project.json']);
			});
		});

		it('writes nothing at all when a Project is opened and closed without an edit', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');
			await store.write(`${directory}/annotations/one.geojson`, encode('{"w":1}'));
			const before = await snapshot(store);
			const autosave = new Autosave(store);
			const session = new Workspace(store, { autosave, now: () => clock });
			const write = vi.spyOn(store, 'write');

			await session.readProject(directory);
			await autosave.flush();

			expect(write).not.toHaveBeenCalled();
			expect(await snapshot(store)).toEqual(before);
		});
	});

	describe('renaming a Project', () => {
		it('changes the display name in project.json, keeps everything else and the directory', async () => {
			await store.write(
				'p/project.json',
				encode('{"formatVersion":1,"name":"Old","baseMap":"protomaps-light"}')
			);
			clock = new Date('2026-02-02T00:00:00.000Z');

			await workspace.updateProjectDetails('p', { name: 'New' });

			expect(await readJson(store, 'p/project.json')).toEqual({
				formatVersion: 1,
				name: 'New',
				updatedAt: '2026-02-02T00:00:00.000Z',
				layers: [],
				baseMap: 'protomaps-light'
			});
			expect(await store.list('')).toEqual(['p/project.json']);
		});

		it('succeeds when the new display name is already another Project’s', async () => {
			const first = await workspace.createProject('Amsterdam 1625');
			const second = await workspace.createProject('Boston 1775');

			await workspace.updateProjectDetails(second.directory, { name: 'Amsterdam 1625' });

			const projects = await workspace.listProjects();
			expect(projects.map((p) => p.name)).toEqual(['Amsterdam 1625', 'Amsterdam 1625']);
			expect(projects.map((p) => p.directory).sort()).toEqual([first.directory, second.directory]);
		});
	});

	describe('choosing whether a Project is on the Front Page', () => {
		it('starts off it, goes on and back off, in the file the list is read from', async () => {
			const created = await workspace.createProject('Amsterdam 1625');
			const { directory } = created;
			const listed = async () => (await workspace.listProjects())[0]?.onFrontPage;
			expect(created.onFrontPage).toBe(false);
			expect(await listed()).toBe(false);
			expect((await workspace.setProjectOnFrontPage(directory, true)).onFrontPage).toBe(true);
			expect((await readJson(store, `${directory}/project.json`)).onFrontPage).toBe(true);
			expect(await listed()).toBe(true);
			expect((await workspace.setProjectOnFrontPage(directory, false)).onFrontPage).toBe(false);
			expect(await readJson(store, `${directory}/project.json`)).not.toHaveProperty('onFrontPage');
			expect(await listed()).toBe(false);
		});

		it('changes nothing else about the Project, not even when it was last touched', async () => {
			const was = {
				formatVersion: 1,
				name: 'Old',
				updatedAt: '2026-01-01T00:00:00.000Z',
				baseMap: 'protomaps-light'
			};
			await store.write('p/project.json', encode(JSON.stringify(was)));
			await store.write('p/annotations/a.geojson', encode('{"w":1}'));
			clock = new Date('2026-09-09T09:09:09.000Z');

			await workspace.setProjectOnFrontPage('p', true);

			expect(await readJson(store, 'p/project.json')).toEqual({
				...was,
				layers: [],
				onFrontPage: true
			});
			expect((await workspace.listProjects())[0]?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
			expect(await store.list('p/')).toEqual(['p/annotations/a.geojson', 'p/project.json']);
		});
	});

	describe('duplicating a Project', () => {
		it('copies every file into a new directory marked as a copy, off the Front Page, and leaves the original alone', async () => {
			const { directory } = await workspace.createProject('Amsterdam 1625');
			await workspace.setProjectOnFrontPage(directory, true);
			await store.write(`${directory}/annotations/one.geojson`, encode('{"w":1}'));
			await store.write(`${directory}/annotations/a.geojson`, encode('{}'));
			const before = await snapshot(store, `${directory}/`);
			const copy = await workspace.duplicateProject(directory);
			expect(copy).toMatchObject({ name: 'Amsterdam 1625 (copy)', onFrontPage: false });
			expect(await store.list(`${copy.directory}/`)).toEqual([
				'amsterdam-1625-copy/annotations/a.geojson',
				'amsterdam-1625-copy/annotations/one.geojson',
				'amsterdam-1625-copy/project.json'
			]);
			expect(decode(await store.read(`${copy.directory}/annotations/one.geojson`))).toBe('{"w":1}');
			expect(await snapshot(store, `${directory}/`)).toEqual(before);
		});
	});

	describe('deleting a Project', () => {
		it('removes every file in it, half-finished writes too, and nothing else', async () => {
			const doomed = await createWithAnnotation();
			const kept = await workspace.createProject('Boston 1775');
			store.plant(`${doomed.directory}/.project.json.abandoned${TEMP_PATH_SUFFIX}`, encode('half'));

			await workspace.deleteProject(doomed.directory);

			expect([...store.snapshot().keys()]).toEqual([`${kept.directory}/project.json`]);
			expect((await workspace.listProjects()).map((p) => p.directory)).toEqual([kept.directory]);
		});

		it('writes the gesture down before its first await, so a lost page does not lose it', async () => {
			const deleted = notes();
			const stalled = new MemoryProjectStore();
			stalled.list = () => new Promise<never>(() => undefined);
			const halted = new Workspace(stalled, { deleted, identity: 'this-browser' });

			void halted.deleteProject('amsterdam-1625', WAS);

			expect(deleted.pending()).toEqual([{ directory: 'amsterdam-1625', was: WAS }]);
		});

		it('forgets the record once the removal has actually happened', async () => {
			const deleted = notes();
			const recording = new Workspace(store, { deleted, identity: 'this-browser' });
			const doomed = await recording.createProject('Amsterdam 1625');

			await recording.deleteProject(doomed.directory, doomed);

			expect(deleted.pending()).toEqual([]);
			expect(deleted.has(doomed.directory)).toBe(false);
		});

		it('deletes anyway when a write will not settle, and keeps the record because it might land', async () => {
			const deleted = notes();
			const stuck = new MemoryProjectStore();
			const autosave = new Autosave(stuck, { debounceMs: 1, inFlightWaitMs: 10 });
			const recording = new Workspace(stuck, { autosave, deleted, identity: 'this-browser' });
			const doomed = await recording.createProject('Amsterdam 1625');
			stuck.write = () => new Promise<never>(() => undefined);
			autosave.queue(`${doomed.directory}/project.json`, new Uint8Array([1]));
			await new Promise((resolve) => setTimeout(resolve, 5));

			await recording.deleteProject(doomed.directory, doomed);

			expect(await stuck.list('')).toEqual([]);
			expect(deleted.has(doomed.directory)).toBe(true);
		});

		it.each([false, true])(
			'finishes at the next startup a deletion the page did not live to finish (half done: %s)',
			async (halfDone) => {
				const deleted = notes();
				const doomed = await createWithAnnotation();
				if (halfDone) {
					await store.write(`${doomed.directory}/annotations/two.geojson`, new Uint8Array([1]));
					await store.delete(`${doomed.directory}/annotations/one.geojson`);
				}
				const kept = await workspace.createProject('Boston 1775');
				deleted.record(doomed.directory, doomed);

				expect(await finish(deleted)).toEqual({ ...NOTHING, finished: [doomed.directory] });
				expect(await store.list('')).toEqual([`${kept.directory}/project.json`]);
				expect(deleted.pending()).toEqual([]);
			}
		);

		it('keeps a deletion it could not finish, and names it rather than counting it', async () => {
			const deleted = notes();
			deleted.record('amsterdam-1625', WAS);

			const outcome = await new Workspace(MemoryProjectStore.unreachable(), {
				deleted
			}).finishInterruptedDeletions();

			expect(outcome).toEqual({ ...NOTHING, unfinished: ['amsterdam-1625'] });
			expect(deleted.pending().map((record) => record.directory)).toEqual(['amsterdam-1625']);
		});

		it.each([
			['a new Project', 'amsterdam-1625', (on: Workspace) => on.createProject('Amsterdam 1625')],
			[
				'a duplicate',
				'amsterdam-1625-copy',
				async (on: Workspace) =>
					on.duplicateProject((await on.createProject('Amsterdam 1625')).directory)
			]
		])(
			'drops the record when %s claims the deleted one’s folder name, sweep or no sweep',
			async (_case, directory, claim) => {
				const deleted = notes();
				deleted.record(directory, WAS);
				const recording = new Workspace(store, { deleted, identity: 'this-browser' });

				expect((await claim(recording)).directory).toBe(directory);
				expect(deleted.pending()).toEqual([]);
				expect(await recording.finishInterruptedDeletions()).toEqual(NOTHING);
				expect(await store.list(`${directory}/`)).toEqual([`${directory}/project.json`]);
			}
		);

		it('removes the manifest last, so an interrupted deletion keeps its evidence', async () => {
			const doomed = await createWithAnnotation();
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

		it('refuses to finish a deletion against a different Project in a same-named folder', async () => {
			const storage = new FakeJournalStorage();
			notes('folder:maps', storage).record('amsterdam-1625', WAS);
			const other = new MemoryProjectStore();
			const theirs = new Workspace(other, {
				deleted: notes('folder:maps', storage),
				identity: 'a-name-anywhere'
			});
			await theirs.writeProject(
				'amsterdam-1625',
				newProjectFile('Amsterdam 1625', new Date('2026-08-01T00:00:00.000Z'))
			);
			await other.write('amsterdam-1625/annotations/theirs.geojson', new Uint8Array([9]));

			const outcome = await theirs.finishInterruptedDeletions();

			expect(outcome).toEqual({
				...NOTHING,
				refused: [
					{
						directory: 'amsterdam-1625',
						detail: expect.stringContaining('will not remove it on its own')
					}
				]
			});
			expect(await other.list('')).toEqual([
				'amsterdam-1625/annotations/theirs.geojson',
				'amsterdam-1625/project.json'
			]);
			expect(notes('folder:maps', storage).has('amsterdam-1625')).toBe(true);
		});

		it('refuses to finish a deletion against a byte-identical copy of the deleted Project', async () => {
			const storage = new FakeJournalStorage();
			const laptop = new MemoryProjectStore();
			const doomed = await new Workspace(laptop, { now: () => clock }).createProject(
				'Amsterdam 1625'
			);
			await laptop.write(`${doomed.directory}/annotations/one.geojson`, new Uint8Array([1]));
			notes('folder:maps', storage).record(doomed.directory, doomed);
			const backup = await seeded(await snapshot(laptop));

			const outcome = await new Workspace(backup, {
				deleted: notes('folder:maps', storage),
				identity: 'a-name-anywhere'
			}).finishInterruptedDeletions();

			expect(outcome.finished).toEqual([]);
			expect(await backup.list('')).toEqual([
				`${doomed.directory}/annotations/one.geojson`,
				`${doomed.directory}/project.json`
			]);
			expect(outcome.refused.map((entry) => entry.detail)).toEqual([
				expect.stringContaining('will not remove it on its own')
			]);
		});

		it('finishes nothing unattended for a caller that did not say what the Workspace is', async () => {
			const deleted = notes();
			const doomed = await createWithAnnotation();
			deleted.record(doomed.directory, doomed);

			const outcome = await new Workspace(store, { deleted }).finishInterruptedDeletions();
			expect(outcome.finished).toEqual([]);
			expect(outcome.refused.map((entry) => entry.directory)).toEqual([doomed.directory]);
			expect(await store.list('')).toEqual([
				`${doomed.directory}/annotations/one.geojson`,
				`${doomed.directory}/project.json`
			]);
		});

		it('removes nothing from a directory that has files and no manifest', async () => {
			const deleted = notes();
			await store.write('amsterdam-1625/annotations/one.geojson', new Uint8Array([1]));
			await store.write('amsterdam-1625/annotations/two.geojson', new Uint8Array([2]));
			store.plant(`amsterdam-1625/.project.json.abandoned${TEMP_PATH_SUFFIX}`, encode('half'));
			deleted.record('amsterdam-1625', WAS);

			expect(await finish(deleted)).toEqual(NOTHING);
			const left = ['one', 'two'].map((n) => `amsterdam-1625/annotations/${n}.geojson`);
			expect(await store.list('')).toEqual(left);
			expect([...store.snapshot().keys()].sort()).toEqual(left);
			expect(deleted.pending()).toEqual([]);
		});

		it.each([
			[
				'carries no name',
				JSON.stringify({ formatVersion: 1, updatedAt: '2026-08-01T00:00:00.000Z' })
			],
			['was already unreadable', 'not json']
		])('finishes the deletion of a Project whose manifest %s', async (_case, manifest) => {
			const deleted = notes();
			await store.write('amsterdam-1625/project.json', encode(manifest));
			const [listed] = await workspace.listProjects();
			expect(listed?.name).toBe('amsterdam-1625');
			deleted.record('amsterdam-1625', listed!);

			expect(await finish(deleted)).toEqual({ ...NOTHING, finished: ['amsterdam-1625'] });
			expect(await store.list('')).toEqual([]);
		});

		it('refuses to finish a deletion against a Project the user has since edited', async () => {
			const deleted = notes();
			const recording = new Workspace(store, {
				deleted,
				identity: 'this-browser',
				now: () => clock
			});
			const doomed = await recording.createProject('Amsterdam 1625');
			deleted.record(doomed.directory, doomed);
			clock = new Date('2027-01-01T00:00:00.000Z');
			await recording.updateProjectDetails(doomed.directory, { name: 'Amsterdam 1625, revisited' });

			const outcome = await recording.finishInterruptedDeletions();
			expect(outcome.refused.map((entry) => entry.directory)).toEqual([doomed.directory]);
			expect((await recording.listProjects()).map((project) => project.name)).toEqual([
				'Amsterdam 1625, revisited'
			]);
		});

		it.each([
			['whose record names no target', PROJECT, MANIFEST, null, true],
			['at an unreadable manifest the record called readable', PROJECT, 'not json', WAS, true],
			[
				'naming a Workspace directory',
				'images/abc/info.json',
				'{}',
				{ name: 'images', updatedAt: '' },
				false
			]
		])('refuses a deletion %s', async (_case, path, content, was, kept) => {
			const deleted = notes();
			const directory = path.split('/')[0]!;
			await store.write(path, encode(content));
			deleted.record(directory, was);

			const outcome = await finish(deleted);
			expect(outcome.refused.map((entry) => entry.directory)).toEqual([directory]);
			expect(await store.list('')).toEqual([path]);
			expect(deleted.pending().length).toBe(kept ? 1 : 0);
		});

		it('says nothing about a record whose Project had already gone', async () => {
			const deleted = notes();
			deleted.record('amsterdam-1625', WAS);

			expect(await finish(deleted)).toEqual(NOTHING);
			expect(deleted.pending()).toEqual([]);
		});

		it.each([
			[NOTHING, false],
			[{ ...NOTHING, finished: ['amsterdam-1625'] }, true],
			[
				{ ...NOTHING, refused: [{ directory: 'amsterdam-1625', detail: 'Nothing was removed.' }] },
				true
			],
			[{ ...NOTHING, unfinished: ['amsterdam-1625'] }, true]
		])('says a startup’s deletions %j are noteworthy: %s', (report, noteworthy) => {
			expect(deletionsAreNoteworthy(report)).toBe(noteworthy);
		});

		it('says so when the browser will not write the deletion down, and deletes anyway', async () => {
			const storage = new FakeJournalStorage();
			storage.setItem = () => {
				throw new DOMException('blocked', 'SecurityError');
			};
			const refused: string[] = [];
			const recording = new Workspace(store, {
				deleted: notes('opfs:My Workspace', storage),
				onDeletionNotRecorded: (directory) => refused.push(directory)
			});
			const doomed = await recording.createProject('Amsterdam 1625');

			await recording.deleteProject(doomed.directory, doomed);

			expect(refused).toEqual([doomed.directory]);
			expect(await store.list('')).toEqual([]);
		});
	});

	describe('routing writes through autosave', () => {
		const via = (debounceMs: number) =>
			new Workspace(store, { autosave: new Autosave(store, { debounceMs }), now: () => clock });

		it('coalesces a debounced rename and writes once', async () => {
			vi.useFakeTimers();
			try {
				const workspace = via(400);
				const { directory } = await workspace.createProject('Amsterdam 1625');
				const write = vi.spyOn(store, 'write');

				for (const name of ['A', 'Am', 'Ams']) {
					await workspace.updateProjectDetails(directory, { name }, { debounce: true });
				}
				await vi.advanceTimersByTimeAsync(400);

				expect(write).toHaveBeenCalledTimes(1);
				expect((await readJson(store, `${directory}/project.json`)).name).toBe('Ams');
			} finally {
				vi.useRealTimers();
			}
		});

		it('reports a rejected write to its caller rather than resolving', async () => {
			const workspace = via(400);
			const { directory } = await workspace.createProject('Amsterdam 1625');
			vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('quota exceeded'));

			await expect(
				workspace.updateProjectDetails(directory, { name: 'Amsterdam 1626' })
			).rejects.toThrow('quota exceeded');
			expect((await readJson(store, `${directory}/project.json`)).name).toBe('Amsterdam 1625');
		});

		it('writes a discrete action immediately, so a closed tab cannot lose it', async () => {
			const created = await via(10_000).createProject('Amsterdam 1625');
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

describe('the Workspace’s shared Map Images (ADR-0023)', () => {
	let store: MemoryProjectStore;
	let workspace: Workspace;

	const addMapImage = async (imageId: string) => {
		await store.write(imageInfoPath(imageId), encode(`{"id":"https://unset.invalid/${imageId}"}`));
		await store.write(`images/${imageId}/0,0,256,256/256,256/0/default.jpg`, encode('tile bytes'));
		await seedAlignmentFixture(store, imageId, encode(`{"type":"Annotation","id":"${imageId}"}`));
	};

	const drawMap = async (directory: string, name: string, opacity = 1) => {
		const file = await workspace.readProject(directory);
		await workspace.writeProject(directory, {
			...file,
			layers: [{ ...newMapLayer({ id: `l-${directory}`, name, imageId: 'floride-1657' }), opacity }]
		});
	};

	beforeEach(() => {
		store = new MemoryProjectStore();
		workspace = new Workspace(store, { now: () => new Date('2026-01-01T00:00:00.000Z') });
	});

	it('lets two Projects hold a map Layer for the same image, with one pyramid on disk', async () => {
		await addMapImage('floride-1657');
		const mine = await workspace.createProject('My reading');
		const theirs = await workspace.createProject('Course copy');
		await drawMap(mine.directory, 'The 1657 survey');
		await drawMap(theirs.directory, 'Background sheet', 0.4);

		const layers = await Promise.all(
			[mine, theirs].map(async (project) => (await workspace.readProject(project.directory)).layers)
		);
		expect(layers.map((stack) => stack[0])).toMatchObject([
			{ imageId: 'floride-1657', name: 'The 1657 survey', opacity: 1 },
			{ imageId: 'floride-1657', name: 'Background sheet', opacity: 0.4 }
		]);
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

	it('leaves every Map Image and Alignment in place when a Project is deleted', async () => {
		await addMapImage('floride-1657');
		const doomed = await workspace.createProject('A false start');
		await drawMap(doomed.directory, 'The 1657 survey');
		const shared = {
			...(await snapshot(store, 'images/')),
			...(await snapshot(store, 'alignments/'))
		};

		await workspace.deleteProject(doomed.directory);

		expect(await snapshot(store)).toEqual(shared);
	});

	describe('the reserved directory names', () => {
		it.each([
			['Images', 'images'],
			['Alignments', 'alignments'],
			['Base Map', 'base-map'],
			['images', 'images'],
			['IMAGES', 'images'],
			['bAsE mAp', 'base-map'],
			['Ímages', 'images'],
			['Ímages', 'images']
		])('refuses a Project called %j, naming the reservation', async (displayName, folder) => {
			const failure = await rejection(
				ReservedDirectoryNameError,
				workspace.createProject(displayName)
			);

			expect(failure.directory).toBe(folder);
			expect(failure.message).toContain(folder);
			expect(failure.message).toContain('reserved');
			expect(await store.list('')).toEqual([]);
		});

		it('folds case and Unicode composition, like the collision check', () => {
			expect(
				['images', 'IMAGES', 'base-map', 'image', 'images-2', 'my-images'].map(
					isReservedDirectoryName
				)
			).toEqual([true, true, true, false, false, false]);
		});
	});

	it.each([
		['images/floride-1657/info.json', 'floride-1657'],
		['images/floride-1657/0,0,256,256/256,256/0/default.jpg', 'floride-1657'],
		['alignments/floride-1657.json', 'floride-1657'],
		['project.json', null],
		['annotations/a.geojson', null],
		['images/floride-1657', null],
		['images/', null],
		['alignments/nested/a.json', null],
		['alignments/.json', null],
		['alignments/a.geojson', null]
	])('hoists the archive path %j to the image %j', (path, imageId) => {
		expect(hoistedImageId(path)).toBe(imageId);
	});
});
