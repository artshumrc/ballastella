<script lang="ts">
	import { moveAnnotation, type Annotation } from '@ballastella/core';
	import { untrack } from 'svelte';

	import AnnotationList from './AnnotationList.svelte';

	let {
		annotations,
		openId: initialOpenId = null,
		withTools = false,
		withGuidance = false,
		withMoving = false,
		onopen
	}: {
		annotations: readonly Annotation[] | null;
		openId?: string | null;
		withTools?: boolean;
		withGuidance?: boolean;
		withMoving?: boolean;
		onopen?: (id: string | null) => void;
	} = $props();

	let openId = $state(untrack(() => initialOpenId));
	let shown = $state.raw(untrack(() => annotations));

	export const show = (next: readonly Annotation[] | null): void => {
		shown = next;
	};
</script>

{#snippet tools()}
	<div data-testid="harness-annotation-tools">Draw</div>
{/snippet}

{#snippet noAnnotationsGuidance()}
	<span data-testid="harness-annotation-guidance">Nothing in this Layer yet. Draw one.</span>
{/snippet}

<AnnotationList
	annotations={shown}
	{openId}
	onopen={(id) => {
		onopen?.(id);
		openId = id;
	}}
	{...withTools ? { tools } : {}}
	{...withGuidance ? { noAnnotationsGuidance } : {}}
	{...withMoving
		? {
				onmove: (id: string, toIndex: number) => {
					shown = moveAnnotation({ annotations: shown ?? [] }, id, toIndex).annotations;
				}
			}
		: {}}
/>
