import { addProtocol } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let registered = false;

/**
 * Register the `pmtiles://` protocol with MapLibre.
 *
 * This is what makes "everything is static files" true for the Base Map and not only for Project
 * data (ADR-0005): a whole tileset is one archive read over HTTP Range requests, so there is no
 * tile server, no API key, no tile-provider terms of service, no per-fork registration — and it
 * works offline.
 *
 * MapLibre's protocol registry is page-global, but `addProtocol` does not throw on a second
 * registration — in maplibre-gl 5 it is a plain assignment into `config.REGISTERED_PROTOCOLS`, so
 * re-registering silently replaces the handler. This is idempotent anyway, because panes come and
 * go with navigation and the protocol does not. Note the flag is module state while the registry
 * is page state: after a Vite HMR reload of this module the flag resets while the registration
 * survives, which is harmless here precisely because the second call is not an error.
 */
export function registerPmtilesProtocol(): void {
	if (registered) return;
	registered = true;
	addProtocol('pmtiles', new Protocol().tile);
}
