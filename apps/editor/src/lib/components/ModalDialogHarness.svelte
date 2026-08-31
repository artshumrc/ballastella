<script lang="ts">
	import ModalDialog from './ModalDialog.svelte';

	/**
	 * The three shapes a dialog's opener can be in by the time the dialog closes.
	 *
	 * A harness rather than one of the real surfaces, because focus restoration is `ModalDialog`'s
	 * and every dialog in the application inherits it — asserting it once here is what keeps the
	 * claim from being re-derived, slightly differently, per surface.
	 */
	let {
		open = $bindable(false),
		/** Whether opening the dialog unmounts the control that opened it, as opening a bundle does. */
		vanishing = false
	}: { open?: boolean; vanishing?: boolean } = $props();

	let fallback = $state<HTMLElement | undefined>();
</script>

{#if !(vanishing && open)}
	<button type="button" data-testid="opener" onclick={() => (open = true)}>Open it</button>
{/if}

<!-- Where the news of what just happened is, which is where focus goes when the opener has gone. -->
<p tabindex="-1" bind:this={fallback} data-testid="fallback">It happened.</p>

<ModalDialog bind:open title="A question" restoreFocusTo={() => fallback}>
	<p>Something to decide.</p>
	{#snippet actions()}
		<button type="button" data-testid="close" onclick={() => (open = false)}>Close</button>
	{/snippet}
</ModalDialog>
