import {
	DEFAULT_BASE_MAP_BORDERS,
	PROJECT_BORDERS_KEY,
	readBaseMapBorders,
	type BaseMapBorders
} from '../base-map/borders.js';
import { PROJECT_BASE_MAP_KEY, readBaseMapId } from '../base-map/project.js';
import type { Bytes } from '../store/project-store.js';
import {
	IMPORT_PROVENANCE_KEY,
	parseImportProvenance,
	serialiseImportProvenance,
	type ImportProvenanceEntry
} from './import-provenance.js';
import { parseLayers, serialiseLayers, type Layer } from './layer.js';

/** The `project.json` format this build of the app understands (ADR-0010). */
export const CURRENT_FORMAT_VERSION = 1;

/**
 * Where a user with a Project from the future can find an app that reads it.
 *
 * A forker running their own instance changes this in one place. It is deployment
 * configuration in the sense of ADR-0020, and it appears in exactly one message — the one
 * refusal that stands between an old fork and silently destroying somebody's work.
 */
export const BALLASTELLA_CANONICAL_URL = 'https://artshumrc.github.io/ballastella/';

/** The name of a Project's manifest inside its directory (ADR-0008). */
export const PROJECT_FILE_NAME = 'project.json';

/** The path of a Project's manifest within the workspace. */
export const projectFilePath = (directory: string): string => `${directory}/${PROJECT_FILE_NAME}`;

/**
 * The one field this build reads in order to **throw it away** (ADR-0023).
 *
 * It was a list of the image ids whose map Layer the user had deleted, and it existed only because
 * an Alignment write created map Layers lazily: without a tombstone, deleting a Layer and then
 * nudging a Control Point silently brought it back. A map Layer is now created by exactly one thing
 * — the user adding a Map Image to a Project — so nothing can resurrect one and the field is
 * dead.
 *
 * Named here rather than left as an unknown field because "unknown" means *preserved*: `ProjectFile`
 * exists partly to keep a field a build one commit ahead added (ADR-0010), and that tolerance would
 * carry this tombstone in every existing `project.json` for the life of the Workspace — and rewrite
 * it in a new position the first time the user changed anything, giving them a diff that says
 * nothing. This is the opposite case: a field *this* build removed, whose meaning is known to be
 * nothing.
 */
const REMOVED_MAP_LAYERS_KEY = 'removedMapLayers';

/** The key {@link ProjectFile.description} is written under. */
const DESCRIPTION_KEY = 'description';

/**
 * A parsed `project.json`.
 *
 * Everything here is display state, never portability data: an Alignment is a Georeference
 * Annotation and an Annotation Layer is GeoJSON, both of which stand on their own (ADR-0002).
 * Nothing in this file is needed to read the scholarship.
 */
export interface ProjectFile {
	readonly formatVersion: number;
	/** The display name. May collide with another Project's; identity is the directory (ADR-0008). */
	readonly name: string;
	/**
	 * What the Project is, in the author's own words, or `''` when they have not said (ADR-0008).
	 *
	 * **Absent from the file means `''`**, and `''` is written as *absence*, for the reason
	 * `canonicalUrl` and `onFrontPage` give: a Project with nothing to say keeps the bytes it had
	 * before this field existed, so a Workspace in git gains no diff on the day the app is updated.
	 *
	 * Prose for a reader, never markup and never parsed: it is rendered as text wherever it is shown,
	 * for the reason `ProjectCardList` gives about a display name.
	 */
	readonly description: string;
	/**
	 * When the Project was last changed, ISO 8601.
	 *
	 * Recorded in the file rather than taken from the filesystem's modification time, because
	 * the workspace is expected to live in git or Dropbox (ADR-0008) and a fresh clone stamps
	 * every file with the moment of checkout. A Project's own record of when its author last
	 * touched it survives being moved, zipped, and cloned; a file mtime does not.
	 */
	readonly updatedAt: string;
	/**
	 * The ordered Layer stack, top first (ADR-0002).
	 *
	 * **The single most important field in the file.** Losing it is "not one annotation but the map
	 * of everything" (ADR-0017 rule 4), which is why it is written atomically, why `EditorSession` is
	 * the app's only writer of this document, and why `parseLayers` refuses to throw over a field it
	 * does not like.
	 */
	readonly layers: readonly Layer[];
	/**
	 * The author's default Base Map, by stable id and never by URL (ADR-0020).
	 *
	 * Normalised by `readBaseMapId`, the one reader of this field: anything that cannot be an id
	 * — a non-string, an empty string, whitespace alone — is `null`, meaning the author has not
	 * chosen. `resolveBaseMap` turns that into the deployment default.
	 */
	readonly baseMap: string | null;
	/**
	 * Which administrative boundaries the Base Map draws (`borders.ts`).
	 *
	 * Never `null`: unlike `baseMap`, where "the author has not chosen" is a state `resolveBaseMap`
	 * turns into a deployment default, every unusable value here means the documented default and
	 * `readBaseMapBorders` has already applied it. So a caller has a value it can draw with.
	 */
	readonly borders: BaseMapBorders;
	/**
	 * The address this Project's Map Images have been stamped for, or `null` (ADR-0004).
	 *
	 * Set only by the opt-in publish step that rewrites each `info.json` `id`, and remembered here so
	 * that a later publish can offer the same address rather than asking again — which is what makes
	 * a stamped `id` a *citable* IIIF endpoint rather than a value nobody can reproduce.
	 *
	 * **An address, and the one field in this file that is one.** It is not read to fetch anything:
	 * the editor assigns `Image#uri` from wherever the tiles really are, so moving a stamped Project
	 * cannot break it (ADR-0004's load-time override always wins). Compare `baseMap`, which is an id
	 * precisely *because* an address in Project data is the mistake ADR-0020 exists to prevent — the
	 * difference is that this one is a record of where the user published, not a place to fetch from.
	 *
	 * `null` is written as *absence*: an unstamped `project.json` is byte-identical to one written
	 * before this field existed, which is what keeps every byte-identity assertion in this codebase
	 * true and keeps a Workspace in git from gaining a diff on the day the app is updated.
	 */
	readonly canonicalUrl: string | null;
	/**
	 * Whether this Project is listed on the Published Site's Front Page (ADR-0032).
	 *
	 * **Absent from the file means `true`**, which is what every Project written before this field
	 * existed meant and what a new one means: publishing lists everything unless the author says
	 * otherwise. `false` is written; `true` is written as *absence*, so a Project on the Front Page is
	 * byte-identical to one from a build that had never heard of the choice.
	 *
	 * ⚠ **Not on the Front Page is not private, and nothing here should be read as if it were.** The
	 * repository is public and `?p=<directory>` opens the Project for anyone who knows the name; this
	 * decides one list and nothing else. The control that sets it says so in words, because a scholar
	 * with embargoed material will act on the reading the interface invites.
	 *
	 * **This field did not bump `CURRENT_FORMAT_VERSION`, deliberately.** ADR-0010 refuses a newer
	 * version outright, and one repository read by several instances at several versions multiplies
	 * exactly the skew that ADR names — so a build that has never heard of this carries it through
	 * {@link unknownFields} and writes it back untouched, rather than refusing the Project or silently
	 * taking a colleague's work off their own front page.
	 */
	readonly onFrontPage: boolean;
	/**
	 * How this Project reached this Workspace, oldest transfer first (ADR-0037).
	 *
	 * **Absent for a Project nobody imported**, which is every Project made here and every one written
	 * before Import existed — so the field costs those Projects no byte, exactly as `canonicalUrl` and
	 * `onFrontPage` cost them none. Written only by Import, and read-only everywhere else: it is a
	 * record of transfers, not metadata an author maintains.
	 *
	 * ⚠ **Not attribution, and it must never become it.** See `import-provenance.ts`: an entry names a
	 * route, and a filename or a repository owner is not the scholar who made the maps.
	 */
	readonly importProvenance?: readonly ImportProvenanceEntry[];
	/**
	 * Anything else the file carried, kept so that writing it back cannot drop it. The refusal
	 * below means we never write a file from a newer version, but the same-version case matters
	 * too: a field added by a build one commit ahead is not worth destroying (ADR-0010).
	 */
	readonly unknownFields: Readonly<Record<string, unknown>>;
}

/**
 * Refused rather than opened. Without this an old fork drops the fields it does not
 * recognise, writes the file back, and destroys the work with no error at all — and forking
 * is something this project actively invites, so the skew is structural (ADR-0010).
 */
export class ProjectFormatTooNewError extends Error {
	readonly formatVersion: number;
	readonly supportedFormatVersion: number;

	/**
	 * @param closing the reassurance the message ends on. The default is right for a Project sitting
	 *   in the Workspace, which is the common case and the one where "untouched" is the fact the user
	 *   needs. It is slightly wrong on an import, where there is no local Project to leave alone and
	 *   the fact that matters is that nothing arrived — which every other refusal on that path says.
	 */
	constructor(
		formatVersion: number,
		appUrl: string = BALLASTELLA_CANONICAL_URL,
		closing: string = 'It has been left untouched.'
	) {
		super(
			`This Project was made with a newer version of Ballastella ` +
				`(format ${formatVersion}; this copy understands ${CURRENT_FORMAT_VERSION}). ` +
				`Open it at ${appUrl}, or update your copy. ` +
				closing
		);
		this.name = 'ProjectFormatTooNewError';
		this.formatVersion = formatVersion;
		this.supportedFormatVersion = CURRENT_FORMAT_VERSION;
	}
}

/** The file is not a `project.json` at all — truncated, not JSON, or missing `formatVersion`. */
export class ProjectFileUnreadableError extends Error {
	constructor(reason: string) {
		super(`This Project's ${PROJECT_FILE_NAME} could not be read: ${reason}`);
		this.name = 'ProjectFileUnreadableError';
	}
}

/**
 * The Front Page choice a `project.json` records, from the field's raw value (ADR-0032).
 *
 * Only a literal `false` takes a Project off the Front Page. Absence is the default and the
 * pre-ADR-0032 behaviour, and a value of some other shape is a file somebody else's build wrote —
 * reading it as "not listed" would take a Project off a site over a field this parser could not make
 * sense of, which is the destructive direction.
 *
 * One implementation, so that {@link parseProjectFile} and {@link readOnFrontPage} cannot come to
 * different answers about the same file — the disagreement `readBaseMapId` exists to prevent.
 */
const onFrontPageOf = (value: unknown): boolean => value !== false;

/**
 * The Front Page choice out of bytes this build may not be able to parse as a `project.json`.
 *
 * ⚠ **Read rather than assumed, and that is the whole point.** `onFrontPage` is version-independent
 * by construction — the argument for not bumping `CURRENT_FORMAT_VERSION` for it (ADR-0010,
 * ADR-0032) — so a manifest from a newer build still says plainly what its author chose. Assuming
 * the default for one this build cannot otherwise read would put a Project its author took off the
 * Front Page back onto a public site, which is the one direction the format contract's tolerance
 * does not already guard.
 *
 * Bytes that are not a JSON object at all are on the Front Page, which is what an absent field means.
 */
export function readOnFrontPage(bytes: Uint8Array): boolean {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch {
		return true;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return true;
	return onFrontPageOf((raw as Record<string, unknown>).onFrontPage);
}

/**
 * Parse `project.json`.
 *
 * Reads only. Nothing here writes, and nothing calls for a write: merely looking at last
 * year's Project must not produce a diff in a git working tree or sync a rewrite to another
 * machine (ADR-0010). There is deliberately no migration machinery — there are no migrations
 * to run, and the first real format change brings its own ticket.
 */
export function parseProjectFile(bytes: Uint8Array): ProjectFile {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new ProjectFileUnreadableError(cause instanceof Error ? cause.message : String(cause));
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new ProjectFileUnreadableError('the file does not contain a JSON object');
	}

	const {
		formatVersion,
		name,
		description,
		updatedAt,
		layers,
		canonicalUrl,
		onFrontPage,
		[IMPORT_PROVENANCE_KEY]: importProvenance,
		...unknownFields
	} = raw as Record<string, unknown>;
	// Removed by the same key `readBaseMapId` reads it under, so the field cannot be recognised in
	// one place and treated as unknown in the other.
	delete unknownFields[PROJECT_BASE_MAP_KEY];
	// The same removal for the same reason: `readBaseMapBorders` reads this key off the raw document,
	// so leaving it here would have one field both modelled and carried, and `serialiseProjectFile`
	// would write the carried copy over the edit that had just been made.
	delete unknownFields[PROJECT_BORDERS_KEY];
	// **Dropped, not carried** (ADR-0023). `removedMapLayers` was a tombstone list that existed only
	// because an Alignment write created map Layers lazily; a Layer is now created by exactly one
	// thing — the user adding a Map Image to a Project — so the field means nothing to any build
	// that can read this one. Left in `unknownFields` it would be *preserved* by
	// `serialiseProjectFile` for the life of the Workspace, and preserved in a new position, so every
	// Project written by the previous build would gain a spurious diff on its first edit and keep a
	// dead field for ever. Reading a file that has it must still work, which is why this is a delete
	// here rather than a refusal: the value is ignored, the Project opens.
	delete unknownFields[REMOVED_MAP_LAYERS_KEY];
	// A history of some other shape is **carried rather than dropped**: an `importProvenance` that is
	// not an array is not a history this build can read, but it is somebody's field and the tolerance
	// every other unrecognised field here gets applies to it too (ADR-0010).
	if (importProvenance !== undefined && !Array.isArray(importProvenance)) {
		unknownFields[IMPORT_PROVENANCE_KEY] = importProvenance;
	}
	// A description of some other shape is **carried rather than dropped**, for the reason above: it is
	// not prose this build can render, but it is somebody's field and ADR-0010's tolerance covers it.
	if (description !== undefined && typeof description !== 'string') {
		unknownFields[DESCRIPTION_KEY] = description;
	}

	const provenance = parseImportProvenance(importProvenance);

	if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
		throw new ProjectFileUnreadableError('formatVersion is missing or is not an integer');
	}
	// Checked before anything else is trusted: a newer file's other fields may mean something
	// different from what they mean here.
	if (formatVersion > CURRENT_FORMAT_VERSION) throw new ProjectFormatTooNewError(formatVersion);

	return {
		formatVersion,
		name: typeof name === 'string' ? name : '',
		description: typeof description === 'string' ? description : '',
		updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
		// Tolerant by design and never throwing — see `parseLayers`. A Layer list that refused to
		// parse would turn one bad field into a Project that cannot be opened at all.
		layers: parseLayers(layers),
		// Through `readBaseMapId` rather than inline, so there is exactly one implementation of
		// "what did the author choose?". Two of them disagreeing meant `"baseMap": "  "` behaved
		// differently depending on which code path reached the file.
		baseMap: readBaseMapId(raw),
		// Total rather than nullable, and tolerant of every other shape — see `readBaseMapBorders`.
		borders: readBaseMapBorders(raw),
		// Anything that is not a usable address reads as unstamped rather than as an error, which is
		// the same tolerance every other field here gets: a `project.json` is a document somebody
		// else's build may have written, and one bad field must not make a Project unopenable.
		canonicalUrl:
			typeof canonicalUrl === 'string' && canonicalUrl.trim() !== '' ? canonicalUrl : null,
		onFrontPage: onFrontPageOf(onFrontPage),
		// Absent rather than empty when there is no history, so a Project nobody imported carries no
		// trace of the field and an empty array from somewhere else does not become one.
		...(provenance.length === 0 ? {} : { importProvenance: provenance }),
		unknownFields
	};
}

/**
 * Serialise `project.json`: tab-indented with a trailing newline, so a workspace kept in git
 * produces diffs a human can read and every write of an unchanged Project is byte-identical.
 */
export function serialiseProjectFile(file: ProjectFile): Bytes {
	const {
		unknownFields,
		formatVersion,
		name,
		description,
		updatedAt,
		layers,
		baseMap,
		borders,
		canonicalUrl,
		onFrontPage,
		importProvenance
	} = file;
	const history =
		importProvenance === undefined || importProvenance.length === 0 ? null : importProvenance;
	// The keys this build is about to write itself, taken out of what it carries: `parseProjectFile`
	// keeps a value of the wrong shape under its own key on purpose, and spread over a modelled one it
	// would silently drop the edit that had just been made.
	const shadowed = new Set(
		[history === null ? null : IMPORT_PROVENANCE_KEY, description === '' ? null : DESCRIPTION_KEY]
			.filter((key) => key !== null)
			.filter((key) => key in unknownFields)
	);
	const carried =
		shadowed.size === 0
			? unknownFields
			: Object.fromEntries(Object.entries(unknownFields).filter(([key]) => !shadowed.has(key)));
	const json = JSON.stringify(
		{
			formatVersion,
			name,
			// Omitted when the author has said nothing, so a Project without a description is
			// byte-identical to one from a build that had never heard of the field.
			...(description === '' ? {} : { description }),
			updatedAt,
			layers: serialiseLayers(layers),
			baseMap,
			// Written only when the author moved off the default, for the reason the three fields below
			// give: absence *is* `all`, so every Project written before this field existed keeps its exact
			// bytes and a Workspace kept in git gains no diff on the day the app is updated.
			...(borders === DEFAULT_BASE_MAP_BORDERS ? {} : { [PROJECT_BORDERS_KEY]: borders }),
			// Omitted entirely when there is none, rather than written as `null`. An unstamped Project's
			// bytes are then exactly what they were before this field existed — which is what keeps the
			// byte-identity assertions across reorder, rename, toggle, and opacity true, and keeps a
			// Workspace kept in git from gaining a diff on every Project the day the app is updated.
			...(canonicalUrl === null ? {} : { canonicalUrl }),
			// Written only when the author took the Project off the Front Page, for the same reason and
			// with the same effect: absence *is* the default, so every Project on the Front Page keeps the
			// bytes it had before ADR-0032 and a Workspace in git gains no diff on the day of the upgrade.
			//
			// Last of the named fields, so a Project that already carries a canonical stamp keeps its
			// existing key order too.
			...(onFrontPage ? {} : { onFrontPage: false }),
			// Written only by a Project that has been imported, for the third time and for the same
			// reason: a Project nobody transferred keeps the bytes it had before Import existed.
			...(history === null ? {} : { [IMPORT_PROVENANCE_KEY]: serialiseImportProvenance(history) }),
			// Spread last so nothing carried shadows a field an edit changed — with the one key this
			// build models under `importProvenance` taken out of it when there is a history to write.
			// `parseProjectFile` keeps a non-array `importProvenance` here on purpose, and spread over a
			// modelled history it would silently drop the entry a transfer had just appended.
			...carried
		},
		null,
		'\t'
	);
	return new TextEncoder().encode(`${json}\n`);
}

/** A brand-new Project's manifest. */
export function newProjectFile(name: string, updatedAt: Date, description = ''): ProjectFile {
	return {
		formatVersion: CURRENT_FORMAT_VERSION,
		name,
		description,
		updatedAt: updatedAt.toISOString(),
		layers: [],
		baseMap: null,
		borders: DEFAULT_BASE_MAP_BORDERS,
		canonicalUrl: null,
		onFrontPage: true,
		unknownFields: {}
	};
}
