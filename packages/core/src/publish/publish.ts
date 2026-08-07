// Publishing: the Workspace becomes the Published Site (ADR-0006, ADR-0008).
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHAT PUBLISHING IS, AND WHAT IT IS NOT
//
// It writes an `index.html`, the read-only viewer's files, and one small record of the site into
// the Workspace, **beside** the Projects already there. It copies no Project data at all — not one
// tile, not one `project.json` — because a single Historical Map is hundreds of megabytes to
// gigabytes of pyramid and copying it on every publish is slowest exactly in OPFS, the most
// constrained backend (ADR-0006). That is why `publishSite` never calls `store.read` on anything
// inside a Project directory, and why `publish.test.ts` puts a spy on `read` to keep it that way.
//
// ─────────────────────────────────────────────────────────────────────────────────────────
// WHY THERE IS A SITE RECORD AT ALL
//
// A static host has no directory listing, so the viewer's HTTP `ProjectStore` cannot enumerate
// anything (ADR-0006 names that adapter; ADR-0008 has no index file inside the Workspace because
// the *editor's* backends can list). The hub page therefore needs the Project list handed to it,
// and publishing is the only moment that list is knowable. So one file — `ballastella-site.json` —
// carries the Project list, the viewer's version stamp, and the resolved Base Map catalog
// (ADR-0020, so a Published Site keeps working when the authoring deployment later changes its
// own catalog).
//
// It is not an index *of the Workspace*: it holds no file paths and nothing a Project needs. Delete
// it and every Project directory is still complete, standard-format, and readable with no
// proprietary index (SPEC story 94). It is part of the viewer file set, not part of the data.
//
// Publishing still copies no Project data and no pyramid. ADR-0023 moved the pyramids to the Workspace
// root, which changes nothing here: they were never copied, and now they are not copied from one place
// instead of many.

import { BASE_MAP_CATALOG, type BaseMapCatalog } from '../base-map/index.js';
import { baseMapCacheSize, type BaseMapCacheSize } from '../base-map/offline-cache.js';
import { BASE_MAP_TILE_DIRECTORY } from '../base-map/tile-cache.js';
import { referencedHistoricalMaps, unusedHistoricalMapBytes } from '../project/historical-maps.js';
import { imageDirectory, imageInfoPath } from '../project/image-files.js';
import { parseProjectFile, projectFilePath, type ProjectFile } from '../project/project-file.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	workspaceSize,
	type WorkspaceSize
} from '../project/workspace-size.js';
import type { ProjectSummary } from '../project/workspace.js';
import { assertStorePath, type Bytes, type ProjectStore } from '../store/project-store.js';
import { serialiseJson } from '../tiler/pyramid.js';
import {
	PUBLISHED_APP_DIRECTORY,
	PUBLISHED_SITE_RECORD_NAME,
	VIEWER_FILE_PATHS,
	claimedByPublishing,
	isViewerFile
} from '../transfer/viewer-files.js';
import { bundleBytes, type ViewerBundle, type ViewerBundleFile } from './viewer-bundle.js';

/** The record's format, versioned for the same reason `project.json` is (ADR-0010). */
export const PUBLISHED_SITE_FORMAT_VERSION = 1;

/** One Project as the hub page lists it. */
export type PublishedProject = {
	/** Its identity, and what `?p=` names (ADR-0008). */
	readonly directory: string;
	/** Its display name. Untrusted text: a Reader's browser must render it as text, never as markup. */
	readonly name: string;
};

/** The record a Published Site carries about itself. */
export type PublishedSite = {
	readonly formatVersion: number;
	/** The stamp of the viewer that was written, so a stale bundle is detectable (ADR-0006). */
	readonly viewerVersion: string;
	/** When it was published, ISO 8601. */
	readonly publishedAt: string;
	readonly projects: readonly PublishedProject[];
	/** This deployment's catalog, travelling with the site (ADR-0020). */
	readonly baseMap: BaseMapCatalog;
	/**
	 * Whether this Workspace carries cached Base Map **tiles** (ADR-0025).
	 *
	 * **This field changed meaning in ticket 11**, from "the deployment's extract was copied" to what
	 * ADR-0025 says: the site draws its geography from `base-map/tiles/…` and needs no network for it.
	 * Publishing copies nothing extra to make it true — the tiles are already in the Workspace, which
	 * *is* the published root — so this is an observation of the folder at publish time and never a
	 * choice on the dialog.
	 */
	readonly baseMapBundled: boolean;
	/**
	 * Whether the Base Map's glyphs and sprites were written too.
	 *
	 * Separated from {@link baseMapBundled} rather than folded into it, because the two are
	 * independently true and the Reader meets different failures: without *tiles* the geography is
	 * absent, and without *glyphs* the geography draws with no place names at all (ADR-0025's 820 KB).
	 * `ReaderMapPane` drops `glyphs`, `sprite`, and every symbol layer when this is false, and the two
	 * sentences beside the map say which of the two happened.
	 */
	readonly baseMapAssetsBundled: boolean;
	/**
	 * The deepest zoom the cached tiles reach, or `null` when there are none.
	 *
	 * Carried on the record because a Reader's store is HTTP and **cannot list a directory** (ADR-0006):
	 * the editor reads this depth back off the files, and a static host gives the viewer no way to. It
	 * is load-bearing rather than informational — a vector source with no `maxzoom` makes MapLibre ask
	 * for tiles past the pyramid, every one of which 404s, and the map goes blank at exactly the zoom
	 * the site was published to work at.
	 */
	readonly baseMapMaxZoom: number | null;
};

/** The site record is there and will not parse. */
export class PublishedSiteUnreadableError extends Error {
	constructor(reason: string) {
		super(`This Workspace's ${PUBLISHED_SITE_RECORD_NAME} could not be read: ${reason}`);
		this.name = 'PublishedSiteUnreadableError';
	}
}

/** Tab-indented with a trailing newline, matching every other JSON this project writes. */
export const serialisePublishedSite = (site: PublishedSite): Bytes => serialiseJson(site);

/**
 * Parse the record.
 *
 * Tolerant about everything except the fields a Reader's page cannot be drawn without, in the same
 * spirit as `parseLayers`: a record written by a newer viewer must still list the Projects.
 */
export function parsePublishedSite(bytes: Uint8Array): PublishedSite {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
	} catch (cause) {
		throw new PublishedSiteUnreadableError(cause instanceof Error ? cause.message : String(cause));
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new PublishedSiteUnreadableError('the file does not contain a JSON object');
	}
	const record = raw as Record<string, unknown>;
	const projects = Array.isArray(record.projects) ? record.projects : [];

	return {
		formatVersion:
			typeof record.formatVersion === 'number'
				? record.formatVersion
				: PUBLISHED_SITE_FORMAT_VERSION,
		viewerVersion: typeof record.viewerVersion === 'string' ? record.viewerVersion : '',
		publishedAt: typeof record.publishedAt === 'string' ? record.publishedAt : '',
		projects: projects.flatMap((entry) => {
			const project = entry as Record<string, unknown> | null;
			const directory = project?.directory;
			if (typeof directory !== 'string' || directory === '') return [];
			return [{ directory, name: typeof project?.name === 'string' ? project.name : directory }];
		}),
		baseMap: isCatalog(record.baseMap) ? record.baseMap : BASE_MAP_CATALOG,
		baseMapBundled: record.baseMapBundled === true,
		// ⚠ **A record written before ticket 11 has no `baseMapAssetsBundled`, and its `baseMapBundled`
		// meant exactly what this field means now** — the deployment's Base Map files were copied. The
		// meaning moved; the sites did not. Reading the new field strictly made every already-published
		// site reopen with `glyphs`, `sprite`, and every symbol layer dropped and a notice saying the
		// labels were not copied, while `base-map/fonts/` sat on the host untouched. Nothing errored.
		//
		// So an absent field falls back to the old field's old meaning. Not a migration and not a
		// `formatVersion` bump: the record is read-only to this build, no byte is rewritten, and the
		// fallback costs one `??`. `parsePublishedSite` is already the tolerant reader for exactly this
		// class of thing — "a record written by a newer viewer must still list the Projects", and a
		// record written by an *older* one must still draw its labels.
		baseMapAssetsBundled:
			typeof record.baseMapAssetsBundled === 'boolean'
				? record.baseMapAssetsBundled
				: record.baseMapBundled === true,
		baseMapMaxZoom: typeof record.baseMapMaxZoom === 'number' ? record.baseMapMaxZoom : null
	};
}

/**
 * Enough of a catalog to draw a Base Map from, checked structurally.
 *
 * Not a full validation: an entry this build does not understand is ADR-0020's own fallback case,
 * and `resolveBaseMap` already handles an id it cannot serve. What must not happen is the switcher
 * being handed something with no `entries` at all.
 */
function isCatalog(value: unknown): value is BaseMapCatalog {
	const catalog = value as BaseMapCatalog | null;
	return (
		typeof catalog === 'object' &&
		catalog !== null &&
		Array.isArray(catalog.entries) &&
		catalog.entries.length > 0
	);
}

/** Something the user should read before publishing, or after. */
export type PublishWarning = {
	readonly kind: 'referenced-images' | 'base-map-size' | 'hosting-limit' | 'name-collision';
	readonly message: string;
};

/** What publishing is about to do, worked out before a single byte is written. */
export type PublishPlan = {
	readonly viewerVersion: string;
	/** The Projects the hub page will list, in the order it will list them. */
	readonly projects: readonly PublishedProject[];
	/** Every path publishing will write, with its byte length. The site record is included. */
	readonly files: readonly ViewerBundleFile[];
	/** How many bytes those files add to the Workspace. */
	readonly bytes: number;
	/** What the Workspace holds now, from `ProjectStore#size` and never from reading a tile. */
	readonly workspace: WorkspaceSize;
	/**
	 * How much of {@link workspace} is Historical Maps no Project's Layers draw (SPEC story 98).
	 *
	 * **Publishing is additive and cannot leave them out** — they are already in the directory the site
	 * is written into — so the honest thing is to say what they weigh. That sentence is what gives the
	 * hub's reclaim list a reason to be visited, and `{ bytes: 0, maps: 0 }` for a Workspace where every
	 * map is in use is the answer rather than the absence of one.
	 */
	readonly unusedHistoricalMaps: { readonly bytes: number; readonly maps: number };
	/**
	 * Whether the Workspace already carries cached Base Map tiles (ADR-0025).
	 *
	 * Observed rather than chosen: publishing copies nothing to make it true, because the tiles are
	 * already in the directory being published. It is on the plan so the dialog can say whether the
	 * site will need a network connection (SPEC story 99) before the user pushes it.
	 */
	readonly baseMapBundled: boolean;
	/** Whether glyphs and sprites are being written. The dialog's checkbox decides this one. */
	readonly baseMapAssetsBundled: boolean;
	/** How many tiles the cache holds and what they weigh, for the sentence about the site. */
	readonly baseMapTiles: BaseMapCacheSize;
	readonly baseMap: BaseMapCatalog;
	/**
	 * The address this Workspace's Projects are already stamped for, or `null` (ADR-0004).
	 *
	 * Carried on the plan because it is read from the same `project.json` files the referenced-image
	 * warning is read from, and because the alternative is asking a user to remember, a semester
	 * later, the exact address they typed — which is the difference between a citable IIIF endpoint
	 * and one that moves every time it is re-published.
	 */
	readonly canonicalUrl: string | null;
	/**
	 * Project directories whose names collide with something publishing writes. Publishing refuses
	 * rather than overwriting one — see {@link publishSite}.
	 */
	readonly collisions: readonly string[];
	readonly warnings: readonly PublishWarning[];
};

/** Publishing was refused, before anything was written. */
export class PublishRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PublishRefusedError';
	}
}

export type PlanPublishOptions = {
	readonly bundle: ViewerBundle;
	/** The Projects, as the Workspace lists them — most recently touched first (ADR-0008). */
	readonly projects: readonly ProjectSummary[];
	/** Write the Base Map's own files too, so the site works with no network (SPEC story 88). */
	readonly includeBaseMap: boolean;
	/** This deployment's catalog. Injected so the tests can drive a different one (ADR-0020). */
	readonly catalog?: BaseMapCatalog;
};

/**
 * Work out what publishing would do, and everything the user has to be told first.
 *
 * Separate from {@link publishSite} because two of the three required warnings are only useful
 * *before* the writing starts: ADR-0020 requires the Base Map's size be stated before it is added,
 * and ADR-0008's hosting cliff is a decision, not a report. So this reads and computes; it writes
 * nothing at all.
 */
export async function planPublish(
	store: ProjectStore,
	options: PlanPublishOptions
): Promise<PublishPlan> {
	const { bundle, projects, includeBaseMap } = options;
	const catalog = options.catalog ?? BASE_MAP_CATALOG;

	const listed: PublishedProject[] = projects.map((project) => ({
		directory: project.directory,
		name: project.name
	}));

	// Before the files are written, so the bundle's own bytes are not counted as bytes the
	// Workspace already held. `workspaceSize` is `list` + `size` and never `read` — a Workspace with
	// a mirrored pyramid in it is tens of thousands of files (ADR-0001, ADR-0008).
	const workspace = await workspaceSize(store);
	// Cheap even beside that walk: the classification and the used-by are one `list` of `images/` and
	// one read per Project, and the `size` calls happen only for the maps nothing draws — usually none.
	const unusedHistoricalMaps = await unusedHistoricalMapBytes(store);
	// ADR-0025: an observation of the folder, not a choice. One `list` of `base-map/tiles/` and a
	// `size` per tile — the same `list` + `size` discipline as `workspaceSize`, never a `read`.
	const baseMapTiles = await baseMapCacheSize(store);

	const baseMap = includeBaseMap ? bundle.baseMap : [];
	// The record is weighed with a plausible length rather than skipped: it is a file publishing
	// writes, and a plan whose byte total omitted one of its own files would be wrong in the
	// direction that matters at the cliff.
	const recordFile: ViewerBundleFile = {
		path: PUBLISHED_SITE_RECORD_NAME,
		// Written from the plan rather than fetched, so there is nothing to serve it from.
		source: '',
		bytes: serialisePublishedSite(
			siteRecord({
				viewerVersion: bundle.version,
				publishedAt: '',
				projects: listed,
				catalog,
				baseMapBundled: baseMapTiles.tiles > 0,
				baseMapAssetsBundled: includeBaseMap,
				baseMapMaxZoom: baseMapTiles.maxZoom
			})
		).byteLength
	};
	const files = [...bundle.files, ...baseMap, recordFile];
	const bytes = bundleBytes(files);

	const collisions = listed
		.filter((project) => claimedByPublishing(project.directory))
		.map((project) => project.directory);

	const warnings: PublishWarning[] = [];

	if (collisions.length > 0) {
		warnings.push({ kind: 'name-collision', message: collisionMessage(collisions) });
	}

	const { referenced, canonicalUrl } = await inspectProjects(store, listed);
	if (referenced.length > 0) {
		warnings.push({ kind: 'referenced-images', message: referencedWarning(referenced) });
	}

	if (includeBaseMap && baseMap.length > 0) {
		warnings.push({
			kind: 'base-map-size',
			message:
				`Including Base Map labels and symbols writes ${baseMap.length} more files, about ` +
				`${describeBytes(bundleBytes(baseMap))}, into this Workspace. ` +
				(baseMapTiles.tiles > 0
					? `The Base Map tiles are already here — ${baseMapTiles.tiles} of them, ` +
						`${describeBytes(baseMapTiles.bytes)} — so this site will draw its geography with no ` +
						`network connection. `
					: `The Base Map tiles still need a network connection: make a Project available offline ` +
						`if the site has to draw its geography on a train. `) +
				`These files count against the same hosting budget as your Historical Maps.`
		});
	}

	if (crossesHostingLimit(workspace.bytes, bytes)) {
		warnings.push({
			kind: 'hosting-limit',
			message: hostingWarning(workspace.bytes, bytes, unusedHistoricalMaps)
		});
	}

	return {
		viewerVersion: bundle.version,
		projects: listed,
		files,
		bytes,
		workspace,
		unusedHistoricalMaps,
		baseMapBundled: baseMapTiles.tiles > 0,
		baseMapAssetsBundled: includeBaseMap && baseMap.length > 0,
		baseMapTiles,
		baseMap: catalog,
		canonicalUrl,
		collisions,
		warnings
	};
}

const collisionMessage = (collisions: readonly string[]): string =>
	`${collisions.map((directory) => `“${directory}”`).join(', ')} ` +
	`${collisions.length === 1 ? 'is a Project whose folder has' : 'are Projects whose folders have'} ` +
	`a name publishing needs for the website itself. Rename ` +
	`${collisions.length === 1 ? 'it' : 'them'} — the display name can stay as it is — and publish ` +
	`again. Nothing has been written.`;

/**
 * The two facts publishing needs out of the Projects' own documents, in one walk.
 *
 * **The referenced Historical Maps** are each Project's map Layers intersected with what the Workspace
 * observably fetches from elsewhere, because the warning is about what the *site* draws: a `remote.json`
 * for an image nothing references costs a Reader nothing, and a Layer over a referenced image renders
 * blank without a network (ADR-0007, SPEC stories 29 and 90).
 *
 * **The canonical address** is whatever the Projects already agree on, so a re-publish can offer it
 * back. The first one found wins: they are stamped together by one action, and a Workspace whose
 * Projects disagree has been edited by hand, where offering one of the two is better than offering
 * neither.
 *
 * A Project that will not parse is skipped in silence. It is already carrying its own problem — the
 * hub lists it with that problem, and `listProjects` found it — and a second message about its
 * Layers would say nothing a user could act on.
 */
async function inspectProjects(
	store: ProjectStore,
	projects: readonly PublishedProject[]
): Promise<{
	referenced: { project: PublishedProject; layers: string[] }[];
	canonicalUrl: string | null;
}> {
	const remote = await referencedHistoricalMaps(store);
	const referenced: { project: PublishedProject; layers: string[] }[] = [];
	let canonicalUrl: string | null = null;
	for (const project of projects) {
		let file: ProjectFile;
		try {
			file = parseProjectFile(await store.read(projectFilePath(project.directory)));
		} catch {
			continue;
		}
		canonicalUrl ??= file.canonicalUrl;
		const layers = file.layers
			.filter((layer) => layer.kind === 'map' && remote.has(layer.imageId))
			.map((layer) => layer.name || layer.id);
		if (layers.length > 0) referenced.push({ project, layers });
	}
	return { referenced, canonicalUrl };
}

// The private `referencedImageIds` that used to be here — one `list` of `images/`, sorted out by
// suffix — is now `referencedHistoricalMaps` in `project/historical-maps.ts`, which is the same walk
// through the one implementation of ADR-0023's rule. It was one of five readings of that rule; the
// hub's reclaim list needed a sixth, and got that module instead.

function referencedWarning(referenced: { project: PublishedProject; layers: string[] }[]): string {
	const total = referenced.reduce((sum, entry) => sum + entry.layers.length, 0);
	const where = referenced
		.map((entry) => `${entry.project.name}: ${entry.layers.join(', ')}`)
		.join('; ');
	return (
		`${total === 1 ? 'One Historical Map' : `${total} Historical Maps`} in this Workspace ` +
		`${total === 1 ? 'is' : 'are'} still fetched from the library that holds ${total === 1 ? 'it' : 'them'} ` +
		`rather than copied into your own folder (${where}). Your Published Site depends on those ` +
		`servers: a Reader with no network, or one visiting after the library reorganises, sees ` +
		`nothing where ${total === 1 ? 'that Layer draws' : 'those Layers draw'}. Make an offline copy ` +
		`of each one first if the site has to stand on its own.`
	);
}

/**
 * The ADR-0008 cliff, said in publishing's own words.
 *
 * The arithmetic is `crossesHostingLimit`'s and the byte total is `workspaceSize`'s — the same two
 * functions ticket 15 warns from, so the two moments cannot give a user two different answers about
 * one Workspace. Only the sentence differs, because ticket 15's is about a copy that is about to be
 * made and this one is about a site that is about to be pushed.
 *
 * **And it names what is reclaimable** (SPEC story 98). Publishing is additive: the Historical Maps no
 * Project draws are already in the directory being published and cannot be left out, so a warning
 * about a cliff that did not say how much of the drop is dead weight would be telling the user they
 * are stuck when they are one deletion from not being. The clause is omitted rather than written with
 * a zero, because "including 0 bytes of Historical Maps no Project uses" is noise in the one message
 * that has to be read.
 */
function hostingWarning(
	current: number,
	adding: number,
	unused: { bytes: number; maps: number }
): string {
	const limit = describeBytes(STATIC_HOSTING_LIMIT_BYTES);
	const already = current > STATIC_HOSTING_LIMIT_BYTES;
	return (
		`This Workspace holds ${describeBytes(current)}` +
		(unused.maps > 0
			? `, including ${describeBytes(unused.bytes)} of Historical Maps no Project uses — ` +
				`${unused.maps === 1 ? 'one map' : `${unused.maps} maps`} you can delete from the hub to ` +
				`reclaim that space — and`
			: ' and') +
		` publishing adds about ${describeBytes(adding)}, ` +
		(already
			? `so it is already past the ${limit} a free static host such as GitHub Pages will publish. `
			: `which takes it past the ${limit} a free static host such as GitHub Pages will publish. `) +
		`This is a cliff rather than a slowdown: the files are written either way, but pushing them ` +
		`will fail. The way out is to host the site somewhere without that limit, or to keep fewer ` +
		`offline copies in this Workspace.`
	);
}

export type PublishSiteOptions = {
	readonly store: ProjectStore;
	readonly plan: PublishPlan;
	/**
	 * The bytes of one bundle file, given the file's own record — which carries the deployment-relative
	 * `source` the editor serves it from as well as the Workspace-relative `path` it goes to.
	 *
	 * Injected because the editor serves those files from its own deployment over a **relative** URL
	 * (ADR-0006), which is knowledge core must not have — and because it is what lets the tests drive
	 * publishing with no browser at all.
	 */
	readonly readAsset: (file: ViewerBundleFile) => Promise<Bytes>;
	/** The clock, injectable so `publishedAt` is assertable. */
	readonly now?: () => Date;
	readonly onProgress?: (progress: {
		readonly files: number;
		readonly totalFiles: number;
		readonly path: string | null;
	}) => void;
};

/**
 * Write the Published Site into the Workspace.
 *
 * **Additive towards the user's data, and that is a property of this function rather than an
 * intention.** It writes only the paths the plan names, every one of which is a name
 * `VIEWER_FILE_PATHS` records — checked below rather than assumed — and it reads nothing from the
 * Workspace, so no Project file can be rewritten, re-serialised, or touched by publishing, whatever
 * else changes here later.
 *
 * The one thing it removes is what the *last* publish wrote and this one does not: see
 * {@link removeSupersededFiles}, which is confined to the same recorded list and runs only once
 * everything this publish writes is on disk.
 *
 * The site record is written **last**, for the same reason `project.json` is written last
 * everywhere else in this codebase: it is what a Reader's first request resolves through, and a
 * record naming a viewer whose chunks are not all there yet is a site that renders blank. Written
 * this way, an interrupted publish leaves a stale record — the site the user had before — which is
 * a site that works.
 *
 * @throws PublishRefusedError when a Project's folder is named after something publishing writes
 */
export async function publishSite(options: PublishSiteOptions): Promise<PublishedSite> {
	const { store, plan, readAsset } = options;
	const now = options.now ?? (() => new Date());

	if (plan.collisions.length > 0) {
		throw new PublishRefusedError(collisionMessage(plan.collisions));
	}

	// The recorded list is enforced here rather than merely documented. ADR-0006's requirement is
	// that the viewer file set be *recorded*, and the way that quietly stops being true is a chunk
	// or an asset arriving in the bundle under a name nobody added to `VIEWER_FILE_PATHS` — after
	// which the data-only zip carries it and nothing says so. Refusing to write an unrecorded path
	// makes the list an invariant of publishing instead of a comment about it.
	const unrecorded = plan.files.filter((file) => !isViewerFile(file.path));
	if (unrecorded.length > 0) {
		throw new PublishRefusedError(
			`Publishing would write ${unrecorded.map((file) => file.path).join(', ')}, which ` +
				`VIEWER_FILE_PATHS does not record. ADR-0006 requires the viewer file set to be ` +
				`enumerable, so that a data-only Project zip can exclude exactly it. Record the path ` +
				`there and publish again. Nothing has been written.`
		);
	}

	const assets = plan.files.filter((file) => file.path !== PUBLISHED_SITE_RECORD_NAME);
	const totalFiles = assets.length + 1;
	let written = 0;
	const report = (path: string | null) =>
		options.onProgress?.({ files: written, totalFiles, path });

	report(null);
	for (const file of assets) {
		const path = assertStorePath(file.path);
		await store.write(path, await readAsset(file));
		written += 1;
		report(file.path);
	}

	const site = siteRecord({
		viewerVersion: plan.viewerVersion,
		publishedAt: now().toISOString(),
		projects: plan.projects,
		catalog: plan.baseMap,
		baseMapBundled: plan.baseMapBundled,
		baseMapAssetsBundled: plan.baseMapAssetsBundled,
		baseMapMaxZoom: plan.baseMapTiles.maxZoom
	});
	await store.write(PUBLISHED_SITE_RECORD_NAME, serialisePublishedSite(site));
	written += 1;
	report(PUBLISHED_SITE_RECORD_NAME);

	// After the record, deliberately. Everything this publish writes is already on disk by here, so
	// an interruption during the sweep leaves a complete site with some superseded files still beside
	// it — the same "a site that works" outcome the write order above is arranged for.
	await removeSupersededFiles(store, new Set(plan.files.map((file) => file.path)));
	return site;
}

/**
 * Remove the files a previous publish wrote that this one does not.
 *
 * The case this exists for is the Base Map. Publish with it, then publish without it, and ~5 MB of
 * `base-map/` stays in the Workspace while the record written beside it says `baseMapBundled: false`
 * — the folder and the site's own account of itself disagreeing about what the site is. A Reader is
 * unaffected, because nothing points at those files; the user is not, because the folder **is** the
 * product (ADR-0006) and they are about to push it.
 *
 * **Only paths `VIEWER_FILE_PATHS` records are so much as listed.** That is the whole of the safety
 * argument: the sweep cannot reach a Project directory because it never asks about one, and a
 * Project whose folder is one of those names was refused above rather than published over.
 *
 * `_app/` is left alone on purpose. Its names are content hashes, so an edited viewer writes new
 * ones beside the old, and ADR-0006 records that accumulation as an accepted cost of publishing into
 * the working folder. Sweeping it would be a change to that decision rather than a repair of this
 * one.
 *
 * ⚠ **`base-map/tiles/` is left alone too, and that one is not a preference.** `base-map/` is a
 * recorded viewer directory because of its glyphs and sprites, and since ADR-0025 the opt-in offline
 * tile cache lives inside it — bytes a user deliberately asked for, fetched from somebody else's
 * server, and never written by publishing. Without this guard, publishing once with the Base Map
 * checkbox off would delete every one of them: no dialog, no message, and the Project silently stops
 * being available offline. It is the same shape as the loss this function was written to *avoid*, in
 * the opposite direction. `publish.test.ts` asserts the cache survives a publish that omits the Base
 * Map, because nothing else in the codebase would notice.
 */
async function removeSupersededFiles(
	store: ProjectStore,
	planned: ReadonlySet<string>
): Promise<void> {
	for (const recorded of VIEWER_FILE_PATHS) {
		if (recorded === PUBLISHED_APP_DIRECTORY) continue;
		if (recorded.endsWith('/')) {
			for (const path of await store.list(recorded)) {
				if (path.startsWith(BASE_MAP_TILE_DIRECTORY)) continue;
				if (!planned.has(path)) await store.delete(path);
			}
		} else if (!planned.has(recorded)) {
			// `delete` is idempotent, so a recorded name this Workspace never held costs one no-op
			// rather than a `list` of the whole Workspace to find out.
			await store.delete(recorded);
		}
	}
}

const siteRecord = (fields: {
	viewerVersion: string;
	publishedAt: string;
	projects: readonly PublishedProject[];
	catalog: BaseMapCatalog;
	baseMapBundled: boolean;
	baseMapAssetsBundled: boolean;
	baseMapMaxZoom: number | null;
}): PublishedSite => ({
	formatVersion: PUBLISHED_SITE_FORMAT_VERSION,
	viewerVersion: fields.viewerVersion,
	publishedAt: fields.publishedAt,
	projects: fields.projects,
	baseMap: fields.catalog,
	baseMapBundled: fields.baseMapBundled,
	baseMapAssetsBundled: fields.baseMapAssetsBundled,
	baseMapMaxZoom: fields.baseMapMaxZoom
});

/**
 * The site record as it stands in the Workspace, or `null` when it has never been published.
 *
 * Never published is the ordinary first state, not a failure. A record that is there and will not
 * parse *is* surfaced, because it is what the editor reads to decide whether the Published Site is
 * out of date, and quietly answering "no site" would offer the wrong action.
 */
export async function readPublishedSite(store: ProjectStore): Promise<PublishedSite | null> {
	let bytes: Bytes;
	try {
		bytes = await store.read(PUBLISHED_SITE_RECORD_NAME);
	} catch {
		return null;
	}
	return parsePublishedSite(bytes);
}

/**
 * Whether a Published Site is behind the Workspace it sits in, and why — or `''` when it is not.
 *
 * Two ways to be behind, and both matter (ADR-0006). The viewer's files can be older than this
 * build of the editor, which is the one the ADR names. And the *Project list* can be older than the
 * Workspace, which is the case a student meets: they add a Project in week four and the hub page
 * from week three does not list it (SPEC story 81).
 */
export function publishedSiteStaleness(
	site: PublishedSite | null,
	current: { readonly viewerVersion: string; readonly projects: readonly ProjectSummary[] }
): string {
	if (site === null) return '';

	const published = new Set(site.projects.map((project) => project.directory));
	const missing = current.projects.filter((project) => !published.has(project.directory));
	const removed = site.projects.filter(
		(project) => !current.projects.some((summary) => summary.directory === project.directory)
	);
	const renamed = current.projects.filter((project) =>
		site.projects.some(
			(entry) => entry.directory === project.directory && entry.name !== project.name
		)
	);
	const staleViewer = site.viewerVersion !== current.viewerVersion;

	const reasons = [
		missing.length > 0
			? `${missing.map((project) => `“${project.name}”`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on it yet`
			: '',
		removed.length > 0
			? `${removed.map((project) => `“${project.name}”`).join(', ')} ${removed.length === 1 ? 'is' : 'are'} still on it`
			: '',
		renamed.length > 0
			? `${renamed.map((project) => `“${project.name}”`).join(', ')} ${renamed.length === 1 ? 'is' : 'are'} listed under an older name`
			: '',
		staleViewer ? 'and it carries an older version of the viewer' : ''
	].filter(Boolean);

	if (reasons.length === 0) return '';
	return `This Workspace has been published, but ${reasons.join(', ')}. Publish again to bring the site up to date.`;
}

// ── The canonical URL: an opt-in stamp, and the one thing publishing writes into Project data ──

/**
 * A user-typed address as an image service base, or `''` when it cannot be one.
 *
 * Deliberately strict about the scheme and forgiving about everything else: a canonical `id` has
 * to be an absolute URL a stranger's IIIF client can dereference (ADR-0004), and `http`/`https`
 * are the only schemes that is true of. The trailing `/` and any query or fragment are dropped,
 * because what is being recorded is a base other paths are concatenated onto.
 */
export function normaliseCanonicalUrl(input: string): string {
	const trimmed = input.trim();
	if (trimmed === '') return '';
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return '';
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
	url.search = '';
	url.hash = '';
	return url.href.replace(/\/+$/, '');
}

/**
 * The IIIF image service `id` one Historical Map answers at, once the Workspace is at `url`.
 *
 * `<url>/images/<image-id>` — the directory the pyramid is in, because `@allmaps/iiif-parser` builds
 * every tile URL by concatenating the IIIF path onto `id`, and the pyramid's files are laid out at
 * exactly that path **relative to the Workspace** (ADR-0004, ADR-0023). No Project directory: a
 * Historical Map is shared, so it answers at one address whichever Projects reference it — and a stamp
 * that named one of them would 404 for every tile the moment that Project was renamed or deleted.
 *
 * Stamp the wrong base and every tile 404s, so this is the one function that decides it.
 *
 * Resolved through `URL` rather than by string-joining, because that is what it actually is — a
 * Workspace-relative path resolved against the address the Workspace is served at — and because
 * `scripts/check-workspace-rooted-paths.mjs` is right to refuse the string-joined spelling. Every
 * `${something}/${imageDirectory(id)}` that fence sees *is* a Project-rooted store path except this one,
 * and an exemption for the file would have covered `stampCanonicalUrl` below it too.
 */
export const canonicalImageServiceId = (url: string, imageId: string): string =>
	// `normaliseCanonicalUrl` has already stripped any trailing slash, so this adds exactly one.
	new URL(imageDirectory(imageId), `${url}/`).href;

/** What stamping the Workspace's Historical Maps changed. */
export type CanonicalStamp = {
	readonly url: string;
	/** The `info.json` files rewritten. */
	readonly images: readonly string[];
};

/**
 * Rewrite every named Historical Map's `info.json` `id` to the canonical address (SPEC story 92).
 *
 * This is what turns a scholar's tiles into a real, citable IIIF endpoint that Allmaps, Theseus,
 * and OpenSeadragon can consume directly — the interoperability promise actually paying out rather
 * than being a claim about file formats (ADR-0004).
 *
 * **A Workspace-level action, and it takes no Project directory** (ADR-0023). The pyramids are shared,
 * so there is one address per Historical Map and stamping it once is stamping it for every Project. The
 * per-Project version wrote `<url>/<project>/images/<id>`, which was a citation that broke as soon as
 * a second Project used the map or the first one was renamed.
 *
 * **Opt-in, and the only path on which publishing writes the user's own files.** Everything else
 * publishing does is additive; this is a change the user asked for, so it is a separate call the
 * caller makes deliberately and records in each `project.json`.
 *
 * Only `id` is touched, and the rest of the document is written back exactly as it was parsed, so
 * a field a newer build added survives the stamp. Nothing else in the pyramid moves: the editor
 * assigns `Image#uri` at load time from wherever the tiles really are, so a stamped Workspace still
 * opens here — load-time override always wins (ADR-0004).
 */
export async function stampCanonicalUrl(
	store: ProjectStore,
	url: string,
	imageIds: readonly string[]
): Promise<CanonicalStamp> {
	const stamped = normaliseCanonicalUrl(url);
	if (stamped === '') {
		throw new PublishRefusedError(
			`“${url}” is not a web address a IIIF client could fetch tiles from. It needs to start ` +
				`with https:// (or http://) and name the address your Workspace is published at — for ` +
				`example https://your-name.github.io/your-repository. Nothing has been changed.`
		);
	}

	const images: string[] = [];
	for (const imageId of imageIds) {
		const path = assertStorePath(imageInfoPath(imageId));
		const info = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(await store.read(path))
		);
		if (typeof info !== 'object' || info === null || Array.isArray(info)) continue;
		const next = { ...(info as Record<string, unknown>) };
		next.id = canonicalImageServiceId(stamped, imageId);
		await store.write(path, serialiseJson(next));
		images.push(imageId);
	}
	return { url: stamped, images };
}
