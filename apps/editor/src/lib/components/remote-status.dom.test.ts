// The one badge the navigation bar answers *where is my work* with, at Seam 1c.
//
// ⚠ **The subject is the projection, not the determination.** Which of the six a Workspace is in is
// `remote-status.ts`'s at Seam 1, and this file must not be able to change that answer: it renders
// the component against a state it was handed. What only this seam can say cheaply is what a reader
// sees for each of the six — which is a claim about one badge, two clauses and one press, and needs
// no browser.
//
// ⚠ **The table is asserted whole rather than row by row in scattered tests.** ADR-0044 settles what
// each situation reads as, and the failure worth catching is a row that drifted out of agreement with
// its neighbours — a repository named where the two sides do not agree, or a direction dropped.

import {
	REMOTE_STATUS_LABELS,
	REMOTE_STATUS_UNCHECKED,
	UNCHECKED_REMOTE_STATUS,
	type RemoteRepository,
	type RemoteStatusState,
	type SourceStatus,
	type SynchronizationBaseline
} from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import { toasts } from '$lib/toasts/toasts.svelte.js';

import RemoteStatus from './RemoteStatus.svelte';
import WhereYourWorkIs from './WhereYourWorkIs.svelte';

/** Every determination there is, so a seventh added to core arrives here as a failure. */
const DETERMINATIONS = Object.keys(REMOTE_STATUS_LABELS) as SourceStatus[];

/**
 * The words the glossary's *Avoid* lists put out of reach on this surface.
 *
 * Substantive rather than stylistic: `ahead` and `behind` describe a commit graph the scholar never
 * opens, *connected* and *up to date* report a relationship rather than whether the work is anywhere
 * but this machine, and calling a Sync a backup would promise something a mirror of an owned
 * namespace does not keep (ADR-0033, ADR-0044).
 */
const FORBIDDEN = [
	'backed up',
	'back up',
	'backup',
	'the cloud',
	'ahead',
	'behind',
	'connected',
	'up to date',
	'dirty',
	'diverged'
];

const ATLAS: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };

const BASELINE: SynchronizationBaseline = {
	remote: ATLAS,
	commit: 'c0ffee1',
	files: new Map([
		['projects/atlas/project.json', 'aaa'],
		['projects/atlas/map.tif', 'bbb']
	])
};

/**
 * ADR-0044's table, verbatim, with `null` for the reading that has not been taken.
 *
 * ⚠ **`conflict` reads as the both-directions row it is.** The badge says which direction is
 * outstanding, and a Conflict has work outstanding in both; that the two sides contest one file is
 * the determination's own business and is one press away. Nothing here may promise agreement.
 */
const TABLE: readonly (readonly [SourceStatus | null, string])[] = [
	['in-sync', 'Saved here · in sync with ada/atlas'],
	['changes-to-send', 'Saved here · changes to send'],
	['changes-to-get', 'Saved here · changes to get'],
	['changes-both-ways', 'Saved here · changes both ways'],
	['conflict', 'Saved here · changes both ways'],
	['cannot-tell', "Saved here · can't tell what's on GitHub"],
	[null, 'Saved here · not checked yet']
];

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

function bar(
	state: Partial<RemoteStatusState> = {},
	extra: { baseline?: SynchronizationBaseline | null } = {}
): void {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(RemoteStatus, {
		target: main,
		props: {
			saveState: 'saved',
			remote: ATLAS,
			state: { ...UNCHECKED_REMOTE_STATUS, ...state },
			baseline: extra.baseline ?? null,
			update: null,
			notice: '',
			failure: ''
		}
	});
	flushSync();
}

/** One determination's whole state, with a reading behind it where there is one to have. */
const reading = (status: SourceStatus | null): Partial<RemoteStatusState> => ({
	status,
	at: status === null ? null : Date.parse('2026-08-27T10:00:00Z')
});

const at = (testid: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);

const text = (testid: string): string =>
	(at(testid)?.textContent ?? '').replace(/\s+/g, ' ').trim();

const press = (testid: string): void => {
	at(testid)?.click();
	flushSync();
};

/** Take the current mount down, so two readings in one test cannot share a document. */
function clear(): void {
	unmount(mounted!);
	mounted = undefined;
	document.body.innerHTML = '';
}

/** One determination's badge, from its own mount. */
function badgeFor(status: SourceStatus | null): string {
	bar(reading(status));
	const badge = text('where-your-work-is');
	clear();
	return badge;
}

describe('one badge, two clauses', () => {
	test.each(TABLE)('%s reads as ADR-0044 says it reads', (status, expected) => {
		bar(reading(status));

		expect(text('where-your-work-is')).toBe(expected);
	});

	// ⚠ **The name is the report of a fact, and there is only one row where the fact holds.** Beside
	// any other determination it says a repository was named rather than that work reached it.
	test.each(TABLE.filter(([status]) => status !== 'in-sync'))(
		'%s names no repository anywhere on the badge',
		(status) => {
			bar(reading(status), { baseline: BASELINE });

			expect(at('where-your-work-is')?.outerHTML).not.toContain('ada/atlas');
		}
	);

	test('is the only status region in the bar', () => {
		bar(reading('in-sync'));

		expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
		expect(at('where-your-work-is')?.getAttribute('role')).toBe('status');
	});

	// ⚠ **Where the edit is kept and whether GitHub has it are different questions**, and a badge that
	// answered one of them would be read as answering both.
	test.each(TABLE)('%s keeps the local clause beside the GitHub one', (status) => {
		bar(reading(status));

		const badge = text('where-your-work-is');
		expect(badge.startsWith('Saved here · ')).toBe(true);
		expect(badge.slice('Saved here · '.length).length).toBeGreaterThan(1);
	});

	test('says the reading has not been taken rather than projecting one of the six', () => {
		bar();
		press('remote-status-explain');

		expect(text('remote-status-determination')).toBe(REMOTE_STATUS_UNCHECKED);
	});

	test.each(['conflict', 'changes-both-ways', 'cannot-tell'] as const)(
		'%s does not read as the two sides agreeing',
		(status) => {
			const agreement = badgeFor('in-sync');
			const badge = badgeFor(status);

			expect(badge).not.toBe(agreement);
			expect(badge).not.toMatch(/in sync/i);
		}
	);

	test('keeps the determination readable by a spec without putting it on screen', () => {
		bar(reading('conflict'));

		expect(at('where-your-work-is')?.dataset.remoteStatus).toBe('conflict');
		expect(text('where-your-work-is')).not.toContain(REMOTE_STATUS_LABELS.conflict);
	});
});

// ⚠ **A status about a repository that does not exist is a status about nothing** (ADR-0044). The
// bar offers Sync with GitHub instead, and `RemoteStatus` is not mounted at all — but the clause that
// says whether the edit reached this machine is not the GitHub clause and does not go with it
// (ADR-0017 rule 5).
describe('a Workspace with no repository', () => {
	test('is the local clause alone, carrying no GitHub clause and no determination', () => {
		const main = document.createElement('main');
		document.body.append(main);
		mounted = mount(WhereYourWorkIs, { target: main, props: { saveState: 'saved' } });
		flushSync();

		expect(text('where-your-work-is')).toBe('Saved here');
		expect(at('where-your-work-is')?.dataset.remoteStatus).toBeUndefined();
		expect(at('remote-status-explain')).toBeNull();
	});
});

describe('everything else, one press away', () => {
	test('holds nothing until the disclosure is pressed, and all four after', () => {
		bar(reading('changes-to-send'), { baseline: BASELINE });

		expect(at('remote-status-detail')).toBeNull();
		expect(at('remote-status-determination')).toBeNull();
		expect(at('remote-status-checked')).toBeNull();
		expect(at('remote-status-baseline')).toBeNull();
		expect(at('remote-status-explain')?.getAttribute('aria-expanded')).toBe('false');

		press('remote-status-explain');

		expect(at('remote-status-explain')?.getAttribute('aria-expanded')).toBe('true');
		expect(text('remote-status-determination')).toContain('Changes to send');
		expect(text('remote-status-detail')).toContain('Sync sends them');
		expect(text('remote-status-checked')).toContain('Checked at');
		expect(text('remote-status-baseline')).toContain(BASELINE.commit);
		expect(text('remote-status-baseline')).toContain('2 files');
	});

	test('leaves the Baseline line out when there is no Baseline', () => {
		bar(reading('cannot-tell'));
		press('remote-status-explain');

		expect(at('remote-status-determination')).not.toBeNull();
		expect(at('remote-status-baseline')).toBeNull();
	});

	// ⚠ **The gestures are on the Sync modal and not here** (ADR-0044). This panel is the reading:
	// what the determination is, what it means, when it was taken and what the two sides last agreed
	// on. What to *do* about any of it is one surface, reached from the bar's one GitHub control.
	test('offers no gesture of its own, in either state of the disclosure', () => {
		bar(reading('in-sync'));

		expect(at('check-remote-status')).toBeNull();
		expect(at('update-from-github')).toBeNull();

		press('remote-status-explain');

		expect(at('check-remote-status')).toBeNull();
		expect(at('update-from-github')).toBeNull();
	});

	test.each(DETERMINATIONS)('%s has both a label and a sentence behind the press', (status) => {
		bar(reading(status));
		press('remote-status-explain');

		const detail = text('remote-status-detail');
		expect(detail).toContain(REMOTE_STATUS_LABELS[status]);
		// A sentence of its own beyond the label, and not merely the label repeated.
		expect(detail.replace(REMOTE_STATUS_LABELS[status], '').trim().length).toBeGreaterThan(20);
	});

	test('closes again on a second press', () => {
		bar(reading('in-sync'));

		press('remote-status-explain');
		press('remote-status-explain');

		expect(at('remote-status-detail')).toBeNull();
	});
});

// ⚠ **A network failure is not agreement.** Reported as `In sync` it is the one reading that
// licenses sending over somebody else's afternoon, and reported as a Conflict resolved it is the
// one that licenses believing a Conflict is over.
describe('a check that failed', () => {
	test.each(['in-sync', 'conflict'] as const)('%s keeps the determination it had', (status) => {
		bar(reading(status));
		press('remote-status-explain');
		const determination = text('remote-status-determination');
		const checked = text('remote-status-checked');
		clear();

		bar({
			...reading(status),
			failure: 'GitHub could not be reached, so the status below is the last one read.'
		});
		press('remote-status-explain');

		expect(text('remote-status-determination')).toBe(determination);
		expect(text('remote-status-checked')).toBe(checked);
		expect(at('where-your-work-is')?.dataset.remoteStatus).toBe(status);
	});
});

// ⚠ **Never one of the six** (ADR-0033). A site built by another editor version has different chunk
// names, so this is routinely true of a Workspace whose scholarship agrees with its Remote exactly.
describe('a Published Site built from other files', () => {
	test('is its own message rather than a determination', () => {
		bar({ ...reading('in-sync'), publishedSiteStale: ['index.html', 'app.js'] });
		press('remote-status-explain');

		// A message the reader can put away, drawn in the app's one stack rather than in the bar.
		const stale = toasts.items.find((item) => item.testid === 'published-site-stale');
		expect(stale?.text).toContain('2 files');
		expect(stale?.tone).toBe('info');

		// And the determination beside it is untouched by it.
		expect(text('remote-status-determination')).toBe(REMOTE_STATUS_LABELS['in-sync']);
		expect(at('where-your-work-is')?.dataset.remoteStatus).toBe('in-sync');
	});
});

describe('the words the badge uses', () => {
	test.each([...DETERMINATIONS, null])(
		'%s says none of the words the glossary refuses',
		(status) => {
			bar(reading(status), { baseline: BASELINE });
			press('remote-status-explain');

			const surface = (document.body.textContent ?? '').toLowerCase();
			for (const word of FORBIDDEN) expect(surface).not.toContain(word);
		}
	);
});
