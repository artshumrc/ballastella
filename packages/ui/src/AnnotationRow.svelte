<script lang="ts">
	// One Annotation's row: a selector that opens nothing, and the place its order is changed.
	//
	// **The row says which Annotation this is and that it is the chosen one** (ADR-0035). An
	// Annotation's *membership* — that it belongs to a Layer which is shown, hidden, ordered, renamed
	// and deleted as a group — is what a stack of cards answers well, and this row is that answer. Its
	// *content* is read in the `AnnotationInspector` docked over the map, in both apps, because a
	// title, a paragraph of prose and an author's twenty-five style controls do not fit in a 24 rem
	// column three sibling rows are sharing. ADR-0035 has the reasoning, including what moors the panel
	// to its Annotation now that it is not inside the row: the dashed leader, and the ordinal and name
	// this row and that header draw from one rule each.
	//
	// **A row is dragged to reorder it, and that is the only control it gains.** The order of a
	// `FeatureCollection` is the order its shapes draw in, which makes it the only thing deciding which
	// of two overlapping Annotations is on top — ADR-0002's "order is load-bearing" one level down from
	// the Layer stack. ADR-0016 makes the drag the *convenience* and requires a keyboard path beside it,
	// and that path is deliberately **not** here: the row holds one button and nothing else opens in it
	// (the-annotation-inspector stories 10, 69), so a control strip appearing under the selected row is
	// the growth that story forbids. The Move buttons and the Layer picker live in the Inspector,
	// where Delete already is, because all three act on the Annotation the panel is describing.
	//
	// Without `onmove` there is no handle and no drop target, which is what a published site gets: the
	// order of a Layer's shapes is the author's decision, and a Reader is not offered it.
	//
	// **`open` is the selection, and the disclosure semantics survive the region moving.** The button
	// keeps `aria-expanded`, and `aria-controls` names the Inspector — which is legal without
	// containment — so a screen reader is told the same thing it was told when the region was in the
	// row. `aria-pressed` is still refused: two properties for one fact are two things that can
	// disagree.

	import { annotationOrdinal, type Annotation } from '@ballastella/core';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';

	import { ANNOTATION_DRAG_TYPE } from './annotation-drag.js';
	import { ANNOTATION_INSPECTOR_ID } from './annotation-inspector-id.js';
	import { annotationName, shapeWord } from './annotation-name.js';
	import { KIND_STYLE } from './layer-kind-style.js';
	import { iconForAnnotation } from './shape-icons.js';

	let {
		annotation,
		index,
		open,
		onopen,
		onmove,
		dragging = $bindable(''),
		over = $bindable('')
	}: {
		annotation: Annotation;
		/**
		 * Where this Annotation sits in its collection, counted from zero.
		 *
		 * Read for the ordinal this row draws, for the untitled fallback's number, and for the position a
		 * drop onto this row asks for. It is the *collection's* position rather than this row's place
		 * among the rows on screen, so that the Inspector's header — handed the same number — names the
		 * same "Untitled pin 3".
		 */
		index: number;
		open: boolean;
		/** The row was pressed: this Annotation's id to select it, `null` to deselect it. */
		onopen: (id: string | null) => void;
		/**
		 * An Annotation was dropped on this row: move it to this row's position in the collection.
		 * Without it there is no handle and no drop target.
		 */
		onmove?: (id: string, toIndex: number) => void;
		/**
		 * The Annotation being dragged and the row a drop would land on, both `''` for neither.
		 *
		 * Bound rather than owned, because they are facts about the *list*: only one row is being
		 * dragged and only one is the target, and two rows each holding their own copy is two answers
		 * to one question. The list also announces the move, which it can only do knowing both.
		 */
		dragging?: string;
		over?: string;
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

	**The whole row is the drop target and only the handle is the drag source**, which is the
	arrangement `LayerList` arrived at the hard way: a pointer drag beginning anywhere inside a
	`draggable` element is claimed by the drag machinery rather than by the control under it, so a
	`draggable` row is a row whose text cannot be selected with the mouse.

	`data-drop-target` says whether a drop would land here — the same fact the outline draws — because
	a highlight that *flickers* is a sequence of states rather than a state, and a test cannot watch a
	class over time without reading the stylesheet's mind. An `outline` rather than a border for the
	reason the selected row's spine is a shadow: an outline is not layout, so nothing shifts sideways
	as the target moves down the list.

	**The drag handlers go with `onmove`, exactly as the handle does.** A row that highlights and calls
	`preventDefault` on `dragover` is telling the pointer that a drop here will be accepted; without
	`onmove` it would be accepting one it cannot perform.
-->
<li
	class={[
		'group/annotation-row border-b border-base-200 last:border-b-0',
		open && `${KIND_STYLE.annotation.tint} shadow-[inset_2px_0_0_var(--layer-kind-ink-annotation)]`,
		dragging === annotation.id && 'opacity-50',
		over === annotation.id &&
			dragging !== annotation.id &&
			'outline-2 -outline-offset-2 outline-[var(--layer-kind-ink-annotation)]'
	]}
	data-testid="annotation-row-item"
	data-drop-target={over === annotation.id && dragging !== annotation.id ? 'true' : 'false'}
	ondragover={onmove &&
		((event) => {
			// Only an Annotation, and never the row it is already on. A Layer being dragged across the
			// stack passes over these rows on its way to a card, and a row that highlighted for it would
			// be promising a drop it has no way to perform.
			if (!event.dataTransfer?.types.includes(ANNOTATION_DRAG_TYPE)) return;
			// Without this the drop never fires: the default action of `dragover` is to refuse.
			event.preventDefault();
			over = annotation.id;
		})}
	ondragleave={onmove &&
		((event) => {
			// **Only when the pointer has really left this row.** `dragleave` fires on every descendant
			// and bubbles, so crossing from the row's padding onto the name, the ordinal or the shape
			// word inside it delivers a leave *for the row* — which cleared the highlight until the next
			// `dragover` put it back, once per element crossed. `relatedTarget` is what the leave is
			// *for*, so a leave into this row's own subtree is not a leave at all. It is null when the
			// pointer goes somewhere with no element to name, such as out of the window, and that is a
			// real departure: the highlight has to go, or a drag abandoned outside the app leaves a row
			// looking like a target for ever.
			const entered = event.relatedTarget;
			if (entered instanceof Node && event.currentTarget.contains(entered)) return;
			if (over === annotation.id) over = '';
		})}
	ondrop={onmove &&
		((event) => {
			const id = event.dataTransfer?.getData(ANNOTATION_DRAG_TYPE);
			event.preventDefault();
			over = '';
			dragging = '';
			if (!id || id === annotation.id) return;
			onmove(id, index);
		})}
>
	<!--
		One element under the `<li>`, because daisyUI's `menu` styles each direct child as an item: two
		of them would be two padded, separately-hovering blocks where the row is one thing. **It is also
		the whole of what the selected row grows by, which is nothing**: the handle is present on every
		row whether or not it is the chosen one (stories 10, 69).
	-->
	<div class="flex items-center gap-1 rounded-none">
		{#if onmove}
			<!--
					`aria-hidden` because it is pointer-only and redundant: the Inspector's Move buttons are
					the contract and the drag is the convenience (ADR-0016). Faint at rest and up to
					full strength when the row is hovered or holds focus — always present and always
					operable, never the thing your eye lands on first.

					**What it carries is the id, twice.** `text/plain` is what a drag deposits in any text
					field it is dropped on and is worth being the Annotation's name rather than its id — but
					nothing outside this app reads that, and the id in both formats keeps the drop handlers
					reading one value. See `annotation-drag.ts` for why the custom format exists at all.
				-->
			<span
				class="shrink-0 cursor-grab leading-none opacity-30 transition-opacity select-none group-focus-within/annotation-row:opacity-70 group-hover/annotation-row:opacity-70"
				draggable="true"
				aria-hidden="true"
				data-testid="annotation-drag-handle"
				ondragstart={(event) => {
					dragging = annotation.id;
					event.dataTransfer?.setData(ANNOTATION_DRAG_TYPE, annotation.id);
					event.dataTransfer?.setData('text/plain', annotation.id);
				}}
				ondragend={() => {
					dragging = '';
					over = '';
				}}
			>
				<GripVertical size={14} />
			</span>
		{/if}

		<!--
				**That button's expanded state is the selection.** There is deliberately no `aria-pressed`
				beside it: a row that was pressed but not open, or open but not pressed, would be two
				answers to "which Annotation is active", and two properties for one fact are two things that
				can disagree (the-annotation-inspector story 54). `aria-expanded` is ADR-0016's shape for a
				disclosure, and it is the Layer card's own convention one level down rather than a second one
				invented here. There is no separate control beside the name for the same reason: the gesture
				that chooses an Annotation is the gesture that opens the panel about it.

				**The region it names is the `AnnotationInspector`, across the screen** (ADR-0035).
				`aria-controls` does not require containment, so the disclosure semantics survive the region
				having moved out of the row (the-annotation-inspector story 53) — and it is named only while
				this row is the selected one, because two rows naming one panel would be two rows claiming it.
			-->
		<button
			type="button"
			class={['flex grow items-center gap-2 bg-transparent p-0 text-left', open && 'font-semibold']}
			aria-expanded={open}
			aria-controls={open ? ANNOTATION_INSPECTOR_ID : undefined}
			data-testid="annotation-row"
			data-annotation-id={annotation.id}
			onclick={() => onopen(open ? null : annotation.id)}
		>
			<!--
					**The number, so that "look at 3" identifies one Annotation across a desk** (stories 37,
					38). It is the same number the mark on the map draws, from `annotationOrdinal` in `core` —
					one rule, so the canvas and the sidebar cannot disagree — and it is *inside the button*
					rather than positioned beside it, so a screen reader hears "3, shape, Untitled shape 3" and
					nothing about which Annotation is which depends on seeing a line (story 42).

					⚠ **Nothing writes it.** The number is this row's place in the collection it was handed,
					so deleting an Annotation renumbers the rest, and so does moving one (ADR-0002).

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
	</div>
</li>
