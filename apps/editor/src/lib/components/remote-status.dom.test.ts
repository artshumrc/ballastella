// The one badge the navigation bar answers *where is my work* with, at Seam 1c.
//
// ⚠ **The subject is the projection, not the determination.** Which of the six a Workspace is in is
// `remote-status.ts`'s at Seam 1, and this file must not be able to change that answer: it renders
// the component against a state it was handed. What only this seam can say cheaply is what a reader
// sees for each of the six — which is a claim about one badge, two clauses and one press, and needs
// no browser.
//
// ⚠ **The three cautionary determinations are asserted negatively as well as positively.** A lead
// that read as agreement during a Conflict is the misreading the whole design exists to refuse, and
// an assertion that only checked the exact string would keep passing after somebody softened it.

import {
	REMOTE_STATUS_LABELS,
	REMOTE_STATUS_UNCHECKED,
	UNCHECKED_REMOTE_STATUS,
	type RemoteStatusState,
	type SourceStatus,
	type SynchronizationBaseline
} from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { toasts } from '$lib/toasts/toasts.svelte.js';

import RemoteStatus from './RemoteStatus.svelte';

/** Every determination there is, so a seventh added to core arrives here as a failure. */
const DETERMINATIONS = Object.keys(REMOTE_STATUS_LABELS) as SourceStatus[];

/**
 * The words the glossary's *Avoid* lists put out of reach on this surface.
 *
 * Substantive rather than stylistic: a Publish mirrors an owned namespace and removes Projects the
 * author deleted locally (ADR-0033), so calling it a backup would be a promise the code does not
 * keep.
 */
const FORBIDDEN = [
	'backed up',
	'back up',
	'backup',
	'the cloud',
	'sync',
	'in sync',
	'ahead',
	'behind',
	'dirty'
];

const BASELINE: SynchronizationBaseline = {
	remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
	commit: 'c0ffee1',
	files: new Map([
		['projects/atlas/project.json', 'aaa'],
		['projects/atlas/map.tif', 'bbb']
	])
};

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
			state: { ...UNCHECKED_REMOTE_STATUS, ...state },
			baseline: extra.baseline ?? null,
			onCheck: vi.fn(),
			update: null,
			notice: '',
			failure: '',
			onUpdate: vi.fn(),
			deletionPreview: null,
			onAnswerDeletions: vi.fn()
		}
	});
	flushSync();
}

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

/** One determination's GitHub clause, from its own mount. */
function clauseFor(status: SourceStatus): string {
	bar({ status, at: Date.parse('2026-08-27T10:00:00Z') });
	const clause = text('where-your-work-is');
	clear();
	return clause;
}

describe('one badge, two clauses', () => {
	test.each([...DETERMINATIONS, null])('%s keeps both clauses on the badge', (status) => {
		bar({ status, at: status === null ? null : Date.parse('2026-08-27T10:00:00Z') });

		const badge = text('where-your-work-is');
		// Where the work is kept here…
		expect(badge).toContain('Saved locally');
		// …and whether GitHub has it, in the same line and never in one word.
		expect(badge).toContain('GitHub');
		expect(badge.replace('Saved locally', '').replace(/[·\s]/g, '').length).toBeGreaterThan(1);
	});

	test('is the only status region in the bar', () => {
		bar({ status: 'up-to-date', at: Date.parse('2026-08-27T10:00:00Z') });

		expect(document.querySelectorAll('[role="status"]')).toHaveLength(1);
		expect(at('where-your-work-is')?.getAttribute('role')).toBe('status');
	});

	test('says the reading has not been taken rather than projecting one of the six', () => {
		bar();
		press('remote-status-explain');

		// Named as GitHub's on the badge, and as the domain's own seventh sentence behind the press.
		expect(text('where-your-work-is')).toMatch(/GitHub has not been checked/i);
		expect(text('remote-status-determination')).toBe(REMOTE_STATUS_UNCHECKED);
	});

	test.each(DETERMINATIONS)(
		'%s leads with a plain answer rather than the determination',
		(status) => {
			bar({ status, at: Date.parse('2026-08-27T10:00:00Z') });

			// Not the determination's own label: that is what the press is for.
			expect(text('where-your-work-is')).not.toContain(REMOTE_STATUS_LABELS[status]);
		}
	);

	test.each(['conflict', 'changes-on-both-sides', 'cannot-tell'] as const)(
		'%s does not read as work being safe on GitHub',
		(status) => {
			const agreement = clauseFor('up-to-date');
			const clause = clauseFor(status);

			expect(clause).not.toBe(agreement);
			expect(clause).not.toMatch(/\bis on GitHub\b/i);
		}
	);

	test('keeps the determination readable by a spec without putting it on screen', () => {
		bar({ status: 'conflict', at: Date.parse('2026-08-27T10:00:00Z') });

		expect(at('where-your-work-is')?.dataset.remoteStatus).toBe('conflict');
	});
});

describe('everything else, one press away', () => {
	test('holds nothing until the disclosure is pressed, and all four after', () => {
		bar(
			{ status: 'changes-to-publish', at: Date.parse('2026-08-27T10:00:00Z') },
			{
				baseline: BASELINE
			}
		);

		expect(at('remote-status-detail')).toBeNull();
		expect(at('remote-status-determination')).toBeNull();
		expect(at('remote-status-checked')).toBeNull();
		expect(at('remote-status-baseline')).toBeNull();
		expect(at('remote-status-explain')?.getAttribute('aria-expanded')).toBe('false');

		press('remote-status-explain');

		expect(at('remote-status-explain')?.getAttribute('aria-expanded')).toBe('true');
		expect(text('remote-status-determination')).toContain('Changes to publish');
		expect(text('remote-status-detail')).toContain('Publish sends them to GitHub');
		expect(text('remote-status-checked')).toContain('Checked at');
		expect(text('remote-status-baseline')).toContain(BASELINE.commit);
		expect(text('remote-status-baseline')).toContain('2 files');
	});

	test('leaves the Baseline line out when there is no Baseline', () => {
		bar({ status: 'cannot-tell', at: Date.parse('2026-08-27T10:00:00Z') });
		press('remote-status-explain');

		expect(at('remote-status-determination')).not.toBeNull();
		expect(at('remote-status-baseline')).toBeNull();
	});

	test('keeps the check and the Update reachable behind the same press', () => {
		bar({ status: 'up-to-date', at: Date.parse('2026-08-27T10:00:00Z') });

		expect(at('check-remote-status')).toBeNull();
		expect(at('update-from-github')).toBeNull();

		press('remote-status-explain');

		expect(at('check-remote-status')).not.toBeNull();
		expect(at('update-from-github')).not.toBeNull();
	});

	test.each(DETERMINATIONS)('%s has both a label and a sentence behind the press', (status) => {
		bar({ status, at: Date.parse('2026-08-27T10:00:00Z') });
		press('remote-status-explain');

		const detail = text('remote-status-detail');
		expect(detail).toContain(REMOTE_STATUS_LABELS[status]);
		// A sentence of its own beyond the label, and not merely the label repeated.
		expect(detail.replace(REMOTE_STATUS_LABELS[status], '').trim().length).toBeGreaterThan(20);
	});

	test('closes again on a second press', () => {
		bar({ status: 'up-to-date', at: Date.parse('2026-08-27T10:00:00Z') });

		press('remote-status-explain');
		press('remote-status-explain');

		expect(at('remote-status-detail')).toBeNull();
	});
});

// ⚠ **A network failure is not agreement.** Reported as `Up to date` it is the one reading that
// licenses publishing over somebody else's afternoon, and reported as a Conflict resolved it is the
// one that licenses believing a Conflict is over.
describe('a check that failed', () => {
	test.each(['up-to-date', 'conflict'] as const)('%s keeps the determination it had', (status) => {
		bar({ status, at: Date.parse('2026-08-27T10:00:00Z') });
		press('remote-status-explain');
		const determination = text('remote-status-determination');
		const checked = text('remote-status-checked');
		clear();

		bar({
			status,
			at: Date.parse('2026-08-27T10:00:00Z'),
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
		bar({
			status: 'up-to-date',
			at: Date.parse('2026-08-27T10:00:00Z'),
			publishedSiteStale: ['index.html', 'app.js']
		});
		press('remote-status-explain');

		// A message the reader can put away, drawn in the app's one stack rather than in the bar.
		const stale = toasts.items.find((item) => item.testid === 'published-site-stale');
		expect(stale?.text).toContain('2 files');
		expect(stale?.tone).toBe('info');

		// And the determination beside it is untouched by it.
		expect(text('remote-status-determination')).toBe(REMOTE_STATUS_LABELS['up-to-date']);
		expect(at('where-your-work-is')?.dataset.remoteStatus).toBe('up-to-date');
	});
});

describe('the vocabulary', () => {
	test.each([...DETERMINATIONS, null])(
		'%s says none of the words the glossary refuses',
		(status) => {
			bar(
				{ status, at: status === null ? null : Date.parse('2026-08-27T10:00:00Z') },
				{ baseline: BASELINE }
			);
			press('remote-status-explain');

			const surface = (document.body.textContent ?? '').toLowerCase();
			for (const word of FORBIDDEN) expect(surface).not.toContain(word);
		}
	);
});
