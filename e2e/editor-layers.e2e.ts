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
		/** How many times each file has been opened for reading — see `countFileReads`. */
		ballastellaFileReads?: Record<string, number>;
	}
}

/**
 * Count every file the page opens for reading from now on, by file name.
 *
 * The only way to assert "this edit costs no read of the store" from outside, and the store is the
 * thing being claimed about rather than an internal: OPFS issues no requests, so there is nothing on
 * the network to watch. `getFile()` is the one call every read in `DirectoryHandleStore` goes through.
 */
async function countFileReads(page: Page): Promise<void> {
	await page.evaluate(() => {
		const counts: Record<string, number> = {};
		window.ballastellaFileReads = counts;
		const proto = FileSystemFileHandle.prototype;
		const original = proto.getFile;
		proto.getFile = function (this: FileSystemFileHandle) {
			counts[this.name] = (counts[this.name] ?? 0) + 1;
			return original.call(this);
		};
	});
}

const fileReads = (page: Page): Promise<Record<string, number>> =>
	page.evaluate(() => ({ ...window.ballastellaFileReads }));

/**
 * Hold up every read of a file called `name` by `ms`, widening a window the machine usually closes.
 *
 * A check-then-act separated by an `await` is a race whether or not the await is usually fast, and a
 * test that depends on it being slow is a test that passes by luck. Slowing the one read that sits in
 * the middle of it makes the window wide enough to drive on purpose.
 */
async function delayReadsOf(page: Page, name: string, ms: number): Promise<void> {
	await page.evaluate(
		async ([match, delay]) => {
			const proto = FileSystemFileHandle.prototype;
			const original = proto.getFile;
			proto.getFile = async function (this: FileSystemFileHandle) {
				if (this.name === match) {
					await new Promise((resolve) => setTimeout(resolve, delay as number));
				}
				return original.call(this);
			};
		},
		[name, ms] as const
	);
}

/**
 * Refuse every write into `alignments/`, and nothing else, as a full disk does.
 *
 * By the **directory**, which patching `FileSystemFileHandle` cannot do. An Alignment is
 * `alignments/<image-id>.json` and a local image id is random (ADR-0015), so there is no name to match
 * on before the file has been picked — and matching `.json` would take `info.json` and `manifest.json`
 * with it and make this a failed *ingest* instead. `getFileHandle` is where `DirectoryHandleStore`
 * reaches a file, and it is reached from the directory that holds it.
 */
async function failWritesUnderAlignments(page: Page): Promise<void> {
	await page.evaluate(() => {
		const proto = FileSystemDirectoryHandle.prototype;
		const original = proto.getFileHandle;
		proto.getFileHandle = async function (this: FileSystemDirectoryHandle, ...args) {
			const handle = await original.apply(this, args as never);
			if (this.name === 'alignments') {
				handle.createWritable = () =>
					Promise.reject(
						new DOMException(`Quota exceeded writing ${handle.name}`, 'QuotaExceededError')
					);
			}
			return handle;
		};
	});
}

/** Hold up every write whose file name contains `needle` by `ms`. See {@link delayReadsOf}. */
async function delayWritesTo(page: Page, needle: string, ms: number): Promise<void> {
	await page.evaluate(
		([match, delay]) => {
			const proto = FileSystemFileHandle.prototype as unknown as {
				createWritable: (...args: unknown[]) => Promise<unknown>;
			};
			const original = proto.createWritable;
			proto.createWritable = async function (this: FileSystemFileHandle, ...args: unknown[]) {
				if (this.name.includes(match as string)) {
					await new Promise((resolve) => setTimeout(resolve, delay as number));
				}
				return original.call(this, ...args);
			};
		},
		[needle, ms] as const
	);
}

/**
 * The names of the **Workspace's** stored Historical Maps, which are random identifiers (ADR-0015).
 *
 * At the Workspace root rather than inside a Project (ADR-0023): a pyramid is prepared once and shared,
 * so `images/` has one answer whichever Project is open.
 */
const storedImageIds = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const images = await root.getDirectoryHandle('images');
		const names: string[] = [];
		for await (const name of images.keys()) names.push(name);
		return names;
	});

/**
 * The id of the first Historical Map whose pyramid is **complete**, or `null`.
 *
 * `info.json` is written last by the tiler and is therefore the completion marker for the whole
 * directory, so its arrival is the moment the ingest is over and the rest of the add — the
 * Alignment, the Layer, `project.json` — has begun. That is a signal nothing later in the add
 * produces, which is what makes it usable as a barrier *inside* the add rather than after it.
 *
 * Through `getFileHandle` rather than `getFile`, so a test that has slowed reads down to widen a
 * window does not slow its own barrier down with them.
 */
const completedPyramid = (page: Page): Promise<string | null> =>
	page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		let images: FileSystemDirectoryHandle;
		try {
			images = await root.getDirectoryHandle('images');
		} catch {
			return null;
		}
		for await (const name of images.keys()) {
			try {
				const image = await images.getDirectoryHandle(name);
				await image.getFileHandle('info.json');
				return name;
			} catch {
				// Not a finished pyramid: either not a directory, or still being written into.
			}
		}
		return null;
	});

/** Empty the origin's OPFS, so no test can see another's Projects. */
async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/**
 * One file of a Project, straight out of OPFS.
 *
 * Pass `''` as the directory for something at the Workspace root — a Historical Map's pyramid or its
 * Alignment, which belong to the Workspace rather than to any Project (ADR-0023).
 */
const readProjectFile = (page: Page, directory: string, path: string): Promise<string> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await navigator.storage.getDirectory();
			let handle = directory === '' ? root : await root.getDirectoryHandle(directory as string);
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
/** Every file under `prefix`, as a sha256 per path. `''` as the directory walks the Workspace root. */
async function hashesUnder(page: Page, directory: string, prefix: string) {
	const files = await page.evaluate(
		async ([directory, prefix]) => {
			const out: [string, number[]][] = [];
			const root = await navigator.storage.getDirectory();
			// `''` is the Workspace root, which is where an Alignment lives now (ADR-0023).
			const project = directory === '' ? root : await root.getDirectoryHandle(directory as string);
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
 * An empty Project, open, with nothing added to it yet.
 *
 * Split out of {@link projectWithImage} because adding the Historical Map is now itself the thing
 * under test in two places — the write it can fail on and the window it can lose a rename in — and
 * both of those have to arrange something *before* the file is picked.
 *
 * @returns the Project directory
 */
async function emptyProject(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, 'Amsterdam 1625');
	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
	return 'amsterdam-1625';
}

/** Pick the gradient PNG in the file input. Returns once the pyramid is listed. */
async function addHistoricalMap(page: Page): Promise<void> {
	await page.getByLabel('Add a Historical Map from a file').setInputFiles({
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect(page.getByRole('listitem')).toHaveCount(1, { timeout: 30_000 });
}

/**
 * A Project with one ingested Historical Map and not one Control Point yet — the state a scholar is in
 * when they make their first pair, **and still on the Project page**.
 *
 * **There is a map Layer in the stack already** (ADR-0023): adding the Historical Map is what put it
 * there, and it says it is not aligned yet until the pairs exist. So the barrier is the save
 * indicator rather than a pane: since ticket 03 there is no alignment pane on this page to wait for,
 * and the whole of the add — pyramid, Alignment, `project.json` — is what "Saved" means here.
 *
 * @returns the Project directory
 */
async function projectWithImage(page: Page): Promise<string> {
	const directory = await emptyProject(page);
	await addHistoricalMap(page);
	await expect(page.getByRole('status')).toHaveText('Saved');
	return directory;
}

/**
 * On to the alignment route for the Project's one Historical Map (ticket 03).
 *
 * Separate from {@link projectWithImage} because most of this file never needs the panes — it is
 * about the Layer stack — and because the two tests that are about what *adding* the map does have to
 * stay on the Project page to see it.
 */
async function openAlignment(page: Page): Promise<void> {
	await page.getByTestId('align-historical-map').click();
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
	await expect(page.getByTestId('image-pane')).toBeVisible();
}

/** One Control Point pair, at the same fraction across both panes. */
async function pairAt(page: Page, fx: number, fy: number): Promise<void> {
	await clickAt(page.getByTestId('image-pane'), fx, fy);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
	await clickAt(page.getByTestId('base-map-pane'), fx, fy);
	await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
}

/**
 * A Project with one aligned Historical Map, which is the smallest thing that has a Layer stack with
 * something in it that draws.
 *
 * Made through the interface rather than seeded into OPFS: the Layer comes from the add (ADR-0023)
 * and the Control Points come from the alignment workspace, so what the rest of this file measures
 * is a stack the application built rather than a fixture that already agreed with it.
 *
 * @returns the Project directory
 */
async function alignedProject(page: Page): Promise<string> {
	const directory = await projectWithImage(page);
	await openAlignment(page);
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');

	// Three pairs, which is the minimum a first-order polynomial can be solved from (ADR-0013), so
	// the Layer this makes has something to draw.
	for (const [fx, fy] of [
		[0.3, 0.3],
		[0.7, 0.35],
		[0.5, 0.7]
	] as const) {
		await pairAt(page, fx, fy);
	}
	await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn');
	await expect(page.getByRole('status')).toHaveText('Saved');

	return directory;
}

/** How long the stack may take to reach the map. See {@link openLayers}. */
const STACK_READY_MS = 20_000;

/**
 * Open the Layers pane and wait until the stack has been put on the map.
 *
 * The wait is longer than the default because what it waits for is a whole Base Map style — a PMTiles
 * header, sprites, glyphs — and then a warped Historical Map on top of it. Five seconds is enough on an
 * idle machine and not on a busy one, which reads as a failure of whatever the test went on to do.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE WAY IN IS A PARAMETER, AND THAT IS NOT A CONVENIENCE
 *
 * There are two ways to reach this pane and **they were not equivalent**. A fresh load — `via: 'load'`,
 * which is what every test in this file used and so remains the default — worked; the client-side
 * navigation from the Project page did not, once that page had a local Historical Map on it. Its
 * `WarpedMapLayer` was taken off a map that had already been removed, `Map#getLayer` threw because a
 * removed map has no style, and an exception thrown while Svelte is destroying one page abandons the
 * rest of that flush — including the mount of the page being navigated to. So the Layers pane arrived
 * with no MapLibre map inside it at all and the stack was never built.
 *
 * Neither route can stand in for the other, which is why {@link via} exists rather than being chosen
 * once here. `editor-remote-iiif.e2e.ts` covers the same pair for a `'referenced'` Layer, where the
 * failure went the other way round.
 *
 * @param via `'load'` navigates to the pane's URL; `'link'` clicks through from the Project page, which
 *   the caller must already be on.
 */
async function openLayers(
	page: Page,
	directory: string,
	{ drawn = 1, via = 'load' }: { drawn?: number; via?: 'load' | 'link' } = {}
): Promise<void> {
	if (via === 'link') await page.getByTestId('open-layers').click();
	else await page.goto(`/layers?p=${directory}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(drawn), {
		timeout: STACK_READY_MS
	});
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
 * How long {@link warpedTiles} waits for the first decoded tile.
 *
 * Generous, and it costs nothing when the tiles are there: the poll returns on the first non-zero
 * answer. A test that calls `warpedTiles` more than once therefore has to allow for this twice, which
 * is what the `test.setTimeout` calls beside each of its callers are for.
 */
const WARPED_TILE_WAIT_MS = 30_000;

/**
 * How many warped tiles have arrived **and decoded** for one Layer.
 *
 * `CacheableTile.isCachedTile()` is `data !== undefined`, and `data` is the ImageData the tile worker
 * produced — so this counts tiles that made it all the way through the ADR-0011 shim rather than
 * tiles that were merely asked for.
 */
const warpedTiles = (page: Page, layerId: string): Promise<number> =>
	page.evaluate(
		async ([id, ceiling]) => {
			// **The layer is looked up on every pass, never captured once.** Any change to the stack — a
			// reorder, a Layer shown or hidden — tears the whole stack down and builds a new one, with a
			// new `WarpedMapLayer` per map Layer, and the handle is replaced along with it. A version that
			// grabbed the layer once and then polled it was watching an object that had been taken off the
			// map, whose cache stays empty for ever: it answered 0 for a renderer that had six decoded
			// tiles a second after the reorder, which is the opposite of the honest signal this is for.
			const live = () => window.ballastellaLayerStack?.warped[id as string];
			const cached = () => {
				const layer = live();
				return layer === undefined
					? -1
					: (layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
			};

			// **Polled, not slept for, and still the same assertion.** `getCachedTiles()` is the honest
			// signal — a cached tile is bytes that arrived *and* decoded through the ADR-0011 shim, which
			// is what the `@allmaps/render` patch made possible — so what changed is the waiting, not what
			// is being asked. A fixed three seconds and one look was enough on an idle machine and not on
			// a loaded one; a longer fixed sleep would be the same defect, slower.
			let framed: unknown;
			for (let waited = 0; waited <= (ceiling as number); waited += 200) {
				const layer = live();
				if (layer !== undefined && layer !== framed) {
					// Bring the warped map into view, or the renderer has no reason to ask for a tile — and
					// again for a layer that has just replaced the one this was looking at.
					framed = layer;
					window.ballastellaLayerStack?.map.fitBounds(layer.getBounds(), { animate: false });
				}
				if (cached() > 0) break;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			return cached();
		},
		[layerId, WARPED_TILE_WAIT_MS] as const
	);

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
 * The Workspace path of the one Alignment this Project draws, derived from the Layer's image id.
 *
 * The id is not spelled out because a Historical Map's id is a random identifier rather than its
 * filename (ADR-0015) — which is also why the Layer's *name* comes from the image's manifest. The path
 * around it is spelled out rather than imported from `core`, so that a fixture built from the same
 * function the app builds its paths with cannot agree with itself however wrong both are.
 */
const alignmentRefOf = async (page: Page, directory: string): Promise<string> =>
	`alignments/${
		(await projectJson(page, directory)).layers.find(
			(layer: { kind: string }) => layer.kind === 'map'
		).imageId
	}.json`;

test.describe('a Layer for a Historical Map that has just been added', () => {
	/**
	 * SPEC stories 18 and 68, and the criterion ticket 02 exists for: **the gesture that makes the
	 * Layer is adding the map, not aligning it.** Asserted before a single Control Point exists, which
	 * is what makes it a claim about the add rather than about the alignment that used to follow.
	 */
	test('adding a Historical Map produces a kind: map Layer in project.json, with no Control Point', async ({
		page
	}) => {
		const directory = await projectWithImage(page);

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
			opacity: 1
		});
		// **One field, and both Workspace paths derive from it** (ADR-0023). The Layer names the image id
		// and nothing else — no `alignmentRef` to disagree with the derived path, and no `imageMode` to
		// disagree with the files on disk.
		expect(file.layers[0].imageId).toMatch(/^[a-z0-9]+$/i);
		expect(file.layers[0].alignmentRef).toBeUndefined();
		expect(file.layers[0].imageMode).toBeUndefined();
		expect(typeof file.layers[0].id).toBe('string');
		expect(file.layers[0].id).not.toBe('');

		// **The starter Alignment is on disk**, at the Workspace root, with no Control Points and a
		// Resource Mask over the whole sheet. Without it the Layer names a file that is not there, and
		// `assertReferencesPresent` makes the Project un-exportable and un-publishable — this build would
		// write a zip it then refused to read.
		const alignment = JSON.parse(
			await readProjectFile(page, '', `alignments/${file.layers[0].imageId}.json`)
		);
		expect(alignment.type).toBe('Annotation');
		expect(alignment.body?.features ?? []).toHaveLength(0);
		// The sheet is 700 × 500, and the mask is its four corners in the order `fullImageResourceMask`
		// produces them. Spelled out rather than derived, so a fixture built from the app's own function
		// cannot agree with itself however wrong both are.
		expect(alignment.target?.selector?.value).toBe(
			'<svg width="700" height="500"><polygon points="0,0 700,0 700,500 0,500" /></svg>'
		);

		// And nothing was written inside the Project directory: a pyramid and an Alignment belong to the
		// Workspace, shared by every Project that draws them (ADR-0023).
		await expect(
			readProjectFile(page, directory, `alignments/${file.layers[0].imageId}.json`)
		).rejects.toThrow();
	});

	/** What an unaligned map Layer says about itself, in the sidebar, once. */
	const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';

	/**
	 * The Layer says so, rather than the list being silent about a map nobody can see yet.
	 *
	 * **Including when it is hidden**, which is the half that was not possible before: the pane read
	 * the Alignment only of the Layers it handed to the map, so a hidden map Layer's row had nothing to
	 * say about it. ADR-0023 accepts the extra reads for exactly this.
	 */
	test('says it is not aligned yet, shown or hidden, from the moment the map is added', async ({
		page
	}) => {
		const directory = await projectWithImage(page);
		// Nothing is drawn, because nothing can be placed yet — and that is a sentence, not a silence.
		await openLayers(page, directory, { drawn: 0 });

		// **After the documents have been read**, not before. Every Layer starts with no document in
		// hand, and a Layer with no Alignment reads as not aligned too — so asserting the sentence on
		// the first paint would go green on the state that exists before anything has been opened, which
		// is the vacuous version of this test.
		await page.waitForTimeout(2000);
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);

		// Hidden, and it still says it: the sentence is about where the Historical Map sits on the earth,
		// and a Layer does not become aligned by being ticked.
		await rows(page).first().getByTestId('layer-visible').uncheck();
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);
		await rows(page).first().getByTestId('layer-visible').check();
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);
	});

	/**
	 * And it clears itself when the Control Points arrive, with nothing writing a flag.
	 *
	 * "Not aligned" is `controlPoints.length < MINIMUM_CONTROL_POINTS`, derived and never stored
	 * (ADR-0023) — so a **partly** aligned map, two points short of the three a first-order polynomial
	 * needs (ADR-0013), still warns. A boolean written when the map was added would get that wrong, and
	 * it is the state a scholar interrupted half way is left in.
	 */
	test('stops saying it once there are enough Control Points, and not before', async ({ page }) => {
		test.setTimeout(90_000);
		const directory = await projectWithImage(page);
		await openAlignment(page);

		await pairAt(page, 0.3, 0.3);
		await pairAt(page, 0.7, 0.35);
		await expect(page.getByRole('status')).toHaveText('Saved');
		await openLayers(page, directory, { drawn: 0 });
		// Settled, for the reason the test above gives: a Layer whose Alignment has not been read yet
		// reads as not aligned, so the sentence has to still be there once it has.
		await page.waitForTimeout(2000);
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);

		// The third pair clears it, and the Layer is on the map. Back through the Project page, because
		// the alignment view is a route of its own since ticket 03 and its `?layer=` is not a URL this
		// test knows how to write.
		await page.goto(`/?p=${directory}`);
		await openAlignment(page);
		await expect(page.getByTestId('control-point-row')).toHaveCount(2);
		await pairAt(page, 0.5, 0.7);
		// The barrier, and the honest one: the alignment workspace's own warped preview is drawn, so the
		// three pairs really do solve. Without it this waits on the Layers pane for a state the Alignment
		// may not have reached yet, and a red run would say nothing about the sentence under test.
		await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn');
		await expect(page.getByRole('status')).toHaveText('Saved');
		await openLayers(page, directory, { drawn: 1 });
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveCount(0);
	});

	/**
	 * An Alignment write must not touch `project.json` at all (ADR-0023): not create a Layer, not
	 * rename one, not reorder the stack. Every completed pair and every released drag reaches
	 * `writeAlignment`, so anything it wrote to the document would be written hundreds of times during
	 * one alignment — `updatedAt` is what would move, and it is asserted here rather than a count,
	 * because a rewrite saying the same thing passes a count.
	 */
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
		expect(after.layers).toEqual(before.layers);
		expect(after.updatedAt).toBe(before.updatedAt);
	});

	// Adding a Historical Map the Project already draws is a no-op on the stack rather than a duplicate
	// or a refusal. It needs an image id that is the *same* on the second add, which a local file never
	// has — `generateRandomId()`, ADR-0015 — so it is covered on the referenced path, where
	// `generateId(uri)` is deterministic: see `editor-remote-iiif.e2e.ts`.

	/**
	 * The Layer must never exist without the Alignment it draws.
	 *
	 * A map Layer whose `alignments/<image-id>.json` is not there is a Project ticket 13's import
	 * refuses — `assertReferencesPresent` says the Layer "needs it to be drawn" — so a Layer written
	 * over a failed starter-Alignment write leaves a scholar unable to import their own export. This is
	 * the same discipline `addAnnotationLayer` already keeps for `geojsonRef`, and there is nothing
	 * exotic about the interruption: OPFS has a quota, and a folder Workspace can have its permission
	 * revoked mid-session.
	 *
	 * **The failure is arranged before the file is picked**, because the write that can fail is part of
	 * adding the map — ticket 02 — rather than part of the first pair or, as ticket 03 briefly had it,
	 * part of pressing Align. The pyramid's own files are left writable — only `alignments/*.json` is
	 * refused — so this is the Alignment failing and not the ingest.
	 *
	 * **The ordering this protects is not tied to any one gesture.** Alignment before Layer is what
	 * `assertReferencesPresent` requires whichever act makes the Layer, which is why this test is
	 * re-pointed at each new one rather than retired with it.
	 */
	test('does not create the Layer when the starter Alignment could not be written', async ({
		page
	}) => {
		const directory = await emptyProject(page);
		await failWritesUnderAlignments(page);

		// The list of the Workspace's Historical Maps is written **last** by the add, so waiting for it
		// is waiting for the whole gesture to be over — including the half that failed. The barrier is
		// deliberately not the failure message: an implementation that made the Layer anyway would
		// overwrite the message with the successful `project.json` write, and this test would then go
		// red on the wrong line and say nothing about the Layer.
		await addHistoricalMap(page);

		// No Layer, because the Alignment it would draw is not there. Read off the page, which renders
		// the count out of the one in-memory `project.json`, and out of the file.
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (0)');
		expect((await projectJson(page, directory)).layers).toEqual([]);
		// The pyramid did land — this is the Alignment write failing, not the ingest.
		expect(await storedImageIds(page)).toHaveLength(1);
		await expect(
			readProjectFile(page, '', `alignments/${(await storedImageIds(page))[0]}.json`)
		).rejects.toThrow();
		// And the user is told, rather than being left with a Historical Map that quietly did not arrive.
		await expect(page.getByText('Quota exceeded')).toBeVisible();

		// **And there is no way to align it into existence either**, which is ticket 03's half of the
		// same rule: with no Layer in the stack there is no `?layer=` to address, so the Project page
		// offers no Align link for this map at all rather than a control that would make one.
		await expect(page.getByTestId('align-historical-map')).toHaveCount(0);
		await expect(page.getByTestId('align-unavailable')).toBeVisible();
	});

	/**
	 * Making the Layer must not throw away whatever else changed while it was being made.
	 *
	 * Putting the Layer in the stack reads `project.json` out of memory, `await`s a read of the image's
	 * `manifest.json` for the Layer's name, and writes the document back. A version that wrote back the
	 * *snapshot it took before the await* discarded whatever else changed inside that window — and one
	 * of them is the Project name field, which sits on this very page: a user renames their Project
	 * while their Historical Map is being added, sees the field revert to the old name, and the file on
	 * disk carries the old name too. `project.json` is the document whose loss is "not one annotation
	 * but the map of everything" (ADR-0017 rule 4).
	 *
	 * ──────────────────────────────────────────────────────────────────────────────────
	 * THE BARRIER IS THE PYRAMID, AND IT USED TO BE THE HISTORICAL MAPS LIST
	 *
	 * The rename has to happen **inside** the window, or this test asserts nothing while claiming to
	 * assert something. Waiting for the Historical Maps list to show one item no longer puts it inside
	 * anything: `ingestImage` sets `this.images` *last*, deliberately, so that a map appears in the
	 * list only once the whole add is done. By the time that row rendered the Layer was written, the
	 * window was shut, and reverting the fix under test left this green.
	 *
	 * `images/<id>/info.json` is the signal that still means what the list used to mean: the tiler
	 * writes it last, so it lands when the ingest ends and the Layer is on its way — with the
	 * `manifest.json` read below still to come. See {@link completedPyramid}.
	 *
	 * **Ticket 03 leaves this exactly where it is.** The window belongs to the add, and the add is on
	 * this page; the alignment route is not involved in it at all. That is the whole difference between
	 * this test and the ones above that had to be re-pointed.
	 */
	test('making the Layer does not discard a Project rename made while it was being made', async ({
		page
	}) => {
		const directory = await emptyProject(page);
		// Widens the window between the snapshot and the write. The window is real at any speed; this
		// only makes it wide enough to drive on purpose.
		await delayReadsOf(page, 'manifest.json', 3000);

		await page.getByLabel('Add a Historical Map from a file').setInputFiles({
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(700, 500)
		});
		// Inside the window: the pyramid has landed, and the Layer is on its way. Polled tightly,
		// because everything after this has to happen before the delayed read resolves.
		await expect
			.poll(() => completedPyramid(page), { timeout: 30_000, intervals: [50] })
			.not.toBeNull();
		const name = page.getByLabel('Project name');
		await name.fill('Amsterdam, 1625');
		await name.blur();

		// Long enough for the delayed read and the write it leads to. A fixed wait rather than a signal,
		// because the claim is about a write that must *not* undo an earlier one.
		await page.waitForTimeout(5000);
		await expect(page.getByRole('status')).toHaveText('Saved');

		// The Layer was made, and the rename survived it — on screen and in the file.
		const file = await projectJson(page, directory);
		expect(file.layers).toHaveLength(1);
		expect(file.name).toBe('Amsterdam, 1625');
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (1)');
		await expect(name).toHaveValue('Amsterdam, 1625');
	});

	test('shows the Layer as a local copy, which is what decides whether a reader needs the network', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);

		// The badge is now an **observation of the Workspace's files** rather than a field of
		// `project.json` (ADR-0023): the image directory has an `info.json` of ours, so the tiles are here.
		const badge = page.getByTestId('layer-image-mode');
		await expect(badge).toHaveAttribute('data-image-mode', 'mirrored');
		await expect(badge).toContainText('Local copy');
	});

	/**
	 * The link from the Project page is a way in of its own, and it used to be a broken one.
	 *
	 * Every other test in this file loads `/layers?p=…` directly, so a defect that only the client-side
	 * navigation reaches was invisible to the whole suite by construction — see {@link openLayers}. It
	 * needs a **local** Historical Map on the Project page to reproduce, because that is what puts a
	 * warped layer on a Base Map pane that then has to be torn down: the pane the user is leaving removed
	 * its map first and asked it for a layer afterwards, `Map#getLayer` threw on a map with no style, and
	 * Svelte abandoned the rest of the destroy — and with it the mount of the pane being navigated to.
	 *
	 * **`pageerror` is asserted as well as the drawn count**, because the exception is the mechanism and
	 * asserting only the outcome would leave the next version of this failure free to arrive silently.
	 * And the stack is asked of MapLibre rather than of the app, for the reason the whole file does:
	 * MapLibre's layer order *is* the drawing.
	 *
	 * **The teardown moved one hop since ticket 03** and is still exactly what this walks. The panes
	 * that have to come down are on `/align/`, so the trip is align → Project → Layers rather than
	 * Project → Layers, and it is the *first* hop that now destroys a Base Map carrying a warped layer.
	 * `pageerror` is watched across both.
	 */
	test('draws the stack when the pane is reached by the link from the Project page', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		const crashes: string[] = [];
		page.on('pageerror', (error) => crashes.push(error.message));

		// Out of the alignment route, which is where the warped pane being torn down now lives.
		await page.getByTestId('back-to-project').click();
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await openLayers(page, directory, { via: 'link' });

		const layerId = (await rowIds(page))[0] as string;
		expect(await stackOrder(page)).toEqual([`ballastella-layer-${layerId}`]);
		// The handle exists at all, which is the symptom that was reported: no map, no stack, no handle.
		expect(await stackBuilds(page)).toBeGreaterThan(0);
		expect(crashes, 'the navigation threw while tearing the previous pane down').toEqual([]);
	});
});

/**
 * SPEC story 8's reading room, whose wifi answers the request and then never finishes it.
 *
 * **A request that hangs, not one that fails.** A PMTiles archive that is *refused* leaves the Layer
 * drawing perfectly well over a blank Base Map — MapLibre treats a source, a sprite and a glyph range
 * that errored as loaded, so `isStyleLoaded()` becomes true and the stack attaches. A request left
 * open does not: the style never completes, the stack never attaches, `onstack` is never called, and
 * the page's own fallback has nothing to say about a Layer whose Alignment it read perfectly well. The
 * region then read "0 of 1 Layers are drawn" with no reason anywhere on the page, which tells a
 * scholar their work is missing and not why. Captive portals and dead connections hang; that is the
 * case worth covering.
 */
test.describe('a Base Map that never finishes loading', () => {
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// THE SERVICE WORKER IS BLOCKED HERE, AND THAT IS THE POINT OF THE TEST RATHER THAN A DODGE
	//
	// Ticket 18's worker precaches this deployment's own bundled Base Map, and it answers a request
	// for the archive out of that cache — so once it is installed the hang below is *unreachable for
	// the bundled archive*, which is ADR-0012's offline claim working rather than this fallback
	// breaking. `page.route` cannot see a request the worker answered, so with a worker in place this
	// test asserted the opposite of what it says.
	//
	// The message it covers is still needed twice over, and both are what this now measures: a first
	// visit, before any worker is installed, and a `needsNetwork: true` catalog entry, whose archive is
	// on somebody else's server and which the worker deliberately never caches (ADR-0012 fence 4).
	// Blocking the worker is how a Playwright context reaches the first of those.
	test.use({ serviceWorkers: 'block' });

	test('says why the Layer cannot be drawn rather than leaving the list silent', async ({
		page
	}) => {
		// Longer than the pane's own wait for the style, which is the thing being asserted.
		test.setTimeout(90_000);
		const directory = await alignedProject(page);

		// Neither fulfilled nor aborted: the request stays open for the life of the page.
		await page.route('**/base-map/*.pmtiles', () => undefined);
		await page.goto(`/layers?p=${directory}`);
		await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
		await expect(rows(page)).toHaveCount(1);

		// The Layer's own row carries the reason, and the region still counts honestly.
		await expect(rows(page).first().getByTestId('layer-problem')).toContainText(
			'Base Map has not finished loading',
			{ timeout: 40_000 }
		);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');
	});
});

test.describe('showing and hiding a Layer (SPEC story 50)', () => {
	test('draws the Historical Map warped, and takes it off the map when hidden', async ({
		page
	}) => {
		test.setTimeout(30_000 + WARPED_TILE_WAIT_MS);
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
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
			timeout: STACK_READY_MS
		});
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
	});

	// **A real pointer drag, not `fill()`.** `fill()` sets `value` and dispatches `input`
	// programmatically, so it cannot see the thing a user meets first: the row carries
	// `draggable="true"` for the reorder, and a pointer drag beginning on a descendant of a draggable
	// element can be claimed by the drag machinery instead of by the control under the cursor. A slider
	// thumb that will not move puts story 51 out of reach by mouse, on the platform ADR-0014 says
	// authoring targets — and every test in this file would still be green.
	test('the slider can be dragged with the mouse, not only set programmatically', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const layerId = (await rowIds(page))[0] as string;
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('100%');

		const slider = page.getByTestId('layer-opacity');
		const box = await slider.boundingBox();
		if (!box) throw new Error('the opacity slider has no box to drag in');
		// From the thumb, which sits at the right-hand end while the Layer is fully opaque.
		await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 10 });
		await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2, { steps: 10 });
		await page.mouse.up();

		// Somewhere near the left of the track rather than an exact value: what is being asserted is
		// that the gesture reached the control at all, and a range's own hit geometry is its business.
		const opacity = await warpedOpacity(page, layerId);
		expect(opacity, 'dragging the opacity slider did not reach the warped renderer').toBeLessThan(
			0.6
		);
		await expect(page.getByRole('status')).toHaveText('Saved');
		expect((await projectJson(page, directory)).layers[0].opacity).toBeCloseTo(opacity, 5);
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
	 * @param defaultStyle the Annotation Layer's style, written into `project.json` — ticket 10 owns the
	 * controls that would otherwise set it
	 * @returns the Project directory and the two Layer ids, Annotation Layer first
	 */
	async function stackWithBothKinds(page: Page, defaultStyle: Record<string, unknown> = {}) {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved');
		const [annotationId, mapId] = (await rowIds(page)) as [string, string];

		if (Object.keys(defaultStyle).length > 0) {
			const file = await projectJson(page, directory);
			await writeProjectFile(
				page,
				directory,
				'project.json',
				`${JSON.stringify(
					{
						...file,
						layers: file.layers.map((layer: { kind: string }) =>
							layer.kind === 'annotation' ? { ...layer, defaultStyle } : layer
						)
					},
					null,
					'\t'
				)}\n`
			);
		}

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
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2', {
			timeout: STACK_READY_MS
		});
		return { directory, annotationId, mapId };
	}

	test('an Annotation Layer above a map Layer draws above it, and moving it down reverses that', async ({
		page
	}) => {
		// Two waits for decoded tiles, either of which may take the full ceiling on a loaded machine.
		test.setTimeout(30_000 + 2 * WARPED_TILE_WAIT_MS);
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

	/**
	 * The case ADR-0002 actually names: an opaque label over the map it describes.
	 *
	 * The test above exercises translucent over translucent, and only that. A `WarpedMapLayer` is a
	 * MapLibre *custom* layer, so it always renders in the translucent pass; a `fill` at
	 * `fill-opacity: 1` renders in the **opaque** pass, which is a different pass with different
	 * ordering rules. Every polygon in this file inherits simplestyle's `fill-opacity: 0.6` default, so
	 * the pass an annotation Layer will normally be in once ticket 10 gives it a solid fill was never
	 * covered. Asserted through `getLayersOrder()` and `queryRenderedFeatures`, not pixels.
	 */
	test('an opaque annotation above a map Layer still draws above it', async ({ page }) => {
		test.setTimeout(30_000 + WARPED_TILE_WAIT_MS);
		const { annotationId, mapId } = await stackWithBothKinds(page, {
			fill: '#aa0000',
			'fill-opacity': 1
		});

		expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);
		expect(await renderedAtCentre(page)).toContain(`ballastella-layer-${annotationId}-fill`);

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
	});

	// The half of SPEC story 53 that "the order changed" cannot see. A keyboard user reorders by
	// pressing the same button repeatedly, so where focus is *after* a move decides whether they can
	// make a second one — and the `{#each}` is keyed, so Svelte moves the row's DOM node out from under
	// the button that was just activated. Losing focus here means Tabbing back in from the top of the
	// document, past MapLibre's own controls, for every single move.
	test('leaves the keyboard on the Layer that moved, so a second move needs no Tab', async ({
		page
	}) => {
		const { annotationId, mapId } = await stackWithBothKinds(page);
		const moveDown = rows(page).nth(0).getByTestId('layer-move-down');

		await page.keyboard.press('Tab');
		await tabTo(page, moveDown, 'Move down');
		await page.keyboard.press('Enter');
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);

		// At the bottom of the stack "Move down" is a disabled button, so the keyboard is handed the
		// other half of the same control rather than the document body.
		await expect(rows(page).nth(1).getByTestId('layer-move-up')).toBeFocused();

		// And it really is operable from there: one keypress, no Tab, and the Layer comes back.
		await page.keyboard.press('Enter');
		expect(await rowIds(page)).toEqual([annotationId, mapId]);
		await expect(page.getByTestId('layer-move-status')).toContainText('moved to 1 of 2');
	});

	// The same thing away from the ends, where the button that was pressed is still enabled — the case
	// that is about Svelte moving a keyed node rather than about `disabled`.
	test('keeps focus on the same button when the move does not reach the end', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(3);
		const [top] = (await rowIds(page)) as [string, string, string];

		const moveDown = rows(page).nth(0).getByTestId('layer-move-down');
		await page.keyboard.press('Tab');
		await tabTo(page, moveDown, 'Move down');
		await page.keyboard.press('Enter');

		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', top);
		await expect(rows(page).nth(1).getByTestId('layer-move-down')).toBeFocused();

		await page.keyboard.press('Enter');
		expect((await rowIds(page))[2]).toBe(top);
	});

	// From the handle, which is the drag source: the row is only the drop target, because a pointer
	// drag beginning anywhere inside a `draggable` element is claimed by the drag machinery rather than
	// by the slider or the name field under the cursor.
	test('reorders by dragging, reaching the same render order', async ({ page }) => {
		const { annotationId, mapId } = await stackWithBothKinds(page);

		await rows(page).nth(0).getByTestId('layer-drag-handle').dragTo(rows(page).nth(1));

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
		// Waited for, not assumed: a reload renders the hub frame before `?p=` has been read, so the
		// rows arrive a tick after the page does (ADR-0008 — a Project is selected client-side).
		await expect(rows(page)).toHaveCount(2);

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
			// The Alignment is the Workspace's and the Annotations are the Project's (ADR-0023), so the two
			// halves of "no display-state edit reaches a portability document" are hashed from two places.
			...(await hashesUnder(page, '', 'alignments/')),
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
			...(await hashesUnder(page, '', 'alignments/')),
			...(await hashesUnder(page, directory, 'annotations/'))
		];
		expect(after).toEqual(before);

		// And the display state did land somewhere: `project.json` is the only place it lives. The four
		// values are named rather than left to "the bytes differ", because `writeProject` stamps a fresh
		// `updatedAt` on every write — so the inequality below holds even if the rename, the reorder, the
		// toggle and the opacity had all been dropped from the serialised `layers`, which would make the
		// pairing with the hashes above vacuous.
		const project = await projectJson(page, directory);
		expect(await readProjectFile(page, directory, 'project.json')).not.toBe(projectBefore);
		expect(project.layers[1].name).toBe('Trade routes');
		expect(project.layers[1].kind).toBe('annotation');
		expect(project.layers[0].kind).toBe('map');
		expect(project.layers[0].visible).toBe(false);
		expect(project.layers[0].opacity).toBeCloseTo(0.4, 5);
	});

	// Display state must not cost a read of the store either. A rename and an opacity drag change
	// nothing about *which* Layers are drawn or out of which files, so re-reading every Alignment and
	// every `FeatureCollection` for one of them makes the cheapest edit in the application one of the
	// most expensive: at `step="0.05"` one drag of the slider is twenty input events, and a Project with
	// six aligned maps and two Annotation Layers would pay eight OPFS reads and eight JSON parses for
	// each one.
	test('a rename and an opacity change re-read no Layer document at all', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const annotationId = (await rowIds(page))[0] as string;
		const alignmentFile = (await alignmentRefOf(page, directory)).split('/').at(-1) as string;
		await countFileReads(page);

		await page.getByTestId('layer-opacity').fill('0.4');
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('40%');
		await rows(page).nth(0).getByTestId('layer-name').fill('Trade routes');
		await rows(page).nth(0).getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');
		// Both Layers are still drawn, so nothing was skipped rather than re-read.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const reads = await fileReads(page);
		expect(reads[alignmentFile] ?? 0, 'the Alignment was read again for display state').toBe(0);
		expect(
			reads[`${annotationId}.geojson`] ?? 0,
			'the FeatureCollection was read again for display state'
		).toBe(0);
	});

	test('renaming a Layer changes only project.json', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const alignmentRef = await alignmentRefOf(page, directory);
		const alignmentBefore = await readProjectFile(page, '', alignmentRef);

		await page.getByTestId('layer-name').fill('The 1625 plan');
		await page.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

		expect((await projectJson(page, directory)).layers[0].name).toBe('The 1625 plan');
		expect(await readProjectFile(page, '', alignmentRef)).toBe(alignmentBefore);
	});

	// The name field's half of the same question as the opacity drag: `fill()` never presses a mouse
	// button, so it cannot see a text input inside a `draggable` row where a drag-select is claimed by
	// the drag machinery and the user cannot select a word to replace it (SPEC story 54).
	test('a Layer’s name can be selected by dragging across it with the mouse', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const field = page.getByTestId('layer-name');
		await expect(field).toHaveValue('la-floride.png');

		const box = await field.boundingBox();
		if (!box) throw new Error('the name field has no box to drag in');
		await page.mouse.move(box.x + 6, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 10 });
		await page.mouse.up();

		const selected = await field.evaluate((element) => {
			const input = element as HTMLInputElement;
			return input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0);
		});
		expect(selected, 'dragging across the name field selected nothing').not.toBe('');
		await expect(field).toBeFocused();
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

test.describe('adding an Annotation Layer (SPEC stories 55 and 56)', () => {
	/**
	 * Two clicks, two Layers — the same stale-snapshot failure as `#ensureMapLayer`, found by a test
	 * that clicked twice and flaked.
	 *
	 * `addAnnotationLayer` writes the empty `FeatureCollection` before the Layer that references it, on
	 * purpose: a `geojsonRef` naming nothing is a Project ticket 13's import refuses. But it read
	 * `project.json` out of memory *before* that write and wrote the snapshot back after, so a user
	 * double-clicking the button got one Layer instead of two — and an orphaned `.geojson` in
	 * `annotations/` that nothing references and no UI can reach.
	 */
	test('gives two clicks two Layers, and leaves no orphaned FeatureCollection', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		// Widens the window between the snapshot and the write, which is real at any speed.
		await delayWritesTo(page, '.geojson.', 1000);
		const add = page.getByTestId('add-annotation-layer');

		// Deliberately not awaiting the first to land, which is what a double-click is.
		await add.click();
		await add.click();

		await expect(rows(page)).toHaveCount(3, { timeout: 15_000 });
		await expect(page.getByRole('status')).toHaveText('Saved');

		// And every file in `annotations/` belongs to a Layer that is in the stack. An orphan there is a
		// file the user can neither see nor delete.
		const refs = (await projectJson(page, directory)).layers
			.filter((layer: { kind: string }) => layer.kind === 'annotation')
			.map((layer: { geojsonRef: string }) => layer.geojsonRef)
			.sort();
		const files = (await hashesUnder(page, directory, 'annotations/'))
			.map((line) => line.split(' ')[0])
			.sort();

		expect(refs).toHaveLength(2);
		expect(files).toEqual(refs);
	});
});

test.describe('getting back out of the Layers pane', () => {
	// The stack is where a user *notices* that a Control Point needs fixing — the Historical Map is
	// visibly in the wrong place — so the way back to the alignment workspace has to be one click rather
	// than a trip out to the hub and in again.
	test('links back to the Project it belongs to, not only to the hub', async ({ page }) => {
		const directory = await alignedProject(page);
		// The other direction of the same defect the link-route test above covers, and it needs asserting
		// separately because it is **invisible on screen**: leaving this pane took the stack off a map that
		// had already been removed, `Map#getLayer` threw, and Svelte abandoned the rest of the flush — but
		// the Project page's own markup is derived state rather than effects, so it rendered anyway and only
		// its effects were skipped. Nothing below would have failed; the exception is the whole signal.
		const crashes: string[] = [];
		page.on('pageerror', (error) => crashes.push(error.message));
		await openLayers(page, directory);

		await page.getByTestId('back-to-project').click();

		// *This* Project rather than the hub: its own name in the field, and its own Layer count.
		await expect(page.getByRole('heading', { name: 'Historical Maps' })).toBeVisible();
		await expect(page.getByLabel('Project name')).toHaveValue('Amsterdam 1625');
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (1)');

		expect(crashes, 'leaving the pane threw while taking the stack off the map').toEqual([]);
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
			// Ticket 11's delete, which is the one control here that cannot be shrugged off — so it has to
			// be on the keyboard path, and the undo that makes it safe has one of its own.
			[0, 'layer-delete'],
			[1, 'layer-visible'],
			[1, 'layer-name'],
			[1, 'layer-move-up'],
			[1, 'layer-delete'],
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
