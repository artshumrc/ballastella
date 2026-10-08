import { describe, expect, it } from 'vitest';

import { createImagePane } from '../image-pane/iiif-image-pane.js';
import { ROUND_TRIP_TOLERANCE_PX } from '../image-pane/synthetic-projection.js';
import { MemoryProjectStore } from '../store/memory-project-store.js';
import { SiteFileUnreachableError } from '../store/http-project-store.js';
import { serialiseJson, type ReadOnlyProjectStore } from '../store/project-store.js';
import { encode, escapesOutOfBand, jpegHeader, seeded, stubTiler } from '../test-support.js';
import { ingestImageFile } from '../tiler/ingest.js';
import { buildImageInfo, imageServiceId } from '../tiler/pyramid.js';
import {
	MissingImageServiceOverrideError,
	createStoreImageFetch,
	isImageServicePlaceholderUrl,
	refuseUnroutedImageServiceRequests,
	type FetchFn,
	type TileFetchOutcome
} from './store-image-fetch.js';

const storeWithTile = () =>
	seeded({
		'images/abc123/info.json': '{"id":"x"}',
		'images/abc123/0,0,256,256/256,256/0/default.jpg': 'tile bytes',
		// project-rooted-path-is-the-fixture: the decoy pyramid the shim must never resolve to
		'amsterdam-1625/images/abc123/info.json': '{"id":"the wrong map"}',
		// project-rooted-path-is-the-fixture: the decoy tile, whose bytes name the wrong rooting
		'amsterdam-1625/images/abc123/0,0,256,256/256,256/0/default.jpg': 'the wrong tile'
	});

const placeholderTile = `${imageServiceId('abc123')}/0,0,256,256/256,256/0/default.jpg`;
const placeholderInfo = `${imageServiceId('abc123')}/info.json`;

describe('createStoreImageFetch', () => {
	const refusingWith = (cause: unknown): ReadOnlyProjectStore => ({
		read: async () => {
			throw cause;
		}
	});

	const unreachable = (path: string, detail = 'Failed to fetch') =>
		new SiteFileUnreachableError(path, path, 0, detail);

	const NO_ANSWER: TileFetchOutcome = {
		ok: false,
		failure: { kind: 'no-answer', host: null },
		imageId: 'abc123'
	};

	const outcomesOf = (store: ReadOnlyProjectStore, fetch?: FetchFn) => {
		const outcomes: TileFetchOutcome[] = [];
		const fetchImage = createStoreImageFetch({
			store,
			...(fetch && { fetch }),
			onOutcome: (outcome) => outcomes.push(outcome)
		});
		return { fetchImage, outcomes };
	};

	const refusedWith = (cause: unknown) =>
		outcomesOf(refusingWith(cause)).fetchImage(placeholderTile);

	const switchable = (bytes = 'bytes') => {
		const store = {
			refusing: true,
			read: async (path: string) => {
				if (store.refusing) throw unreachable(path);
				return encode(bytes);
			}
		};
		return store;
	};

	it.each([
		['a tile, keyed on the placeholder base URL', placeholderTile, 'image/jpeg', 'tile bytes'],
		['the info.json, through the same route', placeholderInfo, 'application/json', '{"id":"x"}'],
		['a tile asked for by URL', new URL(placeholderTile), 'image/jpeg', 'tile bytes'],
		['a tile asked for by Request', new Request(placeholderTile), 'image/jpeg', 'tile bytes'],
		[
			'a tile whose IIIF commas are percent-encoded',
			`${imageServiceId('abc123')}/0%2C0%2C256%2C256/256%2C256/0/default.jpg`,
			'image/jpeg',
			'tile bytes'
		]
	])('serves %s from the Workspace root, silently', async (_case, input, type, body) => {
		const { fetchImage, outcomes } = outcomesOf(await storeWithTile());
		const response = await fetchImage(input);
		expect([response.status, response.headers.get('content-type')]).toEqual([200, type]);
		expect(await response.text()).toBe(body);
		expect(outcomes).toEqual([]);
	});

	it('answers 404 for what it does not hold, reporting only a missing info.json', async () => {
		const { fetchImage, outcomes } = outcomesOf(await storeWithTile());

		const missingTile = await fetchImage(`${imageServiceId('abc123')}/9,9,1,1/1,1/0/default.jpg`);
		const detail = await missingTile.text();
		expect(missingTile.status).toBe(404);
		expect(detail).toContain('images/abc123/9,9,1,1/1,1/0/default.jpg');
		expect(detail).not.toContain('amsterdam-1625');
		expect(outcomes).toEqual([]);

		expect((await fetchImage(`${imageServiceId('not-here')}/info.json`)).status).toBe(404);
		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'file-missing', host: null }, imageId: 'not-here' }
		]);
	});

	it('answers 404, and never reads, for a placeholder path that is not a store path', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		for (const path of ['../../etc/passwd/1,1/1,1/0/default.jpg', '//info.json', '']) {
			expect((await fetchImage(`${imageServiceId('abc123')}/${path}`)).status, path).toBe(404);
		}
		expect((await fetchImage(imageServiceId('abc123'))).status).toBe(404);
	});

	it('answers a HEAD with the length and no body, and 405 to a method that is not a read', async () => {
		const fetchImage = createStoreImageFetch({ store: await storeWithTile() });

		const head = await fetchImage(placeholderTile, { method: 'HEAD' });
		expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([
			200,
			'10',
			''
		]);

		const put = await fetchImage(placeholderTile, { method: 'PUT' });
		expect([put.status, put.headers.get('allow')]).toEqual([405, 'GET, HEAD']);
	});

	it('passes another host, or a relative URL, straight through with arguments untouched', async () => {
		const seen: { input: unknown; init: unknown }[] = [];
		const fetchImage = createStoreImageFetch({
			store: await storeWithTile(),
			fetch: async (input, init) => {
				seen.push({ input, init });
				return new Response('from the network');
			}
		});
		const init = { headers: { accept: 'image/jpeg' } };
		const remote = 'https://iiif.example.org/abc/0,0,256,256/256,256/0/default.jpg';

		expect(await (await fetchImage(remote, init)).text()).toBe('from the network');
		await fetchImage('/fixtures/images/floride-1657/info.json');

		expect(seen).toEqual([
			{ input: remote, init },
			{ input: '/fixtures/images/floride-1657/info.json', init: undefined }
		]);
	});

	const unreadable = (detail: string): TileFetchOutcome => ({
		ok: false,
		failure: { kind: 'unreadable', host: null, detail },
		imageId: 'abc123'
	});

	it.each([
		[
			'a store that answered nothing',
			unreachable('images/abc123/info.json'),
			504,
			NO_ANSWER,
			'could not be reached'
		],
		[
			'a server that answered with an error',
			new SiteFileUnreachableError(
				'images/abc123/info.json',
				'https://maps.library.example/images/abc123/info.json',
				503,
				''
			),
			503,
			{
				ok: false,
				failure: { kind: 'server-error', host: 'maps.library.example', status: 503 },
				imageId: 'abc123'
			},
			''
		],
		[
			'a refusal it has no name for, borrowing no other row’s remedy',
			new Error('the quota was exceeded'),
			500,
			unreadable('the quota was exceeded'),
			'the quota was exceeded'
		],
		[
			'a cause with no prototype to stringify',
			Object.create(null),
			500,
			unreadable('the reason could not be read'),
			'the reason could not be read'
		],
		[
			'a cause whose toString throws',
			{
				toString() {
					throw new Error('boom');
				}
			},
			500,
			unreadable('the reason could not be read'),
			'the reason could not be read'
		]
	])(
		'answers %s with a Response, its cause in statusText, and one outcome',
		async (_case, cause, status, outcome, statusText) => {
			const { fetchImage, outcomes } = outcomesOf(refusingWith(cause));

			const response = await fetchImage(placeholderTile);
			expect(response.status).toBe(status);
			expect(response.statusText).toContain(statusText);
			expect(outcomes).toEqual([outcome]);
		}
	);

	it('rethrows an abort untouched, because that is the renderer changing its mind', async () => {
		const abort = new Error('The operation was aborted.');
		abort.name = 'AbortError';
		const { fetchImage, outcomes } = outcomesOf(refusingWith(abort));

		await expect(fetchImage(placeholderTile)).rejects.toBe(abort);
		expect(outcomes).toEqual([]);
	});

	it('reports the pass-through half and rethrows it, because that answer is not this shim’s', async () => {
		const refusal = new TypeError('Failed to fetch');
		const { fetchImage, outcomes } = outcomesOf(await storeWithTile(), () =>
			Promise.reject(refusal)
		);

		await expect(fetchImage('https://maps.library.example/iiif/x/info.json')).rejects.toBe(refusal);
		expect(outcomes).toEqual([
			{ ok: false, failure: { kind: 'no-answer', host: 'maps.library.example' }, imageId: null }
		]);
	});

	it('takes the notice down only when the refused URL comes back, and puts it up again', async () => {
		const store = switchable();
		const { fetchImage, outcomes } = outcomesOf(store);

		await fetchImage(placeholderTile);
		expect(outcomes).toEqual([NO_ANSWER]);
		store.refusing = false;
		await fetchImage(`${imageServiceId('abc123')}/0,0,1,1/1,1/0/default.jpg`);
		expect(outcomes).toHaveLength(1);

		await fetchImage(placeholderTile);
		expect(outcomes.at(-1)).toEqual({ ok: true });
		store.refusing = true;
		await fetchImage(placeholderTile);
		expect(outcomes).toEqual([NO_ANSWER, { ok: true }, NO_ANSWER]);
	});

	it('keeps the notice up while any refused URL is still missing, not just the last one', async () => {
		const refusing = new Set([placeholderTile, placeholderInfo]);
		const store: ReadOnlyProjectStore = {
			read: async (path) => {
				if ([...refusing].some((url) => url.endsWith(path.split('/').slice(2).join('/')))) {
					throw unreachable(path);
				}
				return encode('bytes');
			}
		};
		const { fetchImage, outcomes } = outcomesOf(store);

		await Promise.all([...refusing].map((url) => fetchImage(url)));
		expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(2);

		refusing.delete(placeholderTile);
		await fetchImage(placeholderTile);
		expect(outcomes.filter((outcome) => outcome.ok)).toEqual([]);

		refusing.clear();
		await fetchImage(placeholderInfo);
		expect(outcomes.at(-1)).toEqual({ ok: true });
	});

	it.each([true, false])(
		'keeps a partial outage’s notice up (concurrently: %s)',
		async (concurrently) => {
			const refused = `${imageServiceId('abc123')}/256,0,256,256/256,256/0/default.jpg`;
			const { fetchImage, outcomes } = outcomesOf({
				read: async (path) => {
					if (path.includes('256,0,')) throw unreachable(path, 'no');
					return encode('bytes');
				}
			});

			for (let round = 0; round < 3; round += 1) {
				if (concurrently) {
					await Promise.all([fetchImage(placeholderTile), fetchImage(refused)]);
				} else {
					await fetchImage(placeholderTile);
					await fetchImage(refused);
				}
			}

			expect(outcomes.map((outcome) => outcome.ok)).toEqual([false, false, false]);
		}
	);

	it('does not report a refusal for bytes an overlapping request already brought back', async () => {
		let releaseRefusal: (() => void) | undefined;
		let firstRequest = true;
		const { fetchImage, outcomes } = outcomesOf({
			read: async (path) => {
				if (firstRequest) {
					firstRequest = false;
					await new Promise<void>((resolve) => (releaseRefusal = resolve));
					throw unreachable(path, 'slow refusal');
				}
				return encode('{"id":"x"}');
			}
		});

		const slowRefusal = fetchImage(placeholderInfo);
		expect((await fetchImage(placeholderInfo)).status).toBe(200);
		releaseRefusal!();
		await slowRefusal;

		expect(outcomes).toEqual([]);
	});

	it('reports a refusal issued after the bytes arrived, even with an older request still in flight', async () => {
		let releaseFirst: (() => void) | undefined;
		let call = 0;
		const { fetchImage, outcomes } = outcomesOf({
			read: async (path) => {
				call += 1;
				if (call === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
				if (call <= 2) return encode('bytes');
				throw unreachable(path, 'gone after that');
			}
		});

		const first = fetchImage(placeholderTile);
		await fetchImage(placeholderTile);
		await fetchImage(placeholderTile);

		expect(outcomes).toEqual([NO_ANSWER]);
		releaseFirst!();
		await first;
	});

	it('does not take a notice down because a refused URL later answered with an error', async () => {
		let answer: 'reject' | 'error' | 'ok' = 'reject';
		const { fetchImage, outcomes } = outcomesOf(await storeWithTile(), async () => {
			if (answer === 'reject') throw new TypeError('Failed to fetch');
			return answer === 'error'
				? new Response('the library is unwell', { status: 500 })
				: new Response('tile bytes');
		});
		const remote = 'https://maps.library.example/iiif/x/info.json';

		await expect(fetchImage(remote)).rejects.toThrow();
		expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
		answer = 'error';
		expect((await fetchImage(remote)).status).toBe(500);
		expect(outcomes.filter((outcome) => outcome.ok)).toEqual([]);
		answer = 'ok';
		expect((await fetchImage(remote)).ok).toBe(true);
		expect(outcomes.at(-1)).toEqual({ ok: true });
	});

	it('is not destroyed by a subscriber that throws, on a refusal or on bytes that arrived', async () => {
		const escaped = escapesOutOfBand();
		const store = switchable('tile bytes');
		const fetchImage = createStoreImageFetch({
			store,
			onOutcome: () => {
				throw new Error('the subscriber blew up');
			}
		});

		const refusal = await fetchImage(placeholderTile);
		expect(refusal.status).toBe(504);
		expect(await refusal.json()).toEqual({ error: 'this site could not be reached.' });
		store.refusing = false;
		const arrival = await fetchImage(placeholderTile);
		expect([arrival.status, await arrival.text()]).toEqual([200, 'tile bytes']);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(escaped.map((cause) => (cause as Error).message)).toEqual([
			'the subscriber blew up',
			'the subscriber blew up'
		]);
	});

	it('keeps statusText a reason-phrase Response accepts, and the status one it can construct', async () => {
		const clamped = await refusedWith(
			new SiteFileUnreachableError(
				'images/abc123/info.json',
				'https://maps.library.example/x',
				999,
				'line one\nline two'
			)
		);
		expect(clamped.status).toBe(500);
		expect(clamped.statusText).not.toContain('\n');

		expect((await refusedWith(new Error('x'.repeat(20_000)))).statusText.length).toBe(200);

		const { statusText } = await refusedWith(
			new Error('the quota — “abc123” — was exceeded\u007f\u0000')
		);
		expect(statusText).toContain('the quota');
		expect(statusText).toContain('was exceeded');
		expect(statusText).not.toMatch(/ {2}/);
		expect(statusText).toBe(statusText.trim());
		expect(statusText.length).toBeLessThanOrEqual(200);
		for (const character of statusText) {
			const code = character.codePointAt(0) ?? 0;
			expect(code === 0x09 || (code >= 0x20 && code <= 0x7e), JSON.stringify(character)).toBe(true);
		}
	});
});

describe('isImageServicePlaceholderUrl', () => {
	it('matches the reserved host and nothing else', () => {
		expect(isImageServicePlaceholderUrl(placeholderTile)).toBe(true);
		expect(isImageServicePlaceholderUrl('http://unset.invalid/a/b')).toBe(true);
		expect(isImageServicePlaceholderUrl('https://tiles.unset.invalid/a/b')).toBe(true);
		expect(isImageServicePlaceholderUrl('https://notunset.invalid/a/b')).toBe(false);
		expect(isImageServicePlaceholderUrl('https://iiif.example.org/a/b')).toBe(false);
		expect(isImageServicePlaceholderUrl('/fixtures/info.json')).toBe(false);
	});
});

describe('refuseUnroutedImageServiceRequests', () => {
	it('turns a placeholder request that escaped the injection layer into a named error', async () => {
		const reached: unknown[] = [];
		const scope = {
			fetch: (async (input) => {
				reached.push(input);
				return new Response('');
			}) as FetchFn
		};

		const restore = refuseUnroutedImageServiceRequests(scope);

		await expect(scope.fetch(placeholderTile)).rejects.toThrow(MissingImageServiceOverrideError);
		await expect(scope.fetch(placeholderTile)).rejects.toThrow(/Image#uri/);
		expect(reached).toEqual([]);

		await scope.fetch('https://iiif.example.org/info.json');
		expect(reached).toEqual(['https://iiif.example.org/info.json']);
		restore();
		await scope.fetch(placeholderTile);
		expect(reached).toHaveLength(2);
	});

	it('is idempotent, and its teardown does not undo somebody else’s wrapper', async () => {
		const scope = { fetch: (async () => new Response('')) as FetchFn };
		const original = scope.fetch;
		const restore = refuseUnroutedImageServiceRequests(scope);
		const wrapped = scope.fetch;
		const second = refuseUnroutedImageServiceRequests(scope);
		expect(scope.fetch).toBe(wrapped);
		second();
		expect(scope.fetch).toBe(wrapped);
		restore();
		expect(scope.fetch).toBe(original);
	});
});

const ingest = (store: MemoryProjectStore, width: number, height: number) =>
	ingestImageFile({
		store,
		file: new File([jpegHeader(width, height) as BlobPart], 'scan.jpg'),
		openDecodeAndCrop: stubTiler({ width, height }, (tile) =>
			encode(`${tile.scaleFactor}/${tile.column},${tile.row}`)
		)
	});

const paneFor = async (fetchImage: FetchFn, imageId: string) =>
	createImagePane(await (await fetchImage(`${imageServiceId(imageId)}/info.json`)).json(), {
		storedImageId: imageId
	});

describe('a pyramid the tiler wrote, read back through the pane', () => {
	async function ingestAndOpen(width: number, height: number) {
		const store = new MemoryProjectStore();
		const result = await ingest(store, width, height);
		const fetchImage = createStoreImageFetch({ store });
		return { result, pane: await paneFor(fetchImage, result.imageId), fetchImage };
	}

	it('resolves every tile of every level on the placeholder host, ragged edges included', async () => {
		const { result, pane, fetchImage } = await ingestAndOpen(700, 500);

		const tiles = pane.allTiles();
		expect(tiles).toHaveLength(result.tileCount);
		expect(pane.image.uri).toBe(imageServiceId(result.imageId));
		expect(tiles.every((tile) => isImageServicePlaceholderUrl(tile.url))).toBe(true);

		const statuses = await Promise.all(
			tiles.map(async (tile) => {
				const response = await fetchImage(tile.url);
				return { url: tile.url, status: response.status, body: await response.text() };
			})
		);

		expect(statuses.filter((tile) => tile.status !== 200)).toEqual([]);
		expect(
			statuses.map(({ url, body }) => ({ url, body })),
			'the pane and the tiler disagree about which tile is where'
		).toEqual(
			tiles.map((tile) => ({
				url: tile.url,
				body: `${tile.scaleFactor}/${tile.column},${tile.row}`
			}))
		);

		expect([...new Set(tiles.map((tile) => tile.scaleFactor))]).toEqual([1, 2, 4]);
		for (const scaleFactor of [1, 2, 4]) {
			const atLevel = tiles.filter((tile) => tile.scaleFactor === scaleFactor);
			expect(
				[
					atLevel.some((tile) => tile.placement.width < pane.tileSize),
					atLevel.some((tile) => tile.placement.height < pane.tileSize)
				],
				`ragged right and bottom margin tiles at scale factor ${scaleFactor}`
			).toEqual([true, true]);
		}
	});

	const worstRoundTrip = (pane: ReturnType<typeof createImagePane>) => {
		let x = 0;
		let y = 0;
		const { width, height } = pane.image;

		for (let column = 0; column <= 97; column++) {
			for (let row = 0; row <= 89; row++) {
				const point = { x: (width * column) / 97 + 1 / 3, y: (height * row) / 89 + 1 / 7 };
				const back = pane.syntheticToResource(pane.resourceToSynthetic(point));
				x = Math.max(x, Math.abs(back.x - point.x));
				y = Math.max(y, Math.abs(back.y - point.y));
			}
		}

		return { x, y };
	};

	it('keeps the projection’s round-trip precision on a store-backed pyramid', async () => {
		const { pane } = await ingestAndOpen(700, 500);
		const store = new MemoryProjectStore();
		await store.write(
			'images/big/info.json',
			serialiseJson(buildImageInfo({ imageId: 'big', width: 60000, height: 24000 }))
		);
		const large = await paneFor(createStoreImageFetch({ store }), 'big');

		for (const [label, worst] of [
			['700 × 500, scale factors 1–4', worstRoundTrip(pane)],
			['60000 × 24000, scale factors 1–256', worstRoundTrip(large)]
		] as const) {
			expect(worst.x, `${label} Δx`).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
			expect(worst.y, `${label} Δy`).toBeLessThan(ROUND_TRIP_TOLERANCE_PX);
		}
	});

	it('keeps two images in one Workspace apart', async () => {
		const store = new MemoryProjectStore();
		const wide = await ingest(store, 700, 500);
		const tall = await ingest(store, 300, 900);
		const fetchImage = createStoreImageFetch({ store });
		const [widePane, tallPane] = [
			await paneFor(fetchImage, wide.imageId),
			await paneFor(fetchImage, tall.imageId)
		];

		expect([widePane, tallPane].map((pane) => [pane.image.width, pane.image.height])).toEqual([
			[700, 500],
			[300, 900]
		]);

		const shared = '0,0,256,256/256,256/0/default.jpg';
		const wideShared = widePane.allTiles().find((tile) => tile.url.endsWith(shared))!;
		const tallShared = tallPane.allTiles().find((tile) => tile.url.endsWith(shared))!;
		expect(await (await fetchImage(wideShared.url)).text()).toBe('1/0,0');
		expect(await (await fetchImage(tallShared.url)).text()).toBe('1/0,0');
		expect(wideShared.url).not.toBe(tallShared.url);

		const wideOnly = widePane
			.allTiles()
			.find((tile) => tile.column === 2 && tile.scaleFactor === 1)!;
		expect((await fetchImage(wideOnly.url)).status).toBe(200);
		expect(
			(await fetchImage(wideOnly.url.replace(wide.imageId, tall.imageId))).status,
			'one image answered for another'
		).toBe(404);
	});
});
