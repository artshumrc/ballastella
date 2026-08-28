<script lang="ts">
	// The map's running commentary: what is drawn on it, and where it is looking.
	//
	// **Announced, not drawn.** Every sentence here is for a screen reader — a sighted user reads the
	// same facts off the map itself — so on screen these lines were restatement taking room the Base
	// Map wants. `sr-only` rather than deletion, because the announcements are the whole reason they
	// were written, and a WebGL canvas says nothing about what it is showing.
	//
	// **Both lines are always rendered, and that is the mechanism rather than a layout choice.** An
	// `aria-live` region is announced when its text *changes*, so a region that appears with its text
	// already in it announces nothing; `MapNotice`'s header carries the full argument and the same
	// rule. `role="status"` is unavailable — the save indicator owns it for the whole editor — and an
	// `alert` would interrupt a Reader every time they hid a Layer.
	//
	// The `data-` attributes are not decoration: they are the only machine-checkable statement of what
	// the map is showing, and the browser suites wait on them rather than on the sentences.

	import { openingViewSentence, type OpeningViewOutcome } from '@ballastella/core';
	import type { Snippet } from 'svelte';

	let {
		layerCount,
		drawnCount,
		emptyStackNote,
		openingOutcome,
		refitted = false,
		children
	}: {
		/** How many Layers the Project has. */
		layerCount: number;
		/** How many of them are on the map. */
		drawnCount: number;
		/**
		 * What this consumer's user is told when the Project has no Layers at all.
		 *
		 * An empty stack means two different things to the two users — the editor's sentence invites
		 * adding something and a Reader has nothing to add — so the wording is each app's own. A
		 * snippet for the same reason `LayerList` takes `noLayersGuidance` as one: prose about a
		 * consumer's own screen belongs in the markup that renders it.
		 */
		emptyStackNote: Snippet;
		/** What the opening view settled on. Also published as `data-opening-view`. */
		openingOutcome: OpeningViewOutcome;
		/** Whether the framing was asked for rather than automatic. */
		refitted?: boolean;
		/**
		 * Anything else this consumer announces from beside the map.
		 *
		 * The editor adds whether the Project works with no network and what a copy finished doing:
		 * making an offline copy is one button away there and nowhere at all for a Reader, so it is a
		 * fact the one user who can act on it is told and the other is not.
		 */
		children?: Snippet;
	} = $props();
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
