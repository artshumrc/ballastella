import { type AnnotationGeometry } from '@ballastella/core';
import type { DetachedWindowAPI } from 'happy-dom';
import { type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { all, one, settle, show, takeDown } from '$lib/test-support/dom';

import AnnotationTextFaceHarness from './AnnotationTextFaceHarness.svelte';

const POINT = { type: 'Point', coordinates: [0, 0] } as unknown as AnnotationGeometry;

const LINE = {
	type: 'LineString',
	coordinates: [0, 1].map((n) => [n, n])
} as unknown as AnnotationGeometry;

const device = (): DetachedWindowAPI['settings']['device'] =>
	(window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.settings.device;

afterEach(() => {
	takeDown();
	device().prefersReducedMotion = 'no-preference';
});

const face = (props: ComponentProps<typeof AnnotationTextFaceHarness>): void =>
	show(AnnotationTextFaceHarness, props);

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await settle();
};

const typeInto = async (field: HTMLInputElement | HTMLTextAreaElement, text: string) => {
	for (const character of text) {
		field.value += character;
		field.dispatchEvent(new Event('input', { bubbles: true }));
		await settle();
	}
};

describe('the title and description are text until somebody asks to change them', () => {
	test('Edit text turns them into fields and hands over the keyboard', async () => {
		face({ geometry: POINT, properties: { title: 'Warehouses' } });
		expect(one('annotation-description-text')).toBeInTheDocument();
		expect(all('annotation-title')).toHaveLength(0);

		await press(one('annotation-edit-text')!);

		expect(one('annotation-title')).toHaveValue('Warehouses');
		expect(one('annotation-description')).toBeInTheDocument();
		expect(one('annotation-title')).toHaveFocus();
	});

	test('typing whole sentences does not shut the fields, and Done puts them back to text, committed', async () => {
		const committed = vi.fn();
		face({ geometry: POINT, oncommit: committed });
		await press(one('annotation-edit-text')!);

		const title = one('annotation-title') as HTMLInputElement;
		await typeInto(title, 'Fort Amsterdam');
		expect(one('annotation-title')).toHaveValue('Fort Amsterdam');
		const description = one('annotation-description') as HTMLTextAreaElement;
		await typeInto(description, 'Built in 1625.');
		expect(one('annotation-description')).toHaveValue('Built in 1625.');
		expect(one('annotation-text-done')).toBeInTheDocument();

		await press(one('annotation-text-done')!);

		expect(committed).toHaveBeenCalled();
		expect(all('annotation-title')).toHaveLength(0);
		expect(one('annotation-inspector-name')).toHaveTextContent('Fort Amsterdam');
	});

	test('a different Annotation arriving does close them', async () => {
		face({ geometry: POINT, id: 'a-1' });
		await press(one('annotation-edit-text')!);
		expect(one('annotation-title')).toBeInTheDocument();
		takeDown();
		face({ geometry: POINT, id: 'a-2' });
		expect(all('annotation-title')).toHaveLength(0);
		expect(one('annotation-description-text')).toBeInTheDocument();
	});

	test('a freshly drawn Annotation alone opens titling, once and reported, so reopening cannot seize the keyboard', async () => {
		const titled = vi.fn();
		face({ geometry: POINT, titling: true, ontitled: titled });
		await settle();

		expect(one('annotation-title')).toHaveFocus();
		expect(titled).toHaveBeenCalledTimes(1);
		takeDown();
		const untouched = vi.fn();
		face({ geometry: POINT, ontitled: untouched });
		expect(all('annotation-title')).toHaveLength(0);
		await press(one('annotation-edit-text')!);

		expect(one('annotation-title')).toHaveFocus();
		expect(untouched).not.toHaveBeenCalled();
	});
});

describe('one Annotation, one name', () => {
	test('a titled Annotation is titled exactly once, and its words are the description alone', () => {
		face({ geometry: POINT, properties: { title: 'Fort Amsterdam' } });
		expect(one('annotation-inspector-name')).toHaveTextContent('Fort Amsterdam');
		expect(document.body.textContent?.match(/Fort Amsterdam/g)).toHaveLength(1);
		const words = [...one('annotation-text-face')!.children].slice(0, -1);
		expect(words).toEqual([one('annotation-description-text')]);
	});

	test('and an untitled one carries the shared fallback exactly once', () => {
		face({ geometry: POINT, index: 2 });
		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Untitled pin 3');
		expect(document.body.textContent?.match(/Untitled pin 3/g)).toHaveLength(1);
		expect(document.body.textContent?.match(/Untitled/g)).toHaveLength(1);
	});
});

describe('an Annotation this build cannot draw', () => {
	test('says so where the words are, and keeps them editable', () => {
		face({ geometry: null as unknown as AnnotationGeometry });
		expect(one('annotation-not-drawable')).toBeInTheDocument();
		expect(one('annotation-edit-text')).toBeInTheDocument();
		takeDown();
		face({ geometry: POINT });
		expect(one('annotation-not-drawable')).not.toBeInTheDocument();
	});
});

describe('deleting the Annotation being read', () => {
	test('the delete is here, beside the words, and reports rather than acting', async () => {
		const deleted = vi.fn();
		face({ geometry: POINT, ondelete: deleted });

		await press(one('annotation-delete')!);

		expect(deleted).toHaveBeenCalledTimes(1);
		expect(document.querySelector('dialog')).toBeNull();
	});
});

describe('where the Annotation sits, and which Layer it is in (ADR-0016)', () => {
	test('the two Move buttons ask for the neighbouring position and report nothing else', async () => {
		const moved = vi.fn();
		face({ geometry: POINT, index: 1, count: 3, onmove: moved });

		await press(one('annotation-move-up')!);
		expect(moved).toHaveBeenLastCalledWith(0);

		await press(one('annotation-move-down')!);
		expect(moved).toHaveBeenLastCalledWith(2);
	});

	test('an end of the collection is a disabled button rather than a refusal', () => {
		face({ geometry: POINT, index: 0, count: 2 });
		expect(one('annotation-move-up')).toBeDisabled();
		expect(one('annotation-move-down')).not.toBeDisabled();
		takeDown();
		face({ geometry: POINT, index: 1, count: 2 });
		expect(one('annotation-move-up')).not.toBeDisabled();
		expect(one('annotation-move-down')).toBeDisabled();
	});

	test('the only Annotation is offered no reordering, and one Annotation Layer no picker', () => {
		face({ geometry: POINT, index: 0, count: 1 });
		expect(one('annotation-move-up')).toBeNull();
		expect(one('annotation-move-down')).toBeNull();
		expect(one('annotation-move-to-layer')).toBeNull();
		takeDown();
		face({ geometry: POINT, index: 0, count: 3 });
		expect(one('annotation-move-to-layer')).toBeNull();
		expect(one('annotation-move-up')).toBeInTheDocument();
	});

	test('the Layer picker offers the other Layers, moves on a choice, and goes back to its placeholder', async () => {
		const movedToLayer = vi.fn();
		face({
			geometry: POINT,
			index: 0,
			count: 1,
			moveTargets: [
				{ id: 'l-2', name: 'The routes' },
				{ id: 'l-3', name: '' }
			],
			onmovetolayer: movedToLayer
		});

		const picker = one('annotation-move-to-layer') as HTMLSelectElement;
		expect([...picker.options].map((option) => option.textContent?.trim())).toEqual([
			'Move to Layer…',
			'The routes',
			'Untitled Layer'
		]);

		picker.value = 'l-2';
		picker.dispatchEvent(new Event('change', { bubbles: true }));
		await settle();

		expect(movedToLayer).toHaveBeenCalledWith('l-2');
		expect(picker.value).toBe('');
	});
});

describe('a Label’s text face is one field, and the words in it are what draws', () => {
	const LABEL = { 'marker-symbol': 'label' };
	const field = (): HTMLInputElement => one('annotation-title') as HTMLInputElement;

	test('one field captioned for what it draws, and neither a description control nor an Edit text gate', () => {
		face({ geometry: POINT, properties: { ...LABEL, title: 'Zuiderzee' } });
		expect(field()).toHaveValue('Zuiderzee');
		expect(field().closest('label')?.querySelector('span')).toHaveTextContent('Label text');
		expect(all('annotation-edit-text')).toHaveLength(0);
		expect(all('annotation-text-done')).toHaveLength(0);
		expect(all('annotation-description')).toHaveLength(0);
		expect(all('annotation-description-text')).toHaveLength(0);
		takeDown();
		face({ geometry: POINT, properties: { 'marker-symbol': 'harbor', title: 'Zuiderzee' } });
		expect(one('annotation-edit-text')).toBeInTheDocument();
		expect(one('annotation-description-text')).toBeInTheDocument();
		expect(all('annotation-title')).toHaveLength(0);
	});

	test('and a Line that carries the discriminator is still a Line', () => {
		face({ geometry: LINE, properties: { ...LABEL, description: 'The west quay.' } });
		expect(one('annotation-edit-text')).toBeInTheDocument();
		expect(one('annotation-description-text')).toBeInTheDocument();
		expect(all('annotation-title')).toHaveLength(0);
		expect(all('annotation-label-empty')).toHaveLength(0);
	});

	test('a description a stranger’s file carries is still rendered, below the field and read-only', () => {
		face({
			geometry: POINT,
			properties: { ...LABEL, title: 'Zuiderzee', description: 'Drained in 1932.' }
		});

		expect(one('annotation-description-text')).toBeInTheDocument();
		expect(all('annotation-description')).toHaveLength(0);
		const parts = [...one('annotation-text-face')!.children];
		expect(parts.indexOf(one('annotation-description-text')!)).toBeGreaterThan(
			parts.findIndex((part) => part.contains(field()))
		);
	});

	test('an empty Label says it draws nothing, and says it to a screen reader', async () => {
		face({ geometry: POINT, properties: LABEL });
		const sentence = one('annotation-label-empty');
		expect(sentence).toHaveTextContent('draws nothing');
		expect(sentence?.id).toBeTruthy();
		expect(field()).toHaveAttribute('aria-describedby', sentence!.id);

		await typeInto(field(), 'Ee');

		expect(all('annotation-label-empty')).toHaveLength(0);
		expect(one('annotation-title')).not.toHaveAttribute('aria-describedby');
	});

	test('just placed, it arrives with the keyboard, spends the offer, and reports every character typed', async () => {
		const typed = vi.fn();
		const titled = vi.fn();
		face({ geometry: POINT, properties: LABEL, titling: true, ontitled: titled, ontext: typed });
		await settle();
		expect(field()).toHaveFocus();
		expect(titled).toHaveBeenCalledTimes(1);

		await typeInto(field(), 'Zuiderzee');

		expect(one('annotation-title')).toHaveValue('Zuiderzee');
		expect(one('annotation-title')).toHaveFocus();
		expect(typed).toHaveBeenCalledTimes('Zuiderzee'.length);
		expect(typed).toHaveBeenLastCalledWith({ title: 'Zuiderzee' });
	});

	test('clearing the words, or leaving only whitespace, draws nothing; clearing reports an empty string', async () => {
		const typed = vi.fn();
		face({ geometry: POINT, properties: { ...LABEL, title: 'Ee' }, ontext: typed });
		field().value = '';
		field().dispatchEvent(new Event('input', { bubbles: true }));
		await settle();

		expect(typed).toHaveBeenLastCalledWith({ title: '' });
		expect(one('annotation-label-empty')).toBeInTheDocument();
		takeDown();
		face({ geometry: POINT, properties: { ...LABEL, title: '   ' } });
		expect(one('annotation-label-empty')).toBeInTheDocument();
	});

	test.each([
		['reduce', '0'],
		['no-preference', '220']
	] as const)(
		'a Label is revealed by the Inspector’s own arrival; motion preference %s gives %s ms',
		(preference, ms) => {
			device().prefersReducedMotion = preference;
			face({ geometry: POINT, properties: LABEL });
			expect(one('annotation-inspector')).toHaveAttribute('data-reveal-ms', ms);
		}
	);
});
