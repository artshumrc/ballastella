// The IIIF Presentation manifest that goes beside a generated pyramid.
//
// Why an ingested photograph gets a manifest at all: it is what makes the Project directory
// readable by something that is not this app (ADR-0002, ADR-0006). `info.json` describes an
// image service; a Manifest is the document a IIIF viewer, an Allmaps Georeference Annotation,
// or a library's own tooling points at. A local scan that only ever had an `info.json` would be
// a second-class Historical Map the moment it left this app, which is precisely what SPEC story
// 21 says it must not be.
//
// Its `id`s carry the same `https://unset.invalid/` placeholder as `info.json` and for the same
// reason (ADR-0004): there is no URL at authoring time, publishing resolves one, and a
// placeholder that always fails DNS is better than one that quietly resolves to somewhere else.

import type { Level0ImageInfo } from './pyramid.js';
import {
	IMAGE_SERVICE_PLACEHOLDER_ORIGIN,
	imageServiceId,
	pyramidScaleFactors
} from './pyramid.js';

/** A single-canvas IIIF Presentation 3.0 Manifest wrapping one level-0 image service. */
export type ImageManifest = {
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

/**
 * The largest whole-image derivative a level-0 pyramid actually has: the single tile at the
 * coarsest scale factor.
 *
 * A Presentation manifest's painting body needs a fetchable `id`, and the obvious choice —
 * `/full/max/0/default.jpg` — does not exist here. A level-0 service serves only the regions
 * and sizes its `info.json` declares, and the whole image at full resolution is not one of
 * them. Naming a URL that 404s would make the manifest worse than useless: a viewer that
 * cannot tile would show a broken image rather than nothing.
 */
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

/**
 * What the user calls this Historical Map, out of its `manifest.json`, or `''` when the document does
 * not say.
 *
 * The manifest's label is the **only** record of the file the user picked: an image id is a random
 * identifier (ADR-0015), so a Layer named from the id alone would be named after a hash. Read from
 * here rather than kept a second time in `project.json`, because two records of the same fact are two
 * records that can disagree — and a Layer's `name` is the user's to change from this starting point
 * (SPEC story 54), after which the manifest is no longer the authority on it.
 */
export function readImageLabel(manifest: unknown): string {
	const label = (manifest as { label?: { none?: unknown } } | null)?.label?.none;
	if (!Array.isArray(label)) return '';
	const first = label[0];
	return typeof first === 'string' ? first : '';
}

/** The `manifest.json` for a locally ingested image. */
export function buildImageManifest({
	imageId,
	label,
	info
}: {
	imageId: string;
	/** What the user will see this Historical Map called. Usually the file they picked. */
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
		// `none` rather than a language tag, because the label is a filename the user chose and
		// claiming it is English would be a guess written into a portable document.
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
