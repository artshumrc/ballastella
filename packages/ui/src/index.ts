// The Svelte components both apps render, and the stylesheet that goes with them.
//
// Source, not a build artefact: `.svelte` and `.ts` compiled by whichever app's bundler imports
// them, which is the arrangement `@ballastella/core` already uses and the reason neither package has
// a `build` script (ADR-0034, amending ADR-0019). `svelte` is a peer dependency here for the same
// reason — the framework belongs to the app doing the compiling, and two copies of it in one page is
// a broken interface rather than a version warning.
//
// The stylesheet is `@ballastella/ui/layout.css`, imported by each app's own `routes/layout.css`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// ⚠ `theme.svelte.ts` IS NOT HERE, AND THAT IS DELIBERATE
//
// `apps/viewer/src/lib/theme.svelte.ts` and `apps/editor/src/lib/theme.svelte.ts` are two modules
// doing what looks like one job, and the divergence is argued in the viewer's own module header: a
// Reader's theme is read from `prefers-color-scheme` once at construction, while an author sitting in
// the editor for hours gets a stored preference and a live listener. What is shared is the *control*;
// the signal behind it is not. Merging them would settle that argument by deleting it, so a
// contributor who comes here looking for the theme should read that header first.

// One Annotation's description, sanitised. The whole of the package's `{@html}`, so a surface that
// wants rendered Markdown composes this rather than writing one of its own: see its header.
export { default as AnnotationDescription } from './AnnotationDescription.svelte';
export { default as AnnotationInspector } from './AnnotationInspector.svelte';
// The id a row's `aria-controls` names, so the two spellings cannot drift apart. Its own module rather
// than the component's `<script module>`: see the header of `annotation-inspector-id.ts`.
export { ANNOTATION_INSPECTOR_ID } from './annotation-inspector-id.js';
// The drag format that tells an Annotation being dragged from a Layer being dragged, shared by the two
// lists that accept the drop: see its header.
export { ANNOTATION_DRAG_TYPE } from './annotation-drag.js';
export { default as AnnotationList } from './AnnotationList.svelte';
export { default as AnnotationRow } from './AnnotationRow.svelte';
export { default as AppBar } from './AppBar.svelte';
export { default as BaseMapSwitcher } from './BaseMapSwitcher.svelte';
export { default as LayerList } from './LayerList.svelte';
export { default as LeaderLine } from './LeaderLine.svelte';
// The rectangle `LeaderLine` takes for either end of the line, so a consumer can name what it hands in.
export type { Box } from './leader-line';
export { default as MapCommentary } from './MapCommentary.svelte';
export { default as MapNotice } from './MapNotice.svelte';
export { default as MenuPopover } from './MenuPopover.svelte';
export { default as ProjectCardList } from './ProjectCardList.svelte';
export { KIND_STYLE } from './layer-kind-style';
export { TOOL_ICONS, iconForAnnotation } from './shape-icons';
export { pageChrome, type Breadcrumb, type WayBack } from './page-chrome.svelte.js';
