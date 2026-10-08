<script lang="ts">
	import { moveLayer, type Layer, type MapLayer } from '@ballastella/core';
	import type { DrawnOutcome } from '@ballastella/core/render';

	import LayerList from './LayerList.svelte';

	let {
		layers: initial,
		outcomes = {},
		openLayerId: initialOpen = null,
		onmove
	}: {
		layers: readonly Layer[];
		outcomes?: Readonly<Record<string, DrawnOutcome>>;
		openLayerId?: string | null;
		onmove?: (id: string, toIndex: number) => void;
	} = $props();

	let layers = $state([...initial]);
	let openLayerId = $state(initialOpen);
	export const order = (): string[] => layers.map((layer) => layer.id);
</script>

{#snippet problemAction(layer: Layer)}
	<span data-testid="harness-problem-action" data-layer-id={layer.id}></span>
{/snippet}

{#snippet mapContents(layer: MapLayer)}
	<span data-testid="harness-map-contents" data-layer-id={layer.id}></span>
{/snippet}

{#snippet annotationContents()}
	<span data-testid="harness-annotation-contents"></span>
{/snippet}

<LayerList
	{problemAction}
	{mapContents}
	{annotationContents}
	{layers}
	{outcomes}
	{openLayerId}
	onopen={(id) => (openLayerId = id)}
	ontypename={() => {}}
	oncommit={() => {}}
	onshow={() => {}}
	ondragopacity={() => {}}
	onmove={(id, toIndex) => {
		onmove?.(id, toIndex);
		layers = [...moveLayer(layers, id, toIndex)];
	}}
	ondelete={(id) => (layers = layers.filter((layer) => layer.id !== id))}
/>
