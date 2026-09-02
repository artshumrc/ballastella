// What an Annotation's description renders as, asserted against the component both apps compose.
//
// ⚠ **The inertness of a stranger's Markdown is NOT asserted here and must not be.** DOMPurify
// answers "supported" against happy-dom and then returns its input essentially untouched, so a
// sanitiser claim at this seam is green whatever the sanitiser does — this package's
// `vitest.config.ts` records the measurement. That claim lives in `e2e/viewer-reader.e2e.ts`, in a
// real browser, against the real Reader build.
//
// What is left for this seam is the surface's own shape, which is what the tests below assert.

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
	// A bare `<div>` has the implicit `generic` role, for which ARIA 1.2 prohibits `aria-label` and
	// which browsers drop from the accessibility tree: the attribute was there, and named nothing.
	// A `<section>` with a name is a `region`, so a reader on a screen reader meets a boundary between
	// the Inspector's identity header and a stranger's prose instead of running from one into the other.
	describeIt({ annotation: annotation({ id: 'a-1', title: 'The west quay' }) });

	const description = one('annotation-description-text');
	expect(description?.tagName).toBe('SECTION');
	expect(description).toHaveAttribute('aria-label', 'Description');
});

test('says there is no description rather than rendering an empty region', () => {
	// The fallback both apps rely on: an Annotation with no prose is a normal Annotation, and a face
	// that drew nothing at all would read as a panel that had failed to load.
	describeIt({ annotation: annotation({ id: 'a-1' }) });

	expect(one('annotation-description-text')).toHaveTextContent('No description.');
});
