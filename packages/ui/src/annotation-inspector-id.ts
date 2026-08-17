/**
 * The Annotation Inspector's element id, fixed rather than derived from the Annotation.
 *
 * One Inspector is on screen at a time — one Layer card open, one row selected — which is what makes a
 * fixed id safe, the same argument `AnnotationList` makes for its own.
 *
 * **A module rather than a `const` in `AnnotationInspector.svelte`, for the reason `layer-kind-style.ts`
 * is one:** `AnnotationRow`'s `aria-controls` names this region from across the screen, and a row that
 * had to import the component to learn a string would drag the whole panel — its transition, its icon,
 * its name rules — into the bundle of every app that renders a row, leaving it to tree-shaking to
 * notice that only the string was wanted. A row pointing at a string spelled twice is a row that can
 * point at nothing, so the string is shared; it is the sharing that must cost nothing.
 */
export const ANNOTATION_INSPECTOR_ID = 'annotation-inspector';
