<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		value = $bindable(''),
		testid,
		class: className = '',
		children
	}: { value?: string; testid: string; class?: string; children?: Snippet } = $props();

	const id = $props.id();
</script>

<div class="flex flex-col gap-1 {className}">
	<label class="text-sm font-medium" for={id}>Personal access token</label>
	<input
		{id}
		class="input w-full max-w-md input-sm"
		type="password"
		bind:value
		data-testid={testid}
		autocomplete="off"
		spellcheck="false"
	/>
	{@render children?.()}
</div>
