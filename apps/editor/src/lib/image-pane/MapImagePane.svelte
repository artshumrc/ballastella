<script lang="ts">
	import {
		createImagePane,
		messageOf,
		type FetchFn,
		type ImagePane,
		type ImagePaneSource,
		type ResourcePoint
	} from '@ballastella/core';
	import { onDestroy, untrack, type Snippet } from 'svelte';

	import Alert from '$lib/components/Alert.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	import type { ImageReadout } from './ImageDetails.svelte';
	import ImagePaneView, { type PaneOverlayPoint } from './ImagePane.svelte';

	let {
		imageId,
		source,
		fetchTile,
		label,
		overlayPoints = [],
		maskRing = [],
		onclickpoint,
		onpane,
		onreadout,
		frameClass = 'mt-3 h-96',
		controls
	}: {
		imageId: string;
		source: ImagePaneSource;
		fetchTile: FetchFn;
		label: string;
		overlayPoints?: PaneOverlayPoint[];
		maskRing?: readonly ResourcePoint[];
		onclickpoint?: (point: ResourcePoint) => void;
		onpane?: (pane: ImagePane) => void;
		onreadout?: (readout: ImageReadout | null) => void;
		frameClass?: string;
		controls?: Snippet;
	} = $props();

	let pane: ImagePane | undefined = $state.raw();
	let shownImageId = $state('');
	let failure = $state('');
	let tilesLoaded = $state(false);
	let mapZoom = $state(0);
	let pointer = $state<{ x: number; y: number } | undefined>();

	$effect(() => {
		const built = pane;
		const id = shownImageId;
		onreadout?.(built && id !== '' ? { imageId: id, pane: built, mapZoom, pointer } : null);
	});

	onDestroy(() => onreadout?.(null));
	const installedApp = useInstalledApp();

	const remoteHost = $derived.by(() => {
		if (typeof source.tiles !== 'string') return '';
		try {
			return new URL(source.tiles).hostname;
		} catch {
			return '';
		}
	});

	let generation = 0;
	let reopenAttempt = $state(0);

	$effect(() => {
		const wanted = imageId;
		const { tiles, infoUrl } = source;
		void reopenAttempt;
		const connected = untrack(() => installedApp.online);
		const mine = ++generation;
		pane = undefined;
		shownImageId = '';
		failure = '';
		tilesLoaded = false;

		void (async () => {
			try {
				if (!connected && typeof tiles === 'string') {
					throw new Error(
						`this Map Image's sheet is served by ${remoteHost || 'another server'}, and ` +
							`there is no connection. Its tiles were never copied into this Workspace, and the ` +
							`record beside it says how big the image is but not how it is cut into tiles — so ` +
							`there is nothing to draw and nothing safe to guess. Reconnect and this pane opens ` +
							`by itself.`
					);
				}

				const response = await fetchTile(infoUrl);

				if (!response.ok) {
					throw new Error(
						`its info.json could not be read from ${remoteHost || 'this Workspace'} ` +
							`(${response.status} ${response.statusText})`
					);
				}

				const built = createImagePane(await response.json(), tiles);
				if (mine !== generation) return;
				pane = built;
				shownImageId = wanted;
				onpane?.(built);
			} catch (cause) {
				if (mine !== generation) return;
				failure = `“${wanted}” could not be opened: ${messageOf(cause)}`;
			}
		})();
	});

	let wasOnline = true;
	$effect(() => {
		const online = installedApp.online;
		const returned = online && !wasOnline;
		wasOnline = online;
		if (!returned || remoteHost === '') return;
		if (untrack(() => pane) !== undefined) return;
		reopenAttempt += 1;
	});

	const offlineAfterOpening = $derived(
		pane !== undefined && remoteHost !== '' && !installedApp.online
	);
</script>

{#if failure}
	<Alert testid="map-image-failure" class="max-w-prose"><p>{failure}</p></Alert>
{:else if pane}
	<!-- Region outside the {#if}: a live region inserted with its first text is not announced. -->
	<div aria-live="polite" data-testid="map-image-offline-region">
		{#if offlineAfterOpening}
			<div
				class="mb-3 alert max-w-prose alert-warning"
				data-testid="map-image-offline"
				data-offline-host={remoteHost}
			>
				<p>
					There is no connection, and this Map Image’s sheet is served by {remoteHost}, so no more
					of it will arrive until you are back online. You can carry on placing Control Points — the
					pane still knows where every image pixel is, so they will be in the right place.
				</p>
			</div>
		{/if}
	</div>

	<div class="flex h-10 flex-wrap items-center gap-2">
		{@render controls?.()}

		<p
			class="text-sm"
			aria-live="polite"
			data-testid="map-image-tiles"
			data-tiles-loaded={tilesLoaded}
		>
			{#if !tilesLoaded}
				<span class="loading loading-xs loading-spinner" aria-hidden="true"></span>
			{/if}
			<span class="sr-only">
				{tilesLoaded ? 'All tiles for this view have loaded.' : 'Loading tiles…'}
			</span>
		</p>
	</div>

	<div class="{frameClass} overflow-hidden rounded-box border border-base-300">
		{#key shownImageId}
			<ImagePaneView
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
{:else}
	<p aria-live="polite">Opening the Map Image…</p>
{/if}
