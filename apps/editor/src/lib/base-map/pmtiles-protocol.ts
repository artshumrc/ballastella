import { addProtocol } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let registered = false;

/**
 * Register the `pmtiles://` protocol with MapLibre.
 *
 * This is what makes "everything is static files" true for the Base Map and not only for Project
 * data (ADR-0005): a whole tileset is one archive read over HTTP Range requests, so there is no
 * tile server, no API key, no tile-provider terms of service, no per-fork registration — and it
 * works offline. SPEC stories 88 and 101 both rest on this one call.
 *
 * MapLibre's protocol registry is global and a second registration for the same scheme throws, so
 * this is idempotent: panes come and go with navigation, the protocol does not.
 */
export function registerPmtilesProtocol(): void {
	if (registered) return;
	registered = true;
	addProtocol('pmtiles', new Protocol().tile);
}
