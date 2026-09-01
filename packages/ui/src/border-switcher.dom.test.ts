// What the border switcher renders, asserted against the component rather than against an app.
//
// The subject is the radio group the component builds out of core's list of boundary choices: that
// it offers all of them in that order, that it shows the current one, that they are one choice
// rather than three, and that changing it reports what was chosen.
//
// What stays in `e2e/` is the other half: that choosing here redraws MapLibre and lands in
// `project.json`. That is a claim about the application, not about this markup.
//
// Everything is read straight off the document — `mount` is Svelte's own and a query is
// `document.querySelector`. There is no component-testing library.

import { BASE_MAP_BORDERS, DEFAULT_BASE_MAP_BORDERS, type BaseMapBorders } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BorderSwitcher from './BorderSwitcher.svelte';

let mounted: Record<string, unknown> | undefined;

const render = (props: {
	borders: BaseMapBorders;
	onSelect: (borders: BaseMapBorders) => void;
	legend?: string;
	legendSrOnly?: boolean;
}) => {
	mounted = mount(BorderSwitcher, { target: document.body, props });
	flushSync();
	return [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
};

const chosen = (radios: HTMLInputElement[]): string | undefined =>
	radios.find((radio) => radio.checked)?.value;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('offers every boundary choice core defines, in its order', () => {
	const radios = render({ borders: 'all', onSelect: () => {} });

	expect(radios.map((radio) => radio.value)).toEqual([...BASE_MAP_BORDERS]);
});

test('reads every choice as a whole phrase, so no option has to be guessed at', () => {
	render({ borders: 'all', onSelect: () => {} });

	expect([...document.querySelectorAll('label')].map((label) => label.textContent?.trim())).toEqual(
		['No borders', 'National only', 'National and internal']
	);
});

test('is one choice rather than three, which is what the shared name makes it', () => {
	// Three radios with three names are three independent checkboxes wearing a circle: each can be
	// set on its own, none can be unset, and a screen reader announces no position in a group. The
	// name is generated rather than a literal, so two of these on one screen cannot unset each other.
	const radios = render({ borders: 'all', onSelect: () => {} });

	expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
	expect(radios[0]!.name).not.toBe('');
});

test('shows the choice it is handed, and only that one', () => {
	const radios = render({ borders: 'national', onSelect: () => {} });

	expect(chosen(radios)).toBe('national');
	expect(radios.filter((radio) => radio.checked)).toHaveLength(1);
});

test('shows every boundary by default, which is what a Project drew before the field existed', () => {
	expect(chosen(render({ borders: DEFAULT_BASE_MAP_BORDERS, onSelect: () => {} }))).toBe('all');
});

test('reports the choice that was made', () => {
	const onSelect = vi.fn();
	const radios = render({ borders: 'all', onSelect });

	radios[0]!.click();
	flushSync();

	expect(onSelect).toHaveBeenCalledExactlyOnceWith('none');
});

// A group of radios needs a name of its own, and ADR-0016 keeps that out of a `title` — so the
// legend goes off the screen rather than away, for a caller whose own heading already says the word.
test('groups the radios under a legend, kept for a screen reader when taken off the screen', () => {
	render({ borders: 'all', onSelect: () => {} });
	expect(document.querySelector('fieldset > legend')?.textContent?.trim()).toBe('Borders');
	expect(document.querySelector('legend')).not.toHaveClass('sr-only');

	unmount(mounted!);
	document.body.innerHTML = '';

	render({ borders: 'all', onSelect: () => {}, legendSrOnly: true });
	expect(document.querySelector('legend')).toHaveClass('sr-only');
});

test('carries the test id both suites address the control by', () => {
	render({ borders: 'all', onSelect: () => {} });

	expect(document.querySelector('fieldset')).toHaveAttribute('data-testid', 'border-switcher');
});
