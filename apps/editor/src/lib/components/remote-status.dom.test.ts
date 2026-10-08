import {
	REMOTE_STATUS_LABELS,
	REMOTE_STATUS_UNCHECKED,
	UNCHECKED_REMOTE_STATUS,
	type RemoteRepository,
	type RemoteStatusState,
	type SourceStatus,
	type SynchronizationBaseline
} from '@ballastella/core';
import { afterEach, describe, expect, test } from 'vitest';

import { inMain, one, press, show, takeDown, textOf } from '$lib/test-support/dom.js';
import { toasts } from '$lib/toasts/toasts.svelte.js';

import RemoteStatus from './RemoteStatus.svelte';
import WhereYourWorkIs from './WhereYourWorkIs.svelte';

const DETERMINATIONS = Object.keys(REMOTE_STATUS_LABELS) as SourceStatus[];

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

const TABLE: readonly (readonly [SourceStatus | null, string])[] = [
	['in-sync', 'Saved here · in sync with ada/atlas'],
	['changes-to-send', 'Saved here · changes to send'],
	['changes-to-get', 'Saved here · changes to get'],
	['changes-both-ways', 'Saved here · changes both ways'],
	['cannot-tell', "Saved here · can't tell what's on GitHub"],
	[null, 'Saved here · not checked yet']
];

afterEach(takeDown);

function bar(
	state: Partial<RemoteStatusState> = {},
	baseline: SynchronizationBaseline | null = null
): void {
	const props = { saveState: 'saved', remote: ATLAS, baseline, update: null, notice: '' } as const;
	show(RemoteStatus, { ...props, state: { ...UNCHECKED_REMOTE_STATUS, ...state } }, inMain());
}

const reading = (status: SourceStatus | null): Partial<RemoteStatusState> => ({
	status,
	at: status === null ? null : Date.parse('2026-08-27T10:00:00Z')
});

const text = (testid: string): string => textOf(one(testid));

function badgeFor(status: SourceStatus | null): string {
	bar(reading(status));
	const badge = text('where-your-work-is');
	takeDown();
	return badge;
}

describe('one badge, two clauses', () => {
	test.each(TABLE)('%s reads as ADR-0044 says it reads', (status, expected) => {
		bar(reading(status));
		expect(text('where-your-work-is')).toBe(expected);
	});

	test.each(TABLE.filter(([status]) => status !== 'in-sync'))(
		'%s names no repository anywhere on the badge',
		(status) => {
			bar(reading(status), BASELINE);
			expect(one('where-your-work-is')?.outerHTML).not.toContain('ada/atlas');
		}
	);

	test('is the only status region in the bar', () => {
		bar(reading('in-sync'));
		expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
		expect(one('where-your-work-is')?.closest('[role="status"]')).not.toBeNull();
	});

	test('says the reading has not been taken rather than projecting one of the six', () => {
		bar();
		press('where-your-work-is');
		expect(text('remote-status-determination')).toBe(REMOTE_STATUS_UNCHECKED);
	});

	test.each(['changes-both-ways', 'cannot-tell'] as const)(
		'%s does not read as the two sides agreeing',
		(status) => {
			const agreement = badgeFor('in-sync');
			const badge = badgeFor(status);
			expect(badge).not.toBe(agreement);
			expect(badge).not.toMatch(/in sync/i);
		}
	);

	test('keeps the determination readable by a spec without putting it on screen', () => {
		bar(reading('changes-both-ways'));
		expect(one('where-your-work-is')?.dataset.remoteStatus).toBe('changes-both-ways');
		expect(text('where-your-work-is')).not.toContain(REMOTE_STATUS_LABELS['changes-both-ways']);
	});
});

describe('a Workspace with no repository', () => {
	test('is the local clause alone, carrying no GitHub clause and no determination', () => {
		show(WhereYourWorkIs, { saveState: 'saved' }, inMain());
		expect(text('where-your-work-is')).toBe('Saved here');
		expect(one('where-your-work-is')?.dataset.remoteStatus).toBeUndefined();
		expect(one('where-your-work-is')?.tagName).toBe('P');
	});
});

describe('everything else, one press away', () => {
	test('keeps the popover closed until the badge is pressed, holds all four details, and closes on a second press', () => {
		bar(reading('changes-to-send'), BASELINE);
		expect(one('remote-status-detail')?.getAttribute('popover')).toBe('auto');
		expect(one('where-your-work-is')?.getAttribute('aria-expanded')).toBe('false');
		press('where-your-work-is');
		expect(one('where-your-work-is')?.getAttribute('aria-expanded')).toBe('true');
		expect(text('remote-status-determination')).toContain('Changes to send');
		expect(text('remote-status-detail')).toContain('Sync sends them');
		expect(text('remote-status-checked')).toContain('Checked at');
		expect(text('remote-status-baseline')).toContain(BASELINE.commit);
		expect(text('remote-status-baseline')).toContain('2 files');
		press('where-your-work-is');
		expect(one('where-your-work-is')?.getAttribute('aria-expanded')).toBe('false');
	});

	test('leaves the Baseline line out when there is no Baseline', () => {
		bar(reading('cannot-tell'));
		press('where-your-work-is');
		expect(one('remote-status-determination')).not.toBeNull();
		expect(one('remote-status-baseline')).toBeNull();
	});

	test('offers no gesture of its own, in either state of the disclosure', () => {
		bar(reading('in-sync'));
		expect(one('check-remote-status')).toBeNull();
		press('where-your-work-is');
		expect(one('check-remote-status')).toBeNull();
	});

	test.each(DETERMINATIONS)('%s has both a label and a sentence behind the press', (status) => {
		bar(reading(status));
		press('where-your-work-is');
		const detail = text('remote-status-detail');
		expect(detail).toContain(REMOTE_STATUS_LABELS[status]);
		expect(detail.replace(REMOTE_STATUS_LABELS[status], '').trim().length).toBeGreaterThan(20);
	});
});

describe('a check that failed', () => {
	test.each(['in-sync', 'changes-both-ways'] as const)(
		'%s keeps the determination it had',
		(status) => {
			bar(reading(status));
			press('where-your-work-is');
			const determination = text('remote-status-determination');
			const checked = text('remote-status-checked');
			takeDown();

			bar({
				...reading(status),
				failure: 'GitHub could not be reached, so the status below is the last one read.'
			});
			press('where-your-work-is');
			expect(text('remote-status-determination')).toBe(determination);
			expect(text('remote-status-checked')).toBe(checked);
			expect(one('where-your-work-is')?.dataset.remoteStatus).toBe(status);
		}
	);
});

describe('a Published Site built from other files', () => {
	test('is its own message rather than a determination', () => {
		bar({ ...reading('in-sync'), publishedSiteStale: ['index.html', 'app.js'] });
		press('where-your-work-is');
		const stale = toasts.items.find((item) => item.testid === 'published-site-stale');
		expect(stale?.text).toContain('2 files');
		expect(stale?.tone).toBe('info');
		expect(text('remote-status-determination')).toBe(REMOTE_STATUS_LABELS['in-sync']);
		expect(one('where-your-work-is')?.dataset.remoteStatus).toBe('in-sync');
	});
});

describe('the words the badge uses', () => {
	test.each([...DETERMINATIONS, null])(
		'%s says none of the words the glossary refuses',
		(status) => {
			bar(reading(status), BASELINE);
			press('where-your-work-is');
			const surface = (document.body.textContent ?? '').toLowerCase();
			for (const word of FORBIDDEN) expect(surface).not.toContain(word);
		}
	);
});
