import { alignmentPath } from '../alignment/alignment.js';
import {
	parseReferencedImage,
	referencedImagePath,
	type ReferencedImage
} from '../remote-iiif/referenced-image.js';
import { readImageLabel, wholeImageDerivative } from '../tiler/image-manifest.js';
import { imageGeometryFromInfo, imageServiceId } from '../tiler/pyramid.js';
import {
	messageOf,
	parseJsonBytes,
	topLevelSegment,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import {
	IMAGE_DIRECTORY,
	imageDirectory,
	imageInfoPath,
	imageManifestPath
} from './image-files.js';
import { ProjectFormatTooNewError, parseProjectFile, projectFilePath } from './project-file.js';

type TileLocation = 'in-workspace' | 'referenced';

interface MapImageFiles {
	readonly infoJson: boolean;
	readonly remoteJson: boolean;
}

export function tileLocation(files: MapImageFiles): TileLocation | null {
	if (files.infoJson) return 'in-workspace';
	return files.remoteJson ? 'referenced' : null;
}

interface MapImageUser {
	readonly directory: string;
	readonly name: string;
}

export interface WorkspaceMapImage {
	readonly imageId: string;
	readonly label: string;
	readonly provenance: {
		readonly source: string;
		readonly canvasLabel: string;
	} | null;
	readonly tiles: TileLocation;
	readonly library: string;
	readonly thumbnail: string | null;
	readonly bytes: number;
	readonly files: number;
	readonly usedBy: readonly MapImageUser[];
	readonly mightBeUsedBy: readonly MapImageUser[];
}

async function scanImages(
	store: Pick<ProjectStore, 'list'>
): Promise<Map<string, { files: MapImageFiles; paths: StorePath[] }>> {
	const prefix = `${IMAGE_DIRECTORY}/`;
	const found = new Map<
		string,
		{ files: { infoJson: boolean; remoteJson: boolean }; paths: StorePath[] }
	>();

	for (const path of await store.list(prefix)) {
		const rest = path.slice(prefix.length);
		const slash = rest.indexOf('/');
		if (slash <= 0) continue;
		const imageId = rest.slice(0, slash);
		const entry = found.get(imageId) ?? {
			files: { infoJson: false, remoteJson: false },
			paths: []
		};
		entry.paths.push(path);
		if (path === imageInfoPath(imageId)) entry.files.infoJson = true;
		else if (path === referencedImagePath(imageId)) entry.files.remoteJson = true;
		found.set(imageId, entry);
	}

	for (const [imageId, { files }] of found) {
		if (tileLocation(files) === null) found.delete(imageId);
	}
	return found;
}

export async function referencedMapImages(
	store: Pick<ProjectStore, 'list'>
): Promise<ReadonlySet<string>> {
	const scanned = [...(await scanImages(store))];
	return new Set(
		scanned.filter(([, { files }]) => tileLocation(files) === 'referenced').map(([id]) => id)
	);
}

interface MapImageUsage {
	readonly byMap: ReadonlyMap<string, readonly MapImageUser[]>;
	readonly fromANewerVersion: readonly MapImageUser[];
}

export async function mapImageUsage(
	store: Pick<ProjectStore, 'list' | 'read'>
): Promise<MapImageUsage> {
	const byMap = new Map<string, MapImageUser[]>();
	const fromANewerVersion: MapImageUser[] = [];

	for (const path of await store.list('')) {
		const directory = topLevelSegment(path);
		if (path !== projectFilePath(directory)) continue;

		let file;
		try {
			file = parseProjectFile(await store.read(path));
		} catch (cause) {
			if (cause instanceof ProjectFormatTooNewError) {
				fromANewerVersion.push({ directory, name: directory });
			}
			continue;
		}

		const name = file.name || directory;
		for (const layer of file.layers) {
			if (layer.kind !== 'map' || layer.imageId === '') continue;
			const users = byMap.get(layer.imageId) ?? [];
			if (!users.some((user) => user.directory === directory)) users.push({ directory, name });
			byMap.set(layer.imageId, users);
		}
	}

	return { byMap, fromANewerVersion };
}

const usersOf = (usage: MapImageUsage, imageId: string): readonly MapImageUser[] =>
	usage.byMap.get(imageId) ?? [];

export async function listWorkspaceMapImages(store: ProjectStore): Promise<WorkspaceMapImage[]> {
	const scanned = await scanImages(store);
	const usage = await mapImageUsage(store);

	const maps = await Promise.all(
		[...scanned].map(async ([imageId, { files, paths }]): Promise<WorkspaceMapImage | null> => {
			const tiles = tileLocation(files);
			if (tiles === null) return null;
			const remote = files.remoteJson ? await readRemoteRecord(store, imageId) : null;
			const named = files.infoJson ? await readManifestLabel(store, imageId) : '';

			return {
				imageId,
				label: named || remote?.label || '',
				provenance: remote
					? { source: remote.source, canvasLabel: remote.canvas ? remote.label : '' }
					: null,
				tiles,
				library: tiles === 'referenced' ? libraryOf(remote?.service ?? '') : '',
				thumbnail:
					tiles === 'in-workspace'
						? await readWorkspaceThumbnail(store, imageId)
						: referencedThumbnail(remote),
				...(await weigh(store, imageId, paths)),
				usedBy: usersOf(usage, imageId),
				mightBeUsedBy: usage.fromANewerVersion
			};
		})
	);

	return maps.filter((map) => map !== null).sort((a, b) => a.imageId.localeCompare(b.imageId));
}

interface Reclaimable {
	readonly bytes: number;
	readonly usedBy: readonly unknown[];
	readonly mightBeUsedBy: readonly unknown[];
}

export function unusedMapImages<T extends Reclaimable>(
	maps: readonly T[]
): { maps: T[]; bytes: number } {
	const unused = maps.filter((map) => map.usedBy.length === 0 && map.mightBeUsedBy.length === 0);
	return { maps: unused, bytes: unused.reduce((sum, map) => sum + map.bytes, 0) };
}

export async function unusedMapImageBytes(
	store: ProjectStore
): Promise<{ bytes: number; maps: number }> {
	const scanned = await scanImages(store);
	const usage = await mapImageUsage(store);
	if (usage.fromANewerVersion.length > 0) return { bytes: 0, maps: 0 };
	const unused = [...scanned].filter(([imageId]) => usersOf(usage, imageId).length === 0);
	const weights = await Promise.all(
		unused.map(([imageId, { paths }]) => weigh(store, imageId, paths))
	);
	return { bytes: weights.reduce((sum, { bytes }) => sum + bytes, 0), maps: unused.length };
}

async function weigh(
	store: Pick<ProjectStore, 'size'>,
	imageId: string,
	paths: readonly StorePath[]
): Promise<{ bytes: number; files: number }> {
	const sizes = await Promise.all(paths.map((path) => store.size(path).catch(() => 0)));
	const placement = await store.size(alignmentPath(imageId)).catch(() => null);

	return {
		bytes: sizes.reduce((sum, size) => sum + size, 0) + (placement ?? 0),
		files: paths.length + (placement === null ? 0 : 1)
	};
}

export class MapImageInUseError extends Error {
	override readonly name = 'MapImageInUseError';
	constructor(
		readonly imageId: string,
		label: string,
		readonly projects: readonly MapImageUser[],
		readonly fromANewerVersion: readonly MapImageUser[] = []
	) {
		super(refusalMessage(label || imageId, projects, fromANewerVersion));
	}
}

const namesOf = (users: readonly MapImageUser[]): string =>
	users.map((user) => `“${user.name}”`).join(' and ');

function refusalMessage(
	named: string,
	projects: readonly MapImageUser[],
	fromANewerVersion: readonly MapImageUser[]
): string {
	if (projects.length === 0) {
		const one = fromANewerVersion.length === 1;
		return (
			`“${named}” has not been deleted: ${namesOf(fromANewerVersion)} ` +
			`${one ? 'was' : 'were'} made with a newer version of Ballastella, so this build cannot read ` +
			`which Map Images ${one ? 'it draws' : 'they draw'}. Update your copy of Ballastella, or ` +
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

export class MapImagePartlyDeletedError extends Error {
	override readonly name = 'MapImagePartlyDeletedError';
	constructor(
		readonly imageId: string,
		label: string,
		readonly removed: number,
		cause: unknown
	) {
		super(
			`“${label || imageId}” was only partly deleted: ${removed} of its ` +
				`${removed === 1 ? 'file was' : 'files were'} removed and the rest could not be. It is still ` +
				`listed, and deleting it again will finish the job. The Workspace reported: ${messageOf(cause)}`,
			{ cause }
		);
	}
}

export async function deleteMapImage(
	store: ProjectStore,
	imageId: string,
	options: { label?: string } = {}
): Promise<void> {
	const usage = await mapImageUsage(store);
	const users = usersOf(usage, imageId);
	if (users.length > 0 || usage.fromANewerVersion.length > 0) {
		throw new MapImageInUseError(imageId, options.label ?? '', users, usage.fromANewerVersion);
	}

	const directory = `${imageDirectory(imageId)}/`;
	await store.reclaimAbandonedWrites(directory);
	const listed = await store.list(directory);
	const classifiers = [referencedImagePath(imageId), imageInfoPath(imageId)];
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
			if (removed === 0) throw cause;
			throw new MapImagePartlyDeletedError(imageId, options.label ?? '', removed, cause);
		}
		removed++;
	}
}

export function partitionByOfflineCopy(
	images: readonly ReferencedImage[],
	ingested: readonly { readonly imageId: string }[]
): { referenced: ReferencedImage[]; offlineCopies: ReferencedImage[] } {
	const local = new Set(ingested.map((image) => image.imageId));
	const isReferenced = (image: ReferencedImage) =>
		tileLocation({ infoJson: local.has(image.imageId), remoteJson: true }) === 'referenced';
	return {
		referenced: images.filter(isReferenced),
		offlineCopies: images.filter((image) => !isReferenced(image))
	};
}

async function readRemoteRecord(
	store: Pick<ProjectStore, 'read'>,
	imageId: string
): Promise<ReferencedImage | null> {
	try {
		return parseReferencedImage(await store.read(referencedImagePath(imageId)), { imageId });
	} catch {
		return null;
	}
}

async function readManifestLabel(
	store: Pick<ProjectStore, 'read'>,
	imageId: string
): Promise<string> {
	try {
		const bytes = await store.read(imageManifestPath(imageId));
		return readImageLabel(parseJsonBytes(bytes));
	} catch {
		return '';
	}
}

async function readWorkspaceThumbnail(
	store: Pick<ProjectStore, 'read'>,
	imageId: string
): Promise<string | null> {
	let info: unknown;
	try {
		info = parseJsonBytes(await store.read(imageInfoPath(imageId)));
	} catch {
		return null;
	}

	const geometry = imageGeometryFromInfo(info);
	if (geometry === null) return null;
	return wholeImageDerivative(geometry.width, geometry.height, geometry.tileSize).url(
		imageServiceId(imageId)
	);
}

function referencedThumbnail(record: ReferencedImage | null): string | null {
	if (record === null) return null;
	const { width, height, tileSize } = record;
	if (width === 0 || height === 0 || tileSize === 0) return null;
	return wholeImageDerivative(width, height, tileSize).url(record.service);
}

function libraryOf(service: string): string {
	try {
		return new URL(service).host;
	} catch {
		return '';
	}
}
