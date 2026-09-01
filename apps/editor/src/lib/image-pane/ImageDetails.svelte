<script module lang="ts">
	import type { ImagePane } from '@ballastella/core';

	/**
	 * Everything the readout says, gathered by whoever is drawing the sheet.
	 *
	 * One object rather than four props so the pane reports it in one call, and so a screen cannot pair
	 * one pyramid's dimensions with another's zoom.
	 */
	export type ImageReadout = {
		/** The Map Image on screen — the readout's own claim about which pyramid this describes. */
		readonly imageId: string;
		readonly pane: ImagePane;
		readonly mapZoom: number;
		readonly pointer?: { x: number; y: number };
	};
</script>

<script lang="ts">
	// The geometry of the pyramid on screen, as text, behind a disclosure.
	//
	// It is genuinely useful — it is how a user tells two scans of the same sheet apart — and it is also
	// the only way a test can say *which* pyramid is being drawn, since a pyramid read out of OPFS issues
	// no request to observe. What it is not is something a scholar placing Control Points needs under the
	// sheet: it lives in the alignment screen's sidebar, with the rest of what is true about the work
	// rather than about the gesture.
	//
	// **Closed by default, and not persisted** — the same contract "Check this alignment" has, for the
	// same ADR-0002 reason: which readouts are open is a working view.
	//
	// **A `<button aria-expanded>` and not `<details>`.** ADR-0016 bans the `<details>` dropdown, and
	// every other disclosure on this screen is this shape.
	//
	// **Conditionally rendered rather than CSS-hidden**, so it is absent from the accessibility tree too
	// and the readout a test reads is one a user could also be looking at. The e2e suites that assert the
	// pyramid open it first, through `showPaneDetails`.

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
