import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from './test.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = path.join(repoRoot, 'e2e/fixtures/places/springfield.json');
export const AMBIGUOUS_QUERY = 'Springfield';
const isPlaceLookup = (url: URL): boolean => url.pathname.endsWith('/search');

async function placeFixture(): Promise<string> {
	return readFile(fixture, 'utf8');
}

export async function candidateAt(point: {
	readonly lng: number;
	readonly lat: number;
}): Promise<string> {
	const [first] = JSON.parse(await placeFixture()) as Record<string, unknown>[];
	return JSON.stringify([
		{
			...first,
			lat: String(point.lat),
			lon: String(point.lng),
			boundingbox: [
				String(point.lat - 0.01),
				String(point.lat + 0.01),
				String(point.lng - 0.01),
				String(point.lng + 0.01)
			]
		}
	]);
}

type PlaceLookupService = {
	count(): number;
	queries(): string[];
	answerWith(body: string, status?: number): void;
	answerFromFixture(): Promise<void>;
};

export async function routePlaceLookup(target: Pick<Page, 'route'>): Promise<PlaceLookupService> {
	let body = await placeFixture();
	let status = 200;
	const queries: string[] = [];

	await target.route(isPlaceLookup, async (route) => {
		queries.push(new URL(route.request().url()).searchParams.get('q') ?? '');
		await route.fulfill({
			status,
			headers: {
				'content-type': 'application/json; charset=utf-8',
				'access-control-allow-origin': '*'
			},
			body
		});
	});

	return {
		count: () => queries.length,
		queries: () => [...queries],
		answerWith: (next, nextStatus = 200) => {
			body = next;
			status = nextStatus;
		},
		answerFromFixture: async () => {
			body = await placeFixture();
			status = 200;
		}
	};
}
