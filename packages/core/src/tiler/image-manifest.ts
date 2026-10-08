import type { Level0ImageInfo } from './pyramid.js';
import {
	IMAGE_SERVICE_PLACEHOLDER_ORIGIN,
	imageServiceId,
	pyramidScaleFactors
} from './pyramid.js';

type ImageManifest = {
	'@context': 'http://iiif.io/api/presentation/3/context.json';
	id: string;
	type: 'Manifest';
	label: { none: [string] };
	items: [
		{
			id: string;
			type: 'Canvas';
			width: number;
			height: number;
			items: [
				{
					id: string;
					type: 'AnnotationPage';
					items: [
						{
							id: string;
							type: 'Annotation';
							motivation: 'painting';
							target: string;
							body: {
								id: string;
								type: 'Image';
								format: 'image/jpeg';
								width: number;
								height: number;
								service: [Level0ImageInfo];
							};
						}
					];
				}
			];
		}
	];
};

export function wholeImageDerivative(
	width: number,
	height: number,
	tileSize?: number
): {
	url: (serviceId: string) => string;
	width: number;
	height: number;
} {
	const factors = pyramidScaleFactors({ width, height }, tileSize);
	const coarsest = factors[factors.length - 1]!;
	const derivedWidth = Math.ceil(width / coarsest);
	const derivedHeight = Math.ceil(height / coarsest);

	return {
		url: (serviceId) =>
			`${serviceId}/0,0,${width},${height}/${derivedWidth},${derivedHeight}/0/default.jpg`,
		width: derivedWidth,
		height: derivedHeight
	};
}

export function readImageLabel(manifest: unknown): string {
	const label = (manifest as { label?: { none?: unknown } } | null)?.label?.none;
	if (!Array.isArray(label)) return '';
	const first = label[0];
	return typeof first === 'string' ? first : '';
}

export function buildImageManifest({
	imageId,
	label,
	info
}: {
	imageId: string;
	label: string;
	info: Level0ImageInfo;
}): ImageManifest {
	const serviceId = imageServiceId(imageId);
	const base = `${IMAGE_SERVICE_PLACEHOLDER_ORIGIN}/${imageId}`;
	const canvasId = `${base}/canvas/1`;
	const derivative = wholeImageDerivative(info.width, info.height, info.tiles[0].width);

	return {
		'@context': 'http://iiif.io/api/presentation/3/context.json',
		id: `${base}/manifest.json`,
		type: 'Manifest',
		label: { none: [label] },
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
									id: derivative.url(serviceId),
									type: 'Image',
									format: 'image/jpeg',
									width: derivative.width,
									height: derivative.height,
									service: [info]
								}
							}
						]
					}
				]
			}
		]
	};
}
