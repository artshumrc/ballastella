<script lang="ts">
	// One Annotation's content, read beside the map (ADR-0035).
	//
	// The Inspector owns three things and nothing else: the identity header, the tab strip, and which
	// face is showing. What either face *contains* is the consumer's, handed in as a snippet.
	//
	// **Every difference between the two apps here is an unpassed snippet.** The editor passes a `style`
	// snippet and gets a tab strip; the viewer passes none and gets no strip at all — not a disabled
	// Style tab and not a lone Text tab, because one face is not a choice. There is no `readOnly` prop
	// and no `mode` prop: a flag beside the snippet would be a second description of the same fact, and
	// two descriptions can disagree (the-annotation-inspector stories 65, 66).
	//
	// **The Inspector does not position itself.** Where it sits — top-right over the map pane on a
	// desktop, a sheet at the bottom on a phone — is the consumer's, because only the consumer knows
	// what container it is in and what else is in that container. Nothing here sets `position`.
	//
	// **The block a consumer renders this in must be unkeyed, and must not dip false between
	// selections.** This component carries a fixed element id and a 220 ms out transition, so a
	// `{#key annotation.id}` — or an `{#if}` whose condition goes false for a frame while the selection
	// moves — keeps the outgoing panel mounted beside the incoming one for that duration: two elements
	// answering to `id="annotation-inspector"`, their two tab strips merged into one radio group, and a
	// row whose `aria-controls` no longer names a single target. Showing a different Annotation means
	// handing the same instance a new `annotation` prop, which is what the face reset below is for.

	import { annotationOrdinal, type Annotation } from '@ballastella/core';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { fly } from 'svelte/transition';

	import { annotationName, shapeWord } from './annotation-name.js';
	import { KIND_STYLE } from './layer-kind-style.js';
	import { iconForGeometry } from './shape-icons.js';

	let {
		annotation,
		index,
		onclose,
		text,
		style
	}: {
		annotation: Annotation;
		/**
		 * Where this Annotation sits in its collection, counted from zero.
		 *
		 * Read for the ordinal the header draws and for the untitled fallback's number, and handed on to
		 * the `text` snippet so that whatever a consumer renders there can name the Annotation the way
		 * the header and the row name it.
		 */
		index: number;
		/**
		 * Dismiss. **The selection is the consumer's, so this reports rather than clears**: the
		 * Inspector is on screen because a row is selected, and un-selecting that row is a fact about
		 * the list rather than about this panel.
		 */
		onclose: () => void;
		/** The Text face. Both apps pass `AnnotationReading`; the editor wraps it in its own controls. */
		text: Snippet<[Annotation, number]>;
		/**
		 * The Style face.
		 *
		 * Absent in the viewer, and absent in the editor for an Annotation whose geometry this build
		 * cannot draw — in both cases there is simply no Style tab, rather than a tab that opens on a
		 * sentence explaining its own emptiness.
		 *
		 * Explicitly `| undefined` because a consumer that computes the snippet has to be able to hand
		 * over "none", and `exactOptionalPropertyTypes` otherwise distinguishes that from an absent prop.
		 */
		style?: Snippet<[Annotation]> | undefined;
	} = $props();

	/**
	 * The Inspector's own element id, fixed rather than derived from the Annotation.
	 *
	 * One Inspector is on screen at a time — one Layer card open, one row selected — which is what
	 * makes a fixed id safe, the same argument `AnnotationList` makes for its own. A row's
	 * `aria-controls` points here.
	 */
	const ID = 'annotation-inspector';

	const FACE_ID = `${ID}-face`;

	/**
	 * The two tabs' element ids, carried by the `<label>`s rather than by the radios inside them.
	 *
	 * "Text" and "Style" are the labels' own text, so a label is something the face's `aria-labelledby`
	 * can name outright. Naming the radio instead would leave the panel's accessible name to depend on
	 * the name algorithm recursing into a form control and recovering its native label, which screen
	 * readers do not agree about.
	 */
	const TEXT_TAB_ID = `${ID}-tab-text`;
	const STYLE_TAB_ID = `${ID}-tab-style`;

	/**
	 * Which face is showing.
	 *
	 * This component's own state and not a prop: which of two faces of one Annotation somebody is
	 * looking at is not a thing either app has any other use for.
	 */
	let face = $state<'text' | 'style'>('text');

	/**
	 * The Annotation this component last reacted to.
	 *
	 * **The guard is the point, not bookkeeping.** `annotation` is a fresh object every time the
	 * collection is re-read — which is after every save, which is while somebody is typing — so an
	 * effect that read the object rather than comparing its id would re-run on each keystroke's write
	 * and slam the face back to Text mid-sentence, taking the Style controls away from under the
	 * pointer. `AnnotationEditor`'s `shown` guard in the editor records the same rule and the suite
	 * failure that produced it. Comparing the id makes "a different Annotation arrived" the trigger,
	 * which is the whole of what the reset is for: the strip has no memory, so selecting another
	 * Annotation shows its words rather than the previous one's swatches
	 * (the-annotation-inspector story 26).
	 */
	let shown = $state('');

	$effect(() => {
		const id = annotation.id;
		if (id === shown) return;
		shown = id;
		face = 'text';
	});

	/**
	 * How long the Inspector takes to arrive.
	 *
	 * The same 220 ms `cubicOut` the Layer cards and the Annotation rows already use, because "how long
	 * a surface takes to appear in this application" is one thing to learn. Zero when the user has
	 * asked for less motion, which is the whole of respecting that here: the panel arrives rather than
	 * travels (the-annotation-inspector story 58).
	 */
	const arrival = $derived({
		duration: prefersReducedMotion.current ? 0 : 220,
		y: 8,
		easing: cubicOut
	});

	/**
	 * How this Annotation reads, from `annotation-name.ts` rather than from wording invented here.
	 *
	 * The same rule the row draws from, which is one of the two things mooring this panel to its
	 * Annotation now that it is not inside the row (ADR-0035): an untitled Annotation is the same
	 * "Untitled shape 3" in both places, and there is no second "Untitled" anywhere in this file.
	 */
	const name = $derived(annotationName(annotation, index));

	const Icon = $derived(iconForGeometry(annotation.geometry?.type));
</script>

<!--
	`transition:fly|global` rather than a local transition, because the block that inserts this
	component is the consumer's `{#if selected}` and a local transition plays only for the block it is
	declared in.

	`data-reveal-ms` is the number `arrival` computed, written out because it is otherwise visible only
	to something that can watch an animation — the same reason `AnnotationRow` writes its own out.

	⚠ **It is evidence about the computation and about nothing else.** The attribute and the directive
	read one `$derived`, so a test on the attribute goes red when that number is wrong and stays green
	if the transition were hard-coded past it or deleted outright.
-->
<section
	id={ID}
	class="flex w-full flex-col gap-3 overflow-hidden rounded-lg border border-base-300 bg-base-100 shadow-lg"
	aria-label="Annotation Inspector: {name}"
	data-testid="annotation-inspector"
	data-reveal-ms={arrival.duration}
	transition:fly|global={arrival}
>
	<!--
		The identity header: the ordinal, the glyph, the shape word and the name, all four from the rules
		the row draws from. **The glyph is never alone with meaning** (ADR-0016), so the shape word sits
		beside it exactly as it does in the row.
	-->
	<header
		class="flex items-start gap-2 border-b border-base-300 {KIND_STYLE.annotation.tint} px-3 py-2"
		data-testid="annotation-inspector-header"
	>
		<span
			class={['shrink-0 text-xs font-semibold tabular-nums', KIND_STYLE.annotation.ink]}
			data-testid="annotation-inspector-ordinal"
		>
			{annotationOrdinal(index)}
		</span>

		<Icon class="size-4 shrink-0 opacity-60" aria-hidden="true" />
		<span class="shrink-0 text-xs opacity-60" data-testid="annotation-inspector-shape">
			{shapeWord(annotation)}
		</span>

		<h3 class="min-w-0 grow text-sm font-semibold" data-testid="annotation-inspector-name">
			{name}
		</h3>

		<button
			type="button"
			class="btn btn-square shrink-0 btn-ghost btn-xs"
			data-testid="annotation-inspector-close"
			onclick={() => onclose()}
		>
			<X size={14} aria-hidden="true" />
			<span class="sr-only">Dismiss the Annotation Inspector</span>
		</button>
	</header>

	{#if style}
		<!--
			Radio inputs with `role="tablist"` added, which is ADR-0016's mandated method for tabs: the one
			shared `name` is what makes the two mutually exclusive and what gives the strip arrow-key
			navigation with nothing written, so the name is load-bearing rather than decorative.

			`role="tab"` overrides the checkbox mapping a radio would otherwise carry, so the chosen state
			is *said* as `aria-selected`. `checked` is not thereby ornamental: it is what the platform puts
			the group's single tab stop on, and it is what daisyUI draws the highlight from
			(`.tabs-box>:is(label:has(:checked))`). Both read one `$state`, so they cannot disagree.

			No `sr-only` on the radios: daisyUI's own `.tab:is(label) & input` is already
			`appearance:none; opacity:0; position:absolute; inset:0`, which both hides the control and
			spreads its hit target over the whole label. `sr-only` would say the hiding a second time and
			shrink that target to a pixel.

			The panel is a sibling of the strip rather than a child of it, because a `tablist` may contain
			only tabs.
		-->
		<div role="tablist" class="tabs tabs-box px-3" data-testid="annotation-inspector-tabs">
			<label id={TEXT_TAB_ID} class="tab" data-testid="annotation-inspector-tab-text">
				<input
					type="radio"
					role="tab"
					name="annotation-inspector-face"
					aria-selected={face === 'text'}
					aria-controls={FACE_ID}
					checked={face === 'text'}
					onchange={() => (face = 'text')}
				/>
				Text
			</label>
			<label id={STYLE_TAB_ID} class="tab" data-testid="annotation-inspector-tab-style">
				<input
					type="radio"
					role="tab"
					name="annotation-inspector-face"
					aria-selected={face === 'style'}
					aria-controls={FACE_ID}
					checked={face === 'style'}
					onchange={() => (face = 'style')}
				/>
				Style
			</label>
		</div>
	{/if}

	<!--
		The showing face. `role="tabpanel"` only where there is a strip: with one face there is nothing
		switching between anything, and a lone tabpanel would name a relationship that does not exist.

		`aria-labelledby` names the showing tab's `<label>` — the element the words are in — so the panel
		is announced as "Text" or "Style" without anything having to look through a radio for its name.
	-->
	<div
		id={FACE_ID}
		class="px-3 pb-3"
		role={style ? 'tabpanel' : undefined}
		aria-labelledby={style ? (face === 'style' ? STYLE_TAB_ID : TEXT_TAB_ID) : undefined}
		data-testid="annotation-inspector-face"
		data-face={style && face === 'style' ? 'style' : 'text'}
	>
		{#if style && face === 'style'}
			{@render style(annotation)}
		{:else}
			{@render text(annotation, index)}
		{/if}
	</div>
</section>
