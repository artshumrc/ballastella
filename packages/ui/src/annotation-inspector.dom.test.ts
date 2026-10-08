import type { Annotation } from '@ballastella/core';
import type { DetachedWindowAPI } from 'happy-dom';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { annotationName } from './annotation-name.js';
import AnnotationInspectorHarness from './AnnotationInspectorHarness.svelte';

const device = (): DetachedWindowAPI['settings']['device'] =>
	(window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.settings.device;

const annotation = (fields: {
	id: string;
	type?: 'Point' | 'LineString' | 'Polygon';
	title?: string;
}): Annotation =>
	({
		id: fields.id,
		geometry: { type: fields.type ?? 'Point', coordinates: [0, 0] },
		properties: fields.title === undefined ? {} : { title: fields.title }
	}) as Annotation;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	takeDown();
	device().prefersReducedMotion = 'no-preference';
});

const inspect = (props: ComponentProps<typeof AnnotationInspectorHarness>): void => {
	mounted = mount(AnnotationInspectorHarness, { target: document.body, props });
	flushSync();
};

const show = (next: Annotation): void => {
	const harness = mounted as { show?: (next: Annotation) => void } | undefined;
	if (!harness?.show) throw new Error('nothing is mounted that can be handed a new Annotation');
	harness.show(next);
	flushSync();
};

const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

const styleTab = (): HTMLInputElement =>
	one('annotation-inspector-tab-style')!.querySelector('input')!;

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('the Inspector says which Annotation it is about', () => {
	test('the header draws the ordinal, the glyph, the shape word, and the shared untitled name once', () => {
		const untitled = annotation({ id: 'a-3', type: 'Polygon' });
		inspect({ annotation: untitled, index: 2 });
		expect(one('annotation-inspector-header')).toHaveClass('bg-info', 'text-info-content');
		expect(one('annotation-inspector-close')).toHaveClass(
			'bg-transparent',
			'btn-ghost',
			'text-current',
			'hover:bg-current/20',
			'focus-visible:outline-current'
		);
		expect(one('annotation-inspector-ordinal')).toHaveTextContent('3');
		// The glyph is never alone with meaning (ADR-0016): the word is what a screen reader reads, and the icon beside it is decorative rather than the only channel.
		expect(one('annotation-inspector-shape')).toHaveTextContent('shape');
		const glyph = one('annotation-inspector-header')?.querySelector('svg');
		expect(glyph).not.toBeNull();
		expect(glyph).toHaveAttribute('aria-hidden', 'true');
		expect(one('annotation-inspector-name')).toHaveTextContent(annotationName(untitled, 2));
		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Untitled shape 3');
		expect(one('annotation-inspector-header')!.textContent?.match(/Untitled/g)).toHaveLength(1);
	});

	test('a title displaces the fallback rather than joining it, and names the Inspector', () => {
		inspect({ annotation: annotation({ id: 'a-1', title: 'Fort Amsterdam' }), index: 0 });
		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Fort Amsterdam');
		expect(one('annotation-inspector-header')?.textContent).not.toMatch(/Untitled/);
		// The ordinal and the shape word stay: a titled Annotation is still the 1 on the map and still a pin, which is what makes "look at 1" identify one Annotation across a desk.
		expect(one('annotation-inspector-ordinal')).toHaveTextContent('1');
		expect(one('annotation-inspector-shape')).toHaveTextContent('pin');
		const inspector = one('annotation-inspector')!;
		expect(inspector.tagName).toBe('SECTION');
		expect(inspector).toHaveAttribute('aria-label', 'Annotation Inspector: Fort Amsterdam');
	});
});

describe('the tab strip is there if and only if a Style face was passed', () => {
	test('an author gets a strip with two faces, and a Reader gets no strip at all', () => {
		const subject = annotation({ id: 'a-1', title: 'Fort Amsterdam' });
		inspect({ annotation: subject, index: 0, withStyle: true });
		const strip = one('annotation-inspector-tabs')!;
		expect(strip).toBeInTheDocument();
		expect(strip).toHaveAttribute('role', 'tablist');
		expect(strip.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(one('annotation-inspector-tab-text')).toBeInTheDocument();
		expect(one('annotation-inspector-tab-style')).toBeInTheDocument();
		// A lone `role="tabpanel"` names a relationship that does not exist: nothing switches between anything, and a screen reader would announce a tab panel with no tabs.
		expect(one('annotation-inspector-face')).toHaveAttribute('role', 'tabpanel');
		takeDown();
		inspect({ annotation: subject, index: 0 });
		expect(one('annotation-inspector-face')).not.toHaveAttribute('role');
		expect(one('annotation-inspector-face')).not.toHaveAttribute('aria-labelledby');
		expect(one('annotation-inspector-tabs')).not.toBeInTheDocument();
		expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0);
		expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
		expect(one('annotation-inspector-tab-text')).not.toBeInTheDocument();
		expect(one('annotation-inspector-tab-style')).not.toBeInTheDocument();
		expect(one('harness-inspector-text')).toBeInTheDocument();
	});

	test('the Style face is rendered only when its snippet was passed', async () => {
		const subject = annotation({ id: 'a-1', title: 'Fort Amsterdam' });
		inspect({ annotation: subject, index: 0, withStyle: true });
		await press(styleTab());
		expect(one('harness-inspector-style')).toBeInTheDocument();
		expect(one('harness-inspector-text')).not.toBeInTheDocument();
		takeDown();
		inspect({ annotation: subject, index: 0 });
		expect(one('harness-inspector-style')).not.toBeInTheDocument();
	});

	test('the tab strip is a radio group, so which face is showing is one fact', async () => {
		// `role="tab"` overrides the checkbox state a radio would otherwise carry, so `aria-selected` is what says which one is chosen — and both read one `$state`, which is what stops them disagreeing.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		const text = one('annotation-inspector-tab-text')!.querySelector('input')!;
		const style = one('annotation-inspector-tab-style')!.querySelector('input')!;
		expect(text.type).toBe('radio');
		expect(text.name).toBe('annotation-inspector-face');
		expect(style.name).toBe('annotation-inspector-face');
		expect(document.querySelectorAll('input[name="annotation-inspector-face"]')).toHaveLength(2);
		expect(text).toHaveAttribute('aria-controls', 'annotation-inspector-face');
		expect(style).toHaveAttribute('aria-controls', 'annotation-inspector-face');
		expect(one('annotation-inspector-face')).toHaveAttribute('id', 'annotation-inspector-face');

		// **`checked` beside `aria-selected`, because `checked` is the half with consequences**: daisyUI draws the chosen tab from `label:has(:checked)` and the platform puts the group's single tab stop on the checked radio, so…
		expect(text.checked).toBe(true);
		expect(style.checked).toBe(false);
		expect(text).toHaveAttribute('aria-selected', 'true');
		expect(style).toHaveAttribute('aria-selected', 'false');

		await press(style);
		show(annotation({ id: 'a-2' }));
		expect(text.checked).toBe(true);
		expect(style.checked).toBe(false);
		expect(text).toHaveAttribute('aria-selected', 'true');
		expect(style).toHaveAttribute('aria-selected', 'false');
	});

	test('the showing face is named by the words on its tab, and the name follows the face', async () => {
		// The words "Text" and "Style" are the `<label>`'s, so the label is what `aria-labelledby` names.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		for (const [face, words] of [
			['text', 'Text'],
			['style', 'Style']
		]) {
			if (face === 'style') await press(styleTab());
			const tab = `annotation-inspector-tab-${face}`;
			expect(one('annotation-inspector-face')).toHaveAttribute('aria-labelledby', tab);
			expect(document.getElementById(tab)).toBe(one(tab));
			expect(document.getElementById(tab)?.textContent?.trim()).toBe(words);
		}
	});
});

describe('the strip has no memory', () => {
	test('Text shows on first render, and again when a different Annotation arrives while Style was showing', async () => {
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'text');
		expect(one('harness-inspector-text')).toBeInTheDocument();
		expect(one('harness-inspector-style')).not.toBeInTheDocument();
		await press(styleTab());
		expect(one('harness-inspector-style')).toBeInTheDocument();
		show(annotation({ id: 'a-2', type: 'Polygon' }));
		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'text');
		expect(one('harness-inspector-text')).toHaveAttribute('data-annotation-id', 'a-2');
		expect(one('harness-inspector-style')).not.toBeInTheDocument();
	});

	test('a fresh object carrying the same id does not reset the face', async () => {
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		await press(styleTab());
		expect(one('harness-inspector-style')).toBeInTheDocument();
		show(annotation({ id: 'a-1', title: 'Fort Amsterda' }));
		show(annotation({ id: 'a-1', title: 'Fort Amsterdam' }));
		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'style');
		expect(one('harness-inspector-style')).toBeInTheDocument();
		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Fort Amsterdam');
	});
});

describe('dismissing reports rather than clears', () => {
	test('the dismiss control calls onclose and the Inspector changes nothing of its own', async () => {
		const closed = vi.fn();
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true, onclose: closed });
		await press(styleTab());
		expect(one('annotation-inspector-close')).toHaveTextContent('Dismiss the Annotation Inspector');

		await press(one('annotation-inspector-close')!);

		expect(closed).toHaveBeenCalledTimes(1);
		expect(one('annotation-inspector')).toBeInTheDocument();
		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'style');
	});
});

describe('less motion is respected here as everywhere else', () => {
	test.each([
		['reduce', '0'],
		['no-preference', '220']
	] as const)('when the reader prefers %s motion, the reveal takes %s ms', (preference, ms) => {
		device().prefersReducedMotion = preference;
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0 });
		expect(one('annotation-inspector')).toHaveAttribute('data-reveal-ms', ms);
	});
});
