// The control that downloads a Map Snapshot: its two labels, and the semantics behind them.
//
// Seam 1c and not Seam 2, because everything asserted here is markup — the element, its accessible
// name, whether it is in the tab order — and none of it needs a map. What a real map adds is the
// picture, which is the manual checklist's.
//
// Everything is read straight off the document; there is no component-testing library.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import MapSnapshotButton from './MapSnapshotButton.svelte';

let mounted: Record<string, unknown> | undefined;

const render = (props: Partial<Record<string, unknown>> = {}) => {
	mounted = mount(MapSnapshotButton, {
		target: document.body,
		props: { ready: true, onclick: () => {}, ...props }
	});
	flushSync();
	return document.querySelector<HTMLButtonElement>('[data-testid="download-map-snapshot"]')!;
};

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

test('is a native button named in words, with no tooltip carrying the meaning', () => {
	// ADR-0016: an icon with a `title` is not a name — daisyUI renders tooltips through CSS
	// `::before`, which no screen reader announces, and a touch screen has no hover to reveal it.
	const button = render();

	expect(button.tagName).toBe('BUTTON');
	expect(button.type).toBe('button');
	expect(button).toHaveAccessibleName('Download map snapshot');
	expect(document.querySelector('[title]')).toBeNull();
});

test('is operable from the keyboard, which is what a `<button>` is for', () => {
	// Focused rather than clicked: `focus()` plus the platform's own activation is the press a
	// keyboard user makes, and it is the press a `<div>` with a click handler would fail.
	const onclick = vi.fn();
	const button = render({ onclick });

	button.focus();
	expect(document.activeElement).toBe(button);
	button.click();

	expect(onclick).toHaveBeenCalledTimes(1);
});

test('says it is preparing, and leaves the tab order, until the frame is complete', () => {
	// The label is the state. There is no second live region and no tooltip: what a screen-reader
	// user hears on reaching the control is the same sentence a sighted user reads.
	const button = render({ ready: false });

	expect(button).toHaveAccessibleName('Preparing map snapshot…');
	expect(button.disabled).toBe(true);
});

test('cannot be pressed while it is preparing', () => {
	const onclick = vi.fn();
	const button = render({ ready: false, onclick });

	button.click();

	expect(onclick).not.toHaveBeenCalled();
});

test('carries an icon that is decoration rather than a second name', () => {
	const button = render();

	expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
	expect(button).toHaveAccessibleName('Download map snapshot');
});
