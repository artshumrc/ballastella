import { expect, test, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';

/**
 * SPEC's Seam 2 for remote IIIF ingest: a URL pasted into the running app, in a real browser,
 * against real OPFS and a fixture host that behaves the way real ones do (SPEC stories 16–20, 24,
 * 25, 26, 29, 48).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE FIXTURE HOSTS, AND WHY THERE ARE FOUR OF THEM
 *
 * The pyramid geometry, the guards, and the parsing are asserted in `@ballastella/core` against
 * fourteen `info.json` documents captured from live services. What can only be asserted here is
 * everything about *hosts*: which requests the app makes, which it does not, and what happens when
 * a host refuses one.
 *
 *   `library.test`  — Manifests and a Collection. CORS everywhere.
 *   `images.test`   — an image service that serves everything readably.
 *   `tiles-only.test` — **`info.json` with CORS and tiles without it.** The ticket says a naive
 *                     implementation that probes only `info.json` passes a naive test and then
 *                     ships the blank-map failure this slice exists to prevent, so the fixture host
 *                     is built to catch exactly that. `route.abort()` is what a browser does to a
 *                     cross-origin request the host does not permit: the `fetch` rejects.
 *   `annotations.allmaps.org` — the community lookup, so "off means no request" is a claim about
 *                     the network rather than about a variable.
 *
 * Every host is routed, so **nothing in this file reaches the internet**. A red run means this
 * repository is wrong, not that a library is having a bad afternoon.
 */

const crcTable = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

const crc32 = (bytes: Buffer): number => {
	let c = -1;
	for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
	return (c ^ -1) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
	const out = Buffer.alloc(data.length + 12);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, 'ascii');
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
};

/**
 * A greyscale PNG of exactly `width` × `height`.
 *
 * Exactly matters. The CORS probe decodes the tile it fetched and refuses the resource if its
 * dimensions are not what was asked for — the exact-resize check — so a fixture host that answered
 * with the wrong size would fail every test here, which is the point of that check.
 */
function gradientPng(width: number, height: number): Buffer {
	const raw = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (width + 1);
		raw[row] = 0;
		for (let x = 0; x < width; x++) {
			raw[row + 1 + x] = (x * 255) / width / 2 + (y * 255) / height / 2;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

const IMAGE_WIDTH = 700;
const IMAGE_HEIGHT = 500;

/**
 * `generateId(uri)` — the identifier Allmaps keys an image on — computed here from `node:crypto`.
 *
 * Deliberately an independent implementation rather than an import of `@allmaps/id`: the criterion
 * is that the app's id *equals* `generateId(uri)`, and asserting that with the same function the app
 * used would only prove the function is deterministic. SHA-1 of the URI, first 16 hex characters.
 * Verified against the live Allmaps API in `packages/core/src/remote-iiif/live-services.test.ts`.
 */
const generateId = (uri: string): string =>
	createHash('sha1').update(uri).digest('hex').slice(0, 16);

const service = (host: string, name: string) => `https://${host}/iiif/3/${name}`;

const infoJson = (host: string, name: string) => ({
	'@context': 'http://iiif.io/api/image/3/context.json',
	id: service(host, name),
	type: 'ImageService3',
	protocol: 'http://iiif.io/api/image',
	profile: 'level2',
	width: IMAGE_WIDTH,
	height: IMAGE_HEIGHT,
	tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
});

const canvas = (index: number, label: string, host: string, name: string) => ({
	id: `https://library.test/iiif/atlas/canvas/${index}`,
	type: 'Canvas',
	label: { none: [label] },
	width: IMAGE_WIDTH,
	height: IMAGE_HEIGHT,
	items: [
		{
			id: `https://library.test/iiif/atlas/page/${index}`,
			type: 'AnnotationPage',
			items: [
				{
					id: `https://library.test/iiif/atlas/annotation/${index}`,
					type: 'Annotation',
					motivation: 'painting',
					target: `https://library.test/iiif/atlas/canvas/${index}`,
					body: {
						id: `${service(host, name)}/full/max/0/default.jpg`,
						type: 'Image',
						format: 'image/jpeg',
						width: IMAGE_WIDTH,
						height: IMAGE_HEIGHT,
						service: [{ id: service(host, name), type: 'ImageService3', profile: 'level2' }]
					}
				}
			]
		}
	]
});

const atlasManifest = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/atlas/manifest.json',
	type: 'Manifest',
	label: { en: ['A Sea Atlas of the Western Approaches'] },
	summary: { en: ['Three charts, engraved 1657.'] },
	metadata: [
		{ label: { en: ['Date'] }, value: { en: ['1657'] } },
		{ label: { en: ['Shelfmark'] }, value: { none: ['MS Atlas 44'] } }
	],
	requiredStatement: {
		label: { en: ['Attribution'] },
		value: { en: ['Provided by the Example Library'] }
	},
	rights: 'http://creativecommons.org/licenses/by/4.0/',
	items: [
		canvas(1, 'Title page', 'images.test', 'title-page'),
		canvas(2, 'Chart of the Florida coast', 'images.test', 'florida'),
		canvas(3, 'Chart of the Chesapeake', 'images.test', 'chesapeake')
	]
};

const collection = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/collection',
	type: 'Collection',
	label: { en: ['Sea atlases'] },
	items: [
		{
			id: 'https://library.test/iiif/atlas/manifest.json',
			type: 'Manifest',
			label: { en: ['A Sea Atlas of the Western Approaches'] }
		}
	]
};

/** A single-canvas Manifest on the host whose tiles are not readable cross-origin. */
const hostileManifest = {
	'@context': 'http://iiif.io/api/presentation/3/context.json',
	id: 'https://library.test/iiif/locked/manifest.json',
	type: 'Manifest',
	label: { en: ['A chart from a locked-down host'] },
	items: [canvas(1, 'The chart', 'tiles-only.test', 'locked')]
};

/**
 * A Georeference Annotation for one of the fixture images, as `annotations.allmaps.org` answers.
 *
 * Three Control Points, which is what `polynomial1` needs to solve — so importing this produces an
 * Alignment that can actually be rendered rather than one that merely parses.
 */
const communityAnnotation = (host: string, name: string) => ({
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: {
			id: service(host, name),
			type: 'ImageService3',
			width: IMAGE_WIDTH,
			height: IMAGE_HEIGHT
		},
		selector: {
			type: 'SvgSelector',
			value: `<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}"><polygon points="10,10 690,10 690,490 10,490" /></svg>`
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order: 1 } },
		features: [
			{
				type: 'Feature',
				properties: { resourceCoords: [60, 80] },
				geometry: { type: 'Point', coordinates: [-82.5, 27.9] }
			},
			{
				type: 'Feature',
				properties: { resourceCoords: [640, 90] },
				geometry: { type: 'Point', coordinates: [-80.1, 28.1] }
			},
			{
				type: 'Feature',
				properties: { resourceCoords: [340, 430] },
				geometry: { type: 'Point', coordinates: [-81.2, 25.7] }
			}
		]
	}
});

const json = (route: Route, body: unknown) =>
	route.fulfill({
		status: 200,
		contentType: 'application/json',
		headers: { 'access-control-allow-origin': '*' },
		body: JSON.stringify(body)
	});

/** The size a IIIF tile URL asked for, so the fixture host can honour it exactly. */
function requestedSize(url: string): { width: number; height: number } | null {
	const match = /\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	if (!match) return null;
	return { width: Number(match[5]), height: Number(match[6]) };
}

/**
 * Install every fixture host.
 *
 * @param options.tilesReadable whether `tiles-only.test` may serve its tiles. `false` aborts them,
 *   which is what a browser does to a cross-origin request the host does not permit.
 * @param options.communityAnnotations what the Allmaps API answers with, or `null` for a 404 —
 *   which is what the real API answers for a resource it has nothing for.
 */
async function installFixtureHosts(
	page: Page,
	options: { communityAnnotations?: unknown[] | null } = {}
): Promise<void> {
	const annotations = options.communityAnnotations ?? null;

	await page.route('https://library.test/**', (route) => {
		const url = route.request().url();
		if (url.endsWith('/atlas/manifest.json')) return json(route, atlasManifest);
		if (url.endsWith('/locked/manifest.json')) return json(route, hostileManifest);
		if (url.endsWith('/iiif/collection')) return json(route, collection);
		if (url.endsWith('/maps/1657')) {
			// A viewer page answered with a 200, which is the most common single failure on this path.
			return route.fulfill({
				status: 200,
				contentType: 'text/html; charset=utf-8',
				headers: { 'access-control-allow-origin': '*' },
				body: '<!DOCTYPE html><title>A Sea Atlas</title><p>Look at this map.</p>'
			});
		}
		return route.fulfill({
			status: 404,
			headers: { 'access-control-allow-origin': '*' },
			body: '{}'
		});
	});

	for (const host of ['images.test', 'tiles-only.test']) {
		await page.route(`https://${host}/**`, (route) => {
			const url = route.request().url();
			const name = /\/iiif\/3\/([^/]+)/.exec(url)?.[1] ?? '';

			if (url.endsWith('/info.json')) return json(route, infoJson(host, name));

			const size = requestedSize(url);
			if (!size) {
				return route.fulfill({
					status: 404,
					headers: { 'access-control-allow-origin': '*' },
					body: 'no such tile'
				});
			}
			// The whole point of `tiles-only.test`: its description is readable and its tiles are not.
			if (host === 'tiles-only.test') return route.abort('accessdenied');
			return route.fulfill({
				status: 200,
				contentType: 'image/png',
				headers: { 'access-control-allow-origin': '*' },
				body: gradientPng(size.width, size.height)
			});
		});
	}

	await page.route('https://annotations.allmaps.org/**', (route) =>
		annotations === null
			? route.fulfill({
					status: 404,
					contentType: 'application/json',
					headers: { 'access-control-allow-origin': '*' },
					body: JSON.stringify({ status: 404, error: 'Not Found' })
				})
			: json(route, { '@context': 'x', type: 'AnnotationPage', items: annotations })
	);
}

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/** Overwrite a file in a Project, the way a hand-edit or a half-finished write would leave it. */
/** Overwrite one file in OPFS. `''` as the directory writes at the Workspace root (ADR-0023). */
const writeFile = (page: Page, directory: string, path: string, body: string): Promise<void> =>
	page.evaluate(
		async ([directory, path, body]) => {
			const root = await navigator.storage.getDirectory();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string);
			const writable = await file.createWritable();
			await writable.write(body as string);
			await writable.close();
		},
		[directory, path, body]
	);

/**
 * One file out of OPFS, as text. `''` as the directory reads from the Workspace root (ADR-0023).
 *
 * The bytes rather than the parse, for the assertions whose claim is that *nothing was written*: a
 * document re-serialised to say the same thing is equal as JSON and different as a file, and
 * `updatedAt` is the field that tells them apart.
 */
const readText = (page: Page, directory: string, path: string): Promise<string> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await navigator.storage.getDirectory();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments[segments.length - 1] as string);
			return (await file.getFile()).text();
		},
		[directory, path]
	);

/** One JSON file out of OPFS. `''` as the directory reads from the Workspace root (ADR-0023). */
const readJson = async (page: Page, directory: string, path: string): Promise<unknown> =>
	JSON.parse(await readText(page, directory, path));

async function createProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
}

async function openNewProject(page: Page, name = 'Amsterdam 1625'): Promise<void> {
	await createProject(page, name);
	await page.getByRole('link', { name }).click();
	await expect(
		page.getByRole('heading', { name: 'Add a Historical Map from a library' })
	).toBeVisible();
}

/** Paste a URL and look it up. */
async function lookUp(page: Page, url: string): Promise<void> {
	await page.getByTestId('remote-url').fill(url);
	await page.getByTestId('remote-read').click();
}

test.describe('adding a Historical Map from a IIIF URL', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('accepts a Manifest, a Collection, and a bare image service, and browses each', async ({
		page
	}) => {
		await installFixtureHosts(page);
		await openNewProject(page);

		// A Manifest (SPEC story 16) — three canvases, each pickable (story 19).
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await expect(page.getByTestId('remote-label')).toHaveText(
			'A Sea Atlas of the Western Approaches'
		);
		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);
		await expect(page.getByTestId('remote-canvas').nth(1)).toHaveText(/Chart of the Florida coast/);

		// Metadata, rights, and attribution while choosing (SPEC story 20).
		await expect(page.getByTestId('remote-rights')).toContainText(
			'creativecommons.org/licenses/by/4.0'
		);
		await expect(page.getByTestId('remote-attribution')).toContainText(
			'Provided by the Example Library'
		);
		await page.getByText('Catalogue details (2)').click();
		await expect(page.getByText('MS Atlas 44')).toBeVisible();

		// A Collection (SPEC story 17): one URL from a library is enough.
		await page.getByTestId('remote-reset').click();
		await lookUp(page, 'https://library.test/iiif/collection');
		await expect(page.getByTestId('remote-label')).toHaveText('Sea atlases');
		await expect(page.getByTestId('remote-item')).toHaveCount(1);
		await page.getByTestId('remote-item').click();
		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);

		// A bare image service (SPEC story 18): nothing to choose, so it is selected outright.
		await page.getByTestId('remote-reset').click();
		await lookUp(page, `${service('images.test', 'florida')}/info.json`);
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await expect(page.getByTestId('remote-status')).toContainText('700 by 500 pixels');
	});

	test('names the host when its tiles are not readable cross-origin — and the tile probe is what catches it', async ({
		page
	}) => {
		// SPEC story 24, and the failure ADR-0007 exists to prevent. `tiles-only.test` serves its
		// `info.json` with CORS and aborts its tiles, so an implementation that probed only the
		// description would pass every other test in this file and ship a blank map.
		await installFixtureHosts(page);
		await openNewProject(page);

		const requested: string[] = [];
		page.on('request', (request) => requested.push(request.url()));

		await lookUp(page, 'https://library.test/iiif/locked/manifest.json');

		const error = page.getByTestId('remote-error');
		await expect(error).toBeVisible();
		await expect(error).toContainText('tiles-only.test');
		await expect(error).toContainText('completely blank');
		// Nothing was added, and nothing was written.
		await expect(page.getByTestId('remote-add')).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toHaveCount(0);

		// **The mutation guard.** The refusal has to have come from a *tile* request, not from the
		// description: the description succeeded, so a probe that stopped there would have accepted the
		// resource. Both requests are here, and the tile one is what failed.
		const toHost = requested.filter((url) => url.includes('tiles-only.test'));
		expect(toHost.some((url) => url.endsWith('/info.json'))).toBe(true);
		expect(toHost.some((url) => /\/0\/default\.jpg$/.test(url))).toBe(true);
	});

	test('gives a referenced image the id Allmaps keys it on, and a Layer that says so', async ({
		page
	}) => {
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();

		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
		await expect(page.getByTestId('referenced-image-host')).toHaveText('images.test');

		// `generateId(uri)` — computed here with `node:crypto`, independently of the app.
		const imageId = generateId(service('images.test', 'florida'));
		expect(imageId).toMatch(/^[0-9a-f]{16}$/);

		// At the Workspace root: a referenced Historical Map belongs to the Workspace like any other, so
		// adding the same remote resource from a second Project reaches the record already here (ADR-0023).
		const record = (await readJson(page, '', `images/${imageId}/remote.json`)) as Record<
			string,
			unknown
		>;
		expect(record.service).toBe(service('images.test', 'florida'));
		expect(record.label).toBe('Chart of the Florida coast');
		expect(record.partOf).toBe('https://library.test/iiif/atlas/manifest.json');
		expect(record.canvas).toBe('https://library.test/iiif/atlas/canvas/2');
		// ADR-0007 wants rights and attribution again at the moment an offline copy is made (ticket
		// 15), long after the Manifest has been navigated away from — so they are recorded now.
		expect(record.rights).toBe('http://creativecommons.org/licenses/by/4.0/');
		expect(record.attribution).toBe('Provided by the Example Library');

		const project = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; name: string; imageId: string }[];
		};
		expect(project.layers).toHaveLength(1);
		expect(project.layers[0]).toMatchObject({
			kind: 'map',
			name: 'Chart of the Florida coast',
			imageId
		});

		// **No pyramid was written, and that is the whole record of it** (ADR-0023). A referenced image has
		// no `info.json` of ours; `remote.json` sitting there without one is what says the tiles are on a
		// Library's server, so nothing in `project.json` claims it and nothing could disagree.
		await expect(readJson(page, '', `images/${imageId}/info.json`)).rejects.toThrow();
		// And the badge on the Layer says so, read off those files rather than off the document.
		await page.getByTestId('open-layers').click();
		await expect(page.getByTestId('layer-image-mode')).toHaveAttribute(
			'data-image-mode',
			'referenced'
		);
	});

	/**
	 * The defect ticket 01's review found, and the round trip that proves it is closed.
	 *
	 * A referenced map added **without** a community Alignment used to write `images/<id>/remote.json`
	 * and the Layer, and nothing else — while `layerReferences` requires `alignments/<id>.json` for
	 * every map Layer. So this build exported a zip it then refused to import, by name, and the only
	 * way to see it was to add a map and not align it. ADR-0023's starter Alignment closes it.
	 *
	 * Driven all the way round — export, an empty Workspace, import — rather than by asserting the file
	 * exists, because the file existing is what the *previous* test in this file already asserts on the
	 * community path. What was broken is the pair of them agreeing.
	 */
	test('a map added without an Alignment exports to a zip this build imports back', async ({
		page
	}) => {
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		// No community Alignment was offered — the fixture API answers with none unless asked to — so
		// this is the unaligned case rather than one that happens to have three Control Points.
		await expect(page.getByTestId('community-offer')).toHaveCount(0);
		await page.getByTestId('remote-add').click();
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
		await expect(page.getByRole('status')).toHaveText('Saved');

		const imageId = generateId(service('images.test', 'florida'));
		const alignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			body: { features: unknown[] };
			target: { source: { id: string }; selector: { value: string } };
		};
		// The starter Alignment: no Control Points, the whole sheet, and the Library's service as its
		// `resource.id` — the same address the community one carries, for the same reason (ADR-0007).
		expect(alignment.body.features).toEqual([]);
		expect(alignment.target.selector.value).toBe(
			`<svg width="${IMAGE_WIDTH}" height="${IMAGE_HEIGHT}"><polygon points="0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}" /></svg>`
		);
		expect(alignment.target.source.id).toBe(service('images.test', 'florida'));

		// Export it, from the hub.
		await page.goto('/');
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		const download = page.waitForEvent('download');
		await page.getByRole('button', { name: /^Export/ }).click();
		const saved = await download;
		expect(saved.suggestedFilename()).toBe('amsterdam-1625.zip');
		// Read back and handed to the input by name: `download.path()` is a temporary file with a random
		// basename, and the importer derives the folder it offers from the name it is given.
		const zip = await readFile(await saved.path());

		// A Workspace with nothing in it, so the import cannot be satisfied by what is already there.
		await emptyWorkspace(page);
		await page.reload();
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toHaveCount(0);

		await page.getByRole('button', { name: 'Import Project…' }).click();
		await page
			.getByRole('dialog', { name: 'Import Project' })
			.getByLabel('Project zip')
			.setInputFiles({
				name: 'amsterdam-1625.zip',
				mimeType: 'application/zip',
				buffer: zip
			});
		await page.getByRole('button', { name: 'Import Project', exact: true }).click();

		// **Accepted, not refused.** The refusal this closes says the zip "is missing
		// “alignments/<id>.json”, which the Layer … needs to be drawn", so its absence is the assertion.
		await expect(page.getByRole('link', { name: 'Amsterdam 1625' })).toBeVisible();
		await expect(page.getByText('is missing')).toHaveCount(0);
		const imported = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; imageId: string }[];
		};
		expect(imported.layers).toEqual([expect.objectContaining({ kind: 'map', imageId })]);
		expect(
			((await readJson(page, '', `alignments/${imageId}.json`)) as { body: { features: [] } }).body
				.features
		).toEqual([]);
	});

	/**
	 * SPEC story 68, the second half: adding a Historical Map the Project already draws is a no-op on
	 * the stack — not a duplicate row, and not a refusal.
	 *
	 * The referenced path is where this can be driven at all: `generateId(uri)` is deterministic, so
	 * the second add lands on the same image id, where a local file's random id (ADR-0015) makes two
	 * adds legitimately two Historical Maps.
	 *
	 * Byte identity on `project.json`, so "unchanged" covers the Layer's id, its position, its name,
	 * **and** `updatedAt` — a re-add that rewrote the document to say the same thing would pass a count
	 * and fail this.
	 */
	test('adding the same referenced map again leaves the stack byte-identical', async ({ page }) => {
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await page.getByTestId('remote-add').click();
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
		await expect(page.getByRole('status')).toHaveText('Saved');

		const before = await readText(page, 'amsterdam-1625', 'project.json');
		expect(JSON.parse(before).layers).toHaveLength(1);
		// The user renames it, so a Layer that came back rebuilt rather than untouched is visible.
		await page.getByTestId('open-layers').click();
		await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
		await page.getByTestId('layer-name').fill('The Florida coast, as drawn in 1657');
		await page.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');
		const renamed = await readText(page, 'amsterdam-1625', 'project.json');

		// Back to the Project, and add the very same canvas again.
		await page.goto('/?p=amsterdam-1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();

		// One Layer, the same one, with the name the user gave it — and not one byte written.
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (1)');
		// A fixed wait, because what is being asserted is a write that must **not** happen: reading the
		// file the moment the add returns would go green against an implementation whose write was still
		// in flight. Long enough for ADR-0017's sub-second debounce and the write behind it.
		await page.waitForTimeout(2000);
		expect(await readText(page, 'amsterdam-1625', 'project.json')).toBe(renamed);
	});

	/**
	 * "Remove the Layer, add the same map again, and it comes back — which today it silently does not."
	 *
	 * The behaviour ticket 02 names as the demonstrable one, and it is the *other* side of the deleted
	 * tombstone. `ProjectFile.removedMapLayers` recorded the image ids whose Layer the user had removed
	 * and was consulted on every Alignment write; a re-add had to remember to lift it, and anything
	 * that forgot made a deletion permanent through the affordance built to reverse it. With the record
	 * gone there is nothing to lift and nothing to forget.
	 *
	 * **Across a reload**, because that is where a record in the file — rather than in memory — would
	 * still have been waiting.
	 */
	test('a deleted map Layer comes back when the same map is added again', async ({ page }) => {
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await page.getByTestId('remote-add').click();
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
		await expect(page.getByRole('status')).toHaveText('Saved');
		const imageId = generateId(service('images.test', 'florida'));

		await page.goto('/layers?p=amsterdam-1625');
		await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
		await page.getByTestId('layer-delete').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		await expect(page.getByRole('status')).toHaveText('Saved');
		expect(
			((await readJson(page, 'amsterdam-1625', 'project.json')) as { layers: unknown[] }).layers
		).toEqual([]);

		// A reload, so nothing the running page was holding can be what makes this work.
		await page.goto('/?p=amsterdam-1625');
		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();
		await page.getByTestId('remote-add').click();
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (1)');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const back = (await readJson(page, 'amsterdam-1625', 'project.json')) as {
			layers: { kind: string; imageId: string; name: string }[];
		};
		expect(back.layers).toEqual([
			expect.objectContaining({ kind: 'map', imageId, name: 'Chart of the Florida coast' })
		]);
	});

	test('offers the community alignments it found, and importing one produces a working Alignment', async ({
		page
	}) => {
		// SPEC story 25. The annotation the fixture API answers with has three Control Points, which is
		// what `polynomial1` needs — so "working" means renderable, not merely parseable.
		await installFixtureHosts(page, {
			communityAnnotations: [
				communityAnnotation('images.test', 'florida'),
				communityAnnotation('images.test', 'chesapeake')
			]
		});
		await openNewProject(page);

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();

		// One of the two annotations is for a different image, so only one is offered — matched on the
		// identifier, which is what the API keyed it on.
		const offer = page.getByTestId('community-offer');
		await expect(offer).toContainText('Import existing alignment — 1 found.');
		await expect(offer).toContainText('3 control points');
		await expect(page.getByTestId('remote-status')).toContainText(
			'Import existing alignment — 1 found.'
		);

		await page.getByTestId('remote-add').click();
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();

		const imageId = generateId(service('images.test', 'florida'));
		const alignment = (await readJson(page, '', `alignments/${imageId}.json`)) as {
			target: { source: { id: string }; selector: { value: string } };
			body: { features: unknown[]; transformation: { type: string; options: { order: number } } };
		};

		// The Control Points and the Resource Mask came across, so this is an Alignment somebody could
		// work from rather than an empty one with the right shape.
		expect(alignment.body.features).toHaveLength(3);
		expect(alignment.body.transformation).toEqual({ type: 'polynomial', options: { order: 1 } });
		expect(alignment.target.selector.value).toContain('10,10 690,10 690,490 10,490');

		// **And it names the remote service, not the ADR-0004 placeholder.** For a referenced image
		// that is what makes the file resolvable by Allmaps (ADR-0007, SPEC story 91) *and* what makes
		// the warped Layer render at all — `@allmaps/maplibre` fetches tiles from this `id`.
		expect(alignment.target.source.id).toBe(service('images.test', 'florida'));
		expect(JSON.stringify(alignment)).not.toContain('unset.invalid');
	});

	test('discloses the lookup, and makes no request to the Allmaps API when it is off', async ({
		page
	}) => {
		// SPEC story 26 and ADR-0015. Asserted three ways, because the interesting claim is an
		// *absence* and an absence is the easiest thing in the world to assert vacuously.
		await installFixtureHosts(page, {
			communityAnnotations: [communityAnnotation('images.test', 'florida')]
		});
		await openNewProject(page);

		const allmapsRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('annotations.allmaps.org')) allmapsRequests.push(request.url());
		});

		// On by default, and it says so at the point of use.
		const toggle = page.getByTestId('community-lookup-toggle');
		await expect(toggle).toBeChecked();
		await expect(page.getByText(/Checking annotations\.allmaps\.org/)).toBeVisible();

		await toggle.uncheck();
		await expect(page.getByText(/Not checking Allmaps/)).toBeVisible();

		await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('remote-add')).toBeVisible();

		// 1. Playwright saw no request to the host.
		expect(allmapsRequests).toEqual([]);
		// 2. The app's own record of every URL the remote path asked for has the image host in it and
		//    not the Allmaps host — so this is not "no requests happened at all".
		const hosts = await page.evaluate(() => window.ballastellaRemoteRequests?.hosts ?? []);
		expect(hosts).toContain('images.test');
		expect(hosts).not.toContain('annotations.allmaps.org');
		// 3. And the user is told the check did not happen, rather than being told nothing was found.
		await expect(page.getByTestId('community-off')).toBeVisible();

		// Switched back on, the request is made — which is what makes the assertion above mean
		// something rather than describing a lookup that never works. The same canvas, so the only
		// thing that changed between the two selections is the setting.
		await toggle.check();
		await page.getByTestId('remote-canvas').nth(1).click();
		await expect(page.getByTestId('community-offer')).toBeVisible();
		expect(allmapsRequests.length).toBeGreaterThan(0);
	});

	test('refuses a viewer page answered with 200, naming it for what it is', async ({ page }) => {
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, 'https://library.test/maps/1657');

		const error = page.getByTestId('remote-error');
		await expect(error).toContainText('sent a web page rather than a IIIF description');
		await expect(error).toContainText('library.test');
	});

	test('is reachable and operable by keyboard alone', async ({ page }) => {
		// SPEC story 95. Driven entirely from the keyboard: focus the URL field by its accessible
		// label, type, press Enter, then Tab to a canvas button and activate it with Enter.
		await installFixtureHosts(page);
		await openNewProject(page);

		await page.getByLabel('IIIF Manifest, Collection, or image address').focus();
		await page.keyboard.type('https://library.test/iiif/atlas/manifest.json');
		await page.keyboard.press('Enter');

		await expect(page.getByTestId('remote-canvas')).toHaveCount(3);

		const second = page.getByTestId('remote-canvas').nth(1);
		await second.focus();
		await expect(second).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('remote-add')).toBeVisible();

		const add = page.getByTestId('remote-add');
		await add.focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
	});
});

test.describe('reading a referenced Historical Map as a document', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
	});

	test('opens it unwarped in triiiceratops, which draws tiles from the remote host', async ({
		page
	}) => {
		// SPEC story 48. Asserted on tiles having been requested from the library rather than on the
		// viewer having mounted: a mounted OpenSeadragon that fetched nothing is exactly the blank
		// panel this ticket's CORS gate exists to prevent, and it looks identical to a working one.
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, `${service('images.test', 'florida')}/info.json`);
		await page.getByTestId('remote-add').click();
		await expect(page.getByTestId('view-unwarped')).toBeVisible();

		const tileRequests: string[] = [];
		page.on('request', (request) => {
			if (/images\.test.*default\.(jpg|png)$/.test(request.url())) tileRequests.push(request.url());
		});

		await page.getByTestId('view-unwarped').click();
		await expect(page.getByTestId('unwarped-view')).toBeVisible();
		// OpenSeadragon draws into a canvas of its own, inside triiiceratops' viewer.
		await expect(page.getByTestId('unwarped-view').locator('canvas').first()).toBeVisible({
			timeout: 20_000
		});
		await expect.poll(() => tileRequests.length, { timeout: 20_000 }).toBeGreaterThan(0);

		// Closing it takes the viewer away, so a second one is never on the page.
		await page.getByTestId('unwarped-close').click();
		await expect(page.getByTestId('unwarped-view')).toHaveCount(0);
	});

	/**
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * BOTH WAYS IN TO THE LAYERS PANE, BECAUSE THEY WERE NOT EQUIVALENT
	 *
	 * A fresh load of `/layers?p=…` **drew this Layer blank**, while the client-side navigation from the
	 * Project page drew it correctly. On a load the pane builds the stack as soon as it has each Layer's
	 * Alignment, and `remote.json` — the only record of where a referenced image's tiles are — is read
	 * after that: the Layer was handed `service: ''`, which is the ADR-0004 placeholder document, and
	 * asked the injection shim for a pyramid the Project does not contain. The record arriving a moment
	 * later changed nothing, because the remote service was not part of what the pane rebuilds the stack
	 * for.
	 *
	 * Only this test's `'load'` half can see that, and only `editor-layers.e2e.ts`'s link-route test can
	 * see the defect that went the other way round — so both files now cover both routes. Left with one
	 * route each, either defect could come back unnoticed.
	 */
	for (const via of ['link', 'load'] as const) {
		test(`draws a referenced Layer warped, from tiles the remote host served (reached by ${via})`, async ({
			page
		}) => {
			test.slow();
			// The other half of "a referenced image produces a Layer with `imageMode: 'referenced'` **and
			// renders from the remote host**". The Layer part is asserted above, on `project.json`; this is
			// the rendering, and it is asserted the way ticket 09 asserts it — on the warped Layer's own
			// tile cache — because the failure this path has is an error `@allmaps/render` logs and
			// swallows, so a check for an absence of console errors goes green over a blank map.
			//
			// It is also the assertion that catches the specific mistake this ticket could make: handing the
			// renderer an Alignment whose `resource.id` is the ADR-0004 placeholder. That document parses,
			// solves, and reports a map id — and then asks the injection layer for a pyramid the Project
			// does not contain, and draws nothing.
			await installFixtureHosts(page, {
				communityAnnotations: [communityAnnotation('images.test', 'florida')]
			});
			await openNewProject(page);

			await lookUp(page, 'https://library.test/iiif/atlas/manifest.json');
			await page.getByTestId('remote-canvas').nth(1).click();
			await expect(page.getByTestId('community-offer')).toBeVisible();
			await page.getByTestId('remote-add').click();
			await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
			// The record of where the tiles are has reached the Workspace before the pane is opened, so the
			// `'load'` half is about the pane's own ordering rather than about a write that had not happened.
			await expect(page.getByRole('status')).toHaveText('Saved');

			const tileRequests: string[] = [];
			page.on('request', (request) => {
				if (/images\.test.*default\.(jpg|png)$/.test(request.url()))
					tileRequests.push(request.url());
			});
			// And nothing may go to the placeholder host: that is what a referenced image drawn as though it
			// were a local copy would ask for.
			const placeholderRequests: string[] = [];
			page.on('request', (request) => {
				if (request.url().includes('unset.invalid')) placeholderRequests.push(request.url());
			});

			if (via === 'link') await page.getByTestId('open-layers').click();
			else await page.goto('/layers?p=amsterdam-1625');
			await expect(page.getByRole('heading', { name: 'Layers in this Project' })).toBeVisible();

			// The Layer is on the map, not refused.
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const handle = window.ballastellaLayerStack;
							if (!handle) return -1;
							return Object.keys(handle.warped).length;
						}),
					{ timeout: 30_000 }
				)
				.toBe(1);

			// It carried bytes, and they came from the library. `fitBounds` first, exactly as
			// `editor-layers.e2e.ts` does: the renderer has no reason to ask for a tile for a Layer that is
			// not on screen, and the fixture's Control Points put this one off the coast of Florida.
			await expect
				.poll(
					() =>
						page.evaluate(async () => {
							const handle = window.ballastellaLayerStack;
							const layer = Object.values(handle?.warped ?? {})[0];
							if (!handle || !layer) return 0;
							handle.map.fitBounds(layer.getBounds(), { animate: false });
							await new Promise((resolve) => setTimeout(resolve, 1500));
							return layer.renderer?.tileCache?.getCachedTiles?.()?.length ?? 0;
						}),
					{ timeout: 60_000, intervals: [2000] }
				)
				.toBeGreaterThan(0);

			expect(tileRequests.length).toBeGreaterThan(0);
			expect(placeholderRequests).toEqual([]);
		});
	}

	test('says so when the record of where a referenced map lives cannot be read', async ({
		page
	}) => {
		// `remote.json` is the only thing that says where a referenced Historical Map's tiles are, and a
		// Project whose copy of it has been hand-edited or half-written is a Layer nothing can draw. The
		// failure this guards is the quiet one: skipping the record, and leaving the scholar with a Layer
		// that draws nothing and no sentence anywhere. Opening the Project must not fail either — the
		// other Historical Maps are fine — so the readable ones are listed and the broken one is named.
		//
		// Two maps, because one is not the same test: the reason is shown inside the referenced-maps
		// section, so a Project whose *only* referenced record is unreadable currently says nothing at
		// all. That gap is recorded against `ProjectView.svelte` rather than asserted here.
		await installFixtureHosts(page);
		await openNewProject(page);

		for (const name of ['florida', 'approaches']) {
			await lookUp(page, `${service('images.test', name)}/info.json`);
			await expect(page.getByTestId('remote-add')).toBeVisible();
			await page.getByTestId('remote-add').click();
			await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();
		}
		await expect(page.getByRole('status')).toHaveText('Saved');

		const broken = generateId(service('images.test', 'approaches'));
		await writeFile(page, '', `images/${broken}/remote.json`, '{"label":"corrupt"}');

		await page.goto('/?p=amsterdam-1625');
		await expect(page.getByRole('heading', { name: 'Referenced Historical Maps' })).toBeVisible();

		// The readable one is still listed, so one broken record has not taken the Project down with it.
		await expect(page.getByTestId('referenced-image-label')).toHaveCount(1);

		const alert = page.getByRole('alert').filter({ hasText: broken });
		await expect(alert).toContainText('names no image service');
		await expect(alert).toContainText('nowhere to fetch its tiles from');
	});

	test('uses triiiceratops as a Svelte component, never its web-component export', async ({
		page
	}) => {
		// ADR-0018. The web-component export registers `<triiiceratops-viewer>` as a custom element, so
		// its absence from the registry after the viewer has rendered is the observable difference —
		// and it is the one that would change if somebody swapped the import.
		await installFixtureHosts(page);
		await openNewProject(page);

		await lookUp(page, `${service('images.test', 'florida')}/info.json`);
		await page.getByTestId('remote-add').click();
		await page.getByTestId('view-unwarped').click();
		await expect(page.getByTestId('unwarped-view').locator('canvas').first()).toBeVisible({
			timeout: 20_000
		});

		const registered = await page.evaluate(() =>
			['triiiceratops-viewer', 'triiiceratops-element'].map(
				(name) => customElements.get(name) !== undefined
			)
		);
		expect(registered).toEqual([false, false]);
		await expect(page.locator('triiiceratops-viewer')).toHaveCount(0);
	});
});

// Declared here as well as in the app, because the root tsconfig compiles only `e2e/` and
// `playwright.config.ts` — it never sees the editor's own declarations.
//
// `ballastellaLayerStack` is deliberately **not** redeclared: `editor-layers.e2e.ts` already declares
// it, the two files are in one TypeScript program, and a second declaration of the same global with a
// narrower shape is a merge conflict rather than a convenience.
declare global {
	interface Window {
		ballastellaRemoteRequests?: { urls: string[]; hosts: string[] };
	}
}
