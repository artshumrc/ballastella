<script lang="ts">
	// The Annotations inside one Annotation Layer, each in a row that opens on itself.
	//
	// Rendered inside that Layer's own open card, which is what lets the list carry fixed ids and a
	// fixed accessible name: only one card is open at a time, so exactly one of these is on screen.
	//
	// **The list owns the mechanics and the consumer owns the contents.** Expansion, one row at a time,
	// `aria-expanded`, the animation, where the keyboard stays and bringing an opened row back into the
	// column are the same wherever an Annotation is met, and they exist once — in `AnnotationRow`.
	// What an open row *reveals* differs by app and arrives as a snippet: the editor passes its
	// Annotation editor, a published site passes the title and the rendered description.
	//
	// ⚠ **`tools` is the drawing surface and the place search, and a published site passes neither.**
	// Not because they would be harmless there — a place search issues a lookup to a third-party
	// service, and a Published Site quietly doing that for a Reader who asked for nothing is the
	// outcome ADR-0029 is written against. They are a snippet rather than a flag for the reason the
	// whole package follows: a control the viewer must not have is a prop the viewer does not pass.

	import type { Annotation } from '@ballastella/core';
	import type { Snippet } from 'svelte';

	import AnnotationRow from './AnnotationRow.svelte';

	let {
		annotations,
		openId,
		onopen,
		contents,
		tools
	}: {
		annotations: readonly Annotation[];
		/** The open row, which is the selected Annotation — one fact, so one value. */
		openId: string | null;
		onopen: (id: string | null) => void;
		/** What an open row reveals, given the Annotation it belongs to. */
		contents?: Snippet<[Annotation]>;
		/** Whatever this consumer offers above the list. Editor only; a Reader is offered none of it. */
		tools?: Snippet;
	} = $props();
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

	{#if annotations.length === 0}
		<p class="text-sm opacity-70" data-testid="annotation-list-empty">Nothing in this Layer yet.</p>
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
		<div class="overflow-hidden rounded-lg border border-base-300">
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
					<AnnotationRow {annotation} {index} open={annotation.id === openId} {onopen} {contents} />
				{/each}
			</ol>
		</div>
	{/if}
</section>
