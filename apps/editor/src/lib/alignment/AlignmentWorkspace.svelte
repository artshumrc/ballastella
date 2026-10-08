<script lang="ts">
	import {
		count,
		BASE_MAP_CATALOG,
		DEFAULT_DISTORTION_VIEW,
		MINIMUM_CONTROL_POINTS,
		MINIMUM_MASK_VERTICES,
		alignmentPath,
		canSolve,
		detectFold,
		imagePaneSourceFor,
		messageOf,
		type Alignment,
		type BaseMapAppearance,
		type ControlPoint,
		type DistortionView,
		type FetchFn,
		type GeoPoint,
		type ImagePane,
		type OpeningViewFit,
		type ResourcePoint
	} from '@ballastella/core';
	import type { WarpedRender } from '@ballastella/core/render';
	import { BaseMapOptions, LeaderLine, type Box } from '@ballastella/ui';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';

	import BaseMapPane from '$lib/base-map/BaseMapPane.svelte';
	import { fitToAlignment } from '$lib/base-map/opening-view';
	import Alert from '$lib/components/Alert.svelte';
	import BusyButton from '$lib/components/BusyButton.svelte';
	import MapImagePane from '$lib/image-pane/MapImagePane.svelte';
	import ImageDetails, { type ImageReadout } from '$lib/image-pane/ImageDetails.svelte';
	import type { PaneOverlayPoint } from '$lib/image-pane/ImagePane.svelte';
	import type { OverlayPoint } from '$lib/overlay/overlay-points';

	import type { EditorSession } from '../editor-session.svelte.js';
	import ControlPointList from './ControlPointList.svelte';
	import DistortionControls from './DistortionControls.svelte';
	import { mapImageSourceOf } from './map-source.svelte.js';
	import { AlignmentPairing, type PendingHalf } from './pairing.svelte.js';
	import TransformationPicker from './TransformationPicker.svelte';

	let {
		session,
		imageId,
		mapName,
		fetchTile,
		baseMapId,
		baseMapAppearance,
		projectDirectory
	}: {
		session: EditorSession;
		imageId: string;
		mapName: string;
		fetchTile: FetchFn;
		baseMapId: string;
		baseMapAppearance: BaseMapAppearance;
		projectDirectory: string;
	} = $props();

	const held = mapImageSourceOf(
		(wanted) => session.mapImageSource(wanted),
		() => imageId
	);
	const mapSource = $derived(held.current);
	const paneSource = $derived(imagePaneSourceFor(mapSource));
	let pairing = $state.raw<AlignmentPairing | undefined>(undefined);
	let failure = $state('');
	let concurrentEditOutcome = $state('');
	let concurrentEditOutcomeLine: HTMLElement | null = $state(null);
	let restoring = $state(false);
	let warped = $state<WarpedRender | null>(null);
	let distortion = $state<DistortionView>(DEFAULT_DISTORTION_VIEW);
	let overlayOpacity = $state(0.5);
	let readout = $state.raw<ImageReadout | null>(null);
	let checking = $state(false);

	const closeOrOpenChecking = (open: boolean): void => {
		checking = open;
		if (!open) distortion = DEFAULT_DISTORTION_VIEW;
	};

	let editingMask = $state(false);
	let maskPreview = $state.raw<readonly ResourcePoint[] | null>(null);
	let maskStatus = $state<{ kind: 'done' | 'refused'; message: string } | null>(null);

	const maskDone = (message: string): void => {
		maskStatus = { kind: 'done', message };
	};

	let generation = 0;
	let destroyed = false;

	onDestroy(() => {
		destroyed = true;
		generation += 1;
	});

	let openingFit = $state.raw<OpeningViewFit | null>(null);
	let openingOutcome = $state<'pending' | 'control-points' | 'content' | 'default'>('pending');
	let framed = false;
	let livePane: ImagePane | undefined;

	const reload = (): void => {
		if (livePane) loadAlignment(livePane);
	};

	let rebuiltAt: number | null = null;

	$effect(() => {
		const written = session.alignmentsWrittenBack;
		const seenBefore = rebuiltAt !== null;
		rebuiltAt = written;
		if (seenBefore) reload();
	});

	const loadAlignment = (pane: ImagePane): void => {
		if (destroyed) return;
		livePane = pane;
		const mine = ++generation;
		void (async () => {
			try {
				const stored = await session.readAlignment(imageId, pane.image);
				if (mine !== generation) return;
				pairing = new AlignmentPairing(imageId, pane.image, stored);
				frameOn(stored, mine);
			} catch (cause) {
				if (mine !== generation) return;
				failure = `The Alignment for “${imageId}” could not be opened: ${messageOf(cause)}`;
			}
		})();
	};

	const frameOn = (alignment: Alignment, mine: number): void => {
		if (framed) return;
		framed = true;
		const onItsOwnPoints = alignment.controlPoints.length > 0;
		void (async () => {
			const fit = await fitToAlignment(session, alignment, session.openProject?.layers ?? []);
			if (mine !== generation) return;
			openingFit = fit;
			openingOutcome = fit === null ? 'default' : onItsOwnPoints ? 'control-points' : 'content';
		})();
	};

	const history = $derived(session.historyFor(imageId));

	const asStep = (label: string, current: AlignmentPairing, gesture: () => void): void => {
		gesture();
		void history.step(label, [alignmentPath(imageId)], () =>
			session.writeAlignment(current.alignment)
		);
	};

	const quotedMapName = $derived(mapName === '' ? 'with no name' : `“${mapName}”`);
	const controlPoints = $derived(pairing?.controlPoints ?? []);
	const pending = $derived(pairing?.pending ?? null);
	const selectedId = $derived(pairing?.selectedId ?? null);
	let baseMapPane = $state<BaseMapPane | undefined>();
	let controlPointList = $state<ControlPointList | undefined>();
	let controlPointColumn = $state<HTMLElement | undefined>();
	let baseMapFrame = $state<HTMLElement | undefined>();

	const selectedOrdinal = $derived(
		controlPoints.find((point) => point.id === selectedId)?.ordinal ?? null
	);

	const TIP_BOX = 12;

	const selectedMark = (): Box | null => {
		if (selectedOrdinal === null || !baseMapFrame) return null;
		const half = baseMapFrame.querySelector(
			`[data-testid="pane-overlay-point-control-point"][data-ordinal="${selectedOrdinal}"]`
		);
		if (!half) return null;
		const box = half.getBoundingClientRect();
		const tip = { x: (box.left + box.right) / 2, y: box.bottom };
		return {
			left: tip.x - TIP_BOX,
			right: tip.x + TIP_BOX,
			top: tip.y - TIP_BOX,
			bottom: tip.y + TIP_BOX
		};
	};

	const selectedRow = (): Element | null =>
		selectedOrdinal === null || !controlPointColumn
			? null
			: (controlPointColumn
					.querySelector(
						`[data-testid="control-point-row-ordinal"][data-ordinal="${selectedOrdinal}"]`
					)
					?.closest('[data-testid="control-point-row"]') ?? null);

	const solvable = $derived<Alignment | null>(
		pairing && canSolve(pairing.alignment) ? pairing.alignment : null
	);

	const needed = $derived(MINIMUM_CONTROL_POINTS[pairing?.transformationType ?? 'polynomial1']);
	const fold = $derived(pairing ? detectFold(pairing.alignment) : null);
	const SIDE = { resource: 'Map Image', geo: 'Base Map' } as const;

	const halfLabel = (ordinal: number | undefined, half: PendingHalf): string =>
		ordinal === undefined
			? `Control Point waiting for its other half, on the ${SIDE[half]}`
			: `Control Point ${ordinal}, ${SIDE[half]} half. Arrow keys move it, Delete removes the pair.`;

	const removePair = (current: AlignmentPairing, point: ControlPoint): void =>
		asStep(`Undo delete of Control Point ${point.ordinal}`, current, () =>
			current.remove(point.id)
		);

	const editCoordinates = (point: ControlPoint, resource: ResourcePoint, geo: GeoPoint): void => {
		const current = pairing;
		if (!current) return;
		asStep(`Undo edit of Control Point ${point.ordinal}`, current, () => {
			current.move(point.id, 'resource', resource);
			current.move(point.id, 'geo', geo);
		});
	};

	const pairPoints = <TPoint extends ResourcePoint | GeoPoint>(
		current: AlignmentPairing,
		half: PendingHalf
	): OverlayPoint<TPoint>[] => {
		const points: OverlayPoint<TPoint>[] = current.controlPoints.map((point) => ({
			key: point.id,
			point: point[half] as TPoint,
			kind: 'control-point',
			ordinal: point.ordinal,
			label: halfLabel(point.ordinal, half),
			selected: point.id === current.selectedId,
			onselect: () => current.toggleSelected(point.id),
			ondelete: () => removePair(current, point),
			onmoveend: (to) =>
				asStep(`Undo move of Control Point ${point.ordinal}`, current, () =>
					current.move(point.id, half, to)
				)
		}));

		const waiting = current.pending;
		const placed = waiting?.[half];
		if (waiting && placed) {
			points.push({
				key: waiting.id,
				point: placed as TPoint,
				kind: 'control-point',
				pending: true,
				label: halfLabel(undefined, half),
				selected: true,
				onmoveend: (to) => current.move(waiting.id, half, to),
				ondelete: () => current.cancelPending()
			});
		}
		return points;
	};

	const maskPoints = (current: AlignmentPairing): PaneOverlayPoint[] => {
		const vertices: PaneOverlayPoint[] = current.resourceMask.map((vertex, index) => ({
			key: `mask-vertex-${index}`,
			point: vertex,
			kind: 'mask-vertex',
			label:
				`Resource Mask corner ${index + 1} of ${current.resourceMask.length}. Arrow keys move it` +
				(current.canRemoveMaskVertex ? ', Delete removes it.' : '.'),
			onmove: (to) => {
				maskPreview = current.resourceMask.map((vertex, at) => (at === index ? to : vertex));
			},
			onmoveend: (to) => {
				asStep(`Undo the Crop of ${quotedMapName}`, current, () => {
					current.moveMaskVertex(index, to);
					maskPreview = null;
					maskDone(
						`Resource Mask corner ${index + 1} moved to ${Math.round(to.x)}, ${Math.round(to.y)}.`
					);
				});
			},
			ondelete: () => {
				if (!current.canRemoveMaskVertex) {
					maskStatus = {
						kind: 'refused',
						message:
							`A Resource Mask needs at least ${MINIMUM_MASK_VERTICES} corners, so this one cannot ` +
							'be removed. Move it instead, or reset the crop.'
					};
					return;
				}
				asStep(`Undo the Crop of ${quotedMapName}`, current, () => {
					current.removeMaskVertex(index);
					maskDone(
						`Resource Mask corner ${index + 1} removed. ${current.resourceMask.length} corners left.`
					);
				});
			}
		}));

		const edges: PaneOverlayPoint[] = current.maskEdgeMidpoints.map((midpoint, index) => ({
			key: `mask-edge-${index}`,
			point: midpoint,
			kind: 'mask-edge',
			glyph: '+',
			label: `Add a Resource Mask corner on the edge after corner ${index + 1}`,
			onselect: () => {
				asStep(`Undo the Crop of ${quotedMapName}`, current, () => {
					current.insertMaskVertexAfter(index);
					maskDone(
						`A Resource Mask corner was added after corner ${index + 1}. ` +
							`${current.resourceMask.length} corners now.`
					);
				});
			}
		}));

		return [...vertices, ...edges];
	};

	const imagePoints = $derived(
		pairing
			? [
					...pairPoints<ResourcePoint>(pairing, 'resource'),
					...(editingMask ? maskPoints(pairing) : [])
				]
			: []
	);

	const basePoints = $derived(pairing ? pairPoints<GeoPoint>(pairing, 'geo') : []);

	const place = (half: PendingHalf, point: ResourcePoint | GeoPoint): void => {
		const current = pairing;
		if (!current) return;
		const completes = current.pending !== null && current.pending.half !== half;
		if (!completes) current.place(half, point);
		else
			asStep(`Undo placing Control Point ${current.controlPoints.length + 1}`, current, () =>
				current.place(half, point)
			);
	};

	const restoreTheirs = async (): Promise<void> => {
		restoring = true;
		try {
			const restored = await session.restoreAlignmentChangedElsewhere();
			if (destroyed) return;
			if (restored) reload();
			concurrentEditOutcome = restored
				? 'Their version of this Alignment is back, and the Control Points you placed over ' +
					'it have been discarded. The list below is what is on disk now.'
				: 'Their version could not be put back, so nothing has changed: your Control Points ' +
					'are still on screen and still on disk. The warning above is still there, and ' +
					'the reason is with the save indicator.';
			concurrentEditOutcomeLine?.focus();
		} finally {
			restoring = false;
		}
	};
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape') return;
		if (controlPointList?.cancelEdit() || pairing?.cancelPending()) event.preventDefault();
	}}
/>

{#if failure || session.alignmentError}
	<Alert text={failure || session.alignmentError} testid="alignment-failure" class="max-w-prose" />
{:else}
	<div class="relative flex min-h-0 grow flex-col gap-4 lg:flex-row lg:gap-0">
		<div class="flex shrink-0 flex-col gap-4 lg:min-h-0 lg:min-w-0 lg:shrink lg:grow lg:flex-row">
			<section
				aria-labelledby="map-image-pane-heading"
				class="flex shrink-0 flex-col lg:min-h-0 lg:min-w-0 lg:flex-1"
			>
				{#snippet cropControls()}
					<div class="flex flex-1 items-center justify-evenly">
						<h4 id="map-image-pane-heading" class="text-sm font-semibold">Map Image: {mapName}</h4>
						{#if pairing}
							<label class="label cursor-pointer gap-2 text-sm">
								<input
									type="checkbox"
									class="toggle toggle-sm"
									checked={editingMask}
									data-testid="mask-edit-toggle"
									onchange={(event) => {
										editingMask = event.currentTarget.checked;
										maskStatus = null;
									}}
								/>
								Crop
							</label>

							{#if editingMask}
								<button
									class="btn btn-outline btn-sm"
									data-testid="mask-reset"
									onclick={() => {
										const current = pairing;
										if (!current) return;
										asStep(`Undo the Crop reset of ${quotedMapName}`, current, () => {
											current.resetMask();
											maskPreview = null;
											maskDone(
												'The whole sheet is the map again, with ' +
													`${current.resourceMask.length} Resource Mask corners.`
											);
										});
									}}
								>
									Reset crop
								</button>
							{/if}
						{/if}
					</div>
				{/snippet}

				<MapImagePane
					{imageId}
					source={paneSource}
					{fetchTile}
					frameClass="{solvable ? 'mt-3' : 'mt-2'} h-[45dvh] lg:h-auto lg:min-h-64 lg:grow"
					label="Map Image, unwarped, in image pixel coordinates. Click a feature to start a Control Point."
					overlayPoints={imagePoints}
					maskRing={maskPreview ?? pairing?.resourceMask ?? []}
					onclickpoint={(point) => place('resource', point)}
					onpane={loadAlignment}
					onreadout={(current) => (readout = current)}
					controls={cropControls}
				/>

				{#if pairing}
					<div
						class="mt-2 flex shrink-0 flex-col gap-1"
						data-testid="resource-mask-controls"
						data-mask-vertices={pairing.resourceMask.length}
					>
						{#if editingMask}
							<p class="text-sm opacity-70" data-testid="mask-summary">
								{pairing.resourceMask.length} corners. Drag a corner to move it. Click a dashed handle
								to add a corner there. Arrow keys move the corner you have focused; Delete removes it.
							</p>
						{/if}

						<p
							class="min-h-0 text-sm"
							class:text-warning={maskStatus?.kind === 'refused'}
							class:opacity-70={maskStatus?.kind === 'done'}
							aria-live="polite"
							aria-atomic="true"
							data-testid="mask-status"
							data-mask-status={maskStatus?.kind ?? ''}
						>
							{maskStatus?.message ?? ''}
						</p>
					</div>
				{/if}
			</section>

			<section
				aria-labelledby="base-map-pane-heading"
				class="flex shrink-0 flex-col lg:min-h-0 lg:min-w-0 lg:flex-1"
			>
				<div class="mb-2 flex flex-wrap items-center justify-evenly lg:flex-nowrap">
					<h4 id="base-map-pane-heading" class="text-sm font-semibold">Base Map</h4>
					<BaseMapOptions
						entryId={baseMapId}
						catalog={BASE_MAP_CATALOG}
						appearance={baseMapAppearance}
						onAppearance={(chosen) => void session.updateProject({ baseMapAppearance: chosen })}
						onSelectEntry={(id) => session.updateProject({ baseMap: id })}
					/>
					{#if solvable}
						<div class="w-44" data-testid="overlay-opacity-controls">
							<label class="block text-center" for="overlay-opacity">
								<span class="label-text">Opacity</span>
							</label>
							<div class="flex items-center gap-2">
								<input
									id="overlay-opacity"
									type="range"
									class="range w-32 range-xs"
									min="0"
									max="100"
									step="5"
									value={Math.round(overlayOpacity * 100)}
									data-testid="overlay-opacity"
									oninput={(event) => (overlayOpacity = event.currentTarget.valueAsNumber / 100)}
								/>
								<span
									class="w-10 text-right text-sm tabular-nums opacity-70"
									data-testid="overlay-opacity-value"
								>
									{Math.round(overlayOpacity * 100)}%
								</span>
							</div>
						</div>
					{/if}
				</div>
				<div
					bind:this={baseMapFrame}
					class="h-[45dvh] overflow-hidden rounded-box border border-base-300 lg:h-auto lg:min-h-64 lg:grow"
				>
					<BaseMapPane
						appearance={baseMapAppearance}
						bind:this={baseMapPane}
						entryId={baseMapId}
						overlayPoints={basePoints}
						alignment={solvable}
						alignmentSource={mapSource}
						{openingFit}
						{distortion}
						{fetchTile}
						onclickpoint={(point) => place('geo', point)}
						alignmentOpacity={overlayOpacity}
						onwarped={(render) => (warped = render)}
					/>
				</div>
				<p
					class="sr-only"
					aria-live="polite"
					aria-atomic="true"
					data-testid="alignment-opening-view"
					data-opening-view={openingOutcome}
				>
					{#if openingOutcome === 'control-points'}
						Framed on this Map Image’s Control Points, where the work was left.
					{:else if openingOutcome === 'content'}
						No Control Points yet, so the Base Map is framed on this Project’s own content.
					{:else if openingOutcome === 'default'}
						No Control Points yet and nothing else placed on the earth, so the Base Map is on the
						default view.
					{/if}
				</p>
			</section>
		</div>

		<div
			bind:this={controlPointColumn}
			class="flex shrink-0 flex-col gap-3 bg-base-300 p-4 lg:min-h-0 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-base-content/10"
			data-testid="alignment-sidebar"
		>
			<div class="flex flex-wrap items-center gap-3">
				<p
					class="min-h-6 flex-1 text-sm"
					aria-live="polite"
					aria-atomic="true"
					data-testid="pairing-status"
					data-pending={pending ? pending.half : ''}
				>
					{#if pending}
						<span class="font-medium text-warning">{pending.message}</span>
					{:else if controlPoints.length === 0}
						Click a feature on the Map Image, then the same place on the Base Map, to make your
						first Control Point.
					{:else if controlPoints.length < needed}
						{controlPoints.length} of {needed} Control Points. The Map Image appears over the Base Map
						once there are {needed}.
					{:else}
						{controlPoints.length} Control Points.
					{/if}
				</p>

				{#if pending}
					<button class="btn btn-sm btn-warning" onclick={() => pairing?.cancelPending()}>
						Cancel this Control Point
					</button>
				{/if}
			</div>

			{#if session.alignmentChangedElsewhere?.imageId === imageId}
				<Alert testid="alignment-changed-elsewhere">
					<p class="max-w-prose">
						Somebody else changed this Map Image’s Alignment while you had it open — through a
						Workspace shared with this one — and your edit has just been saved over theirs. A Map
						Image has one Alignment, shared by every Project that draws it, so there is only ever
						one file to change.
					</p>
					<div class="flex flex-wrap gap-2">
						<BusyButton
							busy={restoring}
							class="btn btn-sm"
							data-testid="restore-changed-elsewhere"
							onclick={restoreTheirs}
						>
							Put their version back instead
						</BusyButton>
						<button
							class="btn btn-outline btn-sm"
							data-testid="dismiss-changed-elsewhere"
							onclick={() => {
								session.dismissAlignmentChangedElsewhere();
								concurrentEditOutcome =
									'Your version has been kept. Theirs is not on disk any more, and nothing on this ' +
									'screen has changed.';
								concurrentEditOutcomeLine?.focus();
							}}
						>
							Keep mine
						</button>
					</div>
				</Alert>
			{/if}

			<p
				bind:this={concurrentEditOutcomeLine}
				tabindex="-1"
				aria-live="polite"
				class="max-w-prose text-sm opacity-80"
				data-testid="changed-elsewhere-outcome"
			>
				{concurrentEditOutcome}
			</p>

			{#if fold}
				<div
					role="alert"
					class="alert max-w-prose alert-warning"
					data-testid="fold-warning"
					data-fold-kind={fold.kind}
					data-fold-where={fold.where}
				>
					<p>{fold.message}</p>
				</div>
			{/if}

			<ControlPointList
				bind:this={controlPointList}
				{pairing}
				onedit={editCoordinates}
				onremove={(point) => pairing && removePair(pairing, point)}
			/>

			{#if pairing}
				<div class="flex flex-col gap-4">
					<div class="min-w-0">
						<TransformationPicker
							value={pairing.transformationType}
							controlPointCount={controlPoints.length}
							onchoose={(type) => {
								const current = pairing;
								if (!current) return;
								asStep(`Undo the transformation of ${quotedMapName}`, current, () => {
									current.transformationType = type;
								});
							}}
						/>
					</div>

					<div class="min-w-0">
						<button
							type="button"
							class="btn btn-sm"
							aria-expanded={checking}
							aria-controls={checking ? 'check-alignment' : undefined}
							data-testid="check-alignment-toggle"
							onclick={() => closeOrOpenChecking(!checking)}
						>
							Check this alignment
						</button>

						{#if checking}
							<div id="check-alignment" class="mt-3">
								<DistortionControls
									view={distortion}
									enabled={warped?.status === 'drawn'}
									onchange={(next) => (distortion = next)}
								/>
							</div>
						{/if}
					</div>
				</div>
			{/if}

			<p
				class="text-sm"
				aria-live="polite"
				aria-atomic="true"
				data-testid="warped-status"
				data-warped-status={warped?.status ?? ''}
			>
				{#if warped?.status === 'drawn'}
					The Map Image is being drawn over the Base Map from {controlPoints.length} Control Points.
				{:else if warped?.status === 'refused'}
					The Map Image could not be drawn over the Base Map: {warped.reason}
				{:else if controlPoints.length < needed}
					{count(needed - controlPoints.length, 'more Control Point')} and the Map Image will be drawn
					over the Base Map.
				{/if}
			</p>

			{#if readout}
				<ImageDetails {...readout} />
			{/if}

			<a
				class="btn mt-auto w-full shrink-0 btn-lg btn-success"
				href="{resolve('/')}?p={encodeURIComponent(projectDirectory)}"
				data-testid="alignment-done"
			>
				<ArrowLeft class="size-5" aria-hidden="true" />
				Back to project
			</a>
		</div>

		<LeaderLine
			mark={selectedMark}
			row={selectedRow}
			canvas={() => baseMapFrame}
			sidebar={() => controlPointColumn}
			watch={(redraw) => baseMapPane?.onCameraMove(redraw) ?? (() => {})}
		/>
	</div>
{/if}
