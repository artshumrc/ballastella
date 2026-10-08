import type { FetchFn } from '../injection/store-image-fetch.js';
import {
	PathNotFoundError,
	assertStorePath,
	messageOf,
	type Bytes,
	type ReadOnlyProjectStore,
	type StorePath
} from './project-store.js';

export class SiteFileUnreachableError extends Error {
	override readonly name = 'SiteFileUnreachableError';
	readonly host: string;

	constructor(
		readonly path: StorePath,
		url: string,
		readonly status: number,
		detail: string
	) {
		const host = hostOf(url);
		const where = host === '' ? 'this site' : host;
		super(
			status === 0
				? `${where} could not be reached, so ${path} could not be read: ${detail}`
				: `${where} answered ${status} for ${path}, so it could not be read.`
		);
		this.host = host;
	}
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return '';
	}
};

export function createHttpProjectStore({
	resolve,
	fetch: request = (input, init) => fetch(input, init)
}: {
	readonly resolve: (path: StorePath) => string;
	readonly fetch?: FetchFn;
}): ReadOnlyProjectStore {
	return {
		async read(path: StorePath): Promise<Bytes> {
			const wanted = assertStorePath(path);
			const url = resolve(wanted);
			let response: Response;
			try {
				response = await request(url, { cache: 'no-cache' });
			} catch (cause) {
				throw new SiteFileUnreachableError(wanted, url, 0, messageOf(cause));
			}
			if (response.status === 404 || response.status === 410) throw new PathNotFoundError(wanted);
			if (!response.ok) throw new SiteFileUnreachableError(wanted, url, response.status, '');
			return new Uint8Array(await response.arrayBuffer());
		}
	};
}
