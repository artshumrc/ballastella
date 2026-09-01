<script lang="ts">
	// The Project's ordered stack, as a user reads and edits it.
	//
	// **Custom, and necessarily so.** No library provides drag-to-reorder, so this list is hand-built
	// either way — and because Layer order is load-bearing in this application (ADR-0002), a drag-only
	// implementation would make core functionality keyboard-inaccessible. So the move-up and move-down
	// buttons are the contract and the drag is the convenience, not the reverse (ADR-0016).
	//
	// Every control here is a native element: `<input type="range">` for opacity and `<input
	// type="checkbox">` for visibility are ADR-0016's mandated methods, and a `<button>` is a button.
	// There is nothing to trap focus in and nothing to reimplement.
	//
	// The list is an `<ol>`, so its structure *and* its order reach assistive technology from the
	// markup rather than from a label somebody has to remember to update.
	//
	// **One row opens at a time, in place.** A Project is a stack of Layers and a Layer opens to reveal
	// its contents — a Map Image's alignment state and the button that aligns it, an Annotation Layer's
	// tools and Annotations — which is one idea applied twice rather than two panels that have to be
	// kept agreeing.
	//
	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// EVERY WRITE IS AN OPTIONAL CALLBACK, AND THERE IS NO `readOnly` PROP
	//
	// Both apps render this stack, and the difference between them is *absence*: a control a consumer
	// does not want is a callback that consumer does not pass. `ontypename`/`oncommit` carry the rename
	// pencil, `onmove` the two reorder buttons and the drag handle, `ondelete` the Delete,
	// `ondragopacity` the opacity slider and `onshow` the visibility toggle. Each is optional; each
	// guard below tests the prop it belongs to and nothing else.
	//
	// **`oncommit` is the one prop that is not a single control's.** It ends whichever edit was in
	// flight (ADR-0017 rule 1), and two of them are: leaving the rename field *and* releasing the
	// opacity slider. So it is paired with `ontypename` behind the pencil, and it is also what the
	// range's `onchange` calls — a consumer passing `ondragopacity` without it would get a slider that
	// reports every position it is dragged through and never commits one. No consumer does that, so
	// there is one prop rather than two; this is the note that says so, because `oncommit` otherwise
	// reads as the rename's alone.
	//
	// ⚠ **Do not add a `readOnly`, `mode` or `editable` boolean.** A flag and a set of callbacks are two
	// descriptions of the same thing, and the failure is not hypothetical: the moment they can disagree,
	// `readOnly` false with no `ondelete` renders a button that throws, and `readOnly` true with an
	// `ondelete` renders one that quietly works. An absent callback cannot be got wrong in either
	// direction, because the control and the thing it calls arrive together or not at all.
	//
	// `layers`, `outcomes`, `openLayerId` and `onopen` stay required: they are what makes this a stack a
	// reader can look through rather than a list, and no consumer has a reason to omit them.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHAT A CLOSED CARD SHOWS, AND WHY IT IS NOW SO LITTLE
	//
	// A closed row used to carry eleven controls: a drag handle, the position as "2/3", an
	// Open button, a visibility toggle with the word "Show", the name as a bordered text field, Move
	// up, Move down, Delete, the kind, the tiles badge, and the opacity slider with its percentage.
	// Two consequences, both reported by the person this is for: the cards were hard to tell apart —
	// three bordered text fields stacked in a column read as a form, not a stack — and the one thing a
	// user actually scans for, *what this Layer is*, arrived tenth, as grey text under the name.
	//
	// So a closed card carries four things and a warning:
	//
	//   • **what kind of Layer it is** — an icon and the words, at the top, in the card's own tint
	//   • **what it is called**, as text rather than a field
	//   • **whether it is showing**, as the toggle
	//   • **the way in**, as the chevron
	//   • **whatever it is warning about**, as a band across the foot of the card — because a map that
	//     needs aligning is the state a user has to be able to notice *without opening anything*
	//
	// Everything else — the name field, the opacity, where the tiles come from, the reorder buttons and
	// the delete — is inside the open card. Nothing was removed from the screen; the closed card stopped
	// being the place all of it lives at once.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// THE TINT IS THE THING THAT MAKES TWO CARDS DIFFERENT
	//
	// The card is `base-100` on the sidebar's `base-300`, which is the arrangement that separates in
	// *both* themes without a special case: daisyUI's scale runs 100% → 98% → 95% in light and 25% →
	// 23% → 21% in dark, so a `base-100` card is the lighter surface either way. Before this, sidebar
	// and card were both `base-100` with a `base-300` hairline — invisible in light, and in dark a
	// border darker than either surface, which reads as a smudge rather than an edge. `ProjectScreen`
	// owns the column and records the luminance steps that decided `base-300` over `base-200`.
	//
	// The card's own edge is an ink hairline and there is no drop shadow: a `base-300` border is the
	// column's exact colour, so along the bottom of a card it read as a stray beige line rather than
	// an edge, and the shadow under it only made that line look thicker.
	//
	// On top of that the header carries a tint of the Layer kind's own colour — `accent` for a
	// Map Image, `info` for Annotations — so that two cards of different kinds differ before a
	// word has been read, and **everything else in that card is in the same colour**: its toggle, its
	// opacity slider, and the buttons inside it, including the ones `ProjectScreen` supplies as
	// snippets. Every one of those is a daisyUI token rather than a value, and they are all named in
	// one table — `layer-kind-style.ts`, which is also where the choice of pair is argued and why it is
	// a module rather than a const in here. The theme generator owns what the colours are; nothing here
	// says anything but which token goes where (ADR-0016, ADR-0020).
	//
	// When the card is open, the tint stays on the header alone: the body is the card's own surface,
	// which is what makes "this is the Layer" and "this is what is inside it" two regions rather than
	// one long block of colour.
	//
	// **A hidden Layer has the colour drained out of its header** and says "Hidden" beside its kind. A
	// colour that is only drained would reach nobody — a grey wash tells a screen reader nothing — so
	// the word is there for the same reason every state in this app is a sentence somewhere: the
	// toggle's own checked state carries it to assistive technology, and the word carries it to a
	// sighted user who is scanning rather than reading.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// ICONS
	//
	// Lucide, imported one glyph at a time (ADR-0016's amendment, and the note in the catalog entry).
	// **No glyph is ever alone with meaning**: the kind icon sits beside the words "Map Image", and
	// every icon-only button carries its label in `sr-only` text. The two deliberate exceptions are
	// the drag handle, which is `aria-hidden` because it is pointer-only and the move buttons are the
	// contract, and the chevron, whose accessible name is the words "Open" and
	// "Close" — those words were visible before, and what replaced them is a glyph whose meaning
	// `aria-expanded` already carries. A tooltip is not an information channel here and there is none.

	import type { Layer, MapLayer } from '@ballastella/core';
	import { tick, type Snippet } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';

	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import MapIcon from '@lucide/svelte/icons/map';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	import type { DrawnOutcome } from '@ballastella/core/render';

	import { ANNOTATION_DRAG_TYPE } from './annotation-drag.js';

	import { KIND_STYLE } from './layer-kind-style';

	let {
		layers,
		outcomes,
		openLayerId,
		onopen,
		ontypename,
		oncommit,
		onshow,
		ondragopacity,
		onmove,
		ondropannotation,
		ondelete,
		noLayersGuidance,
		foreignLayerNote,
		preparing,
		mapContents,
		problemAction,
		annotationContents
	}: {
		/** The stack, top first. Index 0 draws over everything else. */
		layers: readonly Layer[];
		/** What became of each Layer on the map, keyed by Layer id. */
		outcomes: Readonly<Record<string, DrawnOutcome>>;
		/**
		 * Which Layer is open, or `null` for none. At most one, which is what makes it one value.
		 *
		 * **Held by the screen rather than here**, because for an Annotation Layer it is also the Layer
		 * being drawn into, and a copy kept in this component would be a second thing that could
		 * disagree with the first. `ProjectScreen`'s `openLayerId` is where that is explained.
		 */
		openLayerId: string | null;
		/** Open this Layer, or `null` to close whatever is open. */
		onopen: (id: string | null) => void;
		/** Rename the Layer, keystroke by keystroke. Without it **and** {@link oncommit}, no pencil. */
		ontypename?: (id: string, name: string) => void;
		/** The edit that was in flight is over — a field blurred, a slider released (ADR-0017 rule 1). */
		oncommit?: () => void;
		/** Without it the visibility toggle is not rendered. */
		onshow?: (id: string, visible: boolean) => void;
		/** Without it the opacity slider is not rendered. */
		ondragopacity?: (id: string, opacity: number) => void;
		/**
		 * Move the Layer to a position in the stack, 0 being the top.
		 *
		 * Without it there are no Move up / Move down buttons and no drag handle — both halves of
		 * ADR-0016's pair go together, because the contract and its convenience are one affordance.
		 */
		onmove?: (id: string, toIndex: number) => void;
		/**
		 * An Annotation was dropped on this Layer's card: move it out of the Layer it is in and into
		 * this one, which moves it between two GeoJSON files.
		 *
		 * **The pointer half of a move between Layers; the keyboard half is the picker on the selected
		 * Annotation's row** (ADR-0016). Without this callback a card refuses the drop outright rather
		 * than lighting up for one it cannot perform — the same rule the three Layer drop handlers
		 * follow with `onmove`.
		 *
		 * The Annotation is not named to this component beyond its id, and does not need to be: the
		 * Layer it is leaving is the open one (see the drop handler), so the consumer already knows
		 * where it is coming from.
		 */
		ondropannotation?: (annotationId: string, layerId: string) => void;
		/**
		 * Delete the Layer **and the file it draws**. Without it, no Delete.
		 *
		 * No confirmation dialog, and that is a decision rather than an omission: `removeLayer`
		 * deliberately shipped with no button at all, on the reasoning that the affordance belongs with
		 * the undo that makes it safe. That safety is the screen's Edit History (ADR-0039), which holds
		 * the deleted Layer's file and works after autosave has written the deletion — which a dialog
		 * does not give you, since a user who means to delete confirms without reading and one who does
		 * not needs the way back either way.
		 */
		ondelete?: (id: string) => void;
		/**
		 * What to tell this consumer's user when the stack is empty, beyond the fact that it is.
		 *
		 * **Without it the empty state says only what is true of both apps** — that the Project has no
		 * Layers on it. The editor's guidance names two buttons and the Workspace they draw from, and a
		 * consumer whose user has neither cannot say it: a Reader told to press *Add a Map Image* is
		 * being sent to look for a control that is not there.
		 *
		 * A snippet for the same reason as {@link mapContents}, and the sharpest case of it: the words name
		 * the consumer's own controls, so they belong in the markup that renders them.
		 */
		noLayersGuidance?: Snippet;
		/**
		 * The rest of what an open card says about a Layer of a kind this build cannot draw (ADR-0014).
		 *
		 * **The card says only that there is nothing to show and nothing drawn**, which is true wherever
		 * the Layer is met. What becomes of it afterwards is not: the editor can promise that the Layer is
		 * written back untouched and can still be renamed, hidden and moved, and a published site can
		 * promise none of those — it writes nothing and offers two of the three controls not at all,
		 * because a Published Site has no editing on it.
		 *
		 * A snippet for the same reason as {@link noLayersGuidance}: a sentence about a consumer's own
		 * controls belongs in the markup that renders them.
		 */
		foreignLayerNote?: Snippet;
		/**
		 * The card of a Map Image being prepared right now, or `undefined` when none is.
		 *
		 * Rendered as the **top row of the stack**, which is where the Layer it is becoming will be, so
		 * that "a Layer appears and reports its own preparation" is one row moving through two states
		 * rather than a progress bar somewhere else on the screen that a user has to connect to a Layer
		 * themselves.
		 *
		 * A snippet, like {@link mapContents}: what it draws is the session's ingest — the phase, the
		 * tile numbers and the cancel — and this component is about the stack.
		 */
		preparing?: Snippet;
		/**
		 * What is inside a Map Image Layer, revealed when its card is open: whether it is aligned,
		 * the button that aligns it, and where its tiles come from.
		 *
		 * A snippet, so the card stays the one place a Layer is described and the actions stay with the
		 * screen that knows the routes and the Workspace's remote-origin records. Optional because a
		 * Layer stack is also rendered where there is nothing to do to it.
		 */
		mapContents?: Snippet<[MapLayer]>;
		/**
		 * The way to act on what a **closed** card is warning about, drawn beside {@link outcomes}'
		 * sentence for that Layer.
		 *
		 * A closed card carries the warning precisely so a map that needs aligning can be noticed without
		 * opening anything — and a state worth noticing there is worth acting on there, rather than making
		 * the user open the card to reach the control the sentence is about.
		 *
		 * A snippet for the same reason as {@link mapContents}, and the same reason sharpened: the thing to
		 * do about a problem is a route or a Workspace fact, which the screen knows and the stack does not.
		 * It is rendered for every refused Layer and decides for itself whether it has anything to offer —
		 * the card does not know which refusals are actionable.
		 */
		problemAction?: Snippet<[Layer]>;
		/**
		 * What is inside an Annotation Layer, revealed when its card is open: its drawing tools, its
		 * Annotations, and the selected one's editor.
		 *
		 * A snippet for the same reason as {@link mapContents}, and it takes **no argument at all**: the
		 * Layer it is about is the open one, which is `openLayerId`, which the screen already has. It
		 * was handed the Layer while an Annotation Layer carried a `defaultStyle`; since it no longer
		 * does (ADR-0009, as amended) there was nothing left for the argument to say.
		 */
		annotationContents?: Snippet<[]>;
	} = $props();

	/**
	 * What the last reorder did, announced.
	 *
	 * A move changes nothing that has focus and nothing that is visible near the pointer, so without
	 * this a screen-reader user presses "Move up" and is told nothing at all. `aria-live` rather than
	 * `role="status"`, because the save indicator already owns that role on this page.
	 */
	let moved = $state('');

	/** The Layer being dragged, or `''`. Also what makes the drop target visible. */
	let dragging = $state('');
	let over = $state('');

	/**
	 * The Layer whose name is being typed, or `''`.
	 *
	 * The name is text until somebody asks to change it, which is the whole reason the closed card
	 * stopped reading as a form — three bordered fields in a 24rem column were most of why the cards
	 * looked alike. The pencil that sets this is offered **only on the open card**: renaming is a
	 * deliberate act, and a control that appears on hover is a control a touch user cannot find.
	 *
	 * Held here rather than by the screen because, unlike `openLayerId`, nothing outside this component
	 * has any use for it — no Layer is drawn differently for being renamed.
	 */
	let renaming = $state('');

	/**
	 * The field that has just appeared, so the pencil can hand it the keyboard.
	 *
	 * `$state` unlike the button references below, which are deliberately not: there is one name field
	 * on the screen at a time rather than one per Layer, so this is a `bind:this` on an element inside
	 * an `{#if}` — a binding Svelte writes *and clears*, which it warns about on a plain `let` because
	 * a stale node would be silently focused. Nothing renders from it, so making it reactive costs an
	 * assignment and no re-render.
	 */
	let nameField = $state<HTMLInputElement | undefined>(undefined);

	const describeMove = (name: string, toIndex: number): string =>
		`${name || 'Untitled Layer'} moved to ${toIndex + 1} of ${layers.length}`;

	const move = (id: string, name: string, toIndex: number): boolean => {
		if (!onmove || toIndex < 0 || toIndex >= layers.length) return false;
		onmove(id, toIndex);
		moved = describeMove(name, toIndex);
		return true;
	};

	/**
	 * The two reorder buttons of each Layer, so a move can hand the keyboard back to one of them.
	 *
	 * Plain objects rather than `$state`: nothing renders from these, they are only read in the
	 * microtask after a move, and making them reactive would make writing a `bind:this` a state change.
	 */
	const upButton: Record<string, HTMLButtonElement | undefined> = {};
	const downButton: Record<string, HTMLButtonElement | undefined> = {};
	const disclosureButton: Record<string, HTMLButtonElement | undefined> = {};

	/** Each Layer's card, so a drag can carry a picture of the card rather than of the handle. */
	const card: Record<string, HTMLLIElement | undefined> = {};

	/**
	 * Whether what is being dragged is an Annotation rather than a Layer.
	 *
	 * Read during `dragover`, where the drag-and-drop protected mode makes `getData` return the empty
	 * string and `types` is the only thing a target may look at — which is why the fact is carried by
	 * the presence of a format at all. See `annotation-drag.ts`.
	 */
	const isAnnotationDrag = (event: DragEvent): boolean =>
		Boolean(event.dataTransfer?.types.includes(ANNOTATION_DRAG_TYPE));

	/**
	 * Whether an Annotation dropped on this Layer's card would go anywhere.
	 *
	 * Three conditions, and the third is the one worth saying out loud: **the open Layer is the Layer
	 * the Annotation is already in**. Only an open Annotation Layer renders its contents, so the row
	 * being dragged can only have come from that card — which means this component can refuse a move
	 * to the Layer an Annotation is already in without being told which Layer that is. A drop inside
	 * the open card is the *reorder*, and it has already been handled by the row it landed on by the
	 * time it bubbles to here.
	 */
	const takesAnnotation = (layer: Layer): boolean =>
		Boolean(ondropannotation) && layer.kind === 'annotation' && layer.id !== openLayerId;

	/**
	 * Drag the *card*, not the handle.
	 *
	 * The drag source has to stay the handle — a `draggable` ancestor claims pointer drags from every
	 * control inside it, which is the defect recorded on the `<li>` below — and a browser's default drag
	 * image is a picture of the source element. So the handle alone was what a user saw themselves
	 * dragging: six grey dots, floating, with nothing to say which Layer they belonged to. In a stack of
	 * cards that all differ by a line of text, that is the one moment the feedback matters most.
	 *
	 * `setDragImage` separates the two. The snapshot is taken **during this event**, before the
	 * `opacity-50` that marks the card as being dragged reaches the DOM, so the ghost is the card at full
	 * strength and the faded original stays behind it — which is the pairing that reads as "this one is
	 * being moved" rather than as two half-drawn cards.
	 *
	 * The cursor keeps the grip it started with: the offset is measured from where in the card the
	 * pointer actually was, so the ghost hangs off the handle exactly where the handle was grabbed
	 * instead of snapping to a corner.
	 *
	 * Silently does nothing without a `dataTransfer` or a card — this runs only from a real `dragstart`,
	 * so neither is expected to be missing, and a *drag* is the convenience rather than the contract
	 * (ADR-0016): the move buttons are the path that must never fail, and losing the picture is not worth
	 * throwing in a pointer handler over.
	 */
	const dragTheWholeCard = (event: DragEvent, id: string): void => {
		const dragged = card[id];
		if (!event.dataTransfer || !dragged) return;
		const box = dragged.getBoundingClientRect();
		event.dataTransfer.setDragImage(dragged, event.clientX - box.left, event.clientY - box.top);
	};

	/**
	 * Delete a Layer, and leave the keyboard somewhere in the list.
	 *
	 * The same problem `moveByButton` solves, in its sharpest form: the focused button is *removed*, so
	 * focus falls to `document.body` and a keyboard user has to Tab back in from the top of the document,
	 * past MapLibre's own controls, to do anything else — including reaching the undo they may want.
	 * CONTRIBUTING makes focus management a criterion of every change that adds UI, and a delete is where
	 * it is most obviously owed.
	 *
	 * **The disclosure of the card that takes this one's place**, or of the last card when the bottom
	 * Layer went — the same place a user's eye is, and now the only control a *closed* card offers that
	 * leads anywhere. It used to be that card's own Delete button, which was next to the pointer for the
	 * same reason and is no longer on a closed card at all. Focus is only *taken* here because the
	 * element that had it no longer exists.
	 */
	const deleteByButton = async (id: string, index: number): Promise<void> => {
		ondelete?.(id);
		await tick();
		if (document.activeElement !== document.body) return;
		const remaining = layers.filter((layer) => layer.id !== id);
		const next = remaining[Math.min(index, remaining.length - 1)];
		if (next) disclosureButton[next.id]?.focus();
	};

	/**
	 * Move a Layer by button, and leave the keyboard on the Layer that moved.
	 *
	 * **Without this, a keyboard reorder gets exactly one keypress.** The `{#each}` is keyed by Layer
	 * id, so Svelte *moves* the card's DOM node — and a focused element that is removed and reinserted
	 * is blurred to `document.body`, whether or not the move reached the end of the stack. So a keyboard
	 * user pressed "Move down" once and then had to Tab back in from the top of the document, past
	 * MapLibre's own controls, for every further move. ADR-0016 makes the keyboard path the contract
	 * and the drag the convenience, which is the reverse of that.
	 *
	 * The button that was pressed is preferred, and at the end of the stack it is `disabled` — "the top
	 * Layer cannot go higher" is a disabled button, which is information a screen reader gets for free
	 * from the markup — so the keyboard is handed the other half of the same control instead. That is
	 * also the useful place to be: the next press undoes the move.
	 *
	 * Focus is only *restored*, never taken: if something else has been focused in the meantime, this
	 * leaves it alone. The drop handler deliberately does not call this — a drag has no keyboard
	 * position to keep, and moving focus to a button under the pointer would be a surprise.
	 */
	const moveByButton = async (
		id: string,
		name: string,
		toIndex: number,
		direction: 'up' | 'down'
	): Promise<void> => {
		const pressed = direction === 'up' ? upButton[id] : downButton[id];
		if (!move(id, name, toIndex)) return;
		await tick();
		const active = document.activeElement;
		if (active !== null && active !== document.body && active !== pressed) return;
		const wanted = direction === 'up' ? upButton[id] : downButton[id];
		const other = direction === 'up' ? downButton[id] : upButton[id];
		(wanted && !wanted.disabled ? wanted : other)?.focus();
	};

	/** Start renaming a Layer, and put the keyboard in the field that has just appeared. */
	const renameByButton = async (id: string): Promise<void> => {
		renaming = id;
		await tick();
		nameField?.focus();
		nameField?.select();
	};

	/**
	 * Finish renaming: commit whatever was typed and put the name back to being text.
	 *
	 * `oncommit` is a no-op unless something is pending, because leaving a field nobody typed in must
	 * not rewrite `project.json` with a fresh `updatedAt` (ADR-0010, ADR-0017).
	 */
	const finishRename = (): void => {
		oncommit?.();
		renaming = '';
	};

	/**
	 * Whether this consumer offers renaming at all — the pencil, and behind it the name as a field.
	 *
	 * **Both callbacks or neither.** Typing reports each keystroke and the commit ends the edit
	 * (ADR-0017 rule 1); a consumer that passed one without the other would get a field whose
	 * keystrokes went nowhere, or one whose edit never ended.
	 */
	const canRename = $derived(Boolean(ontypename && oncommit));

	/**
	 * How long a card takes to slide to its new position.
	 *
	 * A move changes nothing under the pointer and nothing that has focus, so a card that teleports
	 * leaves a sighted user to work out which of two identical-looking cards is the one they just moved.
	 * The slide is what carries "this one, from there to here" — the same information the `aria-live`
	 * region above carries in words, which is why both exist.
	 *
	 * Zero when the user has asked for less motion, which is the whole of respecting that here: the
	 * reorder still happens, it simply arrives rather than travels.
	 */
	const moveAnimation = $derived({
		duration: prefersReducedMotion.current ? 0 : 220,
		easing: cubicOut
	});

	/**
	 * How a Layer's kind reads. A kind this build has never heard of says so rather than pretending:
	 * ADR-0014 expects a third one, and a Project carrying it is a Project this build can still
	 * reorder and rename.
	 */
	const kindLabel = (layer: Layer): string => {
		switch (layer.kind) {
			case 'map':
				return 'Map Image';
			case 'annotation':
				return 'Annotation Layer';
			case 'foreign':
				return `Not shown by this version (${layer.declaredKind || 'unknown kind'})`;
		}
	};

	/** The glyph beside those words. Never instead of them. */
	const kindIcon = (layer: Layer) => {
		switch (layer.kind) {
			case 'map':
				return MapIcon;
			case 'annotation':
				return MapPin;
			case 'foreign':
				return CircleHelp;
		}
	};

	/**
	 * The fill across the card's header.
	 *
	 * A hidden Layer takes the drained fill whatever its kind — the tint is what says "this is on the
	 * map", so a hidden card keeping it would be the one card whose colour lies.
	 *
	 * The drain is an alpha wash over the card's own surface rather than `bg-base-200`. In the dark theme,
	 * `base-200` is exactly the sidebar's own
	 * colour: a *collapsed* hidden card is nothing but its header, so it dissolved back into the column
	 * — the precise defect this redesign set out to fix, reappearing for hidden Layers only. An ink wash
	 * is measured from the surface it sits on instead, so it stays a shade off the card in both themes
	 * however the theme orders its greys.
	 */
	const headerTint = (layer: Layer): string =>
		layer.visible ? KIND_STYLE[layer.kind].tint : 'bg-base-content/5';

	/**
	 * The ink of the kind line — the glyph and the words together, because they are one label.
	 *
	 * A hidden Layer's kind line stays at full legibility rather than being dimmed with everything
	 * else: the drain is carried by the header's fill going neutral and the name going 60%, and a
	 * label nobody can read is not a subtler signal, only a worse one.
	 */
	const kindInk = (layer: Layer): string =>
		layer.visible ? KIND_STYLE[layer.kind].ink : 'text-base-content/70';

	/**
	 * The card's own two form controls, in the kind's colour.
	 *
	 * daisyUI's `toggle-*` and `range-*` modifiers, which is the whole point of using them: they take
	 * their fill and their contrasting knob from the token pair the theme defines, so a retheme moves
	 * these with the tint rather than leaving two blue controls in a teal card.
	 *
	 * The toggle keeps its colour when the Layer is hidden and the slider keeps its colour always —
	 * neither is drained. An unchecked toggle shows daisyUI's own off state whatever modifier it
	 * carries, and the opacity slider is a control the Layer owns rather than a report of its state.
	 */
	const kindToggle = (layer: Layer): string => KIND_STYLE[layer.kind].toggle;
	const kindRange = (layer: Layer): string => KIND_STYLE[layer.kind].range;
</script>

<section aria-labelledby="layer-stack-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-4">
		<h2 id="layer-stack-heading" class="text-lg font-semibold w-full text-center">Layers in this Project</h2>
	</div>

	<div
		aria-live="polite"
		aria-atomic="true"
		class="min-h-6 text-sm"
		data-testid="layer-move-status"
	>
		{moved}
	</div>

	{#if layers.length === 0 && !preparing}
		<!--
			The empty state. **What it says beyond "there is nothing here" is the consumer's**, because
			guidance is instructions for using the controls that consumer renders — and a Reader has none
			of them. Without the snippet this is the fact and nothing else, which is the sentence that is
			true in both apps.
		-->
		<p class="max-w-prose" data-testid="no-layers">
			{#if noLayersGuidance}
				{@render noLayersGuidance()}
			{:else}
				This Project has no Layers on it.
			{/if}
		</p>
	{:else}
		<!--
			An `<ol>`, so the list's structure and each Layer's position in the stack reach assistive
			technology from the markup rather than from a label somebody has to remember to update.

			**The position is no longer drawn as "2/3".** It was `aria-hidden` because the `<ol>` already
			says it, and what it gave a sighted user — a number beside a number — the order of the cards
			gives them anyway. What a sighted user did need, and now has, is to be able to *follow* a card
			that moves: see `moveAnimation`.
		-->
		<ol class="mt-2 flex flex-col gap-2" aria-label="Layers, top first">
			{#if preparing}
				<!--
					The Map Image being prepared, in the stack, above the Layers that are already in it. A new map
					Layer is added at the top, so this is where the card it becomes will be, and the card does not
					move when the preparation finishes.

					**It has no name field, no visibility toggle and no position controls**, because none of
					them would have anything to act on: this Layer is not in `project.json` yet — see the
					`preparing` snippet in `ProjectScreen.svelte` for why it deliberately is not — so a rename
					would have nowhere to go and a reorder nothing to reorder. What it carries is the two
					things that are true of it: what is happening, and the way to stop it.

					Dashed, and the one card without a tint: it is the shape of a Layer that is not one yet.
				-->
				<li
					class="rounded-box border border-dashed border-base-300 bg-base-100 p-3"
					data-testid="preparing-layer"
				>
					{@render preparing()}
				</li>
			{/if}
			{#each layers as layer, index (layer.id)}
				{@const outcome = outcomes[layer.id]}
				{@const open = openLayerId === layer.id}
				{@const Icon = kindIcon(layer)}
				<!--
					**The whole card is the drop target; only the handle is the drag source.** It used to be
					`draggable="true"` on the `<li>` itself, and a pointer drag beginning anywhere inside a
					draggable element is claimed by the drag machinery rather than by the control under the
					cursor — so the opacity slider's thumb would not move and the name field could not be
					selected across, both by mouse, on the platform ADR-0014 says authoring targets. No test
					could see it: `fill()` sets `value` and dispatches `input` without ever pressing a button.
					`draggable="false"` on the descendants does not help; Chromium still starts the card's drag.

					**What is dragged is nevertheless the card**, which is not the same question as what starts
					the drag: a browser's drag image is a picture of the source element, so grabbing the handle
					used to lift a picture of the handle — six grey dots with no Layer attached to them. See
					`dragTheWholeCard`, which hands the browser the `<li>` instead. Making the header the drag
					source would have done the same thing for free and was rejected for the reason above: the
					name field is *in* the header, so its text could no longer be selected with the mouse.

						The handle is `aria-hidden` because it is pointer-only and redundant: the move-up and
						move-down buttons inside the open card are the contract, and the drag is the convenience
						(ADR-0016). It uses the same content colour as the rest of the header, so its affordance
						remains visible on every kind fill.

					`animate:flip` is what makes a move followable; `overflow-hidden` is what keeps the
					header's tint clipped to the card, whatever `--radius-box` is set to.

					`data-drop-target` says whether a drop would land here — the same fact the `border-primary`
					draws. It is written out as an attribute as well because a highlight that *flickers* is a
					sequence of states rather than a state, and a test cannot watch a class over time without
					reading the stylesheet's mind. See `ondragleave`.

					**The three drop handlers go with `onmove`, exactly as the handle does.** A card that
					highlights and calls `preventDefault` on `dragover` is telling the pointer that a drop here
					will be accepted; without `onmove` it would be accepting one it cannot perform, so a user
					dragging a word or a file across the stack would light up every card they crossed and get
					nothing on release. Absence removes the affordance rather than leaving it inert.
				-->
				<li
					bind:this={card[layer.id]}
					class="group overflow-hidden rounded-box border border-base-content/10 bg-base-100"
					class:opacity-50={dragging === layer.id}
					class:border-primary={over === layer.id && dragging !== layer.id}
					data-testid="layer-row"
					data-layer-id={layer.id}
					data-layer-kind={layer.kind}
					data-layer-order={layer.order}
					data-image-id={layer.kind === 'map' ? layer.imageId : undefined}
					data-drop-target={over === layer.id && dragging !== layer.id ? 'true' : 'false'}
					animate:flip={moveAnimation}
					ondragover={(onmove || ondropannotation) &&
						((event) => {
							// Two kinds of thing can be over this card, and each has its own answer to "would a
							// drop here do anything": a Layer if this list reorders at all, an Annotation only if
							// this card is a Layer it could actually move into.
							if (isAnnotationDrag(event) ? !takesAnnotation(layer) : !onmove) return;
							// Without this the drop never fires: the default action of `dragover` is to refuse.
							event.preventDefault();
							over = layer.id;
						})}
					ondragleave={(onmove || ondropannotation) &&
						((event) => {
							// **Only when the pointer has really left this card.** `dragleave` fires on every
							// descendant and bubbles, so crossing from the card's padding onto the name, the kind
							// icon or the toggle inside it delivers a leave *for the card* — which cleared the
							// highlight until the next `dragover` put it back, once per element crossed. The card a
							// drop is about flickered while a user held a Layer over it, worst exactly where they
							// were aiming, because that is where the text and the icons are.
							//
							// `relatedTarget` is what the leave is *for* — the element the pointer entered — so a
							// leave into this card's own subtree is not a leave at all. It is null when the pointer
							// goes somewhere with no element to name, such as out of the window, and that is a real
							// departure: the highlight has to go, or a drag abandoned outside the app leaves a card
							// looking like a target for ever.
							const entered = event.relatedTarget;
							if (entered instanceof Node && event.currentTarget.contains(entered)) return;
							if (over === layer.id) over = '';
						})}
					ondrop={(onmove || ondropannotation) &&
						((event) => {
							event.preventDefault();
							// **The Annotation format first**, because an Annotation being dragged carries its id
							// in `text/plain` as well — that is what a drag deposits in any text field it is
							// dropped on — and reading that first would hand an Annotation's id to `moveLayer`.
							const annotationId = event.dataTransfer?.getData(ANNOTATION_DRAG_TYPE);
							const id = annotationId || event.dataTransfer?.getData('text/plain') || dragging;
							over = '';
							dragging = '';
							if (!id) return;
							if (annotationId) {
								if (takesAnnotation(layer)) ondropannotation?.(annotationId, layer.id);
								return;
							}
							if (!onmove || id === layer.id) return;
							const from = layers.findIndex((other) => other.id === id);
							move(id, layers[from]?.name ?? '', index);
						})}
				>
					<!-- The header: what this Layer is, what it is called, whether it is showing, the way in. -->
					<!--
						`data-testid`, because the fill is *shared*: the selected Annotation row inside the card
						wears the same `tint`, and the browser suite asserts that by comparing the two computed
						colours rather than by naming a token twice.
					-->
					<div
						class="flex items-center gap-1.5 py-2 pr-2 pl-1 {headerTint(layer)} {kindInk(layer)}"
						data-testid="layer-header"
					>
						{#if onmove}
							<span
								class="cursor-grab leading-none select-none"
								draggable="true"
								aria-hidden="true"
								data-testid="layer-drag-handle"
								ondragstart={(event) => {
									dragging = layer.id;
									event.dataTransfer?.setData('text/plain', layer.id);
									dragTheWholeCard(event, layer.id);
								}}
								ondragend={() => {
									dragging = '';
									over = '';
								}}
							>
								<GripVertical size={14} />
							</span>
						{/if}

						<span class={kindInk(layer)} aria-hidden="true">
							<Icon size={18} strokeWidth={2} />
						</span>

						<div class="min-w-0 grow">
							<div class="flex items-center gap-1.5 text-[0.65rem] leading-tight font-semibold">
								<span class="truncate uppercase {kindInk(layer)}" data-testid="layer-kind"
									>{kindLabel(layer)}</span
								>
								{#if !layer.visible}
									<!--
										The drained header says "not on the map" to a sighted user and nothing at all to a
										screen reader, which is what the toggle's own state is for — and nothing at all to
										somebody scanning a stack for the Layer that has gone missing, which is what this
										word is for.
									-->
									<span class="text-base-content/70 uppercase" data-testid="layer-hidden"
										>Hidden</span
									>
								{/if}
							</div>

							{#if renaming === layer.id && open}
								<!--
									Typing coalesces into one write and the edit is committed when it *ends* (ADR-0010,
									ADR-0017). Enter finishes for the same reason blurring does — the field is the whole
									interaction, so there is nothing else in it to move to.
								-->
								<input
									bind:this={nameField}
									class="input mt-0.5 w-full input-xs"
									value={layer.name}
									aria-label="Name of Layer {index + 1} of {layers.length}"
									data-testid="layer-name"
									oninput={(event) => ontypename?.(layer.id, event.currentTarget.value)}
									onkeydown={(event) => {
										if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
									}}
									onchange={() => oncommit?.()}
									onblur={() => finishRename()}
								/>
							{:else}
								<div
									class="truncate text-sm leading-tight font-semibold"
									class:opacity-60={!layer.visible}
									data-testid="layer-name-text"
								>
									{layer.name || 'Untitled Layer'}
								</div>
							{/if}
						</div>

						{#if canRename && open && renaming !== layer.id}
							<!--
								Renaming, offered on the open card only. Its accessible name carries the Layer's own
								name for the same reason every other control here does: four buttons called "Rename"
								are four identical controls to a screen reader.

								**This is the only way into the name field**, so `canRename` is the single guard behind
								both halves of that row of the contract: without the callbacks there is no pencil, and
								with no pencil `renaming` is never set and the name is never anything but text.
							-->
							<button
								type="button"
								class="btn btn-square btn-outline btn-xs"
								data-testid="layer-rename"
								onclick={() => void renameByButton(layer.id)}
							>
								<Pencil size={14} aria-hidden="true" />
								<span class="sr-only">Rename — {layer.name || 'Untitled Layer'}</span>
							</button>
						{/if}

						<!--
							ADR-0016 mandates the native checkbox for visibility; daisyUI's `toggle` is a class on
							one. The word "Show" that used to sit beside it is gone from the card and lives on in
							the accessible name, because the toggle is the one control here whose meaning a glyph
							never carried in the first place — and the header it sits in is drained when it is off.
						-->
						{#if onshow}
							<input
								type="checkbox"
								class="toggle shrink-0 toggle-sm {kindToggle(layer)}"
								checked={layer.visible}
								aria-label="Show {layer.name || 'Untitled Layer'} on the map"
								data-testid="layer-visible"
								onchange={(event) => onshow(layer.id, event.currentTarget.checked)}
							/>
						{/if}

						<!--
							The disclosure, and it is a plain `<button>` with `aria-expanded` — ADR-0016's shape
							for exactly this, so a screen reader is told the card can be opened and whether it is,
							with nothing reimplemented.

							**A control of its own rather than the card's name being the trigger.** The name is no
							longer a field, so it *could* be the trigger now — but a header that both opens the card
							and holds the toggle and the pencil is a target that does different things depending on
							where in it you land, which is the opposite of what this redesign is for.

							A chevron rather than the words "Open" and "Close": the words are the accessible name,
							`aria-expanded` is the state, and the glyph points the way the card is about to move. It
							is deliberately not an arrow — the two arrows in the open card move the *Layer*, and one
							arrow that means "open" beside two that mean "move" is the confusion this avoids.
						-->
						<button
							bind:this={disclosureButton[layer.id]}
							type="button"
							class="flex size-8 shrink-0 cursor-pointer items-center justify-center focus-visible:outline-2 focus-visible:outline-current {kindInk(layer)}"
							aria-expanded={open}
							aria-controls={open ? `layer-contents-${layer.id}` : undefined}
							data-testid="layer-disclosure"
							onclick={() => onopen(open ? null : layer.id)}
						>
							{#if open}
								<ChevronUp size={18} aria-hidden="true" />
							{:else}
								<ChevronDown size={18} aria-hidden="true" />
							{/if}
							<span class="sr-only"
								>{open ? 'Close' : 'Open'} — {layer.name || 'Untitled Layer'}</span
							>
						</button>
					</div>

					{#if outcome?.status === 'refused'}
						<!--
							The sentence and, next to it, whatever can be done about it — see {@link problemAction}.
							A band across the foot of the card rather than a line of coloured text in a row of other
							things, because this is the one thing a closed card says that is not simply a fact about
							the Layer: it is work the user has to do.

							**The sentence is `base-content` on a `warning` wash, not `warning`-coloured text.** The
							warning token is an 82%-lightness amber in the stock light theme, so the amber sentence
							this replaces was carrying about 1.7:1 against `base-100` — a colour that reads as
							decoration to anyone looking and as nothing at all to anyone with a screen reader. It is
							16:1 now. The triangle keeps the hue but not the token: amber on its own wash is 1.6:1, so
							it takes the mixed ink `@ballastella/ui/layout.css` defines, at 5:1 — declared there
							rather than in a consumer's stylesheet, or the triangle falls back to the inherited text
							colour wherever this card is rendered by an app that never declared it.
						-->
						<div
							class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warning/40 bg-warning/15 px-2.5 py-1.5 text-xs"
						>
							<TriangleAlert
								size={14}
								class="shrink-0 text-[var(--layer-problem-ink)]"
								aria-hidden="true"
							/>
							<span data-testid="layer-problem">{outcome.reason}</span>
							{@render problemAction?.(layer)}
						</div>
					{/if}

					{#if open}
						<!--
							What is inside this Layer. One card is open at a time, so this markup exists once on
							the screen however many Layers there are — which is why the ids and the headings
							inside it can be fixed strings.

							**Untinted, and that is the point of the tint above it**: the header says which Layer
							this is, and everything below it is what can be done to that Layer.

							The two kinds this build draws are supplied by the screen rather than built here —
							see the snippets' own comments in `ProjectScreen.svelte` for why the Align link
							cannot be a string passed in, and why the drawing surface needs the screen's state.
							The third kind is answered here, because there is nothing to supply.
						-->
						<div
							id="layer-contents-{layer.id}"
							class="flex flex-col gap-3 border-t border-base-300 px-3 py-3"
							data-testid="layer-contents"
							data-layer-id={layer.id}
						>
							{#if layer.kind === 'map'}
								{#if ondragopacity}
									<!--
										ADR-0016 mandates the native range for opacity; there is nothing custom here.

										The `<label>` goes with the slider rather than staying behind it: the word "Opacity"
										and the percentage are the control's own name and value, and a consumer that cannot
										change the opacity would be left with a reading of it that looks like a control.
									-->
									<label class="flex items-center gap-2 text-xs">
										<span class="shrink-0">Opacity</span>
										<input
											type="range"
											class="range grow range-xs {kindRange(layer)}"
											min="0"
											max="1"
											step="0.05"
											value={layer.opacity}
											aria-label="Opacity of {layer.name || 'Untitled Layer'}"
											data-testid="layer-opacity"
											oninput={(event) =>
												ondragopacity(layer.id, Number(event.currentTarget.value))}
											onchange={() => oncommit?.()}
										/>
										<!--
											A `<span>`, not an `<output>`: `<output>` carries an implicit `role="status"`, and the
											save indicator already owns that role on this page — a second one makes
											`getByRole('status')` ambiguous, which is a hint that a screen-reader user would have
											to disambiguate too. The value is already announced by the range's own label.
										-->
										<span
											class="w-9 shrink-0 text-right tabular-nums"
											data-testid="layer-opacity-value">{Math.round(layer.opacity * 100)}%</span
										>
									</label>
								{/if}

								{@render mapContents?.(layer)}
							{:else if layer.kind === 'annotation'}
								{@render annotationContents?.()}
							{:else}
								<!--
									ADR-0014: a Layer of a kind this version does not understand is kept and not
									drawn. It has no contents to reveal, and saying so is the honest thing — an
									empty panel would read as a Layer whose contents failed to load, which is a
									different and much more alarming state.

									**What becomes of it is the consumer's half of the sentence**, for the same
									reason the empty state's guidance is: what can still be done to this Layer, and
									whether it is written anywhere at all, is true of the app the user is in rather
									than of the card.
								-->
								<p class="max-w-prose text-sm" data-testid="layer-foreign-note">
									This is a Layer of a kind this version of Ballastella does not understand, so
									there is nothing inside it to show and nothing of it is drawn on the map.
									{#if foreignLayerNote}{@render foreignLayerNote()}{/if}
								</p>
							{/if}

							<!--
								Where this Layer sits, and getting rid of it. **In the open card, and that is a
								deliberate cost.** ADR-0016 makes the keyboard path the contract and the drag the
								convenience, and this puts the contract one keypress further away than the drag — so
								the words are on the buttons rather than left to a glyph, and the drag handle stays
								faint. What is bought is that no arrow on a closed card can be mistaken for the
								control that opens it, which is what a stack of near-identical cards was failing at.

								The row itself goes when both of its controls do, rather than leaving a bordered
								strip with nothing in it.
							-->
							{#if onmove || ondelete}
								<div class="flex items-center gap-1 border-t border-base-300 pt-3">
									{#if onmove}
										<button
											bind:this={upButton[layer.id]}
											class="btn gap-1 btn-xs"
											disabled={index === 0}
											data-testid="layer-move-up"
											onclick={() => void moveByButton(layer.id, layer.name, index - 1, 'up')}
										>
											<ArrowUp size={13} aria-hidden="true" />
											Move up<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
										</button>
										<button
											bind:this={downButton[layer.id]}
											class="btn gap-1 btn-xs"
											disabled={index === layers.length - 1}
											data-testid="layer-move-down"
											onclick={() => void moveByButton(layer.id, layer.name, index + 1, 'down')}
										>
											<ArrowDown size={13} aria-hidden="true" />
											Move down<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
										</button>
									{/if}
									<span class="grow"></span>
									{#if ondelete}
										<!--
											The Layer's name is in the accessible name for the same reason it is on the two
											buttons beside it: "Delete" four times over is four identical controls to a screen
											reader, and this is the one of them that cannot be shrugged off.
										-->
										<!--
											The trash is `error`-coloured and the word is not. `error` is a 71%-lightness red in
											the stock light theme: 2.9:1 against the card, which is a small label's 4.5:1 missed
											by a mile and a graphical object's 3:1 missed by a hair. The word carries the meaning
											at full contrast, so the glyph repeats it rather than being the only way to know what
											this button does — which is the one arrangement in which 2.9:1 is honestly
											acceptable. It is deliberately not mixed toward `base-content` like the kind line and
											the problem triangle: a Delete whose red has been diluted to pass a bar it does not
											have to meet is a Delete that reads as ordinary.
										-->
										<button
											class="btn gap-1 btn-outline btn-xs"
											data-testid="layer-delete"
											onclick={() => void deleteByButton(layer.id, index)}
										>
											<Trash2 size={13} class="text-error" aria-hidden="true" />
											Delete Layer<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>
