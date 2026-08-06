/**
 * The one reader of `project.json`'s Base Map field.
 *
 * `parseProjectFile` calls this rather than inspecting the field itself, so there is exactly one
 * implementation of "what did the author choose?". While there were two, `"baseMap": "  "` was
 * no choice down one code path and a Base Map called two spaces down the other, and which
 * behaviour a user got depended on which pane happened to open their Project.
 *
 * The rule it enforces is ADR-0020's, which is ADR-0004's discipline applied a second time:
 * portable data records **intent** — a stable id — never an **address**. It matters more here
 * than for image services, because a Base Map that fails to resolve renders a plausible-looking
 * but *wrong* map rather than an obvious error.
 *
 * There is deliberately no writer here to match. `ProjectFile` types the field and
 * `serialiseProjectFile` writes it, and that is the only way it is written: a second writer over
 * a loosely-typed document is how a Base Map choice ends up clobbering a Layer list.
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
