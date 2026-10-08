<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		BASE_MAP_CATALOG,
		baseMapCacheSizeFor,
		cachedTilePath,
		cachedTileReader,
		DEFAULT_BASE_MAP_APPEARANCE,
		DEFAULT_BASE_MAP_BORDER_STYLE,
		DEFAULT_BASE_MAP_BORDERS,
		baseMapFallbackNotice,
		canSolve,
		messageOf,
		resolveBaseMap,
		type Alignment,
		type Annotation,
		type AnnotationCollection,
		type AnnotationLayer,
		type Layer,
		type MapLayer,
		type BaseMapCacheSize,
		type BaseMapEntry,
		type Place
	} from '@ballastella/core';
	import {
		type DrawnLayer,
		type DrawnOutcome,
		type ReadCachedTile
	} from '@ballastella/core/render';
	import {
		AnnotationInspector,
		ANNOTATION_INSPECTOR_ID,
		BaseMapOptions,
		KIND_STYLE,
		LayerList,
		LeaderLine,
		MapCommentary,
		MapNotice,
		MapSnapshotButton,
		pageChrome,
		type Box
	} from '@ballastella/ui';
	import { MapView, annotationRow, returnFocusFromInspector } from '@ballastella/ui/map-view';
	import Plus from '@lucide/svelte/icons/plus';
	import Scan from '@lucide/svelte/icons/scan';
	import { tick, untrack } from 'svelte';

	import AnnotationLayerContents from '$lib/annotations/AnnotationLayerContents.svelte';
	import AnnotationStyleFace from '$lib/annotations/AnnotationStyleFace.svelte';
	import AnnotationTextFace from '$lib/annotations/AnnotationTextFace.svelte';
	import { AnnotationEditing } from '$lib/annotations/annotation-editing.svelte.js';
	import BaseMapPane from '$lib/base-map/BaseMapPane.svelte';
	import MakeOfflineDialog from '$lib/base-map/MakeOfflineDialog.svelte';
	import { MakeProjectOffline, readOfflineCoverage } from '$lib/base-map/make-offline.svelte.js';
	import { fitToProjectContent } from '$lib/base-map/opening-view';
	import Alert from '$lib/components/Alert.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import AddMapImage from '$lib/map-images/AddMapImage.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import OfflineCopyDialog from '$lib/remote-iiif/OfflineCopyDialog.svelte';
	import { OfflineCopyJob } from '$lib/remote-iiif/offline-copy-job.svelte.js';
	import { editHistorySlot } from '$lib/undo/edit-history-slot.svelte.js';

	import ProjectSettingsDialog from './ProjectSettingsDialog.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		session,
		storage,
		openDirectory,
		offerAbove = false
	}: {
		session: EditorSession;
		storage: WorkspaceStorage;
		openDirectory: string;
		offerAbove?: boolean;
	} = $props();

	const recovering = $derived(session.status === 'unreachable');

	$effect(() => {
		pageChrome.showBreadcrumbs('editor-project', [
			{ label: 'Projects', destination: {}, testid: 'all-projects' },
			{
				label: session.openProject?.name || openDirectory,
				testid: 'project-name',
				action: {
					label: 'Edit Project name',
					testid: 'edit-project-name',
					onClick: () => void settings?.show()
				}
			}
		]);
		return () => pageChrome.clear('editor-project');
	});

	$effect(() => {
		editHistorySlot.show('editor-project', session.historyFor(openDirectory));
		return () => editHistorySlot.clear('editor-project');
	});

	const resolution = $derived(
		session.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);
	const notice = $derived(resolution === null ? null : baseMapFallbackNotice(resolution));
	const appearance = $derived(
		session.openProject?.baseMapAppearance ?? DEFAULT_BASE_MAP_APPEARANCE
	);
	const borders = $derived(session.openProject?.borders ?? DEFAULT_BASE_MAP_BORDERS);
	const borderStyle = $derived(session.openProject?.borderStyle ?? DEFAULT_BASE_MAP_BORDER_STYLE);
	const view = new MapView(
		() => layers,
		() => [resolution?.entry.id, appearance]
	);

	const layers = $derived<readonly Layer[]>(session.openProject?.layers ?? []);
	let deletingLayerId = $state<string | null>(null);
	const deletingLayer = $derived(layers.find((layer) => layer.id === deletingLayerId));

	const confirmDeleteLayer = async (): Promise<void> => {
		const id = deletingLayerId;
		deletingLayerId = null;
		if (id) await session.deleteLayer(id);
	};

	const shown = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer => layer.visible && layer.kind !== 'foreign'
		)
	);

	const withDocuments = $derived(
		layers.filter(
			(layer): layer is MapLayer | AnnotationLayer =>
				layer.kind === 'map' || (layer.visible && layer.kind === 'annotation')
		)
	);

	const documentKey = $derived(
		JSON.stringify(
			withDocuments.map((layer) => [
				layer.id,
				layer.kind === 'map' ? layer.imageId : layer.geojsonRef
			])
		)
	);

	let documents = $state.raw<Readonly<Record<string, unknown>>>({});
	let unreadable = $state.raw<Readonly<Record<string, string>>>({});
	let generation = 0;

	$effect(() => {
		void documentKey;
		void session.annotationsWrittenBack;
		const current = session;
		const wanted = untrack(() => withDocuments);
		const mine = ++generation;
		void (async () => {
			const read: Record<string, unknown> = {};
			const failures: Record<string, string> = {};
			for (const layer of wanted) {
				try {
					const document =
						layer.kind === 'map'
							? await current.readLayerAlignment(layer)
							: await current.readAnnotations(layer);
					if (document !== null) read[layer.id] = document;
				} catch (cause) {
					failures[layer.id] = messageOf(cause);
				}
			}
			if (mine !== generation) return;
			documents = read;
			unreadable = failures;
			annotations.releaseMissingSelection();
		})();
	});

	const drawn = $derived<readonly DrawnLayer[]>(
		shown.flatMap((layer): DrawnLayer[] => {
			const document = documents[layer.id];
			if (layer.kind === 'map') {
				if (document === undefined || notAligned.has(layer.id)) return [];
				const referenced = session.referencedImageIds.has(layer.imageId);
				const service = referenced ? (originFor(layer)?.service ?? '') : '';
				return [{ layer, alignment: document as Alignment, referenced, service }];
			}
			return [{ layer, annotations: (document as AnnotationCollection | undefined) ?? null }];
		})
	);

	const originFor = (layer: MapLayer) =>
		session.referencedImages.find((image) => image.imageId === layer.imageId);

	let rendered = $state.raw<Readonly<Record<string, DrawnOutcome>>>({});
	const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';

	const notAligned = $derived(
		new Set(
			withDocuments
				.filter((layer) => layer.kind === 'map')
				.filter((layer) => {
					const document = documents[layer.id];
					return document === undefined || !canSolve(document as Alignment);
				})
				.map((layer) => layer.id)
		)
	);

	const outcomes = $derived.by((): Readonly<Record<string, DrawnOutcome>> => {
		const merged: Record<string, DrawnOutcome> = { ...rendered };
		for (const layer of withDocuments) {
			if (notAligned.has(layer.id)) {
				merged[layer.id] = { status: 'refused', reason: NOT_ALIGNED };
				continue;
			}
			if (merged[layer.id] || documents[layer.id] !== undefined) continue;
			if (layer.kind === 'annotation') {
				merged[layer.id] = { status: 'refused', reason: 'No Annotations in this Layer yet.' };
			}
		}
		for (const [id, reason] of Object.entries(unreadable)) {
			merged[id] = { status: 'refused', reason };
		}
		return merged;
	});

	const fetchTile = $derived(session.imageServiceFetch(view.onTileOutcome));

	let framedProject = '';

	$effect(() => {
		const directory = openDirectory;
		const current = session;
		const file = current.openProject ?? null;
		if (file === null) return;
		if (current.openDirectory !== directory || framedProject === directory) return;
		framedProject = directory;
		view.unframe();
		void fitToProjectContent(current, file.layers).then((fit) => {
			if (framedProject === directory) view.frame(fit);
		});
	});

	async function fitToProject(): Promise<void> {
		const file = session.openProject;
		if (file) view.frame(await fitToProjectContent(session, file.layers), true);
	}

	const annotations = new AnnotationEditing({
		session: () => session,
		layers: () => layers,
		documents: () => documents,
		replaceDocument: (layerId, collection) => {
			documents = { ...documents, [layerId]: collection };
		}
	});

	const drawing = annotations.drawing;
	let baseMapPane = $state<BaseMapPane | undefined>();
	let inspectorDock = $state<HTMLDivElement | undefined>();

	let baseMapOptionsMenu = $state<ReturnType<typeof BaseMapOptions> | undefined>();
	let layerSidebar = $state<HTMLElement | undefined>();
	let mapColumn = $state<HTMLElement | undefined>();
	let layerScroller = $state<HTMLElement | undefined>();

	const selectedMark = (): Box | null => {
		const annotation = annotations.selectedAnnotation;
		return annotation ? (baseMapPane?.annotationBox(annotation) ?? null) : null;
	};

	const selectedRow = () => annotationRow(layerSidebar, annotations.selectedAnnotationId);

	$effect(() => {
		if (annotations.selectedAnnotationId !== null) void keepSelectedMarkClear();
	});

	async function keepSelectedMarkClear(): Promise<void> {
		await tick();
		const annotation = annotations.selectedAnnotation;
		if (!annotation) return;
		const panel = document.getElementById(ANNOTATION_INSPECTOR_ID);
		baseMapPane?.keepAnnotationClear(annotation, panel?.getBoundingClientRect() ?? null);
	}

	async function dismissInspector(): Promise<void> {
		const row = selectedRow();
		annotations.selectAnnotation(null);
		await returnFocusFromInspector(row);
	}

	async function deleteSelectedAnnotation(): Promise<void> {
		const at = annotations.selectedIndex;
		await annotations.deleteSelected();
		await tick();
		const remaining = annotations.activeCollection?.annotations ?? [];
		const next = remaining[Math.min(at, remaining.length - 1)];
		await returnFocusFromInspector(
			next
				? annotationRow(layerSidebar, next.id)
				: layerSidebar?.querySelector('[data-testid="annotation-new"]')
		);
	}

	async function placeAtPlace(place: Place, query: string): Promise<void> {
		baseMapPane?.frameOnPlace(place);
		await annotations.placePin(place.point, query);
	}

	const offline = new MakeProjectOffline(() => session);
	let cache = $state.raw<BaseMapCacheSize | null>(null);
	let offlineReady = $state<boolean | null>(null);
	let offlineSummary = $state('');
	const baseMapEntryId = $derived(resolution?.entry.id ?? '');

	async function readOfflineState(
		current: EditorSession,
		entry: BaseMapEntry,
		forLayers: readonly Layer[]
	): Promise<void> {
		cache = await baseMapCacheSizeFor(current.store, entry.archive);
		try {
			const read = await readOfflineCoverage(current, entry, forLayers);
			offlineReady = read.coverage?.complete ?? false;
			const asOf = read.fromRecord
				? ' Checked against what this Workspace recorded when the tiles were fetched, because there is no connection.'
				: '';
			offlineSummary =
				read.bounds === null
					? 'This Project has nothing placed on the earth yet, so there is no area to make available offline.'
					: read.coverage?.complete
						? `Available offline: all ${read.coverage.budget.count} Base Map tiles this Project’s work covers are in this Workspace.${asOf}`
						: `Not available offline: ${read.coverage?.present ?? 0} of ${read.coverage?.budget.count ?? 0} Base Map tiles this Project’s work covers are in this Workspace.${asOf}`;
		} catch {
			offlineReady = null;
			offlineSummary =
				(cache?.tiles ?? 0) > 0
					? `The Base Map is being drawn from the ${cache?.tiles} tiles in this Workspace. Whether that covers everything this Project needs cannot be checked without a connection.`
					: 'The Base Map needs a network connection, and there is none. Your Map Images, Alignments, and Annotations are all still here.';
		}
	}

	let servedCache: { maxZoom: number; readTile: ReadCachedTile } | null = null;
	const cachedArchive = $derived(resolution?.entry.archive);
	const readCachedTile = $derived(
		cachedArchive === undefined
			? undefined
			: cachedTileReader(session.store, (tile) => cachedTilePath(cachedArchive, tile))
	);

	const cachedBaseMap = $derived.by(() => {
		const held = cache;
		const readTile = readCachedTile;
		if (!held || held.maxZoom === null || !readTile || offlineReady === false) {
			servedCache = null;
			return null;
		}
		if (servedCache?.maxZoom !== held.maxZoom || servedCache.readTile !== readTile) {
			servedCache = { maxZoom: held.maxZoom, readTile };
		}
		return servedCache;
	});

	$effect(() => {
		void openDirectory;
		void documentKey;
		void baseMapEntryId;
		void offline.completed;
		const current = untrack(() => session);
		const entry = untrack(() => resolution?.entry);
		const forLayers = untrack(() => layers);
		if (!entry) return;
		void readOfflineState(current, entry, forLayers);
	});

	let settings = $state<ProjectSettingsDialog | undefined>();
	const offlineCopy = new OfflineCopyJob(() => session);
	const installedApp = useInstalledApp();

	const unavailableNotice = $derived(
		view.unavailableNotice(resolution?.entry, installedApp.online)
	);

	const referencedLayers = $derived(
		layers.filter(
			(layer): layer is MapLayer =>
				layer.kind === 'map' && session.referencedImageIds.has(layer.imageId)
		)
	);

	const unreachableHosts = $derived([
		...new Set(
			referencedLayers
				.map((layer) => originFor(layer)?.service)
				.filter((service): service is string => Boolean(service))
				.map((service) => new URL(service).hostname)
		)
	]);

	let addMapImage = $state<AddMapImage | undefined>();
	let addNotice = $state('');

	const ingestSentence = $derived.by((): string => {
		const ingest = session.ingest;
		if (!ingest) return '';
		const label = session.ingestLabel;
		switch (ingest.phase) {
			case 'inspecting':
				return `Reading ${label}…`;
			case 'opening':
				return `Opening ${label}…`;
			case 'tiling':
				return `Preparing ${label}: tile ${ingest.tilesWritten} of ${ingest.tileCount}`;
			case 'finishing':
				return `Finishing ${label}…`;
			case 'done':
				return `Added ${label}`;
		}
	});
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		if (document.querySelector('dialog[open]') !== null) return;
		if (baseMapOptionsMenu?.isOpen() === true) return;
		const inspector = document.getElementById(ANNOTATION_INSPECTOR_ID);
		if (inspector !== null && event.target instanceof Node && inspector.contains(event.target))
			return;
		if (drawing.cancel()) return;
		if (annotations.selectedAnnotationId !== null) annotations.selectAnnotation(null);
	}}
/>

{#if recovering}
	<div class="m-4">
		<WorkspaceRecovery {storage} />
		<p class="mt-6"><a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a></p>
	</div>
{:else if session.projectProblem}
	<div
		role={offerAbove ? undefined : 'alert'}
		aria-live={offerAbove ? 'polite' : undefined}
		data-testid="project-problem"
		class="m-4 alert flex-col items-start alert-warning"
	>
		<h2 class="font-semibold">
			{session.projectProblem.kind === 'missing'
				? 'Project not found'
				: 'This Project cannot be opened'}
		</h2>
		<p>{session.projectProblem.message}</p>
		<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
	</div>
{:else if session.openProject && resolution}
	<div class="flex min-h-0 flex-col lg:h-full" data-testid="project-screen">
		<div class="relative flex min-h-0 grow flex-col lg:flex-row">
			<div class="flex min-h-0 grow flex-col">
				{#if !installedApp.online}
					<MapNotice
						shape="comes-and-goes"
						variant="info"
						class="m-2"
						heading="The Base Map needs a connection"
						testid="base-map-offline"
					>
						<p>
							There is no network connection, so the Base Map cannot load yet. Everything in your
							Workspace still works: you can add a Map Image now and place it when the connection is
							back.
						</p>
					</MapNotice>

					{#if referencedLayers.length > 0}
						<MapNotice shape="comes-and-goes" class="m-2" testid="referenced-offline">
							<p>
								There is no connection, so nothing can be fetched from {unreachableHosts.join(
									', '
								)}. These Map Images stay blank until there is one. Everything else in this Project
								— its own Map Images, its Alignments, and its Annotations — is unaffected and still
								saves.
							</p>
						</MapNotice>
					{/if}
				{/if}

				<MapNotice
					shape="comes-and-goes"
					class="m-2"
					heading="The Base Map did not load"
					testid="base-map-unavailable"
					text={unavailableNotice}
				/>

				<MapNotice
					shape="comes-and-goes"
					class="m-2"
					heading="A Map Image stopped drawing"
					testid="map-image-tiles-unavailable"
					text={view.tilesUnavailable}
				/>

				<div
					bind:this={mapColumn}
					class="h-[26rem] shrink-0 overflow-hidden lg:h-auto lg:min-h-0 lg:grow"
					data-testid="project-map"
				>
					<BaseMapPane
						bind:this={baseMapPane}
						selectedAnnotationId={annotations.selectedAnnotationId}
						entryId={resolution.entry.id}
						{appearance}
						{borders}
						{borderStyle}
						{cachedBaseMap}
						layers={drawn}
						annotationDragPreview={annotations.dragPreview}
						openingFit={view.openingFit}
						overlayPoints={annotations.annotationPoints}
						{fetchTile}
						onbasemapstatus={view.onBaseMapStatus}
						snapshotGeneration={view.snapshot.generation}
						oninvalidateframe={view.onInvalidateFrame}
						onframesettled={view.onFrameSettled}
						overlayDocked={inspectorDock !== undefined}
						onclickpoint={(point) => void annotations.placePoint(point)}
						onclickannotation={(hit) => {
							if (drawing.tool !== 'select') return;
							annotations.openFromMap(hit.layerId, hit.annotationId);
						}}
						onfinishshape={() => void annotations.finishShape()}
						onstack={(reported) => (rendered = reported)}
						controls={mapControls}
						overlay={mapOverlay}
					/>
				</div>

				<MapCommentary
					layerCount={layers.length}
					{outcomes}
					openingOutcome={view.openingOutcome}
					refitted={view.refitted}
					{emptyStackNote}
				>
					<p
						class="min-h-6 text-sm text-base-content/70"
						aria-live="polite"
						aria-atomic="true"
						data-testid="offline-availability"
						data-offline={offlineReady === null ? 'unknown' : offlineReady ? 'yes' : 'no'}
						data-cache-serving={cachedBaseMap === null ? 'no' : 'yes'}
					>
						{offlineSummary}
					</p>
					{@render live('offline-done', offline.completed, 'min-h-6 text-sm')}
				</MapCommentary>
			</div>

			<div
				bind:this={layerSidebar}
				class="flex shrink-0 flex-col border-t border-base-content/10 bg-base-300 p-4 lg:order-first lg:w-96 lg:border-t-0 lg:border-r"
				data-testid="layer-sidebar"
			>
				<div
					bind:this={layerScroller}
					class="min-h-0 grow lg:overflow-y-auto"
					data-testid="layer-scroller"
				>
					<LayerList
						{layers}
						{outcomes}
						openLayerId={annotations.openLayerId}
						onopen={(id) => annotations.openLayer(id)}
						ontypename={(id, name) => session.typeLayerName(id, name)}
						oncommit={() => session.commitLayerEdit()}
						onshow={(id, visible) => session.showLayer(id, visible)}
						ondragopacity={(id, opacity) => session.dragLayerOpacity(id, opacity)}
						onmove={(id, toIndex) => session.moveLayerTo(id, toIndex)}
						ondropannotation={(annotationId, layerId) =>
							void annotations.moveAnnotationToLayer(annotationId, layerId)}
						ondelete={(id) => (deletingLayerId = id)}
						{noLayersGuidance}
						{foreignLayerNote}
						preparing={session.ingest ? preparingLayer : undefined}
						{mapContents}
						problemAction={layerProblemAction}
						{annotationContents}
					/>

					{#if annotations.annotationLayerCount === 0}
						<p class="mt-2 max-w-prose text-sm" data-testid="no-annotation-layers">
							No Annotation Layers yet. Add one, then open it to draw: its pins, lines, and shapes
							are kept in one GeoJSON file that opens in other mapping tools.
						</p>
					{/if}

					{@render live(
						'annotation-move-refused',
						annotations.moveRefusal,
						'mt-2 max-w-prose text-sm text-warning'
					)}
					{@render live('annotation-moved', annotations.moveNotice, 'sr-only')}
					{@render live('ingest-announcement', ingestSentence, 'sr-only')}

					<!-- role="alert" because this is inserted with its text; aria-live would stay silent. -->
					<Alert class="mt-4 max-w-prose" text={session.ingestError} />

					{#if !layers.some((layer) => layer.kind === 'map') && session.ingest === null}
						<p class="mt-4 max-w-prose text-sm" data-testid="no-map-images">
							This Project has no Map Images yet. Press Add a Map Image to add one.
						</p>
					{/if}

					{@render live('offline-copy-done', offlineCopy.completed, 'mt-4 min-h-6 text-sm')}
					{@render live('remote-notice', addNotice, 'mt-2 min-h-6 max-w-prose text-sm')}

					{#if session.referencedImageErrors.length > 0}
						<Alert class="mt-4 max-w-prose">
							{#each session.referencedImageErrors as failure (failure.imageId)}
								<p>{failure.reason}</p>
							{/each}
						</Alert>
					{/if}
				</div>

				<div class="mt-4 flex shrink-0 gap-2">
					<button
						class="btn flex-1 gap-1 btn-sm {KIND_STYLE.map.btn}"
						type="button"
						data-testid="add-map-image"
						aria-label="Add a Map Image"
						onclick={() => addMapImage?.show()}
					>
						<Plus class="size-4" aria-hidden="true" />
						Map Image
					</button>

					<button
						class="btn flex-1 gap-1 btn-sm {KIND_STYLE.annotation.btn}"
						type="button"
						data-testid="add-annotation-layer"
						aria-label="Add an Annotation Layer"
						onclick={() =>
							session.addAnnotationLayer(`Annotations ${annotations.annotationLayerCount + 1}`)}
					>
						<Plus class="size-4" aria-hidden="true" />
						Annotation Layer
					</button>
				</div>
			</div>

			<LeaderLine
				mark={selectedMark}
				row={selectedRow}
				canvas={() => mapColumn}
				sidebar={() => layerScroller}
				watch={(redraw) => baseMapPane?.onCameraMove(redraw) ?? (() => {})}
			/>
		</div>
	</div>

	<MakeOfflineDialog job={offline} entry={resolution.entry} {layers} />

	<AddMapImage bind:this={addMapImage} {session} onnotice={(notice) => (addNotice = notice)} />

	<ProjectSettingsDialog
		bind:this={settings}
		{session}
		{storage}
		project={session.openProject}
		directory={openDirectory}
		{appearance}
		{borders}
		{borderStyle}
		onmakeoffline={async () => {
			await tick();
			await offline.ask(resolution.entry, layers);
		}}
	/>

	<ConfirmDialog
		bind:open={() => deletingLayerId !== null, (open) => !open && (deletingLayerId = null)}
		title="Delete Layer"
		confirm="Delete Layer"
		testid="confirm-delete-layer"
		onconfirm={confirmDeleteLayer}
	>
		<p>
			Delete <strong>{deletingLayer?.name || 'Untitled Layer'}</strong>? Its Annotations go with it.
			A Map Image stays in the Workspace and can be added again.
		</p>
	</ConfirmDialog>
{:else}
	<p class="p-4">Opening Project “{openDirectory}”…</p>
{/if}

{#snippet live(testid: string, text: string, className: string)}
	<p class={className} aria-live="polite" aria-atomic="true" data-testid={testid}>{text}</p>
{/snippet}

{#snippet noLayersGuidance()}
	No Layers yet. Press <strong>Add a Map Image</strong> to bring one in — from a file, from a
	library, or from one this Workspace already holds — and it appears here straight away, aligned or
	not. <strong>Add an Annotation Layer</strong> is for whenever you have something to say over it.
{/snippet}

{#snippet emptyStackNote()}
	Nothing is on the map yet.
{/snippet}

{#snippet foreignLayerNote()}
	It is kept exactly as it was found and written back untouched, and you can still rename it, hide
	it, and move it in the stack.
{/snippet}

{#snippet preparingLayer()}
	{#if session.ingest}
		{@const ingest = session.ingest}
		<div class="flex flex-col gap-2">
			<div class="flex flex-wrap items-baseline gap-2">
				<span class="font-medium" data-testid="preparing-layer-name">{session.ingestLabel}</span>
				<span class="text-sm opacity-70">Map Image</span>
			</div>

			<p class="text-sm" data-testid="preparing-layer-status">{ingestSentence}</p>

			<progress
				class="progress w-full"
				value={ingest.fraction}
				max="1"
				aria-label="Preparing {session.ingestLabel}"
			></progress>

			<div>
				<button
					type="button"
					class="btn btn-sm"
					aria-label="Cancel preparing {session.ingestLabel}"
					onclick={() => session.cancelIngest()}
					disabled={ingest.phase === 'done'}
				>
					Cancel
				</button>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet alignLink(layer: Layer, testid: string, label: string)}
	<a
		class="btn btn-xs {KIND_STYLE.map.btn}"
		data-testid={testid}
		href="{resolve('/align')}?p={encodeURIComponent(
			session.openDirectory ?? ''
		)}&layer={encodeURIComponent(layer.id)}"
	>
		{label}
	</a>
{/snippet}

{#snippet layerProblemAction(layer: Layer)}
	{@const reported = outcomes[layer.id]}
	{#if layer.kind === 'map' && reported?.status === 'refused' && reported.reason === NOT_ALIGNED}
		{@render alignLink(layer, 'align-map-image-now', 'Align now')}
	{/if}
{/snippet}

{#snippet mapContents(layer: MapLayer)}
	{@const origin = originFor(layer)}
	{@const referenced = session.referencedImageIds.has(layer.imageId)}
	{@const reported = outcomes[layer.id]}
	<div class="flex flex-col gap-2">
		{#if reported?.status === 'refused' && reported.reason === NOT_ALIGNED}
			<p class="text-sm text-warning" data-testid="layer-not-aligned">{NOT_ALIGNED}</p>
		{/if}

		<div class="flex flex-wrap items-center gap-2">
			{@render alignLink(layer, 'align-map-image', 'Align to base map')}
			<span
				class="text-xs"
				class:text-warning={referenced}
				class:text-success={!referenced}
				data-testid="layer-image-mode"
				data-image-mode={referenced ? 'referenced' : 'offline-copy'}
			>
				{referenced ? 'Source: External IIIF' : 'Source: Local'}
			</span>

			{#if referenced && origin}
				<span class="text-xs" data-testid="referenced-image-label"
					>{origin.label || origin.imageId}</span
				>
				<code class="text-xs opacity-70" data-testid="referenced-image-host"
					>{new URL(origin.service).hostname}</code
				>
				<OfflineCopyDialog image={origin} job={offlineCopy} />
			{:else if origin}
				<span class="text-xs" data-testid="offline-copy-label"
					>{origin.label || origin.imageId}</span
				>
				<code class="text-xs break-all opacity-70" data-testid="offline-copy-source"
					>{origin.service}</code
				>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet annotationContents()}
	<AnnotationLayerContents
		collection={annotations.activeCollection}
		selectedId={annotations.selectedAnnotationId}
		{drawing}
		onplace={(place, query) => void placeAtPlace(place, query)}
		onfinish={() => void annotations.finishShape()}
		onselect={(id) => annotations.selectAnnotation(id)}
		onmove={(id, toIndex) => void annotations.moveAnnotationTo(id, toIndex)}
	/>
{/snippet}

{#snippet inspectorText(annotation: Annotation)}
	<AnnotationTextFace
		{annotation}
		titling={annotation.id === annotations.titlingId}
		ontext={(text) => void annotations.typeText(text)}
		ontitled={() => (annotations.titlingId = null)}
		oncommit={() => void annotations.commitAnnotationEdit()}
		ondelete={() => void deleteSelectedAnnotation()}
		index={annotations.selectedIndex}
		count={annotations.activeCollection?.annotations.length ?? 0}
		moveTargets={annotations.moveTargets}
		onmove={(toIndex) => void annotations.moveAnnotationTo(annotation.id, toIndex)}
		onmovetolayer={(layerId) => void annotations.moveAnnotationToLayer(annotation.id, layerId)}
	/>
{/snippet}

{#snippet inspectorStyle(annotation: Annotation)}
	<AnnotationStyleFace
		{annotation}
		onstyle={(style, options) => void annotations.styleSelected(style, options)}
		onlinestyle={(line) => void annotations.lineStyleSelected(line)}
		oncommit={() => void annotations.commitAnnotationEdit()}
		onapplytoall={() => void annotations.applySelectedStyleToLayer()}
	/>
{/snippet}

{#snippet mapControls()}
	<div class="flex flex-wrap items-center gap-2">
		<BaseMapOptions
			bind:this={baseMapOptionsMenu}
			entryId={resolution!.entry.id}
			catalog={BASE_MAP_CATALOG}
			showChevron={true}
			{appearance}
			{borders}
			onAppearance={(chosen) => void session.updateProject({ baseMapAppearance: chosen })}
			onSelectEntry={(id) => session.updateProject({ baseMap: id })}
			onBorders={(choice) => void session.updateProject({ borders: choice })}
		/>

		<button
			type="button"
			class="btn btn-sm"
			data-testid="fit-to-project"
			onclick={() => void fitToProject()}
		>
			<Scan size={16} aria-hidden="true" />
			Frame project
		</button>

		<MapSnapshotButton
			ready={view.snapshotReady}
			capturing={view.snapshot.capturing}
			captureFailed={view.snapshot.captureFailed}
			onclick={() => void view.capture(baseMapPane, openDirectory)}
		/>
	</div>

	<MapNotice
		shape="always-present"
		variant="plain"
		class="basis-full text-sm text-base-content/70"
		testid="base-map-notice"
		text={notice}
	/>
{/snippet}

{#snippet mapOverlay()}
	{#if annotations.selectedAnnotation}
		<div
			bind:this={inspectorDock}
			class="absolute top-auto right-2 bottom-[6.25rem] left-2 z-[7] flex max-h-[60%] flex-col lg:top-2 lg:bottom-auto lg:left-auto lg:max-h-[calc(100%-3rem)] lg:w-80 lg:max-w-[calc(100%-1rem)]"
		>
			<AnnotationInspector
				annotation={annotations.selectedAnnotation}
				index={annotations.selectedIndex}
				onclose={() => void dismissInspector()}
				text={inspectorText}
				style={annotations.selectedIsDrawable ? inspectorStyle : undefined}
			/>
		</div>
	{/if}
{/snippet}
