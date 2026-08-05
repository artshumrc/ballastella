<script lang="ts">
	import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
	import { BASE_MAP_CATALOG, baseMapStyle, resolveBaseMap } from '@ballastella/core';
	import { Map as MapLibreMap, NavigationControl } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount } from 'svelte';

	import { theme } from '$lib/theme.svelte';
	import { exposeBaseMapToBrowserTests } from './browser-test-handle';
	import { resolveDeploymentAsset } from './deployment-assets';
	import { registerPmtilesProtocol } from './pmtiles-protocol';

	/** The catalog id currently shown. The page owns which one that is, and its persistence. */
	let { entryId }: { entryId: string } = $props();

	let container: HTMLDivElement;
	let map = $state<MapLibreMap | undefined>(undefined);

	/**
	 * What the map is currently painted with. A plain `let`, deliberately: in runes mode it is not
	 * reactive, so the effect below can read and write it without becoming its own dependency.
	 */
	let painted = '';

	const paintKey = (id: string, currentTheme: string): string => `${id}@${currentTheme}`;

	const styleFor = (id: string): StyleSpecification =>
		baseMapStyle(resolveBaseMap(id).entry, {
			theme: theme.current,
			resolveAsset: resolveDeploymentAsset
		});

	onMount(() => {
		registerPmtilesProtocol();

		const created = new MapLibreMap({
			container,
			style: styleFor(entryId),
			center: [...BASE_MAP_CATALOG.initialView.center],
			zoom: BASE_MAP_CATALOG.initialView.zoom,
			// ODbL makes the attribution a licence condition, so it is not folded behind an "i".
			attributionControl: { compact: false },
			// MapLibre puts this on the canvas as its accessible name. A WebGL canvas announces
			// nothing on its own, and there will be a second pane (ticket 03) to tell apart.
			locale: { 'Map.Title': 'Base Map' }
		});
		created.addControl(new NavigationControl({}), 'top-right');

		painted = paintKey(entryId, theme.current);
		map = created;
		const unexpose = exposeBaseMapToBrowserTests(created);

		return () => {
			unexpose();
			created.remove();
			map = undefined;
		};
	});

	$effect(() => {
		const wanted = paintKey(entryId, theme.current);
		const current = map;
		if (current === undefined || painted === wanted) return;
		painted = wanted;
		// One call, driven by one signal: the flavor changes in the same action that changes the
		// interface, which is the whole of ADR-0016's "not two independent toggles that agree".
		current.setStyle(styleFor(entryId));
	});
</script>

<!--
	MapLibre gives the canvas `tabindex="0"`, a `role`, and an accessible name, and handles arrow-key
	panning and +/- zooming itself, so the pane is keyboard operable without anything added here.
-->
<div bind:this={container} class="h-full w-full"></div>
