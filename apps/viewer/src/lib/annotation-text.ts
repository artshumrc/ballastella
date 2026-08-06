// The Published Site's Annotation text, rendered through **the editor's own renderer**.
//
// This module is deliberately almost empty, and that is the point of it. ADR-0009 requires that the
// sanitised renderer be exported from `core` and reused here rather than reimplemented, because ticket
// 17 asserts that the same XSS payload which is inert in the editor is inert in a Published Site — and
// that assertion means nothing unless it is the same code path. A second implementation in the viewer
// is the specific failure mode being prevented: it would be the one that runs on the user's own
// domain, where a mistake is stored XSS on `maps.digitalhumanities.harvard.edu` or on a student's
// GitHub Pages origin.
//
// So there is exactly one function here, it forwards, and it exists so that ticket 17 has a named seam
// to call and so that a future edit adding "just a bit of Markdown handling" to the viewer has an
// obvious place to be refused.
//
// `marked` and `dompurify` are direct dependencies of this app as well as of `core`. ADR-0018 explains
// why `dompurify` arriving in triiiceratops' tree costs nothing extra to install; it is not permission
// to import it undeclared, which pnpm's isolated `node_modules` prevents anyway.

import { renderAnnotationPopup, type AnnotationText } from '@ballastella/core';

/**
 * One Annotation's title and description as sanitised HTML, for a reader.
 *
 * @returns sanitised HTML, or `''` when there is nothing to show
 */
export function annotationHtml(annotation: AnnotationText): string {
	return renderAnnotationPopup(annotation);
}
