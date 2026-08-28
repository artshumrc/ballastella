// Labelled points drawn over a pane, in whatever coordinate space that pane speaks.
//
// This is the seam Control Points arrive on, and it is one seam rather than an overlay API per pane
// — a Control Point is drawn on *both* panes, so a per-pane implementation would be the same eighty
// lines of marker, focus, and drag handling written twice, diverging on the third change.
//
// Deliberately not called a marker layer. CONTEXT.md lists **marker** and **pin** under the words
// to avoid for a Control Point, and CONTRIBUTING makes that binding on code as well as UI.
// MapLibre's own class is `Marker`, so the word is unavoidable at that one import and goes no
// further — the same bargain `ImagePane.svelte` already struck.
//
// Generic over the coordinate type on purpose. The image pane speaks image pixels and the Base Map
// pane speaks lng/lat, and the synthetic geography that converts the former must not leak out of
// the image pane (ADR-0005): a pane hands in its own two converters and gets back its own
// coordinates, so neither pane can be handed the other's numbers.

import { Marker, type LngLatLike, type Map as MapLibreMap } from 'maplibre-gl';

/**
 * What a point is for, which decides how it is drawn and whether it can be touched.
 *
 * `reference` and `reported` are the image pane's one-sided annotations of its own coordinate
 * space — **not** Control Points, which pair an image pixel with a place on the earth and are
 * incomplete without both halves (ADR-0022).
 *
 * `mask-vertex` and `mask-edge` are the Resource Mask's handles, on the image pane only: the mask
 * is in image pixel space, so it has no meaning on the Base Map. A vertex can be moved and
 * removed; an edge handle sits at the midpoint of an edge and adds a vertex there.
 *
 * `annotation-vertex` and `annotation-draft` are on the Base Map only — an Annotation is on real
 * geography. A vertex is the same object to a keyboard as a Control Point or a mask corner, so
 * it arrives on this seam rather than inside a WebGL drawing library that cannot be focused.
 * `annotation-draft` is a vertex of a shape still being placed — it has no identity to move or delete
 * yet, so it is drawn and not operable.
 *
 * There is deliberately **no** `annotation-edge` to match `mask-edge`: nothing inserts a vertex into a
 * line or a shape, so nothing would ever emit one. A kind nothing produces is an affordance the code
 * promises and the app does not have, so it is not here until something draws it.
 */
export type OverlayPointKind =
	| 'reference'
	| 'reported'
	| 'control-point'
	| 'mask-vertex'
	| 'mask-edge'
	| 'annotation-vertex'
	| 'annotation-draft';

/**
 * The kinds a user can operate: focusable `<button>`s, draggable and arrow-key movable where the
 * caller supplies {@link OverlayPoint.onmoveend}, and Delete-able where it supplies
 * {@link OverlayPoint.ondelete}.
 *
 * A set rather than a comparison, because there are four of them and the list is the whole of the
 * distinction. Anything not here is a label — `aria-hidden`, `pointer-events: none`, so clicks reach
 * the map underneath. `annotation-draft` is deliberately absent: a vertex of a shape still being placed
 * must not swallow the very next click, which is the click that places the next one.
 *
 * The two callbacks are per point rather than per kind, so what a handle can do is whatever the pane
 * asked for: a Control Point and a Resource Mask corner are deleted from their own handle, and an
 * Annotation's vertex currently is not — an Annotation is deleted whole, from the panel beside the map,
 * and removing one vertex of a three-vertex shape has no defined answer yet. Delete on an Annotation's
 * vertex therefore does nothing at all, which is said here rather than left implied by a doc that
 * promises every interactive kind is Delete-able.
 */
const INTERACTIVE_KINDS: ReadonlySet<OverlayPointKind> = new Set<OverlayPointKind>([
	'control-point',
	'mask-vertex',
	'mask-edge',
	'annotation-vertex'
]);

/** How far one arrow-key press moves a point, in screen pixels. */
const NUDGE_PIXELS = 1;

/** How far a shifted arrow-key press moves a point, for crossing a pane quickly. */
const NUDGE_PIXELS_FAST = 20;

export type OverlayPoint<TPoint> = {
	/**
	 * Identity across updates. Defaults to the kind and position in the list, which is right for
	 * the fixed reference points; a Control Point passes its own id, so that a point keeps its
	 * element — and therefore keyboard focus and any drag in progress — while its coordinate
	 * changes underneath it.
	 */
	key?: string;
	point: TPoint;
	/** Announced, and shown as the point's accessible name when it can be operated. */
	label: string;
	kind: OverlayPointKind;
	/**
	 * The number drawn inside the point, so an instructor can say "look at point 7" (ADR-0022).
	 * Absent for a half still waiting for its partner, which has no ordinal yet.
	 */
	ordinal?: number;
	/**
	 * A single character drawn inside the point instead of an ordinal — `+` on a Resource Mask edge
	 * handle, which is the affordance for "a vertex goes here".
	 *
	 * Decoration only: it is never the accessible name, which is always {@link label}, so a handle
	 * still announces what it does rather than announcing "plus".
	 */
	glyph?: string;
	/** Drawn highlighted. Set on **both** halves of a selected pair, which is what links the panes. */
	selected?: boolean;
	/** The half clicked but not yet matched (ADR-0022 contract 1: visible, and labelled as pending). */
	pending?: boolean;
	/**
	 * Called **once, when a move ends** — pointer-up, or the release of an arrow key (ADR-0017
	 * rule 1). Never per pointer-move: a drag has to cost one store write, not one per frame.
	 *
	 * Its presence is also what makes the point draggable at all, so a point that cannot be moved
	 * cannot be picked up.
	 */
	onmoveend?: (to: TPoint) => void;
	/** Called while a move is in progress, for live feedback that must not be written. */
	onmove?: (to: TPoint) => void;
	onselect?: () => void;
	ondelete?: () => void;
};

export interface OverlayPointLayerOptions<TPoint> {
	map: MapLibreMap;
	/** Where one of this pane's points is, in the geography MapLibre draws. */
	toLngLat: (point: TPoint) => LngLatLike;
	/** Which of this pane's points a place in the pane is. */
	fromLngLat: (lngLat: { lng: number; lat: number }) => TPoint;
	/**
	 * The point's own coordinates as `data-` attributes, for the Playwright suite.
	 *
	 * Per pane rather than per point, because only the pane knows what its coordinates are called.
	 * It is how the browser tests establish something a round trip cannot: a reference point states
	 * the image pixel it claims to be at, the test clicks it, and the pane has to report that
	 * same pixel back — the point is *drawn* through `resourceToSynthetic` and MapLibre's project,
	 * and the click returns through MapLibre's unproject and `syntheticToResource`, which is two
	 * different directions rather than one function inverted by its own inverse.
	 */
	datasetFor?: (point: TPoint) => Record<string, string>;
}

export interface OverlayPointLayer<TPoint> {
	/** Reconcile the drawn points with `points`, by {@link OverlayPoint.key}. */
	update(points: readonly OverlayPoint<TPoint>[]): void;
	destroy(): void;
}

interface Handle<TPoint> {
	readonly marker: Marker;
	readonly element: HTMLElement;
	/**
	 * The descriptor as of the last update. Listeners read it through the handle rather than
	 * closing over it, because the callbacks are rebuilt on every render and a listener that
	 * captured the first one would keep calling into a stale closure.
	 */
	current: OverlayPoint<TPoint>;
	/**
	 * Whether a move is in progress — a pointer drag or a held arrow key.
	 *
	 * While it is, MapLibre owns this point's position and {@link OverlayPointLayer.update} must
	 * not write over it: a re-render triggered mid-gesture would snap the point back to the value
	 * in state, which is the one the user is in the middle of changing, and the point would fight
	 * the pointer.
	 */
	moving: boolean;
}

/**
 * Draw and maintain a pane's overlay points.
 *
 * Reconciled by key rather than rebuilt wholesale. A stale point is a coordinate claim that is no
 * longer true, which is why any point whose key has gone is removed — but rebuilding everything to
 * achieve that also destroys the element under the user's finger, and a Control Point is draggable
 * and focusable: rebuilding mid-gesture drops the drag, and rebuilding after an arrow-key nudge
 * throws focus back to the document, which makes the keyboard path unusable after exactly one
 * keypress.
 */
export function createOverlayPointLayer<TPoint>(
	options: OverlayPointLayerOptions<TPoint>
): OverlayPointLayer<TPoint> {
	const { map, toLngLat, fromLngLat, datasetFor } = options;
	const handles = new Map<string, Handle<TPoint>>();

	/** The point a handle currently sits at, read back out of MapLibre. */
	const positionOf = (handle: Handle<TPoint>): TPoint => fromLngLat(handle.marker.getLngLat());

	const nudge = (handle: Handle<TPoint>, dx: number, dy: number): void => {
		// Moved by screen pixels rather than by a coordinate step, so one key press means the same
		// visible distance at every zoom — the point of the gesture is "a bit to the left", and a
		// fixed coordinate step is invisible when zoomed out and enormous when zoomed in.
		const at = map.project(handle.marker.getLngLat());
		const to = fromLngLat(map.unproject([at.x + dx, at.y + dy]));
		handle.marker.setLngLat(toLngLat(to));
		handle.moving = true;
		handle.current.onmove?.(to);
	};

	const endNudge = (handle: Handle<TPoint>): void => {
		if (!handle.moving) return;
		handle.moving = false;
		// The same commit point a pointer-up takes. A held arrow key repeats `keydown` many times
		// and fires `keyup` once, so this is one store write per key-hold rather than per repeat.
		handle.current.onmoveend?.(positionOf(handle));
	};

	const paint = (handle: Handle<TPoint>, point: OverlayPoint<TPoint>): void => {
		handle.current = point;
		const { element } = handle;
		const interactive = INTERACTIVE_KINDS.has(point.kind);

		// Set here rather than at construction so it cannot go stale: only a point that has somewhere
		// to report a move to can be picked up, and a point that stops being movable stops being
		// draggable in the same update.
		handle.marker.setDraggable(Boolean(point.onmoveend));

		// Toggled one class at a time rather than assigned as a whole `className`, because **MapLibre
		// puts its own classes on this element** — `maplibregl-marker` and an anchor class — and it
		// does so inside `new Marker(...)`, before this ever runs. Overwriting `className` wiped them,
		// which cost the element `position: absolute` and left every point laid out in the container's
		// normal flow: horizontally it happened to land near the right answer, vertically it was tens
		// of pixels out, and the visible symptom was Control Points that did not sit where they were
		// placed. Assigning the whole `className` is safe only before construction, and this runs after.
		element.classList.add('pane-overlay-point', `pane-overlay-point-${point.kind}`);
		element.classList.toggle('pane-overlay-point-selected', Boolean(point.selected));
		element.classList.toggle('pane-overlay-point-pending', Boolean(point.pending));
		element.dataset.testid = `pane-overlay-point-${point.kind}`;
		element.dataset.selected = point.selected ? 'true' : 'false';
		element.dataset.pending = point.pending ? 'true' : 'false';

		if (point.ordinal === undefined) delete element.dataset.ordinal;
		else element.dataset.ordinal = String(point.ordinal);

		for (const [name, value] of Object.entries(datasetFor?.(point.point) ?? {})) {
			element.dataset[name] = value;
		}

		if (interactive) {
			// The ordinal is *in the element*, as text, so it is visible without hovering and is read
			// out as part of the point's name. ADR-0022 wants "look at point 7" to work over a
			// student's shoulder and in a written comment, which a tooltip does not serve.
			element.textContent =
				point.ordinal === undefined ? (point.glyph ?? '') : String(point.ordinal);
			element.setAttribute('aria-label', point.label);
			if (point.kind === 'control-point') {
				// The selected state is what links the two panes, so it has to be announced and not merely
				// drawn: a screen-reader user selecting point 7 needs to be told which point is current
				// (ADR-0022 contract 4).
				//
				// **Only for a Control Point, because only a Control Point is a toggle.** A Resource Mask
				// corner and an edge handle are never `selected` — one is dragged and one inserts a vertex
				// — so `aria-pressed` on them announced "Resource Mask corner 1 of 4 … toggle button, not
				// pressed" and would have gone on saying "not pressed" for ever. A state that cannot
				// change is not a state; it is a promise of a second behaviour the handle does not have.
				element.setAttribute('aria-pressed', point.selected ? 'true' : 'false');
			} else {
				element.removeAttribute('aria-pressed');
			}
			element.removeAttribute('aria-hidden');
			element.removeAttribute('title');
		} else {
			// A native `title` is a tooltip, which CONTRIBUTING says is not an information channel —
			// compliant only because the element is `aria-hidden` and the same text is in the page as
			// visible prose, so this is a mouse convenience on decoration.
			element.title = point.label;
			element.setAttribute('aria-hidden', 'true');
		}
	};

	const create = (point: OverlayPoint<TPoint>): Handle<TPoint> => {
		const interactive = INTERACTIVE_KINDS.has(point.kind);
		const element = document.createElement(interactive ? 'button' : 'div');
		const handle: Handle<TPoint> = {
			marker: new Marker({ element, anchor: 'center' }),
			element,
			current: point,
			moving: false
		};

		if (interactive) {
			const button = element as HTMLButtonElement;
			button.type = 'button';

			button.addEventListener('click', (event) => {
				// MapLibre's own click handler is on the map; a click on a point is about the point.
				event.stopPropagation();
				handle.current.onselect?.();
			});

			button.addEventListener('keydown', (event) => {
				const fast = event.shiftKey ? NUDGE_PIXELS_FAST : NUDGE_PIXELS;
				const step: Record<string, [number, number]> = {
					ArrowLeft: [-fast, 0],
					ArrowRight: [fast, 0],
					ArrowUp: [0, -fast],
					ArrowDown: [0, fast]
				};
				const delta = step[event.key];
				if (delta) {
					// MapLibre pans the map on arrow keys, and the canvas is this element's ancestor, so
					// without this the map moves instead of the point.
					event.preventDefault();
					event.stopPropagation();
					nudge(handle, delta[0], delta[1]);
					return;
				}
				if (event.key === 'Delete' || event.key === 'Backspace') {
					event.preventDefault();
					event.stopPropagation();
					handle.current.ondelete?.();
				}
			});

			button.addEventListener('keyup', (event) => {
				if (event.key.startsWith('Arrow')) endNudge(handle);
			});
			// A point dragged and then blurred without a keyup still has to commit.
			button.addEventListener('blur', () => endNudge(handle));
		}

		handle.marker.on('dragstart', () => {
			handle.moving = true;
		});
		handle.marker.on('drag', () => handle.current.onmove?.(positionOf(handle)));
		// `dragend` is pointer-up. This is ADR-0017 rule 1's one write, and the reason the drag test
		// counts writes rather than merely asserting that one happened: a per-pointer-move
		// implementation passes "did it save" and fails a count.
		handle.marker.on('dragend', () => {
			handle.moving = false;
			handle.current.onmoveend?.(positionOf(handle));
		});

		// Painted before it is added, so MapLibre measures an element that already has its size. The
		// `center` anchor is applied from the element's own dimensions, and an unstyled element has
		// none — the point would then be offset by half its own width and height for good.
		paint(handle, point);
		handle.marker.setLngLat(toLngLat(point.point)).addTo(map);
		return handle;
	};

	/**
	 * Put the keyboard somewhere sensible after the handle it was on has been removed.
	 *
	 * **Without this, Delete on a focused Control Point or the last Resource Mask corner drops focus
	 * to `<body>`** — and from there the arrow keys pan the map instead of moving the next handle, so
	 * the keyboard path ends after exactly one deletion. CONTRIBUTING makes focus management a
	 * criterion of every change that adds UI, and a delete gesture is where it is most obviously owed:
	 * the user is working through a set of points and expects to still be in the set afterwards.
	 *
	 * The next handle of the same kind, in drawing order, or the previous one if the removed handle was
	 * last. Same kind because the kinds are different jobs — landing on a mask corner after deleting a
	 * Control Point would be a silent change of task — and the map's own canvas as the last resort,
	 * because MapLibre gives it a `tabindex`, a role and an accessible name, so it is a place the user
	 * can be told they are in.
	 */
	const restoreFocus = (
		removedKey: string,
		removedKind: OverlayPointKind,
		orderBefore: readonly string[]
	): void => {
		const survivingOfSameKind = (keys: readonly string[]): HTMLElement | undefined => {
			for (const key of keys) {
				const handle = handles.get(key);
				if (handle && handle.current.kind === removedKind) return handle.element;
			}
			return undefined;
		};

		const at = orderBefore.indexOf(removedKey);
		const after = at < 0 ? [] : orderBefore.slice(at + 1);
		const before = at < 0 ? [] : orderBefore.slice(0, at).reverse();
		const next = survivingOfSameKind(after) ?? survivingOfSameKind(before);
		(next ?? map.getCanvas()).focus();
	};

	return {
		update(points) {
			const seen = new Set<string>();
			// Drawing order, which is also tab order, taken before anything is reconciled — the handle
			// that is about to go is where "the next one" has to be counted from.
			const orderBefore = [...handles.keys()];

			points.forEach((point, index) => {
				const key = point.key ?? `${point.kind}:${index}`;
				seen.add(key);
				const handle = handles.get(key);
				if (!handle) {
					// `create` paints on the way in, so there is nothing left to do for a new point.
					handles.set(key, create(point));
					return;
				}
				if (!handle.moving) handle.marker.setLngLat(toLngLat(point.point));
				paint(handle, point);
			});

			// A point whose key has gone is a coordinate claim that is no longer true.
			let hadFocus: { key: string; kind: OverlayPointKind } | undefined;
			for (const [key, handle] of handles) {
				if (seen.has(key)) continue;
				// Read before the element leaves the document, because afterwards there is nothing to ask.
				if (handle.element.contains(document.activeElement)) {
					hadFocus = { key, kind: handle.current.kind };
				}
				handle.marker.remove();
				handles.delete(key);
			}

			if (hadFocus) restoreFocus(hadFocus.key, hadFocus.kind, orderBefore);
		},

		destroy() {
			for (const handle of handles.values()) handle.marker.remove();
			handles.clear();
		}
	};
}
