import {
	PathNotFoundError,
	imageInfoPath,
	messageOf,
	parseJsonBytes,
	type ReadOnlyProjectStore
} from '@ballastella/core';

// Read structurally: the core parser would drag the tiler into the viewer.
type ServedImageInfo = {
	readonly width: number;
	readonly height: number;
	readonly tiles: readonly { readonly width: number; readonly scaleFactors: readonly number[] }[];
	readonly declaredId: string;
	readonly document: Readonly<Record<string, unknown>>;
};

const unreadable = (reason: string): Error =>
	new Error(`This Map Image’s info.json could not be read: ${reason}`);

function parseServedImageInfo(bytes: Uint8Array): ServedImageInfo {
	let raw: unknown;
	try {
		raw = parseJsonBytes(bytes);
	} catch (cause) {
		throw unreadable(messageOf(cause));
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw unreadable('it does not contain a JSON object');
	}
	const record = raw as Record<string, unknown>;
	const width = positive(record.width);
	const height = positive(record.height);
	if (width === 0 || height === 0) {
		throw unreadable('it gives no pixel dimensions for the image');
	}

	const tiles = (Array.isArray(record.tiles) ? record.tiles : []).flatMap((entry) => {
		const tile = entry as Record<string, unknown> | null;
		const tileWidth = positive(tile?.width);
		const scaleFactors = (Array.isArray(tile?.scaleFactors) ? tile.scaleFactors : []).filter(
			(factor): factor is number => positive(factor) > 0
		);
		if (tileWidth === 0 || scaleFactors.length === 0) return [];
		return [{ width: tileWidth, scaleFactors }];
	});
	if (tiles.length === 0) {
		throw unreadable('it declares no tiles, so nothing can be fetched');
	}

	return {
		width,
		height,
		tiles,
		declaredId: typeof record.id === 'string' ? record.id : '',
		document: record
	};
}

const positive = (value: unknown): number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;

function servedImageServiceId(info: ServedImageInfo): string | null {
	let url: URL;
	try {
		url = new URL(info.declaredId);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
	const placeholder = 'unset.invalid';
	if (url.hostname === placeholder || url.hostname.endsWith(`.${placeholder}`)) return null;
	return info.declaredId.replace(/\/+$/, '');
}

// Level 0 serves only declared regions, so /full/max would 404.
function wholeImage(info: ServedImageInfo): { path: string; width: number; height: number } {
	const factors = info.tiles.flatMap((tile) => [...tile.scaleFactors]);
	const coarsest = Math.max(...factors);
	const width = Math.ceil(info.width / coarsest);
	const height = Math.ceil(info.height / coarsest);
	return {
		path: `0,0,${info.width},${info.height}/${width},${height}/0/default.jpg`,
		width,
		height
	};
}

function servedImageManifest(options: {
	serviceId: string;
	label: string;
	info: ServedImageInfo;
}): unknown {
	const { serviceId, label, info } = options;
	const canvasId = `${serviceId}/canvas/1`;
	const derivative = wholeImage(info);

	return {
		'@context': 'http://iiif.io/api/presentation/3/context.json',
		id: `${serviceId}/manifest.json`,
		type: 'Manifest',
		...(label === '' ? {} : { label: { none: [label] } }),
		items: [
			{
				id: canvasId,
				type: 'Canvas',
				width: info.width,
				height: info.height,
				items: [
					{
						id: `${canvasId}/annotation-page/1`,
						type: 'AnnotationPage',
						items: [
							{
								id: `${canvasId}/annotation/1`,
								type: 'Annotation',
								motivation: 'painting',
								target: canvasId,
								body: {
									id: `${serviceId}/${derivative.path}`,
									type: 'Image',
									format: 'image/jpeg',
									width: derivative.width,
									height: derivative.height,
									// The whole info.json: {id, type, profile} alone loads zero tiles.
									service: [{ ...info.document, id: serviceId }]
								}
							}
						]
					}
				]
			}
		]
	};
}

export type UnwarpedSheet = { manifestId: string; manifest: unknown } | { error: string };

export async function loadUnwarpedSheet(
	store: ReadOnlyProjectStore,
	layer: { imageId: string; name: string }
): Promise<UnwarpedSheet> {
	if (layer.imageId === '') {
		return { error: 'This site does not record where this Map Image’s image is.' };
	}
	try {
		const info = parseServedImageInfo(await store.read(imageInfoPath(layer.imageId)));
		const serviceId = servedImageServiceId(info);
		if (serviceId === null) {
			return {
				error:
					'This Map Image cannot be opened on its own from this site yet. Its image was ' +
					'tiled without a web address, so nothing here can fetch the sheet. The scholar who ' +
					'made this site can fix it by giving Ballastella the address ' +
					'the site is at, which turns the map into a citable IIIF endpoint. It is still shown ' +
					'aligned on the map.'
			};
		}
		return {
			manifestId: `${serviceId}/manifest.json`,
			manifest: servedImageManifest({ serviceId, label: layer.name, info })
		};
	} catch (cause) {
		return {
			error:
				cause instanceof PathNotFoundError
					? 'The image behind this Map Image is not on this site, so it cannot be read as a document.'
					: messageOf(cause)
		};
	}
}
