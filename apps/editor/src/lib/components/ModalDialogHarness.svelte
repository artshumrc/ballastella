<script lang="ts">
	import ModalDialog from './ModalDialog.svelte';

	let { open = $bindable(false), vanishing = false }: { open?: boolean; vanishing?: boolean } =
		$props();

	let fallback = $state<HTMLElement | undefined>();
</script>

{#if !(vanishing && open)}
	<button type="button" data-testid="opener" onclick={() => (open = true)}>Open it</button>
{/if}

<p tabindex="-1" bind:this={fallback} data-testid="fallback">It happened.</p>

<ModalDialog bind:open title="A question" restoreFocusTo={() => fallback}>
	<p>Something to decide.</p>
	{#snippet actions()}
		<button type="button" data-testid="close" onclick={() => (open = false)}>Close</button>
	{/snippet}
</ModalDialog>
