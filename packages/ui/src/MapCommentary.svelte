<script lang="ts">
	// **Announced, not drawn.** Every sentence here is for a screen reader — a sighted user reads the

	import { openingViewSentence, type OpeningViewOutcome } from '@ballastella/core';
	import type { DrawnOutcome } from '@ballastella/core/render';
	import type { Snippet } from 'svelte';

	let {
		layerCount,
		outcomes,
		emptyStackNote,
		openingOutcome,
		refitted = false,
		children
	}: {
		layerCount: number;
		outcomes: Readonly<Record<string, DrawnOutcome>>;
		emptyStackNote: Snippet;
		/** What the opening view settled on. */
		openingOutcome: OpeningViewOutcome;
		refitted?: boolean;
		/** The editor adds whether the Project works with no network and what a copy finished doing: making an offline copy is one button away there and nowhere at all for a Reader, so it is a fact the one user… */
		children?: Snippet;
	} = $props();

	const drawnCount = $derived(
		Object.values(outcomes).filter((outcome) => outcome.status === 'drawn').length
	);
</script>

<div class="sr-only">
	<p
		class="min-h-6 text-sm"
		aria-live="polite"
		aria-atomic="true"
		data-testid="stack-status"
		data-drawn={drawnCount}
	>
		{#if layerCount === 0}
			{@render emptyStackNote()}
		{:else}
			{drawnCount} of {layerCount}
			{layerCount === 1 ? 'Layer is' : 'Layers are'} drawn over the Base Map.
		{/if}
	</p>
	<p
		class="min-h-6 text-sm text-base-content/70"
		aria-live="polite"
		aria-atomic="true"
		data-testid="opening-view"
		data-opening-view={openingOutcome}
	>
		{openingViewSentence(openingOutcome, refitted)}
	</p>
	{#if children}{@render children()}{/if}
</div>
