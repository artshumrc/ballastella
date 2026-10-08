<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		text = '',
		heading = '',
		testid,
		tone = 'warning',
		role = 'alert',
		class: className = '',
		children
	}: {
		text?: string | null;
		heading?: string;
		testid?: string;
		tone?: 'warning' | 'error' | 'info';
		role?: 'alert' | 'status';
		class?: string;
		children?: Snippet;
	} = $props();

	const TONE = { warning: 'alert-warning', error: 'alert-error', info: 'alert-info' };
</script>

{#if text || children}
	<div
		{role}
		class="alert flex-col items-start {TONE[tone]} {className}"
		data-testid={text ? undefined : testid}
	>
		{#if heading}<h2 class="font-semibold">{heading}</h2>{/if}
		{#if text}<p data-testid={testid}>{text}</p>{/if}
		{@render children?.()}
	</div>
{/if}
