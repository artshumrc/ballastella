import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

/**
 * SPEC's Seam 2 for the Layer stack: showing, hiding, reordering, renaming, and setting the opacity
 * of Layers in the running app (stories 49–54).
 *
 * **Every claim about ordering and visibility is asserted on what rendered, never on an absence of
 * errors.** Two handles make that possible, and both are about MapLibre's own state rather than the
 * app's: `map.getLayersOrder()` *is* the mechanism by which one Layer draws above another, and each
 * warped Layer's tile cache is the honest signal that an aligned Historical Map carried bytes. The
 * failure this path used to have was an error `@allmaps/render` logged and swallowed, so a
 * console-only check went green while the map rendered blank.
 *
 * The other thing this reaches inside for is OPFS, because the display-state criterion is that
 * reordering, renaming, and toggling leave `alignments/*.json` and `annotations/*.geojson` **byte
 * identical** — which is a claim about files, and OPFS issues no requests.
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

/** A greyscale gradient PNG, so this file needs no binary fixture. */
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

// Declared here as well as in the app, because the root tsconfig compiles only `e2e/` and
// `playwright.config.ts` — it never sees the editor's own declaration.
declare global {
	interface Window {
		ballastellaLayerStack?: {
			map: {
				getLayersOrder(): string[];
				fitBounds(bounds: unknown, options?: unknown): void;
				queryRenderedFeatures(point?: unknown, options?: unknown): { layer: { id: string } }[];
				getCanvas(): { width: number; height: number };
			};
			warped: Record<
				string,
				{
					getBounds(): unknown;
					getOpacity(): number;
					/** Upstream internals, optional all the way down so a version bump fails loudly. */
					renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
				}
			>;
			builds: number;
		};
	}
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

/** One file of a Project, straight out of OPFS. */
const readProjectFile = (page: Page, directory: string, path: string): Promise<string> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await navigator.storage.getDirectory();
			let handle = await root.getDirectoryHandle(directory as string);
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment);
			}
			const file = await handle.getFileHandle(segments.at(-1) as string);
			return (await file.getFile()).text();
		},
		[directory, path]
	);

const writeProjectFile = (
	page: Page,
	directory: string,
	path: string,
	text: string
): Promise<void> =>
	page.evaluate(
		async ([directory, path, text]) => {
			const root = await navigator.storage.getDirectory();
			let handle = await root.getDirectoryHandle(directory as string, { create: true });
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments.at(-1) as string, { create: true });
			const writable = await file.createWritable();
			await writable.write(text as string);
			await writable.close();
		},
		[directory, path, text]
	);

/** Every file of a Project under `prefix`, as a sha256 per path. The bytes are the assertion. */
async function hashesUnder(page: Page, directory: string, prefix: string) {
	const files = await page.evaluate(
		async ([directory, prefix]) => {
			const out: [string, number[]][] = [];
			const root = await navigator.storage.getDirectory();
			const project = await root.getDirectoryHandle(directory as string);
			const walk = async (handle: FileSystemDirectoryHandle, at: string): Promise<void> => {
				for await (const [name, entry] of handle.entries()) {
					const path = at === '' ? name : `${at}/${name}`;
					if (entry.kind === 'directory') {
						await walk(entry as FileSystemDirectoryHandle, path);
					} else if (path.startsWith(prefix as string)) {
						const bytes = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer();
						out.push([path, [...new Uint8Array(bytes)]]);
					}
				}
			};
			await walk(project, '');
			return out.sort(([a], [b]) => a.localeCompare(b));
		},
		[directory, prefix]
	);
	return files.map(
		([path, bytes]) =>
			`${path} ${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}` as const
	);
}

async function createProject(page: Page, name: string): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	await page.getByRole('dialog', { name: 'New Project' }).getByLabel('Project name').fill(name);
	await page
		.getByRole('dialog', { name: 'New Project' })
		.getByRole('button', { name: 'Create' })
		.click();
}

/** Click at a fraction across a pane, so the same helper works for both canvases. */
async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/**
 * A Project with one aligned Historical Map, which is the smallest thing that has a Layer stack.
 *
 * Made through the interface rather than seeded into OPFS, because the first criterion is that
 * *aligning* is what produces the Layer — so the Layer has to come from the alignment workspace and
 * not from a fixture that already contains one.
 *
 * @returns the Project directory
 */
async function alignedProject(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, 'Amsterdam 1625');
	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();

	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
	await expect(page.getByTestId('image-pane')).toBeVisible();
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');

	// Three pairs, which is the minimum a first-order polynomial can be solved from (ADR-0013), so
	// the Layer this makes has something to draw.
	for (const [fx, fy] of [
		[0.3, 0.3],
		[0.7, 0.35],
		[0.5, 0.7]
	] as const) {
		await clickAt(page.getByTestId('image-pane'), fx, fy);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await clickAt(page.getByTestId('base-map-pane'), fx, fy);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
	}
	await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn');
	await expect(page.getByRole('status')).toHaveText('Saved');

	return 'amsterdam-1625';
}

/** Open the Layers pane and wait until the stack has been put on the map. */
async function openLayers(page: Page, directory: string, drawn = 1): Promise<void> {
	await page.goto(`/layers?p=${directory}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(drawn));
}

const rows = (page: Page) => page.getByTestId('layer-row');

/** MapLibre's own account of the drawing order, bottom first. */
const layerOrder = (page: Page): Promise<string[]> =>
	page.evaluate(() => window.ballastellaLayerStack?.map.getLayersOrder() ?? []);

/** Only this stack's layers, in drawing order. Everything else is the Base Map style's own. */
const stackOrder = async (page: Page): Promise<string[]> =>
	(await layerOrder(page)).filter((id) => id.startsWith('ballastella-layer-'));

const stackBuilds = (page: Page): Promise<number> =>
	page.evaluate(() => window.ballastellaLayerStack?.builds ?? -1);

/**
 * How many warped tiles have arrived **and decoded** for one Layer.
 *
 * `CacheableTile.isCachedTile()` is `data !== undefined`, and `data` is the ImageData the tile worker
 * produced — so this counts tiles that made it all the way through the ADR-0011 shim rather than
 * tiles that were merely asked for.
 */
const warpedTiles = (page: Page, layerId: string): Promise<number> =>
	page.evaluate(async (id) => {
		const stack = window.ballastellaLayerStack;
		const layer = stack?.warped[id];
		if (!stack || !layer) return -1;
		// Bring the warped map into view, or the renderer has no reason to ask for a tile.
		stack.map.fitBounds(layer.getBounds(), { animate: false });
		await new Promise((resolve) => setTimeout(resolve, 3000));
		return (layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
	}, layerId);

const warpedOpacity = (page: Page, layerId: string): Promise<number> =>
	page.evaluate((id) => window.ballastellaLayerStack?.warped[id]?.getOpacity() ?? -1, layerId);

/** The MapLibre layers that actually painted something at the centre of the canvas. */
const renderedAtCentre = (page: Page): Promise<string[]> =>
	page.evaluate(() => {
		const stack = window.ballastellaLayerStack;
		if (!stack) return [];
		const canvas = stack.map.getCanvas();
		return stack.map
			.queryRenderedFeatures([canvas.width / 2, canvas.height / 2])
			.map((feature) => feature.layer.id);
	});

/** The Layer ids of the rows on screen, top of the stack first. */
const rowIds = (page: Page): Promise<(string | null)[]> =>
	rows(page).evaluateAll((elements) =>
		elements.map((element) => element.getAttribute('data-layer-id'))
	);

/**
 * Press Tab until `target` has focus, so "operable by keyboard" is asserted by *getting there* with
 * the keyboard rather than by calling `focus()` and pretending.
 */
async function tabTo(page: Page, target: Locator, what: string): Promise<void> {
	// Generous, because the page also holds the Base Map's own focusable controls — MapLibre's zoom
	// buttons, the compass, and the attribution links — and Tab has to walk past them.
	for (let press = 0; press < 200; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

const projectJson = async (page: Page, directory: string) =>
	JSON.parse(await readProjectFile(page, directory, 'project.json'));

/**
 * The path of the one Alignment in this Project, taken from the Layer that references it.
 *
 * Not spelled out, because a Historical Map's id is a random identifier rather than its filename
 * (ADR-0015) — which is also why the Layer's *name* comes from the image's manifest.
 */
const alignmentRefOf = async (page: Page, directory: string): Promise<string> =>
	(await projectJson(page, directory)).layers.find(
		(layer: { kind: string }) => layer.kind === 'map'
	).alignmentRef;

test.describe('a Layer for an aligned Historical Map', () => {
	test('aligning a Historical Map produces a kind: map Layer in project.json', async ({ page }) => {
		const directory = await alignedProject(page);

		const file = await projectJson(page, directory);

		expect(file.layers).toHaveLength(1);
		expect(file.layers[0]).toMatchObject({
			kind: 'map',
			// The file the user picked, which is the only record of what they call this Historical Map: an
			// image id is a random identifier (ADR-0015), so naming the Layer from it would name it after
			// a hash. SPEC story 54 is that they can rename it from here.
			name: 'la-floride.png',
			visible: true,
			order: 0,
			opacity: 1,
			// A locally ingested image is a local copy, never a remote reference. Settled by ticket 09
			// because otherwise the field is ambiguous for every image that exists today.
			imageMode: 'mirrored'
		});
		// References the Alignment that is really there, by the Alignment's own naming — which is what
		// lets ticket 13's import follow a Layer to its image without opening the Annotation.
		expect(file.layers[0].alignmentRef).toMatch(/^alignments\/[^/]+\.json$/);
		expect(await readProjectFile(page, directory, file.layers[0].alignmentRef)).toContain(
			'Annotation'
		);
		expect(typeof file.layers[0].id).toBe('string');
		expect(file.layers[0].id).not.toBe('');
	});

	// `writeAlignment` runs on every completed pair and every released drag, so a version that
	// appended — or that rewrote the document to say the same thing — would stamp a fresh `updatedAt`
	// on `project.json` once per pairing click.
	test('does not add a second Layer, or a second write, for the next Control Point', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		const before = await projectJson(page, directory);

		await clickAt(page.getByTestId('image-pane'), 0.4, 0.5);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await clickAt(page.getByTestId('base-map-pane'), 0.4, 0.5);
		await expect(page.getByTestId('control-point-row')).toHaveCount(4);
		await expect(page.getByRole('status')).toHaveText('Saved');

		const after = await projectJson(page, directory);
		expect(after.layers).toHaveLength(1);
		expect(after.updatedAt).toBe(before.updatedAt);
	});

	test('shows the Layer as a local copy, which is what decides whether a reader needs the network', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);

		const badge = page.getByTestId('layer-image-mode');
		await expect(badge).toHaveAttribute('data-image-mode', 'mirrored');
		await expect(badge).toContainText('Local copy');
	});
});

test.describe('showing and hiding a Layer (SPEC story 50)', () => {
	test('draws the Historical Map warped, and takes it off the map when hidden', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const layerId = (await rowIds(page))[0] as string;

		// Asserted on cached tiles, not on an absence of console errors: the pre-patch failure was a
		// swallowed error, so a console-only check went green while the map rendered blank.
		expect(
			await warpedTiles(page, layerId),
			'no warped tile reached the renderer through the ProjectStore shim'
		).toBeGreaterThan(0);
		expect(await stackOrder(page)).toEqual([`ballastella-layer-${layerId}`]);

		await rows(page).first().getByTestId('layer-visible').uncheck();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');

		// The positive form of "it is not drawn": MapLibre no longer has a layer for it at all, so
		// there is nothing that could paint.
		expect(await stackOrder(page)).toEqual([]);
	});

	test('survives a reload, for both kinds', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved');

		// The Annotation Layer is on top, the map Layer below it.
		await rows(page).nth(0).getByTestId('layer-visible').uncheck();
		await rows(page).nth(1).getByTestId('layer-visible').uncheck();
		await expect(page.getByRole('status')).toHaveText('Saved');

		await page.reload();
		await expect(rows(page)).toHaveCount(2);
		await expect(rows(page).nth(0).getByTestId('layer-visible')).not.toBeChecked();
		await expect(rows(page).nth(1).getByTestId('layer-visible')).not.toBeChecked();
		expect(await stackOrder(page)).toEqual([]);

		await rows(page).nth(1).getByTestId('layer-visible').check();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		expect(await stackOrder(page)).toHaveLength(1);
	});
});

test.describe('opacity on a map Layer (SPEC story 51)', () => {
	test('reaches the renderer, is written, and comes back after a reload', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const layerId = (await rowIds(page))[0] as string;
		const builtBefore = await stackBuilds(page);

		await page.getByTestId('layer-opacity').fill('0.35');

		await expect(page.getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
		// ADR-0017 rule 1: dragging a slider must not tear the stack down and refetch every tile.
		expect(await stackBuilds(page), 'the stack was rebuilt by an opacity change').toBe(builtBefore);

		await expect(page.getByRole('status')).toHaveText('Saved');
		expect((await projectJson(page, directory)).layers[0].opacity).toBeCloseTo(0.35, 5);

		await page.reload();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
	});

	// The union makes this a type error in `@ballastella/core`; here it is the UI honouring it, so
	// nobody can "fix" an unresponsive slider by threading opacity through label rendering (ADR-0002).
	test('is offered on a map Layer and on no other kind', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);

		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-kind', 'annotation');
		await expect(rows(page).nth(0).getByTestId('layer-opacity')).toHaveCount(0);
		await expect(rows(page).nth(1).getByTestId('layer-opacity')).toHaveCount(1);
	});
});

test.describe('ordering, including across kinds (ADR-0002)', () => {
	/**
	 * A Project with a map Layer below an Annotation Layer that has a feature in it.
	 *
	 * The feature is written into the Layer's own `.geojson` behind the app's back, because this slice
	 * ships **no drawing tools** by design — that is ticket 10 — and an Annotation Layer with nothing
	 * in it would make "it draws above the map" a claim about an empty layer. The polygon is
	 * deliberately enormous, so it is under the centre of the canvas wherever the Base Map happens to
	 * be looking.
	 *
	 * @returns the Project directory and the two Layer ids, Annotation Layer first
	 */
	async function stackWithBothKinds(page: Page) {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved');
		const [annotationId, mapId] = (await rowIds(page)) as [string, string];

		await writeProjectFile(
			page,
			directory,
			`annotations/${annotationId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						properties: { title: 'Everywhere' },
						geometry: {
							type: 'Polygon',
							coordinates: [
								[
									[-179, -85],
									[179, -85],
									[179, 85],
									[-179, 85],
									[-179, -85]
								]
							]
						}
					}
				]
			})
		);
		await page.reload();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		return { directory, annotationId, mapId };
	}

	test('an Annotation Layer above a map Layer draws above it, and moving it down reverses that', async ({
		page
	}) => {
		const { annotationId, mapId } = await stackWithBothKinds(page);

		// Both are genuinely rendering: the Historical Map has decoded tiles, and the Annotation
		// Layer's polygon is painted where we are about to compare them.
		expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);
		expect(await renderedAtCentre(page)).toContain(`ballastella-layer-${annotationId}-fill`);

		// MapLibre draws in this order, so "after" is "above". This is the mechanism, not a proxy for it.
		const above = await stackOrder(page);
		expect(above.indexOf(`ballastella-layer-${mapId}`)).toBeLessThan(
			above.indexOf(`ballastella-layer-${annotationId}-fill`)
		);

		await rows(page).nth(0).getByTestId('layer-move-down').click();
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const below = await stackOrder(page);
		expect(below.indexOf(`ballastella-layer-${annotationId}-fill`)).toBeLessThan(
			below.indexOf(`ballastella-layer-${mapId}`)
		);
		expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);
	});

	// SPEC story 53. Layer order is load-bearing, so a drag-only reorder would make core
	// functionality keyboard-inaccessible (ADR-0016) — and this is the same implementation the drag
	// drives, so the two routes cannot diverge.
	test('reorders by keyboard alone, with no pointer involved', async ({ page }) => {
		const { annotationId, mapId } = await stackWithBothKinds(page);
		const moveDown = rows(page).nth(0).getByTestId('layer-move-down');

		await page.keyboard.press('Tab');
		await tabTo(page, moveDown, 'Move down');
		await page.keyboard.press('Enter');

		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-id', mapId);
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		// Announced, because a move changes nothing near the pointer and nothing that has focus.
		await expect(page.getByTestId('layer-move-status')).toContainText('moved to 2 of 2');

		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		const order = await stackOrder(page);
		expect(order.indexOf(`ballastella-layer-${annotationId}-fill`)).toBeLessThan(
			order.indexOf(`ballastella-layer-${mapId}`)
		);
	});

	test('reorders by dragging, reaching the same render order', async ({ page }) => {
		const { annotationId, mapId } = await stackWithBothKinds(page);

		await rows(page).nth(0).dragTo(rows(page).nth(1));

		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-id', mapId);
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const order = await stackOrder(page);
		expect(order.indexOf(`ballastella-layer-${annotationId}-fill`)).toBeLessThan(
			order.indexOf(`ballastella-layer-${mapId}`)
		);
	});

	test('survives a reload', async ({ page }) => {
		const { directory, annotationId, mapId } = await stackWithBothKinds(page);

		await rows(page).nth(0).getByTestId('layer-move-down').click();
		await expect(page.getByRole('status')).toHaveText('Saved');
		await page.reload();

		expect(await rowIds(page)).toEqual([mapId, annotationId]);
		expect((await projectJson(page, directory)).layers.map((layer: { id: string }) => layer.id)) //
			.toEqual([mapId, annotationId]);
	});
});

test.describe('display state never reaches a portability document (ADR-0002)', () => {
	test('reorder, rename, toggle, and opacity leave alignments and annotations byte-identical', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved');

		const before = [
			...(await hashesUnder(page, directory, 'alignments/')),
			...(await hashesUnder(page, directory, 'annotations/'))
		];
		// The claim is only worth making if there is something to hash.
		expect(before).toHaveLength(2);
		const projectBefore = await readProjectFile(page, directory, 'project.json');

		await rows(page).nth(0).getByTestId('layer-name').fill('Trade routes');
		await rows(page).nth(0).getByTestId('layer-name').blur();
		await rows(page).nth(0).getByTestId('layer-move-down').click();
		await rows(page).nth(0).getByTestId('layer-visible').uncheck();
		await page.getByTestId('layer-opacity').fill('0.4');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const after = [
			...(await hashesUnder(page, directory, 'alignments/')),
			...(await hashesUnder(page, directory, 'annotations/'))
		];
		expect(after).toEqual(before);
		// And the display state did land somewhere: `project.json` is the only place it lives.
		expect(await readProjectFile(page, directory, 'project.json')).not.toBe(projectBefore);
	});

	test('renaming a Layer changes only project.json', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const alignmentRef = await alignmentRefOf(page, directory);
		const alignmentBefore = await readProjectFile(page, directory, alignmentRef);

		await page.getByTestId('layer-name').fill('The 1625 plan');
		await page.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

		expect((await projectJson(page, directory)).layers[0].name).toBe('The 1625 plan');
		expect(await readProjectFile(page, directory, alignmentRef)).toBe(alignmentBefore);
	});

	// ADR-0010: merely looking must not modify files. Ticket 02's review found an `onblur` that
	// rewrote `project.json` with a fresh `updatedAt` on a focus-and-leave, and the Layer list has
	// three fields per row that could reintroduce it.
	test('tabbing through a Layer’s fields writes nothing at all', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const before = await readProjectFile(page, directory, 'project.json');

		await page.getByTestId('layer-name').focus();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await expect(page.getByRole('status')).toHaveText('Saved');

		expect(await readProjectFile(page, directory, 'project.json')).toBe(before);
	});
});

// ADR-0014 records image-space annotation as the expected next feature, so a build from before that
// kind existed has to open a colleague's Project, reorder it, and save without destroying the Layer
// it cannot draw.
test.describe('a Layer kind this build has never heard of (ADR-0014)', () => {
	test('is listed, is reorderable, and is written back intact', async ({ page }) => {
		const directory = await alignedProject(page);
		const file = await projectJson(page, directory);
		await writeProjectFile(
			page,
			directory,
			'project.json',
			`${JSON.stringify(
				{
					...file,
					layers: [
						{
							kind: 'image-annotation',
							id: 'l-cartouche',
							name: 'Cartouche',
							visible: true,
							order: 0,
							webAnnotationRef: 'image-annotations/l-cartouche.json'
						},
						{ ...file.layers[0], order: 1 }
					]
				},
				null,
				'\t'
			)}\n`
		);

		await openLayers(page, directory);

		await expect(rows(page)).toHaveCount(2);
		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-kind', 'foreign');
		await expect(rows(page).nth(0).getByTestId('layer-kind')).toContainText(
			'Not shown by this version'
		);
		// Skipped at the render boundary rather than throwing: the map Layer below it still drew.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');

		await rows(page).nth(0).getByTestId('layer-name').fill('The cartouche');
		await rows(page).nth(0).getByTestId('layer-name').blur();
		await rows(page).nth(0).getByTestId('layer-move-down').click();
		await expect(page.getByRole('status')).toHaveText('Saved');

		const written = await projectJson(page, directory);
		expect(written.layers[1]).toEqual({
			kind: 'image-annotation',
			id: 'l-cartouche',
			name: 'The cartouche',
			visible: true,
			order: 1,
			// The field this build knows nothing about, still there. Losing it would mean an older
			// build silently destroying a colleague's work (ADR-0010, ADR-0017 rule 4).
			webAnnotationRef: 'image-annotations/l-cartouche.json'
		});
	});
});

test.describe('the Layer list reaches assistive technology (SPEC story 96)', () => {
	test('is an ordered list whose structure and order are announced', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);

		const list = page.getByRole('list', { name: 'Layers, top first' });
		await expect(list).toHaveCount(1);
		// An `<ol>`, so position in the stack comes out of the markup rather than out of a label
		// somebody has to remember to update.
		expect(await list.evaluate((element) => element.tagName)).toBe('OL');
		await expect(list.getByRole('listitem')).toHaveCount(2);

		// Each row's name field says where in the stack it is, because "Layer name" three times over
		// is three identical controls to a screen reader.
		await expect(page.getByLabel('Name of Layer 1 of 2')).toHaveCount(1);
		await expect(page.getByLabel('Name of Layer 2 of 2')).toHaveCount(1);
	});

	test('every control of every Layer is reachable with the keyboard', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);

		// Every control of both rows, in document order. The reorder button that would run off the end
		// of the stack is `disabled` and so out of the tab order on purpose — "the top Layer cannot go
		// higher" is a disabled button, which is why the two rows have different lists.
		const walk: [number, string][] = [
			[0, 'layer-visible'],
			[0, 'layer-name'],
			[0, 'layer-move-down'],
			[1, 'layer-visible'],
			[1, 'layer-name'],
			[1, 'layer-move-up'],
			[1, 'layer-opacity']
		];

		await page.keyboard.press('Tab');
		for (const [row, control] of walk) {
			await tabTo(page, rows(page).nth(row).getByTestId(control), `row ${row} ${control}`);
		}
		// Reaching the last one means every one before it was on the way, in order; asserting it
		// explicitly is what makes the loop above a claim rather than a walk.
		await expect(rows(page).nth(1).getByTestId('layer-opacity')).toBeFocused();
	});
});
