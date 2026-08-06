// The Workspace's Historical Maps: where each one's tiles are, which Projects draw it, and what
// deleting one costs.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS MODULE EXISTS: THE FIVE SPELLINGS OF ONE QUESTION
//
// ADR-0023 deleted the stored `imageMode`, which was right — a claim in `project.json` could disagree
// with the bytes on disk, and repairing that disagreement is what the deleted interrupted-copy path
// existed for. But it did not give the *derived* answer a home, so "is this map's pyramid here, or is
// it on a Library's server?" acquired five implementations: a private `referencedImageIds` in
// `publish.ts`, `partitionByLocalCopy` in `remote-iiif/referenced-image.ts`, a 404 probe in the
// viewer's `readMapLayer`, and a `$derived` set in each app's page. Five spellings of one rule is how
// a Workspace ends up telling a user two different things about the same map.
//
// The rule is now {@link tileLocation} and there is one of it. Everything else here is the two ways
// of *observing* its two inputs, which genuinely do differ by backend:
//
//   * **A store that can list** — OPFS, a folder, the in-memory adapter — answers by walking
//     `images/` once. That is {@link historicalMapFiles}, and it is what the editor and publishing use.
//   * **A store that cannot** — ADR-0006's HTTP adapter, because a static host has no directory
//     listing — answers by asking for the two files by name and reading the 404. That is the viewer's
//     `readMapLayer`, which builds the same {@link HistoricalMapFiles} pair and hands it to the same
//     rule.
//
// So the seam is the *pair of observations*, not the store: two observers, one rule, and no sixth.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY NOTHING HERE OPENS A PYRAMID
//
// `workspace-size.ts` states the discipline in full and it applies unchanged: a mirrored pyramid is
// tens of thousands of tiles, `ProjectStore#size` answers from directory metadata for free, and a
// total assembled with `read` would be the slowest thing in the application while returning exactly
// the same number. Nothing below reads a tile or an `info.json`.
//
// It does read two kinds of small document, and the difference is a per-*map* cost rather than a
// per-*file* one: every `project.json`, because "which Projects use this map" is a fact about the
// Layer stacks and there is nowhere else it lives; and one `manifest.json` or `remote.json` per map,
// because an image id is a random identifier (ADR-0015) and a reclaim list naming maps after hashes
// would be unusable. {@link unusedHistoricalMapBytes}, which publishing calls on every plan, skips the
// labels entirely and weighs only the directories of maps nothing uses — usually none of them.

import { alignmentPath } from '../alignment/alignment.js';
import {
	parseReferencedImage,
	referencedImagePath,
	type ReferencedImage
} from '../remote-iiif/referenced-image.js';
import { readImageLabel } from '../tiler/image-manifest.js';
import { topLevelSegment, type ProjectStore, type StorePath } from '../store/project-store.js';
import {
	IMAGE_DIRECTORY,
	imageDirectory,
	imageInfoPath,
	imageManifestPath
} from './image-files.js';
import { parseProjectFile, projectFilePath } from './project-file.js';

/** Where one Historical Map's tiles are served from, as observed rather than as claimed. */
export type TileLocation = 'in-workspace' | 'referenced';

/**
 * The two files whose presence answers it, and the whole of the evidence.
 *
 * Booleans rather than paths, so the same shape can come from a directory listing or from two
 * requests that either answered or 404ed — which is what lets the viewer share the rule below with a
 * store that has no `list`.
 */
export interface HistoricalMapFiles {
	/** An `info.json` of ours is beside the map: its tiles are files of this Workspace. */
	readonly infoJson: boolean;
	/** A `remote.json` is beside it: the Workspace records where the map came from. */
	readonly remoteJson: boolean;
}

/**
 * ADR-0023's rule, and the only implementation of it: **an `info.json` of ours means the tiles are
 * here.**
 *
 * `null` for a directory holding neither, which is not a Historical Map at all — the tiles of an
 * ingest that was interrupted, since `info.json` is written last precisely so that an incomplete
 * pyramid is invisible (`listIngestedImages`). Nothing may list it, delete it, or count it.
 *
 * **Both files means the tiles are here**, and that is mirroring working rather than an ambiguity: an
 * offline copy writes a pyramid into the directory and deliberately leaves the `remote.json`, because
 * that record is the citation ADR-0007 exists to protect. Reading "both" the other way is the defect
 * this rule was gathered to stop — publishing warned about a network dependency the Workspace no
 * longer had, and the editor's Layers pane sent the renderer back to a library for tiles already on
 * the disk.
 */
export function tileLocation(files: HistoricalMapFiles): TileLocation | null {
	if (files.infoJson) return 'in-workspace';
	return files.remoteJson ? 'referenced' : null;
}

/** A Project that draws a Historical Map, as the refusal and the list name it. */
export interface HistoricalMapUser {
	/** The Project's identity: its directory name (ADR-0008). */
	readonly directory: string;
	/** Its display name, or the directory when it has none. */
	readonly name: string;
}

/** One Historical Map of the Workspace, as the hub's reclaim list shows it. */
export interface WorkspaceHistoricalMap {
	readonly imageId: string;
	/** What the user calls it, or `''` when neither record says. */
	readonly label: string;
	readonly tiles: TileLocation;
	/** The host serving the tiles, `''` when they are in this Workspace. */
	readonly host: string;
	/** Everything deleting this map would reclaim: its pyramid, its records, and its Alignment. */
	readonly bytes: number;
	/** How many files that was. "3 files" and "31 000 files" are different news. */
	readonly files: number;
	/** The Projects whose Layers draw it, by directory order. Empty when none do. */
	readonly usedBy: readonly HistoricalMapUser[];
}

/** Every path under `images/<id>/`, grouped by image id, with the two files that classify it. */
async function scanImages(
	store: Pick<ProjectStore, 'list'>
): Promise<Map<string, { files: HistoricalMapFiles; paths: StorePath[] }>> {
	const prefix = `${IMAGE_DIRECTORY}/`;
	const found = new Map<string, { infoJson: boolean; remoteJson: boolean; paths: StorePath[] }>();

	for (const path of await store.list(prefix)) {
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf('/');
		// `images/<id>` with nothing after it names no file, and a path this walk cannot split is not
		// one this app wrote.
		if (slash <= 0) continue;
		const imageId = rest.slice(0, slash);
		const entry = found.get(imageId) ?? { infoJson: false, remoteJson: false, paths: [] };
		entry.paths.push(path);
		// Compared against the helpers that own the layout rather than against spelled-out names, so a
		// change to where either file lives cannot leave this classifying by a stale one.
		if (path === imageInfoPath(imageId)) entry.infoJson = true;
		else if (path === referencedImagePath(imageId)) entry.remoteJson = true;
		found.set(imageId, entry);
	}

	const maps = new Map<string, { files: HistoricalMapFiles; paths: StorePath[] }>();
	for (const [imageId, entry] of found) {
		const files = { infoJson: entry.infoJson, remoteJson: entry.remoteJson };
		if (tileLocation(files) !== null) maps.set(imageId, { files, paths: entry.paths });
	}
	return maps;
}

/**
 * What the Workspace's `images/` directory says about each Historical Map in it — one `list` and no
 * `read` at all.
 *
 * One walk rather than one per Layer or one per Project: a Workspace holds tens of thousands of tile
 * files, and this is the walk that must not happen more than once.
 */
export async function historicalMapFiles(
	store: Pick<ProjectStore, 'list'>
): Promise<Map<string, HistoricalMapFiles>> {
	return new Map([...(await scanImages(store))].map(([imageId, map]) => [imageId, map.files]));
}

/**
 * The Historical Maps whose tiles are on somebody else's server, by image id.
 *
 * What publishing warns from (ADR-0007, SPEC stories 29 and 90) and what the editor's Layers pane
 * hands the renderer an address for. Both used to work it out for themselves.
 */
export async function referencedHistoricalMaps(
	store: Pick<ProjectStore, 'list'>
): Promise<ReadonlySet<string>> {
	const referenced = new Set<string>();
	for (const [imageId, files] of await historicalMapFiles(store)) {
		if (tileLocation(files) === 'referenced') referenced.add(imageId);
	}
	return referenced;
}

/**
 * Which Projects draw which Historical Maps, read from every `project.json` in the Workspace.
 *
 * **The Layer stacks are the only record of it** (ADR-0023): a pyramid belongs to the Workspace and
 * carries no list of its users, so the question is answered by reading the documents that reference
 * it. Reads nothing else, and in particular no pyramid.
 *
 * A Project counted **once** however many of its Layers draw the same map, because the sentence this
 * feeds is "used by Amsterdam 1625 and Boston 1775" and naming a Project twice reads as a bug.
 *
 * A Project whose document will not parse is skipped in silence, the same call `publish.ts` makes: the
 * hub already lists it with its own problem, and a second message about its Layers would say nothing a
 * user could act on. It does mean a map used only by an unreadable Project can be deleted — which is
 * the better of the two errors, since the alternative is a map that can never be deleted because of a
 * file nothing can read.
 */
export async function historicalMapUsage(
	store: Pick<ProjectStore, 'list' | 'read'>
): Promise<Map<string, HistoricalMapUser[]>> {
	const usage = new Map<string, HistoricalMapUser[]>();

	for (const path of await store.list('')) {
		const directory = topLevelSegment(path);
		if (path !== projectFilePath(directory)) continue;

		let layers;
		let name;
		try {
			const file = parseProjectFile(await store.read(path));
			layers = file.layers;
			name = file.name || directory;
		} catch {
			continue;
		}

		for (const layer of layers) {
			if (layer.kind !== 'map' || layer.imageId === '') continue;
			const users = usage.get(layer.imageId) ?? [];
			if (!users.some((user) => user.directory === directory)) {
				users.push({ directory, name });
			}
			usage.set(layer.imageId, users);
		}
	}

	return usage;
}

/**
 * Every Historical Map in the Workspace, with everything the hub's list says about it.
 *
 * The one place a scholar can answer "why is my Workspace two gigabytes?". Sorted by image id, which
 * is stable across two calls and independent of the order a filesystem happens to enumerate in — a
 * reclaim list that reshuffled itself between renders would move the Delete button under the cursor.
 */
export async function listWorkspaceHistoricalMaps(
	store: ProjectStore
): Promise<WorkspaceHistoricalMap[]> {
	const scanned = await scanImages(store);
	const usage = await historicalMapUsage(store);

	const maps = await Promise.all(
		[...scanned].map(
			async ([imageId, { files, paths }]): Promise<WorkspaceHistoricalMap | null> => {
				const tiles = tileLocation(files);
				/* v8 ignore next -- `scanImages` has already dropped every directory this is null for. */
				if (tiles === null) return null;

				const remote = files.remoteJson ? await readRemoteRecord(store, imageId) : null;
				const named = files.infoJson ? await readManifestLabel(store, imageId) : '';

				return {
					imageId,
					label: named || remote?.label || '',
					tiles,
					// A mirrored map's tiles are here, so it names no host even though it still records one.
					host: tiles === 'referenced' ? hostOf(remote?.service ?? '') : '',
					...(await weigh(store, imageId, paths)),
					usedBy: usage.get(imageId) ?? []
				};
			}
		)
	);

	return maps.filter((map) => map !== null).sort((a, b) => a.imageId.localeCompare(b.imageId));
}

/**
 * The byte weight of the Historical Maps no Project uses, for ADR-0008's publish warning (SPEC story
 * 98).
 *
 * **Weighs only the unused maps**, which is what keeps this cheap enough to run on every publish plan:
 * the classification and the usage cost one walk of `images/` and one read per Project, and the `size`
 * calls — the part that scales with the number of tiles — happen only for directories nothing draws.
 * In the ordinary Workspace, where every map is in use, there are none.
 */
export async function unusedHistoricalMapBytes(
	store: ProjectStore
): Promise<{ bytes: number; maps: number }> {
	const scanned = await scanImages(store);
	const usage = await historicalMapUsage(store);

	const unused = [...scanned].filter(([imageId]) => (usage.get(imageId) ?? []).length === 0);
	const weights = await Promise.all(
		unused.map(([imageId, { paths }]) => weigh(store, imageId, paths))
	);

	return {
		bytes: weights.reduce((sum, weight) => sum + weight.bytes, 0),
		maps: unused.length
	};
}

/** Everything deleting this map would reclaim, from `size` and never from `read`. */
async function weigh(
	store: Pick<ProjectStore, 'size'>,
	imageId: string,
	paths: readonly StorePath[]
): Promise<{ bytes: number; files: number }> {
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
	// The Alignment as well as the pyramid, because deletion takes it — so the figure the user reads
	// beside the Delete button is what the Workspace total actually drops by. A map nobody has placed
	// yet has none, which is the ordinary first state rather than a failure.
	const placement = await store.size(alignmentPath(imageId)).catch(() => null);

	return {
		bytes: sizes.reduce((sum, size) => sum + size, 0) + (placement ?? 0),
		files: paths.length + (placement === null ? 0 : 1)
	};
}

/**
 * Deleting this Historical Map would break Projects that draw it, so it was not deleted.
 *
 * **A refusal and not a confirmation offering to cascade.** One click that destroys three arguments is
 * not a click this application has; the message names the Projects, and the user removes the Layers
 * themselves if that is what they want.
 */
export class HistoricalMapInUseError extends Error {
	readonly imageId: string;
	/** The Projects that draw it, in the order the message names them. */
	readonly projects: readonly HistoricalMapUser[];

	constructor(imageId: string, label: string, projects: readonly HistoricalMapUser[]) {
		const named = projects.map((project) => `“${project.name}”`).join(' and ');
		super(
			`“${label || imageId}” is drawn by ${projects.length === 1 ? 'the Project' : 'the Projects'} ` +
				`${named}, so it has not been deleted — ${projects.length === 1 ? 'that Project' : 'those Projects'} ` +
				`would be left with a Layer that draws nothing. Remove the Layer from ` +
				`${projects.length === 1 ? 'it' : 'each of them'} first if you no longer need this map.`
		);
		this.name = 'HistoricalMapInUseError';
		this.imageId = imageId;
		this.projects = projects;
	}
}

/**
 * Delete one Historical Map: its pyramid, its `remote.json`, and its Alignment.
 *
 * **All three, or the Workspace keeps an orphaned Alignment for a map that no longer exists** — and
 * `alignments/<id>.json` is what a later import would deduplicate against, so the leftover would make
 * a colleague's copy of the same map arrive without its own placement.
 *
 * **The refusal is checked before anything is deleted**, which is the whole of its value: a refusal
 * that had already removed half the tiles would leave the Projects it was protecting drawing a
 * half-pyramid.
 *
 * @throws HistoricalMapInUseError when any Project's Layers draw it
 */
export async function deleteHistoricalMap(
	store: ProjectStore,
	imageId: string,
	options: { label?: string } = {}
): Promise<void> {
	const users = (await historicalMapUsage(store)).get(imageId) ?? [];
	if (users.length > 0) throw new HistoricalMapInUseError(imageId, options.label ?? '', users);

	for (const path of await store.list(`${imageDirectory(imageId)}/`)) {
		await store.delete(path);
	}
	await store.delete(alignmentPath(imageId));
	// The half-finished writes `list` cannot report and `delete` cannot be handed, exactly as
	// `deleteProject` sweeps them: without this, a "deleted" map's directory survives on disk holding
	// bytes that are also missing from the totals this list exists to explain. Scoped to this map's own
	// directory, so it cannot reach the temporary file of an ingest running beside it.
	await store.reclaimAbandonedWrites(`${imageDirectory(imageId)}/`);
}

/**
 * Split the Workspace's remote-origin records by whether a pyramid of ours is beside them.
 *
 * Moved here from `remote-iiif/referenced-image.ts` so that it and {@link referencedHistoricalMaps}
 * answer through {@link tileLocation} rather than through two independent readings of the same rule.
 *
 * `mirrored` keeps its record, which is why this is a partition of the records rather than a removal
 * from them: a mirrored Historical Map must still be able to say where it came from (ADR-0007 —
 * "mirroring must not orphan the copy").
 */
export function partitionByLocalCopy(
	images: readonly ReferencedImage[],
	ingested: readonly { readonly imageId: string }[]
): { referenced: ReferencedImage[]; mirrored: ReferencedImage[] } {
	const local = new Set(ingested.map((image) => image.imageId));
	const referenced: ReferencedImage[] = [];
	const mirrored: ReferencedImage[] = [];

	for (const image of images) {
		// Every image here came from a `remote.json`, which is `remoteJson: true`; `ingested` is the
		// `info.json` half. The same two observations the listing walk makes, through the same rule.
		const where = tileLocation({ infoJson: local.has(image.imageId), remoteJson: true });
		(where === 'referenced' ? referenced : mirrored).push(image);
	}

	return { referenced, mirrored };
}

/** The record beside a referenced map, or `null` when it will not parse. */
async function readRemoteRecord(
	store: Pick<ProjectStore, 'read'>,
	imageId: string
): Promise<ReferencedImage | null> {
	try {
		return parseReferencedImage(await store.read(referencedImagePath(imageId)), { imageId });
	} catch {
		// A record that will not parse costs the label and the host, and the map is still listed with
		// its size: this is the reclaim list, and a map nothing can read is one a user most needs to be
		// able to delete.
		return null;
	}
}

/** What the user calls a locally held map, out of its manifest, or `''`. */
async function readManifestLabel(
	store: Pick<ProjectStore, 'read'>,
	imageId: string
): Promise<string> {
	try {
		const bytes = await store.read(imageManifestPath(imageId));
		return readImageLabel(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		return '';
	}
}

/** The host of a service URI, or `''` when there is not one to name. */
function hostOf(service: string): string {
	try {
		return new URL(service).host;
	} catch {
		return '';
	}
}
