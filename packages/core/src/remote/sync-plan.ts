// What a Sync found, in the terms it has to be offered in (ADR-0044).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROJECTS AND MAP IMAGES, NEVER PATHS, AND THAT IS THE WHOLE REASON THIS MODULE EXISTS
//
// A Sync of one map is four thousand paths. Listed, that is not a column anybody reads and not a
// decision anybody can take; named, it is one line — *the Map Image `amsterdam-1625`, 4,102 files*.
// The path set behind a {@link Change} is the engine's business and never reaches the interface,
// which is the same rule the inbound and outbound deletion previews arrived at separately before one
// modal replaced both.
//
// ⚠ **The three kinds are the Workspace's own, and there is no fourth.** The source namespace is
// `images/**`, `alignments/**`, `base-map/tiles/**`, `<dir>/project.json` and `<dir>/annotations/**`
// — so every source path belongs to a Map Image, to the Base Map's offline tiles, or to a Project.
// A grouping that fell through to a raw path would put one on screen.
//
// ⚠ **An Alignment belongs to its Map Image.** `alignments/<id>.json` sits beside the pyramid rather
// than inside it, so a purely prefix-shaped grouping would name it separately in the same breath as
// saying the Map Image it places is going.

import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { topLevelSegment } from '../store/project-store.js';
import type { PathChoice, SourcePath } from './synchronization-planner.js';
import { REQUESTS_BEYOND_BLOBS } from './send-to-remote.js';
import type { RemoteSendPlan } from './send-to-remote.js';

/** Which of the four things a Sync does. One plan; the mode chooses what is acted on. */
export type SyncMode = 'get' | 'send' | 'both' | 'overwrite';

/** One Project, Map Image or Base Map cache a Sync would move, named the way its author knows it. */
export interface Change {
	readonly kind: 'project' | 'map-image' | 'base-map';
	/** The Project's directory or the Map Image's identity — what the Remote's tree calls it. */
	readonly id: string;
	/**
	 * What the author calls it.
	 *
	 * A Project's display name where the caller could read one, and the directory otherwise — which
	 * is a real answer rather than a placeholder: it is what a file browser shows and what `?p=`
	 * names (ADR-0008). A Project only the Remote has never has a name here, by construction.
	 */
	readonly name: string;
	/** How many paths this Change accounts for. */
	readonly files: number;
}

/** One direction's three groups. Each is named; none is a count of files on its own. */
export interface SyncColumn {
	readonly added: readonly Change[];
	readonly changed: readonly Change[];
	readonly removed: readonly Change[];
}

/**
 * What pressing Sync found, before anything has moved.
 *
 * ⚠ **`budget.remaining` and `budget.resetsAt` are nullable and the engine cannot make them
 * otherwise.** GitHub's rate-limit headers are read rather than inferred, and a corporate proxy
 * strips them — `Number(null)` is `0`, and a budget silently read as nought turns every later 403
 * into "wait for the reset". So *unavailable* is a state the modal says out loud.
 */
export interface SyncPlan {
	/** What the Remote has that this Workspace has not. */
	readonly toGet: SyncColumn;
	/** What this Workspace has that the Remote has not. */
	readonly toSend: SyncColumn;
	/**
	 * Paths changed on both sides since the two last agreed.
	 *
	 * ⚠ **Reported so the modal can say what getting will *make*, never so it can refuse** (ADR-0046).
	 * Each one becomes a second copy the scholar can look at — or, for an Alignment, the one question
	 * in the product — and the rest of the Sync goes ahead around it either way.
	 */
	readonly conflicts: readonly SourcePath[];
	/** What an `overwrite` would take off the Remote, named the same way as everything else. */
	readonly overwrites: readonly Change[];
	readonly budget: {
		/**
		 * How many GitHub requests sending would need: one per blob, plus the tree, the commit and
		 * the ref move.
		 *
		 * ⚠ **The whole send, not the blobs alone**, because that is the number the hourly budget is
		 * spent against — and a plan within three of what is left uploads every byte and then meets
		 * its 403 at `POST /git/trees`, which is the most expensive place to stop.
		 */
		readonly requests: number;
		readonly remaining: number | null;
		readonly resetsAt: Date | null;
	};
	/** What sending would move. */
	readonly size: { readonly bytes: number; readonly files: number };
}

/** Which Project, Map Image or Base Map cache a source path belongs to. */
function owner(path: string): { kind: Change['kind']; id: string } {
	if (path.startsWith(BASE_MAP_TILE_ROOT)) return { kind: 'base-map', id: 'base-map' };
	if (path.startsWith(`${IMAGE_DIRECTORY}/`)) {
		return { kind: 'map-image', id: path.split('/')[1] ?? path };
	}
	if (path.startsWith(`${ALIGNMENT_DIRECTORY}/`)) {
		const file = path.slice(ALIGNMENT_DIRECTORY.length + 1);
		return { kind: 'map-image', id: file.replace(/\.json$/, '') };
	}
	return { kind: 'project', id: topLevelSegment(path) };
}

/**
 * Group source paths into the things a person can be told about, in a stable order.
 *
 * Map Images first, then the Base Map, then Projects — largest and most surprising first, which is
 * the order the counts make legible: a scholar meeting one line reading *4,102 files* wants to know
 * which map it is before they read the three Annotation Projects underneath it.
 */
export function describeChanges(
	paths: Iterable<string>,
	names: ReadonlyMap<string, string> = new Map()
): readonly Change[] {
	const counted = new Map<string, { kind: Change['kind']; id: string; files: number }>();
	for (const path of paths) {
		const { kind, id } = owner(path);
		const key = `${kind}\u0000${id}`;
		const seen = counted.get(key);
		if (seen === undefined) counted.set(key, { kind, id, files: 1 });
		else seen.files += 1;
	}
	const order: Record<Change['kind'], number> = { 'map-image': 0, 'base-map': 1, project: 2 };
	return [...counted.values()]
		.sort((left, right) => order[left.kind] - order[right.kind] || (left.id < right.id ? -1 : 1))
		.map((entry) => ({
			kind: entry.kind,
			id: entry.id,
			name:
				entry.kind === 'base-map'
					? 'The Base Map’s offline tiles'
					: (names.get(entry.id) ?? entry.id),
			files: entry.files
		}));
}

const column = (
	choices: readonly PathChoice[],
	removed: Iterable<string>,
	names: ReadonlyMap<string, string>
): SyncColumn => ({
	added: describeChanges(
		choices.filter((choice) => choice.effect === 'add').map((choice) => choice.path),
		names
	),
	changed: describeChanges(
		choices.filter((choice) => choice.effect === 'replace').map((choice) => choice.path),
		names
	),
	removed: describeChanges(removed, names)
});

/**
 * Read a forecast as the two columns the Sync modal is made of.
 *
 * ⚠ **Both columns come from one plan and one tree listing**, so they cannot disagree about which
 * side a difference is on — which is the disagreement that made two separate gestures unsafe.
 *
 * @param names Project directory → the display name its `project.json` gives it, where the caller
 *   has read one. A Project only the Remote holds is named by its directory.
 */
export function describeSyncPlan(
	upload: RemoteSendPlan,
	names: ReadonlyMap<string, string> = new Map()
): SyncPlan {
	const incoming = upload.incoming;
	return {
		toGet: column(
			incoming,
			incoming.filter((choice) => choice.effect === 'delete').map((choice) => choice.path),
			names
		),
		// `keep` is filtered out by {@link column}: a path the Remote already holds at these very bytes
		// is not a change, and listing it would put every Project in a column on every Sync for ever.
		toSend: column(upload.outgoing, upload.removed, names),
		conflicts: upload.conflicts,
		overwrites: describeChanges(upload.overwrites, names),
		budget: {
			requests: upload.uploads + REQUESTS_BEYOND_BLOBS,
			remaining: upload.requestsRemaining,
			resetsAt: upload.requestsResetAt
		},
		size: { bytes: upload.uploadBytes, files: upload.uploads }
	};
}
