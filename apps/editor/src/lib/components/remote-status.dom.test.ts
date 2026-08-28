// The plain answer the navigation bar gives to *is my work on GitHub*, at Seam 1c.
//
// ⚠ **The subject is the projection, not the determination.** Which of the six a Workspace is in is
// `remote-status.ts`'s at Seam 1, and this file must not be able to change that answer: it renders
// the component against a state it was handed. What only this seam can say cheaply is what a reader
// sees for each of the six — which is a claim about seven sentences and one press, and needs no
// browser.
//
// ⚠ **The three cautionary determinations are asserted negatively as well as positively.** A lead
// that read as agreement during a Conflict is the misreading the whole design exists to refuse, and
// an assertion that only checked the exact string would keep passing after somebody softened it.

import {
	REMOTE_STATUS_LABELS,
	REMOTE_STATUS_UNCHECKED,
	UNCHECKED_REMOTE_STATUS,
	type RemoteStatusState,
	type SourceStatus
} from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

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

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

function bar(state: Partial<RemoteStatusState> = {}): void {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(RemoteStatus, {
		target: main,
		props: {
			state: { ...UNCHECKED_REMOTE_STATUS, ...state },
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

/** One determination's lead, read from its own mount, so two readings cannot share a document. */
function leadFor(status: SourceStatus): string {
	bar({ status, at: Date.parse('2026-08-27T10:00:00Z') });
	const lead = text('remote-status-state');
	unmount(mounted!);
	mounted = undefined;
	document.body.innerHTML = '';
	return lead;
}

describe('the lead in the navigation bar', () => {
	test.each(DETERMINATIONS)('%s reads as a plain answer about GitHub', (status) => {
		bar({ status, at: Date.parse('2026-08-27T10:00:00Z') });

		const lead = text('remote-status-state');
		expect(lead).not.toBe('');
		// Not the determination's own label: that is what the press is for.
		expect(lead).not.toContain(REMOTE_STATUS_LABELS[status]);
		expect(lead).toContain('GitHub');
	});

	test('says the reading has not been taken rather than projecting one of the six', () => {
		bar();

		expect(text('remote-status-state')).toContain(REMOTE_STATUS_UNCHECKED);
	});

	test.each(['conflict', 'changes-on-both-sides', 'cannot-tell'] as const)(
		'%s does not read as work being safe on GitHub',
		(status) => {
			const agreement = leadFor('up-to-date');
			const lead = leadFor(status);

			expect(lead).not.toBe(agreement);
			expect(lead).not.toMatch(/\bis on GitHub\b/i);
		}
	);

	test('keeps the determination readable by a spec without putting it on screen', () => {
		bar({ status: 'conflict', at: Date.parse('2026-08-27T10:00:00Z') });

		expect(at('remote-status-state')?.dataset.remoteStatus).toBe('conflict');
	});
});

describe('the determination and its detail, one press away', () => {
	test('are not on screen until the lead is pressed', () => {
		bar({ status: 'changes-to-publish', at: Date.parse('2026-08-27T10:00:00Z') });

		expect(at('remote-status-detail')).toBeNull();
		expect(at('remote-status-explain')?.getAttribute('aria-expanded')).toBe('false');

		press('remote-status-explain');

		expect(at('remote-status-explain')?.getAttribute('aria-expanded')).toBe('true');
		expect(text('remote-status-detail')).toContain('Changes to publish');
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

describe('the vocabulary', () => {
	test.each([...DETERMINATIONS, null])(
		'%s says none of the words the glossary refuses',
		(status) => {
			bar({ status, at: status === null ? null : Date.parse('2026-08-27T10:00:00Z') });
			press('remote-status-explain');

			const surface = (document.body.textContent ?? '').toLowerCase();
			for (const word of FORBIDDEN) expect(surface).not.toContain(word);
		}
	);
});
