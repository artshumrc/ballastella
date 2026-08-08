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
// `publish.ts`, `partitionByOfflineCopy` in `remote-iiif/referenced-image.ts`, a 404 probe in the
// viewer's `readMapLayer`, and a `$derived` set in each app's page. Five spellings of one rule is how
// a Workspace ends up telling a user two different things about the same map.
//
// The rule is now {@link tileLocation} and there is one of it. Everything else here is a way of
// *observing* its two inputs, and the observation genuinely does differ by backend:
//
//   * **A store that can list** — OPFS, a folder, the in-memory adapter — answers by walking
//     `images/` once. That is `scanImages`, and it is what the editor and publishing use.
//   * **A store that cannot** — ADR-0006's HTTP adapter, because a static host has no directory
//     listing — answers by asking for the two files by name and reading the 404. That is the viewer's
//     `readMapLayer`, which builds the same {@link HistoricalMapFiles} pair and hands it to the same
//     rule.
//   * **{@link partitionByOfflineCopy}**, which observes only one of the two: every record it is handed
//     came out of a `remote.json`, so `remoteJson` is true by construction and the rule there reduces
//     to "is a pyramid of ours beside it?". It routes through {@link tileLocation} anyway so that the
//     reading of *both files present* — an offline copy, not an ambiguity — is decided in one place;
//     but it is an observer that carries one fact through the rule rather than two, and calling it a
//     peer of the other two would overstate what it shares.
//
// So the seam is the *set of observations*, not the store: three observers, one rule, and no sixth
// spelling of the rule itself.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY NOTHING HERE OPENS A PYRAMID
//
// `workspace-size.ts` states the discipline in full and it applies unchanged: an offline copy's pyramid is
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
//
// **What this does cost, stated plainly.** Each public question below walks for itself. On a publish
// plan that is `list('')` twice — once for `workspaceSize` and once for the usage read — and
// `list('images/')` twice, once for {@link unusedHistoricalMapBytes} and once for
// {@link referencedHistoricalMaps}. On a Workspace holding thirty thousand tiles that is four
// enumerations of thirty thousand entries, beside the thirty thousand `size` calls `workspaceSize`
// already makes; the enumerations are the cheaper half, and it is `size` that would have to go first
// if this ever needs to be faster. Sharing one walk between the questions was considered and not
// done: it would make every caller carry a scan object so that publishing — the only caller that asks
// more than one question at a time — could save two enumerations.

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
import { ProjectFormatTooNewError, parseProjectFile, projectFilePath } from './project-file.js';

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
 * **Both files means the tiles are here**, and that is making an offline copy working rather than an ambiguity: an
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
	/**
	 * The Library serving the tiles, named by its address, and `''` when they are in this Workspace.
	 *
	 * "Library" and never "host": CONTEXT.md reserves the word for the institution whose server a
	 * referenced map's tiles stay on, which is exactly what this is.
	 */
	readonly library: string;
	/** Everything deleting this map would reclaim: its pyramid, its records, and its Alignment. */
	readonly bytes: number;
	/** How many files that was. "3 files" and "31 000 files" are different news. */
	readonly files: number;
	/** The Projects whose Layers draw it, by directory order. Empty when none do. */
	readonly usedBy: readonly HistoricalMapUser[];
	/**
	 * Projects made with a newer build of Ballastella, whose Layers this build cannot read (ADR-0010).
	 *
	 * The **same list on every map**, because that is precisely what is known: the document is readable
	 * and certainly has a Layer stack, but not one this build can parse, so any map in the Workspace
	 * might be one it draws. They count as users — the map is not offered for deletion and does not
	 * appear in the unused figure — because the alternative is telling a scholar "no Project uses this
	 * map" about a map the build that wrote that Project would find missing.
	 */
	readonly mightBeUsedBy: readonly HistoricalMapUser[];
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
 * files, so a question answered per Layer is the walk repeated once per Layer.
 *
 * Not exported from the package: {@link referencedHistoricalMaps} is the answer callers actually
 * want, and a second door onto the raw pair is a second place for the rule to be re-read.
 */
async function historicalMapFiles(
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

/** Who draws what, as {@link historicalMapUsage} answers it. */
export interface HistoricalMapUsage {
	/** The Projects whose Layers name each image id, by image id. */
	readonly byMap: ReadonlyMap<string, readonly HistoricalMapUser[]>;
	/**
	 * Projects from a newer build, whose Layers this build cannot read — possible users of every map.
	 *
	 * See {@link WorkspaceHistoricalMap.mightBeUsedBy} for why they are not simply skipped.
	 */
	readonly fromANewerVersion: readonly HistoricalMapUser[];
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
 * **A Project whose document is corrupt is skipped in silence**, the same call `publish.ts` makes:
 * the hub already lists it with its own problem, and a second message about its Layers would say
 * nothing a user could act on. It does mean a map used only by an unreadable Project can be deleted —
 * which is the better of the two errors, since the alternative is a map that can never be deleted
 * because of a file nothing can read.
 *
 * **A Project from a newer build is not corrupt and is not skipped.** ADR-0010 refuses to open it
 * *because it is intact* — SPEC story 114 wants refusal rather than partial loading — and the same
 * hub that lists it as "made with a newer version" must not, two sections below, offer to delete a map
 * it may well draw. Its Layers cannot be read, so what is known is only "this Project might use any
 * map", and that is what {@link HistoricalMapUsage.fromANewerVersion} carries. It takes the directory
 * as its name, exactly as `listProjects` does for the same Project.
 */
export async function historicalMapUsage(
	store: Pick<ProjectStore, 'list' | 'read'>
): Promise<HistoricalMapUsage> {
	const byMap = new Map<string, HistoricalMapUser[]>();
	const fromANewerVersion: HistoricalMapUser[] = [];

	for (const path of await store.list('')) {
		const directory = topLevelSegment(path);
		if (path !== projectFilePath(directory)) continue;

		let layers;
		let name;
		try {
			const file = parseProjectFile(await store.read(path));
			layers = file.layers;
			name = file.name || directory;
		} catch (cause) {
			if (cause instanceof ProjectFormatTooNewError) {
				fromANewerVersion.push({ directory, name: directory });
			}
			continue;
		}

		for (const layer of layers) {
			if (layer.kind !== 'map' || layer.imageId === '') continue;
			const users = byMap.get(layer.imageId) ?? [];
			if (!users.some((user) => user.directory === directory)) {
				users.push({ directory, name });
			}
			byMap.set(layer.imageId, users);
		}
	}

	return { byMap, fromANewerVersion };
}

/** The Projects known to draw one map. Empty is "none of the readable ones", not "none". */
const usersOf = (usage: HistoricalMapUsage, imageId: string): readonly HistoricalMapUser[] =>
	usage.byMap.get(imageId) ?? [];

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
					// A copied map's tiles are here, so it names no Library even though it still
					// records where it came from.
					library: tiles === 'referenced' ? libraryOf(remote?.service ?? '') : '',
					...(await weigh(store, imageId, paths)),
					usedBy: usersOf(usage, imageId),
					mightBeUsedBy: usage.fromANewerVersion
				};
			}
		)
	);

	return maps.filter((map) => map !== null).sort((a, b) => a.imageId.localeCompare(b.imageId));
}

/** What a Historical Map has to look like to be counted, whoever is doing the counting. */
interface Reclaimable {
	readonly bytes: number;
	readonly usedBy: readonly unknown[];
	readonly mightBeUsedBy: readonly unknown[];
}

/**
 * The Historical Maps in a listing that no Project draws, and what they weigh.
 *
 * **The single definition of this ticket's headline figure**, so the hub's "of which 340 MB is used
 * by no Project" and publishing's warning cannot disagree. It was written twice — once here and once
 * as a pair of `$derived` reductions in `ProjectHub.svelte` — which is how the reclaim list and the
 * publish warning end up quoting different numbers for the same Workspace on the same screen.
 *
 * A Project this build cannot read counts as a user, so a Workspace holding one has nothing unused:
 * see {@link WorkspaceHistoricalMap.mightBeUsedBy}.
 */
export function unusedHistoricalMaps<T extends Reclaimable>(
	maps: readonly T[]
): { maps: T[]; bytes: number } {
	const unused = maps.filter((map) => map.usedBy.length === 0 && map.mightBeUsedBy.length === 0);
	return { maps: unused, bytes: unused.reduce((sum, map) => sum + map.bytes, 0) };
}

/**
 * The byte weight of the Historical Maps no Project uses, for ADR-0008's publish warning (SPEC story
 * 98).
 *
 * **Weighs only the unused maps**, which is what keeps this cheap enough to run on every publish plan:
 * the classification and the usage cost one walk of `images/` and one read per Project, and the `size`
 * calls — the part that scales with the number of tiles — happen only for directories nothing draws.
 * In the ordinary Workspace, where every map is in use, there are none. The filter and the sum are
 * {@link unusedHistoricalMaps}', so this is the same figure the hub states and not a second one.
 */
export async function unusedHistoricalMapBytes(
	store: ProjectStore
): Promise<{ bytes: number; maps: number }> {
	const scanned = await scanImages(store);
	const usage = await historicalMapUsage(store);

	const counted = await Promise.all(
		[...scanned].map(async ([imageId, { paths }]) => {
			const usedBy = usersOf(usage, imageId);
			const unused = usedBy.length === 0 && usage.fromANewerVersion.length === 0;
			return {
				usedBy,
				mightBeUsedBy: usage.fromANewerVersion,
				bytes: unused ? (await weigh(store, imageId, paths)).bytes : 0
			};
		})
	);

	const unused = unusedHistoricalMaps(counted);
	return { bytes: unused.bytes, maps: unused.maps.length };
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
	/** The Projects this build cannot read the Layers of, which may draw it (ADR-0010). */
	readonly fromANewerVersion: readonly HistoricalMapUser[];

	constructor(
		imageId: string,
		label: string,
		projects: readonly HistoricalMapUser[],
		fromANewerVersion: readonly HistoricalMapUser[] = []
	) {
		super(refusalMessage(label || imageId, projects, fromANewerVersion));
		this.name = 'HistoricalMapInUseError';
		this.imageId = imageId;
		this.projects = projects;
		this.fromANewerVersion = fromANewerVersion;
	}
}

const namesOf = (users: readonly HistoricalMapUser[]): string =>
	users.map((user) => `“${user.name}”`).join(' and ');

/** The refusal, in the words the hub renders. */
function refusalMessage(
	named: string,
	projects: readonly HistoricalMapUser[],
	fromANewerVersion: readonly HistoricalMapUser[]
): string {
	// The Projects from a newer build alone. There is no list of Layers to name, so the sentence says
	// what is actually known — the document could not be read — and names the two ways out.
	if (projects.length === 0) {
		const one = fromANewerVersion.length === 1;
		return (
			`“${named}” has not been deleted: ${namesOf(fromANewerVersion)} ` +
			`${one ? 'was' : 'were'} made with a newer version of Ballastella, so this build cannot read ` +
			`which Historical Maps ${one ? 'it draws' : 'they draw'}. Update your copy of Ballastella, or ` +
			`delete ${one ? 'that Project' : 'those Projects'}, and this map can be deleted.`
		);
	}

	const one = projects.length === 1;
	const drawn =
		`“${named}” is drawn by ${one ? 'the Project' : 'the Projects'} ` +
		`${namesOf(projects)}, so it has not been deleted — ${one ? 'that Project' : 'those Projects'} ` +
		`would be left with a Layer that draws nothing. Remove the Layer from ` +
		`${one ? 'it' : 'each of them'} first if you no longer need this map.`;

	if (fromANewerVersion.length === 0) return drawn;
	const alsoOne = fromANewerVersion.length === 1;
	return (
		`${drawn} ${namesOf(fromANewerVersion)} ${alsoOne ? 'was' : 'were'} made with a newer version ` +
		`of Ballastella and may draw it too; this build cannot tell.`
	);
}

/**
 * Some of the map's files were removed and the rest could not be, so the Workspace is between states.
 *
 * **Its own error because "could not be deleted" is a false story here.** A deletion that failed
 * halfway has already taken the Alignment and some of the tiles; telling the user nothing happened
 * would leave them believing a map they can still see is intact. What is guaranteed instead is that
 * the map is *still listed* — `info.json` and `remote.json` are deleted last precisely so the file the
 * listing classifies by outlives every earlier failure — so the next render explains the leftover
 * rather than hiding it, and deleting again finishes the job.
 */
export class HistoricalMapPartlyDeletedError extends Error {
	readonly imageId: string;
	/** How many files were removed before the failure. Always at least one. */
	readonly removed: number;

	constructor(imageId: string, label: string, removed: number, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(
			`“${label || imageId}” was only partly deleted: ${removed} of its ` +
				`${removed === 1 ? 'file was' : 'files were'} removed and the rest could not be. It is still ` +
				`listed, and deleting it again will finish the job. The Workspace reported: ${reason}`,
			{ cause }
		);
		this.name = 'HistoricalMapPartlyDeletedError';
		this.imageId = imageId;
		this.removed = removed;
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
 * **The order is chosen for the failure, not for the success**, because a `delete` can refuse at any
 * point — a lock, a revoked folder grant, a disk that filled while a temporary file was open:
 *
 *   1. the **Alignment first**, so that no failure below it can leave `alignments/<id>.json` behind
 *      for a map that is gone, which is the one leftover this function exists to prevent;
 *   2. the tiles and the manifest;
 *   3. **`remote.json` and then `info.json` last**, making an offline copy the ingest, which writes `info.json`
 *      last precisely so that an incomplete pyramid is invisible. They are the two files
 *      {@link tileLocation} classifies by, so while either survives the map is still *listed* — a
 *      half-deleted map the user can see and finish deleting, rather than orphaned bytes that no
 *      listing mentions and no total explains.
 *
 * @throws HistoricalMapInUseError when any Project's Layers draw it, or when a Project this build
 *   cannot read might
 * @throws HistoricalMapPartlyDeletedError when a `delete` refuses after the first one succeeded
 */
export async function deleteHistoricalMap(
	store: ProjectStore,
	imageId: string,
	options: { label?: string } = {}
): Promise<void> {
	const usage = await historicalMapUsage(store);
	const users = usersOf(usage, imageId);
	if (users.length > 0 || usage.fromANewerVersion.length > 0) {
		throw new HistoricalMapInUseError(imageId, options.label ?? '', users, usage.fromANewerVersion);
	}

	const directory = `${imageDirectory(imageId)}/`;
	const listed = await store.list(directory);
	const classifiers = [referencedImagePath(imageId), imageInfoPath(imageId)];
	// Asked for rather than assumed, so that `removed` below counts files that were really there: a
	// map nobody has placed yet has no Alignment, which is the ordinary first state.
	const placement = await store.size(alignmentPath(imageId)).then(
		() => [alignmentPath(imageId)],
		() => []
	);
	const order = [
		...placement,
		...listed.filter((path) => !classifiers.includes(path)),
		...classifiers.filter((path) => listed.includes(path))
	];

	let removed = 0;
	for (const path of order) {
		try {
			await store.delete(path);
		} catch (cause) {
			// Nothing has gone yet, so the caller's own error is the honest one — there is no half state
			// to describe.
			if (removed === 0) throw cause;
			throw new HistoricalMapPartlyDeletedError(imageId, options.label ?? '', removed, cause);
		}
		removed++;
	}

	// The half-finished writes `list` cannot report and `delete` cannot be handed, exactly as
	// `deleteProject` sweeps them: without this, a "deleted" map's directory survives on disk holding
	// bytes that are also missing from the totals this list exists to explain. Scoped to this map's own
	// directory, so it cannot reach the temporary file of an ingest running beside it.
	await store.reclaimAbandonedWrites(directory);
}

/**
 * Split the Workspace's remote-origin records by whether a pyramid of ours is beside them.
 *
 * Moved here from `remote-iiif/referenced-image.ts` so that it and {@link referencedHistoricalMaps}
 * answer through {@link tileLocation} rather than through two independent readings of the same rule.
 *
 * `offlineCopies` keeps its record, which is why this is a partition of the records rather than a
 * removal from them: a Historical Map with an Offline Copy must still be able to say where it came
 * from (ADR-0007 — an offline copy must not orphan the citation).
 *
 * **It carries one observation through the rule rather than two**, since `remoteJson` is true by
 * construction here — see the note in the module header.
 */
export function partitionByOfflineCopy(
	images: readonly ReferencedImage[],
	ingested: readonly { readonly imageId: string }[]
): { referenced: ReferencedImage[]; offlineCopies: ReferencedImage[] } {
	const local = new Set(ingested.map((image) => image.imageId));
	const referenced: ReferencedImage[] = [];
	const offlineCopies: ReferencedImage[] = [];

	for (const image of images) {
		// Every image here came from a `remote.json`, which is `remoteJson: true`; `ingested` is the
		// `info.json` half. The same two observations the listing walk makes, through the same rule.
		const where = tileLocation({ infoJson: local.has(image.imageId), remoteJson: true });
		(where === 'referenced' ? referenced : offlineCopies).push(image);
	}

	return { referenced, offlineCopies };
}

/** The record beside a referenced map, or `null` when it will not parse. */
async function readRemoteRecord(
	store: Pick<ProjectStore, 'read'>,
	imageId: string
): Promise<ReferencedImage | null> {
	try {
		return parseReferencedImage(await store.read(referencedImagePath(imageId)), { imageId });
	} catch {
		// A record that will not parse costs the label and the Library, and the map is still listed with
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

/**
 * The Library a service URI names, by its address, or `''` when there is not one to name.
 *
 * The address stands in for the institution because it is what the record actually holds — a
 * `remote.json` carries a service URI and no institutional name — and `iiif.bnf.example` is still the
 * fact a scholar needs: this map comes from somewhere else and will stop working if that somewhere
 * else reorganises.
 */
function libraryOf(service: string): string {
	try {
		return new URL(service).host;
	} catch {
		return '';
	}
}
