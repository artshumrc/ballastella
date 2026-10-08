import type { BaseMapCatalog } from './entry';

const REMOTE_ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';
const TERRAIN_DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

const IMAGERY_TILES =
	'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg';

const US_IMAGERY_TILES =
	'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&f=image&mosaicRule=%7B%22mosaicMethod%22%3A%22esriMosaicAttribute%22%2C%22sortField%22%3A%22Year%22%2C%22sortValue%22%3A%223000%22%2C%22where%22%3A%22Year%3C%3D2023%22%7D';

export const BASE_MAP_CATALOG: BaseMapCatalog = {
	entries: [
		{
			id: 'planet',
			label: 'Worldwide',
			needsNetwork: true,
			archive: REMOTE_ARCHIVE
		}
	],
	defaultId: 'planet',
	initialView: { center: [0, 20], zoom: 1 },
	glyphs: 'base-map/fonts/{fontstack}/{range}.pbf',
	terrain: {
		tiles: TERRAIN_DEM,
		encoding: 'terrarium',
		maxZoom: 15,
		attribution:
			'<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noreferrer">' +
			'Terrain Tiles</a>'
	},
	imagery: {
		tiles: IMAGERY_TILES,
		maxZoom: 14,
		tileSize: 256,
		attribution:
			'<a href="https://s2maps.eu" target="_blank" rel="noreferrer">Sentinel-2 cloudless</a> by ' +
			'<a href="https://eox.at" target="_blank" rel="noreferrer">EOX IT Services GmbH</a> ' +
			'(<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)'
	},
	regionalImagery: [
		{
			tiles: US_IMAGERY_TILES,
			bounds: [-125, 24, -66, 50],
			minZoom: 13,
			maxZoom: 18,
			tileSize: 256,
			attribution:
				'<a href="https://www.usgs.gov/programs/national-geospatial-program/national-map" target="_blank" rel="noreferrer">USGS The National Map</a>: USDA NAIP'
		}
	],
	sprite: 'base-map/sprites/{flavor}',
	attribution:
		'<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · ' +
		'<a href="https://protomaps.com" target="_blank" rel="noreferrer">Protomaps</a>'
};
