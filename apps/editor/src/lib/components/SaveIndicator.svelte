<script lang="ts">
	import type { SaveState } from '@ballastella/core';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	/**
	 * The save state, shown (ADR-0017 rule 5).
	 *
	 * There is no Save button, so this is the user's only signal that the tool has their work,
	 * and scholars working on material they care about will not trust a tool that offers none.
	 * An `aria-live` region rather than a tooltip, because a daisyUI tooltip renders through CSS
	 * `::before` and is never announced (ADR-0016).
	 */
	// Not named `state`: a local binding by that name turns every `$state` in this file into a
	// store subscription.
	let { saveState }: { saveState: SaveState } = $props();

	/**
	 * "Saving" is often over in a few milliseconds, especially in OPFS. Shown for less than this
	 * it is a strobe rather than information — and an indicator that flickers is worse than one
	 * that lingers, since the thing it has to convey is reassurance.
	 */
	const MINIMUM_SAVING_MS = 400;

	/**
	 * ⚠ **"Saved locally", not "Saved"** (ADR-0032). Since publishing means *send this Workspace to
	 * its Remote*, the bare word conflated the two facts a scholar most needs kept apart: their edit
	 * is safe on this machine the moment they make it, and it is on the web only when they press
	 * Publish. The word is next to that button, so it has to say which of the two it means.
	 *
	 * The other two are unchanged: there is nowhere else for an unsaved edit to be.
	 */
	const LABELS: Record<SaveState, string> = {
		saved: 'Saved locally',
		saving: 'Saving…',
		unsaved: 'Unsaved changes'
	};

	let shown = $state<SaveState>('saved');
	let savingSince = 0;

	$effect(() => {
		const next = saveState;
		if (next === 'saving') {
			savingSince = Date.now();
			shown = 'saving';
			return;
		}
		const remaining = MINIMUM_SAVING_MS - (Date.now() - savingSince);
		if (remaining <= 0) {
			shown = next;
			return;
		}
		const timer = setTimeout(() => {
			shown = next;
		}, remaining);
		return () => clearTimeout(timer);
	});
</script>

<p
	role="status"
	data-save-state={shown}
	class="badge gap-1.5 badge-sm font-medium whitespace-nowrap shadow-sm"
	class:badge-success={shown === 'saved'}
	class:badge-warning={shown !== 'saved'}
>
	{#if shown === 'saved'}
		<span class="saved-mark" aria-hidden="true">
			<CircleCheck class="size-3.5" />
		</span>
	{:else if shown === 'saving'}
		<span class="loading loading-xs loading-spinner" aria-hidden="true"></span>
	{:else}
		<TriangleAlert class="size-3.5" aria-hidden="true" />
	{/if}
	{LABELS[shown]}
</p>

<style>
	.saved-mark {
		animation: saved-confirmation 300ms ease-out;
	}

	@keyframes saved-confirmation {
		0% {
			transform: scale(0.6);
		}
		60% {
			transform: scale(1.2);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.saved-mark {
			animation: none;
		}
	}
</style>
