<script lang="ts">
	// One of the user's own Historical Maps, deep-zoomable, read entirely out of their Project.
	//
	// SPEC story 31. Ticket 03 built this pane over a committed fixture served by HTTP, which is
	// what let the synthetic projection be attacked before any storage existed; what this component
	// adds is the other half of ADR-0011 — the `info.json` and every tile come from the
	// `ProjectStore` through the injection shim, so there is no URL involved anywhere and the pane
	// works with no network at all (story 8).
	//
	// The pyramid is loaded here rather than by the page, because which pyramid is on screen is a
	// question with a *load* behind it: switching Historical Maps replaces the pane, and a read that
	// resolves after the user has already moved on must not be allowed to draw the wrong map.

	import {
		createImagePane,
		imageServiceId,
		type FetchFn,
		type ImagePane,
		type ResourcePoint
	} from '@ballastella/core';

	import ImagePaneView, { type PaneOverlayPoint } from './ImagePane.svelte';

	let {
		imageId,
		fetchTile,
		label,
		overlayPoints = [],
		maskRing = [],
		onclickpoint,
		onpane
	}: {
		/** Which Historical Map of the open Project to show. */
		imageId: string;
		/** The ADR-0011 shim for the open Project. */
		fetchTile: FetchFn;
		/** Accessible name for the map region, from the page. */
		label: string;
		/** Control Points' image halves, and the pending half when it is on this pane (ticket 07). */
		overlayPoints?: PaneOverlayPoint[];
		/** The Alignment's Resource Mask, in image pixels. This pane only: the mask has no meaning on
		 * the Base Map, which speaks lng/lat (ticket 08's out-of-scope note). */
		maskRing?: readonly ResourcePoint[];
		/** An image pixel the user clicked, which is how a Control Point is started (ADR-0022). */
		onclickpoint?: (point: ResourcePoint) => void;
		/**
		 * The pyramid, once it has been read.
		 *
		 * Reported rather than loaded twice. Everything above this component that needs the image's
		 * pixel dimensions — the Alignment's Resource Mask, the Control Point coordinate space — needs
		 * exactly what this pane is drawing, and a second `createImagePane` on the same `info.json`
		 * would be a second answer that can disagree.
		 */
		onpane?: (pane: ImagePane) => void;
	} = $props();

	let pane: ImagePane | undefined = $state.raw();
	let shownImageId = $state('');
	let failure = $state('');
	let paneView: ReturnType<typeof ImagePaneView> | undefined = $state.raw();
	let tilesLoaded = $state(false);
	let mapZoom = $state(0);
	let pointer = $state<{ x: number; y: number } | undefined>();

	/**
	 * Bumped by every load, so a read that resolves late knows it has been superseded. The same
	 * guard `EditorSession.open` needs and for the same reason: reading a pyramid is asynchronous,
	 * and the user can pick another one while it is in flight.
	 */
	let generation = 0;

	$effect(() => {
		const wanted = imageId;
		const mine = ++generation;

		// Cleared straight away: a stale pane on screen under a new map's name is a coordinate
		// claim about the wrong image, which is the one failure this pane must never have.
		pane = undefined;
		shownImageId = '';
		failure = '';
		tilesLoaded = false;

		void (async () => {
			try {
				// The `info.json` comes through the same shim as the tiles, so there is exactly one
				// way into a stored pyramid rather than one for the document and one for its bytes.
				const response = await fetchTile(`${imageServiceId(wanted)}/info.json`);

				if (!response.ok) {
					throw new Error(
						`the Project has no readable info.json for it (${response.status} ${response.statusText})`
					);
				}

				const built = createImagePane(await response.json(), { storedImageId: wanted });
				if (mine !== generation) return;
				pane = built;
				shownImageId = wanted;
				onpane?.(built);
			} catch (cause) {
				if (mine !== generation) return;
				// ADR-0008: a Historical Map that cannot be read is a normal state to render, not an
				// unhandled rejection. `createImagePane` refuses a pyramid whose shape would render
				// plausibly but wrongly, and that refusal explains itself — so it is shown, not
				// swallowed.
				failure = `“${wanted}” could not be opened: ${
					cause instanceof Error ? cause.message : String(cause)
				}`;
			}
		})();
	});

	const pixel = (point: { x: number; y: number }) =>
		`${Math.round(point.x)}, ${Math.round(point.y)}`;
</script>

{#if failure}
	<div role="alert" class="alert max-w-prose alert-warning" data-testid="historical-map-failure">
		<p>{failure}</p>
	</div>
{:else if pane}
	{@const projection = pane.projection}
	<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Historical Map view">
		<button class="btn btn-sm" onclick={() => paneView?.fitImage()}>Fit whole map</button>
		<button class="btn btn-sm" onclick={() => paneView?.zoomToFullResolution()}>
			Zoom to full resolution
		</button>
		<button class="btn btn-sm" onclick={() => paneView?.zoomBy(-1)}>Zoom out one level</button>
		<button class="btn btn-sm" onclick={() => paneView?.zoomBy(1)}>Zoom in one level</button>
	</div>

	<div class="mt-3 h-96 overflow-hidden rounded border border-base-300">
		<!--
			Keyed on the image, so switching Historical Maps builds a new map rather than repointing
			the old one. The tile protocol's registry is populated in `onMount`, and MapLibre's own
			tile cache is keyed by URL under a source that would not have changed — a repointed pane
			would draw the previous pyramid's cached tiles under the new map's coordinates.
		-->
		{#key shownImageId}
			<ImagePaneView
				bind:this={paneView}
				{pane}
				paneId={shownImageId}
				{fetchTile}
				{label}
				{overlayPoints}
				{maskRing}
				{onclickpoint}
				onview={(view) => {
					mapZoom = view.mapZoom;
					pointer = view.pointer;
					tilesLoaded = view.tilesLoaded;
				}}
			/>
		{/key}
	</div>

	<!--
		The geometry of the pyramid on screen, as text. It is genuinely useful — it is how a user
		tells two scans of the same sheet apart — and it is also the only way a test can say *which*
		pyramid is being drawn, since a pyramid read out of OPFS issues no request to observe.
	-->
	<dl
		class="mt-3 grid gap-x-4 text-sm sm:grid-cols-2"
		data-testid="historical-map-pyramid"
		data-image-id={shownImageId}
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
			<span data-testid="historical-map-zoom">{mapZoom.toFixed(4)}</span>
			of {projection.fullResolutionMapZoom} at full resolution
		</dd>
		<dt class="font-medium">Pointer</dt>
		<dd data-testid="historical-map-pointer">{pointer ? pixel(pointer) : '—'}</dd>
	</dl>

	<p
		class="mt-1 text-sm"
		aria-live="polite"
		data-testid="historical-map-tiles"
		data-tiles-loaded={tilesLoaded}
	>
		{tilesLoaded ? 'All tiles for this view have loaded.' : 'Loading tiles…'}
	</p>
{:else}
	<p aria-live="polite">Opening the Historical Map…</p>
{/if}
