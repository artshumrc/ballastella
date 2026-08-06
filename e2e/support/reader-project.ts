// One Project as a Published Site carries it: a `project.json`, an Alignment, an Annotation Layer, and
// a level-0 pyramid.
//
// The Alignment is a **real** IIIF Georeference Annotation — the exact bytes `serialiseAlignment`
// writes for four Control Points over a 700 × 500 image — so `@allmaps/maplibre` solves and draws it
// rather than refusing. Four points over an affine transformation is more than the minimum, which is
// what makes "this Layer is drawn" a fact about the renderer and not about a shortfall message.
//
// The pyramid is one 256 px tile at each scale factor the `info.json` declares, with real JPEG bytes:
// a tile that will not decode is the failure ticket 06 spent a patch on, and `@allmaps/render` logs and
// swallows it — so a string standing in for a tile leaves a blank map and a green test.

import { asJson, tileJpeg, type SiteFiles } from './published-site.js';

export const IMAGE_ID = 'aaa';
export const IMAGE_WIDTH = 700;
export const IMAGE_HEIGHT = 500;

/** The Layer ids the tests address Layers by. */
export const MAP_LAYER_ID = 'l-map';
export const ANNOTATION_LAYER_ID = 'l-notes';

/** A Georeference Annotation over the fixture image, as `serialiseAlignment` writes one. */
export const alignmentJson = (): string =>
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
				gcp([70, 50], [4.88, 52.375]),
				gcp([630, 50], [4.92, 52.375]),
				gcp([630, 450], [4.92, 52.36]),
				gcp([70, 450], [4.88, 52.36])
			]
		}
	});

const gcp = (resourceCoords: [number, number], coordinates: [number, number]) => ({
	type: 'Feature',
	properties: { resourceCoords },
	geometry: { type: 'Point', coordinates }
});

/**
 * The `info.json` a locally ingested pyramid ships with (ADR-0003, ADR-0004).
 *
 * `serviceId` is what the document declares its own `id` to be, and it is the **only** thing that decides
 * where a tiling viewer fetches this pyramid's tiles from — see
 * `apps/viewer/src/lib/unwarped-manifest.ts`. Unstamped it is the ADR-0004 placeholder; a Project the
 * author published with an address has it rewritten by `stampCanonicalUrl` (SPEC story 92), which is the
 * case story 85 needs and the reason this is a parameter.
 */
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

/**
 * Every tile of a 700 × 500 level-0 pyramid at a 256 px tile size, as `planPyramid` lays them out.
 *
 * Generated rather than reasoned about: the IIIF region/size syntax for a ragged edge cell is
 * `@allmaps/iiif-parser`'s to decide, and a path this fixture guessed wrong is a 404 the renderer
 * swallows.
 */
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

/** One Annotation, with whatever `title` and `description` a test wants to put on this surface. */
export const annotation = (fields: {
	id?: string;
	title?: string;
	description?: string;
	coordinates?: [number, number];
}) => ({
	type: 'Feature',
	// A UUID-shaped id, because `parseAnnotations` mints one otherwise and the test could not address it.
	id: fields.id ?? '11111111-1111-4111-8111-111111111111',
	geometry: { type: 'Point', coordinates: fields.coordinates ?? [4.9, 52.3676] },
	properties: {
		...(fields.title === undefined ? {} : { title: fields.title }),
		...(fields.description === undefined ? {} : { description: fields.description }),
		// A large marker, so a click within a few pixels of the centre of the map lands on it.
		'marker-size': 'large',
		'marker-color': '#cc0000'
	}
});

export type ProjectFixture = {
	directory?: string;
	name?: string;
	/** The Annotations in the Annotation Layer. */
	annotations?: unknown[];
	/** `'referenced'` puts the Historical Map on somebody else's server (ADR-0007). */
	imageMode?: 'mirrored' | 'referenced';
	/** The remote service a `'referenced'` image claims, or `undefined` to write no `remote.json`. */
	remoteService?: string;
	/** The author's default Base Map, by id. */
	baseMap?: string | null;
	/** Overrides merged into `project.json` — `formatVersion`, for the ADR-0010 refusal. */
	projectOverrides?: Record<string, unknown>;
	/** Leave the pyramid out, so the unwarped view has nothing to read. */
	withoutPyramid?: boolean;
	/**
	 * The address the pyramid's `info.json` declares as its own image service `id`.
	 *
	 * Absent leaves the ADR-0004 placeholder, which is an unstamped Project. Supplying the site's own
	 * address is what `stampCanonicalUrl` writes when an author publishes with one (SPEC story 92), and it
	 * is the only shape in which a tiling viewer can read the sheet — so a test that wants the unwarped
	 * view to *work* has to say where the site is.
	 */
	canonicalImageServiceId?: string;
};

/**
 * The files of one Project, Workspace-relative.
 *
 * The Annotation Layer is **above** the map Layer in the stack (`order` 0 versus 1), which is ADR-0002's
 * cross-kind rule the tests assert on: an Annotation Layer above a map Layer draws above it.
 */
export function projectFiles(fixture: ProjectFixture = {}): SiteFiles {
	const directory = fixture.directory ?? 'amsterdam-1625';
	const imageMode = fixture.imageMode ?? 'mirrored';
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
					alignmentRef: `alignments/${IMAGE_ID}.json`,
					imageMode
				}
			],
			baseMap: fixture.baseMap === undefined ? null : fixture.baseMap,
			...(fixture.projectOverrides ?? {})
		}),
		[`${directory}/alignments/${IMAGE_ID}.json`]: alignmentJson(),
		[`${directory}/annotations/${ANNOTATION_LAYER_ID}.geojson`]: asJson({
			type: 'FeatureCollection',
			features: fixture.annotations ?? [annotation({ title: 'A warehouse' })]
		})
	};

	if (!fixture.withoutPyramid) {
		files[`${directory}/images/${IMAGE_ID}/info.json`] = infoJson(fixture.canonicalImageServiceId);
		files[`${directory}/images/${IMAGE_ID}/manifest.json`] = asJson({
			'@context': 'http://iiif.io/api/presentation/3/context.json',
			id: `https://unset.invalid/${IMAGE_ID}/manifest.json`,
			type: 'Manifest',
			label: { none: ['blaeu-1625.png'] },
			items: []
		});
		// **Every** tile the pyramid declares, and the paths are not hand-derived: they are what
		// `planPyramid` produces for a 700 × 500 image at a 256 px tile size, which is what
		// `@allmaps/iiif-parser` will ask for. A partial set would leave the renderer's cache empty and
		// make "the Historical Map carried bytes" unassertable — the exact blank-map failure ticket 06
		// spent a patch on. Regenerate by printing `planPyramid(buildImageInfo(…), 'x')` if the tile size
		// or the fixture dimensions ever change.
		const jpeg = tileJpeg();
		for (const cell of PYRAMID_TILES) {
			files[`${directory}/images/${IMAGE_ID}/${cell}`] = jpeg;
		}
	}

	if (imageMode === 'referenced' && fixture.remoteService !== undefined) {
		files[`${directory}/images/${IMAGE_ID}/remote.json`] = asJson({
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
