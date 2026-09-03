/**
 * The one reader of `project.json`'s Base Map fields.
 *
 * `parseProjectFile` calls this rather than inspecting the fields itself, so there is exactly one
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

import {
	appearanceFrom,
	DEFAULT_BASE_MAP_APPEARANCE,
	PROJECT_BASE_MAP_APPEARANCE_KEY,
	type BaseMapAppearance
} from './appearance.js';

/** The key `project.json` records the author's default Base Map under (ADR-0020). */
export const PROJECT_BASE_MAP_KEY = 'baseMap';

/**
 * The author's default Base Map id from a parsed `project.json`, or `null`.
 *
 * `null` for a retired id as well as for an unusable one, because a Project that asked for one of
 * the entries the catalog no longer carries has not asked for tiles this deployment lacks — it has
 * asked for the appearance `readBaseMapChoice` gives it, over the tiles everything else uses.
 */
export function readBaseMapId(document: unknown): string | null {
	return readBaseMapChoice(document).id;
}

/**
 * The id exactly as the document records it, retired or not.
 *
 * Tolerant by design, and for one specific reason: this value comes from a file on someone's
 * disk that an older fork, a hand edit, or a half-finished migration may have left in any
 * shape. Every unusable shape means the same thing — no choice has been recorded — and
 * `resolveBaseMap` turns that into the deployment default. Nothing here throws.
 */
function recordedBaseMapId(document: unknown): string | null {
	if (typeof document !== 'object' || document === null) return null;
	const value = (document as Record<string, unknown>)[PROJECT_BASE_MAP_KEY];
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	return trimmed === '' ? null : trimmed;
}

/**
 * The appearance each retired catalog entry drew, keyed by the id `project.json` recorded for it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHY A TABLE HERE RATHER THAN A QUIETER FALLBACK NOTICE
 *
 * The catalog once carried four entries over the one archive — Streets, Physical geography,
 * Topographic, Muted — and they are now three orthogonal switches (`appearance.ts`), because four
 * named variants covered four of eight combinations and left out the ones scholars asked for. Every
 * `project.json` written before that carries one of these ids, and `resolveBaseMap` cannot tell it
 * from an id this deployment genuinely cannot serve: both are "not in the catalog", and the author
 * met a warning about a Base Map that had not gone anywhere.
 *
 * Silencing unresolvable ids in general is the wrong repair. That notice is ADR-0020's whole point —
 * a Project carrying a fork's id must say so rather than draw a plausible-looking but wrong map — and
 * these four are the one case where the id's *meaning* survives its name, so they are the one case
 * that can be translated instead of reported. Anything else still gets the notice.
 *
 * The translation is a read, not a rewrite: `serialiseProjectFile` writes what was read, so a Project
 * loses the retired id and gains the appearance it meant on its next ordinary save.
 */
const RETIRED_BASE_MAP_APPEARANCES: Readonly<Record<string, BaseMapAppearance>> = Object.freeze({
	streets: DEFAULT_BASE_MAP_APPEARANCE,
	physical: { ...DEFAULT_BASE_MAP_APPEARANCE, streets: false },
	topographic: { ...DEFAULT_BASE_MAP_APPEARANCE, relief: true },
	muted: { ...DEFAULT_BASE_MAP_APPEARANCE, highContrast: true }
});

/** What a Project recorded about its Base Map: which tiles, and how they are drawn. */
export type BaseMapChoice = {
	/** The catalog id, or `null` when the author has recorded no choice. */
	readonly id: string | null;
	/** How it is drawn — never `null`; an unusable or absent value means the documented default. */
	readonly appearance: BaseMapAppearance;
};

/**
 * Both halves of the author's Base Map choice, read together.
 *
 * Together rather than separately because a retired id (see above) is the appearance: reading the two
 * fields independently would either lose what `"baseMap": "topographic"` meant or resurrect it over an
 * appearance the author has since written. An explicit `baseMapAppearance` always wins — the retired id
 * only speaks for a document from before the field existed.
 */
export function readBaseMapChoice(document: unknown): BaseMapChoice {
	const recorded = recordedBaseMapId(document);
	const retired = recorded === null ? undefined : RETIRED_BASE_MAP_APPEARANCES[recorded];
	const written =
		typeof document === 'object' && document !== null
			? appearanceFrom((document as Record<string, unknown>)[PROJECT_BASE_MAP_APPEARANCE_KEY])
			: null;
	return {
		id: retired === undefined ? recorded : null,
		appearance: written ?? retired ?? DEFAULT_BASE_MAP_APPEARANCE
	};
}
