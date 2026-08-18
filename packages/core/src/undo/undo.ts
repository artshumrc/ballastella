// Single-level undo of the last destructive action (ADR-0014, SPEC story 38).
//
// **One level, four actions, and deliberately not a history stack.** `terra-draw` provides no undo, so
// this is ours; and a scoped undo is not optional, because dragging a Control Point is a destructive,
// easy-to-mis-aim gesture and a scholar who nudges the wrong point and cannot get it back will not
// trust the tool. But making every mutation a command object shapes the whole state layer, which is
// the work ADR-0014 defers — so what is here is a *record of one prior value* and the one slot that
// holds it, with no command objects, no inverse-operation registry, and nothing to extend.
//
// **Putting a thing back is the ordinary operation that put it there, not an undo-only one.** Only the
// Control Point drafts need a function of their own — {@link restoreControlPoint}, because a move and a
// deletion are one array operation with two shapes — and a deleted Annotation and a deleted Layer go
// back through `insertAnnotationAt` and `insertLayerAt`, which are the same functions any other insert
// uses. A pass-through here per kind would only be a second name for each of them.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CRUX: UNDO MUST WORK AFTER AUTOSAVE HAS WRITTEN THE DESTRUCTIVE CHANGE TO DISK
//
// With a sub-second per-file debounce (ADR-0017), "revert to the last saved state" is useless: by the
// time the user reaches for undo, the deletion *is* the last saved state. So a record holds the prior
// value **in memory, independent of write state** — and for a deleted Layer that means the referenced
// file's *bytes*, not a parsed model that would re-serialise to something merely equivalent. Ticket 09
// asserts that display-state edits leave `alignments/*.json` and `annotations/*.geojson`
// byte-identical; restoring a deleted Layer has to clear the same bar, and only the bytes can.
//
// Reverting is itself an ordinary mutation: it goes through the same {@link
// import('../autosave/autosave.js').Autosave} as every other edit, with no bespoke save path.

import type { DraftControlPoint, GeoPoint } from '../alignment/alignment.js';
import type { Annotation } from '../annotation/annotation.js';
import type { ResourcePoint } from '../image-pane/synthetic-projection.js';
import type { Layer } from '../project/layer.js';
import type { Bytes } from '../store/project-store.js';

/**
 * A Control Point was dragged or nudged, and this is where it was.
 *
 * Both halves are held even though a gesture moves one of them: a pair is one thing (ADR-0022), and
 * restoring the half the user did not touch to the value it already has costs nothing, while deciding
 * *which* half moved would be a second fact that could disagree with the gesture.
 */
export interface ControlPointMovedUndo {
	readonly kind: 'control-point-moved';
	/** Which Map Image's Alignment this pair belongs to, so an undo cannot cross images. */
	readonly imageId: string;
	readonly pointId: string;
	/** As the user read it when they moved it — 1-based, derived from position (ADR-0022). */
	readonly ordinal: number;
	readonly resource: ResourcePoint;
	readonly geo: GeoPoint;
}

/**
 * A Control Point pair was deleted, and this is the pair.
 *
 * `at` is its index among the drafts rather than its ordinal, because the ordinal is *derived* from
 * position: putting the pair back where it was is what restores its number, and storing the number
 * itself would be a second source of truth that a later deletion would make wrong.
 */
export interface ControlPointDeletedUndo {
	readonly kind: 'control-point-deleted';
	readonly imageId: string;
	/** What it was numbered when it was deleted, for the affordance to name. */
	readonly ordinal: number;
	/** Its position among the drafts, which is what puts the ordinal back. */
	readonly at: number;
	readonly point: DraftControlPoint;
}

/** An Annotation was deleted, with all of its `properties` — including `stroke-dasharray`. */
export interface AnnotationDeletedUndo {
	readonly kind: 'annotation-deleted';
	/** The Annotation Layer it was in, so it cannot be restored into another one. */
	readonly layerId: string;
	/** Its position in the collection, which is the order Annotations draw in. */
	readonly at: number;
	readonly annotation: Annotation;
}

/**
 * A Layer was deleted: its entry in the stack, its position, **and the bytes of the file it drew**.
 *
 * The bytes are the whole reason this record exists rather than a Layer id. Deleting a map Layer
 * deletes an `alignments/*.json` and deleting an Annotation Layer deletes an `annotations/*.geojson`,
 * so an undo that restored only the `project.json` entry would leave a Layer referencing a file that
 * is not there — a Project ticket 13's import refuses by name — and would have thrown away the
 * scholarship rather than the display state.
 */
export interface LayerDeletedUndo {
	readonly kind: 'layer-deleted';
	/** Its position in the stack, 0 being the top. Restoring it anywhere else discards the ordering. */
	readonly at: number;
	readonly layer: Layer;
	/**
	 * The file the Layer drew, by path within the Project, or `''` when it drew none.
	 *
	 * `''` for a Layer of a kind this build has never heard of: its reference lives in
	 * `unknownFields` under a name we do not know, so there is no file we can honestly claim to be
	 * deleting or putting back.
	 */
	readonly path: string;
	/** Its contents exactly as they were, or `null` when there was no such file to hold. */
	readonly bytes: Bytes | null;
}

/**
 * The last destructive action, held so it can be reversed. Exactly four kinds — the four ADR-0014
 * names, and nothing else.
 *
 * Creating, renaming, restyling, toggling visibility, reordering, and changing a transformation type
 * are **not** here, and that absence is the fence: they are either non-destructive or reversed by
 * repeating the action, and a broader net is the history stack ADR-0014 excludes.
 */
export type UndoRecord =
	ControlPointMovedUndo | ControlPointDeletedUndo | AnnotationDeletedUndo | LayerDeletedUndo;

/** Whether this record is about a Control Point, and so belongs to one Map Image. */
export const isControlPointUndo = (
	record: UndoRecord
): record is ControlPointMovedUndo | ControlPointDeletedUndo =>
	record.kind === 'control-point-moved' || record.kind === 'control-point-deleted';

/**
 * What the undo affordance says (SPEC story 38).
 *
 * **It names the action it will reverse**, because a bare "Undo" button after an accidental delete is
 * not reassuring: the user's question is "did I just lose the thing I think I lost", and the answer has
 * to be on the control. It is also the accessible name of the button, so a screen-reader user hears
 * "Undo delete of Control Point 7" rather than "Undo, button".
 *
 * Here rather than in a component so that the wording is one fact with one definition, testable
 * without a browser, and identical wherever the affordance is drawn.
 */
export function describeUndo(record: UndoRecord): string {
	switch (record.kind) {
		case 'control-point-moved':
			return `Undo move of Control Point ${record.ordinal}`;
		case 'control-point-deleted':
			return `Undo delete of Control Point ${record.ordinal}`;
		case 'annotation-deleted':
			return `Undo delete of ${quoted(record.annotation.properties.title, 'this Annotation')}`;
		case 'layer-deleted':
			return `Undo delete of the Layer ${quoted(record.layer.name, 'with no name')}`;
	}
}

/** A user's own words in quotation marks, or a fallback phrase when they typed none. */
const quoted = (name: string | undefined, fallback: string): string =>
	name === undefined || name === '' ? fallback : `“${name}”`;

/**
 * The drafts with a moved or deleted Control Point put back.
 *
 * One function for both kinds because the pairing UI holds one array and this is the only thing done
 * to it: a move restores two coordinates in place, and a deletion splices the pair back in at the
 * index it held. Restoring an id that is already among the drafts returns the array it was given, so a
 * caller can tell a no-op by identity and write nothing — the discipline `alignment.ts` and `layer.ts`
 * both follow.
 *
 * **Matching is by id, and the id is the caller's problem.** A Control Point's id is minted per
 * session and is not in the file — the format carries no per-point identifier, and adding one would be
 * the proprietary index SPEC story 94 rules out. So a record can outlive the pairing that made it, and
 * the ids it names can be gone. Resolving that is deliberately *not* done here: from an array of
 * drafts alone, "the recorded pair was deleted" and "the recorded pair is still there under a new id"
 * look identical, and guessing between them by position would put a moved pair's old coordinates onto
 * some other pair. The caller knows which happened, because it knows whether the pairing in front of
 * it is the one the record was made on. See `putBack` in `AlignmentWorkspace.svelte`.
 */
export function restoreControlPoint(
	drafts: readonly DraftControlPoint[],
	record: ControlPointMovedUndo | ControlPointDeletedUndo
): readonly DraftControlPoint[] {
	if (record.kind === 'control-point-moved') {
		let changed = false;
		const restored = drafts.map((draft) => {
			if (draft.id !== record.pointId) return draft;
			changed = true;
			return { id: draft.id, resource: record.resource, geo: record.geo };
		});
		return changed ? restored : drafts;
	}
	if (drafts.some((draft) => draft.id === record.point.id)) return drafts;
	const at = Math.min(drafts.length, Math.max(0, record.at));
	return [...drafts.slice(0, at), record.point, ...drafts.slice(at)];
}

/**
 * The file a Layer draws that belongs to **this Project**, by path within it, or `''` when there is
 * none.
 *
 * The one place that maps a Layer's kind to the file that has to be deleted with it and restored with
 * it, so the delete and the undo cannot disagree about which file that is.
 *
 * **A map Layer answers `''`, and that is ADR-0023 rather than an omission.** Its Alignment and its
 * pyramid belong to the Workspace and are shared by every Project that references the image, so
 * deleting the Layer must leave both alone — SPEC story 67: removing a Layer leaves the Map Image
 * available. Returning `alignments/<id>.json` here would make one Project's delete button destroy
 * another Project's map.
 *
 * A {@link import('../project/layer.js').ForeignLayer} answers `''` too, for a different reason: its
 * reference is a field in `unknownFields` whose name this build has never heard of, and guessing would
 * either orphan a file or delete one we were never asked to touch.
 */
export function layerFileRef(layer: Layer): string {
	switch (layer.kind) {
		case 'map':
			return '';
		case 'annotation':
			return layer.geojsonRef;
		case 'foreign':
			return '';
	}
}

/**
 * The one undo slot: what would be reversed, and how (ADR-0014).
 *
 * **One slot, not a stack.** {@link offer} replaces whatever was in it, {@link take} empties it, and
 * a second undo therefore does nothing and is not offered — which is the visible half of the same
 * rule. Only the four destructive actions call `offer`, so a non-destructive one cannot consume the
 * slot: there is no code path by which a visibility toggle reaches this class.
 *
 * A plain class with a listener rather than anything framework-aware, exactly as `Autosave` is: the
 * semantics are worth testing without a browser, and the app subscribes to project them into its own
 * reactive state.
 *
 * **The record does not persist.** It is held in memory for the life of the open Project and dropped
 * when the Project is closed; ADR-0014 puts persisting undo across a reload out of scope, and a
 * tombstone — not an undo record — is what has to survive one.
 */
export class UndoSlot {
	#record: UndoRecord | null = null;
	#apply: (() => Promise<void>) | null = null;
	readonly #listeners = new Set<(record: UndoRecord | null) => void>();

	/** What undo would reverse, or `null` when there is nothing to reverse. */
	get record(): UndoRecord | null {
		return this.#record;
	}

	/** Called on every change, and once immediately. Returns its own unsubscribe. */
	subscribe(listener: (record: UndoRecord | null) => void): () => void {
		this.#listeners.add(listener);
		listener(this.#record);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Record a destructive action and how to reverse it.
	 *
	 * `apply` is supplied by whoever owns the state that changed rather than derived here, because the
	 * four actions live in three different places — the pairing drafts, one Annotation Layer's
	 * collection, and `project.json` plus a file — and a slot that reached into all three would be the
	 * command-object architecture ADR-0014 defers.
	 */
	offer(record: UndoRecord, apply: () => Promise<void>): void {
		this.#record = record;
		this.#apply = apply;
		this.#publish();
	}

	/**
	 * Empty the slot and hand back how to reverse what was in it, or `null` when it was empty.
	 *
	 * Emptied *before* the caller applies it, so an undo that is slow cannot be started twice and a
	 * second press has nothing to find.
	 */
	take(): (() => Promise<void>) | null {
		const apply = this.#apply;
		this.clear();
		return apply;
	}

	/** Forget what is in the slot. The Project has been closed, or the record no longer applies. */
	clear(): void {
		if (this.#record === null && this.#apply === null) return;
		this.#record = null;
		this.#apply = null;
		this.#publish();
	}

	/**
	 * Forget the record when `stale` says it no longer applies.
	 *
	 * The case it exists for: a Control Point undo belongs to the Map Image it was made on, and
	 * once the user is aligning a different one, an affordance offering to move a point they cannot see
	 * is worse than no affordance at all.
	 */
	clearIf(stale: (record: UndoRecord) => boolean): void {
		if (this.#record !== null && stale(this.#record)) this.clear();
	}

	#publish(): void {
		for (const listener of this.#listeners) listener(this.#record);
	}
}
