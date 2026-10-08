import { BASE_MAP_CATALOG, type BaseMapCatalog } from '../base-map/index.js';
import {
	baseMapCaches,
	totalBaseMapCacheSize,
	type BaseMapCache,
	type BaseMapCacheSize
} from '../base-map/offline-cache.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { normaliseRemoteIdentity } from '../remote/remote-binding.js';
import { referencedMapImages, unusedMapImageBytes } from '../project/map-images.js';
import { parseProjectFile, projectFilePath, type ProjectFile } from '../project/project-file.js';
import {
	STATIC_HOSTING_LIMIT_BYTES,
	crossesHostingLimit,
	describeBytes,
	workspaceSize,
	type WorkspaceSize
} from '../project/workspace-size.js';
import type { ProjectSummary } from '../project/workspace.js';
import {
	asRecord,
	assertStorePath,
	parseJsonObject,
	serialiseJson,
	textField,
	type Bytes,
	type ProjectStore
} from '../store/project-store.js';
import { listIngestedImages } from '../tiler/ingest.js';
import {
	JEKYLL_OFF_MARKER,
	PUBLISHED_APP_DIRECTORY,
	PUBLISHED_SITE_RECORD_NAME,
	VIEWER_FILE_PATHS,
	claimedByPublishedSite,
	isViewerFile
} from '../transfer/viewer-files.js';
import { bundleBytes, type ViewerBundle, type ViewerBundleFile } from './viewer-bundle.js';

const PUBLISHED_SITE_FORMAT_VERSION = 2;

type PublishedProject = {
	readonly directory: string;
	readonly name: string;
	readonly onFrontPage: boolean;
};

export type PublishedRepository = {
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
};

export type PublishedSite = {
	readonly formatVersion: number;
	readonly viewerVersion: string;
	readonly publishedAt: string;
	readonly editorUrl: string;
	readonly repository: PublishedRepository | null;
	readonly projects: readonly PublishedProject[];
	readonly baseMap: BaseMapCatalog;
	readonly baseMapBundled: boolean;
	readonly baseMapAssetsBundled: boolean;
	readonly baseMapCaches: readonly PublishedBaseMapCache[];
};

type PublishedBaseMapCache = {
	readonly archive: string | null;
	readonly maxZoom: number;
};

class PublishedSiteUnreadableError extends Error {
	override readonly name = 'PublishedSiteUnreadableError';
	constructor(reason: string) {
		super(`This Workspace's ${PUBLISHED_SITE_RECORD_NAME} could not be read: ${reason}`);
	}
}

const serialisePublishedSite = (site: PublishedSite): Bytes => serialiseJson(site);

const JEKYLL_OFF_MARKER_FILE: ViewerBundleFile = {
	path: JEKYLL_OFF_MARKER,
	source: '',
	bytes: 0
};

export function parsePublishedSite(bytes: Uint8Array): PublishedSite {
	const record = parseJsonObject(bytes, (reason) => new PublishedSiteUnreadableError(reason));
	const projects = Array.isArray(record.projects) ? record.projects : [];

	return {
		formatVersion:
			typeof record.formatVersion === 'number'
				? record.formatVersion
				: PUBLISHED_SITE_FORMAT_VERSION,
		viewerVersion: textField(record.viewerVersion),
		publishedAt: textField(record.publishedAt),
		editorUrl: parseEditorUrl(record.editorUrl),
		repository: parsePublishedRepository(record.repository),
		projects: projects.flatMap((entry) => {
			const project = entry as Record<string, unknown> | null;
			const directory = project?.directory;
			if (typeof directory !== 'string' || directory === '') return [];
			return [
				{
					directory,
					name: typeof project?.name === 'string' ? project.name : directory,
					onFrontPage: project?.onFrontPage !== false
				}
			];
		}),
		baseMap: isCatalog(record.baseMap) ? record.baseMap : BASE_MAP_CATALOG,
		baseMapBundled: record.baseMapBundled === true,
		baseMapAssetsBundled:
			typeof record.baseMapAssetsBundled === 'boolean'
				? record.baseMapAssetsBundled
				: record.baseMapBundled === true,
		baseMapCaches: parseBaseMapCaches(record.baseMapCaches, record.baseMapMaxZoom)
	};
}

function parseEditorUrl(value: unknown): string {
	if (typeof value !== 'string' || value === '') return '';
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return '';
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
	if (!reachableByAReader(url.hostname)) return '';
	url.username = '';
	url.password = '';
	url.search = '';
	url.hash = '';
	return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function parsePublishedRepository(value: unknown): PublishedRepository | null {
	const record = asRecord(value);
	return record && normaliseRemoteIdentity(record);
}

function reachableByAReader(hostname: string): boolean {
	const host = hostname.toLowerCase();
	if (host.startsWith('[')) return host !== '[::1]';
	if (host === 'localhost' || host.endsWith('.localhost')) return false;
	if (host.startsWith('127.')) return false;
	return host.includes('.');
}

const isZoom = (value: unknown): value is number =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0;

function parseBaseMapCaches(
	value: unknown,
	legacyMaxZoom: unknown
): readonly PublishedBaseMapCache[] {
	if (!Array.isArray(value)) {
		return isZoom(legacyMaxZoom) ? [{ archive: null, maxZoom: legacyMaxZoom }] : [];
	}
	return value.flatMap<PublishedBaseMapCache>((entry: unknown) => {
		const { archive, maxZoom } = (entry ?? {}) as { archive?: unknown; maxZoom?: unknown };
		const named =
			archive === null ? null : typeof archive === 'string' && archive !== '' ? archive : undefined;
		if (named === undefined) return [];
		if (!isZoom(maxZoom)) return [];
		return [{ archive: named, maxZoom }];
	});
}

function isCatalog(value: unknown): value is BaseMapCatalog {
	const entries = (value as { entries?: unknown } | null)?.entries;
	return Array.isArray(entries) && entries.length > 0;
}

type PublishedSiteWarning = {
	readonly kind: 'referenced-images' | 'base-map-size' | 'hosting-limit' | 'name-collision';
	readonly message: string;
};

export type PublishedSitePlan = {
	readonly viewerVersion: string;
	readonly projects: readonly PublishedProject[];
	readonly files: readonly ViewerBundleFile[];
	readonly bytes: number;
	readonly workspace: WorkspaceSize;
	readonly mapImages: WorkspaceSize;
	readonly unusedMapImages: { readonly bytes: number; readonly maps: number };
	readonly baseMapBundled: boolean;
	readonly baseMapAssetsBundled: boolean;
	readonly baseMapTiles: BaseMapCacheSize;
	readonly baseMapCaches: readonly PublishedBaseMapCache[];
	readonly baseMap: BaseMapCatalog;
	readonly canonicalUrl: string | null;
	readonly editorUrl: string;
	readonly repository: PublishedRepository | null;
	readonly collisions: readonly string[];
	readonly warnings: readonly PublishedSiteWarning[];
};

export class PublishedSiteRefusedError extends Error {
	override readonly name = 'PublishedSiteRefusedError';
}

const tiledMapImageSize = async (store: ProjectStore): Promise<WorkspaceSize> => {
	const images = await listIngestedImages(store);
	const sizes = await Promise.all(
		images.map((image) => workspaceSize(store, `${image.directory}/`))
	);
	return sizes.reduce(
		(total, size) => ({ bytes: total.bytes + size.bytes, files: total.files + size.files }),
		{ bytes: 0, files: 0 }
	);
};

export async function planPublishedSite(
	store: ProjectStore,
	options: {
		readonly bundle: ViewerBundle;
		readonly projects: readonly ProjectSummary[];
		readonly catalog?: BaseMapCatalog;
		readonly editorUrl?: string;
		readonly repository?: PublishedRepository | null;
	}
): Promise<PublishedSitePlan> {
	const { bundle } = options;
	const listed: PublishedProject[] = options.projects.map(({ directory, name, onFrontPage }) => ({
		directory,
		name,
		onFrontPage
	}));

	const workspace = await workspaceSize(store);
	const mapImages = await tiledMapImageSize(store);
	const unusedMapImages = await unusedMapImageBytes(store);
	const caches = await baseMapCaches(store);
	const baseMapTiles = totalBaseMapCacheSize(caches);
	const baseMap = bundle.baseMap;
	const record: SiteFields = {
		viewerVersion: bundle.version,
		editorUrl: parseEditorUrl(options.editorUrl),
		repository: parsePublishedRepository(options.repository),
		projects: listed,
		baseMap: options.catalog ?? BASE_MAP_CATALOG,
		baseMapBundled: baseMapTiles.tiles > 0,
		baseMapAssetsBundled: baseMap.length > 0,
		baseMapCaches: publishedBaseMapCaches(caches)
	};
	const recordFile: ViewerBundleFile = {
		path: PUBLISHED_SITE_RECORD_NAME,
		source: '',
		bytes: serialisePublishedSite(siteRecord(record, '')).byteLength
	};
	const files = [...bundle.files, ...baseMap, recordFile, JEKYLL_OFF_MARKER_FILE];
	const bytes = bundleBytes(files);

	const collisions = listed
		.filter((project) => claimedByPublishedSite(project.directory))
		.map((project) => project.directory);

	const warnings: PublishedSiteWarning[] = [];

	if (collisions.length > 0) {
		warnings.push({ kind: 'name-collision', message: collisionMessage(collisions) });
	}

	const { referenced, canonicalUrl } = await inspectProjects(store, listed);
	if (referenced.length > 0) {
		warnings.push({ kind: 'referenced-images', message: referencedWarning(referenced) });
	}

	if (baseMap.length > 0) {
		warnings.push({
			kind: 'base-map-size',
			message:
				`Base Map labels and symbols add ${baseMap.length} more files, about ` +
				`${describeBytes(bundleBytes(baseMap))}. ` +
				(baseMapTiles.tiles > 0
					? `${baseMapTiles.tiles} cached tiles (${describeBytes(baseMapTiles.bytes)}); works offline. `
					: 'Base Map tiles need a network connection. ') +
				`Counts against the hosting budget.`
		});
	}

	if (crossesHostingLimit(workspace.bytes, bytes)) {
		warnings.push({
			kind: 'hosting-limit',
			message: hostingWarning(workspace.bytes, bytes, unusedMapImages)
		});
	}

	return {
		...record,
		files,
		bytes,
		workspace,
		mapImages,
		unusedMapImages,
		baseMapTiles,
		canonicalUrl,
		collisions,
		warnings
	};
}

const publishedBaseMapCaches = (
	caches: readonly BaseMapCache[]
): readonly PublishedBaseMapCache[] =>
	caches.flatMap<PublishedBaseMapCache>((cache) => {
		if (cache.tiles === 0) return [];
		if (cache.legacy) {
			return cache.maxZoom === null ? [] : [{ archive: null, maxZoom: cache.maxZoom }];
		}
		return cache.archive !== null && cache.sourceMaxZoom !== null
			? [{ archive: cache.archive, maxZoom: cache.sourceMaxZoom }]
			: [];
	});

const collisionMessage = (collisions: readonly string[]): string =>
	`${collisions.map((directory) => `“${directory}”`).join(', ')} ` +
	`${collisions.length === 1 ? 'is a Project whose folder has' : 'are Projects whose folders have'} ` +
	`a name the website itself needs. Rename ` +
	`${collisions.length === 1 ? 'it' : 'them'} — the display name can stay as it is — and try ` +
	`again. Nothing has been written.`;

async function inspectProjects(
	store: ProjectStore,
	projects: readonly PublishedProject[]
): Promise<{
	referenced: { project: PublishedProject; layers: string[] }[];
	canonicalUrl: string | null;
}> {
	const remote = await referencedMapImages(store);
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

function referencedWarning(referenced: { project: PublishedProject; layers: string[] }[]): string {
	const total = referenced.reduce((sum, entry) => sum + entry.layers.length, 0);
	const where = referenced
		.map((entry) => `${entry.project.name}: ${entry.layers.join(', ')}`)
		.join('; ');
	return (
		`${total === 1 ? 'One Map Image' : `${total} Map Images`} in this Workspace ` +
		`${total === 1 ? 'is' : 'are'} still fetched from the library that holds ${total === 1 ? 'it' : 'them'} ` +
		`rather than copied into your own folder (${where}). Your Published Site depends on those ` +
		`servers: a Reader with no network, or one visiting after the library reorganises, sees ` +
		`nothing where ${total === 1 ? 'that Layer draws' : 'those Layers draw'}. Make an offline copy ` +
		`of each one first if the site has to stand on its own.`
	);
}

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
			? `, including ${describeBytes(unused.bytes)} of Map Images no Project uses — ` +
				`${unused.maps === 1 ? 'one map' : `${unused.maps} maps`} you can delete from the hub to ` +
				`reclaim that space — and`
			: ' and') +
		` writing it adds about ${describeBytes(adding)}, ` +
		(already
			? `so it is already past the ${limit} a free static host such as GitHub Pages will serve. `
			: `which takes it past the ${limit} a free static host such as GitHub Pages will serve. `) +
		`This is a cliff rather than a slowdown: the files are written either way, but pushing them ` +
		`will fail. The way out is to host the site somewhere without that limit, or to keep fewer ` +
		`offline copies in this Workspace.`
	);
}

export async function writePublishedSite({
	store,
	plan,
	readAsset,
	now = () => new Date(),
	onProgress
}: {
	readonly store: ProjectStore;
	readonly plan: PublishedSitePlan;
	readonly readAsset: (file: ViewerBundleFile) => Promise<Bytes>;
	readonly now?: () => Date;
	readonly onProgress?: (progress: {
		readonly files: number;
		readonly totalFiles: number;
		readonly path: string | null;
	}) => void;
}): Promise<PublishedSite> {
	if (plan.collisions.length > 0) {
		throw new PublishedSiteRefusedError(collisionMessage(plan.collisions));
	}

	const unrecorded = plan.files.filter((file) => !isViewerFile(file.path));
	if (unrecorded.length > 0) {
		throw new PublishedSiteRefusedError(
			`Writing this site would put ${unrecorded.map((file) => file.path).join(', ')} there, which ` +
				`VIEWER_FILE_PATHS does not record. ADR-0045 requires the viewer file set to be ` +
				`enumerable, so that a data-only Project archive can exclude exactly it. Record the path ` +
				`there and try again. Nothing has been written.`
		);
	}

	const assets = plan.files.filter((file) => file.source !== '');
	const authored = plan.files.filter(
		(file) => file.source === '' && file.path !== PUBLISHED_SITE_RECORD_NAME
	);
	const totalFiles = plan.files.length;
	let written = 0;
	const report = (path: string | null) => onProgress?.({ files: written, totalFiles, path });
	const write = async (path: string, bytes: Bytes) => {
		await store.write(assertStorePath(path), bytes);
		written += 1;
		report(path);
	};

	report(null);
	for (const file of assets) await write(file.path, await readAsset(file));
	for (const file of authored) await write(file.path, new Uint8Array(0));
	const site = siteRecord(plan, now().toISOString());
	await write(PUBLISHED_SITE_RECORD_NAME, serialisePublishedSite(site));

	const planned = new Set(plan.files.map((file) => file.path));
	await removeViewerFiles(
		store,
		VIEWER_FILE_PATHS.filter((recorded) => recorded !== PUBLISHED_APP_DIRECTORY),
		planned
	);
	return site;
}

async function removeViewerFiles(
	store: ProjectStore,
	recordedPaths: readonly string[],
	keep: ReadonlySet<string> = new Set()
): Promise<void> {
	for (const recorded of recordedPaths) {
		const paths = recorded.endsWith('/')
			? (await store.list(recorded)).filter((path) => !path.startsWith(BASE_MAP_TILE_ROOT))
			: [recorded];
		for (const path of paths) if (!keep.has(path)) await store.delete(assertStorePath(path));
	}
}

export const withdrawShareLinks = (store: ProjectStore): Promise<void> =>
	removeViewerFiles(store, VIEWER_FILE_PATHS);

type SiteFields = Omit<PublishedSite, 'formatVersion' | 'publishedAt'>;

const siteRecord = (fields: SiteFields, publishedAt: string): PublishedSite => ({
	formatVersion: PUBLISHED_SITE_FORMAT_VERSION,
	viewerVersion: fields.viewerVersion,
	publishedAt,
	editorUrl: fields.editorUrl,
	repository: fields.repository,
	projects: fields.projects,
	baseMap: fields.baseMap,
	baseMapBundled: fields.baseMapBundled,
	baseMapAssetsBundled: fields.baseMapAssetsBundled,
	baseMapCaches: fields.baseMapCaches
});

export async function readPublishedSite(store: ProjectStore): Promise<PublishedSite | null> {
	const bytes = await store.read(PUBLISHED_SITE_RECORD_NAME).catch(() => null);
	return bytes === null ? null : parsePublishedSite(bytes);
}

export function publishedSiteStaleness(
	site: PublishedSite | null,
	current: { readonly viewerVersion: string; readonly projects: readonly ProjectSummary[] }
): string {
	if (site === null) return '';

	const onSite = (project: ProjectSummary, test: (entry: PublishedProject) => boolean) =>
		site.projects.some((entry) => entry.directory === project.directory && test(entry));
	const these = (projects: readonly { name: string }[], what: string): string =>
		projects.length === 0
			? ''
			: `${projects.map((project) => `“${project.name}”`).join(', ')} ${projects.length === 1 ? 'is' : 'are'} ${what}`;
	const named = (test: (project: ProjectSummary) => boolean, what: string) =>
		these(current.projects.filter(test), what);

	const reasons = [
		named((project) => !onSite(project, () => true), 'not on it yet'),
		these(
			site.projects.filter(
				(entry) => !current.projects.some((project) => project.directory === entry.directory)
			),
			'still on it'
		),
		named(
			(project) => onSite(project, (entry) => entry.name !== project.name),
			'listed under an older name'
		),
		named(
			(project) => !project.onFrontPage && onSite(project, (entry) => entry.onFrontPage),
			'still on its front page'
		),
		named(
			(project) => project.onFrontPage && onSite(project, (entry) => !entry.onFrontPage),
			'not on its front page yet'
		),
		site.viewerVersion === current.viewerVersion
			? ''
			: 'and it carries an older version of the viewer'
	].filter(Boolean);

	if (reasons.length === 0) return '';
	return `This Workspace has a Published Site, but ${reasons.join(', ')}. Sync again to bring the site up to date.`;
}
