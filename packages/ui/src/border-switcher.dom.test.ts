import { BASE_MAP_BORDERS, DEFAULT_BASE_MAP_BORDERS, type BaseMapBorders } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import BorderSwitcher from './BorderSwitcher.svelte';

let mounted: Record<string, unknown> | undefined;

const render = (props: {
	borders: BaseMapBorders;
	onSelect: (borders: BaseMapBorders) => void;
	legend?: string;
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
	// Three radios with three names are three independent checkboxes wearing a circle: each can be set on its own, none can be unset, and a screen reader announces no position in a group.
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

test('groups the radios under a legend, kept for a screen reader when taken off the screen', () => {
	render({ borders: 'all', onSelect: () => {} });
	expect(document.querySelector('fieldset > legend')?.textContent?.trim()).toBe('Borders');
});

test('carries the test id both suites address the control by', () => {
	render({ borders: 'all', onSelect: () => {} });
	expect(document.querySelector('fieldset')).toHaveAttribute('data-testid', 'border-switcher');
});
