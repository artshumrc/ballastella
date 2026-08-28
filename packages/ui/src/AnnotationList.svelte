<script lang="ts">
	// The Annotations inside one Annotation Layer, each in a row that selects it.
	//
	// Rendered inside that Layer's own open card, which is what lets the list carry fixed ids and a
	// fixed accessible name: only one card is open at a time, so exactly one of these is on screen.
	//
	// **This list answers membership and nothing else.** Which Annotations are in this Layer, in what
	// order, how many, and which one is chosen. An Annotation's content is read in the
	// `AnnotationInspector` docked over the map, in both apps, so no row opens a region and this
	// component forwards none (ADR-0035). What one row does — select, report, carry `aria-expanded` and
	// an `aria-controls` naming the Inspector — is `AnnotationRow`'s, once, for both apps.
	//
	// ⚠ **`tools` is the drawing surface and the place search, and a published site passes neither.**
	// Not because they would be harmless there — a place search issues a lookup to a third-party
	// service, and a Published Site quietly doing that for a Reader who asked for nothing is the
	// outcome ADR-0029 is written against. They are a snippet rather than a flag for the reason the
	// whole package follows: a control the viewer must not have is a prop the viewer does not pass.

	import type { Annotation } from '@ballastella/core';
	import type { Snippet } from 'svelte';

	import { annotationName } from './annotation-name.js';
	import AnnotationRow from './AnnotationRow.svelte';

	let {
		annotations,
		openId,
		onopen,
		onmove,
		tools,
		noAnnotationsGuidance
	}: {
		/**
		 * The Annotations in this Layer, or `null` where its collection has not been read.
		 *
		 * ⚠ **The two are not the same fact and an empty array must not stand in for both.** "This Layer
		 * has no Annotations in it" is a positive claim about a collection somebody has read; a Layer
		 * that is still loading, or whose GeoJSON would not parse, is a Layer nobody can say that about
		 * — and saying it anyway told a Reader that a Layer holding the scholar's work was empty, in the
		 * same card whose problem band said the file could not be read. So `null` says nothing at all,
		 * which is the only honest thing this component knows.
		 */
		annotations: readonly Annotation[] | null;
		/** The open row, which is the selected Annotation — one fact, so one value. */
		openId: string | null;
		onopen: (id: string | null) => void;
		/**
		 * Move an Annotation to a position in this collection — what a row dropped on a row asks for.
		 * Without it the rows carry no handle and accept no drop, which is what a published site gets:
		 * the order of a Layer's shapes is the author's decision, and a Reader is not offered it.
		 *
		 * ⚠ **This is the drag alone, and it is the convenience rather than the contract.** ADR-0016
		 * requires a keyboard path for a reorder, and it is not in this list: the row holds one button
		 * and nothing opens in it, so the Move buttons are in the Annotation Inspector, beside the
		 * Delete that acts on the same Annotation.
		 */
		onmove?: (id: string, toIndex: number) => void;
		/** Whatever this consumer offers above the list. Editor only; a Reader is offered none of it. */
		tools?: Snippet;
		/**
		 * What an empty Layer says beyond the bare fact that it is empty. Editor only.
		 *
		 * See the empty state below: guidance is instructions for controls the consumer renders, and a
		 * Reader has none of them.
		 */
		noAnnotationsGuidance?: Snippet;
	} = $props();

	/**
	 * The Annotation being dragged and the row a drop would land on, both `''` for neither.
	 *
	 * Held here rather than in a row because both are facts about the list: exactly one row is being
	 * dragged and exactly one is the target, and a row holding its own copy of either would be a
	 * second answer to a question the list has already answered.
	 */
	let dragging = $state('');
	let over = $state('');

	/**
	 * What the last reorder did, announced.
	 *
	 * A move changes nothing that has focus and nothing that is visible near the pointer, so without
	 * this a screen-reader user presses "Move up" and is told nothing at all. `aria-live` rather than
	 * `role="status"`, because the save indicator already owns that role on this page — the same
	 * reasoning, and the same shape, as the Layer stack's own announcement one level up.
	 */
	let moved = $state('');

	/**
	 * Report the move and say what it did.
	 *
	 * The position announced is the one that was *asked for*, clamped to the collection, rather than
	 * one read back afterwards: the consumer owns the collection and hands it back as a prop, so
	 * reading the new position here would mean announcing whatever had arrived by the time this ran.
	 */
	const move = (id: string, toIndex: number): void => {
		const list = annotations ?? [];
		const from = list.findIndex((annotation) => annotation.id === id);
		const annotation = list[from];
		if (!onmove || !annotation) return;
		const to = Math.min(list.length - 1, Math.max(0, toIndex));
		onmove(id, toIndex);
		moved = `${annotationName(annotation, from)} moved to ${to + 1} of ${list.length}`;
	};
</script>

<!--
	Named by `aria-label` rather than by a heading of its own. The card this renders inside already
	says "Annotations" in its header — the one line that stays visible when the card is collapsed — so
	a `<h3>` here put the same word on the screen twice, a few pixels apart, saying nothing the first
	one had not. The name still reaches assistive technology, which is what the heading was carrying;
	only the duplicated pixels went.
-->
<section aria-label="Annotations" class="flex flex-col gap-3">
	{@render tools?.()}

	<!--
		Where the last Annotation went, for somebody who cannot see it travel. Always rendered, because a
		live region is announced when its text *changes* rather than when the element carrying it is
		inserted.
	-->
	<p class="sr-only" aria-live="polite" aria-atomic="true" data-testid="annotation-move-status">
		{moved}
	</p>

	{#if annotations === null}
		<!--
			A collection nobody has read yet, and therefore nothing said about what is in it. The card
			around this one is where a Layer that could not be read says so; a list that has been handed
			no Annotations knows only that it has been handed none.
		-->
	{:else if annotations.length === 0}
		<!--
			The empty state. **What it says beyond "there is nothing here" is the consumer's**, which is
			the shape `LayerList`'s own empty state already takes one level up: guidance is instructions
			for using the controls that consumer renders, and a Reader has none of them. On a Published
			Site nothing will ever be put in this Layer, so an editor's "yet" promises a Reader something
			that cannot happen. Without the snippet this is the fact and nothing else, which is the
			sentence that is true in both apps.
		-->
		<p class="text-sm opacity-70" data-testid="annotation-list-empty">
			{#if noAnnotationsGuidance}
				{@render noAnnotationsGuidance()}
			{:else}
				This Layer has no Annotations in it.
			{/if}
		</p>
	{:else}
		<!--
			**Outlined, headed and divided, because it did not read as a list.** Ghost buttons in a gap-1
			column are the shape a toolbar has: nothing said where the Annotations began, where they
			ended, or that the rows were siblings rather than four unrelated controls stacked in a
			sidebar. The box draws the edge, the caption says what is inside it and how many, and the
			hairlines between rows are what make them read as items of one thing.

			daisyUI's own `menu`, which is the component for a list of choices — ADR-0016 mandates no
			method for a list, and reaching for `menu` rather than restyling `btn` keeps the hover, focus
			and active states the theme already defines. Still an `<ol>`, so the structure reaches
			assistive technology from the markup rather than from the class; still a `<button>` per row,
			carrying `aria-expanded` — ADR-0016's shape for a disclosure — and what makes the list
			operable by keyboard with nothing added.
		-->
		<div class="overflow-hidden rounded-box border border-base-300">
			<p
				class="border-b border-base-300 bg-base-200 px-3 py-1 text-[0.65rem] font-semibold uppercase opacity-70"
				id="annotation-list-caption"
			>
				{annotations.length}
				{annotations.length === 1 ? 'Annotation' : 'Annotations'}
			</p>

			<ol
				class="menu w-full gap-0 menu-sm p-0"
				aria-labelledby="annotation-list-caption"
				data-testid="annotation-list"
			>
				{#each annotations as annotation, index (annotation.id)}
					<AnnotationRow
						{annotation}
						{index}
						open={annotation.id === openId}
						{onopen}
						bind:dragging
						bind:over
						{...onmove ? { onmove: move } : {}}
					/>
				{/each}
			</ol>
		</div>
	{/if}
</section>
