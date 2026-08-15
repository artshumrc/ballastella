// The number an Annotation is known by, on its mark and on its row.
//
// **One rule, so the two surfaces cannot disagree.** A scholar saying "look at 3" across a desk, and
// a scholar writing "3" in a footnote a Reader follows, are both relying on the sidebar and the map
// agreeing about which Annotation that is — and on the authoring app and the Published Site agreeing
// too. So the rule is a function in `core`, read by `packages/ui`'s row and by `render/`'s mark,
// rather than an `index + 1` written wherever a number is wanted.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ DISPLAY STATE, NEVER WRITTEN (ADR-0002)
//
// No GeoJSON feature gains an `id`, a `properties` entry, or any other byte from this. The ordinal is
// derived from the order a collection already has, at the moment something draws it, which is what
// makes renumbering after a delete a *re-render*: the Annotations after the deleted one are the same
// objects, serialising to the same bytes, and the only thing that changed is what a shorter list is
// counted as.
//
// That is the same argument ADR-0002 makes about `visible` and `opacity`, at the one place it is
// most tempting to break: a number is small, an `id` field is already there, and MapLibre would draw
// it happily from `properties`. `ordinal.test.ts` asserts the bytes; `e2e/editor-annotations.e2e.ts`
// asserts the files.

/**
 * Where an Annotation sits for a reader: its place in the collection, counted from one.
 *
 * `index` is its position in {@link import('./annotation.js').AnnotationCollection.annotations} —
 * the whole collection, including an Annotation whose geometry this build cannot draw. That is
 * deliberate: the row is what a reader counts down, and a number missing from the map because a
 * `GeometryCollection` has nowhere to put one is honest, where a map and a sidebar disagreeing about
 * which Annotation is 3 is not.
 */
export const annotationOrdinal = (index: number): number => index + 1;
