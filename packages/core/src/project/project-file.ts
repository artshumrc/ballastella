import {
	DEFAULT_BASE_MAP_APPEARANCE,
	isDefaultAppearance,
	PROJECT_BASE_MAP_APPEARANCE_KEY,
	type BaseMapAppearance
} from '../base-map/appearance.js';
import {
	DEFAULT_BASE_MAP_BORDER_STYLE,
	DEFAULT_BASE_MAP_BORDERS,
	isDefaultBorderStyle,
	PROJECT_BORDER_STYLE_KEY,
	PROJECT_BORDERS_KEY,
	readBaseMapBorderStyle,
	readBaseMapBorders,
	type BaseMapBorders,
	type BaseMapBorderStyle
} from '../base-map/borders.js';
import { PROJECT_BASE_MAP_KEY, readBaseMapChoice } from '../base-map/project.js';
import {
	parseJsonBytes,
	parseJsonObject,
	serialiseJson,
	textField,
	type Bytes
} from '../store/project-store.js';
import {
	IMPORT_PROVENANCE_KEY,
	parseImportProvenance,
	serialiseImportProvenance,
	type ImportProvenanceEntry
} from './import-provenance.js';
import { parseLayers, serialiseLayers, type Layer } from './layer.js';

export const CURRENT_FORMAT_VERSION = 1;
const BALLASTELLA_CANONICAL_URL = 'https://artshumrc.github.io/ballastella/';
export const PROJECT_FILE_NAME = 'project.json';
export const projectFilePath = (directory: string): string => `${directory}/${PROJECT_FILE_NAME}`;

export const isProjectManifest = (path: string): boolean => {
	const segments = path.split('/');
	return segments.length === 2 && segments[1] === PROJECT_FILE_NAME;
};

const DESCRIPTION_KEY = 'description';

export interface ProjectFile {
	readonly formatVersion: number;
	readonly name: string;
	readonly description: string;
	readonly updatedAt: string;
	readonly layers: readonly Layer[];
	readonly baseMap: string | null;
	readonly baseMapAppearance: BaseMapAppearance;
	readonly borders: BaseMapBorders;
	readonly borderStyle: BaseMapBorderStyle;
	readonly canonicalUrl: string | null;
	readonly onFrontPage: boolean;
	readonly importProvenance?: readonly ImportProvenanceEntry[];
	readonly unknownFields: Readonly<Record<string, unknown>>;
}

export class ProjectFormatTooNewError extends Error {
	override readonly name = 'ProjectFormatTooNewError';
	readonly supportedFormatVersion = CURRENT_FORMAT_VERSION;

	constructor(
		readonly formatVersion: number,
		appUrl: string = BALLASTELLA_CANONICAL_URL,
		closing: string = 'It has been left untouched.'
	) {
		super(
			`This Project was made with a newer version of Ballastella ` +
				`(format ${formatVersion}; this copy understands ${CURRENT_FORMAT_VERSION}). ` +
				`Open it at ${appUrl}, or update your copy. ` +
				closing
		);
	}
}

export class ProjectFileUnreadableError extends Error {
	override readonly name = 'ProjectFileUnreadableError';
	constructor(reason: string) {
		super(`This Project's ${PROJECT_FILE_NAME} could not be read: ${reason}`);
	}
}

export function readOnFrontPage(bytes: Uint8Array): boolean {
	try {
		return (parseJsonBytes(bytes) as { onFrontPage?: unknown } | null)?.onFrontPage === true;
	} catch {
		return false;
	}
}

// `closing` is the too-new refusal's last sentence: what the caller has not done.
export function parseProjectFile(bytes: Uint8Array, closing?: string): ProjectFile {
	const raw = parseJsonObject(bytes, (reason) => new ProjectFileUnreadableError(reason));
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
	} = raw;
	for (const key of [
		PROJECT_BASE_MAP_KEY,
		PROJECT_BORDERS_KEY,
		PROJECT_BORDER_STYLE_KEY,
		PROJECT_BASE_MAP_APPEARANCE_KEY,
		'removedMapLayers'
	]) {
		delete unknownFields[key];
	}
	if (importProvenance !== undefined && !Array.isArray(importProvenance)) {
		unknownFields[IMPORT_PROVENANCE_KEY] = importProvenance;
	}
	if (description !== undefined && typeof description !== 'string') {
		unknownFields[DESCRIPTION_KEY] = description;
	}

	const provenance = parseImportProvenance(importProvenance);
	const baseMapChoice = readBaseMapChoice(raw);

	if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion)) {
		throw new ProjectFileUnreadableError('formatVersion is missing or is not an integer');
	}
	if (formatVersion > CURRENT_FORMAT_VERSION) {
		throw new ProjectFormatTooNewError(formatVersion, BALLASTELLA_CANONICAL_URL, closing);
	}

	return {
		formatVersion,
		name: textField(name),
		description: textField(description),
		updatedAt: textField(updatedAt),
		layers: parseLayers(layers),
		baseMap: baseMapChoice.id,
		baseMapAppearance: baseMapChoice.appearance,
		borders: readBaseMapBorders(raw),
		borderStyle: readBaseMapBorderStyle(raw),
		canonicalUrl:
			typeof canonicalUrl === 'string' && canonicalUrl.trim() !== '' ? canonicalUrl : null,
		onFrontPage: onFrontPage === true,
		...(provenance.length === 0 ? {} : { importProvenance: provenance }),
		unknownFields
	};
}

export function serialiseProjectFile(file: ProjectFile): Bytes {
	const {
		unknownFields,
		formatVersion,
		name,
		description,
		updatedAt,
		layers,
		baseMap,
		baseMapAppearance,
		borders,
		borderStyle,
		canonicalUrl,
		onFrontPage,
		importProvenance
	} = file;
	const history =
		importProvenance === undefined || importProvenance.length === 0 ? null : importProvenance;
	const shadowed = new Set(
		[history === null ? null : IMPORT_PROVENANCE_KEY, description === '' ? null : DESCRIPTION_KEY]
			.filter((key) => key !== null)
			.filter((key) => key in unknownFields)
	);
	const carried =
		shadowed.size === 0
			? unknownFields
			: Object.fromEntries(Object.entries(unknownFields).filter(([key]) => !shadowed.has(key)));
	return serialiseJson({
		formatVersion,
		name,
		...(description === '' ? {} : { description }),
		updatedAt,
		layers: serialiseLayers(layers),
		baseMap,
		...(isDefaultAppearance(baseMapAppearance)
			? {}
			: { [PROJECT_BASE_MAP_APPEARANCE_KEY]: { ...baseMapAppearance } }),
		...(borders === DEFAULT_BASE_MAP_BORDERS ? {} : { [PROJECT_BORDERS_KEY]: borders }),
		...(isDefaultBorderStyle(borderStyle)
			? {}
			: {
					[PROJECT_BORDER_STYLE_KEY]: {
						...(borderStyle.color === null ? {} : { color: borderStyle.color }),
						...(borderStyle.lineStyle === null ? {} : { lineStyle: borderStyle.lineStyle }),
						...(borderStyle.width === null ? {} : { width: borderStyle.width })
					}
				}),
		...(canonicalUrl === null ? {} : { canonicalUrl }),
		...(onFrontPage ? { onFrontPage: true } : {}),
		...(history === null ? {} : { [IMPORT_PROVENANCE_KEY]: serialiseImportProvenance(history) }),
		...carried
	});
}

export function newProjectFile(name: string, updatedAt: Date, description = ''): ProjectFile {
	return {
		formatVersion: CURRENT_FORMAT_VERSION,
		name,
		description,
		updatedAt: updatedAt.toISOString(),
		layers: [],
		baseMap: null,
		baseMapAppearance: DEFAULT_BASE_MAP_APPEARANCE,
		borders: DEFAULT_BASE_MAP_BORDERS,
		borderStyle: DEFAULT_BASE_MAP_BORDER_STYLE,
		canonicalUrl: null,
		onFrontPage: false,
		unknownFields: {}
	};
}
