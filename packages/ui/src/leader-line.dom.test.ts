// The leader as a component: what it puts in the document, and what it does not.
//
// Seam 1c holds the wiring — that the layer is decoration, that exactly one line is drawn, that the
// geometry written out is the geometry `leaderPath` decided. The boxes are stubbed, because
// happy-dom performs no layout and reports every rectangle as zero; what that costs is any claim
// about a *real* arrangement, which is why the projection claim is `e2e/editor-annotations.e2e.ts`'s
// and cannot be made here.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test } from 'vitest';

import LeaderLine from './LeaderLine.svelte';
import type { Box } from './leader-line.js';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

/** An element that reports the box it is told to, since happy-dom lays nothing out. */
const at = (box: Box): HTMLElement => {
	const element = document.createElement('div');
	element.getBoundingClientRect = (): DOMRect =>
		({
			left: box.left,
			top: box.top,
			right: box.right,
			bottom: box.bottom,
			width: box.right - box.left,
			height: box.bottom - box.top,
			x: box.left,
			y: box.top,
			toJSON: () => ({})
		}) as DOMRect;
	document.body.append(element);
	return element;
};

const sidebar = at({ left: 0, top: 0, right: 300, bottom: 600 });
const canvas = at({ left: 300, top: 0, right: 1000, bottom: 600 });

/**
 * The layer mounted in a container of its own, with the two ends it is given.
 *
 * The container's own box is left as happy-dom reports it — all zeros — which is the origin the
 * boxes above are already stated against, so the numbers written out are the ones `leaderPath` was
 * asserted on directly.
 */
const draw = (
	over: { mark?: Element | null; row?: Element | null } = {}
): { layer: SVGSVGElement; line: SVGPolylineElement } => {
	const target = document.createElement('div');
	document.body.append(target);
	mounted = mount(LeaderLine, {
		target,
		props: {
			mark: () => over.mark ?? null,
			row: () => over.row ?? null,
			canvas: () => canvas,
			sidebar: () => sidebar
		}
	});
	flushSync();
	const layer = target.querySelector('svg') as SVGSVGElement;
	return { layer, line: layer.querySelector('polyline') as SVGPolylineElement };
};

describe('LeaderLine', () => {
	test('is decoration: hidden from assistive technology, unclickable, and out of the tab order', () => {
		const { layer } = draw();
		expect(layer.getAttribute('aria-hidden')).toBe('true');
		expect(layer.getAttribute('focusable')).toBe('false');
		// Nothing inside it can be reached by a keyboard, which is the claim rather than the class:
		// there is no element in the layer that carries a tab stop of its own.
		expect(layer.querySelectorAll('a, button, input, [tabindex]')).toHaveLength(0);
		// `pointer-events: none` is in the shared stylesheet, which is not loaded here — what is
		// asserted is that the element wears the class the rule is written against.
		expect(layer.classList.contains('leader-line')).toBe(true);
	});

	test('draws nothing at all when nothing is selected', () => {
		const { layer, line } = draw();
		expect(layer.dataset['drawn']).toBe('no');
		expect(line.hasAttribute('points')).toBe(false);
	});

	test('draws exactly one line, from the row to the mark', () => {
		const row = at({ left: 10, top: 100, right: 290, bottom: 130 });
		const mark = at({ left: 590, top: 290, right: 610, bottom: 310 });
		const { layer, line } = draw({ row, mark });
		// Mounted with the boxes already in hand, so the redraw the mount performed had them.
		expect(layer.querySelectorAll('polyline')).toHaveLength(1);
		expect(layer.dataset['drawn']).toBe('yes');
		expect(line.getAttribute('points')?.startsWith('290,115 ')).toBe(true);
	});

	test('a mark that has gone takes the line with it', () => {
		// The Annotation was deleted, or its Layer hidden: the row is still on screen and there is
		// nothing on the canvas to point at.
		const row = at({ left: 10, top: 100, right: 290, bottom: 130 });
		const { layer, line } = draw({ row });
		expect(layer.dataset['drawn']).toBe('no');
		expect(line.hasAttribute('points')).toBe(false);
	});
});
