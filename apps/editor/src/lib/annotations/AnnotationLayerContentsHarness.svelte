<script lang="ts">
	import type { AnnotationCollection } from '@ballastella/core';
	import { untrack } from 'svelte';

	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte';

	import AnnotationLayerContents from './AnnotationLayerContents.svelte';
	import { AnnotationDrawing, type AnnotationTool } from './drawing.svelte';

	let {
		collection,
		selectedId: initialSelectedId = null,
		tool = 'select',
		onselect
	}: {
		collection: AnnotationCollection | null;
		selectedId?: string | null;
		tool?: AnnotationTool;
		onselect?: (id: string | null) => void;
	} = $props();

	let selectedId = $state(untrack(() => initialSelectedId));
	const drawing = new AnnotationDrawing();
	drawing.choose(untrack(() => tool));

	provideInstalledApp();
</script>

<AnnotationLayerContents
	{collection}
	{selectedId}
	{drawing}
	onplace={() => {}}
	onfinish={() => drawing.finish()}
	onselect={(id) => {
		onselect?.(id);
		selectedId = id;
	}}
	onmove={() => {}}
/>
