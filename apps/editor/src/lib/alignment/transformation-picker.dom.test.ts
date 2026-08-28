// What the transformation picker renders for a given Control Point count (ADR-0013).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT MOVED HERE FROM `e2e/editor-alignment-refinement.e2e.ts`, AND WHAT DELIBERATELY DID NOT
//
// Two end-to-end tests each seeded a Project into OPFS, booted the built editor, waited for a real
// MapLibre and a warped pyramid, and then clicked ten Control Point pairs onto two canvases — all so
// that a `<select>`'s option list could be read. `TransformationPicker` computes that list from two
// props and nothing else, so none of it was load-bearing: the claims are about the *option text, the
// tiers, the disclosure and the shortfall sentences*, every one of which this file can fail on for the
// right reason.
//
// ⚠ **What did not move is as important.**
//
// - **That any of this reaches the Alignment on disk.** The stored transformation, the ban on
//   `straight` / `linear` / the bare `polynomial` alias, and the reload that has to come back as third
//   order are claims about bytes and about `@allmaps/annotation`; they stay in
//   `e2e/editor-alignment-refinement.e2e.ts`, where they are asserted against a real file.
// - **That the renderer is told the chosen type.** `WarpedMap` reads `transformation.type` and ignores
//   the order beside it, so "reaches the renderer" can only be asked of a real renderer.
// - **That the guidance is actually painted rather than merely present.** `offsetParent` is layout and
//   this DOM implementation has none, so ADR-0016's "visible text, never a `::before` tooltip" keeps
//   its Seam 2 test. What moves here is the half that is markup: the `aria-describedby` wiring, the
//   text it resolves to, and that the picker leans on no `title` and no tooltip class.
// - **That `controlPointCount` is the number of pairs the user has placed.** This file passes it in.
//
// Everything is addressed by position and read straight off the document, per
// `layer-list.dom.test.ts`: `mount` is Svelte's own and a query is `document.querySelector`.

import { TRANSFORMATION_CHOICES, type TransformationType } from '@ballastella/core';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

import TransformationPicker from './TransformationPicker.svelte';

let mounted: Record<string, unknown> | undefined;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
});

/** The picker at a given selection and Control Point count, plus the spy it calls to choose. */
const picker = (options: {
	value?: TransformationType;
	controlPointCount: number;
}): ((type: TransformationType) => void) => {
	const onchoose = vi.fn();
	mounted = mount(TransformationPicker, {
		target: document.body,
		props: {
			value: options.value ?? 'polynomial1',
			controlPointCount: options.controlPointCount,
			onchoose
		}
	});
	flushSync();
	return onchoose;
};

const at = (testId: string): HTMLElement => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	if (!found) throw new Error(`nothing is rendered with data-testid="${testId}"`);
	return found;
};

const select = (): HTMLSelectElement => at('transformation-select') as HTMLSelectElement;

/** Every `<option>`, disabled or not, in document order. */
const options = () =>
	[...select().options].map((option) => ({
		value: option.value,
		text: option.textContent?.trim() ?? '',
		disabled: option.disabled,
		group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : ''
	}));

/** Press the Advanced disclosure, and let the rerender happen. */
const pressAdvanced = (): void => {
	at('transformation-advanced').click();
	flushSync();
};

describe('the tiers the picker offers (ADR-0013)', () => {
	// Ten pairs, so nothing here is disabled and the list is the whole list.
	test('offers four primary types with the guidance as the primary text, and two behind Advanced', () => {
		picker({ controlPointCount: 10 });

		// Four to begin with. The Advanced tier is not merely styled differently — it is not there.
		expect(options().map((one) => one.value)).toEqual([
			'helmert',
			'polynomial1',
			'projective',
			'thinPlateSpline'
		]);

		// **Guidance first, label second.** ADR-0013: "Most printed maps" is what a historian can act
		// on; "Standard" is not. Asserted as the whole string so the order is the assertion.
		expect(options().map((one) => one.text)).toEqual([
			'Accurate modern maps — rotate, scale, and move only (Simple)',
			'Most printed and scanned maps (Standard)',
			'Maps photographed at an angle (Perspective)',
			'Hand-drawn or geometrically inconsistent maps (Flexible)'
		]);
	});

	test('announces Advanced as a disclosure, and closes it again', () => {
		picker({ controlPointCount: 10 });

		expect(at('transformation-advanced').getAttribute('aria-expanded')).toBe('false');
		pressAdvanced();
		expect(at('transformation-advanced').getAttribute('aria-expanded')).toBe('true');

		expect(options().map((one) => one.value)).toEqual([
			'helmert',
			'polynomial1',
			'projective',
			'thinPlateSpline',
			'polynomial2',
			'polynomial3'
		]);
		// Grouped and named, so the tier is announced rather than being a matter of position.
		expect(options()[4]?.group).toBe('Advanced');
		expect(options()[5]?.group).toBe('Advanced');
		expect(options()[4]?.text).toBe('Only with many well-spread points (Higher-order (2nd))');

		pressAdvanced();
		expect(at('transformation-advanced').getAttribute('aria-expanded')).toBe('false');
		expect(options()).toHaveLength(4);
	});

	// How a stored Alignment reopens. `advancedRequested` is page state and does not survive a reload,
	// so without this a Project saved as Higher-order (3rd) would come back with its own type missing
	// from the list — and a `<select>` whose value matches no option falls back to the first, which
	// reads as the choice having been silently changed to Simple.
	test('discloses Advanced unasked when an advanced type is the one selected', () => {
		picker({ value: 'polynomial3', controlPointCount: 10 });

		expect(options().map((one) => one.value)).toContain('polynomial3');
		expect(select().value).toBe('polynomial3');
		// And the hide button is not offered, because the thing it would hide is the user's own choice.
		expect(document.querySelector('[data-testid="transformation-advanced"]')).toBeNull();
	});
});

describe('the point count gates the type, visibly (ADR-0013)', () => {
	// Two pairs: enough for Simple, one short of Standard and Flexible, two short of Perspective.
	test('disables a type below its minimum and names the shortfall', () => {
		picker({ value: 'helmert', controlPointCount: 2 });
		pressAdvanced();

		const byValue = (value: string) => options().find((one) => one.value === value);

		expect(byValue('helmert')?.disabled, 'Simple needs 2 and there are 2').toBe(false);
		expect(byValue('polynomial1')?.disabled).toBe(true);
		expect(byValue('projective')?.disabled).toBe(true);
		expect(byValue('thinPlateSpline')?.disabled).toBe(true);
		expect(byValue('polynomial2')?.disabled).toBe(true);
		expect(byValue('polynomial3')?.disabled).toBe(true);

		// **The shortfall is named**, on the option itself, with both numbers — not merely greyed out.
		// ADR-0013's own example sentence.
		expect(byValue('thinPlateSpline')?.text).toContain(
			'Flexible needs at least 3 Control Points — you have 2'
		);
		expect(byValue('polynomial3')?.text).toContain(
			'Higher-order (3rd) needs at least 10 Control Points — you have 2'
		);

		// And on the page, so it answers a question the user has while placing points rather than one
		// they have while browsing a list.
		const listed = at('transformation-shortfalls').textContent ?? '';
		expect(listed).toContain('Flexible needs at least 3 Control Points — you have 2');
		expect(listed).toContain('Perspective needs at least 4 Control Points — you have 2');
		expect(listed).toContain('Higher-order (3rd) needs at least 10 Control Points — you have 2');
	});

	// A third pair takes Standard and Flexible off the list and leaves Perspective on it.
	test('drops a shortfall the moment the count reaches the minimum', () => {
		picker({ controlPointCount: 3 });

		const listed = at('transformation-shortfalls').textContent ?? '';
		expect(listed).not.toContain('Flexible needs');
		expect(listed).toContain('Perspective needs at least 4');
		expect(options().find((one) => one.value === 'thinPlateSpline')?.disabled).toBe(false);
		expect(options().find((one) => one.value === 'projective')?.disabled).toBe(true);
	});

	// The type must never be settable in a state the solver cannot handle: with too few points the
	// solve is under-determined and yields a thrown error or a garbage warp.
	test('refuses to choose a type the count cannot support', () => {
		const onchoose = picker({ value: 'helmert', controlPointCount: 2 });

		select().value = 'thinPlateSpline';
		select().dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(onchoose).not.toHaveBeenCalled();

		select().value = 'helmert';
		select().dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(onchoose).toHaveBeenCalledWith('helmert');
	});
});

describe('the guidance is announced with the control (ADR-0016)', () => {
	// A `<select>` shows only the chosen option until it is opened, so the guidance is repeated as
	// prose and bound to the control. ADR-0016 names this copy as exactly what would otherwise be
	// buried in a daisyUI tooltip — which renders through CSS `::before`, so screen readers do not
	// announce it and it cannot be dismissed.
	test('describes the control with the selected type’s guidance, by id', () => {
		picker({ controlPointCount: 3 });

		const describedById = select().getAttribute('aria-describedby') ?? '';
		expect(describedById).not.toBe('');
		expect(document.getElementById(describedById)?.textContent?.trim()).toBe(
			'Most printed and scanned maps'
		);
		expect(at('transformation-guidance').textContent?.trim()).toBe('Most printed and scanned maps');
	});

	test('the guidance follows the selection rather than the default', () => {
		picker({ value: 'thinPlateSpline', controlPointCount: 3 });

		expect(at('transformation-guidance').textContent?.trim()).toBe(
			'Hand-drawn or geometrically inconsistent maps'
		);
	});

	test('leans on no tooltip, native or daisyUI', () => {
		picker({ controlPointCount: 3 });

		const group = at('transformation-picker');
		expect(group.querySelector('[title]')).toBeNull();
		expect(group.querySelector('[class*="tooltip"]')).toBeNull();
	});
});

// The two notes about *consequences* — that Simple cannot mirror, and that the higher orders distort
// at the edges — belong behind "How this works" in `AlignmentWorkspace`, with the rest of this
// screen's explanation, and `e2e/editor-align-route.e2e.ts` asserts them inside that disclosure.
// This is the other half of that claim, and it is the half that catches a note creeping back into
// the group: neither renders here in the state that would show it — Simple selected, and Advanced
// disclosed.
describe('the notes about consequences are not standing in this group', () => {
	test('says nothing extra about Simple when Simple is the selection', () => {
		picker({ value: 'helmert', controlPointCount: 3 });

		expect(document.querySelector('[data-testid="transformation-simple-note"]')).toBeNull();
		expect(at('transformation-picker').textContent).not.toContain('cannot turn the Map Image over');
	});

	test('says nothing extra about the higher orders when Advanced is disclosed', () => {
		picker({ controlPointCount: 10 });
		pressAdvanced();

		expect(document.querySelector('[data-testid="transformation-advanced-note"]')).toBeNull();
		expect(at('transformation-picker').textContent).not.toContain('spectacular distortion');
	});
});

// Every guidance string the picker can show comes from `TRANSFORMATION_CHOICES`, which ADR-0013's
// table pins at Seam 1. This is the join: whatever is in that table is what the option carries, so a
// type added there cannot arrive in the picker without its guidance.
test('renders an option for every type the catalog offers', () => {
	picker({ controlPointCount: 10 });
	pressAdvanced();

	expect(options().map((one) => one.value)).toEqual(
		TRANSFORMATION_CHOICES.map((choice) => choice.type)
	);
	for (const choice of TRANSFORMATION_CHOICES) {
		expect(options().find((one) => one.value === choice.type)?.text).toContain(choice.guidance);
	}
});
