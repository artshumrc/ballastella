import type { Alignment } from '../alignment/alignment.js';
import { toRendererDocument, type AlignmentAddress } from '../alignment/georeference-annotation.js';
import type { ImagePaneTileBase } from '../image-pane/iiif-image-pane.js';
import { imageDirectory, imageInfoPath, IMAGE_DIRECTORY } from '../project/image-files.js';
import {
	asRecord,
	messageOf,
	parseJsonBytes,
	serialiseJson,
	textField,
	type Bytes,
	type StorePath
} from '../store/project-store.js';
import { imageServiceId } from '../tiler/pyramid.js';
import { canonicalServiceUri } from './service-uri.js';

export type MapImageSource =
	| { readonly imageMode: 'offline-copy'; readonly imageId: string }
	| {
			readonly imageMode: 'referenced';
			readonly imageId: string;
			readonly service: string;
	  };

export type ImagePaneSource = {
	readonly tiles: ImagePaneTileBase;
	readonly infoUrl: string;
};

export function imagePaneSourceFor(source: MapImageSource): ImagePaneSource {
	if (source.imageMode !== 'referenced') {
		return {
			tiles: { storedImageId: source.imageId },
			infoUrl: `${imageServiceId(source.imageId)}/info.json`
		};
	}
	const base = canonicalServiceUri(source.service);
	return { tiles: base, infoUrl: `${base}/info.json` };
}

export const REFERENCED_IMAGE_FILE = 'remote.json';

export const referencedImagePath = (imageId: string): StorePath =>
	`${imageDirectory(imageId)}/${REFERENCED_IMAGE_FILE}`;

export const imageDescriptionPaths = (imageId: string): readonly StorePath[] => [
	imageInfoPath(imageId),
	referencedImagePath(imageId)
];

export type ReferencedImage = {
	readonly imageId: string;
	readonly service: string;
	readonly source: string;
	readonly label: string;
	readonly partOf: string;
	readonly canvas: string;
	readonly rights: string;
	readonly attribution: string;
	readonly width: number;
	readonly height: number;
	readonly tileSize: number;
};

type ReferencedImageFields = Omit<
	ReferencedImage,
	'source' | 'label' | 'partOf' | 'canvas' | 'rights' | 'attribution'
> &
	Partial<
		Pick<ReferencedImage, 'source' | 'label' | 'partOf' | 'canvas' | 'rights' | 'attribution'>
	>;

export const referencedImage = (fields: ReferencedImageFields): ReferencedImage => ({
	imageId: fields.imageId,
	service: canonicalServiceUri(fields.service),
	source: fields.source || fields.partOf || fields.service,
	label: fields.label ?? '',
	partOf: fields.partOf ?? '',
	canvas: fields.canvas ?? '',
	rights: fields.rights ?? '',
	attribution: fields.attribution ?? '',
	width: fields.width,
	height: fields.height,
	tileSize: fields.tileSize
});

export const serialiseReferencedImage = (image: ReferencedImage): Bytes =>
	serialiseJson({
		service: image.service,
		source: image.source,
		label: image.label,
		partOf: image.partOf,
		canvas: image.canvas,
		rights: image.rights,
		attribution: image.attribution,
		width: image.width,
		height: image.height,
		tileSize: image.tileSize
	});

export class ReferencedImageUnreadableError extends Error {
	override readonly name = 'ReferencedImageUnreadableError';

	constructor(imageId: string, reason: string) {
		super(
			`The record of where “${imageId}” is served from could not be read: ${reason}. This ` +
				`Map Image is referenced rather than copied into this Project, so without it there ` +
				`is nowhere to fetch its tiles from.`
		);
	}
}

export function parseReferencedImage(
	bytes: Uint8Array,
	options: { imageId: string }
): ReferencedImage {
	const { imageId } = options;

	let raw: unknown;
	try {
		raw = parseJsonBytes(bytes);
	} catch (cause) {
		throw new ReferencedImageUnreadableError(imageId, messageOf(cause));
	}

	const record = asRecord(raw) ?? {};
	const service = typeof record['service'] === 'string' ? record['service'].trim() : '';
	let parsed: URL;
	try {
		parsed = new URL(service);
	} catch {
		throw new ReferencedImageUnreadableError(
			imageId,
			service === '' ? 'it names no image service' : `“${service}” is not an absolute web address`
		);
	}

	if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
		throw new ReferencedImageUnreadableError(
			imageId,
			`its image service is ${parsed.protocol.replace(':', '')}:, and only http and https can be fetched`
		);
	}

	return referencedImage({
		imageId,
		service,
		source: textField(record['source']),
		label: textField(record['label']),
		partOf: textField(record['partOf']),
		canvas: textField(record['canvas']),
		rights: textField(record['rights']),
		attribution: textField(record['attribution']),
		width: positiveInteger(record['width']),
		height: positiveInteger(record['height']),
		tileSize: positiveInteger(record['tileSize'])
	});
}

export async function listReferencedImages(store: {
	list(prefix: string): Promise<readonly string[]> | readonly string[];
	read(path: string): Promise<Uint8Array>;
}): Promise<{ images: ReferencedImage[]; unreadable: { imageId: string; reason: string }[] }> {
	const prefix = `${IMAGE_DIRECTORY}/`;
	const paths = await store.list(prefix);
	const images: ReferencedImage[] = [];
	const unreadable: { imageId: string; reason: string }[] = [];

	for (const path of paths) {
		if (!path.endsWith(`/${REFERENCED_IMAGE_FILE}`)) continue;
		const imageId = path.slice(prefix.length, -`/${REFERENCED_IMAGE_FILE}`.length);
		if (imageId === '' || imageId.includes('/')) continue;
		try {
			images.push(parseReferencedImage(await store.read(path), { imageId }));
		} catch (cause) {
			unreadable.push({ imageId, reason: messageOf(cause) });
		}
	}

	return { images, unreadable };
}

export const sourceOf = (image: ReferencedImage): MapImageSource => ({
	imageMode: 'referenced',
	imageId: image.imageId,
	service: image.service
});

export const referencedRendererDocument = (alignment: Alignment, service: string): unknown =>
	toRendererDocument(alignment, { imageService: canonicalServiceUri(service) });

export const referencedAlignmentAddress = (service: string): AlignmentAddress => ({
	imageService: canonicalServiceUri(service)
});

const positiveInteger = (value: unknown): number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
