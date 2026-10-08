export type BaseMapFlavorName = 'light' | 'dark' | 'grayscale' | 'white' | 'black';

export type BaseMapTerrain = {
	readonly tiles: string;
	readonly encoding: 'terrarium' | 'mapbox';
	readonly maxZoom: number;
	readonly attribution: string;
};

export type BaseMapImagery = {
	readonly tiles: string;
	readonly maxZoom: number;
	// MapLibre assumes 512 for a raster source; a wrong size draws the picture at the wrong scale.
	readonly tileSize: number;
	readonly attribution: string;
};

// Tiles must be transparent outside `bounds`: the worldwide imagery beneath shows through.
export type BaseMapRegionalImagery = BaseMapImagery & {
	readonly bounds: readonly [number, number, number, number];
	readonly minZoom: number;
};

export type BaseMapEntry = {
	readonly id: string;
	readonly label: string;
	readonly needsNetwork: boolean;
	/** A deployment-relative path for a bundled archive, or an absolute URL for a remote one. */
	readonly archive: string;
};

export type BaseMapCatalog = {
	readonly entries: readonly BaseMapEntry[];
	readonly defaultId: string;
	readonly initialView: {
		readonly center: readonly [lng: number, lat: number];
		readonly zoom: number;
	};
	readonly glyphs: string;
	readonly sprite: string;
	readonly terrain?: BaseMapTerrain;
	readonly imagery?: BaseMapImagery;
	readonly regionalImagery?: readonly BaseMapRegionalImagery[];
	readonly attribution: string;
};
