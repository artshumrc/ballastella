<script lang="ts">
	// A development surface for warped rendering's injection point, and nothing more.
	//
	// The same kind of route as `/image-pane`: not user-facing, and it exists so that one mechanism
	// can be exercised in a real browser before the feature that needs it is built. Here the
	// mechanism is `new WarpedMapLayer({ fetchFn })` — ADR-0011's injection point for
	// `@allmaps/maplibre` — added to a real MapLibre map with a real WebGL2 context.
	//
	// Nothing is warped. There is no Alignment in the app until ticket 07, so the layer holds no
	// maps and paints nothing; what is asserted is that the layer takes our `ProjectStore` shim,
	// that it survives being added to a map alongside the one MapLibre copy in the page, and that
	// it sends nothing to the placeholder host. **Ticket 07 absorbs this into the Base Map pane**,
	// where a warped Historical Map actually belongs.

	import { page } from '$app/state';
	import { EditorSession } from '$lib/editor-session.svelte.js';
	import { exposeWarpedLayerToBrowserTests } from '$lib/warped/browser-test-handle.js';
	import { createWarpedMapLayer } from '$lib/warped/warped-map-layer.js';
	import { Map as MapLibreMap } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';

	/** Which Project's store the layer reads through, from `?p=` as everywhere else (ADR-0008). */
	const openDirectory = $derived(page.url.searchParams.get('p'));

	let container: HTMLDivElement;
	let status = $state('Starting…');
	let layerId = $state('');
	let failure = $state('');

	$effect(() => {
		const directory = openDirectory;

		if (EditorSession.unsupportedReason()) {
			failure = EditorSession.unsupportedReason();
			return;
		}

		const session = EditorSession.opfs();
		let map: MapLibreMap | undefined;
		let unexpose = () => undefined as void;

		void (async () => {
			try {
				await session.open(directory);
				const fetchTile = session.imageServiceFetch();

				if (!fetchTile) {
					failure = 'No Project is open. Add ?p=<folder> to reach one.';
					return;
				}

				// An empty style: this route is about the layer, and a Base Map here would only add
				// the pmtiles archive to what has to load before the assertion can be made.
				map = new MapLibreMap({
					container,
					style: { version: 8, sources: {}, layers: [] },
					center: [0, 0],
					zoom: 2,
					attributionControl: false
				});

				const layer = createWarpedMapLayer(fetchTile);
				map.on('load', () => {
					const created = map;
					if (!created) return;
					created.addLayer(layer);
					layerId = layer.id;
					status = `Warped map layer added with a ProjectStore fetchFn for “${directory}”.`;
					unexpose = exposeWarpedLayerToBrowserTests(created, layer);
				});
			} catch (cause) {
				failure = cause instanceof Error ? cause.message : String(cause);
			}
		})();

		return () => {
			unexpose();
			map?.remove();
		};
	});
</script>

<svelte:head><title>Warped rendering — Ballastella Editor</title></svelte:head>

<main class="flex h-dvh flex-col gap-3 p-4">
	<header>
		<h1 class="text-2xl font-bold">Warped rendering</h1>
		<p class="text-sm">
			A development surface for ADR-0011's injection point into <code>@allmaps/maplibre</code>. The
			layer reads its tiles through the open Project's <code>ProjectStore</code>; nothing is warped
			until Alignments exist.
		</p>
	</header>

	{#if failure}
		<p class="alert alert-error" role="alert">{failure}</p>
	{:else}
		<p aria-live="polite" data-testid="warped-status" data-layer-id={layerId}>{status}</p>
	{/if}

	<div class="min-h-0 flex-1 overflow-hidden rounded border border-base-300">
		<div bind:this={container} class="h-full w-full"></div>
	</div>
</main>
