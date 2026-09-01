// What the Annotation Inspector renders, and what it renders nothing of.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE PARITY CLAIM LIVES HERE AND NOT IN A BROWSER
//
// "The viewer offers none of this" is the parity claim this file exists for, and it is provable in
// milliseconds precisely because the Inspector lives in the shared package: the Reader's panel *is*
// this component with a snippet withheld. `apps/viewer` has no unit tests at all, so a claim not made
// here could only be made against a built browser — a browser test for what a `<div>` does not
// contain.
//
// **Both halves of every absence, on purpose.** An absence asserted on its own is the vacuous green
// this repository's testing decisions exist to prevent: rename one `data-testid` and every
// `not.toBeInTheDocument()` below goes on passing while the control it names sits on the screen. So
// each absence is asserted beside the presence that gives it meaning.
//
// ⚠ **The inertness of a stranger's `description` is NOT asserted here and must not be.** DOMPurify
// answers "supported" against happy-dom and then returns its input essentially untouched, so a
// sanitiser claim at this seam is green whatever the sanitiser does — this package's
// `vitest.config.ts` records the measurement. That claim lives in `e2e/viewer-reader.e2e.ts`, in a
// real browser, against a real published build. What the Inspector does with the description is in
// any case nothing: the Text face is the consumer's snippet, and `AnnotationDescription` is asserted
// in `annotation-list.dom.test.ts`.
//
// ⚠ **Nor can this file see the Annotation named twice.** The header is here and the words are a
// snippet, and the snippet below is a marker — so a consumer whose face drew a title of its own would
// pass everything in this file. That count is taken over the composition, in
// `apps/editor/src/lib/annotations/annotation-text-face.dom.test.ts`, where the real face is mounted
// inside this component.
//
// ⚠ **No layout claim belongs here either.** This seam has no viewport, no paint and no geometry, so
// "the map is visible below the panel", "the panel does not grow over the attribution", "a long
// description scrolls inside it" and "the leader is drawn under it" are Seam 2's or nothing. Nor
// does this file assert where the Inspector sits: the component does not position itself.

import type { Annotation } from '@ballastella/core';
import type { DetachedWindowAPI } from 'happy-dom';
import { flushSync, mount, tick, unmount, type ComponentProps } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { annotationName } from './annotation-name.js';
import AnnotationInspectorHarness from './AnnotationInspectorHarness.svelte';

/**
 * What this DOM reports about the person using it — here, whether they have asked for less motion.
 *
 * happy-dom answers `prefers-reduced-motion` from these settings, so `prefersReducedMotion` out of
 * `svelte/motion` is reading a real media query against a real `matchMedia` rather than a stub of
 * Svelte's own signal. The settings are the window's, so {@link afterEach} puts them back.
 */
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
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	device().prefersReducedMotion = 'no-preference';
});

/** Mount the harness, remember it for {@link afterEach}, and let its effects run. */
const inspect = (props: ComponentProps<typeof AnnotationInspectorHarness>): void => {
	mounted = mount(AnnotationInspectorHarness, { target: document.body, props });
	flushSync();
};

/**
 * Hand the Inspector already on the screen a different Annotation, the way a consumer does.
 *
 * A prop update rather than a second mount, which for the face-reset rule is the only shape the claim
 * has: a component that chose its face once, at mount, is right in a freshly mounted panel and wrong
 * in the one the scholar is looking at.
 */
const show = (next: Annotation): void => {
	const harness = mounted as { show?: (next: Annotation) => void } | undefined;
	if (!harness?.show) throw new Error('nothing is mounted that can be handed a new Annotation');
	harness.show(next);
	flushSync();
};

/** Take the mounted panel down mid-test, so a second prop set can be mounted into a clean document. */
const takeDown = (): void => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
};

const one = (testId: string): HTMLElement | null =>
	document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** Press a control and let Svelte finish. */
const press = async (element: HTMLElement): Promise<void> => {
	element.focus();
	element.click();
	await tick();
	await tick();
};

describe('the Inspector says which Annotation it is about', () => {
	test('the header draws the ordinal, the glyph and the shape word', () => {
		inspect({ annotation: annotation({ id: 'a-3', type: 'Polygon' }), index: 2 });

		expect(one('annotation-inspector-header')).toHaveClass('bg-info', 'text-info-content');
		expect(one('annotation-inspector-ordinal')).toHaveTextContent('3');
		// The glyph is never alone with meaning (ADR-0016): the word is what a screen reader reads, and
		// the icon beside it is decorative rather than the only channel.
		expect(one('annotation-inspector-shape')).toHaveTextContent('shape');
		// **That the glyph is hidden is the claim, not that it is there.** An `svg` announced beside the
		// word would make the word a repetition rather than the sole channel, so the word carrying the
		// meaning and the glyph carrying none are one assertion in two halves.
		const glyph = one('annotation-inspector-header')?.querySelector('svg');
		expect(glyph).not.toBeNull();
		expect(glyph).toHaveAttribute('aria-hidden', 'true');
	});

	test('an untitled Annotation reads exactly what the shared name rule returns', () => {
		// **The rule's own answer rather than a literal written twice**, which is the whole of this
		// claim: the fault it fixes was two pieces of wording a few pixels apart, so what is asserted is
		// that the header has no wording of its own. `annotation-list.dom.test.ts` holds the same rule's
		// answer against the row, so the two surfaces cannot drift.
		const untitled = annotation({ id: 'a-3', type: 'Polygon' });
		inspect({ annotation: untitled, index: 2 });

		expect(one('annotation-inspector-name')).toHaveTextContent(annotationName(untitled, 2));
		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Untitled shape 3');
	});

	test('there is no second “Untitled” anywhere in the header', () => {
		// The fault this header exists to avoid, asserted as a count rather than as a lookup: the row said
		// "Untitled shape 3" and the box six pixels below it said "Untitled", and a test that found the
		// right string would have passed while the wrong one sat beside it.
		inspect({ annotation: annotation({ id: 'a-3', type: 'Polygon' }), index: 2 });

		const header = one('annotation-inspector-header')!;
		expect(header.textContent?.match(/Untitled/g)).toHaveLength(1);
	});

	test('a title displaces the fallback rather than joining it', () => {
		inspect({ annotation: annotation({ id: 'a-1', title: 'Fort Amsterdam' }), index: 0 });

		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Fort Amsterdam');
		expect(one('annotation-inspector-header')?.textContent).not.toMatch(/Untitled/);
		// The ordinal and the shape word stay: a titled Annotation is still the 1 on the map and still a
		// pin, which is what makes "look at 1" identify one Annotation across a desk.
		expect(one('annotation-inspector-ordinal')).toHaveTextContent('1');
		expect(one('annotation-inspector-shape')).toHaveTextContent('pin');
	});

	test('the Inspector is named for assistive technology by its Annotation', () => {
		// Arriving in the region has to say what it is *about*, which is the one thing a fixed name
		// could not do. The word is the glossary's — `CONTEXT.md` bans "panel", "popup" and "drawer" —
		// and the name is the shared rule's, so it is the same name the row carries.
		inspect({ annotation: annotation({ id: 'a-1', title: 'Fort Amsterdam' }), index: 0 });

		const inspector = one('annotation-inspector')!;
		expect(inspector.tagName).toBe('SECTION');
		expect(inspector).toHaveAttribute('aria-label', 'Annotation Inspector: Fort Amsterdam');
	});
});

describe('the tab strip is there if and only if a Style face was passed', () => {
	// ⚠ **This is the parity claim, and it is why this file exists.** A Reader has no tab strip because
	// the viewer passes no `style` snippet — not because a case was written for a Reader. So both halves
	// are mounted from the same component with the same Annotation, and the only difference between them
	// is the prop set.
	//
	// **There is no `readOnly` prop to test, and that is the subject rather than an omission.** A
	// consumer's interface *is* the set of props it passes.

	test('an author gets a strip with two faces, and a Reader gets no strip at all', () => {
		const subject = annotation({ id: 'a-1', title: 'Fort Amsterdam' });

		inspect({ annotation: subject, index: 0, withStyle: true });
		const strip = one('annotation-inspector-tabs')!;
		expect(strip).toBeInTheDocument();
		expect(strip).toHaveAttribute('role', 'tablist');
		expect(strip.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(one('annotation-inspector-tab-text')).toBeInTheDocument();
		expect(one('annotation-inspector-tab-style')).toBeInTheDocument();

		takeDown();
		inspect({ annotation: subject, index: 0 });

		// **Absence, not a hidden or a disabled control.** A lone Text tab is a control that switches
		// between one thing, and a disabled Style tab offers a Reader something and then refuses it.
		expect(one('annotation-inspector-tabs')).not.toBeInTheDocument();
		expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(0);
		expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
		expect(one('annotation-inspector-tab-text')).not.toBeInTheDocument();
		expect(one('annotation-inspector-tab-style')).not.toBeInTheDocument();
		// And the content is there either way: withholding the Style face must not withhold the words.
		expect(one('harness-inspector-text')).toBeInTheDocument();
	});

	test('the Style face is rendered only when its snippet was passed', async () => {
		const subject = annotation({ id: 'a-1', title: 'Fort Amsterdam' });

		inspect({ annotation: subject, index: 0, withStyle: true });
		await press(one('annotation-inspector-tab-style')!.querySelector('input')!);
		expect(one('harness-inspector-style')).toBeInTheDocument();
		expect(one('harness-inspector-text')).not.toBeInTheDocument();

		takeDown();
		inspect({ annotation: subject, index: 0 });

		expect(one('harness-inspector-style')).not.toBeInTheDocument();
	});

	test('the face container claims a tabpanel only where there is a strip', () => {
		// A lone `role="tabpanel"` names a relationship that does not exist: nothing switches between
		// anything, and a screen reader would announce a tab panel with no tabs.
		const subject = annotation({ id: 'a-1', title: 'Fort Amsterdam' });

		inspect({ annotation: subject, index: 0, withStyle: true });
		expect(one('annotation-inspector-face')).toHaveAttribute('role', 'tabpanel');

		takeDown();
		inspect({ annotation: subject, index: 0 });

		expect(one('annotation-inspector-face')).not.toHaveAttribute('role');
		expect(one('annotation-inspector-face')).not.toHaveAttribute('aria-labelledby');
	});

	test('the tab strip is a radio group, so which face is showing is one fact', async () => {
		// ADR-0016's mandated method for tabs: radio inputs with `role="tablist"` added, which is what
		// gives arrow-key navigation with nothing written. `role="tab"` overrides the checkbox state a
		// radio would otherwise carry, so `aria-selected` is what says which one is chosen — and both
		// read one `$state`, which is what stops them disagreeing.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });

		const text = one('annotation-inspector-tab-text')!.querySelector('input')!;
		const style = one('annotation-inspector-tab-style')!.querySelector('input')!;
		expect(text.type).toBe('radio');

		// **The literal name on both, and the count.** `expect(text.name).toBe(style.name)` is green as
		// `'' === ''`, so it survives the name being deleted from both — and the one shared name is the
		// entire reason this ADR mandates radios here: it is what makes the two mutually exclusive and
		// what supplies the arrow-key traversal nothing in this file writes by hand.
		expect(text.name).toBe('annotation-inspector-face');
		expect(style.name).toBe('annotation-inspector-face');
		expect(document.querySelectorAll('input[name="annotation-inspector-face"]')).toHaveLength(2);

		// Each tab says which region it drives, and that region is the face.
		expect(text).toHaveAttribute('aria-controls', 'annotation-inspector-face');
		expect(style).toHaveAttribute('aria-controls', 'annotation-inspector-face');
		expect(one('annotation-inspector-face')).toHaveAttribute('id', 'annotation-inspector-face');

		// **`checked` beside `aria-selected`, because `checked` is the half with consequences**: daisyUI
		// draws the chosen tab from `label:has(:checked)` and the platform puts the group's single tab
		// stop on the checked radio, so `aria-selected` alone is green with nothing highlighted and
		// nothing focusable.
		expect(text.checked).toBe(true);
		expect(style.checked).toBe(false);
		expect(text).toHaveAttribute('aria-selected', 'true');
		expect(style).toHaveAttribute('aria-selected', 'false');

		// And the component writes it, rather than only the click that happened to set it: after the
		// face resets, `checked` has moved back with nothing having been pressed.
		await press(style);
		show(annotation({ id: 'a-2' }));

		expect(text.checked).toBe(true);
		expect(style.checked).toBe(false);
		expect(text).toHaveAttribute('aria-selected', 'true');
		expect(style).toHaveAttribute('aria-selected', 'false');
	});

	test('the showing face is named by the words on its tab', () => {
		// The words "Text" and "Style" are the `<label>`'s, so the label is what `aria-labelledby` names.
		// Pointing it at the radio would leave the panel's announced name to the accessible-name
		// algorithm recursing into a form control to recover its native label, which screen readers
		// disagree about — and pointing it at an id nothing carries names nothing at all.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });

		const face = one('annotation-inspector-face')!;
		expect(face).toHaveAttribute('aria-labelledby', 'annotation-inspector-tab-text');
		expect(document.getElementById('annotation-inspector-tab-text')).toBe(
			one('annotation-inspector-tab-text')
		);
		expect(document.getElementById('annotation-inspector-tab-text')?.textContent?.trim()).toBe(
			'Text'
		);
	});

	test('and the name follows the face that is showing', async () => {
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		await press(one('annotation-inspector-tab-style')!.querySelector('input')!);

		const face = one('annotation-inspector-face')!;
		expect(face).toHaveAttribute('aria-labelledby', 'annotation-inspector-tab-style');
		expect(document.getElementById('annotation-inspector-tab-style')).toBe(
			one('annotation-inspector-tab-style')
		);
		expect(document.getElementById('annotation-inspector-tab-style')?.textContent?.trim()).toBe(
			'Style'
		);
	});
});

describe('the strip has no memory', () => {
	const style = (): HTMLInputElement =>
		one('annotation-inspector-tab-style')!.querySelector('input')!;

	test('Text is the showing face on first render', () => {
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });

		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'text');
		expect(one('harness-inspector-text')).toBeInTheDocument();
		expect(one('harness-inspector-style')).not.toBeInTheDocument();
	});

	test('a different Annotation arriving while Style was showing shows Text', async () => {
		// The whole of "selecting an Annotation to read it does not put a colour picker in front of me":
		// styling is one deliberate press away and never simply present, whichever Annotation was last
		// being styled.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		await press(style());
		expect(one('harness-inspector-style')).toBeInTheDocument();

		show(annotation({ id: 'a-2', type: 'Polygon' }));

		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'text');
		expect(one('harness-inspector-text')).toHaveAttribute('data-annotation-id', 'a-2');
		expect(one('harness-inspector-style')).not.toBeInTheDocument();
	});

	test('a fresh object carrying the same id does not reset the face', async () => {
		// ⚠ **This is the half that catches the regression.** `annotation` is a fresh object after every
		// save, and a save is every keystroke, so an effect that read the object rather than comparing
		// its id would slam the face back to Text mid-sentence — taking the swatch out from under the
		// pointer that was about to press it. The editor's `AnnotationTextFace` carries the same guard over
		// its own fields, and records the suite failure the unguarded version produced.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true });
		await press(style());
		expect(one('harness-inspector-style')).toBeInTheDocument();

		show(annotation({ id: 'a-1', title: 'Fort Amsterda' }));
		show(annotation({ id: 'a-1', title: 'Fort Amsterdam' }));

		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'style');
		expect(one('harness-inspector-style')).toBeInTheDocument();
		// And the new words did arrive, which is what says the panel re-rendered rather than ignoring
		// the prop: a component that never noticed the update would pass the assertions above.
		expect(one('annotation-inspector-name')?.textContent?.trim()).toBe('Fort Amsterdam');
	});
});

describe('dismissing reports rather than clears', () => {
	test('the dismiss control calls onclose and the Inspector changes nothing of its own', async () => {
		// The selection lives in the consumer's state, so an Inspector that took itself off the screen
		// would be a second answer to "which Annotation is selected". The harness deliberately does not
		// act on the report, which is what lets the second half of this be asserted at all.
		const closed = vi.fn();
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0, withStyle: true, onclose: closed });
		await press(one('annotation-inspector-tab-style')!.querySelector('input')!);

		await press(one('annotation-inspector-close')!);

		expect(closed).toHaveBeenCalledTimes(1);
		expect(one('annotation-inspector')).toBeInTheDocument();
		expect(one('annotation-inspector-face')).toHaveAttribute('data-face', 'style');
	});

	test('the dismiss control says what it does in words', () => {
		// An icon-only button carries its label in text (ADR-0016's icon amendment); a glyph alone is
		// not an information channel.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0 });

		expect(one('annotation-inspector-close')).toHaveTextContent('Dismiss the Annotation Inspector');
	});
});

describe('less motion is respected here as everywhere else', () => {
	// ⚠ **These assert the number the component computed, and not that the Inspector animated.** There
	// is no paint at this seam and no Web Animations clock, so what an animation looks like has no
	// answer here — see `vitest-setup/web-animations.ts`. `prefersReducedMotion` is a real media query
	// against this DOM's own device settings, so the branch that produced the number is the one the
	// application runs.

	test('the duration is zero when less motion has been asked for', () => {
		device().prefersReducedMotion = 'reduce';
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0 });

		expect(one('annotation-inspector')).toHaveAttribute('data-reveal-ms', '0');
	});

	test('and the application’s own 220 ms when it has not been', () => {
		// The positive control. A duration hard-coded to `0` would satisfy the test above for ever.
		inspect({ annotation: annotation({ id: 'a-1' }), index: 0 });

		expect(one('annotation-inspector')).toHaveAttribute('data-reveal-ms', '220');
	});
});
