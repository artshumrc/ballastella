<script lang="ts">
	// The Map Image beside the Base Map, and the pairing between them (SPEC stories 30 and 32–37).
	//
	// This is the core act of the application: click a feature on the map, click the same place on
	// the earth, and a numbered Control Point pair appears. Both panes are on one page, which is why
	// `EditorSession` holding the only in-memory copy of `project.json` matters — two panes
	// serialising their own snapshot back would be a race inside a single component.
	//
	// The Alignment is written on discrete acts and gesture ends only (ADR-0017 rule 1), from here,
	// so there is exactly one place that decides an edit is over.

	import {
		BASE_MAP_CATALOG,
		DEFAULT_DISTORTION_VIEW,
		MINIMUM_CONTROL_POINTS,
		MINIMUM_MASK_VERTICES,
		alignmentPath,
		canSolve,
		detectFold,
		imagePaneSourceFor,
		type Alignment,
		type ControlPoint,
		type DistortionView,
		type FetchFn,
		type GeoPoint,
		type ImagePane,
		type OpeningViewFit,
		type ResourcePoint
	} from '@ballastella/core';
	import type { WarpedRender } from '@ballastella/core/render';
	import { BaseMapSwitcher, LeaderLine, type Box } from '@ballastella/ui';
	import Check from '@lucide/svelte/icons/check';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';

	import BaseMapPane, { type BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';
	import { fitToAlignment } from '$lib/base-map/opening-view';
	import MapImagePane from '$lib/image-pane/MapImagePane.svelte';
	import ImageDetails, { type ImageReadout } from '$lib/image-pane/ImageDetails.svelte';
	import type { PaneOverlayPoint } from '$lib/image-pane/ImagePane.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import DistortionControls from './DistortionControls.svelte';
	import { mapImageSourceOf } from './map-source.svelte.js';
	import { AlignmentPairing } from './pairing.svelte.js';
	import TransformationPicker from './TransformationPicker.svelte';

	let {
		session,
		imageId,
		mapName,
		fetchTile,
		baseMapId,
		projectDirectory
	}: {
		session: EditorSession;
		/** Which Map Image of the open Project is being aligned. */
		imageId: string;
		/** What the author called it, for the sentence saying what this screen is (SPEC story 112). */
		mapName: string;
		/** The ADR-0011 shim for the open Project, for both panes' tiles. */
		fetchTile: FetchFn;
		/** The Base Map to show beneath, chosen by the author (ADR-0020). */
		baseMapId: string;
		/** The Project this Alignment was opened from. */
		projectDirectory: string;
	} = $props();

	/**
	 * Where the Map Image being aligned is served from (ticket 07).
	 *
	 * **Resolved here and handed down**, because this is the component that also writes the
	 * Alignment, and the two answers have to be the same one: `session.mapImageSource` is what
	 * `#alignmentAddressFor` reads, so the sheet in the pane and the `resource.id` in the file cannot
	 * name different servers. A pane that resolved this for itself would be a second lookup, and the
	 * two drifting is a Library map drawn correctly and written unresolvable.
	 *
	 * A live derivation rather than a value read once: `remoteOrigins` changes when a map is copied
	 * offline, and from that moment the pane should read the Workspace's own pyramid rather than the
	 * Library's.
	 *
	 * ⚠ **The two-step derive it is built from lives in `map-source.svelte.ts`, and it lives there so
	 * that it can be tested.** Collapsing it back into a single object-valued `$derived` rebuilds both
	 * panes on every unrelated Workspace read, and does it invisibly — the module and
	 * `map-source.svelte.test.ts` between them carry the mechanism and the evidence.
	 */
	const held = mapImageSourceOf(
		(wanted) => session.mapImageSource(wanted),
		() => imageId
	);
	const mapSource = $derived(held.current);

	const paneSource = $derived(imagePaneSourceFor(mapSource));

	let pairing = $state.raw<AlignmentPairing | undefined>(undefined);
	let failure = $state('');
	/**
	 * What the user's answer to a concurrent edit did, or `''` (ticket 07, ADR-0023).
	 *
	 * **Both buttons in that alert remove the alert**, so pressing either dropped focus to `<body>` and
	 * left a keyboard user tabbing in from the top of the page to find out what they had just done —
	 * WCAG 2.4.3, and CONTRIBUTING lists focus management as an acceptance criterion inside every UI
	 * change. This is where focus goes instead, and the same line says what happened, because the two
	 * answers are visually indistinguishable: either way the alert is gone and the Control Point list
	 * is a list of Control Points.
	 *
	 * Same shape as `ProjectHub`'s cache status line, for the same reason and the same rule.
	 */
	let concurrentEditOutcome = $state('');
	let concurrentEditOutcomeLine: HTMLElement | null = $state(null);
	/** Whether "Put their version back instead" is mid-write, so a second press is not a second write. */
	let restoring = $state(false);
	let warped = $state<WarpedRender | null>(null);

	/**
	 * How the warped Map Image is drawn (ADR-0013).
	 *
	 * **Held here and nowhere else.** It is a working view, not a property of the work, so it is
	 * never written to `project.json` and never reaches `EditorSession` — persisted it would become
	 * layer display state under ADR-0002, and a Published Site could then load colourised with a
	 * Reader having no way to interpret it.
	 */
	let distortion = $state<DistortionView>(DEFAULT_DISTORTION_VIEW);

	/**
	 * How opaque the warped Map Image is drawn over the Base Map, `0` to `1`.
	 *
	 * ⚠ **Half, not all, and this is why the control exists.** Three Control Points solve an Alignment,
	 * and the moment one solves the sheet is drawn over exactly the geography it was solved against — so
	 * at full opacity the fourth Control Point is placed on a Base Map the author can no longer see.
	 * Translucent by default keeps both readable, and the slider's `0` uncovers the earth completely
	 * without taking the renderer down: the distortion measure and `warped-status` still have a map to
	 * describe.
	 *
	 * A working view like {@link distortion}, so it is persisted nowhere (ADR-0002, ADR-0013) and every
	 * visit starts translucent.
	 */
	let overlayOpacity = $state(0.5);

	/** The Map Image pane's pyramid and view readout, shown in this screen's sidebar. */
	let readout = $state.raw<ImageReadout | null>(null);

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
	 * Whether "How this works" is open (SPEC story 112).
	 *
	 * Closed by default and persisted nowhere, the same contract {@link checking} has and for ADR-0002's
	 * reason: which explanations are open is a working view.
	 */
	let explaining = $state(false);

	/**
	 * Open or close the disclosure, and **put the drawing back as it was when it closes**.
	 *
	 * Without the second half, switching the overlay on and then closing the disclosure leaves the
	 * Map Image colourised with the only control that turns it off no longer on the page — which is
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
	let maskPreview = $state.raw<readonly ResourcePoint[] | null>(null);

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
	 * guard `EditorSession.open` and `MapImagePane` both need, and for the same reason: the
	 * user can pick another Map Image while this one's Alignment is in flight.
	 */
	let generation = 0;
	let destroyed = false;

	// A pane or Alignment read can finish after route navigation has destroyed this workspace. Neither
	// may build a pairing for a component that is no longer on screen.
	onDestroy(() => {
		destroyed = true;
		generation += 1;
	});

	// Cleared as soon as the Map Image changes, before its pyramid has been read. Control Points
	// from the previous Alignment left drawn over a different image are a coordinate claim about the
	// wrong map, which is the one failure this component must never have.
	$effect(() => {
		void imageId;
		generation += 1;
		pairing = undefined;
		warped = null;
		concurrentEditOutcome = '';
		restoring = false;
		failure = '';
		maskStatus = null;
		maskPreview = null;
		// The mask belongs to one image's pixel space, so its handles must not survive into another's.
		// The distortion view is about *drawing* rather than about a coordinate, so it stays.
		editingMask = false;
		openingFit = null;
		openingOutcome = 'pending';
	});

	/**
	 * Where the Base Map pane is framed when this Map Image is opened (ADR-0026).
	 *
	 * On the Alignment's own Control Points when it has any, so that reopening a half-finished
	 * Alignment lands where the work was left instead of somewhere that has to be navigated away from
	 * every time; on the Project's content when it has none.
	 *
	 * **Once per Map Image opened, and never in response to an edit.** Refitting as Control Points
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
	 * than core's {@link OpeningViewOutcome}, because what it frames on is one Map Image's Control
	 * Points and that is a different sentence.
	 */
	let openingOutcome = $state<'pending' | 'control-points' | 'content' | 'default'>('pending');

	/**
	 * The Map Image the pane has already been framed for.
	 *
	 * A plain `let`: it is written by the code that reads it, and a reactive one would make the fit its
	 * own dependency and then refit on every placed pair.
	 */
	let framedImage = '';

	/**
	 * The pyramid currently on screen **and which Map Image it is of**.
	 *
	 * Driven by the pane rather than read here, because the image's pixel dimensions have to be
	 * exactly the ones being drawn: the Resource Mask defaults to that rectangle, and a second
	 * `createImagePane` on the same `info.json` would be a second answer that can disagree.
	 *
	 * A plain `let` and not `$state`: it is only ever read by {@link reload}, at the moment a button is
	 * pressed, and making it reactive would put `loadAlignment` in a dependency graph it writes to.
	 *
	 * ⚠ **The image id travels with the pane, and that pairing is the guard rather than a line that
	 * clears it.** A pyramid held from a previously opened map would let {@link reload} rebuild this
	 * map's Alignment in the *other* image's pixel space — every Control Point coordinate a claim about
	 * the wrong sheet, with nothing on screen saying so. That used to be prevented by assigning
	 * `undefined` in the effect above, which is a guard no test can fail: delete the line and the whole
	 * suite stays green, because the window it protects is the handful of frames between choosing a map
	 * and its pane finishing loading. Carrying the id makes the mismatch *unrepresentable* at the point
	 * of use instead of relying on a clear happening first.
	 */
	let livePane: { readonly imageId: string; readonly pane: ImagePane } | undefined;

	/**
	 * Read this Map Image's Alignment again, discarding the pairing on screen.
	 *
	 * One caller: putting back a version somebody else wrote. Re-reading rather than reconstructing
	 * from the displaced bytes, so the screen shows what is on disk — and so `readAlignment` resets
	 * the session's baseline, without which the very next drag would be reported as displacing
	 * something all over again.
	 *
	 * Does nothing when the pyramid on hand is another map's — see {@link livePane}. Nothing is the
	 * right answer there: the pane for the map now on screen is still loading, and its own `onpane`
	 * will read the Alignment from disk a moment later anyway.
	 */
	const reload = (): void => {
		const live = livePane;
		if (live?.imageId === imageId) loadAlignment(imageId, live.pane);
	};

	/**
	 * What the session's write-back count stood at when this screen last acted on it, or `null` before
	 * it has looked. A plain `let`: it is written by the effect that reads it.
	 */
	let rebuiltAt: number | null = null;

	/**
	 * Rebuild the pairing when an Edit History has written this Alignment back (ADR-0039).
	 *
	 * **A rebuild and not a patch, and the selection is lost with it.** Control Point ids are minted
	 * per session and are not in the file, so the Alignment that comes back from an undo has fresh
	 * ones and nothing on screen can be matched to it. That is the accepted cost of a Step holding
	 * bytes, and it is why nothing here tries to match the Alignment that arrives against the one on
	 * screen point by point.
	 */
	$effect(() => {
		const written = session.alignmentsWrittenBack;
		const seenBefore = rebuiltAt !== null;
		rebuiltAt = written;
		// The first run is this screen taking the count, not a write-back to answer: the pairing it
		// would rebuild is the one the pane has just read.
		if (seenBefore) reload();
	});

	const loadAlignment = (wanted: string, pane: ImagePane): void => {
		if (destroyed) return;
		livePane = { imageId: wanted, pane };
		const mine = ++generation;
		void (async () => {
			try {
				const stored = await session.readAlignment(wanted, pane.image);
				if (destroyed || mine !== generation) return;
				pairing = new AlignmentPairing(wanted, pane.image, stored);
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
	 * Frame the Base Map pane on this Map Image's Alignment, once (ADR-0026).
	 *
	 * Guarded twice, and both guards earn their place. {@link framedImage} is what makes it *once per
	 * Map Image* — `loadAlignment` runs again whenever the pyramid is re-read, and a second fit
	 * would put the map back where the Alignment starts after the user had panned. `generation` is the
	 * usual stale-read guard: the user can pick another Map Image while this read is in flight,
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

	/**
	 * This Map Image's Edit History (ADR-0039).
	 *
	 * **Keyed by the Map Image and not by the Project**, because that is what an Alignment is keyed by
	 * (ADR-0023): the file belongs to the Workspace and is shared by every Project that draws the map,
	 * so reaching it from a second Project must reach the same history rather than a second one
	 * offering to reverse the same edits twice (SPEC story 5).
	 */
	const history = $derived(session.historyFor(imageId));

	/**
	 * One completed gesture, written, as one Step of that history.
	 *
	 * **One gesture is one Step and nothing is merged** — four Crop corners moved are four Steps
	 * (SPEC story 27), which is what lets a scholar back out of the one corner they got wrong.
	 *
	 * **The pairing is mutated here and the write is what the Step wraps**, which is not a shortcut:
	 * a Step's images are the *file's*, either side of the write, and the pairing is in memory — so
	 * moving the mutation inside the Step would buy nothing and would make the panes wait on a flush
	 * before drawing what the scholar has just done.
	 *
	 * **The write is awaited inside the Step and the Step itself is not**, which is what lets a gesture
	 * end return without waiting on a store write: the `after` image is read the moment the Step's
	 * gesture resolves, so a write fired and forgotten in there would be read before it landed.
	 *
	 * The label is the sentence the control will say — verb, then subject, in the scholar's own words
	 * (SPEC story 42).
	 */
	const asStep = (label: string, current: AlignmentPairing, gesture: () => void): void => {
		gesture();
		void history.step(label, [alignmentPath(imageId)], () =>
			session.writeAlignment(current.alignment)
		);
	};

	/** The Map Image as a Step's sentence names it — `quotedName`'s rule, for a map rather than a Layer. */
	const quotedMapName = $derived(mapName === '' ? 'with no name' : `\u201c${mapName}\u201d`);

	const controlPoints = $derived(pairing?.controlPoints ?? []);

	/** The row's pixel-and-earth readout in full, for the hover title of a row too narrow to show it. */
	const pointReadout = (point: ControlPoint) =>
		`${Math.round(point.resource.x)}, ${Math.round(point.resource.y)} px \u2192 ${point.geo.lng.toFixed(5)}, ${point.geo.lat.toFixed(5)}`;
	const pending = $derived(pairing?.pending ?? null);
	const selectedId = $derived(pairing?.selectedId ?? null);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// The leader (ticket 12, SPEC story 45)
	//
	// **One line, from the Base Map half only**, and the two rules that decide that are both already
	// written down. ADR-0022 contract 4 says a selected Control Point highlights *both* halves, which
	// is what joins the two panes — so a line between the panes would be a second answer to a question
	// already answered, eleven times over on a dense Alignment. And SPEC story 49 says nothing may be
	// drawn over a pane a scholar is clicking to sub-pixel accuracy: a line from the *sheet's* half to
	// the docked column on the right would cross the Base Map pane to get there.
	//
	// So the mark the leader leaves from is the one in the pane adjacent to the column, and that is
	// the Base Map's.
	// ─────────────────────────────────────────────────────────────────────────────────────────

	/** The Base Map pane, for the one thing this screen asks of its camera. */
	let baseMapPane = $state<BaseMapPane | undefined>();
	/** The two boxes the leader is drawn between. `$state` for the reason `ProjectScreen` records. */
	let controlPointColumn = $state<HTMLElement | undefined>();
	let baseMapFrame = $state<HTMLElement | undefined>();

	/** The selected pair's ordinal, which is the identity both ends of the line are found by. */
	const selectedOrdinal = $derived(
		controlPoints.find((point) => point.id === selectedId)?.ordinal ?? null
	);

	/**
	 * The selected pair's Base Map half, drawn by `overlay-points.ts` outside this component's tree.
	 *
	 * Measured here rather than in `LeaderLine`, which takes a box: a Control Point really is a DOM
	 * marker, so its box is its own rectangle, whereas an Annotation is painted into a canvas and its
	 * box has to be projected. One prop, two ways of arriving at it.
	 */
	const selectedMark = (): Box | null =>
		selectedOrdinal === null || !baseMapFrame
			? null
			: (baseMapFrame
					.querySelector(
						`[data-testid="pane-overlay-point-control-point"][data-ordinal="${selectedOrdinal}"]`
					)
					?.getBoundingClientRect() ?? null);

	/** Its row in the docked column. */
	const selectedRow = (): Element | null =>
		selectedOrdinal === null || !controlPointColumn
			? null
			: (controlPointColumn
					.querySelector(
						`[data-testid="control-point-row-ordinal"][data-ordinal="${selectedOrdinal}"]`
					)
					?.closest('[data-testid="control-point-row"]') ?? null);

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
	const halfLabel = (ordinal: number | undefined, side: 'Map Image' | 'Base Map'): string =>
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
			label: halfLabel(point.ordinal, 'Map Image'),
			selected: point.id === current.selectedId,
			onselect: () => current.toggleSelected(point.id),
			ondelete: () =>
				asStep(`Undo delete of Control Point ${point.ordinal}`, current, () =>
					current.remove(point.id)
				),
			onmoveend: (to) =>
				asStep(`Undo move of Control Point ${point.ordinal}`, current, () =>
					current.moveResource(point.id, to)
				)
		}));

		const waiting = current.pending;
		if (waiting?.resource) {
			points.push({
				key: waiting.id,
				point: waiting.resource,
				kind: 'control-point',
				pending: true,
				label: halfLabel(undefined, 'Map Image'),
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
			onmove: (to) => {
				maskPreview = current.resourceMask.map((vertex, at) => (at === index ? to : vertex));
			},
			onmoveend: (to) => {
				asStep(`Undo the Crop of ${quotedMapName}`, current, () => {
					current.moveMaskVertex(index, to);
					maskPreview = null;
					// Rounded, because the sentence is "the corner went where I pushed it" and not a
					// coordinate readout — and a nudge is one screen pixel, which is a sub-pixel move when
					// the pane is zoomed out.
					maskDone(
						`Resource Mask corner ${index + 1} moved to ${Math.round(to.x)}, ${Math.round(to.y)}.`
					);
				});
			},
			ondelete: () => {
				// Refused rather than silently ignored: a keypress that appears to do nothing is
				// indistinguishable from a broken handle. Asked before the Step opens, so a refusal does
				// not spend one on a mask that is unchanged.
				if (!current.canRemoveMaskVertex) {
					maskStatus = {
						kind: 'refused',
						message:
							`A Resource Mask needs at least ${MINIMUM_MASK_VERTICES} corners, so this one cannot ` +
							'be removed. Move it instead, or show the whole sheet again.'
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
			// The affordance is activation, not dragging: a handle that both inserted and moved would
			// make "I nudged it" and "I added one" the same gesture. The help text and the cursor say so
			// — see the summary below and `layout.css` — because an affordance the pointer advertises and
			// the code refuses reads as a broken handle rather than as a deliberate choice.
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
			ondelete: () =>
				asStep(`Undo delete of Control Point ${point.ordinal}`, current, () =>
					current.remove(point.id)
				),
			onmoveend: (to) =>
				asStep(`Undo move of Control Point ${point.ordinal}`, current, () =>
					current.moveGeo(point.id, to)
				)
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

	const clickMapImage = (point: ResourcePoint): void => {
		const current = pairing;
		if (!current) return;
		// Written only when a pair actually came into existence. Placing the *first* half writes
		// nothing at all, which is what makes Escape leave no trace on disk. **Not "no file"** — since
		// ADR-0023 there has been an `alignments/<id>.json` from the moment the Map Image was
		// added, so what a mis-started pair must not do is *touch* it: no write, not even one whose
		// bytes would come out the same. In a Workspace kept in git or Dropbox a rewrite is a change to
		// sync whatever it says, which is why the test beside this counts writes and not only bytes.
		//
		// And by the same rule it is only the completing click that opens a Step: a half nobody
		// finished changed no file, so there is nothing to put back.
		if (current.pending?.half !== 'geo') {
			current.clickMapImage(point);
			return;
		}
		asStep(placingLabel(current), current, () => current.clickMapImage(point));
	};

	const clickBaseMap = (point: GeoPoint): void => {
		const current = pairing;
		if (!current) return;
		if (current.pending?.half !== 'resource') {
			current.clickBaseMap(point);
			return;
		}
		asStep(placingLabel(current), current, () => current.clickBaseMap(point));
	};

	/**
	 * What the bar will say about the pair this click is completing.
	 *
	 * Read before the click lands, because the ordinal is the pair's position in the list (ADR-0022)
	 * and the pair being made goes on the end.
	 */
	const placingLabel = (current: AlignmentPairing): string =>
		`Undo placing Control Point ${current.controlPoints.length + 1}`;

	const removePair = (id: string): void => {
		const current = pairing;
		if (!current) return;
		const point = current.controlPoints.find((one) => one.id === id);
		if (!point) return;
		asStep(`Undo delete of Control Point ${point.ordinal}`, current, () => current.remove(id));
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
		┌───────────────────────────────────────────────────────────────────────────────────────────┐
		│ THE PANES ARE THE WORK, SO THE PANES GET THE HEIGHT.                                       │
		└───────────────────────────────────────────────────────────────────────────────────────────┘
		Two canvases beside each other, and everything that is *about* them in a column of its own.
		Every part of this screen used to be one scrolling stack: the panes were a fixed 24rem each and
		the prose grew above them, so a tall display made the words taller and the maps no bigger, and a
		short one pushed the sheet under the fold. The measurement recorded further down — a sentence
		moved above the panes and `editor-alignment.e2e.ts`'s drag went red because the handles were
		outside the viewport — is that failure with a number on it.

		**Desktop is a fixed sidebar and the panes take what is left**, which is `ProjectScreen`'s
		arrangement and for its stated reason: a proportional sidebar grows with the display, and on a
		large one that is a wall of controls beside maps that gained nothing.

		**Mobile is the same DOM in the other direction** — panes first at a fixed share of the viewport,
		the column beneath them as a footer — so visual order and reading order agree at both
		breakpoints. That is why the sidebar is on the right and after the panes in the markup: putting
		it on the left would mean `lg:order-first`, and a keyboard user tabbing into a column that reads
		second and sits first is a defect this app does not get to introduce for a preference.

		The route's own container scrolls, so nothing here is ever *cut off*: on a display too short for
		the minimums below, the page grows and scrolls exactly as it used to.
	-->
	<!--
		`relative` establishes the containing block the leader's own layer is `inset-0` of — it spans the
		panes and the Control Point column together, which is why it is a child of this element rather
		than of either.
	-->
	<div class="relative flex min-h-0 grow flex-col gap-4 lg:flex-row lg:gap-0">
		<!--
			The pane column. `shrink-0` until `lg`, where the two sit side by side and each takes half:
			without `min-w-0` a WebGL canvas's own width wins the flex negotiation and the pair overflow
			the row.

			No gutter between this column and the Control Point column at `lg`: the two are adjacent and
			the border between them is what separates them, which is the arrangement `ProjectScreen`'s
			Layer sidebar already has. A gutter would read as a panel sitting beside the maps rather than
			a column docked to them.
		-->
		<div class="flex shrink-0 flex-col gap-4 lg:min-h-0 lg:min-w-0 lg:shrink lg:grow lg:flex-row">
			<!--
				⚠ **`lg:flex-1` and never `lg:grow`, and that is what makes the panes exactly equal**
				(SPEC story 48). `flex-1` is `flex: 1 1 0%`: both panes start from nothing and split the
				row, so neither can be widened by what is written above it. `grow` leaves the basis `auto`,
				which measures each pane's own content first and hands out only the *remainder* equally —
				and on this screen the two panes' contents differ, because the Base Map's heading carries a
				Base Map switcher and an opacity slider and the Map Image's carries a checkbox. Drawn
				that way on this repository's own mockups the pair measured 308 px and 378 px.

				That is not a preference. Neither the sheet nor the earth may be privileged by the layout:
				a scholar comparing a feature across the two panes is comparing two views of one place, and
				a wider pane is a claim that one of them matters more. `editor-align-route.e2e.ts` measures
				the rendered boxes at 768 px, 1120 px and 1440 px rather than reading the class name.
			-->
			<section
				aria-labelledby="map-image-pane-heading"
				class="flex shrink-0 flex-col lg:min-h-0 lg:min-w-0 lg:flex-1"
			>
				<!--
					The same pane story 31 already delivers, now carrying Control Points. It loads the
					pyramid and reports it through `onpane`, which is what the Alignment's Resource Mask and
					coordinate space are built from — reading the same `info.json` a second time here would
					be a second answer that can disagree with what is being drawn.

					`frameClass` is where this screen's answer to "how tall is a pane" is stated: it grows into
					the column on a desktop, and takes a fixed share of the viewport below `lg`. The `min-h`
					floor is the point at which growing stops being the better answer — below it the sheet is
					too small to aim a Control Point at, so the page scrolls instead of squeezing further.
				-->
				{#snippet cropControls()}
					<div class="flex flex-1 items-center justify-evenly">
						<h4 id="map-image-pane-heading" class="text-sm font-semibold">Map Image: {mapName}</h4>
						<!--
							Crop: the Resource Mask's handles, on or off.

							**In the pane's own control row**, because it acts on the sheet in that pane — it was a row of
							its own underneath, one line high, on the screen with two
							live panes competing for height. **"Crop" rather than "Outline the part of the sheet that is
							the map"**: the sentence was the label, and a sentence-long label in a row of verbs reads as
							prose rather than as a control. What it does is still said in full — in the summary under the
							pane, which is where the gestures and the corner count already are.
						-->
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
									class="btn btn-ghost btn-sm"
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
									Show the whole sheet again
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
					onclickpoint={clickMapImage}
					onpane={(pane) => loadAlignment(imageId, pane)}
					onreadout={(current) => (readout = current)}
					controls={cropControls}
				/>

				{#if pairing}
					<!--
						The Resource Mask (SPEC stories 46 and 47): which part of this sheet is actually the map.

						The outline is always drawn — dimming what it leaves out, so the user can see what the
						Alignment excludes whether or not they are changing it — and the handles are asked for,
						because eight of them over a sheet you are placing Control Points on is noise and a
						mis-aimed click is a moved outline.

						**Under this pane and not in the sidebar**, because a Resource Mask is in one image's pixel
						space: it is a property of the sheet above it rather than of the Alignment, and its handles are
						on that canvas. The toggle itself is up in the pane's own control row — see `cropControls`.
					-->
					<div
						class="mt-2 flex shrink-0 flex-col gap-1"
						data-testid="resource-mask-controls"
						data-mask-vertices={pairing.resourceMask.length}
					>
						{#if editingMask}
							<!--
								What can be done to the outline, **only while Crop is on**.

								The line that said what the mask *is* — "n corners. Everything outside the outline is
								left out…" — is gone: a control labelled Crop explains itself, and it was a permanent
								line of prose on the screen with the least height to spare.

								**These are instructions for a gesture in progress, which is a different thing, and the
								two handles do two different things.** A corner is dragged; a dashed handle is
								*activated* and adds a corner where it sits. Ticket 08's own note is why — "a handle
								that both inserted and moved would make 'I nudged it' and 'I added one' the same
								gesture" — and an earlier version of this said "drag a dashed handle to add one", which
								is a gesture the code deliberately refuses. On a teaching tool a promised gesture that
								does nothing reads as a broken handle.
							-->
							<p class="text-sm opacity-70" data-testid="mask-summary">
								{pairing.resourceMask.length} corners. Drag a corner to move it. Click a dashed handle
								to add a corner there. Arrow keys move the corner you have focused; Delete removes it.
							</p>
						{/if}

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

			<section
				aria-labelledby="base-map-pane-heading"
				class="flex shrink-0 flex-col lg:min-h-0 lg:min-w-0 lg:flex-1"
			>
				<!--
					The Base Map heading and the choice of Base Map, together.

					**Here because this is where the wrong one is discovered.** The deployment default is a
					regional extract (ADR-0020), so an author aligning a sheet of anywhere outside its bounds
					zooms in and watches the earth go blank — and the switcher lived only on the Layers pane,
					behind a button labelled with a Layer count, which says nothing about Base Maps. The
					control belongs beside the pane whose emptiness sends you looking for it — which is also
					why it stayed out of the sidebar when everything else about the Alignment moved into one.

					It writes through `session.chooseBaseMap`, the same one every other switcher calls, so the
					choice is the Project's author default (ADR-0020) rather than a third copy of that state.
				-->
				<div class="mb-2 flex flex-wrap items-center justify-evenly lg:flex-nowrap">
					<h4 id="base-map-pane-heading" class="text-sm font-semibold">Base Map</h4>
					<!--
						The switcher's own label is `sr-only` here, and only here: the heading to its left already
						says "Base Map", so on screen it was the word twice and a line of height for the second one.
						The `<select>` keeps its accessible name.
					-->
					<div class="w-80 max-w-full">
						<BaseMapSwitcher
							entryId={baseMapId}
							catalog={BASE_MAP_CATALOG}
							class="w-full"
							labelSrOnly
							onSelect={(id) => session.chooseBaseMap(id)}
						/>
					</div>
					<!--
						How much of the sheet is drawn over the earth — in this pane's header, in the room the
						repeated label gave back, so it costs the map no height at all.

						Shown only once there is something to fade: with fewer than three Control Points nothing is
						warped, and a slider over an empty Base Map is a control with no referent.
					-->
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
								<!--
								Fixed width and right-aligned, because the row moved as the number grew a digit. `100%`
								is as wide as this ever gets, so reserving it is what stops the slider shifting under
								the pointer that is dragging it.
							-->
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
				<!-- The Map Image frame reserves this header's height, keeping the canvases top-aligned. -->
				<div
					bind:this={baseMapFrame}
					class="h-[45dvh] overflow-hidden rounded-box border border-base-300 lg:h-auto lg:min-h-64 lg:grow"
				>
					<BaseMapPane
						bind:this={baseMapPane}
						entryId={baseMapId}
						overlayPoints={basePoints}
						alignment={solvable}
						alignmentSource={mapSource}
						{openingFit}
						{distortion}
						{fetchTile}
						onclickpoint={clickBaseMap}
						alignmentOpacity={overlayOpacity}
						onwarped={(render) => (warped = render)}
					/>
				</div>
				<!--
					Where the Base Map pane is looking and why (SPEC story 112, ADR-0026). Opening a Map
					Image moves this pane, and a WebGL canvas announces nothing — so without this the one person
					who cannot see it happen is the one person not told it happened.

					`sr-only`, because that person is the only one it tells anything: a sighted author watched the
					pane move, and the sentence was three lines of prose charged to the map's height. Still in the
					DOM, still a live region, still announced — read out rather than printed.
				-->
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

		<!--
			Everything that is about the pairing rather than about one pane: the prompt, the warnings, the
			transformation, the Control Points, and who else this Alignment belongs to.

			A fixed 24rem column that scrolls on its own at `lg`, so a long Control Point list cannot take
			height away from the maps it is a list of — the failure the whole of this arrangement exists to
			remove. Below `lg` it is a footer under the panes and the page scrolls as one.

			┌───────────────────────────────────────────────────────────────────────────────────────────┐
			│ SOLID AND DOCKED, AND ON THIS SCREEN THAT RULE IS ABSOLUTE (SPEC story 49).                │
			└───────────────────────────────────────────────────────────────────────────────────────────┘
			`bg-base-300` rather than the page's own background showing through: a scholar is placing
			Control Points to sub-pixel accuracy on the two canvases to the left, so this column must be
			a surface of its own that nothing is drawn through, and it must be in the flow beside them
			rather than over them. It is the same `base-300` column, with the same `base-content/10`
			border, that `ProjectScreen` docks its Layer stack in — one arrangement, not two.
		-->
		<div
			bind:this={controlPointColumn}
			class="flex shrink-0 flex-col gap-3 bg-base-300 p-4 lg:min-h-0 lg:w-96 lg:overflow-y-auto lg:border-l lg:border-base-content/10"
			data-testid="alignment-sidebar"
		>
			<!--
				The pending prompt. `role="status"` is already taken by the save indicator on this page, so
				this is an `aria-live` region — which is also why the ingest progress region is one. `atomic`,
				so it is read as a whole sentence rather than as the words that changed.

				First in the column, because it is the sentence that answers "what do I click next" and it is
				read after every half-pair. It is also why the column is not allowed to be the thing that
				scrolls off: on a phone this is the line under the maps, not two screens below them.
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

			<!--
				What this screen is, in words, behind a disclosure (SPEC story 112).

				A WebGL canvas announces its own accessible name and nothing about what the pair of them is
				*for*, and "Map Image" beside "Base Map" does not tell a screen-reader user that clicking
				one and then the other is the gesture. Visible text and not a tooltip (ADR-0016).

				Closed by default and under the prompt rather than above it: the prompt is the sentence that
				says what to click next, and a scholar who has placed a Control Point before does not need
				to be told what the two panes are again.

				**Everything this screen explains without being asked is in here** (SPEC stories 62, 67):
				one sentence about the gesture, the limit of Simple, and what the advanced transformations
				cost. Text, never a tooltip and never CSS-generated content (ADR-0016) — the align spec
				asserts the absence of both.
			-->
			<div>
				<button
					type="button"
					class="btn btn-ghost btn-sm"
					aria-expanded={explaining}
					aria-controls={explaining ? 'align-explainer' : undefined}
					data-testid="align-explainer-toggle"
					onclick={() => (explaining = !explaining)}
				>
					How this works
				</button>

				{#if explaining}
					<div
						id="align-explainer"
						class="mt-2 flex max-w-prose flex-col gap-2 text-sm opacity-70"
						data-testid="align-explainer"
					>
						<p>
							Click a feature on the Map Image and then the same place on the earth to make a
							Control Point pair; with enough pairs the Map Image is drawn over the Base Map.
						</p>

						<!--
							**The one place the fold warning cannot help.** A similarity has no reflection to fit,
							so a least-squares solve over two swapped Control Points comes back unmirrored rather
							than folded and `detectFold` correctly reports nothing. That is right mathematics and
							not a defect — but it is a *silence*, and a student who has learnt to trust "this
							Alignment is mirrored" under Standard will read the same silence here as "no mistake".

							Not folded into Simple's own guidance text, because that string is ADR-0013's table and
							is asserted verbatim; this is a note about the consequence of the choice, like the one
							below it.
						-->
						<p data-testid="transformation-simple-note">
							Simple cannot turn the Map Image over, so it is the one choice where the "this
							Alignment is mirrored" warning cannot appear. Under Simple, two swapped Control Points
							show up as a badly placed Map Image rather than as a warning.
						</p>

						<p data-testid="transformation-advanced-note">
							Higher-order transformations bend the map more freely, and need many well-spread
							Control Points. With few or clustered points they produce spectacular distortion at
							the edges.
						</p>
					</div>
				{/if}
			</div>

			<!--
		An Alignment that changed somewhere else while it was open here (ticket 07, ADR-0023).

		ADR-0023 makes an Alignment the Workspace's, shared by every Project that draws the map, and
		accepts that a Workspace kept in git or Dropbox can therefore receive a colleague's edit between
		this session's read and its write. The mitigation it asks for is **visibility, not prevention**:
		the save has already happened — refusing it would discard the work in front of the user to
		protect work they cannot see — and this is where they are told, and offered the other version.

		`role="alert"` rather than a polite region, and it stays until dismissed. It is the one thing on
		this screen the user cannot find out any other way: nothing moved, nothing failed, and the save
		indicator says "Saved". It is only shown for the map on screen, because the button beside it
		writes that map's file.
	-->
			{#if session.alignmentChangedElsewhere?.imageId === imageId}
				<div
					role="alert"
					class="alert flex-col items-start alert-warning"
					data-testid="alignment-changed-elsewhere"
				>
					<p class="max-w-prose">
						Somebody else changed this Map Image’s Alignment while you had it open — through a
						Workspace shared with this one — and your edit has just been saved over theirs. A Map
						Image has one Alignment, shared by every Project that draws it, so there is only ever
						one file to change.
					</p>
					<div class="flex flex-wrap gap-2">
						<button
							class="btn btn-sm"
							data-testid="restore-changed-elsewhere"
							disabled={restoring}
							onclick={async () => {
								// **Guarded against a second press, because the answer is a write.** The restore now
								// waits behind whatever is already writing this map's file, so the alert — and this
								// button — stay on screen for the whole wait, and a double-click queued two identical
								// `replace` writes of the same bytes. Idempotent on disk, and still wrong in the one
								// place ADR-0023 cares about: a Workspace kept in git or Dropbox syncs a rewrite
								// whatever it says.
								if (restoring) return;
								restoring = true;
								// **Which map this answer is about**, because the restore waits behind whatever is
								// already writing this map's file and the user can navigate inside that wait. The
								// re-read and the effect above both handle that correctly on their own; the
								// *sentence* did not, and it is the half that speaks. Without this, a navigation
								// landing inside one store write announced "their version is back — the list below
								// is what is on disk now" over a different Map Image's Control Points, and
								// took focus to say it.
								const answering = imageId;
								try {
									// **Branched on what actually happened**, never announced in advance. A failure
									// leaves the alert standing and `saveError` set, and the sentence below is read out
									// loud to the one user who cannot see that contradiction — so claiming success over
									// it is the worst version of this control.
									const restored = await session.restoreAlignmentChangedElsewhere();
									// The right file was still written either way — that is the session's business and
									// it is keyed by image id. What is dropped here is only the announcement.
									if (destroyed || answering !== imageId) return;
									if (restored) {
										// Re-read, so the pane shows what is now on disk rather than the pairing that was
										// just discarded. Without this the screen keeps drawing the Control Points the
										// user chose to give up, and the next drag writes them back.
										reload();
									}
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
							}}
						>
							Put their version back instead
						</button>
						<button
							class="btn btn-ghost btn-sm"
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
				</div>
			{/if}

			<!--
		What the answer above did, and where focus lands when the alert that asked removes itself.

		Always rendered and empty when there is nothing to say — the rule every live region in this app
		follows, and the one the offline notice in `MapImagePane` had to be reshaped to obey: a
		region inserted together with its first text is not reliably announced.
	-->
			<p
				bind:this={concurrentEditOutcomeLine}
				tabindex="-1"
				aria-live="polite"
				class="max-w-prose text-sm opacity-80"
				data-testid="changed-elsewhere-outcome"
			>
				{concurrentEditOutcome}
			</p>

			<!--
		The fold warning (ADR-0013): "the single most useful piece of feedback a student can receive."

		Above the transformation controls and not tucked beside the distortion toggles, because it is
		about the Alignment being wrong rather than about how it is drawn — and it appears with the
		overlay off, which is its whole point. It is near the top of this column with the other alerts,
		so that on a phone, where the column is a footer, it is the first thing under the maps. `role="alert"` rather than a polite region: an Alignment that has folded over
		itself is a mistake the user is currently making, and the next thing they do is place another
		point on top of it.
	-->
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

			<!--
		The Control Points as a list. Not decoration: it is the keyboard and screen-reader path to
		every pairing action ADR-0022 asks for, and it is where the ordinals are unambiguously
		readable — the numbers drawn on the map are small, and on a dense Alignment they overlap.

		**The one thing in this column that is allowed to be long**, which is why the column scrolls and
		the panes do not: a fifty-point Alignment used to add fifty rows to the height of the page, and
		the page was the same scrolling stack the maps were in.
	-->
			<section aria-labelledby="control-points-heading">
				<h4 id="control-points-heading" class="text-sm font-semibold">
					Control Points ({controlPoints.length})
				</h4>

				{#if controlPoints.length === 0}
					<p class="mt-1 text-sm opacity-70">None yet.</p>
				{:else}
					<ul class="mt-2 flex flex-col gap-1" data-testid="control-point-list">
						{#each controlPoints as point (point.id)}
							<li class="flex items-center gap-2 text-sm" data-testid="control-point-row">
								<!--
							Selecting from here highlights *both* halves, which is the same state the map
							points read — so the cross-pane highlight has a keyboard route as well as a
							pointer one. `aria-pressed` because it is a toggle, not a navigation.
						-->
								<button
									class="btn shrink-0 btn-xs"
									class:btn-secondary={point.id === selectedId}
									aria-pressed={point.id === selectedId}
									data-testid="control-point-select"
									data-ordinal={point.ordinal}
									onclick={() => pairing?.toggleSelected(point.id)}
								>
									<!--
										**The number the marker already wears, on the row** (SPEC story 44). Both halves
										of this pair draw `point.ordinal` inside themselves as text — see
										`.pane-overlay-point-control-point` — and this is that number's third
										appearance, so that "point 7" identifies one pair across a desk whether the
										listener is looking at a canvas or at the list.

										**A `<span>` of its own inside the button, at `tabular-nums`**, which is the
										marker's own `font-variant-numeric` and `AnnotationRow`'s treatment of the same
										idea on the Project screen: a column of ordinals that do not shift as they gain
										a digit is what makes the list scannable. Inside the button rather than beside
										it, so a screen reader hears "Point 7" as one name and nothing about which pair
										is which depends on seeing the canvas.

										⚠ **Nothing writes it.** `ControlPoint.ordinal` is the pair's position in the
										Alignment's list, derived on read and on collect and stored nowhere — a
										Georeference Annotation has no place to put an index, and inventing one would be
										the proprietary field ADR-0002 and SPEC story 94 both rule out. Deleting point 3
										of 5 renumbers the two after it because this list renders again.
									-->
									Point
									<span
										class="tabular-nums"
										data-testid="control-point-row-ordinal"
										data-ordinal={point.ordinal}>{point.ordinal}</span
									>
								</button>
								<code class="min-w-0 flex-1 truncate opacity-70" title={pointReadout(point)}>
									{Math.round(point.resource.x)}, {Math.round(point.resource.y)} px →
									{point.geo.lng.toFixed(5)}, {point.geo.lat.toFixed(5)}
								</code>
								<!--
								**A glyph that looks like a button and looks destructive** (SPEC story 65,
								ADR-0016's icon amendment). This is the one place on this screen where a mis-click
								destroys work. `btn-outline btn-error` draws the glyph and a border in `error`
								without a fill, which is what this repository gives an in-row destructive action;
								the solid `btn-error` is reserved for the confirm button inside a destructive
								dialog. `btn-sm` rather than `btn-xs`, because `btn-xs` is a 24×24 target sitting
								exactly on WCAG 2.2 AA 2.5.8's floor for the only unconfirmed destructive control
								here.

								**The name is text and it names which point.** `sr-only` beside an
								`aria-hidden` glyph, never a `title`: a `title` is not announced reliably and
								cannot be dismissed, and specs reach this control by accessible name.

								No confirmation. Undo is the safety net ADR-0022's flow assumes, and it names
								what it will put back.
								-->
								<button
									type="button"
									class="btn btn-square shrink-0 btn-outline btn-error btn-sm"
									data-testid="control-point-delete"
									onclick={() => removePair(point.id)}
								>
									<Trash2 size={13} aria-hidden="true" />
									<span class="sr-only">Delete Control Point {point.ordinal}</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			{#if pairing}
				<!--
			How the map is stretched, and how that is drawn. Two groups rather than one: the
			transformation type is part of the Alignment and is written to disk, and the distortion view
			is a working view that is deliberately not (ADR-0013). Keeping them apart is what stops the
			conflation that puts a debugging toggle in a Published Site — they were two columns of a row
			when this screen was full-width, and they are two blocks of one column now that it is 24rem.
		-->
				<div class="flex flex-col gap-4">
					<div class="min-w-0">
						<TransformationPicker
							value={pairing.transformationType}
							controlPointCount={controlPoints.length}
							onchoose={(type) => {
								const current = pairing;
								if (!current) return;
								// Every Control Point survives, because this touches one field. Written now rather
								// than on a timer: choosing a type is a discrete act (ADR-0017 rule 1).
								asStep(`Undo the transformation of ${quotedMapName}`, current, () =>
									current.setTransformationType(type)
								);
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

				**The fold warning is deliberately not in here.** It is above this control, it runs whether or
				not this is open, and it is a correctness warning about a contradictory Control Point rather
				than a way of drawing one. Folding it in would hide the one piece of feedback ADR-0013 calls
				the most useful a student can receive behind a control they have no reason to open.
			-->
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

			<!--
		What the warped renderer did. Said rather than left to look like an empty map, because the
		upstream defect in `@allmaps/render` (see `warped-map-layer.ts`) makes the failure silent:
		tiles fail inside a worker and the errors are swallowed, so without this the user sees a Base
		Map with nothing on it and no reason given.
	-->
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
					{needed - controlPoints.length} more Control {needed - controlPoints.length === 1
						? 'Point'
						: 'Points'} and the Map Image will be drawn over the Base Map.
				{/if}
			</p>

			<!--
				What is being drawn, as numbers, last in the column because it is a diagnostic.

				It was under the sheet, which is the one place on this screen where four rows of numbers cost
				the map its height. Absent until there is a pyramid to describe, rather than showing a
				disclosure over nothing.
			-->
			{#if readout}
				<ImageDetails {...readout} />
			{/if}

			<a
				class="btn mt-auto w-full shrink-0 btn-lg btn-primary"
				href="{resolve('/')}?p={encodeURIComponent(projectDirectory)}"
				data-testid="alignment-done"
			>
				<Check class="size-5" aria-hidden="true" />
				Done
			</a>
		</div>

		<!--
			The leader, last so that it paints over the panes and the column (SPEC story 45).

			**One line, and it leaves from the Base Map half** — the reasoning is in the script, and its
			two halves are ADR-0022 contract 4 (the pairing highlight already joins the two panes) and
			SPEC story 49 (nothing is drawn over a pane being clicked to sub-pixel accuracy).

			Below `lg` this is a stack, the column sits under the maps, and `LeaderLine` measures that and
			draws nothing.
		-->
		<LeaderLine
			mark={selectedMark}
			row={selectedRow}
			canvas={() => baseMapFrame}
			sidebar={() => controlPointColumn}
			watch={(redraw) => baseMapPane?.onCameraMove(redraw) ?? (() => {})}
		/>
	</div>
{/if}
