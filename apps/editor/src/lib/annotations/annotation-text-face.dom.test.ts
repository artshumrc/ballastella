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
import type { DetachedWindowAPI } from 'happy-dom';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import AnnotationTextFaceHarness from './AnnotationTextFaceHarness.svelte';

const POINT = { type: 'Point', coordinates: [0, 0] } as unknown as AnnotationGeometry;

const LINE = {
	type: 'LineString',
	coordinates: [
		[0, 0],
		[1, 1]
	]
} as unknown as AnnotationGeometry;

/**
 * What this DOM reports about the person using it — here, whether they have asked for less motion.
 *
 * happy-dom answers `prefers-reduced-motion` from these settings, so the component's own media query
 * is reading a real `matchMedia` rather than a stub. The settings belong to the window, which is why
 * {@link afterEach} puts them back.
 */
const device = (): DetachedWindowAPI['settings']['device'] =>
	(window as unknown as { happyDOM: DetachedWindowAPI }).happyDOM.settings.device;

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	device().prefersReducedMotion = 'no-preference';
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
		// Titling a shape straight after drawing it is one gesture, and the face is handed *whether this
		// is the shape that was just drawn* rather than a flag of its own — so selecting an Annotation to
		// read it cannot put the same form in front of a reader. Both halves, because either alone would
		// pass a face that always opened its fields, or never did.
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

describe('one Annotation, one name', () => {
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

describe('deleting the Annotation being read', () => {
	test('the delete is here, beside the words, and reports rather than acting', async () => {
		// **Reports**: what a delete costs and how it is undone is `AnnotationEditing.deleteSelected`'s,
		// and that it is undoable without a confirmation dialog (ADR-0039) is asserted over real storage
		// in `e2e/editor-undo.e2e.ts`. What is this face's is that the control is here at all — not on
		// the row, and not in the Layer card's footer beside *Delete Layer*, which would put two deletes
		// of different scope in one card.
		const deleted = vi.fn();
		face({ geometry: POINT, ondelete: deleted });

		await press(one('annotation-delete')!);

		expect(deleted).toHaveBeenCalledTimes(1);
		// And no dialog was raised to ask about it, which is the whole of the bargain the Edit History
		// keeps (ADR-0039): the way back is undo rather than a question in front of every deliberate
		// delete.
		expect(document.querySelector('dialog')).toBeNull();
	});
});

describe('where the Annotation sits, and which Layer it is in (ADR-0016)', () => {
	// ⚠ **These controls are the *contract*, and the drag handle on the row is the convenience.**
	// ADR-0016 will not have a drag be the only way to change something whose order is load-bearing
	// (ADR-0002), and the row could not carry the buttons: it holds one button and nothing opens in it,
	// so a control strip unfolding under the selected row is exactly the growth that claim exists to
	// prevent. That they are *here* is what this asserts; what a move does to the two files is
	// `annotation-editing.svelte.test.ts`'s.

	test('the two Move buttons ask for the neighbouring position and report nothing else', async () => {
		const moved = vi.fn();
		face({ geometry: POINT, index: 1, count: 3, onmove: moved });

		await press(one('annotation-move-up')!);
		expect(moved).toHaveBeenLastCalledWith(0);

		await press(one('annotation-move-down')!);
		expect(moved).toHaveBeenLastCalledWith(2);
	});

	test('an end of the collection is a disabled button rather than a refusal', () => {
		// "The first Annotation cannot go higher" is information a screen reader gets for free from the
		// markup, which is why it is `disabled` rather than a press that quietly does nothing.
		face({ geometry: POINT, index: 0, count: 2 });
		expect(one('annotation-move-up')).toBeDisabled();
		expect(one('annotation-move-down')).not.toBeDisabled();

		takeDown();
		face({ geometry: POINT, index: 1, count: 2 });
		expect(one('annotation-move-up')).not.toBeDisabled();
		expect(one('annotation-move-down')).toBeDisabled();
	});

	test('the only Annotation in a Layer is offered no reordering at all', () => {
		// Two disabled buttons is a row that can do nothing, and a Project with one Layer holding one
		// Annotation is where it would sit for ever.
		face({ geometry: POINT, index: 0, count: 1 });

		expect(one('annotation-move-up')).toBeNull();
		expect(one('annotation-move-down')).toBeNull();
		expect(one('annotation-move-to-layer')).toBeNull();
	});

	test('the Layer picker offers the other Layers, moves on a choice, and goes back to its placeholder', async () => {
		// **The placeholder is the resting state.** The Layer this Annotation is in is not among the
		// choices, so a picker showing one of the *others* as selected would be claiming the move has
		// already happened — and by the time it has, this panel is describing an Annotation in a
		// different Layer.
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

	test('a Project with one Annotation Layer offers no picker', () => {
		face({ geometry: POINT, index: 0, count: 3 });

		expect(one('annotation-move-to-layer')).toBeNull();
		expect(one('annotation-move-up')).toBeInTheDocument();
	});
});

describe('a Label’s text face is one field, and the words in it are what draws', () => {
	// ⚠ **The Label is spelled as a properties bag, not as a flag on the harness.** `marker-symbol` is
	// the discriminator a file carries and `isLabel` is the one reading of it, so a face driven by
	// anything else here would go green against a component that had stopped asking the Annotation what
	// it is.
	//
	// **The absences have their Pin control in the same test.** "No description control" and "no *Edit
	// text*" are absences, and an absence asserted alone goes quietly green the day the face stops
	// rendering at all — or the day it starts withholding those controls from every kind.

	const LABEL = { 'marker-symbol': 'label' };

	const field = (): HTMLInputElement => one('annotation-title') as HTMLInputElement;

	test('one field captioned for what it draws, and neither a description control nor an Edit text gate', () => {
		face({ geometry: POINT, properties: { ...LABEL, title: 'Zuiderzee' } });

		// A field on arrival, with the words in it — nothing to press to get there, which is what makes
		// placing a Label and typing one gesture rather than three.
		expect(field()).toHaveValue('Zuiderzee');
		// Captioned as the Label's text rather than as a title, so that what is being typed and what
		// appears on the map are plainly the same thing.
		expect(field().closest('label')?.querySelector('span')).toHaveTextContent('Label text');
		expect(all('annotation-edit-text')).toHaveLength(0);
		expect(all('annotation-text-done')).toHaveLength(0);
		// Neither the textarea nor the rendered prose: a Label with no description has nothing below its
		// field at all, and `AnnotationDescription` answers "No description." when asked — which here
		// would be an answer to a question this face does not offer.
		expect(all('annotation-description')).toHaveLength(0);
		expect(all('annotation-description-text')).toHaveLength(0);

		// ── AND THE PIN CONTROL, WHICH IS WHAT MAKES THE FOUR ABSENCES ABOVE MEAN ANYTHING ──
		//
		// **Carrying a `marker-symbol` of its own**, because simplestyle's field is *what this marker
		// shows at its point* and `'label'` is one reading of it rather than a flag: a face that branched
		// on the key being present would be green against a bare `{ title }` and would turn every
		// symbolled Pin in a stranger's file into a Label.
		takeDown();
		face({ geometry: POINT, properties: { 'marker-symbol': 'harbor', title: 'Zuiderzee' } });

		expect(one('annotation-edit-text')).toBeInTheDocument();
		expect(one('annotation-description-text')).toBeInTheDocument();
		expect(all('annotation-title')).toHaveLength(0);
	});

	test('and a Line that carries the discriminator is still a Line', () => {
		// ⚠ **The reading the whole face turns on.** `isLabel` requires a Point *and* the symbol, because
		// `marker-symbol` on a LineString means nothing in simplestyle and a stranger's file may carry
		// one anyway. A face that asked only about the properties — `isLabelFeature`, which exists for the
		// renderer, which holds no Annotation — would hand this route the one-field surface and take away
		// both its description and its *Edit text* gate. Every other case in this file is a Point, so this
		// is the only place that can fail.
		face({ geometry: LINE, properties: { ...LABEL, description: 'The west quay.' } });

		expect(one('annotation-edit-text')).toBeInTheDocument();
		expect(one('annotation-description-text')).toBeInTheDocument();
		expect(all('annotation-title')).toHaveLength(0);
		expect(all('annotation-label-empty')).toHaveLength(0);
	});

	test('a description a stranger’s file carries is still rendered, below the field and read-only', () => {
		// Nothing in a file is hidden because this app offers no control for it. Writing it back untouched
		// is `setText`'s and `geojson.ts`'s; what is this face's is that it is on screen.
		face({
			geometry: POINT,
			properties: { ...LABEL, title: 'Zuiderzee', description: 'Drained in 1932.' }
		});

		expect(one('annotation-description-text')).toBeInTheDocument();
		// Read-only: the shared rendering, and no textarea offering to change it.
		expect(all('annotation-description')).toHaveLength(0);
		// Below the field rather than above it, so the thing that draws is what a reader meets first.
		const parts = [...one('annotation-text-face')!.children];
		expect(parts.indexOf(one('annotation-description-text')!)).toBeGreaterThan(
			parts.findIndex((part) => part.contains(field()))
		);
	});

	test('an empty Label says it draws nothing, and says it to a screen reader', async () => {
		// An Annotation placed and not finished is invisible on the map and indistinguishable from one
		// that was never placed, so the face says so in ordinary text — not a tooltip and not a toast
		// (CONTRIBUTING).
		face({ geometry: POINT, properties: LABEL });

		const sentence = one('annotation-label-empty');
		expect(sentence).toHaveTextContent('draws nothing');
		// Associated with the field, which is the whole of "reaches assistive technology": a paragraph
		// merely near the input is read as unrelated prose, or not at all.
		expect(sentence?.id).toBeTruthy();
		expect(field()).toHaveAttribute('aria-describedby', sentence!.id);

		// ── AND IT GOES THE MOMENT THERE ARE WORDS ──────────────────────────────────────────
		await typeInto(field(), 'Ee');

		expect(all('annotation-label-empty')).toHaveLength(0);
		expect(one('annotation-title')).not.toHaveAttribute('aria-describedby');
	});

	test('and a Label of nothing but whitespace still says it', () => {
		// ⚠ **The half `!== ''` misses.** MapLibre's shaping trims each line before it measures anything,
		// so a title of one space draws no words and no chip either — `stack-layers.ts`'s
		// `TITLE_WITHOUT_WHITESPACE` is the renderer saying exactly that. A face that called a space
		// "words" would withdraw this sentence at the moment it became true.
		face({ geometry: POINT, properties: { ...LABEL, title: '   ' } });

		expect(one('annotation-label-empty')).toBeInTheDocument();
	});

	test('typing a whole sentence reports every character and never resets the field', async () => {
		// The `shown` guard, from the Label's side. `annotation` is a fresh object after every save,
		// which is after every keystroke — and this field is the whole of the face, so a guard that
		// compared objects rather than ids would take the keyboard out of it mid-word.
		const typed = vi.fn();
		face({ geometry: POINT, properties: LABEL, ontext: typed });
		field().focus();

		await typeInto(field(), 'Zuiderzee');

		// Read fresh off the document: had the face re-rendered the field, the handle above would still
		// answer with the value the departed node was holding.
		expect(one('annotation-title')).toHaveValue('Zuiderzee');
		expect(one('annotation-title')).toHaveFocus();
		expect(typed).toHaveBeenCalledTimes('Zuiderzee'.length);
		expect(typed).toHaveBeenLastCalledWith({ title: 'Zuiderzee' });
	});

	test('a Label just placed arrives with the keyboard in the field, and the offer is spent', async () => {
		// Placing a Label is placing a Pin — one click, and the Inspector opens with the keyboard where
		// the words go. The offer is taken up once and then withdrawn, because this face is
		// unmounted and mounted again whenever the Style face shows, and a `titling` still standing
		// would drag the keyboard back out of whatever an author had moved on to.
		const titled = vi.fn();
		face({ geometry: POINT, properties: LABEL, titling: true, ontitled: titled });
		await settle();

		expect(field()).toHaveFocus();
		expect(titled).toHaveBeenCalledTimes(1);
	});

	test('clearing the words reports an empty string, which is what removes the property', async () => {
		// The report is this face's whole part in the chain: `setText` removes a property it is handed
		// `''` for, and that a cleared Label leaves no `"title": ""` in the file is asserted over the
		// bytes in `packages/core/src/annotation/annotation.test.ts`. What would break the chain here is
		// a face that reported nothing on a clear, or reported `undefined` — which `setText` reads as
		// "leave it alone".
		const typed = vi.fn();
		face({ geometry: POINT, properties: { ...LABEL, title: 'Ee' }, ontext: typed });

		field().value = '';
		field().dispatchEvent(new Event('input', { bubbles: true }));
		await settle();

		expect(typed).toHaveBeenLastCalledWith({ title: '' });
		// And the face answers the emptying at once rather than on the next selection.
		expect(one('annotation-label-empty')).toBeInTheDocument();
	});

	test('a Label is revealed by the arrival the Inspector already has, at zero when less motion is asked for', () => {
		// ⚠ **This is the Inspector's own number, read with a Label selected — and that is all it is.**
		// `data-reveal-ms` is `prefersReducedMotion.current ? 0 : 220` and depends on nothing about the
		// Annotation, so these two cannot catch a `transition:` added to the Label branch; the reveal
		// itself is `packages/ui/src/annotation-inspector.dom.test.ts`'s and is not re-proved here. What
		// they do say is the thing worth saying: a Label gets that reveal rather than one of its own, so
		// the setting means one thing everywhere. There is no paint and no Web Animations clock at this
		// seam either — see `vitest-setup/web-animations.ts`.
		device().prefersReducedMotion = 'reduce';
		face({ geometry: POINT, properties: LABEL });

		expect(one('annotation-inspector')).toHaveAttribute('data-reveal-ms', '0');
	});

	test('and at the application’s own 220 ms when it has not been', () => {
		// The other half, without which a reveal hard-coded to zero would satisfy the test above for ever.
		face({ geometry: POINT, properties: LABEL });

		expect(one('annotation-inspector')).toHaveAttribute('data-reveal-ms', '220');
	});
});
