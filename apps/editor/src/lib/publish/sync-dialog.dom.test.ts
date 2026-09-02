// The Sync modal at Seam 1c: what a reader sees, and which of the four modes a press asks for.
//
// ⚠ **The subject is the screen, never the engine.** Which bytes end up where is Seam 1's, against
// the shared fake GitHub; what only this seam can say cheaply is that the two columns name Projects
// and Map Images rather than paths, that every removal either side would suffer is on the screen the
// author reads before pressing, and that the send affordances are *absent* for somebody who cannot
// write rather than present and refusing.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import SyncDialog from './SyncDialog.svelte';
import { FakeSyncStorage, asStorage } from './sync-dialog-fake.svelte.js';
import { at as file, emptyForecast } from './sync-dialog-forecast.js';

// The viewer bundle is fetched from the deployment, which neither seam's fence allows and which no
// claim here is about: the Share Links half is exercised through `hasShareLinks`.
vi.mock('./viewer-bundle-source', () => ({
	loadViewerBundle: async () => ({ version: 'test', files: [] }),
	readBundleAsset: async () => new Uint8Array(0)
}));

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

beforeEach(() => {
	// `showModal` is not implemented in jsdom, and `ModalDialog` calls it on open.
	HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
		this.open = false;
	};
});

/** Every microtask the modal's opening pass takes: four reads, then the forecast. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
	flushSync();
}

const el = (testid: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

const shown = (testid: string): HTMLElement => {
	const found = el(testid);
	if (found === null) throw new Error(`no [data-testid="${testid}"] on screen`);
	return found;
};

const absent = (testid: string): boolean => el(testid) === null;

const text = (testid: string): string =>
	(el(testid)?.textContent ?? '').replace(/\s+/g, ' ').trim();

const press = (testid: string): void => {
	shown(testid).click();
	flushSync();
};

/** Open the modal over a fake, and let its opening pass finish. */
async function open(storage: FakeSyncStorage = new FakeSyncStorage()): Promise<FakeSyncStorage> {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(SyncDialog, {
		target: main,
		props: { storage: asStorage(storage), open: true }
	});
	flushSync();
	await settle();
	return storage;
}

/** A Workspace holding a Project the Remote has not got: something to send and nothing to get. */
const somethingToSend = (): FakeSyncStorage => {
	const storage = new FakeSyncStorage();
	storage.session.projects = [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' } as never];
	storage.session.forecast = emptyForecast({
		unchanged: false,
		files: [file('amsterdam-1625/project.json')],
		outgoing: [{ path: 'amsterdam-1625/project.json', sha: 'a'.repeat(40), effect: 'add' }],
		uploads: 1,
		uploadBytes: 12
	});
	return storage;
};

/** A Remote holding a Project this Workspace has not got: something to get and nothing to send. */
const somethingToGet = (): FakeSyncStorage => {
	const storage = new FakeSyncStorage();
	storage.session.forecast = emptyForecast({
		incoming: [{ path: 'delft/project.json', sha: 'b'.repeat(40), effect: 'add' }],
		leftAlone: ['delft/project.json']
	});
	return storage;
};

describe('the sync modal', () => {
	test('reads both sides and moves nothing', async () => {
		const storage = await open(somethingToGet());

		expect(shown('to-get')).toBeTruthy();
		expect(storage.gets).toEqual([]);
		expect(storage.session.sends).toEqual([]);
		expect(storage.session.published).toBe(0);
	});

	// ⚠ **The claim the whole modal exists for.** A Sync of one map is four thousand paths; a column
	// listing them is not a decision anybody can take (ADR-0044).
	test('names Projects and Map Images, and puts no path on the screen', async () => {
		const storage = new FakeSyncStorage();
		storage.session.projects = [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' } as never];
		storage.session.forecast = emptyForecast({
			unchanged: false,
			incoming: [
				{ path: 'images/map-1/info.json', sha: 'b'.repeat(40), effect: 'add' },
				{ path: 'images/map-1/0/0/0.jpg', sha: 'c'.repeat(40), effect: 'add' }
			],
			outgoing: [
				{ path: 'amsterdam-1625/project.json', sha: 'a'.repeat(40), effect: 'add' },
				{ path: 'amsterdam-1625/annotations/notes.json', sha: 'd'.repeat(40), effect: 'add' }
			]
		});
		await open(storage);

		expect(text('to-get')).toContain('map-1');
		expect(text('to-get')).toContain('2 files');
		expect(text('to-send')).toContain('Amsterdam 1625');
		expect(text('to-send')).toContain('2 files');
		// The negative that keeps four thousand unintelligible lines off the screen: not one of the
		// six paths behind those two lines is anywhere on it.
		for (const path of [
			'images/map-1/info.json',
			'images/map-1/0/0/0.jpg',
			'amsterdam-1625/project.json',
			'amsterdam-1625/annotations/notes.json'
		]) {
			expect(text('sync-modal')).not.toContain(path);
		}
	});

	// ⚠ **Every removal either side would suffer, on the screen the author is already reading**
	// (Story 7). A deletion discovered after a press is the failure this shape exists to prevent, and
	// both the inbound and the outbound preview folded into these two lines.
	test('gives each column a Removals line of its own', async () => {
		const storage = new FakeSyncStorage();
		storage.session.projects = [{ directory: 'delft', name: 'Delft 1650' } as never];
		storage.session.forecast = emptyForecast({
			unchanged: false,
			incoming: [{ path: 'delft/annotations/l3.geojson', sha: null, effect: 'delete' }],
			outgoing: [{ path: 'delft/project.json', sha: 'a'.repeat(40), effect: 'keep' }],
			removed: ['images/map-9/info.json']
		});
		await open(storage);

		expect(shown('to-get-removals')).toBeTruthy();
		expect(text('to-get')).toContain('Delft 1650');
		expect(shown('to-send-removals')).toBeTruthy();
		expect(text('to-send')).toContain('map-9');
	});

	test('says so plainly when the two sides already agree', async () => {
		await open();

		expect(text('sync-nothing-to-do')).toContain('Nothing needs changing');
		expect(shown('sync-get').getAttribute('aria-disabled')).toBe('true');
		expect(shown('sync-send').getAttribute('aria-disabled')).toBe('true');
	});
});

describe('the sync modal’s four choices', () => {
	test('gets only, without sending anything', async () => {
		const storage = await open(somethingToGet());

		press('sync-get');
		await settle();

		expect(storage.gets).toHaveLength(1);
		expect(storage.session.sends).toEqual([]);
	});

	test('sends only, without getting anything', async () => {
		const storage = await open(somethingToSend());

		press('sync-send');
		await settle();

		expect(storage.session.sends).toEqual([{ overwrite: undefined }]);
		expect(storage.gets).toEqual([]);
	});

	// ⚠ **Two transactions in order, and the second is unattempted when the first fails.** Getting
	// keeps the inbound crash-recovery protocol and sending keeps the single-commit property; folded
	// into one they would have neither.
	test('gets and then sends, as one press', async () => {
		const storage = new FakeSyncStorage();
		storage.session.projects = [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' } as never];
		storage.session.forecast = emptyForecast({
			unchanged: false,
			incoming: [{ path: 'delft/project.json', sha: 'b'.repeat(40), effect: 'add' }],
			outgoing: [{ path: 'amsterdam-1625/project.json', sha: 'a'.repeat(40), effect: 'add' }]
		});
		await open(storage);

		press('sync-both');
		await settle();

		expect(storage.gets).toHaveLength(1);
		expect(storage.session.sends).toHaveLength(1);
	});

	test('leaves the send unattempted when the get fails', async () => {
		const storage = new FakeSyncStorage();
		storage.session.projects = [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' } as never];
		storage.session.forecast = emptyForecast({
			unchanged: false,
			incoming: [{ path: 'delft/project.json', sha: 'b'.repeat(40), effect: 'add' }],
			outgoing: [{ path: 'amsterdam-1625/project.json', sha: 'a'.repeat(40), effect: 'add' }]
		});
		storage.getAnswer = new Error('GitHub could not be reached.');
		await open(storage);

		press('sync-both');
		await settle();

		expect(storage.session.sends).toEqual([]);
		// Said inside the modal, which is still open: the send has not happened and the author is
		// still looking at the screen that would have started it.
		expect(text('sync-modal')).toContain('could not be reached');
	});

	// ⚠ **Overwrite names what it would remove before it will proceed** (Story 15), and the paths it
	// names travel with the press so the engine cannot apply the answer to a set nobody agreed to.
	test('names what an overwrite would remove, and carries those paths to the engine', async () => {
		const storage = new FakeSyncStorage();
		storage.session.forecast = emptyForecast({
			unchanged: false,
			overwrites: ['florida-1657/project.json'],
			incoming: [{ path: 'florida-1657/project.json', sha: 'b'.repeat(40), effect: 'add' }]
		});
		await open(storage);

		expect(text('sync-overwrite-removals')).toContain('florida-1657');
		press('sync-arm-overwrite');
		await settle();
		press('sync-overwrite');
		await settle();

		expect(storage.session.sends).toEqual([{ overwrite: ['florida-1657/project.json'] }]);
	});

	// ⚠ **A second press rather than a louder first one** (Story 16). On a solo repository an
	// overwrite can only discard the author's own work; on a shared one it deletes a colleague's.
	test('demands a confirmation before overwriting a repository that is not solely the author’s', async () => {
		const storage = somethingToSend();
		storage.sharing = { shared: true, known: true, owner: 'ada', others: ['grace'] };
		await open(storage);

		press('sync-arm-overwrite');
		await settle();

		expect(text('sync-shared-remote')).toContain('grace');
		// The replaced version is still in the history — said, and not offered as a remedy.
		expect(text('sync-shared-remote')).toContain("repository's history");
		expect(absent('sync-overwrite')).toBe(true);

		press('confirm-shared-overwrite');
		await settle();
		press('sync-overwrite');
		await settle();

		expect(storage.session.sends).toHaveLength(1);
	});

	test('lets the shared-Remote question be answered no, leaving everything as it was', async () => {
		const storage = somethingToSend();
		storage.sharing = { shared: true, known: true, owner: 'ada', others: ['grace'] };
		await open(storage);

		press('sync-arm-overwrite');
		await settle();
		press('cancel-shared-overwrite');

		expect(absent('sync-shared-remote')).toBe(true);
		expect(absent('sync-overwrite')).toBe(true);
		expect(storage.session.sends).toEqual([]);
	});
});

describe('the sync modal for somebody who cannot write', () => {
	/** A read-only collaborator: signed in, and GitHub says this account may not push. */
	const readOnly = (): FakeSyncStorage => {
		const storage = somethingToGet();
		storage.rights = { canPush: false };
		return storage;
	};

	// ⚠ **Absent rather than present-and-refusing** (Story 50). A control that will certainly refuse
	// is worse than its absence.
	test('offers no send affordance at all', async () => {
		await open(readOnly());

		expect(absent('sync-send')).toBe(true);
		expect(absent('sync-both')).toBe(true);
		expect(absent('sync-arm-overwrite')).toBe(true);
		expect(absent('to-send')).toBe(true);
		expect(text('sync-read-only')).toContain('cannot write to it');
	});

	// The comparison is still made: refusing to plan at all would leave them looking at nothing where
	// the *To get* column belongs.
	test('still shows what there is to get, and can get it', async () => {
		const storage = await open(readOnly());

		expect(storage.session.forecasts).toEqual([{ sending: false }]);
		expect(text('to-get')).toContain('delft');

		press('sync-get');
		await settle();

		expect(storage.gets).toHaveLength(1);
	});
});

/** A Workspace and its Remote that have both moved the same Map Image's Alignment. */
const contestedAlignment = (): FakeSyncStorage => {
	const storage = new FakeSyncStorage();
	storage.session.forecast = emptyForecast({
		unchanged: false,
		conflicts: [
			{
				path: 'alignments/map-1.json',
				comparison: 'conflict',
				baseline: 'a'.repeat(40),
				local: 'b'.repeat(40),
				remote: 'c'.repeat(40)
			}
		],
		overwrites: []
	});
	return storage;
};

describe('the sync modal’s Conflicts', () => {
	const contested = (): FakeSyncStorage => {
		const storage = new FakeSyncStorage();
		storage.session.projects = [{ directory: 'amsterdam-1625', name: 'Amsterdam 1625' } as never];
		storage.session.forecast = emptyForecast({
			unchanged: false,
			conflicts: [
				{
					path: 'amsterdam-1625/annotations/notes.json',
					comparison: 'conflict',
					baseline: 'a'.repeat(40),
					local: 'b'.repeat(40),
					remote: 'c'.repeat(40)
				}
			],
			overwrites: []
		});
		return storage;
	};

	test('names what is contested, and by the Project rather than the path', async () => {
		await open(contested());

		expect(text('sync-conflicts')).toContain('Amsterdam 1625');
		expect(text('sync-conflicts')).not.toContain('amsterdam-1625/annotations/notes.json');
	});

	// ⚠ **It says what getting will make, and that nothing is merged** (ADR-0046). A notice that only
	// reported the collision would leave the scholar looking for the choice they have to make, and the
	// choice they used to be given was *Overwrite the repository* — the one destructive control there
	// is, reached by an obstruction they could not otherwise clear.
	test('says GitHub’s version arrives beside the author’s, named and unmerged', async () => {
		await open(contested());

		expect(text('sync-conflicts')).toContain('(from GitHub)');
		expect(text('sync-conflicts')).toContain('Nothing is combined');
	});

	test('stops neither direction', async () => {
		await open(contested());

		expect(shown('sync-get').getAttribute('aria-disabled')).toBe('false');
		expect(shown('sync-send').getAttribute('aria-disabled')).toBe('false');
		expect(shown('sync-both').getAttribute('aria-disabled')).toBe('false');
	});
});

// ⚠ **The one question in the product**, and the only Conflict without a copy: there is exactly one
// Alignment per Map Image (ADR-0023), so a second file would be referenced by nothing and drawn
// nowhere (ADR-0046).
describe('the sync modal’s Alignment question', () => {
	const twoAlignments = (): FakeSyncStorage => {
		const storage = contestedAlignment();
		storage.session.alignmentQuestions = [
			{
				imageId: 'map-1',
				path: 'alignments/map-1.json',
				mine: { controlPoints: 3, at: new Date('2026-08-30T09:00:00Z') },
				theirs: { controlPoints: 12, at: new Date('2026-09-01T17:30:00Z') }
			}
		];
		return storage;
	};

	test('shows each side’s control point count and date', async () => {
		await open(twoAlignments());

		const question = text('sync-alignment-question');
		expect(question).toContain('3 control points');
		expect(question).toContain('12 control points');
		expect(question).toContain(new Date('2026-08-30T09:00:00Z').getFullYear().toString());
		expect(question).toContain('Keep mine');
		expect(question).toContain('Take the one from GitHub');
	});

	test('carries the answer to the get, and getting is offered unanswered', async () => {
		const storage = twoAlignments();
		await open(storage);

		expect(shown('sync-get').getAttribute('aria-disabled')).toBe('false');
		const chooseTheirs = shown('sync-alignment-question').querySelectorAll('input')[1];
		chooseTheirs?.click();
		press('sync-get');
		await settle();

		expect([...(storage.getChoices[0] ?? new Map())]).toEqual([
			['alignments/map-1.json', 'take-theirs']
		]);
	});
});

describe('the sync modal’s three budgets', () => {
	test('says what would move and what this hour has left, before anything is pressed', async () => {
		const storage = somethingToSend();
		await open(storage);

		expect(text('sync-budget')).toContain('1 of 1 files');
		expect(text('sync-budget')).toContain('Requests this hour: 4800 left');
	});

	// A corporate proxy strips the rate-limit headers, and a budget silently read as nought turns
	// every later 403 into "wait for the reset".
	test('says the request budget is unavailable rather than naming a number it does not have', async () => {
		const storage = somethingToSend();
		storage.session.forecast = emptyForecast({
			...(storage.session.forecast as ReturnType<typeof emptyForecast>),
			requestsRemaining: null,
			requestsResetAt: null
		});
		await open(storage);

		expect(text('sync-budget')).toContain('Requests this hour: unavailable');
	});
});

describe('the sync modal and Share Links', () => {
	// ⚠ **The viewer is written only where there is already a site** (ADR-0045). Having Share Links
	// *is* carrying the viewer file set, so writing it here would grant them — silently, on a press
	// about GitHub.
	test('writes no viewer into a Workspace that has not asked for Share Links', async () => {
		const storage = await open(somethingToSend());

		press('sync-send');
		await settle();

		expect(storage.session.published).toBe(0);
	});

	// ⚠ **And no front-page question either, here or with Share Links on.** Which Projects a Reader
	// meets first is set in a Project's own settings and nowhere else (ADR-0045); a list of every
	// Project offered at the moment of a Sync is the second place that made a scholar unsure which
	// one won.
	test('writes the viewer where the Workspace has Share Links, and asks nothing about the front page', async () => {
		const storage = somethingToSend();
		storage.shareLinks = true;
		await open(storage);

		expect(absent('sync-project-selection')).toBe(true);
		press('sync-send');
		await settle();

		expect(storage.session.published).toBe(1);
	});
});
