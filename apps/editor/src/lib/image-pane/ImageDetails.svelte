<script module lang="ts">
	import type { ImagePane } from '@ballastella/core';

	export type ImageReadout = {
		readonly imageId: string;
		readonly pane: ImagePane;
		readonly mapZoom: number;
		readonly pointer?: { x: number; y: number };
	};
</script>

<script lang="ts">
	let { imageId, pane, mapZoom, pointer }: ImageReadout = $props();

	let showing = $state(false);

	const pixel = (point: { x: number; y: number }) =>
		`${Math.round(point.x)}, ${Math.round(point.y)}`;
</script>

<div>
	<button
		type="button"
		class="btn btn-outline btn-xs"
		aria-expanded={showing}
		aria-controls={showing ? 'map-image-details' : undefined}
		data-testid="map-image-details-toggle"
		onclick={() => (showing = !showing)}
	>
		{showing ? 'Hide image details' : 'Image details'}
	</button>

	{#if showing}
		<dl
			id="map-image-details"
			class="mt-2 grid gap-x-4 text-sm"
			data-testid="map-image-pyramid"
			data-image-id={imageId}
			data-width={pane.image.width}
			data-height={pane.image.height}
		>
			<dt class="font-medium">Pyramid</dt>
			<dd>
				{pane.image.width} × {pane.image.height} pixels, {pane.tileSize}-pixel tiles, scale factors
				{pane.image.tileZoomLevels.map((level) => level.scaleFactor).join(', ')}
			</dd>
			<dt class="font-medium">Zoom</dt>
			<dd>
				<span data-testid="map-image-zoom">{mapZoom.toFixed(4)}</span>
				of {pane.projection.fullResolutionMapZoom} at full resolution
			</dd>
			<dt class="font-medium">Pointer</dt>
			<dd data-testid="map-image-pointer">{pointer ? pixel(pointer) : '—'}</dd>
		</dl>
	{/if}
</div>
