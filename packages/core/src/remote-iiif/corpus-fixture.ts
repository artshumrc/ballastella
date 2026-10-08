import { readFileSync } from 'node:fs';

import { acceptRemoteImageService, type RemoteImageService } from './image-service.js';

type CapturedService = {
	name: string;
	fetchedFrom: string;
	info: { width?: number; height?: number; id?: string; '@id'?: string; tiles?: unknown };
};

export const corpus = JSON.parse(
	readFileSync(new URL('fixtures/real-world-image-services.json', import.meta.url), 'utf8')
) as { services: CapturedService[] };

export function captured(name: string): CapturedService {
	const found = corpus.services.find((entry) => entry.name === name);
	if (!found) throw new Error(`No captured service called “${name}”.`);
	return found;
}

export const acceptCaptured = (name: string): Promise<RemoteImageService> => {
	const { info, fetchedFrom } = captured(name);
	return acceptRemoteImageService(info, {
		requestedUrl: fetchedFrom,
		fallbackUri: fetchedFrom.replace(/\/info\.json$/, '')
	});
};
