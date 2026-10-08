import { describe, expect, it, vi } from 'vitest';

import { createHttpProjectStore, SiteFileUnreachableError } from './http-project-store.js';
import { InvalidPathError, PathNotFoundError, type StorePath } from './project-store.js';
import { decode, encode, rejection } from '../test-support.js';

function serving(
	files: Record<string, string | { status: number }>,
	base = 'https://scholar.example/'
) {
	const asked: string[] = [];
	const init: RequestInit[] = [];
	const fetch = vi.fn(async (input: Request | string | URL, options?: RequestInit) => {
		const url = String(input);
		asked.push(url);
		if (options) init.push(options);
		const answer = files[url];
		if (answer === undefined) return new Response('not here', { status: 404 });
		if (typeof answer === 'object') return new Response('', { status: answer.status });
		return new Response(encode(answer), { status: 200 });
	});
	const store = createHttpProjectStore({ resolve: (path: StorePath) => `${base}${path}`, fetch });
	return { store, asked, init };
}

describe('the HTTP ProjectStore adapter', () => {
	describe('reading', () => {
		it('reads a Published Site’s file as bytes', async () => {
			const { store } = serving(
				{ 'https://scholar.example/atlas/amsterdam-1625/project.json': '{"formatVersion":1}' },
				'https://scholar.example/atlas/'
			);

			expect(decode(await store.read('amsterdam-1625/project.json'))).toBe('{"formatVersion":1}');
		});

		it('resolves through the injected resolver, so one build serves a root and a subdirectory', async () => {
			const root = serving({ 'https://scholar.example/ballastella-site.json': '{}' });
			const subpath = serving(
				{ 'https://student.example/atlas-2026/ballastella-site.json': '{}' },
				'https://student.example/atlas-2026/'
			);

			await root.store.read('ballastella-site.json');
			await subpath.store.read('ballastella-site.json');

			expect(root.asked).toEqual(['https://scholar.example/ballastella-site.json']);
			expect(subpath.asked).toEqual(['https://student.example/atlas-2026/ballastella-site.json']);
		});

		it('reads a file’s bytes exactly, into a plain ArrayBuffer, including bytes that are not text', async () => {
			const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
			const store = createHttpProjectStore({
				resolve: () => 'https://scholar.example/tile.jpg',
				fetch: async () => new Response(jpeg, { status: 200 })
			});

			const bytes = await store.read('images/a/0,0,256,256/256,256/0/default.jpg');
			expect(bytes).toEqual(jpeg);
			expect(bytes.buffer).toBeInstanceOf(ArrayBuffer);
		});

		it('revalidates rather than serving a stale Project from the browser cache', async () => {
			const { store, init } = serving({ 'https://scholar.example/p/project.json': '{}' });
			await store.read('p/project.json');

			expect(init.map((options) => options.cache)).toEqual(['no-cache']);
		});
	});

	describe('a file that is not on the site', () => {
		it.each([
			['a 404, the same as every other backend', {}],
			[
				'a 410 the same way: the host is answering, and the file is gone',
				{ 'https://scholar.example/p/annotations/l2.geojson': { status: 410 } }
			]
		])('rejects %s, naming the path it could not find', async (_description, files) => {
			const { store } = serving(files);

			const failure = await rejection(PathNotFoundError, store.read('p/annotations/l2.geojson'));
			expect(failure).toMatchObject({ path: 'p/annotations/l2.geojson' });
		});
	});

	describe('a host that is not answering', () => {
		it.each([
			['a server error', { status: 500 }],
			['a bad gateway', { status: 502 }],
			['a refusal', { status: 403 }]
		])('rejects %s as unreachable rather than as missing', async (_description, answer) => {
			const { store } = serving(
				{ 'https://library.example/p/project.json': answer },
				'https://library.example/'
			);

			const failure = await rejection(SiteFileUnreachableError, store.read('p/project.json'));
			expect(failure).not.toBeInstanceOf(PathNotFoundError);
			expect(failure.status).toBe(answer.status);
		});

		it('names the host in the message, because that is the actionable part', async () => {
			const store = createHttpProjectStore({
				resolve: (path) => `https://maps.library.example/iiif/${path}`,
				fetch: async () => {
					throw new TypeError('Failed to fetch');
				}
			});

			const failure = await rejection(SiteFileUnreachableError, store.read('images/a/info.json'));
			expect(failure.host).toBe('maps.library.example');
			expect(failure.message).toContain('maps.library.example');
			expect(failure.message).toContain('Failed to fetch');
			expect(failure.status).toBe(0);
		});
	});

	describe('paths', () => {
		it.each([
			['an empty path', ''],
			['a leading slash', '/p/project.json'],
			['a trailing slash', 'p/'],
			['an empty segment', 'p//project.json'],
			['a parent traversal', 'p/../../etc/passwd'],
			['a current-directory segment', 'p/./project.json'],
			['a backslash separator', 'p\\project.json'],
			['the reserved temporary suffix', 'p/project.json.ballastella-tmp']
		])('refuses %s, exactly as the other backends do', async (_description, path) => {
			const { store, asked } = serving({});

			await expect(store.read(path)).rejects.toThrow(InvalidPathError);
			expect(asked).toEqual([]);
		});
	});

	describe('what it deliberately cannot do', () => {
		it('has no write, and therefore nothing a Reader does can attempt one', () => {
			const store = createHttpProjectStore({ resolve: (path) => `https://x.example/${path}` });
			expect(Object.keys(store)).toEqual(['read']);
			for (const method of ['write', 'delete', 'reclaimAbandonedWrites', 'list', 'size']) {
				expect(store, method).not.toHaveProperty(method);
			}
		});

		it('is the read half of ProjectStore, so ADR-0011’s shim takes it unchanged', async () => {
			const { createStoreImageFetch } = await import('../injection/store-image-fetch.js');
			const { store } = serving(
				{ 'https://scholar.example/atlas/images/aaa/info.json': '{"width":1024}' },
				'https://scholar.example/atlas/'
			);

			const readTile = createStoreImageFetch({ store });
			const response = await readTile('https://unset.invalid/aaa/info.json');
			expect(response.status).toBe(200);
			expect(await response.text()).toBe('{"width":1024}');
		});
	});
});
