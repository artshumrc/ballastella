// What the Annotation Inspector's Text face offers, asserted against the component rather than
// against the application.
//
// **The face is mounted inside a real `AnnotationInspector`**, which is where the application mounts
// it and where the last claim in this file can fail at all: the header names the Annotation and the
// face carries its words, so "the Annotation is titled once" is a fact about the two together and a
// face measured on its own cannot see a second title. `AnnotationTextFaceHarness.svelte` argues that
// at length.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS ASSERTED HERE, AND WHAT DELIBERATELY IS NOT
//
// Whether the words are text or fields, what turns one into the other, and that a whole sentence can
// be typed without them shutting. All of it is the face's own behaviour, handed an Annotation by the
// test.
//
// ⚠ **The description's rendering is not asserted here and must not be.** It is
// `AnnotationDescription`'s, in `packages/ui`, and its inertness is `e2e/viewer-reader.e2e.ts`'s:
// DOMPurify answers "supported" against happy-dom and then returns its input essentially untouched, so
// a sanitiser claim at this seam is green whatever the sanitiser does. What is asserted here is that
// the resting state is that shared component rather than markup of this app's own, and that the words
// name their Annotation no more than once.
//
// ⚠ **What stays in `e2e/` is storage and wiring**: that typing coalesces into one write per file,
// that tabbing through an untouched field writes nothing, and that a delete from here is undoable.
// Nothing about a file can fail at this seam, because there is no file.

import { type AnnotationGeometry } from '@ballastella/core';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationTextFaceHarness from './AnnotationTextFaceHarness.svelte';

const POINT = { type: 'Point', coordinates: [0, 0] } as unknown as AnnotationGeometry;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

const face = (props: ComponentProps<typeof AnnotationTextFaceHarness>): void => {
	mounted = mount(AnnotationTextFaceHarness, { target: document.body, props });
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

const settle = async (): Promise<void> => {
	await tick();
	await tick();
};

const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await settle();
};

/** Type one character into a field the way a keyboard does: append, then fire `input`. */
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

	test('typing a whole sentence does not shut the fields', async () => {
		// ⚠ **The regression this is here for, and the reason the harness rebuilds the Annotation.**
		// The face resets its editing state when *a different Annotation arrives*, and `annotation` is a
		// fresh object after every save — which is after every keystroke. Written as an effect that
		// merely read `annotation.id`, that reset fired on each character, and a scholar could type
		// exactly one letter before the fields turned back into text.
		face({ geometry: POINT });
		await press(one('annotation-edit-text')!);

		const title = one('annotation-title') as HTMLInputElement;
		await typeInto(title, 'Fort Amsterdam');
		// Read fresh off the document rather than through the handle above: had the fields closed and
		// reopened, the old node would still answer with the value it was holding when it left.
		expect(one('annotation-title')).toHaveValue('Fort Amsterdam');

		const description = one('annotation-description') as HTMLTextAreaElement;
		await typeInto(description, 'Built in 1625.');
		expect(one('annotation-description')).toHaveValue('Built in 1625.');
		// Still fields, which is the sentence: a face that had reverted to text would have no
		// `annotation-title` at all and the assertions above would have failed on a stale node.
		expect(one('annotation-text-done')).toBeInTheDocument();
	});

	test('a different Annotation arriving does close them', async () => {
		// The negative control for the test above, and the behaviour the guard exists to keep: without
		// it, selecting one Annotation while editing another's text opens the second straight into a
		// form nobody asked to edit.
		face({ geometry: POINT, id: 'a-1' });
		await press(one('annotation-edit-text')!);
		expect(one('annotation-title')).toBeInTheDocument();

		takeDown();

		// A second face for a second Annotation is what the Inspector does with a new selection — the
		// same component, told about a different id.
		face({ geometry: POINT, id: 'a-2' });
		expect(all('annotation-title')).toHaveLength(0);
		expect(one('annotation-description-text')).toBeInTheDocument();
	});

	test('Done puts them back to text, committing what was typed', async () => {
		const committed = vi.fn();
		face({ geometry: POINT, oncommit: committed });
		await press(one('annotation-edit-text')!);
		await typeInto(one('annotation-title') as HTMLInputElement, 'Warehouses');

		await press(one('annotation-text-done')!);

		expect(committed).toHaveBeenCalled();
		expect(all('annotation-title')).toHaveLength(0);
		// What was typed is on screen as the Inspector's header rather than as a second copy of it here,
		// which is also what says the write reached the harness's rebuilt Annotation.
		expect(one('annotation-inspector-name')).toHaveTextContent('Warehouses');
	});

	test('a freshly drawn Annotation opens with its title as a field, and nothing else does', () => {
		// Titling a shape straight after drawing it is one gesture (the-annotation-inspector story 40),
		// and the face is handed *whether this is the shape that was just drawn* rather than a flag of
		// its own — so selecting an Annotation to read it cannot put the same form in front of a reader.
		// Both halves, because either alone would pass a face that always opened its fields, or never
		// did.
		face({ geometry: POINT, titling: true });

		expect(one('annotation-title')).toBeInTheDocument();

		takeDown();
		face({ geometry: POINT });

		expect(all('annotation-title')).toHaveLength(0);
		expect(one('annotation-edit-text')).toBeInTheDocument();
	});

	test('that offer is taken up once and reported, so reopening the face cannot seize the keyboard again', async () => {
		// ⚠ **The defect this is here for.** The Inspector unmounts this face while the Style face is
		// showing and mounts it again on the way back, which resets `editingText` and re-runs the effect —
		// so a `titling` still true dragged the keyboard into the title field on a press of *Text*, with
		// the same shape selected long after it was drawn. An author who draws a shape, titles it and then
		// looks at the swatches had their keyboard yanked back into a field.
		//
		// Titling a shape straight after drawing it is *one* gesture, so the offer is spent rather than
		// standing: the face says the field has the keyboard, and the consumer stops saying `titling`.
		const titled = vi.fn();
		face({ geometry: POINT, titling: true, ontitled: titled });
		await settle();

		expect(one('annotation-title')).toHaveFocus();
		expect(titled).toHaveBeenCalledTimes(1);

		// **And nothing is reported when a scholar opens the fields themselves**, which is the half that
		// keeps this about the offer rather than about the fields: that press was never an offer, so there
		// is nothing to withdraw, and a face that reported it would have the consumer clearing state on a
		// gesture it knows nothing about.
		takeDown();
		const untouched = vi.fn();
		face({ geometry: POINT, ontitled: untouched });
		await press(one('annotation-edit-text')!);

		expect(one('annotation-title')).toHaveFocus();
		expect(untouched).not.toHaveBeenCalled();
	});
});

describe('one Annotation, one name (the-annotation-inspector stories 3, 4)', () => {
	// ⚠ **These are counted over the whole composed Inspector, and that is the point.** The fault they
	// hold shut is a title drawn by the identity header *and again* by the words a few pixels below it,
	// in the same weight, so that an author cannot tell whether the second one is another field. Either
	// half on its own is innocent; only the two mounted together can be wrong, which is why the harness
	// puts the face where the application puts it.
	//
	// The names themselves are `annotation-name.ts`'s, held against the row's by
	// `packages/ui/src/annotation-list.dom.test.ts`, so nothing here asserts the wording twice over.

	test('a titled Annotation is titled exactly once', () => {
		face({ geometry: POINT, properties: { title: 'Fort Amsterdam' } });

		expect(one('annotation-inspector-name')).toHaveTextContent('Fort Amsterdam');
		expect(document.body.textContent?.match(/Fort Amsterdam/g)).toHaveLength(1);
	});

	test('and an untitled one carries the shared fallback exactly once', () => {
		// The half that catches a face falling back to wording of its own: a bare "Untitled" under a
		// header reading "Untitled pin 3" is two names for one Annotation, and counting the whole word
		// rather than the phrase is what sees it.
		face({ geometry: POINT, index: 2 });

		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Untitled pin 3');
		expect(document.body.textContent?.match(/Untitled pin 3/g)).toHaveLength(1);
		expect(document.body.textContent?.match(/Untitled/g)).toHaveLength(1);
	});

	test('the words are the description alone, with no title of their own', () => {
		// The mechanism behind the two counts above, asserted where a future edit would break it: the
		// face renders `AnnotationDescription` and there is no title element anywhere below the header.
		// Both halves, because an absence on its own goes green when the whole face stops rendering.
		//
		// **Asserted as the face's own children rather than as the absence of a `data-testid`.** A
		// renamed id is exactly how an absence assertion goes quietly green, and there is no title
		// element left to name — so the honest form of "no title of its own" is that everything the
		// resting face holds above its control row is the one description section.
		face({ geometry: POINT, properties: { title: 'Fort Amsterdam' } });

		expect(one('annotation-description-text')).toBeInTheDocument();
		const words = [...one('annotation-text-face')!.children].slice(0, -1);
		expect(words).toEqual([one('annotation-description-text')]);
	});
});

describe('an Annotation this build cannot draw', () => {
	test('says so where the words are, and keeps them editable', () => {
		// A foreign document may carry a `GeometryCollection`. It is offered **no Style face at all** —
		// the consumer withholds the snippet, which is asserted in
		// `packages/ui/src/annotation-inspector.dom.test.ts` — so a tab that opened on an explanation of
		// its own emptiness is not the shape of this. The sentence belongs beside the half of the
		// Annotation that is still the scholar's, and it says that the shape is written back untouched.
		face({ geometry: null as unknown as AnnotationGeometry });

		expect(one('annotation-not-drawable')).toBeInTheDocument();
		expect(one('annotation-edit-text')).toBeInTheDocument();

		takeDown();
		face({ geometry: POINT });

		// The other half, because a sentence asserted only where it appears goes quietly green when it
		// starts appearing everywhere.
		expect(one('annotation-not-drawable')).not.toBeInTheDocument();
	});
});

describe('deleting the Annotation being read (the-annotation-inspector story 31)', () => {
	test('the delete is here, beside the words, and reports rather than acting', async () => {
		// **Reports**: what a delete costs and how it is undone is `AnnotationEditing.deleteSelected`'s,
		// and that it is undoable without a confirmation dialog (ADR-0014) is asserted over real storage
		// in `e2e/editor-undo.e2e.ts`. What is this face's is that the control is here at all — not on
		// the row, and not in the Layer card's footer beside *Delete Layer*, which would put two deletes
		// of different scope in one card.
		const deleted = vi.fn();
		face({ geometry: POINT, ondelete: deleted });

		await press(one('annotation-delete')!);

		expect(deleted).toHaveBeenCalledTimes(1);
		// And no dialog was raised to ask about it, which is the whole of ADR-0014's bargain: the way
		// back is undo rather than a question in front of every deliberate delete.
		expect(document.querySelector('dialog')).toBeNull();
	});
});
