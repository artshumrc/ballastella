import { flushSync } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import type { PathChoice, RemoteSendPlan } from '@ballastella/core';

import { absent, at, inMain, one, press, show, takeDown, textOf } from '$lib/test-support/dom.js';

import { SyncFailure } from '../remote.svelte.js';
import SyncDialog from './SyncDialog.svelte';
import { FakeSyncStorage, asStorage } from './sync-dialog-fake.svelte.js';
import { at as file, emptyForecast, localPlan } from './sync-dialog-forecast.js';

afterEach(takeDown);

async function settle(): Promise<void> {
	for (let turn = 0; turn < 3; turn += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
		flushSync();
	}
}

const text = (testid: string): string => textOf(one(testid));

const modes = (storage: FakeSyncStorage) => storage.syncs.map(({ mode }) => mode);

async function open(storage: FakeSyncStorage = new FakeSyncStorage()): Promise<FakeSyncStorage> {
	show(SyncDialog, { storage: asStorage(storage), open: true }, inMain());
	await settle();
	return storage;
}

async function pressAndSettle(...testids: string[]): Promise<void> {
	for (const testid of testids) {
		press(testid);
		await settle();
	}
}

const AMSTERDAM = { directory: 'amsterdam-1625', name: 'Amsterdam 1625' };

const choice = (path: string, digit: string, effect: PathChoice['effect'] = 'add'): PathChoice => ({
	path,
	sha: effect === 'delete' ? null : digit.repeat(40),
	effect
});

const conflict = (path: string) => ({
	path,
	comparison: 'conflict' as const,
	baseline: 'a'.repeat(40),
	local: 'b'.repeat(40),
	remote: 'c'.repeat(40)
});

function storageWith(
	forecast: Partial<RemoteSendPlan>,
	projects: readonly { directory: string; name: string }[] = []
): FakeSyncStorage {
	const storage = new FakeSyncStorage();
	storage.session.projects = projects as never;
	storage.forecast = emptyForecast(forecast);
	return storage;
}

const somethingToSend = (): FakeSyncStorage =>
	storageWith(
		{
			unchanged: false,
			files: [file('amsterdam-1625/project.json')],
			outgoing: [choice('amsterdam-1625/project.json', 'a')],
			uploads: 1,
			uploadBytes: 12
		},
		[AMSTERDAM]
	);

const somethingToGet = (): FakeSyncStorage =>
	storageWith({
		incoming: [choice('delft/project.json', 'b')],
		leftAlone: ['delft/project.json']
	});

const somethingBothWays = (): FakeSyncStorage =>
	storageWith(
		{
			unchanged: false,
			incoming: [choice('delft/project.json', 'b')],
			outgoing: [choice('amsterdam-1625/project.json', 'a')]
		},
		[AMSTERDAM]
	);

const sendForecast = (storage: FakeSyncStorage) => storage.forecast as RemoteSendPlan;

describe('the sync modal', () => {
	test('names Projects and Map Images, and puts no path on the screen', async () => {
		const paths = [
			'images/map-1/info.json',
			'images/map-1/0/0/0.jpg',
			'amsterdam-1625/project.json',
			'amsterdam-1625/annotations/notes.json'
		];
		await open(
			storageWith(
				{
					unchanged: false,
					incoming: [choice(paths[0], 'b'), choice(paths[1], 'c')],
					outgoing: [choice(paths[2], 'a'), choice(paths[3], 'd')]
				},
				[AMSTERDAM]
			)
		);

		expect(text('to-get')).toContain('map-1');
		expect(text('to-get')).toContain('2 files');
		expect(text('to-send')).toContain('Amsterdam 1625');
		expect(text('to-send')).toContain('2 files');
		for (const path of paths) expect(text('sync-modal')).not.toContain(path);
	});

	test('gives each column a Removals line of its own', async () => {
		await open(
			storageWith(
				{
					unchanged: false,
					incoming: [choice('delft/annotations/l3.geojson', '', 'delete')],
					outgoing: [choice('delft/project.json', 'a', 'keep')],
					removed: ['images/map-9/info.json']
				},
				[{ directory: 'delft', name: 'Delft 1650' }]
			)
		);

		expect(at('to-get-removals')).toBeTruthy();
		expect(text('to-get')).toContain('Delft 1650');
		expect(at('to-send-removals')).toBeTruthy();
		expect(text('to-send')).toContain('map-9');
	});

	test('says so plainly when the two sides already agree', async () => {
		await open();

		expect(text('sync-nothing-to-do')).toContain('Nothing needs changing');
		expect(at('sync-get').getAttribute('aria-disabled')).toBe('true');
		expect(at('sync-send').getAttribute('aria-disabled')).toBe('true');
	});
});

describe('the sync modal’s four choices', () => {
	test.each([
		['gets only', somethingToGet, 'get'],
		['sends only', somethingToSend, 'send'],
		['gets and then sends, as one press', somethingBothWays, 'both']
	])('reads both sides, moving nothing until pressed, and then %s', async (_, fixture, mode) => {
		const storage = await open(fixture());
		expect(storage.syncs).toEqual([]);

		await pressAndSettle(`sync-${mode}`);

		expect(modes(storage)).toEqual([mode]);
	});

	test.each([
		[false, false, []],
		[true, true, ['brought in first and is still here', 'The website itself was written']]
	])('says why the Sync stopped (got %s, written %s)', async (got, written, said) => {
		const storage = somethingBothWays();
		storage.outcome = new SyncFailure(new Error('GitHub could not be reached.'), got, written);
		await open(storage);

		await pressAndSettle('sync-both');

		for (const phrase of ['could not be reached', ...said]) {
			expect(text('sync-modal')).toContain(phrase);
		}
		if (!got) expect(text('sync-modal')).not.toContain('brought in first');
	});

	test('names what an overwrite would remove, and carries those paths to the engine', async () => {
		const storage = await open(
			storageWith({
				unchanged: false,
				overwrites: ['florida-1657/project.json'],
				incoming: [choice('florida-1657/project.json', 'b')]
			})
		);

		expect(text('sync-overwrite-removals')).toContain('florida-1657');
		await pressAndSettle('sync-arm-overwrite', 'sync-overwrite');

		expect(storage.syncs).toMatchObject([
			{ mode: 'overwrite', overwrite: ['florida-1657/project.json'] }
		]);
	});

	test('demands a confirmation before overwriting a repository that is not solely the author’s', async () => {
		const storage = somethingToSend();
		storage.sharing = { shared: true, known: true, owner: 'ada', others: ['grace'] };
		await open(storage);

		await pressAndSettle('sync-arm-overwrite');
		expect(text('sync-shared-remote')).toContain('grace');
		expect(text('sync-shared-remote')).toContain("repository's history");
		expect(absent('sync-overwrite')).toBe(true);

		press('cancel-shared-overwrite');
		expect(absent('sync-shared-remote')).toBe(true);
		expect(absent('sync-overwrite')).toBe(true);
		expect(storage.syncs).toEqual([]);

		await pressAndSettle('sync-arm-overwrite', 'confirm-shared-overwrite', 'sync-overwrite');
		expect(modes(storage)).toEqual(['overwrite']);
	});
});

const expectNoSendAffordance = (): void => {
	for (const testid of ['sync-send', 'sync-both', 'sync-arm-overwrite']) {
		expect(absent(testid)).toBe(true);
	}
};

describe('the sync modal for somebody who cannot write', () => {
	const readOnly = (): FakeSyncStorage => {
		const storage = somethingToGet();
		storage.canSend = false;
		return storage;
	};

	test('offers no send affordance at all, but shows what there is to get, and gets it', async () => {
		const storage = await open(readOnly());
		expectNoSendAffordance();
		expect(absent('to-send')).toBe(true);
		expect(text('sync-read-only')).toContain('cannot write to it');
		expect(text('to-get')).toContain('delft');

		await pressAndSettle('sync-get');

		expect(modes(storage)).toEqual(['get']);
	});

	test('does not mistake an unreadable rights check for read-only access', async () => {
		const storage = somethingToGet();
		storage.canSend = null;

		await open(storage);

		expect(absent('sync-read-only')).toBe(true);
		expect(at('sync-get').getAttribute('aria-disabled')).toBe('false');
	});
});

describe('the sync modal with nobody signed in', () => {
	const signedOut = (): FakeSyncStorage => {
		const storage = somethingToGet();
		storage.signedIn = false;
		storage.canSend = false;
		return storage;
	};

	test('reads both sides and gets, offering no send and saying the sign-in is what it needs', async () => {
		const storage = await open(signedOut());
		expect(text('to-get')).toContain('delft');
		expect(at('sync-get').getAttribute('aria-disabled')).toBe('false');
		expectNoSendAffordance();
		expect(text('sync-sign-in-needed')).toContain('Getting from');

		await pressAndSettle('sync-get');

		expect(modes(storage)).toEqual(['get']);
	});
});

describe('the sync modal’s Conflicts', () => {
	test('names the contested Project, says GitHub’s arrives unmerged beside it, and stops neither direction', async () => {
		await open(
			storageWith(
				{
					unchanged: false,
					conflicts: [conflict('amsterdam-1625/annotations/notes.json')],
					overwrites: []
				},
				[AMSTERDAM]
			)
		);

		expect(text('sync-conflicts')).toContain('Amsterdam 1625');
		expect(text('sync-conflicts')).not.toContain('amsterdam-1625/annotations/notes.json');
		expect(text('sync-conflicts')).toContain('(from GitHub)');
		expect(text('sync-conflicts')).toContain('Nothing is combined');
		for (const testid of ['sync-get', 'sync-send', 'sync-both']) {
			expect(at(testid).getAttribute('aria-disabled')).toBe('false');
		}
	});
});

describe('the sync modal’s Alignment question', () => {
	const twoAlignments = (): FakeSyncStorage => {
		const storage = storageWith({
			unchanged: false,
			conflicts: [conflict('alignments/map-1.json')],
			overwrites: []
		});
		storage.questions = [
			{
				imageId: 'map-1',
				path: 'alignments/map-1.json',
				mine: { controlPoints: 3, at: new Date('2026-08-30T09:00:00Z') },
				theirs: { controlPoints: 12, at: new Date('2026-09-01T17:30:00Z') }
			}
		];
		return storage;
	};

	test('shows each side’s count and date, offers the get unanswered, and carries the answer to it', async () => {
		const storage = await open(twoAlignments());
		const question = text('sync-alignment-question');
		expect(question).toContain('3 control points');
		expect(question).toContain('12 control points');
		expect(question).toContain(new Date('2026-08-30T09:00:00Z').getFullYear().toString());
		expect(question).toContain('Keep mine');
		expect(question).toContain('Take the one from GitHub');
		expect(at('sync-get').getAttribute('aria-disabled')).toBe('false');
		at('sync-alignment-question').querySelectorAll('input')[1]?.click();
		await pressAndSettle('sync-get');

		expect(storage.syncs[0]?.choices).toEqual([['alignments/map-1.json', 'take-theirs']]);
	});
});

describe('the sync modal’s three budgets', () => {
	test('says what would move and what this hour has left, before anything is pressed', async () => {
		await open(somethingToSend());

		expect(text('sync-budget')).toContain('1 of 1 files');
		expect(text('sync-budget')).toContain('Requests this hour: 4800 left');
	});

	test('says the request budget is unavailable rather than naming a number it does not have', async () => {
		const storage = somethingToSend();
		storage.forecast = emptyForecast({
			...sendForecast(storage),
			requestsRemaining: null,
			requestsResetAt: null
		});
		await open(storage);

		expect(text('sync-budget')).toContain('Requests this hour: unavailable');
	});
});

describe('the sync modal and Share Links', () => {
	test.each([
		['no site from a Workspace that has not asked for Share Links', null],
		['the site it showed, and asks nothing about the front page', localPlan()]
	])('hands the send %s', async (_, plan) => {
		const storage = somethingToSend();
		storage.plan = plan;
		await open(storage);
		expect(absent('sync-site-breakdown')).toBe(plan === null);
		expect(absent('sync-project-selection')).toBe(true);

		await pressAndSettle('sync-send');

		expect(storage.syncs[0]?.site).toEqual(plan);
	});
});
