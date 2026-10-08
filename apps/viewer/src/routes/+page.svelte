<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		BASE_MAP_CATALOG,
		DEFAULT_BASE_MAP_APPEARANCE,
		PUBLISHED_SITE_RECORD_NAME,
		PathNotFoundError,
		baseMapFallbackNotice,
		baseMapNotInSiteNotice,
		cachedTilePath,
		cachedTileReader,
		legacyCachedTilePath,
		createStoreImageFetch,
		messageOf,
		parseProjectFile,
		parsePublishedSite,
		projectFilePath,
		readBaseMapPreference,
		resolveBaseMap,
		returnLinkUrl,
		projectOpeningFit,
		setLayerVisible,
		setMapLayerOpacity,
		writeBaseMapPreference,
		type Annotation,
		type AnnotationLayer,
		type Layer,
		type MapLayer,
		type ReaderBaseMapPreference,
		type ProjectFile,
		type PublishedRepository,
		type PublishedSite
	} from '@ballastella/core';
	import { type DrawnLayer, type DrawnOutcome } from '@ballastella/core/render';
	import {
		AnnotationDescription,
		AnnotationInspector,
		AnnotationList,
		BaseMapOptions,
		LayerList,
		LeaderLine,
		MapCommentary,
		MapNotice,
		MapSnapshotButton,
		ProjectCardList,
		pageChrome,
		type Box
	} from '@ballastella/ui';
	import LayerStackMap, { type AnnotationHit } from '@ballastella/ui/LayerStackMap.svelte';
	import { MapView, annotationRow, returnFocusFromInspector } from '@ballastella/ui/map-view';
	import Scan from '@lucide/svelte/icons/scan';
	import type { Map as MapLibreMap } from 'maplibre-gl';
	import 'maplibre-gl/dist/maplibre-gl.css';
	import { onMount, untrack } from 'svelte';

	import { online } from '$lib/online.svelte';
	import { readLayerDocuments, toContentLayers, type ReadDocuments } from '$lib/project-documents';
	import { returnLink } from '$lib/return-link.svelte.js';
	import { resolveSiteAsset, siteStore, sitePrefix } from '$lib/site-files';
	import { startTheme, theme } from '$lib/theme.svelte';
	import UnwarpedView from '$lib/UnwarpedView.svelte';
	import { loadUnwarpedSheet, type UnwarpedSheet } from '$lib/unwarped-manifest';

	// searchParams throws during prerender, and there is no site record or localStorage there.
	let hydrated = $state(false);
	onMount(() => {
		hydrated = true;
		startTheme();
		chosen = readBaseMapPreference(readerStorage(), sitePrefix());
		void loadSite();
		return online.start();
	});

	const openDirectory = $derived(hydrated ? page.url.searchParams.get('p') : null);
	const unwarpedLayerId = $derived(hydrated ? page.url.searchParams.get('unwarped') : null);
	let site = $state<PublishedSite | null>(null);
	let siteError = $state('');
	let openProject = $state<{ directory: string; file: ProjectFile } | null>(null);
	let projectError = $state('');

	async function loadSite(): Promise<void> {
		try {
			site = parsePublishedSite(await siteStore().read(PUBLISHED_SITE_RECORD_NAME));
		} catch (cause) {
			siteError =
				cause instanceof PathNotFoundError
					? 'This site has no list of Projects yet. The viewer’s own files are here, but the list ' +
						'itself has not arrived — Sync from Ballastella to add it.'
					: messageOf(cause);
		}
	}

	const remote = $derived<PublishedRepository | null>(
		site === null || site.editorUrl === '' ? null : site.repository
	);

	const frontPage = $derived(site?.projects.filter((project) => project.onFrontPage) ?? []);

	// Naming which page is empty would hint that unlisted work exists.
	const blankFrontPage = $derived(site !== null && siteError === '' && frontPage.length === 0);

	const cloneLink = $derived(
		site === null || remote === null || blankFrontPage
			? null
			: returnLinkUrl(site.editorUrl, {
					kind: 'clone',
					owner: remote.owner,
					repository: remote.repository
				})
	);

	const reviewLink = $derived(
		site === null || remote === null || openProject === null
			? null
			: returnLinkUrl(site.editorUrl, {
					kind: 'review',
					owner: remote.owner,
					repository: remote.repository,
					project: openProject.directory
				})
	);

	const barHeading = $derived(
		openDirectory === null ? 'Front Page' : (openProject?.file.name ?? '')
	);

	const barBack = $derived(
		unwarpedLayerId !== null && openDirectory !== null && openProject !== null
			? {
					label: 'Back to this Project’s map',
					project: openDirectory,
					testid: 'back-to-project'
				}
			: null
	);

	$effect(() => {
		const said = barHeading;
		pageChrome.show(said, barBack);
		return () => pageChrome.clear(said);
	});

	$effect(() => {
		const [href, label] =
			openDirectory === null
				? [cloneLink, 'Open this Workspace in Ballastella']
				: [reviewLink, 'Open this Project in Ballastella'];
		returnLink.current = href === null ? null : { href, label };
	});

	$effect(() => {
		const directory = openDirectory;
		if (!hydrated || directory === null) {
			openProject = null;
			projectError = '';
			return;
		}
		void (async () => {
			try {
				const file = parseProjectFile(await siteStore().read(projectFilePath(directory)));
				if (openDirectory !== directory) return;
				openProject = { directory, file };
				projectError = '';
			} catch (cause) {
				if (openDirectory !== directory) return;
				openProject = null;
				projectError =
					cause instanceof PathNotFoundError
						? `There is no Project called “${directory}” on this site.`
						: messageOf(cause);
			}
		})();
	});

	let layers = $derived<readonly Layer[]>(openProject?.file.layers ?? []);
	let openLayerId = $derived.by((): string | null => {
		void openProject;
		return null;
	});

	let announced = $state('');

	const layerName = (id: string): string =>
		layers.find((layer) => layer.id === id)?.name || 'Untitled Layer';

	function showLayer(id: string, visible: boolean): void {
		announced = `${layerName(id)} ${visible ? 'shown' : 'hidden'}`;
		layers = setLayerVisible(layers, id, visible);
	}

	function dragLayerOpacity(id: string, opacity: number): void {
		announced = `${layerName(id)} at ${Math.round(opacity * 100)}%`;
		layers = setMapLayerOpacity(layers, id, opacity);
	}

	const shown = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer => layer.visible && layer.kind !== 'foreign'
		)
	);

	let documents = $state.raw<ReadDocuments>({});
	let generation = 0;

	// Not visibility or opacity: a slider drag must not refetch.
	const documentKey = $derived(
		JSON.stringify([
			openProject?.directory ?? '',
			layers.map((layer) =>
				layer.kind === 'map'
					? [layer.id, layer.imageId]
					: layer.kind === 'annotation'
						? [layer.id, layer.geojsonRef]
						: [layer.id]
			)
		])
	);

	$effect(() => {
		void documentKey;
		const open = untrack(() => openProject);
		const wanted = untrack(() => layers);
		if (!open || wanted.length === 0) {
			documents = {};
			settleOpeningView(open, []);
			return;
		}
		const mine = ++generation;
		void (async () => {
			const read = await readLayerDocuments(siteStore(), open.directory, wanted);
			if (mine !== generation) return;
			documents = read;
			settleOpeningView(open, toContentLayers(wanted, read));
		})();
	});

	let framedProject = '';

	function settleOpeningView(
		open: { directory: string } | null,
		content: ReturnType<typeof toContentLayers>
	): void {
		if (open === null) {
			framedProject = '';
			view.unframe();
			return;
		}
		if (framedProject === open.directory) return;
		framedProject = open.directory;
		view.frame(projectOpeningFit(content), false);
	}

	const view = new MapView(
		() => layers,
		() => baseMap.entry.id
	);

	const fetchTile = $derived(
		createStoreImageFetch({ store: siteStore(), onOutcome: view.onTileOutcome })
	);

	const drawn = $derived<readonly DrawnLayer[]>(
		shown.flatMap((layer): DrawnLayer[] => {
			const read = documents[layer.id];
			if (read?.status !== 'ready') return [];
			if (layer.kind === 'map') {
				if (!read.alignment) return [];
				return [
					{
						layer,
						alignment: read.alignment,
						referenced: read.referenced ?? false,
						service: read.service ?? ''
					}
				];
			}
			return [{ layer, annotations: read.annotations ?? null }];
		})
	);

	let rendered = $state.raw<Readonly<Record<string, DrawnOutcome>>>({});

	const outcomes = $derived.by((): Readonly<Record<string, DrawnOutcome>> => {
		const merged: Record<string, DrawnOutcome> = {};
		for (const layer of shown) {
			const read = documents[layer.id];
			if (read?.status === 'unreadable') {
				merged[layer.id] = { status: 'refused', reason: read.reason };
				continue;
			}
			if (read === undefined || read.status === 'loading') {
				merged[layer.id] = { status: 'refused', reason: 'Still loading…' };
				continue;
			}
			const reportedByMap = rendered[layer.id];
			if (reportedByMap) {
				merged[layer.id] = reportedByMap;
				continue;
			}
			merged[layer.id] =
				layer.kind === 'map'
					? {
							status: 'refused',
							reason: 'This Map Image has not been aligned, so it is not drawn.'
						}
					: { status: 'refused', reason: 'This Layer has no Annotations in it.' };
		}
		return merged;
	});

	const needsNetwork = $derived(
		layers.filter((layer) => layer.kind === 'map' && referencedImageIds.has(layer.imageId))
	);

	const referencedImageIds = $derived(
		new Set(
			layers.flatMap((layer) => {
				if (layer.kind !== 'map') return [];
				const read = documents[layer.id];
				return read?.status === 'loading' || read === undefined || read.referenced !== true
					? []
					: [layer.imageId];
			})
		)
	);

	const unreachable = $derived(
		layers.flatMap((layer) => {
			const read = documents[layer.id];
			return read?.status === 'unreadable' && read.hostUnreachable
				? [{ name: layer.name || layer.id, reason: read.reason }]
				: [];
		})
	);

	const catalog = $derived(site?.baseMap ?? BASE_MAP_CATALOG);
	let chosen = $state.raw<ReaderBaseMapPreference>({ entryId: null, appearance: null });

	function readerStorage(): Storage | null {
		try {
			return typeof window === 'undefined' ? null : window.localStorage;
		} catch {
			return null;
		}
	}

	const baseMap = $derived(
		resolveBaseMap(chosen.entryId ?? openProject?.file.baseMap ?? null, catalog)
	);

	const baseMapAppearance = $derived(
		chosen.appearance ?? openProject?.file.baseMapAppearance ?? DEFAULT_BASE_MAP_APPEARANCE
	);
	const baseMapNotice = $derived(baseMapFallbackNotice(baseMap));
	const bundledBaseMapAvailable = $derived(site?.baseMapAssetsBundled ?? false);

	const cachedBaseMap = $derived.by(() => {
		const archive = baseMap.entry.archive;
		const held =
			site?.baseMapCaches.find((cache) => cache.archive === archive) ??
			site?.baseMapCaches.find((cache) => cache.archive === null);
		if (!held) return null;
		return {
			maxZoom: held.maxZoom,
			readTile: cachedTileReader(siteStore(), (tile) =>
				held.archive === null ? legacyCachedTilePath(tile) : cachedTilePath(archive, tile)
			)
		};
	});

	const siteRecordKnown = $derived(site !== null || siteError !== '');
	const archiveUnavailable = $derived(view.unavailableNotice(baseMap.entry, online.current));

	const baseMapNotInSite = $derived(
		baseMapNotInSiteNotice(baseMap.entry, {
			bundledAssets: bundledBaseMapAvailable,
			cachedTiles: cachedBaseMap !== null
		})
	);

	const showingTheMap = $derived(openProject !== null && unwarpedLayerId === null);

	function chooseForThisReader(preference: ReaderBaseMapPreference): void {
		chosen = preference;
		writeBaseMapPreference(readerStorage(), sitePrefix(), preference);
	}

	let selected = $state.raw<{ layerId: string; annotationId: string } | null>(null);

	const openAnnotations = $derived.by((): readonly Annotation[] | null => {
		if (openLayerId === null) return null;
		const read = documents[openLayerId];
		if (read?.status !== 'ready') return null;
		return read.annotations?.annotations ?? [];
	});

	const openAnnotationId = $derived(
		selected !== null && selected.layerId === openLayerId ? selected.annotationId : null
	);

	const openAnnotationIndex = $derived(
		openAnnotations?.findIndex((candidate) => candidate.id === openAnnotationId) ?? -1
	);

	let readerMapPane = $state<LayerStackMap | undefined>();

	const openFromMap = (hit: AnnotationHit): void => {
		openLayerId = hit.layerId;
		selected = hit;
	};

	const selectOnEnter = (map: MapLibreMap): void =>
		map.getCanvas().addEventListener('keydown', (event) => {
			if (event.key !== 'Enter') return;
			event.preventDefault();
			const centre = map.getCenter();
			const hit = readerMapPane?.annotationAt(map.project([centre.lng, centre.lat]));
			if (hit) openFromMap(hit);
		});

	let inspectorDock = $state<HTMLDivElement | undefined>();

	let layerColumn = $state<HTMLElement | undefined>();
	let mapColumn = $state<HTMLElement | undefined>();

	const openAnnotation = $derived(
		openAnnotations?.find((annotation) => annotation.id === openAnnotationId) ?? null
	);
	const selectedMark = (): Box | null =>
		openAnnotation ? (readerMapPane?.annotationBox(openAnnotation) ?? null) : null;

	const selectedRow = () => annotationRow(layerColumn, openAnnotationId);

	async function dismissInspector(): Promise<void> {
		const row = selectedRow();
		selected = null;
		await returnFocusFromInspector(row);
	}

	const unwarpedLayer = $derived(
		layers.find(
			(layer): layer is MapLayer => layer.kind === 'map' && layer.id === unwarpedLayerId
		) ?? null
	);

	let unwarped = $state.raw<{ layerId: string; sheet: UnwarpedSheet } | null>(null);

	$effect(() => {
		const layer = unwarpedLayer;
		if (!layer) return;
		void loadUnwarpedSheet(siteStore(), layer).then((sheet) => {
			if (unwarpedLayerId === layer.id) unwarped = { layerId: layer.id, sheet };
		});
	});

	const unwarpedSheet = $derived(
		unwarped !== null && unwarped.layerId === unwarpedLayer?.id ? unwarped.sheet : null
	);

	function readAsDocument(layerId: string): void {
		if (openDirectory === null) return;
		void goto(
			resolve(`/?p=${encodeURIComponent(openDirectory)}&unwarped=${encodeURIComponent(layerId)}`)
		);
	}

	const frontPageCards = $derived(
		frontPage.map((project) => ({
			name: project.name,
			directory: project.directory,
			href: resolve(`/?p=${encodeURIComponent(project.directory)}`)
		}))
	);

	const title = $derived(
		openProject ? `${openProject.file.name} — Ballastella` : 'Ballastella — Projects'
	);
</script>

<svelte:head><title>{title}</title></svelte:head>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && selected !== null) selected = null;
	}}
/>

<main class="flex min-h-0 flex-col lg:h-full">
	<MapNotice
		shape="always-present"
		variant="plain"
		class="max-w-prose text-sm text-warning"
		testid="base-map-notice"
		text={showingTheMap ? baseMapNotice : ''}
	/>

	<MapNotice
		shape="always-present"
		variant="plain"
		class="max-w-prose text-sm text-warning"
		testid="base-map-not-in-site"
		text={showingTheMap ? baseMapNotInSite : ''}
	/>

	{#if openDirectory === null}
		{#if !blankFrontPage}
			<div class="mx-auto w-full max-w-6xl p-4 sm:p-8">
				<p class="max-w-prose">
					These are the Projects shared from one Ballastella Workspace. A Reader can look at the
					work — the aligned Map Images and the Annotations written over them — and cannot change
					it. Made with
					<a class="link" href="https://github.com/artshumrc/ballastella#readme">Ballastella</a>.
				</p>

				{#if cloneLink !== null}
					<p class="mt-4 max-w-prose" data-testid="no-account-needed">
						Opening this Workspace in Ballastella takes a copy of all of it onto your own computer.
						You do not need an account, and nothing on this site is changed.
					</p>
				{/if}

				{#if siteError}
					<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
						<h2 class="font-semibold">This site has no list of Projects</h2>
						<p data-testid="site-problem">{siteError}</p>
					</div>
				{:else if site === null}
					<p class="mt-8">Looking for the Projects on this site…</p>
				{:else}
					<ProjectCardList
						class="mt-8 workspace-home-column"
						testid="front-page-projects"
						projects={frontPageCards}
					/>
				{/if}
			</div>
		{/if}
	{:else}
		{#if projectError}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<h2 class="text-xl font-semibold">This Project cannot be shown</h2>
				<p data-testid="project-problem">{projectError}</p>
			</div>
		{:else if openProject === null}
			<p>Opening…</p>
		{:else}
			{#if unwarpedLayerId !== null}
				<!-- A separate branch: two tile viewers exceed a phone's memory. -->
				{#if unwarpedLayer === null}
					<p class="mt-4" data-testid="unwarped-problem">
						This Project has no Map Image with that name.
					</p>
				{:else if unwarpedSheet === null}
					<p class="mt-4">Opening the sheet…</p>
				{:else if 'error' in unwarpedSheet}
					<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
						<p data-testid="unwarped-problem">{unwarpedSheet.error}</p>
					</div>
				{:else}
					<UnwarpedView
						label={unwarpedLayer.name}
						manifestId={unwarpedSheet.manifestId}
						manifest={unwarpedSheet.manifest}
						onclose={() => history.back()}
					/>
				{/if}
			{:else}
				<div class="flex min-h-0 grow flex-col" data-testid="project-screen">
					<div class="relative flex min-h-0 grow flex-col lg:flex-row">
						<div class="flex min-h-0 grow flex-col">
							<MapNotice
								shape="comes-and-goes"
								heading="The Base Map did not load"
								testid="base-map-unavailable"
								text={archiveUnavailable}
							/>

							<MapNotice
								shape="comes-and-goes"
								heading="A Map Image stopped drawing"
								testid="map-image-tiles-unavailable"
								text={view.tilesUnavailable}
							/>

							<div
								bind:this={mapColumn}
								class="h-[26rem] shrink-0 overflow-hidden lg:h-auto lg:min-h-0 lg:grow"
							>
								{#if siteRecordKnown}
									<LayerStackMap
										bind:this={readerMapPane}
										testid="reader-map-pane"
										stackHandle="ballastellaReaderMap"
										hitRadius={8}
										selectedAnnotationId={openAnnotationId}
										entryId={baseMap.entry.id}
										{catalog}
										theme={theme.current}
										appearance={baseMapAppearance}
										borders={openProject.file.borders}
										borderStyle={openProject.file.borderStyle}
										resolveAsset={resolveSiteAsset}
										bundledAssets={bundledBaseMapAvailable}
										{cachedBaseMap}
										layers={drawn}
										openingFit={view.openingFit}
										{fetchTile}
										tilesMissing={view.tilesMissing}
										onmap={selectOnEnter}
										onclickannotation={openFromMap}
										onstack={(reported) => (rendered = reported)}
										onbasemapstatus={view.onBaseMapStatus}
										snapshotGeneration={view.snapshot.generation}
										oninvalidateframe={view.onInvalidateFrame}
										onframesettled={view.onFrameSettled}
									>
										<!-- z-[6]: leader 5, controls 6, Inspector 7. -->
										<div
											class="absolute top-2 left-2 z-[6] flex max-w-[calc(100%-1rem)] flex-wrap items-start gap-2 {inspectorDock !==
											undefined
												? 'lg:max-w-[calc(100%-21.5rem)]'
												: ''}"
										>
											{@render mapControls()}
										</div>
										{@render mapOverlay()}
									</LayerStackMap>
								{/if}
							</div>

							<MapCommentary
								layerCount={layers.length}
								{outcomes}
								openingOutcome={view.openingOutcome}
								refitted={view.refitted}
								{emptyStackNote}
							/>
						</div>

						<div
							bind:this={layerColumn}
							class="shrink-0 border-t border-base-content/10 bg-base-300 p-4 lg:order-first lg:w-96 lg:overflow-y-auto lg:border-t-0 lg:border-r"
							data-testid="layer-sidebar"
						>
							<div
								aria-live="polite"
								aria-atomic="true"
								class="min-h-6 text-sm"
								data-testid="layer-view-status"
							>
								{announced}
							</div>

							<LayerList
								{layers}
								{outcomes}
								{openLayerId}
								onopen={(id) => (openLayerId = id)}
								onshow={showLayer}
								ondragopacity={dragLayerOpacity}
								{mapContents}
								{annotationContents}
							/>
							{#if needsNetwork.length > 0}
								<MapNotice
									shape="comes-and-goes"
									variant="plain"
									class="mt-4 text-sm text-warning"
									testid="project-needs-network"
								>
									{needsNetwork.length === 1
										? 'One Map Image'
										: `${needsNetwork.length} Map Images`}
									here {needsNetwork.length === 1 ? 'is' : 'are'} held on the library's own server rather
									than in this site: {needsNetwork.map((layer) => layer.name).join(', ')}. Without a
									network connection {needsNetwork.length === 1 ? 'it' : 'they'} cannot be shown.
								</MapNotice>
							{/if}

							{#if unreachable.length > 0}
								<MapNotice
									shape="comes-and-goes"
									heading="Some of this Project could not be reached"
									class="mt-4"
								>
									{#each unreachable as failure (failure.name)}
										<p data-testid="layer-unreachable">{failure.reason}</p>
									{/each}
								</MapNotice>
							{/if}
						</div>

						<LeaderLine
							mark={selectedMark}
							row={selectedRow}
							canvas={() => mapColumn}
							sidebar={() => layerColumn}
							watch={(redraw) => readerMapPane?.onCameraMove(redraw) ?? (() => {})}
						/>
					</div>
				</div>
			{/if}
		{/if}
	{/if}
</main>

{#snippet emptyStackNote()}
	This Project has nothing on the map.
{/snippet}

{#snippet mapControls()}
	<BaseMapOptions
		entryId={baseMap.entry.id}
		{catalog}
		appearance={baseMapAppearance}
		onAppearance={(appearance) => chooseForThisReader({ ...chosen, appearance })}
		onSelectEntry={(entryId) => chooseForThisReader({ ...chosen, entryId })}
	/>
	<button
		type="button"
		class="btn btn-sm"
		data-testid="fit-to-project"
		onclick={() => view.frame(projectOpeningFit(toContentLayers(layers, documents)), true)}
	>
		<Scan size={16} aria-hidden="true" />
		Frame project
	</button>

	<MapSnapshotButton
		ready={view.snapshotReady}
		capturing={view.snapshot.capturing}
		captureFailed={view.snapshot.captureFailed}
		onclick={() => void view.capture(readerMapPane, openProject?.directory)}
	/>
{/snippet}

{#snippet inspectorText(annotation: Annotation)}
	<AnnotationDescription {annotation} />
{/snippet}

{#snippet mapOverlay()}
	{#if openAnnotation}
		<div
			bind:this={inspectorDock}
			class="absolute top-auto right-2 bottom-[6.25rem] left-2 z-[7] flex max-h-[60%] flex-col lg:top-2 lg:bottom-auto lg:left-auto lg:max-h-[calc(100%-3rem)] lg:w-80 lg:max-w-[calc(100%-1rem)]"
		>
			<AnnotationInspector
				annotation={openAnnotation}
				index={openAnnotationIndex}
				onclose={() => void dismissInspector()}
				text={inspectorText}
			/>
		</div>
	{/if}
{/snippet}

{#snippet annotationContents()}
	<AnnotationList
		annotations={openAnnotations}
		openId={openAnnotationId}
		onopen={(id) =>
			(selected =
				id === null || openLayerId === null ? null : { layerId: openLayerId, annotationId: id })}
	/>
{/snippet}

{#snippet mapContents(layer: MapLayer)}
	<div>
		<button
			class="btn btn-xs"
			type="button"
			data-testid="read-as-document"
			onclick={() => readAsDocument(layer.id)}
		>
			Read as a document<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
		</button>
	</div>
{/snippet}
