<script lang="ts">
	import type { Snippet } from 'svelte';

	import ModalDialog from './ModalDialog.svelte';

	let {
		open = $bindable(false),
		title,
		confirm,
		confirmClass = 'btn-error',
		cancel = 'Cancel',
		testid,
		onconfirm,
		children
	}: {
		open?: boolean;
		title: string;
		confirm: string;
		confirmClass?: string;
		cancel?: string;
		testid?: string;
		onconfirm: () => unknown;
		children: Snippet;
	} = $props();
</script>

<ModalDialog bind:open {title}>
	{@render children()}
	{#snippet actions()}
		<button type="button" class="btn" onclick={() => (open = false)}>{cancel}</button>
		<button
			type="button"
			class="btn {confirmClass}"
			data-testid={testid}
			onclick={() => void onconfirm()}
		>
			{confirm}
		</button>
	{/snippet}
</ModalDialog>
