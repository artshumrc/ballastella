import type { PlaceService } from './place';

const SERVICE_ORIGIN = 'https://nominatim.openstreetmap.org';
const CANDIDATE_LIMIT = 10;

export const PLACE_SERVICE: PlaceService = {
	searchUrl: (query) =>
		`${SERVICE_ORIGIN}/search?q=${encodeURIComponent(query)}&format=jsonv2&limit=${CANDIDATE_LIMIT}`,
	attribution: {
		text: '© OpenStreetMap contributors',
		href: 'https://openstreetmap.org/copyright'
	}
};
