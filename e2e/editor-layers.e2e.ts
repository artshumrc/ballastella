import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

import { expectWarpedDrawn } from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addMapImageButton,
	expectNothingPreparing,
	pickMapImageFile
} from './support/map-images.js';
import {
	centreOnAmsterdam,
	editAnnotationText,
	paintProperty,
	renderedAnnotationLayers,
	selectAnnotation,
	waitForPaintedAnnotations
} from './support/annotations.js';
import { alignFromLayer, openLayerRow } from './support/layers.js';
import { projectNameField } from './support/project-screen.js';
import { countFileReads, countFileWrites, fileReads, fileWrites } from './support/store-traffic.js';
import { restoreWorkspace, snapshotWorkspace } from './support/workspace-snapshot.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

/**
 * Seam 2 for the Layer stack: showing, hiding, reordering, renaming, and setting the opacity
 * of Layers in the running app.
 *
 * **Every claim about ordering and visibility is asserted on what rendered, never on an absence of
 * errors.** Two handles make that possible, and both are about MapLibre's own state rather than the
 * app's: `map.getLayersOrder()` *is* the mechanism by which one Layer draws above another, and each
 * warped Layer's tile cache is the honest signal that an aligned Map Image carried bytes. The
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
				/** Style parsed, sources loaded, nothing left to repaint — see {@link renderedAtCentre}. */
				loaded(): boolean;
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

/**
 * A row's text **as assistive technology receives it**: `aria-hidden` subtrees removed.
 *
 * Written out rather than asserted with `toContainText`, because the criterion is precisely that the
 * state is *not* conveyed by a colour: a `class:text-warning` assertion passes while a screen reader
 * is told nothing at all, and so does a `toBeVisible` on an element inside an `aria-hidden` wrapper.
 * A class contributes no characters here, so this cannot be satisfied by one.
 */
const accessibleText = (row: Locator): Promise<string> =>
	row.evaluate((element) => {
		const clone = element.cloneNode(true) as HTMLElement;
		for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
		return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
	});

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
 * The names of the **Workspace's** stored Map Images, which are random identifiers (ADR-0015).
 *
 * At the Workspace root rather than inside a Project (ADR-0023): a pyramid is prepared once and shared,
 * so `images/` has one answer whichever Project is open.
 */
const storedImageIds = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const root = await workspaceRoot();
		const images = await root.getDirectoryHandle('images');
		const names: string[] = [];
		for await (const name of images.keys()) names.push(name);
		return names;
	});

/**
 * The id of the first Map Image whose pyramid is **complete**, or `null`.
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
		const root = await workspaceRoot();
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
		// The whole of browser storage, which is **every named Workspace** rather than one — so no test
		// can see another's, whichever Workspace it was in.
		//
		// ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore`
		// caches its root handle once it resolves (ADR-0008), and that handle is now a *named
		// subdirectory* rather than the OPFS root, which cannot vanish. Deleting the directory out from
		// under a running app therefore latches it "unreachable" until a reload — a state about the
		// harness rather than about the product, and one that used to be unreachable because emptying
		// the root left the root itself in place. Emptying it is exactly what this always meant.
		const root = await navigator.storage.getDirectory();
		const open = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(
			names
				.filter((name) => name !== open.name)
				.map((name) => root.removeEntry(name, { recursive: true }))
		);
		const inside: string[] = [];
		for await (const name of open.keys()) inside.push(name);
		await Promise.all(inside.map((name) => open.removeEntry(name, { recursive: true })));
	});
}

/**
 * One file of a Project, straight out of OPFS.
 *
 * Pass `''` as the directory for something at the Workspace root — a Map Image's pyramid or its
 * Alignment, which belong to the Workspace rather than to any Project (ADR-0023).
 */
const readProjectFile = (page: Page, directory: string, path: string): Promise<string> =>
	page.evaluate(
		async ([directory, path]) => {
			const root = await workspaceRoot();
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
			const root = await workspaceRoot();
			// `''` writes at the Workspace root, where a Map Image's pyramid and its Alignment live
			// (ADR-0023). The reader above already took `''` to mean that; this did not, and the two
			// disagreeing is how a fixture asks for `alignments/…` and gets a `NotAllowedError`.
			let handle =
				directory === ''
					? root
					: await root.getDirectoryHandle(directory as string, { create: true });
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
			const root = await workspaceRoot();
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
	// Creating a Project opens it; what follows is on Workspace Home.
	await expect(page.getByTestId('project-name')).toHaveText(name);
	await page.getByTestId('all-projects').click();
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
 * Split out of {@link projectWithImage} because adding the Map Image is now itself the thing
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
	await expect(addMapImageButton(page)).toBeVisible();
	return 'amsterdam-1625';
}

/**
 * Pick the gradient PNG in the file input, and return once the whole add is over.
 *
 * **The barrier is the pyramid on disk, not the Layer.** The Project page carries no list of the
 * Workspace's Map Images to wait on, and the obvious replacement — waiting for the Layer row — is
 * wrong here: one caller below is about the add whose Layer is deliberately *never made*, so waiting
 * for it would hang for thirty seconds and then fail on the wrong line. `images/<id>/info.json` is
 * written by the tiler last, so it lands when the ingest ends and the Layer is on its way.
 */
async function addMapImage(page: Page): Promise<void> {
	await pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});
	await expect.poll(() => completedPyramid(page), { timeout: 30_000 }).not.toBeNull();
	// And the *whole* add is over, Layer write included: `ingestImage` clears its job in a `finally`,
	// which is what takes the preparing card out of the stack — so this is one signal for the success
	// and the failure alike, which is exactly what the failing-Alignment test below needs. Asked of
	// the card rather than of the file input, which is inside a closed dialog: a
	// control the user cannot see is not evidence of anything.
	await expectNothingPreparing(page, 30_000);
}

/**
 * A Project with one ingested Map Image and not one Control Point yet — the state a scholar is in
 * when they make their first pair, **and still on the Project page**.
 *
 * **There is a map Layer in the stack already** (ADR-0023): adding the Map Image is what put it
 * there, and it says it is not aligned yet until the pairs exist. So the barrier is the save
 * indicator rather than a pane: there is no alignment pane on this page to wait for, and the whole
 * of the add — pyramid, Alignment, `project.json` — is what "Saved" means here.
 *
 * @returns the Project directory
 */
async function projectWithImageThroughTheInterface(page: Page): Promise<string> {
	const directory = await emptyProject(page);
	await addMapImage(page);
	await expect(page.getByRole('status')).toHaveText('Saved here');
	return directory;
}

/**
 * On to the alignment route for the Project's one Map Image.
 *
 * Separate from {@link projectWithImage} because most of this file never needs the panes — it is
 * about the Layer stack — and because the two tests that are about what *adding* the map does have to
 * stay on the Project page to see it.
 *
 * **It opens the Project screen itself.** A seeded Workspace leaves the page on the hub with the
 * files already on disk (see {@link seededWorkspace}), so there is no Layer row to press Align in
 * until this navigates to one — and a caller that is already on the Project screen loses nothing but
 * a load it was about to pay for anyway.
 */
async function openAlignment(page: Page, directory: string): Promise<void> {
	await page.goto(`/?p=${directory}`);
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	// The Align link is inside the Layer's own row, so getting there opens it.
	await alignFromLayer(page);
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
 * A Project with one aligned Map Image, which is the smallest thing that has a Layer stack with
 * something in it that draws.
 *
 * Made through the interface rather than seeded into OPFS: the Layer comes from the add (ADR-0023)
 * and the Control Points come from the alignment workspace, so what the rest of this file measures
 * is a stack the application built rather than a fixture that already agreed with it.
 *
 * @returns the Project directory
 */
async function alignedProjectThroughTheInterface(page: Page): Promise<string> {
	const directory = await projectWithImageThroughTheInterface(page);
	await openAlignment(page, directory);
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
	await expectWarpedDrawn(page);
	await expect(page.getByRole('status')).toHaveText('Saved here');

	return directory;
}

/**
 * The Project directory every fixture in this file builds in — spelled out because a seeded
 * Workspace is restored before any page has read it, so there is nothing on screen to ask.
 */
const PROJECT_DIRECTORY = 'amsterdam-1625';

/** The map Layer's two ids, read out of `project.json` rather than off a screen that may not be up. */
const mapLayerIds = async (page: Page): Promise<{ imageId: string; layerId: string }> => {
	const layer = (await projectJson(page, PROJECT_DIRECTORY)).layers.find(
		(entry: { kind: string }) => entry.kind === 'map'
	);
	return { imageId: layer.imageId as string, layerId: layer.id as string };
};

/**
 * Replay a Workspace this build's own interface once produced, instead of producing it again.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE PYRAMID AND THE THREE CONTROL POINTS ARE SCENERY IN ALL BUT FIVE OF THESE TESTS.          │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Thirty of the thirty-six tests here are about the Layer *stack* — what a row says, what order
 * MapLibre draws in, which files an edit touches — and every one of them used to pay for a real
 * ingest and then for three Control Point pairs made by clicking two live map panes, which is two
 * client-side navigations, a Base Map load and a warped solve before the first assertion. That is
 * the single largest cost in this file.
 *
 * `workspace-snapshot.ts` carries the full argument for why the fixture is a **recording** rather
 * than a literal or a construction from `core`'s own functions; the short version is that these
 * bytes are by construction what this build's ingest and this build's alignment writer produce, so
 * nothing asserted about them changes meaning. The recording is keyed to the build fingerprint, so
 * a changed tiler or serialiser discards it.
 *
 * ⚠ **A test whose subject is the add itself must not use this.** Three below drive
 * {@link emptyProject} and {@link addMapImage} directly — the one that asserts what adding a
 * map writes, the one that fails the starter Alignment write, and the one that renames the Project
 * inside the add's own window. They are what keeps the recording honest.
 *
 * Leaves the page on the hub with the files on disk and nothing read yet: every caller's next move
 * is a navigation, so landing on the Project screen here would be a page load thrown away.
 */
async function seededWorkspace(
	page: Page,
	name: string,
	capture: (page: Page) => Promise<string>
): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, name, async (fresh) => {
		await capture(fresh);
		return mapLayerIds(fresh);
	});
	await restoreWorkspace(page, snapshot.files);
	return PROJECT_DIRECTORY;
}

/**
 * A Project with one ingested Map Image and not one Control Point yet — seeded.
 *
 * See {@link seededWorkspace} for what "seeded" costs and does not cover, and
 * {@link projectWithImageThroughTheInterface} for the journey that was recorded to make it.
 */
const projectWithImage = (page: Page): Promise<string> =>
	seededWorkspace(page, 'layers-with-image', projectWithImageThroughTheInterface);

/**
 * A Project with one aligned Map Image — seeded.
 *
 * See {@link seededWorkspace}, and {@link alignedProjectThroughTheInterface} for the journey that
 * was recorded to make it.
 */
const alignedProject = (page: Page): Promise<string> =>
	seededWorkspace(page, 'layers-aligned', alignedProjectThroughTheInterface);

/** How long the stack may take to reach the map. See {@link openLayers}. */
const STACK_READY_MS = 20_000;

/**
 * Open the Layers pane and wait until the stack has been put on the map.
 *
 * The wait is longer than the default because what it waits for is a whole Base Map style — a PMTiles
 * header, sprites, glyphs — and then a warped Map Image on top of it. Five seconds is enough on an
 * idle machine and not on a busy one, which reads as a failure of whatever the test went on to do.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * THE WAY IN IS A PARAMETER, AND THAT IS NOT A CONVENIENCE
 *
 * There are two ways to reach this pane and **they were not equivalent**. A fresh load — `via: 'load'`,
 * which is what every test in this file used and so remains the default — worked; the client-side
 * navigation from the Project page did not, once that page had a local Map Image on it. Its
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
	// `via: 'link'` used to mean "follow the Project page's Layers link". There is no such page: the
	// Layer stack is the Project, so arriving is already being there and the two paths differ only in
	// whether the screen was loaded fresh.
	if (via === 'link') await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	else await page.goto(`/?p=${directory}`);
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(drawn), {
		timeout: STACK_READY_MS
	});
	await waitForOpeningView(page);
}

/**
 * Wait until the opening view has been settled (ADR-0026).
 *
 * The pane is framed on the Project's content by an asynchronous read of every Layer's documents, so
 * a test that positions the map before that read lands has its viewport moved out from under it. This
 * is not a workaround for a race in the app: the fit is *meant* to happen exactly once, on open, and
 * this is how a test waits for the one time it does.
 */
async function waitForOpeningView(page: Page): Promise<void> {
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: STACK_READY_MS }
	);
}

const rows = (page: Page) => page.getByTestId('layer-row');

type HeaderForeground = {
	control: string;
	opacity: string;
	color: string;
	ink: string;
};

/** The inherited kind-content ink each visible header control receives. */
const headerForegrounds = (page: Page, theme: string): Promise<HeaderForeground[]> =>
	page.evaluate((nextTheme) => {
		document.documentElement.dataset.theme = nextTheme;
		return [...document.querySelectorAll<HTMLElement>('[data-testid="layer-row"]')].flatMap(
			(row) => {
				const kind = row.querySelector<HTMLElement>('[data-testid="layer-kind"]');
				if (!kind) return [];
				const ink = getComputedStyle(kind).color;
				const controls: [string, HTMLElement | null][] = [
					['name', row.querySelector<HTMLElement>('[data-testid="layer-name-text"]')],
					['handle', row.querySelector<HTMLElement>('[data-testid="layer-drag-handle"]')],
					['disclosure', row.querySelector<HTMLElement>('[data-testid="layer-disclosure"]')]
				];
				return controls.flatMap(([control, element]) =>
					element
						? [
								{
									control,
									opacity: getComputedStyle(element).opacity,
									color: getComputedStyle(element).color,
									ink
								}
							]
						: []
				);
			}
		);
	}, theme);

test('Layer header controls use each kind’s paired content token in Carto Light and Bumblebee', async ({
	page
}) => {
	const directory = await projectWithImage(page);
	await openLayers(page, directory, { drawn: 0 });
	await page.getByTestId('add-annotation-layer').click();
	await expect(rows(page)).toHaveCount(2);

	for (const theme of ['carto-light', 'bumblebee']) {
		const foregrounds = await headerForegrounds(page, theme);
		expect(foregrounds, theme).toHaveLength(6);
		for (const foreground of foregrounds) {
			expect(foreground.opacity, `${theme} ${foreground.control} opacity`).toBe('1');
			expect(foreground.color, `${theme} ${foreground.control} colour`).toBe(foreground.ink);
		}
	}
});

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

/**
 * The MapLibre layers that actually painted something at the centre of the canvas.
 *
 * **Waits for the map to settle first**, and that is not politeness. `queryRenderedFeatures` reads
 * what is *painted*, so while a camera move is still resolving it answers `[]` for every layer on the
 * map, base map and all — which reads as "the Annotation Layer is not above the Map Image" and is
 * really "ask again". Both callers query immediately after `warpedTiles`, which jumps the camera onto
 * the sheet; before ADR-0026 that jump was a couple of zoom levels from the deployment default and
 * mostly landed on tiles already in hand, and now it is a jump back from wherever the Project's own
 * content put the map. Same assertion, honest waiting — the same distinction `warpedTiles` itself
 * records about polling rather than sleeping.
 */
const renderedAtCentre = async (page: Page): Promise<string[]> => {
	await page.waitForFunction(() => window.ballastellaLayerStack?.map.loaded() === true, undefined, {
		timeout: 15_000
	});
	return page.evaluate(() => {
		const stack = window.ballastellaLayerStack;
		if (!stack) return [];
		const canvas = stack.map.getCanvas();
		return stack.map
			.queryRenderedFeatures([canvas.width / 2, canvas.height / 2])
			.map((feature) => feature.layer.id);
	});
};

/** The Layer ids of the rows on screen, top of the stack first. */
const rowIds = (page: Page): Promise<(string | null)[]> =>
	rows(page).evaluateAll((elements) =>
		elements.map((element) => element.getAttribute('data-layer-id'))
	);

/** What the page recorded about each element handed to `setDragImage`. See {@link watchDragImages}. */
interface DragImage {
	/** The element's own `data-testid`, so "the card" and "the handle" are distinguishable. */
	testid: string | null;
	layerId: string | null;
	/** The offset the ghost is held at, and the element's size, so the offset can be judged against it. */
	x: number;
	y: number;
	width: number;
	height: number;
}

interface DragWindow {
	ballastellaDragImages: DragImage[];
}

/**
 * Record every element the page asks the browser to draw as a drag ghost.
 *
 * A native drag image is painted by the browser outside the document, so there is nothing to assert
 * about it from inside the page except the call that asked for it. Patching the prototype rather than
 * one `DataTransfer` because the object is made by the browser for each drag and never reaches the
 * test; `addInitScript` so the patch is in place before the app's first line runs.
 *
 * The original is still called, so this observes the behaviour instead of replacing it.
 */
async function watchDragImages(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const drawn: DragImage[] = [];
		(window as unknown as DragWindow).ballastellaDragImages = drawn;
		const original = DataTransfer.prototype.setDragImage;
		DataTransfer.prototype.setDragImage = function (
			this: DataTransfer,
			image: Element,
			x: number,
			y: number
		) {
			const box = image.getBoundingClientRect();
			drawn.push({
				testid: image.getAttribute('data-testid'),
				layerId: image.getAttribute('data-layer-id'),
				x,
				y,
				width: box.width,
				height: box.height
			});
			return original.call(this, image, x, y);
		};
	});
}

/**
 * Press Tab until `target` has focus, so "operable by keyboard" is asserted by *getting there* with
 * the keyboard rather than by calling `focus()` and pretending.
 *
 * ⚠ **This is the most expensive helper in the file and its cost is invisible at the call site.**
 * Every iteration is two protocol round trips — an `evaluate` and a key press — so a walk past the
 * Base Map's own controls can be a hundred of them before the first assertion runs. On a loaded
 * machine that is tens of seconds, and the two tests that use it exhausted the default 30 s test
 * budget in 1 of the 10 runs measured on 2026-08-07. It reported as
 * `waiting for … layer-move-down`, which reads like a button that never rendered. Both callers now
 * state a budget; a new one must too.
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

/**
 * The one map Layer's row, addressed by kind.
 *
 * Opacity belongs to map Layers only, and it now lives inside the card — so a test that reorders, or
 * that adds an Annotation Layer on top, cannot reach the slider through `nth(0)`. Two tests waited
 * sixty seconds for a control that was never coming before this existed.
 */
const mapRow = (page: Page) => page.locator('[data-testid="layer-row"][data-layer-kind="map"]');

const projectJson = async (page: Page, directory: string) =>
	JSON.parse(await readProjectFile(page, directory, 'project.json'));

/**
 * The Workspace path of the one Alignment this Project draws, derived from the Layer's image id.
 *
 * The id is not spelled out because a Map Image's id is a random identifier rather than its
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

test.describe('a Layer for a Map Image that has just been added', () => {
	/**
	 * **The gesture that makes the Layer is adding the map, not aligning it.** Asserted before a single
	 * Control Point exists, which is what makes it a claim about the add rather than about the
	 * alignment that used to follow.
	 */
	test('adding a Map Image produces a kind: map Layer in project.json, with no Control Point', async ({
		page
	}) => {
		// Through the real file input, not seeded: this test's subject *is* what adding a map writes,
		// and asserting it against a recording would be asserting the recording.
		const directory = await projectWithImageThroughTheInterface(page);

		const file = await projectJson(page, directory);

		expect(file.layers).toHaveLength(1);
		expect(file.layers[0]).toMatchObject({
			kind: 'map',
			// The file the user picked, which is the only record of what they call this Map Image: an
			// image id is a random identifier (ADR-0015), so naming the Layer from it would name it after
			// a hash, and they can rename it from here.
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
		// `assertReferencesPresent` makes the Project un-exportable and unsendable — this build would
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
		//
		// ⚠ **Still a sleep, and it was measured against the alternative.** The settled opening view
		// `openLayers` waits for looks like the signal — it is computed from a read of every Layer's
		// documents (ADR-0026) — but it is a *second* read, started in the same flush as the sidebar's
		// own and ordered against it by nothing. Substituting it leaves the window this guards open, and
		// the failure would be a silent vacuous pass rather than a red run. Replacing this needs a
		// signal the sidebar itself emits, which is a change to the application.
		await page.waitForTimeout(2000);
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);

		// Hidden, and it still says it: the sentence is about where the Map Image sits on the earth,
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
		// The panes are where the next pair is made, and a seeded Workspace has not opened them.
		await openAlignment(page, directory);
		await expect(page.getByTestId('control-point-row')).toHaveCount(3);
		const before = await projectJson(page, directory);

		await clickAt(page.getByTestId('image-pane'), 0.4, 0.5);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await clickAt(page.getByTestId('base-map-pane'), 0.4, 0.5);
		await expect(page.getByTestId('control-point-row')).toHaveCount(4);
		await expect(page.getByRole('status')).toHaveText('Saved here');

		const after = await projectJson(page, directory);
		expect(after.layers).toEqual(before.layers);
		expect(after.updatedAt).toBe(before.updatedAt);
	});

	// Adding a Map Image the Project already draws is a no-op on the stack rather than a duplicate
	// or a refusal. It needs an image id that is the *same* on the second add, which a local file never
	// has — `generateRandomId()`, ADR-0015 — so it is covered on the referenced path, where
	// `generateId(uri)` is deterministic: see `editor-remote-iiif.e2e.ts`.

	/**
	 * The Layer must never exist without the Alignment it draws.
	 *
	 * A map Layer whose `alignments/<image-id>.json` is not there is a Project an import refuses —
	 * `assertReferencesPresent` says the Layer "needs it to be drawn" — so a Layer written
	 * over a failed starter-Alignment write leaves a scholar unable to import their own export. This is
	 * the same discipline `addAnnotationLayer` already keeps for `geojsonRef`, and there is nothing
	 * exotic about the interruption: OPFS has a quota, and a folder Workspace can have its permission
	 * revoked mid-session.
	 *
	 * **The failure is arranged before the file is picked**, because the write that can fail is part of
	 * adding the map rather than part of the first pair or of pressing Align. The pyramid's own files
	 * are left writable — only `alignments/*.json` is refused — so this is the Alignment failing and
	 * not the ingest.
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

		// The list of the Workspace's Map Images is written **last** by the add, so waiting for it
		// is waiting for the whole gesture to be over — including the half that failed. The barrier is
		// deliberately not the failure message: an implementation that made the Layer anyway would
		// overwrite the message with the successful `project.json` write, and this test would then go
		// red on the wrong line and say nothing about the Layer.
		await addMapImage(page);

		// No Layer, because the Alignment it would draw is not there. Read off the page, which renders
		// the count out of the one in-memory `project.json`, and out of the file.
		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		expect((await projectJson(page, directory)).layers).toEqual([]);
		// The pyramid did land — this is the Alignment write failing, not the ingest.
		expect(await storedImageIds(page)).toHaveLength(1);
		await expect(
			readProjectFile(page, '', `alignments/${(await storedImageIds(page))[0]}.json`)
		).rejects.toThrow();
		// And the user is told, rather than being left with a Map Image that quietly did not arrive.
		await expect(page.getByText('Quota exceeded')).toBeVisible();

		// **And there is no way to align it into existence either**, which is the alignment route's half
		// of the same rule: with no Layer in the stack there is no `?layer=` to address, so the Project
		// screen offers no Align link for this map at all rather than a control that would make one.
		await expect(page.getByTestId('align-map-image')).toHaveCount(0);
		await expect(page.getByTestId('align-map-image-now')).toHaveCount(0);
		// Said, not merely absent. The Project page used to carry a dedicated "this map is in the
		// Workspace but not in this Project" alert beside its list of the Workspace's Map Images; there
		// is no such list, so the sentence that has to be true here is the sidebar's own empty state —
		// and it names the next action rather than only the fact.
		await expect(page.getByText('This Project has no Map Images yet.')).toBeVisible();
	});

	/**
	 * Making the Layer must not throw away whatever else changed while it was being made.
	 *
	 * Putting the Layer in the stack reads `project.json` out of memory, `await`s a read of the image's
	 * `manifest.json` for the Layer's name, and writes the document back. A version that wrote back the
	 * *snapshot it took before the await* discarded whatever else changed inside that window — and one
	 * of them is the Project name field, which sits on this very page: a user renames their Project
	 * while their Map Image is being added, sees the field revert to the old name, and the file on
	 * disk carries the old name too. `project.json` is the document whose loss is "not one annotation
	 * but the map of everything" (ADR-0017 rule 4).
	 *
	 * ──────────────────────────────────────────────────────────────────────────────────
	 * THE BARRIER IS THE PYRAMID, AND IT USED TO BE THE MAP IMAGES LIST
	 *
	 * The rename has to happen **inside** the window, or this test asserts nothing while claiming to
	 * assert something. Waiting for the Map Images list to show one item no longer puts it inside
	 * anything: `ingestImage` sets `this.images` *last*, deliberately, so that a map appears in the
	 * list only once the whole add is done. By the time that row rendered the Layer was written, the
	 * window was shut, and reverting the fix under test left this green.
	 *
	 * `images/<id>/info.json` is the signal that still means what the list used to mean: the tiler
	 * writes it last, so it lands when the ingest ends and the Layer is on its way — with the
	 * `manifest.json` read below still to come. See {@link completedPyramid}.
	 *
	 * **The alignment route leaves this exactly where it is.** The window belongs to the add, and the
	 * add is on this page; the alignment route is not involved in it at all. That is the whole
	 * difference between this test and the ones above that had to be re-pointed.
	 */
	test('making the Layer does not discard a Project rename made while it was being made', async ({
		page
	}) => {
		const directory = await emptyProject(page);
		// Widens the window between the snapshot and the write. The window is real at any speed; this
		// only makes it wide enough to drive on purpose.
		await delayReadsOf(page, 'manifest.json', 3000);

		await pickMapImageFile(page, {
			name: 'la-floride.png',
			mimeType: 'image/png',
			buffer: gradientPng(700, 500)
		});
		// Inside the window: the pyramid has landed, and the Layer is on its way. Polled tightly,
		// because everything after this has to happen before the delayed read resolves.
		await expect
			.poll(() => completedPyramid(page), { timeout: 30_000, intervals: [50] })
			.not.toBeNull();
		// Renaming is in the Project settings dialog. The breadcrumb edit button opens it inside the same
		// window — the delayed `manifest.json` read is what holds the window open, and it is three seconds
		// wide.
		const name = await projectNameField(page);
		await name.fill('Amsterdam, 1625');
		await name.blur();

		// **The Layer's own row is the barrier**, and it is the honest one: the write this test is about
		// is the one that creates the Layer, so the row cannot be on screen until the delayed
		// `manifest.json` read has resolved and that write has happened. A fixed sleep here was five
		// seconds spent waiting for a three-second delay, and it would have gone green early had the
		// delay ever been raised.
		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 15_000 });
		await expect(page.getByRole('status')).toHaveText('Saved here');

		// The Layer was made, and the rename survived it — on screen and in the file.
		const file = await projectJson(page, directory);
		expect(file.layers).toHaveLength(1);
		expect(file.name).toBe('Amsterdam, 1625');
		await expect(name).toHaveValue('Amsterdam, 1625');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam, 1625');
	});

	/**
	 * The link from the Project page is a way in of its own, and it used to be a broken one.
	 *
	 * Every other test in this file loads `/layers?p=…` directly, so a defect that only the client-side
	 * navigation reaches was invisible to the whole suite by construction — see {@link openLayers}. It
	 * needs a **local** Map Image on the Project page to reproduce, because that is what puts a
	 * warped layer on a Base Map pane that then has to be torn down: the pane the user is leaving removed
	 * its map first and asked it for a layer afterwards, `Map#getLayer` threw on a map with no style, and
	 * Svelte abandoned the rest of the destroy — and with it the mount of the pane being navigated to.
	 *
	 * **`pageerror` is asserted as well as the drawn count**, because the exception is the mechanism and
	 * asserting only the outcome would leave the next version of this failure free to arrive silently.
	 * And the stack is asked of MapLibre rather than of the app, for the reason the whole file does:
	 * MapLibre's layer order *is* the drawing.
	 *
	 * **The teardown is one hop further out** and is still exactly what this walks. The panes
	 * that have to come down are on `/align/`, so the trip is align → Project → Layers rather than
	 * Project → Layers, and it is the *first* hop that now destroys a Base Map carrying a warped layer.
	 * `pageerror` is watched across both.
	 */
	test('draws the stack when the pane is reached by the link from the Project page', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		// The pane that has to come down is the alignment route's, with a warped layer really on it —
		// so a seeded Workspace has to be driven there, and the warped render waited for, before the
		// hop this test is about can destroy anything.
		await openAlignment(page, directory);
		await expectWarpedDrawn(page);

		const crashes: string[] = [];
		page.on('pageerror', (error) => crashes.push(error.message));

		// Out of the alignment route, which is where the warped pane being torn down now lives.
		await page.getByTestId('back-to-project').click();
		await expect(addMapImageButton(page)).toBeVisible();
		await openLayers(page, directory, { via: 'link' });

		const layerId = (await rowIds(page))[0] as string;
		expect(await stackOrder(page)).toEqual([`ballastella-layer-${layerId}`]);
		// The handle exists at all, which is the symptom that was reported: no map, no stack, no handle.
		expect(await stackBuilds(page)).toBeGreaterThan(0);
		expect(crashes, 'the navigation threw while tearing the previous pane down').toEqual([]);
	});
});

/**
 * The reading room whose wifi answers the request and then never finishes it.
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
	// The service worker precaches this deployment's own bundled Base Map, and it answers a request
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
		await page.route(/\.pmtiles$/, () => undefined);
		await page.goto(`/?p=${directory}`);
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(rows(page)).toHaveCount(1);

		// The Layer's own row carries the reason, and the region still counts honestly.
		await expect(rows(page).first().getByTestId('layer-problem')).toContainText(
			'Base Map has not finished loading',
			{ timeout: 40_000 }
		);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');
	});
});

test.describe('showing and hiding a Layer', () => {
	test('draws the Map Image warped, and takes it off the map when hidden', async ({ page }) => {
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
});

test.describe('opacity on a map Layer', () => {
	test('reaches the renderer, is written, and comes back after a reload', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const layerId = (await rowIds(page))[0] as string;
		const builtBefore = await stackBuilds(page);

		// The slider is inside the open card since the Layers revision.
		await (await openLayerRow(page)).getByTestId('layer-opacity').fill('0.35');

		await expect(page.getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
		// ADR-0017 rule 1: dragging a slider must not tear the stack down and refetch every tile.
		expect(await stackBuilds(page), 'the stack was rebuilt by an opacity change').toBe(builtBefore);

		await expect(page.getByRole('status')).toHaveText('Saved here');
		expect((await projectJson(page, directory)).layers[0].opacity).toBeCloseTo(0.35, 5);

		await page.reload();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
			timeout: STACK_READY_MS
		});
		// Which card is open is display state and does not survive a reload (ADR-0002), so the readout
		// is reached by opening the card again. The *opacity* surviving is the claim; the card being
		// open is not, and asserting the readout on a collapsed row would confuse the two.
		await expect((await openLayerRow(page)).getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
	});

	// **A real pointer drag, not `fill()`.** `fill()` sets `value` and dispatches `input`
	// programmatically, so it cannot see the thing a user meets first: a pointer drag beginning on a
	// descendant of a `draggable` element can be claimed by the drag machinery instead of by the control
	// under the cursor. A slider thumb that will not move puts opacity out of reach by mouse, on the
	// platform ADR-0014 says authoring targets — and every test in this file would still be green.
	//
	// The card is opened first, because that is where the slider is: the redesign left a closed card
	// carrying the kind, the name, the toggle and the way in, and moved the opacity inside. **What this
	// guards did not move with it.** The drag source is now the handle rather than the whole card, but
	// the handle is in the *header* of the same `<li>` this slider is inside, so a `draggable` ancestor
	// claiming the gesture is still exactly the failure available to be reintroduced — and now
	// `setDragImage` reads the card during `dragstart` as well.
	test('the slider can be dragged with the mouse, not only set programmatically', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const layerId = (await rowIds(page))[0] as string;
		const row = await openLayerRow(page, 0);
		await expect(row.getByTestId('layer-opacity-value')).toHaveText('100%');

		const slider = row.getByTestId('layer-opacity');
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
		await expect(page.getByRole('status')).toHaveText('Saved here');
		expect((await projectJson(page, directory)).layers[0].opacity).toBeCloseTo(opacity, 5);
	});
});

test.describe('ordering, including across kinds (ADR-0002)', () => {
	/**
	 * A Project with a map Layer below an Annotation Layer that has a feature in it.
	 *
	 * The feature is written into the Layer's own `.geojson` behind the app's back, because the drawing
	 * tools are `editor-annotations.e2e.ts`'s subject and an Annotation Layer with nothing in it would
	 * make "it draws above the map" a claim about an empty layer. The polygon is
	 * deliberately enormous, so it is under the centre of the canvas wherever the Base Map happens to
	 * be looking.
	 *
	 * @param defaultStyle the Annotation Layer's style, written into `project.json` — the controls that
	 * would otherwise set it are the Annotation editor's
	 * @returns the Project directory and the two Layer ids, Annotation Layer first
	 */
	async function stackWithBothKinds(page: Page, defaultStyle: Record<string, unknown> = {}) {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved here');
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

		// Both are genuinely rendering: the Map Image has decoded tiles, and the Annotation
		// Layer's polygon is painted where we are about to compare them.
		expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);
		expect(await renderedAtCentre(page)).toContain(`ballastella-layer-${annotationId}-fill`);

		// MapLibre draws in this order, so "after" is "above". This is the mechanism, not a proxy for it.
		const above = await stackOrder(page);
		expect(above.indexOf(`ballastella-layer-${mapId}`)).toBeLessThan(
			above.indexOf(`ballastella-layer-${annotationId}-fill`)
		);

		// Reorder buttons are inside the open card since the Layers revision. The card follows the
		// Layer rather than the position, so it is still open after the move.
		await (await openLayerRow(page, rows(page).nth(0))).getByTestId('layer-move-down').click();
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const below = await stackOrder(page);
		expect(below.indexOf(`ballastella-layer-${annotationId}-fill`)).toBeLessThan(
			below.indexOf(`ballastella-layer-${mapId}`)
		);
		expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);
	});

	/**
	 * The case ADR-0002 actually names: an opaque label over the map it describes.
	 *
	 * The test above exercises translucent over translucent, and only that. A `WarpedMapLayer` is a
	 * MapLibre *custom* layer, so it always renders in the translucent pass; a `fill` at
	 * `fill-opacity: 1` renders in the **opaque** pass, which is a different pass with different
	 * ordering rules. Every polygon in this file inherits simplestyle's `fill-opacity: 0.6` default, so
	 * the pass an annotation Layer with a solid fill normally renders in was never covered. Asserted
	 * through `getLayersOrder()` and `queryRenderedFeatures`, not pixels.
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

		// Reorder buttons are inside the open card since the Layers revision. The card follows the
		// Layer rather than the position, so it is still open after the move.
		await (await openLayerRow(page, rows(page).nth(0))).getByTestId('layer-move-down').click();
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const below = await stackOrder(page);
		expect(below.indexOf(`ballastella-layer-${annotationId}-fill`)).toBeLessThan(
			below.indexOf(`ballastella-layer-${mapId}`)
		);
	});

	// ⚠ **Every claim in this describe about a *drag* stays here, and it was probed rather than
	// assumed**. happy-dom's `DragEvent` is not a `MouseEvent` and its constructor drops
	// both members these three tests turn on: `dataTransfer` comes back `undefined`, so
	// `dragTheWholeCard` takes its own early return and never calls `setDragImage` at all, and
	// `relatedTarget` comes back `undefined`, so every `dragleave` reads as a real departure and the
	// flicker fix below is unreachable. Dispatching a `MouseEvent` named `dragleave` would make them
	// pass, which is the working-around `vitest.config.ts` forbids: it would be a fake agreeing with a
	// fake about the one member the fake gets wrong. The drag ghost's *offset* needs real layout on top
	// of that, which no DOM implementation has.
	//
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

	// **What a user sees themselves dragging**, which is the half of a drag that no reorder assertion
	// touches: the order came out right the whole time this was broken, and what was wrong was that the
	// thing following the cursor was a picture of the six-dot handle rather than of the Layer.
	//
	// Asserted through `setDragImage`, because that is the only place the fact exists. A native drag
	// ghost is painted by the browser outside the page — it is in no screenshot, in no DOM, and
	// unreachable from the accessibility tree — so the observable contract is *which element was handed
	// to the browser to draw*, and the offset that keeps it under the pointer.
	test('drags a picture of the card, not of the handle', async ({ page }) => {
		await watchDragImages(page);
		const { annotationId } = await stackWithBothKinds(page);

		await rows(page).nth(0).getByTestId('layer-drag-handle').dragTo(rows(page).nth(1));

		const drawn = await page.evaluate(
			() => (window as unknown as DragWindow).ballastellaDragImages
		);
		expect(drawn).toHaveLength(1);
		const [image] = drawn as [DragImage];
		// The card of the Layer that was grabbed, rather than the handle inside it or the whole list.
		expect(image.testid).toBe('layer-row');
		expect(image.layerId).toBe(annotationId);
		// Held where it was picked up: the offset is inside the card, so the ghost hangs off the cursor
		// at the handle rather than snapping to a corner. The handle is at the card's left edge, near the
		// top, which is what makes these bounds tight enough to be worth asserting.
		expect(image.x).toBeGreaterThanOrEqual(0);
		expect(image.x).toBeLessThan(image.width / 2);
		expect(image.y).toBeGreaterThanOrEqual(0);
		expect(image.y).toBeLessThanOrEqual(image.height);
	});

	// **The drop target does not flicker while a Layer is held over it.**
	//
	// `dragleave` fires for every descendant and bubbles, so crossing from a card's padding onto the
	// text or the icon inside it used to clear the highlight and the next `dragover` put it back — once
	// per element crossed, on the part of the card a user is aiming at.
	//
	// Watched over time rather than asserted at the end, because the end state was never wrong: a single
	// `toHaveAttribute` after the gesture passed throughout. A `MutationObserver` on the attribute is
	// what makes the *number of changes* observable, which is what "flicker" is. Held over one card and
	// moved across three of its own descendants; one turning-on is the whole of what should be recorded.
	test('holding a Layer over a card highlights it once, without flickering', async ({ page }) => {
		const { annotationId, mapId } = await stackWithBothKinds(page);

		const target = rows(page).nth(1);
		await expect(target).toHaveAttribute('data-layer-id', mapId);
		await target.evaluate((element) => {
			const seen: string[] = [];
			(
				window as unknown as { ballastellaDropTargetChanges: string[] }
			).ballastellaDropTargetChanges = seen;
			new MutationObserver(() => {
				seen.push(element.getAttribute('data-drop-target') ?? 'missing');
			}).observe(element, { attributeFilter: ['data-drop-target'] });
		});

		// A real drag, paused over three separate descendants of the one card: its kind line, its name,
		// and its visibility toggle. `dragTo` would settle in the middle and cross nothing.
		const handle = rows(page).nth(0).getByTestId('layer-drag-handle');
		const grip = await handle.boundingBox();
		if (!grip) throw new Error('the drag handle has no box to drag from');
		await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
		await page.mouse.down();
		for (const testid of ['layer-kind', 'layer-name-text', 'layer-visible']) {
			const box = await target.getByTestId(testid).boundingBox();
			if (!box) throw new Error(`${testid} has no box to drag over`);
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
		}
		await expect(target).toHaveAttribute('data-drop-target', 'true');

		const changes = await page.evaluate(
			() =>
				(window as unknown as { ballastellaDropTargetChanges: string[] })
					.ballastellaDropTargetChanges
		);
		expect(
			changes,
			'the drop-target highlight changed more than once while the Layer was held over one card'
		).toEqual(['true']);

		// And the drop still lands, so this is a highlight that stopped flickering rather than a
		// `dragleave` that stopped working.
		await page.mouse.up();
		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-id', mapId);
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		await expect(target).toHaveAttribute('data-drop-target', 'false');
	});

	test('survives a reload', async ({ page }) => {
		const { directory, annotationId, mapId } = await stackWithBothKinds(page);

		// Reorder buttons are inside the open card since the Layers revision. The card follows the
		// Layer rather than the position, so it is still open after the move.
		await (await openLayerRow(page, rows(page).nth(0))).getByTestId('layer-move-down').click();
		await expect(page.getByRole('status')).toHaveText('Saved here');
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
		await expect(page.getByRole('status')).toHaveText('Saved here');

		const annotationId = (await rowIds(page))[0] as string;
		const alignmentFile = (await alignmentRefOf(page, directory)).split('/').at(-1) as string;
		await countFileReads(page);

		// The slider is inside the open card since the Layers revision, and only a map Layer has one.
		// **By kind, not by position**: this test puts an Annotation Layer on top, so row 0 has no
		// slider at all and opening it waits for a control that is never coming.
		await (await openLayerRow(page, mapRow(page))).getByTestId('layer-opacity').fill('0.4');
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('40%');
		// Renaming starts at the pencil in an open card since the Layers revision.
		const renaming = await openLayerRow(page, rows(page).nth(0));
		await renaming.getByTestId('layer-rename').click();
		await renaming.getByTestId('layer-name').fill('Trade routes');
		await renaming.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved here');
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

		// Renaming starts at the pencil in an open card since the Layers revision.
		const renaming = await openLayerRow(page);
		await renaming.getByTestId('layer-rename').click();
		await renaming.getByTestId('layer-name').fill('The 1625 plan');
		await renaming.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved here');

		expect((await projectJson(page, directory)).layers[0].name).toBe('The 1625 plan');
		expect(await readProjectFile(page, '', alignmentRef)).toBe(alignmentBefore);
	});

	// The name field's half of the same question as the opacity drag: `fill()` never presses a mouse
	// button, so it cannot see a text input inside a `draggable` row where a drag-select is claimed by
	// the drag machinery and the user cannot select a word to replace it.
	//
	// **This is now the sharpest version of that question, not a weaker one.** The field is reached by
	// opening the card and pressing the pencil, and it appears in the header — the same header that holds
	// the drag handle, a few pixels away. Making the header itself the drag source was considered for the
	// reorder ghost and rejected on exactly this test's grounds.
	test('a Layer’s name can be selected by dragging across it with the mouse', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const row = await openLayerRow(page, 0);
		await row.getByTestId('layer-rename').click();
		const field = row.getByTestId('layer-name');
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

	// ADR-0010: merely looking must not modify files. A review once found an `onblur` that
	// rewrote `project.json` with a fresh `updatedAt` on a focus-and-leave, and the Layer list has
	// three fields per row that could reintroduce it.
	test('tabbing through a Layer’s fields writes nothing at all', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		const before = await readProjectFile(page, directory, 'project.json');

		// The field exists only in an open card with the pencil pressed since the Layers revision, so
		// getting to it is two gestures — neither of which may write, which is this test's whole claim.
		const tabbing = await openLayerRow(page);
		await tabbing.getByTestId('layer-rename').click();
		await tabbing.getByTestId('layer-name').focus();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await expect(page.getByRole('status')).toHaveText('Saved here');

		expect(await readProjectFile(page, directory, 'project.json')).toBe(before);
	});
});

// ADR-0014 records image-space annotation as the expected next feature, so a build from before that
// kind existed has to open a colleague's Project, reorder it, and save without destroying the Layer
// it cannot draw.
//
// ⚠ **What is left here is the wiring, and that is the whole of why it stays.** What such a row
// *says* — the kind it declares, the sentence its open card carries, that neither drawable kind's
// contents are rendered into it, that it can still be renamed and moved — moved to
// `packages/ui/src/layer-list.dom.test.ts`'s `a Layer kind this build has never heard of
// (ADR-0014)`, where it is asserted in milliseconds against a `ForeignLayer` handed
// straight to the component. What `parseLayers` and `serialiseLayers` do with an unknown kind has
// its own tests in `packages/core/src/project/layer.test.ts`.
//
// This test is neither of those and cannot be replaced by both: it is the one place that asks
// whether a foreign kind survives the *journey* — off disk, through the parser, into a row that
// really rendered, past a renderer that really skipped it while drawing the map below it, through
// two edits made with a pointer, and back onto disk with its unknown field intact. A Seam 1c test
// cannot fail because the application forgot to wire the component up; this one can.
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

		// It really rendered as a row of its own kind — the parser's `foreign` reached the markup — and
		// the map Layer below it still drew, so the kind was skipped at the render boundary rather than
		// throwing. What that row *says* is `layer-list.dom.test.ts`'s.
		await expect(rows(page)).toHaveCount(2);
		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-kind', 'foreign');
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');

		// Renaming starts at the pencil in an open card since the Layers revision.
		const renamingForeign = await openLayerRow(page, rows(page).nth(0));
		// **The one says-claim that stays here, and it is a positive control.** What becomes of a foreign
		// Layer is the editor's own sentence — `packages/ui` may not import from `apps/` (ADR-0034), so
		// the shared card is handed it as a snippet and cannot hold these words. `e2e/viewer-reader.e2e.ts`
		// asserts a Reader is told none of it; without this line that absence could pass by the sentence
		// having quietly gone everywhere.
		await expect(renamingForeign.getByTestId('layer-foreign-note')).toContainText(
			'you can still rename it, hide it, and move it in the stack'
		);
		await renamingForeign.getByTestId('layer-rename').click();
		await renamingForeign.getByTestId('layer-name').fill('The cartouche');
		await renamingForeign.getByTestId('layer-name').blur();
		// Reorder buttons are inside the open card since the Layers revision. The card follows the
		// Layer rather than the position, so it is still open after the move.
		await (await openLayerRow(page, rows(page).nth(0))).getByTestId('layer-move-down').click();
		await expect(page.getByRole('status')).toHaveText('Saved here');

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

test.describe('adding an Annotation Layer', () => {
	/**
	 * Two clicks, two Layers — the same stale-snapshot failure as `#ensureMapLayer`, found by a test
	 * that clicked twice and flaked.
	 *
	 * `addAnnotationLayer` writes the empty `FeatureCollection` before the Layer that references it, on
	 * purpose: a `geojsonRef` naming nothing is a Project an import refuses. But it read
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
		await expect(page.getByRole('status')).toHaveText('Saved here');

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

test.describe('leaving the Project screen and coming back', () => {
	/**
	 * The round trip the stack is *for*: notice a Map Image sitting crooked, go and fix it, come
	 * back and look again.
	 *
	 * This used to be "the Layers pane links back to its Project", because the two were different
	 * pages. They are one, so the hop that remains is the one that was always the point —
	 * Project → Align → Project — and it is the hop that carries the defect: leaving took the stack
	 * off a map that had already been removed, `Map#getLayer` threw, and Svelte abandoned the rest of
	 * the flush. **`pageerror` is the whole signal**, because the screen's markup is derived state
	 * rather than effects and rendered anyway; only its effects were skipped.
	 */
	test('goes to Align from the Layer and lands back on the same Project', async ({ page }) => {
		const directory = await alignedProject(page);
		const crashes: string[] = [];
		page.on('pageerror', (error) => crashes.push(error.message));
		await openLayers(page, directory);

		await alignFromLayer(page, rows(page).first());
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();

		await page.getByTestId('back-to-project').click();

		// *This* Project rather than the hub: its own name, its own Layer, and the stack drawn again.
		await expect(page).toHaveURL(new RegExp(`\\?p=${directory}$`));
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
			timeout: STACK_READY_MS
		});

		expect(crashes, 'the round trip threw while taking the stack off the map').toEqual([]);
	});
});

test.describe('the Layer list reaches assistive technology', () => {
	test('every control of every Layer is reachable with the keyboard', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);

		// ═════════════════════════════════════════════════════════════════════════════════════════
		// REACHABLE **PER OPEN CARD** — a decision of 2026-08-11, not an accident of this rewrite.
		//
		// This walk used to be one flat list across both rows, and the Layers revision made that
		// impossible rather than merely wrong: the in-card controls exist only while their card is
		// open, and the disclosure is an accordion (`openLayerId` holds one id), so both rows' cards
		// are never in the tab order at the same time.
		//
		// So reordering by keyboard now costs an extra step that reordering by pointer does not — a
		// mouse user drags `layer-drag-handle` on the *collapsed* row, and that handle is a
		// `<span draggable aria-hidden>` with no key handling, so there is no keyboard path on a
		// closed row at all. **That asymmetry was put to a human and accepted**: keyboard users
		// expand, pointer users drag. It is written here because a version of this test that quietly
		// added an `openLayerRow` call would weaken keyboard reachability without anybody deciding to.
		//
		// What that still requires, and what is asserted below: every control is *reachable*
		// with the keyboard, the disclosure that opens a card included — it is a plain `<button>`
		// precisely so that opening a Layer needs nothing added to be keyboard-operable.
		// ═════════════════════════════════════════════════════════════════════════════════════════

		/**
		 * What a closed row offers, in document order. Reachable without opening anything.
		 *
		 * The disclosure is **last** because it is last in the markup — `layer-visible` is at
		 * `LayerList.svelte:711` and the disclosure at `:736` — and because the walk then leaves focus
		 * exactly where the `Enter` below needs it. Listing it first put focus on a checkbox, where
		 * `Enter` does nothing and the card stayed shut.
		 */
		const onTheRow = ['layer-visible', 'layer-disclosure'];

		/**
		 * What each row's open card offers, in document order.
		 *
		 * Per row, because the reorder button that would run off the end of the stack is `disabled`
		 * and so out of the tab order on purpose — "the top Layer cannot go higher" is a disabled
		 * button. `layer-rename` rather than `layer-name`: the field is behind the pencil since the
		 * revision, and the pencil is the control the keyboard has to reach.
		 */
		const inTheCard: string[][] = [
			// The delete, which is the one control here that cannot be shrugged off — so it has
			// to be on the keyboard path, and the undo that makes it safe has one of its own.
			['layer-rename', 'layer-move-down', 'layer-delete'],
			['layer-rename', 'layer-move-up', 'layer-delete', 'layer-opacity']
		];

		for (const [index, card] of inTheCard.entries()) {
			const row = rows(page).nth(index);

			// The closed row first, from the top of the document each time: this is a fresh walk, not a
			// continuation of the previous row's.
			await page.keyboard.press('Tab');
			for (const control of onTheRow) {
				await tabTo(page, row.getByTestId(control), `row ${index} ${control}`);
			}

			// Opened *with the keyboard*, from the disclosure the walk has just reached — which is the
			// whole of the extra step, and it is asserted rather than assumed.
			await page.keyboard.press('Enter');
			await expect(row.getByTestId('layer-disclosure')).toHaveAttribute('aria-expanded', 'true');

			for (const control of card) {
				await tabTo(page, row.getByTestId(control), `row ${index} ${control}`);
			}
			// Reaching the last one means every one before it was on the way, in order; asserting it
			// explicitly is what makes the loop above a claim rather than a walk.
			await expect(row.getByTestId(card.at(-1) as string)).toBeFocused();
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// ONE LAYER OPENS AT A TIME
//
// A Project is a stack of Layers and a Layer opens to reveal what is inside it. What a *closed* row
// still shows is the load-bearing half: the name, the visibility toggle, and whatever the Layer is
// warning about — because "this Map Image needs aligning" is the state a scholar has to be able
// to notice **without opening anything**.
//
// ⚠ **The position controls used to be on that list and are not any more.** The Layers revision moved
// `layer-move-up` and `layer-move-down` inside the card, which leaves reordering asymmetric: a pointer
// user drags `layer-drag-handle` on the closed row, while a keyboard user opens the card first — the
// handle is a `<span draggable aria-hidden>` with no key handling, so there is no keyboard path on a
// closed row at all.
//
// **That asymmetry was put to a human and accepted on 2026-08-11**: keyboard users expand, pointer
// users drag. It is written here because this paragraph said the opposite for a while, and prose that
// contradicts the code is worse than no prose — the next reader believes it. Keyboard reachability is
// therefore read as *reachable per open card*, and `every control of every Layer is reachable with the
// keyboard` says so in its own comment rather than encoding it by accident.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe('one Layer opens at a time', () => {
	/** What an unaligned map Layer says about itself, in the sidebar, once. */
	const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';

	const disclosure = (page: Page, at: number) => rows(page).nth(at).getByTestId('layer-disclosure');

	/**
	 * The criterion the whole "closed rows stay useful" contract exists for.
	 *
	 * Asserted on the row's **accessible text with the row still closed**, which is two claims at
	 * once: that a user can see the map needs aligning without opening anything, and that the state is
	 * information rather than a colour. A `class:text-warning` implementation passes a `toBeVisible`
	 * and fails this, because a class contributes no characters.
	 */
	test('a closed map Layer row says it is not aligned, as text and not as a colour', async ({
		page
	}) => {
		const directory = await projectWithImage(page);
		await openLayers(page, directory, { drawn: 0 });
		// After the documents have been read: every Layer starts with none in hand, and a Layer with no
		// Alignment reads as not aligned too — so asserting on the first paint would go green on the
		// state that exists before anything has been opened.
		await expect(rows(page).first().getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);

		const row = rows(page).first();
		await expect(row.getByTestId('layer-disclosure')).toHaveAttribute('aria-expanded', 'false');
		expect(await accessibleText(row)).toContain(NOT_ALIGNED);

		// And it is still said inside the open row, beside the button that answers it. One sentence,
		// computed once, so the two cannot drift.
		const open = await openLayerRow(page, 0);
		await expect(open.getByTestId('layer-not-aligned')).toHaveText(NOT_ALIGNED);
		expect(await accessibleText(row)).toContain(NOT_ALIGNED);
	});

	/**
	 * An element may only ever say the thing its id names.
	 *
	 * An Alignment file that is *there and unreadable* is not a map that needs aligning: it is work the
	 * user made that is not on screen, and the two want different actions. The first cut of the open
	 * row rendered any `refused` outcome under an id reading "alignment state", which announced the
	 * second as the first — the mislabelling this file has been paying for elsewhere.
	 *
	 * Narrowing to the derived not-aligned set was **not** enough and that is the interesting half: a
	 * Layer whose Alignment cannot be read has no document at all, and "no document" counts as not
	 * aligned. Only the *reported* outcome carries the precedence between the three, so only it can be
	 * asked. Both halves are asserted here — the row says the true thing under the generic id, and says
	 * nothing at all under the specific one.
	 */
	test('an Alignment that cannot be read is not announced as a map needing alignment', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		const alignmentRef = await alignmentRefOf(page, directory);

		// Corrupt it behind the app's back. A hand-edited or half-written Workspace is the only way to
		// reach this state, which is exactly why it has to be seeded rather than driven.
		// alignment-write-is-the-fixture: the unreadable Alignment this labelling test is about
		await writeProjectFile(page, '', alignmentRef, '{ this is not JSON');

		// Nothing is drawn, because the file the Layer draws from cannot be parsed.
		await openLayers(page, directory, { drawn: 0 });

		const row = rows(page).first();
		const problem = row.getByTestId('layer-problem');
		// The generic slot says what actually happened, and it is not the not-aligned sentence.
		await expect(problem).not.toHaveText('');
		await expect(problem).not.toContainText('Not aligned yet');
		// It is real text in the accessibility tree rather than a colour, on the closed row.
		expect(await accessibleText(row)).not.toContain('Not aligned yet');

		// And the open row does not claim the map merely needs aligning.
		const open = await openLayerRow(page, 0);
		await expect(open.getByTestId('layer-not-aligned')).toHaveCount(0);
		// The Align button is still there, because aligning is still the thing to do about a map with a
		// broken Alignment — this is about what is *said*, not about what is offered.
		await expect(open.getByTestId('align-map-image')).toHaveCount(1);
	});

	/**
	 * **Kept as the wiring for `layer-list.dom.test.ts`'s `draws each kind’s contents in its own open
	 * card and in no other`**. That the card renders `mapContents` only when it is open and
	 * only for a map Layer is the component's, and is asserted there in milliseconds against a marker
	 * snippet. That the snippet the *application* passes is this link, with a `(directory, layer id)`
	 * pair that is true together, is not derivable from anything `LayerList` is handed: the directory
	 * comes from `session.openDirectory` and the id from a Layer read off disk, which is the pair
	 * `alignLink` exists to keep from drifting. So this is a Seam 2 test and the other is a Seam 1c
	 * test asserting the same sentence, which this repository's testing decisions do not count as a
	 * duplicate.
	 */
	test("the Layer's own Align is inside it, and is not on the screen until it is opened", async ({
		page
	}) => {
		const directory = await projectWithImage(page);
		await openLayers(page, directory, { drawn: 0 });

		// Closed, the row's own Align is not on the screen — which is what makes every other spec's
		// `openLayerRow` a step the user really takes rather than a formality. The "Align now" beside the
		// not-aligned sentence is a different affordance under a different id, and has its own spec below.
		await expect(page.getByTestId('align-map-image')).toHaveCount(0);

		const row = await openLayerRow(page, 0);
		const align = row.getByTestId('align-map-image');
		await expect(align).toHaveRole('link');
		const layerId = (await projectJson(page, directory)).layers[0].id as string;
		expect(await align.getAttribute('href')).toContain(`?p=${directory}&layer=${layerId}`);
		expect(await align.getAttribute('href')).toMatch(/\/align\/?\?p=/);
	});

	/**
	 * The closed row's warning answers itself.
	 *
	 * "Not aligned yet" is on the closed row so a scholar can notice it without opening anything — and a
	 * state worth noticing there is worth acting on there. Before this, noticing was all they could do:
	 * the control the sentence describes was a disclosure away.
	 *
	 * The href is asserted, not just the presence, because this link and the open row's carry the same
	 * `(directory, layer id)` pair out of one snippet, and the way that goes wrong is a pair that is
	 * individually plausible and never true together.
	 *
	 * **Kept as the wiring for `layer-list.dom.test.ts`'s `draws the problem action beside the sentence
	 * of a Layer that was refused`**. That the card renders a `problemAction` beside a
	 * refused Layer's sentence, and only there, is the component's. That the screen answers *this*
	 * refusal with an Align, and where that Align goes, is the screen's — and only a real Project on
	 * disk, unaligned, produces the refusal that decides it.
	 */
	test('a closed, unaligned map Layer offers Align now beside the sentence', async ({ page }) => {
		const directory = await projectWithImage(page);
		await openLayers(page, directory, { drawn: 0 });

		const row = rows(page).first();
		await expect(row.getByTestId('layer-problem')).toHaveText(NOT_ALIGNED);
		// Still closed: the point is that nothing had to be opened.
		await expect(row.getByTestId('layer-disclosure')).toHaveAttribute('aria-expanded', 'false');

		const now = row.getByTestId('align-map-image-now');
		await expect(now).toHaveRole('link');
		await expect(now).toHaveText('Align now');
		const layerId = (await projectJson(page, directory)).layers[0].id as string;
		expect(await now.getAttribute('href')).toContain(`?p=${directory}&layer=${layerId}`);

		// And it goes where it says it goes, without the row ever being opened.
		await now.click();
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		expect(new URL(page.url()).searchParams.get('layer')).toBe(layerId);
	});

	// **Retired: `a closed, aligned map Layer offers no Align now`.** Two claims, and
	// neither of them needed a Project on disk. That a Layer which drew carries no `problemAction` at
	// all — the negative that matters, since the closed row is the one place on the screen where an
	// Align could appear for every Layer in the stack at once — is
	// `layer-list.dom.test.ts`'s `draws no problem action for a Layer that drew`, asserted against a
	// snippet the harness supplies unconditionally, so it is the *card's* refusal to ask rather than
	// the screen's refusal to answer. That an aligned Layer has no `layer-problem` band is still
	// asserted here, by `an aligned map Layer never claims it needs aligning, hidden or shown` below,
	// which is where it belongs: the outcome comes from a real renderer reading a real Alignment.

	/**
	 * The same narrowing the open row makes, made here: an Alignment that is *there and unreadable* is
	 * work the user made that is not on screen, and offering "Align now" as the answer to it would be
	 * this row's version of announcing one failure as another.
	 *
	 * The row still warns — under the generic id, which claims nothing in particular — and the Layer's
	 * own Align inside the open row is still there, because aligning remains a thing you may do about a
	 * broken Alignment. What is withheld is the *sentence's* answer, since it is not that sentence.
	 */
	test('an unreadable Alignment gets no Align now on the closed row', async ({ page }) => {
		const directory = await alignedProject(page);
		const alignmentRef = await alignmentRefOf(page, directory);
		// alignment-write-is-the-fixture: the unreadable Alignment this narrowing test is about
		await writeProjectFile(page, '', alignmentRef, '{ this is not JSON');
		await openLayers(page, directory, { drawn: 0 });

		const row = rows(page).first();
		await expect(row.getByTestId('layer-problem')).not.toHaveText('');
		await expect(row.getByTestId('align-map-image-now')).toHaveCount(0);
		await expect((await openLayerRow(page, 0)).getByTestId('align-map-image')).toHaveCount(1);
	});

	/**
	 * The negative half, and it is about a Layer's *visibility* rather than its Alignment.
	 *
	 * "Not aligned yet" is about where the Map Image sits on the earth, and a Layer does not
	 * become aligned, or stop being, by being ticked — so an aligned Layer must say nothing about
	 * needing alignment whether it is shown or hidden. Hiding one takes it off the map and out of what
	 * the renderer reports, which is precisely the way this could go wrong.
	 *
	 * Nothing asserts a positive "Aligned" sentence, because there is none: what the interface offers
	 * is the warning state and the Align button, and an unrequested line claiming success is UI the
	 * Layer stack has no business adding.
	 */
	test('an aligned map Layer never claims it needs aligning, hidden or shown', async ({ page }) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);

		const row = await openLayerRow(page, 0);
		await expect(row.getByTestId('layer-not-aligned')).toHaveCount(0);
		await expect(row.getByTestId('layer-problem')).toHaveCount(0);
		expect(await accessibleText(rows(page).first())).not.toContain('Not aligned yet');

		await row.getByTestId('layer-visible').uncheck();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await expect(row.getByTestId('layer-not-aligned')).toHaveCount(0);
		expect(await accessibleText(rows(page).first())).not.toContain('Not aligned yet');
	});

	/**
	 * ADR-0002 and ADR-0010: which Layer somebody happened to have open is not part of their work.
	 *
	 * Three assertions, and each rules out a different way of getting this wrong. The **write spy** is
	 * the one that matters: a byte comparison of `project.json` cannot tell "nothing was written" from
	 * "the same bytes were written again", and a write on a click that changed nothing is exactly what
	 * ADR-0010 forbids. `localStorage` is checked because it is the other place a preference would
	 * plausibly be put, and the document is searched for the Layer id because a field with any name at
	 * all would carry it.
	 */
	test('opening a Layer writes nothing, and is nowhere in project.json or localStorage', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved here');

		const before = await readProjectFile(page, directory, 'project.json');
		const storageBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));
		await countFileWrites(page);

		const openId = (await rowIds(page))[0] as string;
		await openLayerRow(page, 0);
		await openLayerRow(page, 1);
		await disclosure(page, 1).click();
		await expect(page.getByTestId('layer-contents')).toHaveCount(0);
		// Long enough for autosave's 400 ms debounce to have fired if anything had queued one
		// (ADR-0017 rule 2), so this is "no write happened" rather than "no write has happened yet".
		await page.waitForTimeout(1500);

		expect(await fileWrites(page), 'opening a Layer wrote to the store').toEqual([]);
		expect(await readProjectFile(page, directory, 'project.json')).toBe(before);
		expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(storageBefore);

		// And no field of the document names the Layer that was open, whatever it might be called: the
		// id appears exactly once, as that Layer's own `id`.
		expect(
			before.split(`"${openId}"`).length - 1,
			'the open Layer id appears more than once, so something beside the Layer itself names it'
		).toBe(1);
	});
});

test.describe('a Label obeys its Annotation Layer', () => {
	/**
	 * MapLibre alone can show that hiding the Layer removes its paint; only a Map Image has an opacity
	 * slider, so its change is the neighbouring control that must not disturb Annotation paint.
	 */
	test('counts with every kind, follows visibility, and is untouched by a Map Image opacity change', async ({
		page
	}) => {
		const directory = await alignedProject(page);
		await openLayers(page, directory);
		await page.getByTestId('add-annotation-layer').click();
		await expect(rows(page)).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved here');

		const [annotationLayerId, mapLayerId] = (await rowIds(page)) as [string, string];
		await writeProjectFile(
			page,
			directory,
			`annotations/${annotationLayerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'pin',
						properties: { title: 'The harbour' },
						geometry: { type: 'Point', coordinates: [4.76, 52.43] }
					},
					{
						type: 'Feature',
						id: 'label',
						properties: {
							'marker-symbol': 'label',
							'marker-color': '#d32f2f',
							fill: '#1976d2'
						},
						geometry: { type: 'Point', coordinates: [4.9, 52.37] }
					},
					{
						type: 'Feature',
						id: 'line',
						properties: { title: 'The route' },
						geometry: {
							type: 'LineString',
							coordinates: [
								[4.82, 52.32],
								[4.98, 52.34]
							]
						}
					},
					{
						type: 'Feature',
						id: 'shape',
						properties: { title: 'The parish' },
						geometry: {
							type: 'Polygon',
							coordinates: [
								[
									[4.78, 52.48],
									[4.88, 52.48],
									[4.83, 52.42],
									[4.78, 52.48]
								]
							]
						}
					}
				]
			})
		);

		await openLayers(page, directory, { drawn: 2 });
		await centreOnAmsterdam(page);
		await waitForPaintedAnnotations(page, ['pin', 'line', 'shape']);

		const annotationRow = page.locator(
			`[data-testid="layer-row"][data-layer-id="${annotationLayerId}"]`
		);
		await openLayerRow(page, annotationRow);
		await expect(page.locator('#annotation-list-caption')).toHaveText('4 Annotations');
		await expect(
			annotationRow.getByTestId('layer-contents').getByTestId('layer-opacity')
		).toHaveCount(0);

		await selectAnnotation(page, 1);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Zuiderzee');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved here');
		await expect(page.locator('#annotation-list-caption')).toHaveText('4 Annotations');
		await waitForPaintedAnnotations(page, ['label']);

		const mapRow = page.locator(`[data-testid="layer-row"][data-layer-id="${mapLayerId}"]`);
		const mapContents = await openLayerRow(page, mapRow);
		await expect(mapContents.getByTestId('layer-opacity')).toHaveCount(1);
		const labelBucket = `ballastella-layer-${annotationLayerId}-label`;
		const pointBucket = `ballastella-layer-${annotationLayerId}-point`;
		const beforeLabelOpacity = await paintProperty(page, labelBucket, 'icon-opacity');
		const beforePointOpacity = await paintProperty(page, pointBucket, 'icon-opacity');
		expect(beforeLabelOpacity).not.toBeNull();
		// Pins carry no opacity: an Annotation Layer either shows them or hides them.
		expect(beforePointOpacity).toBeNull();

		await mapContents.getByTestId('layer-opacity').fill('0.35');
		await expect(page.getByRole('status')).toHaveText('Saved here');
		expect(await warpedOpacity(page, mapLayerId)).toBeCloseTo(0.35, 5);

		await waitForPaintedAnnotations(page, ['pin', 'line', 'shape', 'label']);
		expect(await paintProperty(page, labelBucket, 'icon-opacity')).toEqual(beforeLabelOpacity);
		expect(await paintProperty(page, pointBucket, 'icon-opacity')).toEqual(beforePointOpacity);

		await annotationRow.getByTestId('layer-visible').uncheck();
		await expect
			.poll(async () => {
				const painted = await renderedAnnotationLayers(page);
				return ['pin', 'label', 'line', 'shape'].filter((id) => id in painted);
			})
			.toEqual([]);

		await annotationRow.getByTestId('layer-visible').check();
		await waitForPaintedAnnotations(page, ['pin', 'label', 'line', 'shape']);
	});
});
