<script lang="ts">
	// One Annotation's row: a selector that opens nothing.
	//
	// **The row says which Annotation this is and that it is the chosen one, and that is all it says**
	// (ADR-0035). An Annotation's *membership* — that it belongs to a Layer which is shown, hidden,
	// ordered, renamed and deleted as a group — is what a stack of cards answers well, and this row is
	// that answer. Its *content* is read in the `AnnotationInspector` docked over the map, in both apps,
	// because a title, a paragraph of prose and an author's twenty-five style controls do not fit in a
	// 24 rem column three sibling rows are sharing. ADR-0035 has the reasoning, including what mooring
	// the panel to its Annotation now that it is not inside the row: the dashed leader, and the ordinal
	// and name this row and that header draw from one rule each.
	//
	// **`open` is the selection, and the disclosure semantics survive the region moving.** The button
	// keeps `aria-expanded`, and `aria-controls` names the Inspector — which is legal without
	// containment — so a screen reader is told the same thing it was told when the region was in the
	// row. `aria-pressed` is still refused: two properties for one fact are two things that can
	// disagree.

	import { annotationOrdinal, type Annotation } from '@ballastella/core';

	import { ANNOTATION_INSPECTOR_ID } from './annotation-inspector-id.js';
	import { annotationName, shapeWord } from './annotation-name.js';
	import { KIND_STYLE } from './layer-kind-style.js';
	import { iconForAnnotation } from './shape-icons.js';

	let {
		annotation,
		index,
		open,
		onopen
	}: {
		annotation: Annotation;
		/**
		 * Where this Annotation sits in its collection, counted from zero.
		 *
		 * Read for the ordinal this row draws and for the untitled fallback's number. It is the
		 * *collection's* position rather than this row's place among the rows on screen, so that the
		 * Inspector's header — handed the same number — names the same "Untitled pin 3".
		 */
		index: number;
		open: boolean;
		/** The row was pressed: this Annotation's id to select it, `null` to deselect it. */
		onopen: (id: string | null) => void;
	} = $props();

	/**
	 * How one Annotation reads in the list.
	 *
	 * `annotation-name.ts`'s rather than this component's, because the Inspector's header names the
	 * same Annotation from the same rule and the two must not be able to disagree (ADR-0035).
	 */
	const name = $derived(annotationName(annotation, index));

	const Icon = $derived(iconForAnnotation(annotation));
</script>

<!--
	**The selected Annotation's row is marked in the Annotation Layer's own two colours, over the whole
	of it.** In a 24 rem column of four near-identical rows, a mark covering part of a row was not
	enough to say which row had been chosen — the fault a scholar reported first — so the selected
	Annotation is one marked block.

	`KIND_STYLE.annotation.tint` is the same 10% the card's header wears, from the one table every
	colour in this card comes from (`layer-kind-style.ts`). It is a wash rather than a fill for a
	reason: at 10% over `base-100` the row's text stays on the colour it was already legible on, where
	a `base-content` slab has to re-solve its own contrast and then repaint the text to win.

	⚠ **The spine is not the rule that was removed.** What was removed was `border-primary` over
	daisyUI's `menu-active`: two colours making two claims, `primary` being the *app's* action colour
	reserved for the controls outside the Layer cards, and `menu-active` painting `base-content` —
	near-black in the light theme — so a blue rule sat against a black slab in a card whose every other
	control is `info`. Nothing about either colour said "this belongs to the Annotations". This spine is
	the Annotation Layer's own ink, `--layer-kind-ink-annotation`, the same custom property
	`KIND_STYLE.annotation.ink` sets text in and `layout.css` computes from `--color-info`; and it is on
	the selected row only, where the removed rule was drawn on a row that was merely `menu-active`.

	An inset box shadow rather than `border-l-2`, because a border is layout: two pixels appearing on
	the left of the selected row would shift its text sideways as the selection moved down the list.

	Colour is not the only channel (the-annotation-inspector story 7): the name goes semibold, which
	survives a monochrome screen, and `aria-expanded` is what carries the state to a screen reader
	(story 8 of the same epic).
-->
<li
	class={[
		'border-b border-base-200 last:border-b-0',
		open && `${KIND_STYLE.annotation.tint} shadow-[inset_2px_0_0_var(--layer-kind-ink-annotation)]`
	]}
	data-testid="annotation-row-item"
>
	<!--
		**That button's expanded state is the selection.** There is deliberately no `aria-pressed` beside
		it: a row that was pressed but not open, or open but not pressed, would be two answers to "which
		Annotation is active", and two properties for one fact are two things that can disagree
		(the-annotation-inspector story 54). `aria-expanded` is ADR-0016's shape for a disclosure, and it
		is the Layer card's own convention one level down rather than a second one invented here. There
		is no separate control beside the name for the same reason: the gesture that chooses an
		Annotation is the gesture that opens the panel about it.

		**The region it names is the `AnnotationInspector`, across the screen** (ADR-0035).
		`aria-controls` does not require containment, so the disclosure semantics survive the region
		having moved out of the row (the-annotation-inspector story 53) — and it is named only while this
		row is the selected one, because two rows naming one panel would be two rows claiming it.
	-->
	<button
		type="button"
		class={['flex w-full items-center gap-2 rounded-none py-2', open && 'font-semibold']}
		aria-expanded={open}
		aria-controls={open ? ANNOTATION_INSPECTOR_ID : undefined}
		data-testid="annotation-row"
		data-annotation-id={annotation.id}
		onclick={() => onopen(open ? null : annotation.id)}
	>
		<!--
			**The number, so that "look at 3" identifies one Annotation across a desk** (stories 37, 38).
			It is the same number the mark on the map draws, from `annotationOrdinal` in `core` — one
			rule, so the canvas and the sidebar cannot disagree — and it is *inside the button* rather
			than positioned beside it, so a screen reader hears "3, shape, Untitled shape 3" and nothing
			about which Annotation is which depends on seeing a line (story 42).

			⚠ **Nothing writes it.** The number is this row's place in the collection it was handed, and
			deleting an Annotation renumbers the rest because the list renders again (ADR-0002).

			The kind's own ink rather than a plain `opacity-60` like the shape word: the number is what
			the mark on the map is wearing, and the ink is the measured mix `layout.css` computes from
			`--color-info` — 6.0:1 in the light theme and 8.8:1 in dark, on the row's own 10% wash. The
			raw token is 2.2:1 there and could not carry text this size.
		-->
		<span
			class={['shrink-0 text-xs font-semibold tabular-nums', KIND_STYLE.annotation.ink]}
			data-testid="annotation-row-ordinal"
		>
			{annotationOrdinal(index)}
		</span>

		<!--
			The same glyph the tool that drew it carries, and **beside the word rather than instead of
			it** (SPEC story 111) — the word is what a screen reader reads and what a glyph alone would
			have taken away.
		-->
		<Icon class="size-4 shrink-0 opacity-60" aria-hidden="true" />
		<span class="shrink-0 text-xs opacity-60">{shapeWord(annotation)}</span>
		<span class="truncate" data-testid="annotation-row-name">
			{name}
		</span>
	</button>
</li>
