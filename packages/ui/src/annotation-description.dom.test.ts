import type { Annotation } from '@ballastella/core';
import { flushSync, mount, unmount, type ComponentProps } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import AnnotationDescription from './AnnotationDescription.svelte';

const annotation = (fields: { id: string; title?: string }): Annotation =>
	({
		id: fields.id,
		geometry: { type: 'Point', coordinates: [0, 0] },
		properties: fields.title === undefined ? {} : { title: fields.title }
	}) as Annotation;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const describeIt = (props: ComponentProps<typeof AnnotationDescription>): void => {
	mounted = mount(AnnotationDescription, { target: document.body, props });
	flushSync();
};

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

test('names the description on an element that can carry a name', () => {
	// A bare `<div>` has the implicit `generic` role, for which ARIA 1.2 prohibits `aria-label` and which browsers drop from the accessibility tree: the attribute was there, and named nothing.
	describeIt({ annotation: annotation({ id: 'a-1', title: 'The west quay' }) });
	const description = one('annotation-description-text');
	expect(description?.tagName).toBe('SECTION');
	expect(description).toHaveAttribute('aria-label', 'Description');
});

test('says there is no description rather than rendering an empty region', () => {
	describeIt({ annotation: annotation({ id: 'a-1' }) });
	expect(one('annotation-description-text')).toHaveTextContent('No description.');
});
