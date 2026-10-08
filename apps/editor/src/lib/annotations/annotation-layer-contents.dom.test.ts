import { type Annotation, type AnnotationCollection } from '@ballastella/core';
import { type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { all, one, press, show, takeDown } from '$lib/test-support/dom';

import AnnotationLayerContentsHarness from './AnnotationLayerContentsHarness.svelte';

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

const collectionOf = (...annotations: Annotation[]): AnnotationCollection => ({ annotations });
afterEach(takeDown);

const contents = (props: ComponentProps<typeof AnnotationLayerContentsHarness>): void =>
	show(AnnotationLayerContentsHarness, props);

describe('“New Annotation” clears the way for the one about to be drawn', () => {
	test('closes the Annotation that was open and leaves the list where it is', () => {
		const chose = vi.fn();
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })),
			selectedId: 'a-1',
			onselect: chose
		});
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		press('annotation-new');
		expect(chose).toHaveBeenCalledWith(null);
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'false');
		expect(one('annotation-tools')).toBeInTheDocument();
		expect(one('annotation-list')).toBeInTheDocument();
		expect(one('annotation-row')).toHaveTextContent('The west quay');
		expect(document.getElementById('annotation-list-caption')).toHaveTextContent('1 Annotation');
	});

	test('Cancel puts the shapes away, and the list was never the thing hidden', () => {
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })) });
		press('annotation-new');
		expect(one('annotation-list')).toBeInTheDocument();
		press('annotation-cancel');
		expect(one('annotation-new')).toBeInTheDocument();
		expect(all('annotation-tools')).toHaveLength(0);
		expect(one('annotation-list')).toBeInTheDocument();
	});

	test('an armed shape leaves the list alone too', () => {
		contents({ collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })) });
		press('annotation-new');
		press('annotation-tool-point');
		expect(one('annotation-tool-point')).toHaveAttribute('aria-pressed', 'true');
		expect(one('annotation-list')).toBeInTheDocument();
	});
});

describe('the Annotation just drawn is in the list, because that is where it is', () => {
	test('with a tool armed and an Annotation selected, its row is the selected one in the list', () => {
		contents({
			collection: collectionOf(
				annotation({ id: 'a-1', title: 'The west quay' }),
				annotation({ id: 'a-2', title: 'The east quay' })
			),
			selectedId: 'a-2',
			tool: 'point'
		});

		expect(one('annotation-tools')).toBeInTheDocument();
		expect(one('annotation-list')).toBeInTheDocument();
		expect(all('annotation-row')).toHaveLength(2);
		expect(all('annotation-row')[1]).toHaveAttribute('aria-expanded', 'true');
		expect(all('annotation-row')[0]).toHaveAttribute('aria-expanded', 'false');
	});

	test('with a tool armed and nothing selected, no row is selected', () => {
		contents({
			collection: collectionOf(annotation({ id: 'a-1', title: 'The west quay' })),
			tool: 'point'
		});

		expect(one('annotation-tools')).toBeInTheDocument();
		expect(one('annotation-row')).toHaveAttribute('aria-expanded', 'false');
	});
});

describe('a Layer with nothing in it yet', () => {
	test('tells a scholar how to fill it, in this app’s own words', () => {
		contents({ collection: collectionOf() });

		expect(one('annotation-list-empty')).toHaveTextContent(
			'Nothing in this Layer yet. Press New Annotation and draw one on the map.'
		);
	});
});
