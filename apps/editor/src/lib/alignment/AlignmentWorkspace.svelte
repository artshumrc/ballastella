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
		DEFAULT_DISTORTION_VIEW,
		MINIMUM_CONTROL_POINTS,
		MINIMUM_MASK_VERTICES,
		canSolve,
		detectFold,
		type Alignment,
		type DistortionView,
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
	import DistortionControls from './DistortionControls.svelte';
	import { AlignmentPairing } from './pairing.svelte.js';
	import TransformationPicker from './TransformationPicker.svelte';

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
	 * How the warped Historical Map is drawn (ADR-0013).
	 *
	 * **Held here and nowhere else.** It is a working view, not a property of the work, so it is
	 * never written to `project.json` and never reaches `EditorSession` — persisted it would become
	 * layer display state under ADR-0002, and a Published Site could then load colourised with a
	 * Reader having no way to interpret it.
	 */
	let distortion = $state<DistortionView>(DEFAULT_DISTORTION_VIEW);

	/**
	 * Whether the Resource Mask's handles are on the pane.
	 *
	 * The outline itself is always drawn — a user needs to see what the Alignment leaves out whether
	 * or not they are changing it — but eight draggable handles over a sheet you are placing Control
	 * Points on is noise, and a mis-aimed click is a moved outline. So the handles are asked for.
	 */
	let editingMask = $state(false);

	/** Why the last mask edit did not happen, if it did not. Said, not silently ignored. */
	let maskRefusal = $state('');

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
		maskRefusal = '';
		// The mask belongs to one image's pixel space, so its handles must not survive into another's.
		// The distortion view is about *drawing* rather than about a coordinate, so it stays.
		editingMask = false;
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

	/** How many pairs the *chosen* type needs — not the default's, which is what ticket 07 could assume. */
	const needed = $derived(MINIMUM_CONTROL_POINTS[pairing?.transformationType ?? 'polynomial1']);

	/**
	 * Whether this Alignment folds over itself, and where (ADR-0013).
	 *
	 * **Independent of the distortion overlay, and continuously computed.** It reads `pairing` and
	 * nothing about what is being drawn, so it is present with the overlay off, before the warped
	 * layer has been added, and while the Base Map's style is still loading — which is when a student
	 * placing their fourth point most needs to be told they have swapped two of the first three.
	 */
	const fold = $derived(pairing ? detectFold(pairing.alignment) : null);

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

		// The Resource Mask's handles, on this pane only — the mask is in image pixel space, and
		// editing it on the Base Map has no meaning (ticket 08's out-of-scope note).
		if (editingMask) points.push(...maskPoints(current));

		return points;
	});

	/**
	 * The Resource Mask's vertex and edge handles.
	 *
	 * On the same seam as a Control Point, deliberately. A mask vertex is the same kind of object to a
	 * keyboard — something you focus, nudge with the arrow keys, and delete — so it gets a real
	 * `<button>` with a name, arrow-key movement, and one store write per gesture, all of which
	 * `overlay-points.ts` already carries. The alternative was a drawing library editing inside a
	 * WebGL layer, which is not focusable and has no keyboard story at all.
	 *
	 * Keyed by index rather than by identity, because a mask vertex has no identity: the ring's order
	 * *is* the polygon, and there is nowhere in the file to put an id (SPEC story 94). Consequence:
	 * inserting a vertex renumbers the handles after it, exactly as deleting a Control Point
	 * renumbers the ordinals after it.
	 */
	const maskPoints = (current: AlignmentPairing): PaneOverlayPoint[] => {
		const vertices: PaneOverlayPoint[] = current.resourceMask.map((vertex, index) => ({
			key: `mask-vertex-${index}`,
			point: vertex,
			kind: 'mask-vertex',
			label:
				`Resource Mask corner ${index + 1} of ${current.resourceMask.length}. Arrow keys move it` +
				(current.canRemoveMaskVertex ? ', Delete removes it.' : '.'),
			onmoveend: (to) => {
				current.moveMaskVertex(index, to);
				maskRefusal = '';
				save(current);
			},
			ondelete: () => {
				if (current.removeMaskVertex(index)) {
					maskRefusal = '';
					save(current);
					return;
				}
				// Refused rather than silently ignored: a keypress that appears to do nothing is
				// indistinguishable from a broken handle.
				maskRefusal =
					`A Resource Mask needs at least ${MINIMUM_MASK_VERTICES} corners, so this one cannot ` +
					'be removed. Move it instead, or show the whole sheet again.';
			}
		}));

		const edges: PaneOverlayPoint[] = current.maskEdgeMidpoints.map((midpoint, index) => ({
			key: `mask-edge-${index}`,
			point: midpoint,
			kind: 'mask-edge',
			glyph: '+',
			label: `Add a Resource Mask corner on the edge after corner ${index + 1}`,
			// The affordance is activation, not dragging: a handle that both inserted and moved would
			// make "I nudged it" and "I added one" the same gesture.
			onselect: () => {
				current.insertMaskVertexAfter(index);
				maskRefusal = '';
				save(current);
			}
		}));

		return [...vertices, ...edges];
	};

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

	<!--
		The fold warning (ADR-0013): "the single most useful piece of feedback a student can receive."

		Above the panes and not tucked beside the distortion toggles, because it is about the Alignment
		being wrong rather than about how it is drawn — and it appears with the overlay off, which is
		its whole point. `role="alert"` rather than a polite region: an Alignment that has folded over
		itself is a mistake the user is currently making, and the next thing they do is place another
		point on top of it.
	-->
	{#if fold}
		<div
			role="alert"
			class="mt-3 alert max-w-prose alert-warning"
			data-testid="fold-warning"
			data-fold-kind={fold.kind}
			data-fold-where={fold.where}
		>
			<p>{fold.message}</p>
		</div>
	{/if}

	{#if pairing}
		<!--
			How the map is stretched, and how that is drawn. Two groups rather than one: the
			transformation type is part of the Alignment and is written to disk, and the distortion view
			is a working view that is deliberately not (ADR-0013). Putting them in one row would invite
			exactly the conflation that puts a debugging toggle in a Published Site.
		-->
		<div class="mt-4 flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
			<div class="min-w-0 flex-1">
				<TransformationPicker
					value={pairing.transformationType}
					controlPointCount={controlPoints.length}
					onchoose={(type) => {
						const current = pairing;
						if (!current) return;
						// Every Control Point survives, because this touches one field. Written now rather
						// than on a timer: choosing a type is a discrete act (ADR-0017 rule 1).
						current.setTransformationType(type);
						save(current);
					}}
				/>
			</div>

			<div class="min-w-0 flex-1">
				<DistortionControls
					view={distortion}
					enabled={warped?.status === 'drawn'}
					onchange={(next) => (distortion = next)}
				/>
			</div>
		</div>
	{/if}

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
				maskRing={pairing?.resourceMask ?? []}
				onclickpoint={clickHistoricalMap}
				onpane={(pane) => loadAlignment(imageId, pane)}
			/>

			{#if pairing}
				<!--
					The Resource Mask (SPEC stories 46 and 47): which part of this sheet is actually the map.

					The outline is always drawn — dimming what it leaves out, so the user can see what the
					Alignment excludes whether or not they are changing it — and the handles are asked for,
					because eight of them over a sheet you are placing Control Points on is noise and a
					mis-aimed click is a moved outline.
				-->
				<div class="mt-3 flex flex-col gap-1" data-testid="resource-mask-controls">
					<div class="flex flex-wrap items-center gap-3">
						<label class="label cursor-pointer gap-2 text-sm">
							<input
								type="checkbox"
								class="toggle toggle-sm"
								checked={editingMask}
								data-testid="mask-edit-toggle"
								onchange={(event) => {
									editingMask = event.currentTarget.checked;
									maskRefusal = '';
								}}
							/>
							Outline the part of the sheet that is the map
						</label>

						{#if editingMask}
							<button
								class="btn btn-ghost btn-sm"
								data-testid="mask-reset"
								onclick={() => {
									const current = pairing;
									if (!current) return;
									current.resetMask();
									maskRefusal = '';
									save(current);
								}}
							>
								Show the whole sheet again
							</button>
						{/if}
					</div>

					<p
						class="text-sm opacity-70"
						data-testid="mask-summary"
						data-mask-vertices={pairing.resourceMask.length}
					>
						{#if editingMask}
							{pairing.resourceMask.length} corners. Drag a corner to move it, or a dashed handle to add
							one. Arrow keys move the corner you have focused; Delete removes it.
						{:else}
							{pairing.resourceMask.length} corners. Everything outside the outline is left out when the
							Historical Map is drawn over the Base Map.
						{/if}
					</p>

					<!--
						Why an edit did not happen. A live region, because the refusal follows a keypress on a
						handle the user is looking at rather than at this text.
					-->
					<p
						class="min-h-0 text-sm text-warning"
						aria-live="polite"
						aria-atomic="true"
						data-testid="mask-refusal"
					>
						{maskRefusal}
					</p>
				</div>
			{/if}
		</section>

		<section aria-labelledby="base-map-pane-heading" class="min-w-0">
			<h4 id="base-map-pane-heading" class="mb-2 text-sm font-semibold">Base Map</h4>
			<div class="h-96 overflow-hidden rounded border border-base-300">
				<BaseMapPane
					entryId={baseMapId}
					overlayPoints={basePoints}
					alignment={solvable}
					{distortion}
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
