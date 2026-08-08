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

/**
 * The OPFS root as a place holding several named Workspaces (ADR-0024), in a real browser.
 *
 * There is no OPFS in Node and a stub of one would only prove the stub agrees with itself — the same
 * argument `opfs-project-store.browser.test.ts` makes. The name normalisation and the persistence
 * request need neither, and are asserted in `opfs-workspaces.test.ts` in Node.
 *
 * ⚠ **Every assertion about the listing is a containment**, deliberately. The root really is shared:
 * the two adapter suites' `scratchDirectory()` fixtures are directories in it, so under this module's
 * own contract they *are* Workspaces. Asserting an exact list would be asserting the order the whole
 * package's test files happened to run in, which is a test of the runner.
 */

/** Workspaces this file made, removed afterwards so the root does not accumulate. */
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
		// The store creates its directory lazily, at the first write. Left to that, a Workspace the user
		// has just made and switched into would be missing from the switcher until they typed something
		// — so `create` is eager and this is what says so.
		const name = await remember(await createOpfsWorkspace(uniquely('Empty')));

		expect(await listOpfsWorkspaces()).toContain(name);
		expect(await openOpfsWorkspace(name).list('')).toEqual([]);
	});

	it('keeps each Workspace’s Projects to itself', async () => {
		const mine = await remember(await createOpfsWorkspace(uniquely('Mine')));
		const theirs = await remember(await createOpfsWorkspace(uniquely('Theirs')));

		await openOpfsWorkspace(mine).write(
			'amsterdam-1625/project.json',
			new TextEncoder().encode('{}')
		);

		expect(await openOpfsWorkspace(theirs).list('')).toEqual([]);
		expect(await openOpfsWorkspace(mine).list('')).toEqual(['amsterdam-1625/project.json']);
	});

	it('suffixes a name already taken rather than opening the Workspace that has it', async () => {
		// Two Workspaces under one directory is one Workspace showing another's Projects. Suffixed
		// rather than refused: "Marking 2026 (2)" beside "Marking 2026" is what a teacher opening a
		// second batch means, and a dialog in the way of that is a dialog in the way of the feature.
		const wanted = uniquely('Marking');
		const first = await remember(await createOpfsWorkspace(wanted));
		const second = await remember(await createOpfsWorkspace(wanted));

		expect(second).not.toBe(first);
		expect(second).toBe(`${wanted} (2)`);
	});

	it('suffixes a name that is already at the length cap, rather than spinning for ever', async () => {
		// ┌─────────────────────────────────────────────────────────────────────────────────────┐
		// │ THIS FROZE THE TAB, AND A USER REACHED IT BY TYPING A LONG NAME TWICE.               │
		// └─────────────────────────────────────────────────────────────────────────────────────┘
		//
		// `toWorkspaceName(`${preferred} (2)`)` truncates the suffix straight back off when
		// `preferred` is already at the cap, so the candidate equalled `preferred`, stayed taken, and
		// the search loop advanced by nothing — synchronously, on the main thread, for ever.
		//
		// The timeout is what makes this a test of termination rather than of naming: a spinning
		// implementation never reaches the assertion at all, and Vitest kills it.
		const stem = `Marking ${crypto.randomUUID()}`.padEnd(MAX_WORKSPACE_NAME_LENGTH, 'x');
		const preferred = toWorkspaceName(stem);
		expect([...preferred].length).toBe(MAX_WORKSPACE_NAME_LENGTH);

		const first = await remember(await createOpfsWorkspace(preferred));
		const second = await remember(await createOpfsWorkspace(preferred));
		const third = await remember(await createOpfsWorkspace(preferred));

		expect(first).toBe(preferred);
		// Distinct, still within the cap, and still recognisably the name that was asked for: the
		// stem gives way to the marker rather than the marker being dropped.
		expect(new Set([first, second, third]).size).toBe(3);
		for (const name of [second, third]) {
			expect([...name].length, name).toBeLessThanOrEqual(MAX_WORKSPACE_NAME_LENGTH);
			expect(name, name).toMatch(/ \(\d+\)$/);
		}
	}, 15_000);

	it('treats a name differing only in case as taken, the way APFS and NTFS do', async () => {
		// `getDirectoryHandle('Marking')` hands back the existing `marking` on the two most common
		// filesystems, so a raw string comparison would report "free" and then open the Workspace it
		// had just said did not exist — with the second name's Projects appearing under the first.
		const wanted = uniquely('Case');
		const first = await remember(await createOpfsWorkspace(wanted));
		const second = await remember(await createOpfsWorkspace(wanted.toUpperCase()));

		expect(second).not.toBe(first);
		expect(second.toLowerCase()).not.toBe(first.toLowerCase());
	});

	it('deletes a Workspace and everything in it', async () => {
		const name = await remember(await createOpfsWorkspace(uniquely('Doomed')));
		await openOpfsWorkspace(name).write('p/project.json', new TextEncoder().encode('{}'));
		await openOpfsWorkspace(name).write('images/blaeu/info.json', new TextEncoder().encode('{}'));

		await deleteOpfsWorkspace(name);

		expect(await listOpfsWorkspaces()).not.toContain(name);
		// Recursive, not just the top file: a Workspace half deleted still opens onto part of somebody's
		// work, and `create: true` in the store's resolver would bring the directory straight back.
		expect(await openOpfsWorkspace(name).list('')).toEqual([]);
	});

	it('leaves every other Workspace alone when one is deleted', async () => {
		const kept = await remember(await createOpfsWorkspace(uniquely('Kept')));
		const doomed = await remember(await createOpfsWorkspace(uniquely('Gone')));
		await openOpfsWorkspace(kept).write('p/project.json', new TextEncoder().encode('{"n":1}'));

		await deleteOpfsWorkspace(doomed);

		expect(await openOpfsWorkspace(kept).list('')).toEqual(['p/project.json']);
	});
});
