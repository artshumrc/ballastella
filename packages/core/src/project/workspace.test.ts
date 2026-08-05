import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Autosave } from '../autosave/autosave.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { ProjectFormatTooNewError } from './project-file.js';
import { Workspace, toDirectoryName } from './workspace.js';

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
			await store.write(`${directory}/images/one/info.json`, new TextEncoder().encode('{"w":1}'));
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
			await store.write(`${directory}/images/one/info.json`, new TextEncoder().encode('{"w":1}'));
			await store.write(
				`${directory}/annotations/a.geojson`,
				new TextEncoder().encode('{"type":"FeatureCollection","features":[]}')
			);

			const copy = await workspace.duplicateProject(directory);

			expect(await store.list(`${copy.directory}/`)).toEqual([
				'amsterdam-1625-copy/annotations/a.geojson',
				'amsterdam-1625-copy/images/one/info.json',
				'amsterdam-1625-copy/project.json'
			]);
			expect(decode(await store.read(`${copy.directory}/images/one/info.json`))).toBe('{"w":1}');
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
			await store.write(`${doomed.directory}/images/one/info.json`, new Uint8Array([1]));
			const kept = await workspace.createProject('Boston 1775');

			await workspace.deleteProject(doomed.directory);

			expect(await store.list('')).toEqual([`${kept.directory}/project.json`]);
			expect((await workspace.listProjects()).map((p) => p.directory)).toEqual([kept.directory]);
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
