<script lang="ts">
	import type { Annotation } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationInspector from './AnnotationInspector.svelte';

	let {
		annotation,
		index,
		withStyle = false,
		onclose
	}: {
		annotation: Annotation;
		index: number;
		withStyle?: boolean;
		onclose?: () => void;
	} = $props();

	let shown = $state.raw(untrack(() => annotation));

	export const show = (next: Annotation): void => {
		shown = next;
	};
</script>

{#snippet text(annotation: Annotation)}
	<div data-testid="harness-inspector-text" data-annotation-id={annotation.id}>Text face</div>
{/snippet}

{#snippet style(annotation: Annotation)}
	<div data-testid="harness-inspector-style" data-annotation-id={annotation.id}>Style face</div>
{/snippet}

<AnnotationInspector
	annotation={shown}
	{index}
	{text}
	onclose={() => onclose?.()}
	{...withStyle ? { style } : {}}
/>
