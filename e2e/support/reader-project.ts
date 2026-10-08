import { asJson, tileJpeg, type SiteFiles } from './published-site.js';

export const IMAGE_ID = 'aaa';
const IMAGE_WIDTH = 700;
const IMAGE_HEIGHT = 500;
export const MAP_LAYER_ID = 'l-map';
export const ANNOTATION_LAYER_ID = 'l-notes';

export type SheetBox = { west: number; east: number; south: number; north: number };

const AMSTERDAM_SHEET: SheetBox = { west: 4.88, east: 4.92, south: 52.36, north: 52.375 };

const alignmentJson = (at: SheetBox = AMSTERDAM_SHEET): string =>
	asJson({
		type: 'Annotation',
		'@context': [
			'http://iiif.io/api/extension/georef/1/context.json',
			'http://iiif.io/api/presentation/3/context.json'
		],
		motivation: 'georeferencing',
		target: {
			type: 'SpecificResource',
			source: {
				id: `https://unset.invalid/${IMAGE_ID}`,
				type: 'ImageService3',
				height: IMAGE_HEIGHT,
				width: IMAGE_WIDTH
			},
			selector: {
				type: 'SvgSelector',
				value:
					`<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}">` +
					`<polygon points="0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}" />` +
					`</svg>`
			}
		},
		body: {
			type: 'FeatureCollection',
			transformation: { type: 'polynomial', options: { order: 1 } },
			features: [
				gcp([70, 50], [at.west, at.north]),
				gcp([630, 50], [at.east, at.north]),
				gcp([630, 450], [at.east, at.south]),
				gcp([70, 450], [at.west, at.south])
			]
		}
	});

const gcp = (resourceCoords: [number, number], coordinates: [number, number]) => ({
	type: 'Feature',
	properties: { resourceCoords },
	geometry: { type: 'Point', coordinates }
});

export const infoJson = (serviceId = `https://unset.invalid/${IMAGE_ID}`): string =>
	asJson({
		'@context': 'http://iiif.io/api/image/3/context.json',
		id: serviceId,
		type: 'ImageService3',
		protocol: 'http://iiif.io/api/image',
		profile: 'level0',
		width: IMAGE_WIDTH,
		height: IMAGE_HEIGHT,
		tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
	});

const PYRAMID_TILES: readonly string[] = [
	'0,0,256,256/256,256/0/default.jpg',
	'256,0,256,256/256,256/0/default.jpg',
	'512,0,188,256/188,256/0/default.jpg',
	'0,256,256,244/256,244/0/default.jpg',
	'256,256,256,244/256,244/0/default.jpg',
	'512,256,188,244/188,244/0/default.jpg',
	'0,0,512,500/256,250/0/default.jpg',
	'512,0,188,500/94,250/0/default.jpg',
	`0,0,${IMAGE_WIDTH},${IMAGE_HEIGHT}/175,125/0/default.jpg`
];

export const annotation = (fields: {
	id?: string;
	title?: string;
	description?: string;
	coordinates?: [number, number];
}) => ({
	type: 'Feature',
	id: fields.id ?? '11111111-1111-4111-8111-111111111111',
	geometry: { type: 'Point', coordinates: fields.coordinates ?? [4.9, 52.3676] },
	properties: {
		...(fields.title === undefined ? {} : { title: fields.title }),
		...(fields.description === undefined ? {} : { description: fields.description }),
		'marker-size': 'large',
		'marker-color': '#cc0000'
	}
});

export type ProjectFixture = {
	directory?: string;
	name?: string;
	annotations?: unknown[];
	imageMode?: 'offline-copy' | 'referenced';
	remoteService?: string;
	baseMap?: string | null;
	projectOverrides?: Record<string, unknown>;
	withoutPyramid?: boolean;
	sheetAt?: SheetBox;
	canonicalImageServiceId?: string;
};

export function projectFiles(fixture: ProjectFixture = {}): SiteFiles {
	const directory = fixture.directory ?? 'amsterdam-1625';
	const imageMode = fixture.imageMode ?? 'offline-copy';
	const files: SiteFiles = {
		[`${directory}/project.json`]: asJson({
			formatVersion: 1,
			name: fixture.name ?? 'Amsterdam 1625',
			updatedAt: '2026-01-02T03:04:05.000Z',
			layers: [
				{
					kind: 'annotation',
					id: ANNOTATION_LAYER_ID,
					name: 'Warehouses',
					visible: true,
					order: 0,
					geojsonRef: `annotations/${ANNOTATION_LAYER_ID}.geojson`,
					defaultStyle: {}
				},
				{
					kind: 'map',
					id: MAP_LAYER_ID,
					name: 'Blaeu’s plan of 1625',
					visible: true,
					order: 1,
					opacity: 0.8,
					imageId: IMAGE_ID
				}
			],
			baseMap: fixture.baseMap === undefined ? null : fixture.baseMap,
			...(fixture.projectOverrides ?? {})
		}),
		[`alignments/${IMAGE_ID}.json`]: alignmentJson(fixture.sheetAt),
		[`${directory}/annotations/${ANNOTATION_LAYER_ID}.geojson`]: asJson({
			type: 'FeatureCollection',
			features: fixture.annotations ?? [annotation({ title: 'A warehouse' })]
		})
	};

	if (!fixture.withoutPyramid && imageMode !== 'referenced') {
		files[`images/${IMAGE_ID}/info.json`] = infoJson(fixture.canonicalImageServiceId);
		files[`images/${IMAGE_ID}/manifest.json`] = asJson({
			'@context': 'http://iiif.io/api/presentation/3/context.json',
			id: `https://unset.invalid/${IMAGE_ID}/manifest.json`,
			type: 'Manifest',
			label: { none: ['blaeu-1625.png'] },
			items: []
		});
		const jpeg = tileJpeg();
		for (const cell of PYRAMID_TILES) {
			files[`images/${IMAGE_ID}/${cell}`] = jpeg;
		}
	}

	if (imageMode === 'referenced' && fixture.remoteService !== undefined) {
		files[`images/${IMAGE_ID}/remote.json`] = asJson({
			service: fixture.remoteService,
			label: 'Blaeu’s plan, from the library',
			partOf: '',
			canvas: '',
			rights: '',
			attribution: '',
			width: IMAGE_WIDTH,
			height: IMAGE_HEIGHT
		});
	}

	return files;
}
