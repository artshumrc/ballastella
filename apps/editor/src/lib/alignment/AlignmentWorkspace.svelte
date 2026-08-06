<script lang="ts">
	// The Historical Map beside the Base Map, and the pairing between them (SPEC stories 30 and 32–37).
	//
	// This is the core act of the application: click a feature on the map, click the same place on
	// the earth, and a numbered Control Point pair appears. Both panes are on one page, which is why
	// `EditorSession` holding the only in-memory copy of `project.json` matters — two panes
	// serialising their own snapshot back would be a race inside a single component.
	//
	// The Alignment is written on discrete acts and gesture ends only (ADR-0017 rule 1), from here,
	// so there is exactly one place that decides an edit is over.

	import {
		canSolve,
		MINIMUM_CONTROL_POINTS,
		type Alignment,
		type FetchFn,
		type GeoPoint,
		type ImagePane,
		type ResourcePoint
	} from '@ballastella/core';

	import BaseMapPane, { type BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';
	import HistoricalMapPane from '$lib/image-pane/HistoricalMapPane.svelte';
	import type { PaneOverlayPoint } from '$lib/image-pane/ImagePane.svelte';
	import type { WarpedRender } from '$lib/warped/warped-map-layer';

	import type { EditorSession } from '../editor-session.svelte.js';
	import { AlignmentPairing } from './pairing.svelte.js';

	let {
		session,
		imageId,
		fetchTile,
		baseMapId
	}: {
		session: EditorSession;
		/** Which Historical Map of the open Project is being aligned. */
		imageId: string;
		/** The ADR-0011 shim for the open Project, for both panes' tiles. */
		fetchTile: FetchFn;
		/** The Base Map to show beneath, chosen by the author (ADR-0020). */
		baseMapId: string;
	} = $props();

	let pairing = $state.raw<AlignmentPairing | undefined>(undefined);
	let failure = $state('');
	let warped = $state<WarpedRender | null>(null);

	/**
	 * Bumped by every load, so a read that resolves late knows it has been superseded — the same
	 * guard `EditorSession.open` and `HistoricalMapPane` both need, and for the same reason: the
	 * user can pick another Historical Map while this one's Alignment is in flight.
	 */
	let generation = 0;

	// Cleared as soon as the Historical Map changes, before its pyramid has been read. Control Points
	// from the previous Alignment left drawn over a different image are a coordinate claim about the
	// wrong map, which is the one failure this component must never have.
	$effect(() => {
		void imageId;
		generation += 1;
		pairing = undefined;
		warped = null;
		failure = '';
	});

	/**
	 * The pyramid has been read, so the Alignment can be too.
	 *
	 * Driven by the pane rather than read here, because the image's pixel dimensions have to be
	 * exactly the ones being drawn: the Resource Mask defaults to that rectangle, and a second
	 * `createImagePane` on the same `info.json` would be a second answer that can disagree.
	 */
	const loadAlignment = (wanted: string, pane: ImagePane): void => {
		const mine = ++generation;
		void (async () => {
			try {
				const stored = await session.readAlignment(wanted, pane.image);
				if (mine !== generation) return;
				pairing = new AlignmentPairing(wanted, pane.image, stored);
			} catch (cause) {
				if (mine !== generation) return;
				failure = `The Alignment for “${wanted}” could not be opened: ${
					cause instanceof Error ? cause.message : String(cause)
				}`;
			}
		})();
	};

	/** Write the Alignment as it now stands. Every caller is a discrete act or a gesture end. */
	const save = (current: AlignmentPairing): void => {
		void session.writeAlignment(current.alignment);
	};

	const controlPoints = $derived(pairing?.controlPoints ?? []);
	const pending = $derived(pairing?.pending ?? null);
	const selectedId = $derived(pairing?.selectedId ?? null);

	/**
	 * The Alignment handed to the warped renderer, or `null` while it cannot be solved.
	 *
	 * Withheld below the minimum rather than passed and refused, so the renderer is never asked for
	 * an under-determined solve — which yields either a thrown error or a garbage warp (ADR-0013).
	 */
	const solvable = $derived<Alignment | null>(
		pairing && canSolve(pairing.alignment) ? pairing.alignment : null
	);

	const needed = MINIMUM_CONTROL_POINTS.polynomial1;

	/** How a Control Point half is described to assistive technology and on hover. */
	const halfLabel = (ordinal: number | undefined, side: 'Historical Map' | 'Base Map'): string =>
		ordinal === undefined
			? `Control Point waiting for its other half, on the ${side}`
			: `Control Point ${ordinal}, ${side} half. Arrow keys move it, Delete removes the pair.`;

	/** The image halves, plus the pending half if it is on this pane. */
	const imagePoints = $derived.by((): PaneOverlayPoint[] => {
		const current = pairing;
		if (!current) return [];
		const points: PaneOverlayPoint[] = current.controlPoints.map((point) => ({
			key: point.id,
			point: point.resource,
			kind: 'control-point',
			ordinal: point.ordinal,
			label: halfLabel(point.ordinal, 'Historical Map'),
			selected: point.id === current.selectedId,
			onselect: () => current.toggleSelected(point.id),
			ondelete: () => {
				current.remove(point.id);
				save(current);
			},
			onmoveend: (to) => {
				current.moveResource(point.id, to);
				save(current);
			}
		}));

		const waiting = current.pending;
		if (waiting?.resource) {
			points.push({
				key: waiting.id,
				point: waiting.resource,
				kind: 'control-point',
				pending: true,
				label: halfLabel(undefined, 'Historical Map'),
				selected: true,
				// Movable, but nothing is saved: a pending half is UI state only (ADR-0022 contract 2).
				onmoveend: (to) => current.moveResource(waiting.id, to),
				ondelete: () => current.cancelPending()
			});
		}
		return points;
	});

	/** The earth halves, plus the pending half if it is on this pane. */
	const basePoints = $derived.by((): BaseMapOverlayPoint[] => {
		const current = pairing;
		if (!current) return [];
		const points: BaseMapOverlayPoint[] = current.controlPoints.map((point) => ({
			key: point.id,
			point: point.geo,
			kind: 'control-point',
			ordinal: point.ordinal,
			label: halfLabel(point.ordinal, 'Base Map'),
			selected: point.id === current.selectedId,
			onselect: () => current.toggleSelected(point.id),
			ondelete: () => {
				current.remove(point.id);
				save(current);
			},
			onmoveend: (to) => {
				current.moveGeo(point.id, to);
				save(current);
			}
		}));

		const waiting = current.pending;
		if (waiting?.geo) {
			points.push({
				key: waiting.id,
				point: waiting.geo,
				kind: 'control-point',
				pending: true,
				label: halfLabel(undefined, 'Base Map'),
				selected: true,
				onmoveend: (to) => current.moveGeo(waiting.id, to),
				ondelete: () => current.cancelPending()
			});
		}
		return points;
	});

	const clickHistoricalMap = (point: ResourcePoint): void => {
		const current = pairing;
		if (!current) return;
		const completing = current.pending?.half === 'geo';
		current.clickHistoricalMap(point);
		// Written only when a pair actually came into existence. Placing the *first* half writes
		// nothing at all, which is what makes Escape leave no trace on disk: there is no file to
		// clean up, and no Alignment with an empty list of pairs left behind by a mis-started pair.
		if (completing) save(current);
	};

	const clickBaseMap = (point: GeoPoint): void => {
		const current = pairing;
		if (!current) return;
		const completing = current.pending?.half === 'resource';
		current.clickBaseMap(point);
		if (completing) save(current);
	};

	const removePair = (id: string): void => {
		const current = pairing;
		if (!current) return;
		current.remove(id);
		save(current);
	};
</script>

<!--
	Escape cancels the pending half from anywhere on the page (ADR-0022 contract 1). On the window
	rather than on a pane, because the key is pressed after a click that may have left focus on
	either canvas — or on the Control Point list — and "Escape only works if you have not moved the
	mouse" is not a cancellable pending state.
-->
<svelte:window
	onkeydown={(event) => {
		if (event.key !== 'Escape' || !pairing) return;
		if (pairing.cancelPending()) event.preventDefault();
	}}
/>

{#if failure || session.alignmentError}
	<div role="alert" class="alert max-w-prose alert-warning" data-testid="alignment-failure">
		<p>{failure || session.alignmentError}</p>
	</div>
{:else}
	<!--
		The pending prompt. `role="status"` is already taken by the save indicator on this page, so
		this is an `aria-live` region — which is also why the ingest progress region is one. `atomic`,
		so it is read as a whole sentence rather than as the words that changed.
	-->
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
				Click a feature on the Historical Map, then the same place on the Base Map, to make your
				first Control Point.
			{:else if controlPoints.length < needed}
				{controlPoints.length} of {needed} Control Points. The Historical Map appears over the Base Map
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

	<div class="mt-3 grid items-start gap-4 lg:grid-cols-2">
		<section aria-labelledby="historical-map-pane-heading" class="min-w-0">
			<h4 id="historical-map-pane-heading" class="mb-2 text-sm font-semibold">Historical Map</h4>
			<!--
				The same pane story 31 already delivers, now carrying Control Points. It loads the
				pyramid and reports it through `onpane`, which is what the Alignment's Resource Mask and
				coordinate space are built from — reading the same `info.json` a second time here would
				be a second answer that can disagree with what is being drawn.
			-->
			<HistoricalMapPane
				{imageId}
				{fetchTile}
				label="Historical Map, unwarped, in image pixel coordinates. Click a feature to start a Control Point."
				overlayPoints={imagePoints}
				onclickpoint={clickHistoricalMap}
				onpane={(pane) => loadAlignment(imageId, pane)}
			/>
		</section>

		<section aria-labelledby="base-map-pane-heading" class="min-w-0">
			<h4 id="base-map-pane-heading" class="mb-2 text-sm font-semibold">Base Map</h4>
			<div class="h-96 overflow-hidden rounded border border-base-300">
				<BaseMapPane
					entryId={baseMapId}
					overlayPoints={basePoints}
					alignment={solvable}
					{fetchTile}
					onclickpoint={clickBaseMap}
					onwarped={(render) => (warped = render)}
				/>
			</div>
		</section>
	</div>

	<!--
		What the warped renderer did. Said rather than left to look like an empty map, because the
		upstream defect in `@allmaps/render` (see `warped-map-layer.ts`) makes the failure silent:
		tiles fail inside a worker and the errors are swallowed, so without this the user sees a Base
		Map with nothing on it and no reason given.
	-->
	<p
		class="mt-2 text-sm"
		aria-live="polite"
		aria-atomic="true"
		data-testid="warped-status"
		data-warped-status={warped?.status ?? ''}
	>
		{#if warped?.status === 'drawn'}
			The Historical Map is being drawn over the Base Map from {controlPoints.length} Control Points.
		{:else if warped?.status === 'refused'}
			The Historical Map could not be drawn over the Base Map: {warped.reason}
		{:else if controlPoints.length < needed}
			{needed - controlPoints.length} more Control {needed - controlPoints.length === 1
				? 'Point'
				: 'Points'} and the Historical Map will be drawn over the Base Map.
		{/if}
	</p>

	<!--
		The Control Points as a list. Not decoration: it is the keyboard and screen-reader path to
		every pairing action ADR-0022 asks for, and it is where the ordinals are unambiguously
		readable — the numbers drawn on the map are small, and on a dense Alignment they overlap.
	-->
	<section class="mt-4" aria-labelledby="control-points-heading">
		<h4 id="control-points-heading" class="text-sm font-semibold">
			Control Points ({controlPoints.length})
		</h4>

		{#if controlPoints.length === 0}
			<p class="mt-1 text-sm opacity-70">None yet.</p>
		{:else}
			<ul class="mt-2 flex flex-col gap-1" data-testid="control-point-list">
				{#each controlPoints as point (point.id)}
					<li class="flex flex-wrap items-center gap-2 text-sm" data-testid="control-point-row">
						<!--
							Selecting from here highlights *both* halves, which is the same state the map
							points read — so the cross-pane highlight has a keyboard route as well as a
							pointer one. `aria-pressed` because it is a toggle, not a navigation.
						-->
						<button
							class="btn btn-xs"
							class:btn-secondary={point.id === selectedId}
							aria-pressed={point.id === selectedId}
							data-testid="control-point-select"
							data-ordinal={point.ordinal}
							onclick={() => pairing?.toggleSelected(point.id)}
						>
							Point {point.ordinal}
						</button>
						<code class="opacity-70">
							{Math.round(point.resource.x)}, {Math.round(point.resource.y)} px →
							{point.geo.lng.toFixed(5)}, {point.geo.lat.toFixed(5)}
						</code>
						<button
							class="btn btn-ghost btn-xs"
							data-testid="control-point-delete"
							onclick={() => removePair(point.id)}
						>
							Delete point {point.ordinal}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/if}
