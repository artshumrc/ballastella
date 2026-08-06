import { PROJECT_BASE_MAP_KEY, readBaseMapId } from '../base-map/project.js';
import type { Bytes } from '../store/project-store.js';
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
	 * The address this Project's Historical Maps have been stamped for, or `null` (ADR-0004).
	 *
	 * Set only by the opt-in publish step that rewrites each `info.json` `id`, and remembered here so
	 * that a later publish can offer the same address rather than asking again — which is what makes
	 * a stamped `id` a *citable* IIIF endpoint rather than a value nobody can reproduce (SPEC story
	 * 92).
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

	const { formatVersion, name, updatedAt, layers, canonicalUrl, ...unknownFields } = raw as Record<
		string,
		unknown
	>;
	// Removed by the same key `readBaseMapId` reads it under, so the field cannot be recognised in
	// one place and treated as unknown in the other.
	delete unknownFields[PROJECT_BASE_MAP_KEY];

	if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
		throw new ProjectFileUnreadableError('formatVersion is missing or is not an integer');
	}
	// Checked before anything else is trusted: a newer file's other fields may mean something
	// different from what they mean here.
	if (formatVersion > CURRENT_FORMAT_VERSION) throw new ProjectFormatTooNewError(formatVersion);

	return {
		formatVersion,
		name: typeof name === 'string' ? name : '',
		updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
		// Tolerant by design and never throwing — see `parseLayers`. A Layer list that refused to
		// parse would turn one bad field into a Project that cannot be opened at all.
		layers: parseLayers(layers),
		// Through `readBaseMapId` rather than inline, so there is exactly one implementation of
		// "what did the author choose?". Two of them disagreeing meant `"baseMap": "  "` behaved
		// differently depending on which code path reached the file.
		baseMap: readBaseMapId(raw),
		// Anything that is not a usable address reads as unstamped rather than as an error, which is
		// the same tolerance every other field here gets: a `project.json` is a document somebody
		// else's build may have written, and one bad field must not make a Project unopenable.
		canonicalUrl:
			typeof canonicalUrl === 'string' && canonicalUrl.trim() !== '' ? canonicalUrl : null,
		unknownFields
	};
}

/**
 * Serialise `project.json`: tab-indented with a trailing newline, so a workspace kept in git
 * produces diffs a human can read and every write of an unchanged Project is byte-identical.
 */
export function serialiseProjectFile(file: ProjectFile): Bytes {
	const { unknownFields, formatVersion, name, updatedAt, layers, baseMap, canonicalUrl } = file;
	const json = JSON.stringify(
		{
			formatVersion,
			name,
			updatedAt,
			layers: serialiseLayers(layers),
			baseMap,
			// Omitted entirely when there is none, rather than written as `null`. An unstamped Project's
			// bytes are then exactly what they were before this field existed — which is what keeps the
			// byte-identity assertions across reorder, rename, toggle, and opacity true, and keeps a
			// Workspace kept in git from gaining a diff on every Project the day the app is updated.
			...(canonicalUrl === null ? {} : { canonicalUrl }),
			...unknownFields
		},
		null,
		'\t'
	);
	return new TextEncoder().encode(`${json}\n`);
}

/** A brand-new Project's manifest. */
export function newProjectFile(name: string, updatedAt: Date): ProjectFile {
	return {
		formatVersion: CURRENT_FORMAT_VERSION,
		name,
		updatedAt: updatedAt.toISOString(),
		layers: [],
		baseMap: null,
		canonicalUrl: null,
		unknownFields: {}
	};
}
