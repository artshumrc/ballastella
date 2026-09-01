// What the choice of repository shows and what it refuses, at Seam 1c.
//
// ⚠ **The subject is the list as a choice, not the listing.** Which repositories GitHub reports and
// what a rejected sign-in does are `github-installations.ts`'s at Seam 1; that they are read and
// one is connected belongs to whoever owns the sequence. What only this seam can say cheaply is
// which rows are present, what each is marked with, which of them a press reports, and which it
// refuses — none of which needs a browser.
//
// ⚠ **Unselectable is asserted through the callback, not through `disabled`.** The rows stay in the
// tab order deliberately, so "it cannot lead me into the failure it just warned me about" is a claim
// about what the press *does* rather than about whether the DOM swallowed it.

import type { GrantedRepository } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import RepositoryChoice from './RepositoryChoice.svelte';

const publishable: GrantedRepository = {
	owner: 'ada',
	repository: 'atlas',
	canPublish: true,
	canGrantAccess: true,
	isPrivate: false
};

const readOnly: GrantedRepository = {
	owner: 'grace',
	repository: 'shared-maps',
	canPublish: false,
	canGrantAccess: false,
	isPrivate: false
};

const priv: GrantedRepository = {
	owner: 'ada',
	repository: 'diary',
	canPublish: true,
	canGrantAccess: true,
	isPrivate: true
};

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

function choice(repositories: readonly GrantedRepository[], onchoose = vi.fn()): typeof onchoose {
	const main = document.createElement('main');
	document.body.append(main);
	mounted = mount(RepositoryChoice, { target: main, props: { repositories, onchoose } });
	flushSync();
	return onchoose;
}

const rows = (): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>('[data-testid="granted-repository"]')
];

const rowFor = (named: string): HTMLElement => {
	const found = rows().find((row) => (row.textContent ?? '').includes(named));
	if (!found) throw new Error(`no row is rendered for ${named}`);
	return found;
};

const buttonIn = (row: HTMLElement): HTMLButtonElement => {
	const found = row.querySelector('button');
	if (!found) throw new Error('the row has no button in it');
	return found;
};

/** An element's words with the template's own line breaks collapsed. */
const text = (element: Element | null | undefined): string =>
	(element?.textContent ?? '').replace(/\s+/g, ' ').trim();

const said = (): string => text(document.body);

const filter = (): HTMLInputElement => {
	const found = document.querySelector<HTMLInputElement>('[data-testid="repository-filter"]');
	if (!found) throw new Error('the repository filter is not rendered');
	return found;
};

const filterBy = (value: string): void => {
	filter().value = value;
	filter().dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
};

describe('the repositories a person may put their map in', () => {
	// An absent repository has to read as access not granted rather than as a repository that is not
	// there, and only the list itself can say so.
	test('says the list is what has been given access, before the list', () => {
		choice([publishable]);

		expect(said()).toContain('given Ballastella access to');
		expect(said()).toContain('has not been given access yet');
	});

	// Every row, not only the refused ones — absence is not a mark.
	test('marks each repository with whether it can be published to', () => {
		choice([publishable, readOnly]);

		expect(rowFor('ada/atlas').textContent).toContain('Can be published to');
		expect(rowFor('grace/shared-maps').textContent).toContain('Cannot be published to');
	});

	test('reports the repository chosen', () => {
		const onchoose = choice([publishable, readOnly]);

		buttonIn(rowFor('ada/atlas')).click();
		flushSync();

		expect(onchoose).toHaveBeenCalledWith(publishable);
	});

	test('filters repositories by their full name without changing their order', () => {
		choice([publishable, readOnly]);

		filterBy('SHARED');

		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toHaveTextContent('grace/shared-maps');
	});

	test('says when the filter matches no repository', () => {
		choice([publishable]);

		filterBy('not-a-repository');

		expect(rows()).toHaveLength(0);
		expect(said()).toContain('No repositories match “not-a-repository”.');
	});

	test('keeps the repository rows in their own bounded scroller', () => {
		choice([publishable]);

		expect(document.querySelector('[data-testid="repository-list"]')).toHaveClass(
			'max-h-64',
			'overflow-y-auto'
		);
	});
});

/**
 * Hiding these rows reproduces the very mystery this screen exists to remove — the author goes
 * looking for the repository they made and cannot tell a permission they did not grant from a
 * repository that is not there — so each is present, marked, and refused.
 */
describe('a repository that cannot be published to', () => {
	test('is present and unselectable rather than hidden', () => {
		const onchoose = choice([publishable, readOnly]);

		const row = rowFor('grace/shared-maps');
		expect(buttonIn(row)).toHaveAttribute('aria-disabled', 'true');

		buttonIn(row).click();
		flushSync();

		expect(onchoose).not.toHaveBeenCalled();
	});

	test('says what would put it right', () => {
		choice([readOnly]);

		expect(rowFor('grace/shared-maps').textContent).toContain('write access');
	});

	// A private repository is publishable and still no use: the map would arrive and nobody sent the
	// address could open it.
	test('a private one is present, unselectable, and says why', () => {
		const onchoose = choice([publishable, priv]);

		const row = rowFor('ada/diary');
		expect(row.textContent).toContain('private');
		expect(row.textContent).toContain('would not be visible');
		expect(buttonIn(row)).toHaveAttribute('aria-disabled', 'true');

		buttonIn(row).click();
		flushSync();

		expect(onchoose).not.toHaveBeenCalled();
	});

	/**
	 * Two things to put right are two sentences. A row that named only one would send the author to
	 * fix half of it and come back to the same refusal.
	 */
	test('names both reasons when both hold', () => {
		choice([
			{
				owner: 'grace',
				repository: 'notes',
				canPublish: false,
				canGrantAccess: false,
				isPrivate: true
			}
		]);

		const row = rowFor('grace/notes');
		expect(row.textContent).toContain('write access');
		expect(row.textContent).toContain('private');
	});
});

// Nothing granted is the ordinary state of somebody who has just made an account, and a blank area
// under a heading reads as something that failed.
describe('having granted nothing', () => {
	test('is a step with an instruction rather than an empty area', () => {
		choice([]);

		const empty = document.querySelector('[data-testid="repository-choice-empty"]');
		expect(text(empty)).toContain('making one is the next step');
		expect(said()).toContain('folder on GitHub your map will live in');
		expect(rows()).toHaveLength(0);
	});
});
