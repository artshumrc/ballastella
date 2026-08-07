<script module lang="ts">
	import { AlignmentPairing } from './pairing.svelte.js';

	/**
	 * The newest pairing built for a Historical Map, which is the one an undo has to act on.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THIS IS MODULE STATE AND NOT A CAPTURED INSTANCE
	 *
	 * **An undo record outlives this component.** The slot lives on `EditorSession`, and the session is
	 * not closed by a route change: `open` returns early for the Project already showing, and
	 * {@link EditorSession.forgetUndoOfOtherImages} drops a Control Point record only for a *different*
	 * image. So going to the Layers pane and back destroys this component and builds a new
	 * `AlignmentPairing` while the pending undo stays exactly where it was.
	 *
	 * The restore closure used to capture the pairing it was recorded on. Undo then wrote *that*
	 * object's whole Alignment — so a Control Point placed after coming back was overwritten out of the
	 * file, and the pairing on screen did not move, because the instance being reversed was one nothing
	 * was drawing any more. Resolving the pairing here, when the closure runs, is what makes "the live
	 * pairing" one fact rather than one per component instance.
	 *
	 * Not cleared when the component is destroyed, and that is the point: `UndoControl` is mounted on the
	 * Layers pane too, so a Control Point undo can be pressed with no workspace on screen, and this is
	 * the pairing it acts on there — the newest one for that image, which is the one that made the edit.
	 * It is only ever consulted for a record naming this same Historical Map, so a leftover entry for a
	 * map nobody is aligning cannot be reached — an image id is a random identifier (ADR-0015).
	 */
	let live: { readonly imageId: string; readonly pairing: AlignmentPairing } | null = null;
</script>

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
		type ControlPoint,
		type ControlPointDeletedUndo,
		type ControlPointMovedUndo,
		type DistortionView,
		type FetchFn,
		type GeoPoint,
		type ImagePane,
		type OpeningViewFit,
		type ResourcePoint
	} from '@ballastella/core';
	import type { WarpedRender } from '@ballastella/core/render';
	import { onDestroy } from 'svelte';

	import BaseMapPane, { type BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';
	import BaseMapSwitcher from '$lib/base-map/BaseMapSwitcher.svelte';
	import { fitToAlignment } from '$lib/base-map/opening-view';
	import HistoricalMapPane from '$lib/image-pane/HistoricalMapPane.svelte';
	import type { PaneOverlayPoint } from '$lib/image-pane/ImagePane.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import DistortionControls from './DistortionControls.svelte';
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
	/** Why the last undo declined, or `''`. Cleared by the next attempt — see {@link putBack}. */
	let undoRefused = $state('');
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
	 * Whether "Check this alignment" is open (ticket 03).
	 *
	 * **Closed by default, and not persisted anywhere** — not in `project.json`, not in `localStorage`,
	 * and not in the URL. Everything behind it is a working view rather than a property of the work
	 * (ADR-0002, ADR-0013), so a reload of this route comes back closed by construction: there is no
	 * store to read it from, which is why the criterion "reloading does not reopen the disclosure"
	 * cannot be satisfied by remembering to clear something.
	 *
	 * The contents are **conditionally rendered rather than hidden**. A `hidden` subtree is out of the
	 * accessibility tree too, but a CSS-collapsed one is not, and the criterion is that the overlay, the
	 * measure choice, and the grid are *absent* from it until the disclosure is opened — so the markup is
	 * absent as well, and there is nothing for a screen reader to reach past.
	 *
	 * A `<button aria-expanded>` and not `<details>`: ADR-0016 bans the `<details>` dropdown, and
	 * `TransformationPicker` already sets this precedent for the Advanced tier on the same screen.
	 */
	let checking = $state(false);

	/**
	 * Open or close the disclosure, and **put the drawing back as it was when it closes**.
	 *
	 * Without the second half, switching the overlay on and then closing the disclosure leaves the
	 * Historical Map colourised with the only control that turns it off no longer on the page — which is
	 * a map a user cannot get back, and reads as the colours being what the Alignment now *is*. Closing
	 * "Check this alignment" means the checking is over, so the check's drawing goes with it.
	 *
	 * The consequence is that reopening starts from the default rather than from the last measure. That
	 * is the honest trade: the alternative remembers a working view across the act of dismissing it.
	 */
	const closeOrOpenChecking = (open: boolean): void => {
		checking = open;
		if (!open) distortion = DEFAULT_DISTORTION_VIEW;
	};

	/**
	 * Whether the Resource Mask's handles are on the pane.
	 *
	 * The outline itself is always drawn — a user needs to see what the Alignment leaves out whether
	 * or not they are changing it — but eight draggable handles over a sheet you are placing Control
	 * Points on is noise, and a mis-aimed click is a moved outline. So the handles are asked for.
	 */
	let editingMask = $state(false);

	/**
	 * What the last Resource Mask edit did, or why it did not happen.
	 *
	 * **One live region for both, because a keyboard user needs to be told either way.** An earlier
	 * version announced only the refusal, so the reply to "Delete" was silence when it worked and a
	 * sentence when it did not — which teaches the user that silence means failure. The handles are on
	 * a WebGL canvas and the outline is drawn into it, so a successful move, insert, delete or reset is
	 * otherwise visible only to someone who can see the pane. `aria-live="polite"` is ADR-0016's
	 * mandated method for a status.
	 */
	let maskStatus = $state<{ kind: 'done' | 'refused'; message: string } | null>(null);

	/** Say what a mask edit did. Called on the gesture end, so it is one sentence per act. */
	const maskDone = (message: string): void => {
		maskStatus = { kind: 'done', message };
	};

	/**
	 * Bumped by every load, so a read that resolves late knows it has been superseded — the same
	 * guard `EditorSession.open` and `HistoricalMapPane` both need, and for the same reason: the
	 * user can pick another Historical Map while this one's Alignment is in flight.
	 */
	let generation = 0;
	let destroyed = false;

	// A pane or Alignment read can finish after route navigation has destroyed this workspace. Neither
	// may replace the module-level pairing used by Undo with an instance that is no longer on screen.
	onDestroy(() => {
		destroyed = true;
		generation += 1;
	});

	// Cleared as soon as the Historical Map changes, before its pyramid has been read. Control Points
	// from the previous Alignment left drawn over a different image are a coordinate claim about the
	// wrong map, which is the one failure this component must never have.
	$effect(() => {
		void imageId;
		generation += 1;
		// For the same reason, and only for a Control Point record: an offer to put back point 3 of a map
		// that is no longer on screen describes an edit the user cannot watch happen. A pending undo of a
		// deleted Layer or Annotation is about the Project rather than about one image, and survives.
		session.forgetUndoOfOtherImages(imageId);
		pairing = undefined;
		warped = null;
		failure = '';
		maskStatus = null;
		// The mask belongs to one image's pixel space, so its handles must not survive into another's.
		// The distortion view is about *drawing* rather than about a coordinate, so it stays.
		editingMask = false;
		openingFit = null;
		openingOutcome = 'pending';
	});

	/**
	 * Where the Base Map pane is framed when this Historical Map is opened (ADR-0026).
	 *
	 * On the Alignment's own Control Points when it has any, so that reopening a half-finished
	 * Alignment lands where the work was left instead of somewhere that has to be navigated away from
	 * every time; on the Project's content when it has none.
	 *
	 * **Once per Historical Map opened, and never in response to an edit.** Refitting as Control Points
	 * are placed would move the earth under the very gesture that is placing them, which is the worst
	 * place in the application for it to happen — see {@link framedImage}.
	 */
	let openingFit = $state.raw<OpeningViewFit | null>(null);

	/**
	 * What the pane was framed on, for the sentence beside it (SPEC story 112).
	 *
	 * The Project screen and the viewer both publish one, and this pane moves the Base Map on open
	 * exactly as they do — so a user who cannot see the canvas was the only one not told that it had
	 * moved, and not told *why* when the Alignment is new and it did not. Its own vocabulary rather
	 * than core's {@link OpeningViewOutcome}, because what it frames on is one Historical Map's Control
	 * Points and that is a different sentence.
	 */
	let openingOutcome = $state<'pending' | 'control-points' | 'content' | 'default'>('pending');

	/**
	 * The Historical Map the pane has already been framed for.
	 *
	 * A plain `let`: it is written by the code that reads it, and a reactive one would make the fit its
	 * own dependency and then refit on every placed pair.
	 */
	let framedImage = '';

	/**
	 * The pyramid has been read, so the Alignment can be too.
	 *
	 * Driven by the pane rather than read here, because the image's pixel dimensions have to be
	 * exactly the ones being drawn: the Resource Mask defaults to that rectangle, and a second
	 * `createImagePane` on the same `info.json` would be a second answer that can disagree.
	 */
	const loadAlignment = (wanted: string, pane: ImagePane): void => {
		if (destroyed) return;
		const mine = ++generation;
		void (async () => {
			try {
				const stored = await session.readAlignment(wanted, pane.image);
				if (destroyed || mine !== generation) return;
				pairing = new AlignmentPairing(wanted, pane.image, stored);
				// The one place a pairing comes into existence, and so the one place {@link live} is set: a
				// pending undo recorded before this component was last destroyed has to reverse *this*
				// object, not the one it was recorded on.
				live = { imageId: wanted, pairing };
				// The Alignment **as it was read**, before the user has touched it. Framing on the pairing
				// instead would be framing on a value that changes with every placed pair.
				//
				// This supersedes ticket 03's `fitTo`, which framed on the Control Points alone. ADR-0026's
				// rule is the Resource Mask, it caps the zoom, and it announces where the map went — none of
				// which a bare list of pair positions can do.
				frameOn(wanted, stored, mine);
			} catch (cause) {
				if (destroyed || mine !== generation) return;
				failure = `The Alignment for “${wanted}” could not be opened: ${
					cause instanceof Error ? cause.message : String(cause)
				}`;
			}
		})();
	};

	/**
	 * Frame the Base Map pane on this Historical Map's Alignment, once (ADR-0026).
	 *
	 * Guarded twice, and both guards earn their place. {@link framedImage} is what makes it *once per
	 * Historical Map* — `loadAlignment` runs again whenever the pyramid is re-read, and a second fit
	 * would put the map back where the Alignment starts after the user had panned. `generation` is the
	 * usual stale-read guard: the user can pick another Historical Map while this read is in flight,
	 * and framing the new one on the old one's Control Points is a coordinate claim about the wrong map.
	 */
	const frameOn = (wanted: string, alignment: Alignment, mine: number): void => {
		if (framedImage === wanted) return;
		framedImage = wanted;
		const onItsOwnPoints = alignment.controlPoints.length > 0;
		void (async () => {
			const fit = await fitToAlignment(session, alignment, session.openProject?.layers ?? []);
			if (mine !== generation || framedImage !== wanted) return;
			openingFit = fit;
			openingOutcome = fit === null ? 'default' : onItsOwnPoints ? 'control-points' : 'content';
		})();
	};

	/** Write the Alignment as it now stands. Every caller is a discrete act or a gesture end. */
	const save = (current: AlignmentPairing): void => {
		void session.writeAlignment(current.alignment);
	};

	/**
	 * Reversing a Control Point edit: put the pair back, then write, exactly as the edit itself did.
	 *
	 * **No bespoke save path**, which is ADR-0017's rule for undo as much as for anything else — and
	 * awaited rather than fired, so the save indicator reaches "Saved" for the undo the way it does for
	 * the edit.
	 *
	 * **The pairing is resolved here rather than captured when the record was made**, because a route
	 * change destroys this component and leaves the record standing — see {@link live}. Reversing the
	 * instance the gesture happened on would write an Alignment that has since been replaced, silently
	 * discarding every pair made after coming back.
	 *
	 * **The recorded id is translated when the pairing has been rebuilt.** Control Point ids are minted
	 * per session and are not in the file, so a pairing rebuilt from disk numbers the same pairs
	 * differently and `restoreControlPoint`, which matches by id, found nothing — the round trip's undo
	 * was a no-op. `core` deliberately does not guess at that, because from an array of drafts alone a
	 * pair that was deleted and a pair that was renumbered look the same, and putting a moved pair's old
	 * coordinates onto some *other* pair is a worse bug than the one being fixed. Here the two are
	 * distinguishable: `recordedOn` is the instance the gesture happened on, so a different instance
	 * means a rebuild, and only then is the ordinal — which is what the file actually stores position as
	 * (ADR-0022) — used to find the pair again.
	 *
	 * **A refusal is said out loud rather than returned to nobody.** Every way this can decline used to
	 * return silently, which left the undo button consumed and the save indicator settling on "Saved"
	 * over an edit that never happened. That is the precise failure this ticket exists to prevent, so it
	 * is now the one thing the user is told about.
	 */
	const putBack = async (
		record: ControlPointMovedUndo | ControlPointDeletedUndo,
		recordedOn: AlignmentPairing | undefined
	): Promise<void> => {
		undoRefused = '';
		const current = live?.imageId === record.imageId ? live.pairing : null;
		const wanted = current === recordedOn ? record : renumbered(record, current);
		if (!current || !wanted || !current.restore(wanted)) {
			undoRefused =
				'That Control Point could not be put back — the Alignment on screen is no longer the one it was recorded against. Nothing has been written.';
			return;
		}
		await session.writeAlignment(current.alignment);
	};

	/**
	 * The record with its ids re-pointed at the pair now holding its ordinal, or `null` if there is none.
	 *
	 * Only for a pairing rebuilt from disk — see {@link putBack}. `controlPoints` is the numbered list
	 * itself, so "the pair that is number 7" is read from the same place the label, the file and the
	 * undo affordance's wording all read it, rather than being counted again here.
	 */
	const renumbered = (
		record: ControlPointMovedUndo | ControlPointDeletedUndo,
		current: AlignmentPairing | null
	): ControlPointMovedUndo | ControlPointDeletedUndo | null => {
		if (!current) return null;
		if (record.kind === 'control-point-deleted') {
			// A deletion is spliced back in at its index rather than found by id, so it survives a rebuild
			// as it stands. Its id could collide with one the rebuilt pairing has since minted, and
			// `restoreControlPoint` refuses on a collision — which is now visible rather than silent.
			return record;
		}
		const at = current.controlPoints[record.ordinal - 1];
		return at ? { ...record, pointId: at.id } : null;
	};

	/**
	 * Record where a pair was before this gesture moved it (SPEC story 38).
	 *
	 * Called with the point as it was *rendered*, which is its pre-gesture value: nothing here sets
	 * `onmove`, so no state changes during a drag or a held arrow key, and the closure the handle calls
	 * still carries where the point started. Dragging a Control Point is the easiest thing in this
	 * application to mis-aim, which is why ADR-0014 refuses to ship without an undo of it.
	 */
	const rememberMove = (point: ControlPoint): void => {
		const record: ControlPointMovedUndo = {
			kind: 'control-point-moved',
			imageId,
			pointId: point.id,
			ordinal: point.ordinal,
			resource: point.resource,
			geo: point.geo
		};
		// Read now, not inside the closure: the whole question {@link putBack} asks is whether the pairing
		// it is about to reverse is still the one this gesture happened on, and reading `live` when the
		// closure runs would compare that pairing against itself and always say yes.
		const recordedOn = live?.pairing;
		session.record(record, () => putBack(record, recordedOn));
	};

	/**
	 * Record a pair about to be deleted, with the index that is what restores its ordinal.
	 *
	 * The index is taken among the *drafts* rather than from the ordinal, because a pending half is a
	 * draft too — and because the ordinal is derived from position (ADR-0022), so the position is the
	 * thing that has to go back.
	 */
	const rememberDelete = (current: AlignmentPairing, point: ControlPoint): void => {
		const at = current.drafts.findIndex((draft) => draft.id === point.id);
		if (at === -1) return;
		const record: ControlPointDeletedUndo = {
			kind: 'control-point-deleted',
			imageId,
			ordinal: point.ordinal,
			at,
			point: { id: point.id, resource: point.resource, geo: point.geo }
		};
		const recordedOn = live?.pairing;
		session.record(record, () => putBack(record, recordedOn));
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
				rememberDelete(current, point);
				current.remove(point.id);
				save(current);
			},
			onmoveend: (to) => {
				rememberMove(point);
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
				// Rounded, because the sentence is "the corner went where I pushed it" and not a
				// coordinate readout — and a nudge is one screen pixel, which is a sub-pixel move when
				// the pane is zoomed out.
				maskDone(
					`Resource Mask corner ${index + 1} moved to ${Math.round(to.x)}, ${Math.round(to.y)}.`
				);
				save(current);
			},
			ondelete: () => {
				if (current.removeMaskVertex(index)) {
					maskDone(
						`Resource Mask corner ${index + 1} removed. ${current.resourceMask.length} corners left.`
					);
					save(current);
					return;
				}
				// Refused rather than silently ignored: a keypress that appears to do nothing is
				// indistinguishable from a broken handle.
				maskStatus = {
					kind: 'refused',
					message:
						`A Resource Mask needs at least ${MINIMUM_MASK_VERTICES} corners, so this one cannot ` +
						'be removed. Move it instead, or show the whole sheet again.'
				};
			}
		}));

		const edges: PaneOverlayPoint[] = current.maskEdgeMidpoints.map((midpoint, index) => ({
			key: `mask-edge-${index}`,
			point: midpoint,
			kind: 'mask-edge',
			glyph: '+',
			label: `Add a Resource Mask corner on the edge after corner ${index + 1}`,
			// The affordance is activation, not dragging: a handle that both inserted and moved would
			// make "I nudged it" and "I added one" the same gesture. The help text and the cursor say so
			// — see the summary below and `layout.css` — because an affordance the pointer advertises and
			// the code refuses reads as a broken handle rather than as a deliberate choice.
			onselect: () => {
				current.insertMaskVertexAfter(index);
				maskDone(
					`A Resource Mask corner was added after corner ${index + 1}. ` +
						`${current.resourceMask.length} corners now.`
				);
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
				rememberDelete(current, point);
				current.remove(point.id);
				save(current);
			},
			onmoveend: (to) => {
				rememberMove(point);
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
		// nothing at all, which is what makes Escape leave no trace on disk. **Not "no file"** — since
		// ADR-0023 there has been an `alignments/<id>.json` from the moment the Historical Map was
		// added, so what a mis-started pair must not do is *touch* it: no write, not even one whose
		// bytes would come out the same. In a Workspace kept in git or Dropbox a rewrite is a change to
		// sync whatever it says, which is why the test beside this counts writes and not only bytes.
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
		const point = current.controlPoints.find((one) => one.id === id);
		if (point) rememberDelete(current, point);
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
		An undo that declined. `role="alert"` rather than a polite region, and beside the pairing
		instead of replacing it the way {@link failure} does: the user has just pressed a button whose
		label promised to put a Control Point back, and nothing on screen moved. Being told is the
		difference between "the app refused" and "the app lost my work".
	-->
	{#if undoRefused}
		<div role="alert" class="mt-3 alert max-w-prose alert-warning" data-testid="undo-refused">
			<p>{undoRefused}</p>
		</div>
	{/if}

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

			<!--
				"Check this alignment" (ticket 03): the distortion overlay, which measure it shows, and the
				bent grid, behind one disclosure.

				**Labelled for what it is for and not for what it is.** "Distortion" names a quantity a
				cartographer knows and a historian does not; "check this alignment" names the question a
				scholar actually has, which is the same principle ADR-0013 applies to the transformation
				types — guidance first, label second.

				**The fold warning is deliberately not in here.** It is above the panes, it runs whether or
				not this is open, and it is a correctness warning about a contradictory Control Point rather
				than a way of drawing one. Folding it in would hide the one piece of feedback ADR-0013 calls
				the most useful a student can receive behind a control they have no reason to open.
			-->
			<div class="min-w-0 flex-1">
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
									maskStatus = null;
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
									maskDone(
										'The whole sheet is the map again, with ' +
											`${current.resourceMask.length} Resource Mask corners.`
									);
									save(current);
								}}
							>
								Show the whole sheet again
							</button>
						{/if}
					</div>

					<!--
						What the outline is, and what can be done to it.

						**The two handles do two different things, and the text says which.** A corner is
						dragged; a dashed handle is *activated* and adds a corner where it sits. Ticket 08's
						own note is why — "a handle that both inserted and moved would make 'I nudged it' and
						'I added one' the same gesture" — and an earlier version of this sentence said "drag a
						dashed handle to add one", which is a gesture the code deliberately refuses. On a
						teaching tool a promised gesture that does nothing reads as a broken handle.
					-->
					<p
						class="text-sm opacity-70"
						data-testid="mask-summary"
						data-mask-vertices={pairing.resourceMask.length}
					>
						{#if editingMask}
							{pairing.resourceMask.length} corners. Drag a corner to move it. Click a dashed handle to
							add a corner there. Arrow keys move the corner you have focused; Delete removes it.
						{:else}
							{pairing.resourceMask.length} corners. Everything outside the outline is left out when the
							Historical Map is drawn over the Base Map.
						{/if}
					</p>

					<!--
						What the last edit did, or why it did not happen. **One live region for both**, because
						the alternative is what this was: a refusal announced and a success announced as
						silence, which teaches a keyboard user that nothing said means nothing worked. The
						handles sit on a WebGL canvas and the outline is drawn into it, so there is no other
						signal for someone not looking at the pane. `aria-live="polite"` is ADR-0016's mandated
						method for a status.
					-->
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

		<section aria-labelledby="base-map-pane-heading" class="min-w-0">
			<!--
				The Base Map heading and the choice of Base Map, together.

				**Here because this is where the wrong one is discovered.** The deployment default is a
				regional extract (ADR-0020), so an author aligning a sheet of anywhere outside its bounds
				zooms in and watches the earth go blank — and the switcher lived only on the Layers pane,
				behind a button labelled with a Layer count, which says nothing about Base Maps. The
				control belongs beside the pane whose emptiness sends you looking for it.

				It writes through `session.chooseBaseMap`, the same one every other switcher calls, so the
				choice is the Project's author default (ADR-0020) rather than a third copy of that state.
			-->
			<div class="mb-2 flex flex-wrap items-end justify-between gap-2">
				<h4 id="base-map-pane-heading" class="text-sm font-semibold">Base Map</h4>
				<div class="max-w-xs grow">
					<BaseMapSwitcher entryId={baseMapId} onSelect={(id) => session.chooseBaseMap(id)} />
				</div>
			</div>
			<div class="h-96 overflow-hidden rounded border border-base-300">
				<BaseMapPane
					entryId={baseMapId}
					overlayPoints={basePoints}
					alignment={solvable}
					{openingFit}
					{distortion}
					{fetchTile}
					onclickpoint={clickBaseMap}
					onwarped={(render) => (warped = render)}
				/>
			</div>
			<!--
				Where the Base Map pane is looking and why (SPEC story 112, ADR-0026). Opening a Historical
				Map moves this pane, and a WebGL canvas announces nothing — so without this the one person
				who cannot see it happen is the one person not told it happened.
			-->
			<p
				class="mt-2 min-h-5 text-sm text-base-content/70"
				aria-live="polite"
				aria-atomic="true"
				data-testid="alignment-opening-view"
				data-opening-view={openingOutcome}
			>
				{#if openingOutcome === 'control-points'}
					Framed on this Historical Map’s Control Points, where the work was left.
				{:else if openingOutcome === 'content'}
					No Control Points yet, so the Base Map is framed on this Project’s own content.
				{:else if openingOutcome === 'default'}
					No Control Points yet and nothing else placed on the earth, so the Base Map is on the
					default view.
				{/if}
			</p>
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
