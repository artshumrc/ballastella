import type { Annotation } from '@ballastella/core';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { ANNOTATION_INSPECTOR_ID } from './constants.js';
import { KIND_STYLE } from './layer-kind-style.js';
import AnnotationInspectorHarness from './AnnotationInspectorHarness.svelte';
import AnnotationListHarness from './AnnotationListHarness.svelte';

const PAYLOAD = '<img src=x onerror=alert(1)>The west quay';

const annotation = (fields: {
	id: string;
	type?: 'Point' | 'LineString' | 'Polygon';
	title?: string;
	/** simplestyle's `marker-symbol`. */
	symbol?: string;
}): Annotation =>
	({
		id: fields.id,
		geometry: { type: fields.type ?? 'Point', coordinates: [0, 0] },
		properties: {
			...(fields.title === undefined ? {} : { title: fields.title }),
			...(fields.symbol === undefined ? {} : { 'marker-symbol': fields.symbol })
		}
	}) as Annotation;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const list = (props: ComponentProps<typeof AnnotationListHarness>): void => {
	mounted = mount(AnnotationListHarness, { target: document.body, props });
	flushSync();
};

const inspect = (props: ComponentProps<typeof AnnotationInspectorHarness>): void => {
	mounted = mount(AnnotationInspectorHarness, { target: document.body, props });
	flushSync();
};

const show = (annotations: readonly Annotation[] | null): void => {
	const harness = mounted as { show?: (next: readonly Annotation[] | null) => void } | undefined;
	if (!harness?.show) throw new Error('nothing is mounted that can be handed new Annotations');
	harness.show(annotations);
	flushSync();
};

const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

const all = (testId: string): HTMLElement[] => [
	...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)
];

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const nth = (testId: string, at: number): HTMLElement => {
	const found = all(testId)[at];
	if (!found) throw new Error(`no [data-testid="${testId}"] at position ${at}`);
	return found;
};

const names = () => all('annotation-row-name').map((row) => row.textContent?.trim());

const two = (): Annotation[] => [
	annotation({ id: 'a-1', title: 'One' }),
	annotation({ id: 'a-2', title: 'Two' })
];

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('an Annotation’s own words reach the screen as text (ADR-0009)', () => {
	test.each([
		[
			'the row',
			'annotation-row-name',
			() => list({ annotations: [annotation({ id: 'a-1', title: PAYLOAD })] })
		],
		[
			'the Inspector’s identity header',
			'annotation-inspector-name',
			() => inspect({ annotation: annotation({ id: 'a-1', title: PAYLOAD }), index: 0 })
		]
	])('a title that looks like markup is characters, not elements, in %s', (_, testId, mountIt) => {
		mountIt();
		const name = one(testId)!;
		expect(name).toHaveTextContent(PAYLOAD);
		expect(name.querySelector('img')).toBeNull();
		expect(name.children).toHaveLength(0);
	});

	test('a title displaces the fallback rather than joining it', () => {
		list({
			annotations: [annotation({ id: 'a-1', title: 'Fort Amsterdam' }), annotation({ id: 'a-2' })]
		});

		expect(names()).toEqual(['Fort Amsterdam', 'Untitled pin 2']);
		// The shape word is beside the name rather than instead of it, so the glyph is a second channel: a screen reader still hears which shape each row is.
		expect(nth('annotation-row', 0)).toHaveTextContent('pin');
	});

	test('an untitled label is a label rather than a pin, in the word and in the number', () => {
		// The word is `shapeWord`'s and the number `annotationOrdinal`'s, which is what makes "Untitled label 3" one fact rather than two counts.
		list({
			annotations: [
				annotation({ id: 'a-1' }),
				annotation({ id: 'a-2', type: 'LineString' }),
				annotation({ id: 'a-3', symbol: 'label' })
			]
		});

		expect(names()).toEqual(['Untitled pin 1', 'Untitled line 2', 'Untitled label 3']);
		// Beside the name as well as in it, so a screen reader hears the kind on a titled Label too.
		expect(nth('annotation-row', 2)).toHaveTextContent('label');
	});

	test.each([
		// `marker-symbol` is simplestyle's own field and another tool's value for it — `"harbor"`, `"7"` — is a Pin that keeps its symbol, not a Label with a typo.
		['a label carrying an unknown symbol is not a label at all', { symbol: 'harbor' }],
		['an empty title falls back rather than rendering a blank row', { title: '' }]
	])('%s', (_, fields) => {
		list({ annotations: [annotation({ id: 'a-1', ...fields })] });
		expect(one('annotation-row-name')).toHaveTextContent('Untitled pin 1');
	});
});

describe('every Annotation is numbered on its row', () => {
	// **The number is the same fact the map's mark draws**, and it is `annotationOrdinal`'s in both places — see `packages/core/src/annotation/ordinal.ts` for why the rule is one function rather than an `index + 1` written…

	const three = (): Annotation[] => [
		annotation({ id: 'a-1', title: 'The west quay' }),
		annotation({ id: 'a-2', type: 'LineString', title: 'The tow path' }),
		annotation({ id: 'a-3', type: 'Polygon' })
	];

	const ordinals = (): (string | undefined)[] =>
		all('annotation-row-ordinal').map((mark) => mark.textContent?.trim());

	test('the ordinals follow the collection from 1, added inside the row’s own button rather than replacing anything', () => {
		list({ annotations: three() });
		expect(ordinals()).toEqual(['1', '2', '3']);
		expect(names()).toEqual(['The west quay', 'The tow path', 'Untitled shape 3']);
		expect(nth('annotation-row', 1)).toHaveTextContent('line');
		// Nothing about which Annotation is which may depend on seeing a line, so the ordinal is part of the button's accessible name rather than a decoration positioned beside it.
		const button = nth('annotation-row', 2);
		expect(button.querySelector('[data-testid="annotation-row-ordinal"]')).not.toBeNull();
		expect(button.textContent?.replace(/\s+/g, ' ').trim()).toBe('3 shape Untitled shape 3');
	});

	test('deleting an Annotation renumbers the rest, in the rows already on the screen', () => {
		// Nothing was written to renumber them — `packages/core/src/annotation/ordinal.test.ts` asserts the bytes, and the Annotations here are the same objects handed back.
		const before = three();
		list({ annotations: before });
		expect(ordinals()).toEqual(['1', '2', '3']);
		const survivor = nth('annotation-row', 2);
		show([before[0]!, before[2]!]);
		expect(ordinals()).toEqual(['1', '2']);
		expect(names()).toEqual(['The west quay', 'Untitled shape 2']);
		expect(nth('annotation-row', 1)).toBe(survivor);
		expect(survivor.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 shape Untitled shape 2');
	});
});

describe('the row selects and opens nothing', () => {
	// **Openness and selection are one state, so there is one property for them.** The row carries no `aria-pressed`: an Annotation that was pressed but not open, or open but not pressed, were two answers to "which one is…

	test('a row selects, reports which one, and pressing it again deselects, keeping the keyboard', async () => {
		const opened = vi.fn();
		list({ annotations: two(), onopen: opened });

		await press(nth('annotation-row', 0));
		expect(document.activeElement).toBe(nth('annotation-row', 0));
		expect(opened).toHaveBeenLastCalledWith('a-1');
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'true');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'false');
		expect(nth('annotation-row', 0)).not.toHaveAttribute('aria-pressed');

		await press(nth('annotation-row', 0));
		expect(document.activeElement).toBe(nth('annotation-row', 0));
		expect(opened).toHaveBeenLastCalledWith(null);
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'false');
	});

	test('a selected row is its button and nothing else, with no handle when the consumer cannot reorder', async () => {
		list({ annotations: two() });
		expect(one('annotation-drag-handle')).toBeNull();

		await press(nth('annotation-row', 0));

		const row = nth('annotation-row-item', 0).children[0];
		expect([...(row?.children ?? [])]).toEqual([nth('annotation-row', 0)]);
	});

	test('a reordering consumer adds the handle and still opens nothing', async () => {
		list({ annotations: two(), withMoving: true });

		expect(all('annotation-drag-handle')).toHaveLength(2);

		await press(nth('annotation-row', 0));

		const row = nth('annotation-row-item', 0).children[0];
		expect([...(row?.children ?? [])]).toEqual([
			nth('annotation-drag-handle', 0),
			nth('annotation-row', 0)
		]);
	});

	test('selecting a second Annotation deselects the first', async () => {
		list({ annotations: two(), openId: 'a-1' });

		await press(nth('annotation-row', 1));

		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'false');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'true');
	});
});

describe('the selected row is unmistakable', () => {
	test('the wash and the spine are on the whole row, and on the selected row only', () => {
		list({ annotations: two(), openId: 'a-2' });
		const marked = nth('annotation-row-item', 1);
		const plain = nth('annotation-row-item', 0);
		expect(marked).toHaveClass(KIND_STYLE.annotation.tint);
		expect(marked).toHaveClass('shadow-[inset_2px_0_0_var(--color-info-content)]');
		expect(plain).not.toHaveClass(KIND_STYLE.annotation.tint);
		expect(plain).not.toHaveClass('shadow-[inset_2px_0_0_var(--color-info-content)]');
		expect(marked).toContainElement(nth('annotation-row', 1));
		expect(nth('annotation-row', 1)).not.toHaveClass(KIND_STYLE.annotation.tint);
	});

	test('one property carries the selection, the name is semibold, and only the selected row names the Inspector', () => {
		// The reason `AnnotationRow` refuses `aria-pressed`: a row that was pressed but not open, or open but not pressed, would be two answers to "which Annotation is active".
		list({ annotations: two(), openId: 'a-1' });
		expect(nth('annotation-row', 0)).toHaveClass('font-semibold');
		expect(nth('annotation-row', 1)).not.toHaveClass('font-semibold');
		// The region an Annotation is read in is across the screen (ADR-0035), and `aria-controls` does not require containment — so what a screen reader is told survives the move.
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-controls', ANNOTATION_INSPECTOR_ID);
		expect(nth('annotation-row', 1)).not.toHaveAttribute('aria-controls');
		expect(nth('annotation-row', 0)).toHaveAttribute('aria-expanded', 'true');
		expect(nth('annotation-row', 1)).toHaveAttribute('aria-expanded', 'false');
		for (const row of all('annotation-row-item')) {
			expect(row.querySelectorAll('[aria-pressed]')).toHaveLength(0);
		}
	});
});

describe('the list says what is in the Layer', () => {
	test('and says nothing at all about a Layer whose collection has not been read', () => {
		list({ annotations: null });
		expect(one('annotation-list-empty')).not.toBeInTheDocument();
		expect(one('annotation-list')).not.toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(0);
	});

	test('an empty Layer says so as the bare fact, and guidance about it is the consumer’s', () => {
		list({ annotations: [], withGuidance: true });
		expect(one('harness-annotation-guidance')).toBeInTheDocument();
		expect(one('annotation-list-empty')).toHaveTextContent('Nothing in this Layer yet');
		takeDown();
		list({ annotations: [] });
		expect(all('annotation-row')).toHaveLength(0);
		expect(one('harness-annotation-guidance')).not.toBeInTheDocument();
		expect(one('annotation-list-empty')).toHaveTextContent('This Layer has no Annotations in it.');
		expect(one('annotation-list-empty')?.textContent).not.toMatch(/yet/i);
	});

	test('the caption counts what is in the Layer, in the singular and the plural', () => {
		const caption = () =>
			document.querySelector('#annotation-list-caption')?.textContent?.replace(/\s+/g, ' ').trim();

		list({ annotations: [annotation({ id: 'a-1' })] });
		expect(caption()).toBe('1 Annotation');
		takeDown();
		list({ annotations: [annotation({ id: 'a-1' }), annotation({ id: 'a-2' })] });
		expect(caption()).toBe('2 Annotations');
	});
});

describe('a surface the consumer does not ask for is not there', () => {
	test('offers the drawing surface only with tools', () => {
		list({ annotations: two(), withTools: true });
		expect(one('harness-annotation-tools')).toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(2);
		takeDown();
		list({ annotations: two() });
		expect(one('harness-annotation-tools')).not.toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(2);
	});
});
