<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		shape,
		text,
		heading,
		variant = 'warning',
		testid,
		class: noticeClass,
		children
	}: {
		shape: 'comes-and-goes' | 'always-present';
		text?: string | null;
		heading?: string;
		variant?: 'warning' | 'info' | 'plain';
		testid?: string;
		class?: string;
		children?: Snippet;
	} = $props();

	const something = $derived(children !== undefined || (text ?? '') !== '');
</script>

{#if shape === 'always-present' || something}
	<div
		role={shape === 'comes-and-goes' ? 'alert' : undefined}
		aria-live={shape === 'always-present' ? 'polite' : undefined}
		aria-atomic={shape === 'always-present' ? 'true' : undefined}
		class={[
			variant === 'warning' && 'alert flex-col items-start alert-warning',
			variant === 'info' && 'alert flex-col items-start alert-info',
			noticeClass
		]}
		data-testid={testid}
	>
		{#if heading}<h2 class="font-semibold">{heading}</h2>{/if}
		{#if children}{@render children()}{:else}<p>{text ?? ''}</p>{/if}
	</div>
{/if}
