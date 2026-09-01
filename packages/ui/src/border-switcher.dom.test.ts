// What the border switcher renders, asserted against the component rather than against an app.
//
// The subject is the `<select>` the component builds out of core's list of boundary choices: that it
// offers all of them in that order, that it shows the current one, and that changing it reports the
// choice. It is the same shape as `base-map-switcher.dom.test.ts` because the control is — the two
// stand side by side and a difference in shape would read as a difference in kind.
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
	labelSrOnly?: boolean;
	fullWidth?: boolean;
	class?: string;
}) => {
	mounted = mount(BorderSwitcher, { target: document.body, props });
	flushSync();
	return document.querySelector('select')!;
};

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('offers every boundary choice core defines, in its order', () => {
	const select = render({ borders: 'all', onSelect: () => {} });

	expect([...select.options].map((option) => option.value)).toEqual([...BASE_MAP_BORDERS]);
});

test('reads every choice as a whole phrase, so no option has to be guessed at', () => {
	const select = render({ borders: 'all', onSelect: () => {} });

	expect([...select.options].map((option) => option.textContent)).toEqual([
		'No borders',
		'National only',
		'National and internal'
	]);
});

test('shows the choice it is handed', () => {
	expect(render({ borders: 'national', onSelect: () => {} }).value).toBe('national');
});

test('shows every boundary by default, which is what a Project drew before the field existed', () => {
	expect(render({ borders: DEFAULT_BASE_MAP_BORDERS, onSelect: () => {} }).value).toBe('all');
});

test('reports the choice that was made', () => {
	const onSelect = vi.fn();
	const select = render({ borders: 'all', onSelect });

	select.value = 'none';
	select.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();

	expect(onSelect).toHaveBeenCalledExactlyOnceWith('none');
});

// The `<select>` needs an accessible name, and ADR-0016 keeps that out of a `title` — so the label
// goes off the screen rather than away, for a caller whose own heading already says the word.
test('keeps the label for a screen reader when it is off the screen', () => {
	render({ borders: 'all', onSelect: () => {}, labelSrOnly: true });
	const label = document.querySelector('label')!;

	expect(label.className).toContain('sr-only');
	expect(label.textContent?.trim()).toBe('Borders');
	expect(label.getAttribute('for')).toBe(document.querySelector('select')!.id);
});

test('fills its caller’s width only when asked, and takes the caller’s own class', () => {
	expect(render({ borders: 'all', onSelect: () => {} }).className).toContain('w-full');

	unmount(mounted!);
	document.body.innerHTML = '';

	const fitted = render({
		borders: 'all',
		onSelect: () => {},
		fullWidth: false,
		class: 'select-sm'
	});
	expect(fitted.className).toContain('w-fit');
	expect(fitted.className).toContain('select-sm');
});
