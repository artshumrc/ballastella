<script lang="ts">
	import type { Annotation, AnnotationGeometry } from '@ballastella/core';
	import { AnnotationInspector } from '@ballastella/ui';
	import { untrack } from 'svelte';

	import AnnotationTextFace from './AnnotationTextFace.svelte';

	let {
		id = 'a-1',
		index = 0,
		geometry,
		properties: initialProperties = {},
		titling = false,
		ontext,
		ontitled,
		oncommit,
		ondelete,
		count = 1,
		moveTargets = [],
		onmove,
		onmovetolayer
	}: {
		id?: string;
		index?: number;
		geometry: AnnotationGeometry;
		properties?: Record<string, unknown>;
		titling?: boolean;
		ontext?: (typed: { title?: string; description?: string }) => void;
		ontitled?: () => void;
		oncommit?: () => void;
		ondelete?: () => void;
		count?: number;
		moveTargets?: readonly { id: string; name: string }[];
		onmove?: (toIndex: number) => void;
		onmovetolayer?: (layerId: string) => void;
	} = $props();

	let properties = $state<Record<string, unknown>>(untrack(() => ({ ...initialProperties })));
	const annotation = $derived({ id, geometry, properties: { ...properties } } as Annotation);
</script>

{#snippet text(shown: Annotation)}
	<AnnotationTextFace
		annotation={shown}
		{titling}
		ontext={(typed) => {
			ontext?.(typed);
			properties = { ...properties, ...typed };
		}}
		ontitled={() => ontitled?.()}
		oncommit={() => oncommit?.()}
		ondelete={() => ondelete?.()}
		{index}
		{count}
		{moveTargets}
		onmove={(toIndex) => onmove?.(toIndex)}
		onmovetolayer={(layerId) => onmovetolayer?.(layerId)}
	/>
{/snippet}

<AnnotationInspector {annotation} {index} {text} onclose={() => {}} />
