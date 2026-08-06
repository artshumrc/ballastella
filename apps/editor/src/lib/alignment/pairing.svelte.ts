// Control Point pairing: the core act of the application (ADR-0022).
//
// A user clicks a feature on the Historical Map, clicks the same place on the earth, and a numbered
// pair appears. **The pairing is ours** — neither `terra-draw` nor any other drawing library has a
// concept of linked points across two maps, which is ADR-0022's contract 4 and the reason this file
// exists rather than a configuration of somebody else's editor.
//
// All six of ADR-0022's behaviours live here, in one object, rather than being spread across the
// two panes that draw them. The panes report clicks and moves; this decides what they mean. That
// split is what makes "selecting either half highlights its partner" a single piece of state
// instead of two panes trying to tell each other things.
//
// **This object holds the drafts; `EditorSession` holds the store.** The pending half never reaches
// `EditorSession`, because it never reaches the file: `collectControlPoints` drops it, and every
// write goes through that function (ADR-0022 contract 2).

import {
	collectControlPoints,
	newAlignment,
	toDraftControlPoints,
	type Alignment,
	type ControlPoint,
	type DraftControlPoint,
	type GeoPoint,
	type ResourcePoint
} from '@ballastella/core';

/** Which pane a pending half was placed on, and therefore which click completes it. */
export type PendingHalf = 'resource' | 'geo';

/**
 * One Historical Map's Control Point pairing, as the user makes it.
 *
 * Constructed per Historical Map. Switching maps builds a new one rather than resetting this one,
 * so a pending half cannot survive into a different image's coordinate space.
 */
export class AlignmentPairing {
	/**
	 * Every pair being made, complete or not, in the order they were started.
	 *
	 * At most one is incomplete — {@link pending} — because click-then-click cannot start a second
	 * pair without finishing or cancelling the first.
	 */
	drafts = $state<DraftControlPoint[]>([]);

	/** Which pair is selected, so both panes can highlight it (ADR-0022 contract 4). `null` for none. */
	selectedId = $state<string | null>(null);

	readonly #imageId: string;
	readonly #image: { readonly width: number; readonly height: number };
	/** Bumped per pair, so ids are unique within the session and independent of position. */
	#nextId = 0;

	constructor(imageId: string, image: { width: number; height: number }, stored?: Alignment) {
		this.#imageId = imageId;
		this.#image = { width: image.width, height: image.height };
		if (stored) {
			this.drafts = [...toDraftControlPoints(stored)];
			// Past whatever the stored ids were, so a new pair cannot collide with a resumed one.
			this.#nextId = this.drafts.length;
		}
	}

	/** The complete pairs, numbered 1..n. What gets drawn, listed, solved, and saved. */
	readonly controlPoints: readonly ControlPoint[] = $derived(collectControlPoints(this.drafts));

	/**
	 * The half clicked but not yet matched, or `null`.
	 *
	 * ADR-0022 contract 1: it must be visible, labelled, and cancellable with Escape. Without a
	 * clear pending state the user does not know the app is waiting, and the second click lands
	 * somewhere arbitrary.
	 */
	readonly pending:
		| (DraftControlPoint & {
				/** Which half has been placed — and so which pane the next click has to land on. */
				readonly half: PendingHalf;
				/** What the user is told and what is announced. The "labelled" of contract 1. */
				readonly message: string;
		  })
		| null = $derived.by(() => {
		const draft = this.drafts.find((one) => one.resource === null || one.geo === null);
		if (!draft) return null;
		const half: PendingHalf = draft.resource === null ? 'geo' : 'resource';
		return {
			...draft,
			half,
			message:
				half === 'resource'
					? 'Waiting for the matching place on the Base Map. Press Escape to cancel this Control Point.'
					: 'Waiting for the matching feature on the Historical Map. Press Escape to cancel this Control Point.'
		};
	});

	/**
	 * The Alignment as it stands. Complete pairs only, so this is always writable as-is.
	 *
	 * A getter rather than a `$derived` field because a field initializer runs before the
	 * constructor body, which has not yet assigned the image it needs. Reading it still registers
	 * {@link controlPoints} as a dependency, so anything watching this updates exactly as it would
	 * have; what is given up is memoisation of an object cheap enough to rebuild.
	 */
	get alignment(): Alignment {
		return {
			...newAlignment(this.#imageId, this.#image),
			controlPoints: this.controlPoints
		};
	}

	/**
	 * A click landed on the Historical Map, at an image pixel.
	 *
	 * Completes a pending earth half, or starts a new pair. Deliberately **not** "place a point and
	 * link it later", and deliberately never auto-paired by order: ADR-0022 rejects the latter as
	 * the worst option, because it makes ordering load-bearing and invisible, so one misordered
	 * placement silently shifts every later pairing and the only symptom is a warp that is
	 * inexplicably wrong.
	 */
	clickHistoricalMap(resource: ResourcePoint): void {
		this.#click('resource', resource);
	}

	/** A click landed on the Base Map, at a place on the earth. The symmetric half of the gesture. */
	clickBaseMap(geo: GeoPoint): void {
		this.#click('geo', geo);
	}

	/**
	 * Abandon the pending half. Escape, or the cancel button beside the prompt.
	 *
	 * Leaves no trace: the incomplete draft is removed from UI state, and nothing was ever written
	 * for it — a pending half is not persisted at all, so there is no file to clean up and no
	 * Alignment with an empty `gcps` list left behind by a mis-started pair.
	 */
	cancelPending(): boolean {
		const id = this.pending?.id;
		if (id === undefined) return false;
		this.drafts = this.drafts.filter((draft) => draft.id !== id);
		if (this.selectedId === id) this.selectedId = null;
		return true;
	}

	/** Select a pair, or clear the selection by selecting it again. */
	toggleSelected(id: string): void {
		this.selectedId = this.selectedId === id ? null : id;
	}

	/** Move a pair's image half. Called on gesture end, so it is already one commit. */
	moveResource(id: string, resource: ResourcePoint): void {
		this.#replace(id, (draft) => ({ ...draft, resource }));
	}

	/** Move a pair's earth half. */
	moveGeo(id: string, geo: GeoPoint): void {
		this.#replace(id, (draft) => ({ ...draft, geo }));
	}

	/**
	 * Delete a pair.
	 *
	 * ADR-0022 contract 5: deletion removes the pair, never a half. A half cannot exist in the file,
	 * so deleting one has no valid meaning — which is why there is no method that could.
	 */
	remove(id: string): void {
		this.drafts = this.drafts.filter((draft) => draft.id !== id);
		if (this.selectedId === id) this.selectedId = null;
	}

	#click(half: PendingHalf, at: ResourcePoint | GeoPoint): void {
		const waiting = this.pending;

		if (waiting) {
			if (waiting.half === half) {
				// The same pane again, before the pair was finished. Read as "actually, *there*" —
				// relocating the pending half rather than starting a second pair, since ADR-0022 allows
				// only one pending half and silently ignoring the click would look like a broken map.
				this.#replace(waiting.id, (draft) => ({ ...draft, [half]: at }));
				return;
			}
			// The matching click. This is the moment a Control Point comes into existence.
			this.#replace(waiting.id, (draft) => ({ ...draft, [half]: at }));
			this.selectedId = waiting.id;
			return;
		}

		const id = `p${this.#nextId++}`;
		this.drafts = [
			...this.drafts,
			{ id, resource: null, geo: null, [half]: at } as DraftControlPoint
		];
		this.selectedId = id;
	}

	#replace(id: string, change: (draft: DraftControlPoint) => DraftControlPoint): void {
		this.drafts = this.drafts.map((draft) => (draft.id === id ? change(draft) : draft));
	}
}
