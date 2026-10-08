<script lang="ts">
	import {
		isDescriptionRendererSupported,
		renderDescription,
		type Annotation
	} from '@ballastella/core';
	import { onMount } from 'svelte';

	let { annotation }: { annotation: Annotation } = $props();

	const properties = $derived(annotation.properties);

	/** Both apps prerender and DOMPurify needs a DOM, so the renderer refuses in Node rather than degrading to returning its input unsanitised — the safe direction, since a fallback would write an XSS… */
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	const rendered = $derived(
		mounted && properties.description && isDescriptionRendererSupported()
			? renderDescription(properties.description)
			: ''
	);
</script>

<!-- **A `<section>` rather than a `<div>`, because `aria-label` on a bare `<div>` names nothing.** A `<div>` has the implicit `generic` role, for which ARIA 1.2 prohibits `aria-label` and which browsers… -->
<section
	class="prose-sm prose max-w-none"
	data-testid="annotation-description-text"
	aria-label="Description"
>
	{#if rendered === ''}
		<p class="text-sm opacity-60">No description.</p>
	{:else}
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		{@html rendered}
	{/if}
</section>
