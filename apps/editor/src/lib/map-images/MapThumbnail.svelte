<script lang="ts">
	import MapGlyph from '@lucide/svelte/icons/map';
	import type { FetchFn, WorkspaceMapImage } from '@ballastella/core';

	let {
		map,
		fetchTile,
		size = 96
	}: {
		map: WorkspaceMapImage;
		fetchTile: FetchFn;
		size?: number;
	} = $props();

	let picture = $state<string | null>(null);
	const url = $derived(map.thumbnail);
	const tiles = $derived(map.tiles);
	let failedSource = $state<string | null>(null);
	const source = $derived(tiles === 'referenced' ? url : picture);
	const shown = $derived(source !== null && source !== failedSource ? source : null);

	$effect(() => {
		if (url === null || tiles !== 'in-workspace') return;
		let unmounted = false;
		let created: string | null = null;

		void (async () => {
			const response = await fetchTile(url);
			if (!response.ok) return;
			const blob = await response.blob();
			if (unmounted) return;
			created = URL.createObjectURL(blob);
			picture = created;
		})().catch(() => undefined);

		return () => {
			unmounted = true;
			if (created !== null) URL.revokeObjectURL(created);
			picture = null;
		};
	});
</script>

<div
	class="flex shrink-0 items-center justify-center overflow-hidden"
	style="width: {size}px; height: {size}px"
>
	{#if shown === null}
		<MapGlyph {size} class="opacity-30" aria-hidden="true" data-testid="map-thumbnail-glyph" />
	{:else}
		<img
			src={shown}
			alt=""
			width={size}
			height={size}
			loading={tiles === 'referenced' ? 'lazy' : undefined}
			class="max-h-full max-w-full object-contain"
			data-testid="map-thumbnail-image"
			onerror={() => (failedSource = shown)}
		/>
	{/if}
</div>
