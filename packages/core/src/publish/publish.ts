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

import { BASE_MAP_CATALOG, type BaseMapCatalog } from '../base-map/index.js';
import { imageInfoPath } from '../project/image-files.js';
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
	PUBLISHED_SITE_RECORD_NAME,
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
	/** Whether the Base Map's own files were written too, so the site needs no network for them. */
	readonly baseMapBundled: boolean;
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
		baseMapBundled: record.baseMapBundled === true
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
	readonly baseMapBundled: boolean;
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
				baseMapBundled: includeBaseMap
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
				`Including the Base Map writes ${baseMap.length} more files, about ` +
				`${describeBytes(bundleBytes(baseMap))}, into this Workspace. That is what makes the ` +
				`Published Site work with no network at all, and it counts against the same hosting ` +
				`budget as your Historical Maps.`
		});
	}

	if (crossesHostingLimit(workspace.bytes, bytes)) {
		warnings.push({ kind: 'hosting-limit', message: hostingWarning(workspace.bytes, bytes) });
	}

	return {
		viewerVersion: bundle.version,
		projects: listed,
		files,
		bytes,
		workspace,
		baseMapBundled: includeBaseMap && baseMap.length > 0,
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
 * **The referenced Historical Maps** are read out of each `project.json`'s Layer stack rather than
 * out of `remote.json`, because the warning is about what the *site* draws: a `remote.json` for an
 * image nothing references costs a Reader nothing, and a Layer that says `'referenced'` is a Layer
 * that renders blank without a network (ADR-0007, SPEC stories 29 and 90).
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
			.filter((layer) => layer.kind === 'map' && layer.imageMode === 'referenced')
			.map((layer) => layer.name || layer.id);
		if (layers.length > 0) referenced.push({ project, layers });
	}
	return { referenced, canonicalUrl };
}

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
 */
function hostingWarning(current: number, adding: number): string {
	const limit = describeBytes(STATIC_HOSTING_LIMIT_BYTES);
	const already = current > STATIC_HOSTING_LIMIT_BYTES;
	return (
		`This Workspace holds ${describeBytes(current)} and publishing adds about ` +
		`${describeBytes(adding)}, ` +
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
 * **Additive, and that is a property of this function rather than an intention.** It writes only
 * the paths the plan names, every one of which is a name `PUBLISHED_SITE_PATHS` records, and it
 * reads nothing from the Workspace — so no Project file can be rewritten, re-serialised, or
 * touched by publishing, whatever else changes here later.
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
		baseMapBundled: plan.baseMapBundled
	});
	await store.write(PUBLISHED_SITE_RECORD_NAME, serialisePublishedSite(site));
	written += 1;
	report(PUBLISHED_SITE_RECORD_NAME);
	return site;
}

const siteRecord = (fields: {
	viewerVersion: string;
	publishedAt: string;
	projects: readonly PublishedProject[];
	catalog: BaseMapCatalog;
	baseMapBundled: boolean;
}): PublishedSite => ({
	formatVersion: PUBLISHED_SITE_FORMAT_VERSION,
	viewerVersion: fields.viewerVersion,
	publishedAt: fields.publishedAt,
	projects: fields.projects,
	baseMap: fields.catalog,
	baseMapBundled: fields.baseMapBundled
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
 * `<url>/<project>/images/<image-id>` — the directory the pyramid is in, because
 * `@allmaps/iiif-parser` builds every tile URL by concatenating the IIIF path onto `id`, and the
 * pyramid's files are laid out at exactly that path relative to the Project (ADR-0004, ADR-0006).
 * Stamp the wrong base and every tile 404s, so this is the one function that decides it.
 */
export const canonicalImageServiceId = (url: string, directory: string, imageId: string): string =>
	`${url}/${directory}/${imageInfoPath(imageId).replace(/\/info\.json$/, '')}`;

/** What stamping one Project changed. */
export type CanonicalStamp = {
	readonly url: string;
	/** The `info.json` files rewritten. */
	readonly images: readonly string[];
};

/**
 * Rewrite every `info.json` `id` in one Project to the canonical address (SPEC story 92).
 *
 * This is what turns a scholar's tiles into a real, citable IIIF endpoint that Allmaps, Theseus,
 * and OpenSeadragon can consume directly — the interoperability promise actually paying out rather
 * than being a claim about file formats (ADR-0004).
 *
 * **Opt-in, and the only path on which publishing writes a Project's own files.** Everything else
 * publishing does is additive; this is a change the user asked for, so it is a separate call the
 * caller makes deliberately and records in `project.json`.
 *
 * Only `id` is touched, and the rest of the document is written back exactly as it was parsed, so
 * a field a newer build added survives the stamp. Nothing else in the pyramid moves: the editor
 * assigns `Image#uri` at load time from wherever the tiles really are, so a stamped Project still
 * opens here — load-time override always wins (ADR-0004).
 */
export async function stampCanonicalUrl(
	store: ProjectStore,
	directory: string,
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
		const path = assertStorePath(`${directory}/${imageInfoPath(imageId)}`);
		const info = JSON.parse(
			new TextDecoder('utf-8', { fatal: true }).decode(await store.read(path))
		);
		if (typeof info !== 'object' || info === null || Array.isArray(info)) continue;
		const next = { ...(info as Record<string, unknown>) };
		next.id = canonicalImageServiceId(stamped, directory, imageId);
		await store.write(path, serialiseJson(next));
		images.push(imageId);
	}
	return { url: stamped, images };
}
