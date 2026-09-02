<script lang="ts">
	// A development surface for the image pane, over a committed fixture pyramid.
	//
	// This is deliberately not a user-facing route: the pane here shows a fixture, not the
	// user's own Map Image. It exists so the synthetic projection can be exercised — and
	// asserted in a real browser — before the storage layer, the tiler, or Control Points
	// exist. `MapImagePane.svelte` puts the same pane over a Map Image read from the ProjectStore.

	import { asset } from '$app/paths';
	import { createImagePane, type ImagePane, type ResourcePoint } from '@ballastella/core';
	import { onMount } from 'svelte';

	import ImagePaneView, { type PaneOverlayPoint } from '$lib/image-pane/ImagePane.svelte';

	const PANE_ID = 'floride-1657';

	let pane: ImagePane | undefined = $state.raw();
	let failure: string | undefined = $state();
	let paneView: ReturnType<typeof ImagePaneView> | undefined = $state.raw();

	let mapZoom = $state(0);
	let pointer: ResourcePoint | undefined = $state();
	let reported: ResourcePoint | undefined = $state();
	let tilesLoaded = $state(false);
	let ready = $state(false);

	// Points whose image pixel is known in advance, so that the pane's drawing and its coordinate
	// reporting can be checked against each other. Not Control Points and not registration points
	// — CONTEXT.md rules out "register" for an Alignment and "marker" for a Control Point.
	const referencePoints: { point: ResourcePoint; label: string }[] = $derived(
		pane
			? [
					{ point: { x: 0, y: 0 }, label: 'top left' },
					{ point: { x: pane.image.width, y: 0 }, label: 'top right' },
					{ point: { x: 0, y: pane.image.height }, label: 'bottom left' },
					{ point: { x: pane.image.width, y: pane.image.height }, label: 'bottom right' },
					{ point: { x: pane.image.width / 2, y: pane.image.height / 2 }, label: 'centre' }
				]
			: []
	);

	const overlayPoints: PaneOverlayPoint[] = $derived([
		...referencePoints.map(({ point, label }): PaneOverlayPoint => ({
			point,
			label: `Reference point, ${label}: pixel ${point.x}, ${point.y}`,
			kind: 'reference'
		})),
		...(reported
			? [
					{
						point: reported,
						label: `Reported pixel ${Math.round(reported.x)}, ${Math.round(reported.y)}`,
						kind: 'reported' as const
					}
				]
			: [])
	]);

	const pixel = (point: ResourcePoint) => `${Math.round(point.x)}, ${Math.round(point.y)}`;

	const status = $derived(
		failure
			? failure
			: reported
				? `Image pixel ${pixel(reported)} reported.`
				: 'No image pixel reported yet. Click the map, or use the button below.'
	);

	onMount(async () => {
		// ADR-0004: `info.json` carries the unset.invalid placeholder id, and the base the tiles
		// are really served from is resolved here, at load time. `asset()` keeps that path
		// relative, because a site's address is unknown at build time.
		const infoUrl = new URL(asset('/fixtures/images/floride-1657/info.json'), location.href);

		try {
			const response = await fetch(infoUrl);

			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}`);
			}

			pane = createImagePane(await response.json(), infoUrl.href.replace(/\/info\.json$/, ''));
		} catch (error) {
			failure =
				`The fixture pyramid at ${infoUrl.href} could not be read: ` +
				`${error instanceof Error ? error.message : String(error)}`;
		}
	});
</script>

<svelte:head><title>Image pane — Ballastella Editor</title></svelte:head>

<main class="flex h-dvh flex-col gap-3 p-4">
	<header>
		<h1 class="text-2xl font-bold">Image pane</h1>
		<p class="text-sm">
			A committed fixture Map Image — Nicolas Sanson, <i>La Floride</i>, 1657 — shown unwarped in
			its own coordinate system. Pan and zoom it, and click anywhere to be told which image pixel is
			under the cursor.
		</p>
	</header>

	{#if failure}
		<p class="alert alert-error" role="alert">{failure}</p>
	{:else if pane}
		{@const projection = pane.projection}
		<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Image pane view">
			<button class="btn btn-sm" onclick={() => paneView?.fitImage()}>Fit whole map</button>
			<button class="btn btn-sm" onclick={() => paneView?.zoomToFullResolution(reported)}>
				Zoom to full resolution
			</button>
			<button class="btn btn-sm" onclick={() => paneView?.zoomBy(-1)}>Zoom out one level</button>
			<button class="btn btn-sm" onclick={() => paneView?.zoomBy(1)}>Zoom in one level</button>
			<button
				class="btn btn-primary btn-sm"
				onclick={() => (reported = paneView?.centreResourcePoint())}
			>
				Report the pixel at the centre of the view
			</button>
		</div>

		<div class="min-h-0 flex-1 overflow-hidden rounded-box border border-base-300">
			<ImagePaneView
				bind:this={paneView}
				{pane}
				paneId={PANE_ID}
				label="Map Image, unwarped, in image pixel coordinates"
				{overlayPoints}
				onclickpoint={(point) => (reported = point)}
				onview={(view) => {
					mapZoom = view.mapZoom;
					pointer = view.pointer;
					tilesLoaded = view.tilesLoaded;
				}}
				onready={() => (ready = true)}
			/>
		</div>

		<footer class="grid gap-1 text-sm sm:grid-cols-2">
			<p aria-live="polite" data-testid="pane-status">{status}</p>
			<p>
				<span class="font-semibold">Reported pixel:</span>
				<span
					data-testid="reported-pixel"
					data-x={reported ? reported.x : ''}
					data-y={reported ? reported.y : ''}>{reported ? pixel(reported) : '—'}</span
				>
			</p>
			<p>
				<span class="font-semibold">Pointer:</span>
				<span data-testid="pointer-pixel">{pointer ? pixel(pointer) : '—'}</span>
			</p>
			<p data-testid="pane-tiles" data-tiles-loaded={tilesLoaded}>
				<span class="font-semibold">Tiles:</span>
				{tilesLoaded ? 'all loaded for this view' : 'loading…'}
			</p>
			<p>
				<span class="font-semibold">Map zoom:</span>
				<span data-testid="map-zoom">{mapZoom.toFixed(4)}</span>
				of
				<span data-testid="full-resolution-zoom">{projection.fullResolutionMapZoom}</span>
				at full resolution
			</p>
			<p>
				<span class="font-semibold">Pyramid:</span>
				{pane.image.width} × {pane.image.height} pixels,
				{pane.tileSize}-pixel tiles, scale factors
				{pane.image.tileZoomLevels.map((level) => level.scaleFactor).join(', ')}
			</p>
			<p>
				<span class="font-semibold">Reference points:</span>
				{referencePoints.map(({ point, label }) => `${label} ${pixel(point)}`).join('; ')}
			</p>
			{#if ready}<p data-testid="pane-ready">Pane ready.</p>{/if}
		</footer>
	{:else}
		<p aria-live="polite">Reading the fixture pyramid…</p>
	{/if}
</main>
