import { afterEach, describe, expect, it } from 'vitest';

import {
	MAX_WORKSPACE_NAME_LENGTH,
	createOpfsWorkspace,
	deleteOpfsWorkspace,
	ensureOpfsWorkspace,
	listOpfsWorkspaces,
	openOpfsWorkspace,
	toWorkspaceName
} from './opfs-workspaces.js';
import { encode } from '../test-support.js';

const made: string[] = [];
const uniquely = (label: string): string => `${label} ${crypto.randomUUID()}`;

const remember = async (name: string): Promise<string> => {
	made.push(name);
	return name;
};

afterEach(async () => {
	for (const name of made.splice(0)) await deleteOpfsWorkspace(name).catch(() => undefined);
});

describe('the OPFS root holds several named Workspaces', () => {
	it('lists a Workspace once it has been made, and not before', async () => {
		const name = uniquely('Listing');
		expect(await listOpfsWorkspaces()).not.toContain(name);

		await remember(await ensureOpfsWorkspace(name));

		expect(await listOpfsWorkspaces()).toContain(name);
	});

	it('lists a brand new Workspace before anything has been written into it', async () => {
		const name = await remember(await createOpfsWorkspace(uniquely('Empty')));
		expect(await listOpfsWorkspaces()).toContain(name);
		expect(await openOpfsWorkspace(name).list('')).toEqual([]);
	});

	it('keeps each Workspace’s Projects to itself', async () => {
		const mine = await remember(await createOpfsWorkspace(uniquely('Mine')));
		const theirs = await remember(await createOpfsWorkspace(uniquely('Theirs')));

		await openOpfsWorkspace(mine).write('amsterdam-1625/project.json', encode('{}'));

		expect(await openOpfsWorkspace(theirs).list('')).toEqual([]);
		expect(await openOpfsWorkspace(mine).list('')).toEqual(['amsterdam-1625/project.json']);
	});

	it('suffixes a name already taken rather than opening the Workspace that has it', async () => {
		const wanted = uniquely('Marking');
		const first = await remember(await createOpfsWorkspace(wanted));
		const second = await remember(await createOpfsWorkspace(wanted));
		expect(second).not.toBe(first);
		expect(second).toBe(`${wanted} (2)`);
	});

	it('suffixes a name that is already at the length cap, rather than spinning for ever', async () => {
		const stem = `Marking ${crypto.randomUUID()}`.padEnd(MAX_WORKSPACE_NAME_LENGTH, 'x');
		const preferred = toWorkspaceName(stem);
		expect([...preferred].length).toBe(MAX_WORKSPACE_NAME_LENGTH);
		const first = await remember(await createOpfsWorkspace(preferred));
		const second = await remember(await createOpfsWorkspace(preferred));
		const third = await remember(await createOpfsWorkspace(preferred));
		expect(first).toBe(preferred);
		expect(new Set([first, second, third]).size).toBe(3);
		for (const name of [second, third]) {
			expect([...name].length, name).toBeLessThanOrEqual(MAX_WORKSPACE_NAME_LENGTH);
			expect(name, name).toMatch(/ \(\d+\)$/);
		}
	}, 15_000);

	it('treats a name differing only in case as taken, the way APFS and NTFS do', async () => {
		const wanted = uniquely('Case');
		const first = await remember(await createOpfsWorkspace(wanted));
		const second = await remember(await createOpfsWorkspace(wanted.toUpperCase()));
		expect(second).not.toBe(first);
		expect(second.toLowerCase()).not.toBe(first.toLowerCase());
	});

	it('deletes a Workspace and everything in it', async () => {
		const name = await remember(await createOpfsWorkspace(uniquely('Doomed')));
		await openOpfsWorkspace(name).write('p/project.json', encode('{}'));
		await openOpfsWorkspace(name).write('images/blaeu/info.json', encode('{}'));

		await deleteOpfsWorkspace(name);

		expect(await listOpfsWorkspaces()).not.toContain(name);
		expect(await openOpfsWorkspace(name).list('')).toEqual([]);
	});

	it('leaves every other Workspace alone when one is deleted', async () => {
		const kept = await remember(await createOpfsWorkspace(uniquely('Kept')));
		const doomed = await remember(await createOpfsWorkspace(uniquely('Gone')));
		await openOpfsWorkspace(kept).write('p/project.json', encode('{"n":1}'));

		await deleteOpfsWorkspace(doomed);

		expect(await openOpfsWorkspace(kept).list('')).toEqual(['p/project.json']);
	});
});
