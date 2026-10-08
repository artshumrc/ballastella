import type { GrantedRepository } from '@ballastella/core';
import { flushSync } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { all, at, fill, inMain, said, show, takeDown, textOf } from '$lib/test-support/dom.js';

import RepositoryChoice from './RepositoryChoice.svelte';

const writable: GrantedRepository = {
	owner: 'ada',
	repository: 'atlas',
	canPush: true,
	canGrantAccess: true,
	isPrivate: false
};

const readOnly: GrantedRepository = {
	owner: 'grace',
	repository: 'shared-maps',
	canPush: false,
	canGrantAccess: false,
	isPrivate: false
};

const priv: GrantedRepository = {
	owner: 'ada',
	repository: 'diary',
	canPush: true,
	canGrantAccess: true,
	isPrivate: true
};

afterEach(takeDown);

function choice(repositories: readonly GrantedRepository[], onchoose = vi.fn()): typeof onchoose {
	show(RepositoryChoice, { repositories, onchoose }, inMain());
	return onchoose;
}

const rows = (): HTMLElement[] => all('granted-repository');

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

const filterBy = (value: string): void => fill('repository-filter', value);

const choose = (named: string): void => {
	buttonIn(rowFor(named)).click();
	flushSync();
};

const inRow = (named: string, testid: string): string =>
	textOf(rowFor(named).querySelector(`[data-testid="${testid}"]`));

describe('the repositories a person may put their map in', () => {
	test('says the list is what has been given access, before the list', () => {
		choice([writable]);
		expect(said()).toContain('given Ballastella access to');
		expect(said()).toContain('has not been given access yet');
	});

	test('marks each repository with whether it can be sent to', () => {
		choice([writable, readOnly]);
		expect(rowFor('ada/atlas').textContent).toContain('Can be sent to');
		expect(rowFor('grace/shared-maps').textContent).toContain('Cannot be sent to');
	});

	test('reports the repository chosen', () => {
		const onchoose = choice([writable, readOnly]);
		choose('ada/atlas');
		expect(onchoose).toHaveBeenCalledWith(writable);
	});

	test('filters repositories by their full name without changing their order', () => {
		choice([writable, readOnly]);
		filterBy('SHARED');
		expect(rows()).toHaveLength(1);
		expect(rows()[0]).toHaveTextContent('grace/shared-maps');
	});

	test('says when the filter matches no repository', () => {
		choice([writable]);
		filterBy('not-a-repository');
		expect(rows()).toHaveLength(0);
		expect(said()).toContain('No repositories match “not-a-repository”.');
	});

	test('keeps the repository rows in their own bounded scroller', () => {
		choice([writable]);
		expect(at('repository-list')).toHaveClass('max-h-64', 'overflow-y-auto');
	});
});

describe('a repository that cannot be sent to', () => {
	test('is present and unselectable rather than hidden', () => {
		const onchoose = choice([writable, readOnly]);
		expect(buttonIn(rowFor('grace/shared-maps'))).toHaveAttribute('aria-disabled', 'true');
		choose('grace/shared-maps');
		expect(onchoose).not.toHaveBeenCalled();
	});

	test('says what would put it right, and of a private one, that it is private', () => {
		choice([
			readOnly,
			{
				owner: 'grace',
				repository: 'notes',
				canPush: false,
				canGrantAccess: false,
				isPrivate: true
			}
		]);

		expect(inRow('grace/shared-maps', 'unselectable-reason')).toContain('write access');
		expect(inRow('grace/notes', 'unselectable-reason')).toContain('write access');
		expect(inRow('grace/notes', 'repository-note')).toContain('private');
	});
});

describe('a repository that is private', () => {
	test('is chooseable, because it syncs exactly as a public one does', () => {
		const onchoose = choice([writable, priv]);
		const row = rowFor('ada/diary');
		expect(buttonIn(row)).not.toHaveAttribute('aria-disabled', 'true');
		expect(row.querySelector('[data-testid="unselectable-reason"]')).toBeNull();
		choose('ada/diary');
		expect(onchoose).toHaveBeenCalledWith(priv);
	});

	test('carries the paid-plan note about Share Links on its row, and on no other kind', () => {
		choice([writable, readOnly, priv]);
		expect(inRow('ada/diary', 'repository-note')).toContain('paid GitHub plan');
		expect(inRow('ada/diary', 'repository-note')).toContain(
			'syncs to it exactly as it would to a public one'
		);
		expect(
			[...document.querySelectorAll('[data-testid="repository-note"]')].map((note) =>
				note.closest('[data-testid="granted-repository"]')?.textContent?.slice(0, 9)
			)
		).toEqual(['ada/diary']);
	});
});

describe('having granted nothing', () => {
	test('is a step with an instruction rather than an empty area', () => {
		choice([]);
		expect(textOf(at('repository-choice-empty'))).toContain('making one is the next step');
		expect(said()).toContain('folder on GitHub your map will live in');
		expect(rows()).toHaveLength(0);
	});
});
