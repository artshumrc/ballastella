/**
 * The one field of `project.json` this slice touches.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * SEAM WITH TICKET 02. Ticket 02 owns `project.json`, the `ProjectStore` abstraction, and the
 * autosave rules; it writes `baseMap: null` into a new Project's document. This module is
 * deliberately narrower than that: two pure functions over an already-parsed document, with no
 * opinion about how it was read or how it is written back. When ticket 02 lands, its document
 * type gains `baseMap: string | null` and these two functions keep working unchanged.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The rule these enforce is ADR-0020's, which is ADR-0004's discipline applied a second time:
 * portable data records **intent** — a stable id — never an **address**. It matters more here
 * than for image services, because a Base Map that fails to resolve renders a plausible-looking
 * but *wrong* map rather than an obvious error.
 */

/** The key `project.json` records the author's default Base Map under (ADR-0020). */
export const PROJECT_BASE_MAP_KEY = 'baseMap';

/**
 * The author's default Base Map id from a parsed `project.json`, or `null`.
 *
 * Tolerant by design, and for one specific reason: this value comes from a file on someone's
 * disk that an older fork, a hand edit, or a half-finished migration may have left in any
 * shape. Every unusable shape means the same thing — no choice has been recorded — and
 * `resolveBaseMap` turns that into the deployment default. Nothing here throws.
 */
export function readBaseMapId(document: unknown): string | null {
	if (typeof document !== 'object' || document === null) return null;
	const value = (document as Record<string, unknown>)[PROJECT_BASE_MAP_KEY];
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * The same document with the author's default Base Map set to `id`.
 *
 * Returns a new object and leaves every other key alone, so writing a Base Map choice can never
 * be the thing that drops a Layer list. `id` is an id: this function has no way to record a URL
 * and no caller may give it one.
 */
export function withBaseMapId<Document extends object>(
	document: Document,
	id: string
): Document & { baseMap: string } {
	return { ...document, [PROJECT_BASE_MAP_KEY]: id };
}
