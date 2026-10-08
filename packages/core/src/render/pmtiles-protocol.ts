import { addProtocol } from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let registered = false;

export function registerPmtilesProtocol(): void {
	if (registered) return;
	registered = true;
	addProtocol('pmtiles', new Protocol().tile);
}
