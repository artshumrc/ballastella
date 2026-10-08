<script lang="ts">
	import { type AnnotationCollection, type Place } from '@ballastella/core';
	import { AnnotationList } from '@ballastella/ui';

	import PlaceSearch from '$lib/places/PlaceSearch.svelte';

	import AnnotationTools from './AnnotationTools.svelte';
	import type { AnnotationDrawing } from './drawing.svelte';

	let {
		collection,
		selectedId,
		drawing,
		onplace,
		onfinish,
		onselect,
		onmove
	}: {
		collection: AnnotationCollection | null;
		selectedId: string | null;
		drawing: AnnotationDrawing;
		onplace: (place: Place, query: string) => void;
		onfinish: () => void;
		onselect: (id: string | null) => void;
		onmove: (id: string, toIndex: number) => void;
	} = $props();
</script>

{#snippet tools()}
	<AnnotationTools
		tool={drawing.tool}
		picking={drawing.picking}
		status={drawing.status}
		drawing={drawing.drawing}
		canFinish={drawing.canFinish}
		onnew={() => {
			drawing.offerShapes();
			onselect(null);
		}}
		onchoose={(tool) => drawing.choose(tool)}
		{onfinish}
		oncancel={() => drawing.cancel()}
		onundovertex={() => drawing.undoVertex()}
	/>

	<PlaceSearch
		testid="annotation-place-search"
		label="Find a place and pin it"
		onchoose={onplace}
	/>
{/snippet}

{#snippet noAnnotationsGuidance()}
	Nothing in this Layer yet. Press <strong>New Annotation</strong> and draw one on the map.
{/snippet}

<AnnotationList
	annotations={collection?.annotations ?? []}
	openId={selectedId}
	onopen={onselect}
	{onmove}
	{tools}
	{noAnnotationsGuidance}
/>
