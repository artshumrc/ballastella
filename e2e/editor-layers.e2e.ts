import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';

import { expectWarpedDrawn, gradientPng } from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import {
	addMapImageButton,
	expectNothingPreparing,
	pickMapImageFile
} from './support/map-images.js';
import {
	PROJECT_DIRECTORY,
	centreOnAmsterdam,
	editAnnotationText,
	hashesUnder,
	paintProperty,
	pointFeature,
	projectJson,
	readProjectFile,
	renderedAnnotationLayers,
	selectAnnotation,
	stackBuilds,
	waitForOpeningView,
	waitForPaintedAnnotations,
	writeAnnotations,
	writeProjectFile,
	clickAt,
	createProject
} from './support/annotations.js';
import { alignFromLayer, openLayerRow } from './support/layers.js';
import { projectNameField } from './support/project-screen.js';
import { countFileReads, countFileWrites, fileReads, fileWrites } from './support/store-traffic.js';
import { restoreWorkspace, snapshotWorkspace } from './support/workspace-snapshot.js';
import { delayReadsOf } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

declare global {
	interface Window {
		ballastellaLayerStack?: {
			map: {
				getLayersOrder(): string[];
				fitBounds(bounds: unknown, options?: unknown): void;
				queryRenderedFeatures(point?: unknown, options?: unknown): { layer: { id: string } }[];
				getCanvas(): { width: number; height: number };
				loaded(): boolean;
			};
			warped: Record<
				string,
				{
					getBounds(): unknown;
					getOpacity(): number;
					renderer?: { tileCache?: { getCachedTiles?(): unknown[] } };
				}
			>;
			builds: number;
		};
	}
}

const accessibleText = (row: Locator): Promise<string> =>
	row.evaluate((element) => {
		const clone = element.cloneNode(true) as HTMLElement;
		for (const hidden of clone.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
		return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
	});

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

const storedImageIds = (page: Page): Promise<string[]> =>
	page.evaluate(async () => {
		const root = await workspaceRoot();
		const images = await root.getDirectoryHandle('images');
		const names: string[] = [];
		for await (const name of images.keys()) names.push(name);
		return names;
	});

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
			} catch {}
		}
		return null;
	});

const writeProjectJson = (page: Page, file: unknown): Promise<void> =>
	writeProjectFile(page, 'project.json', `${JSON.stringify(file, null, '\t')}\n`);

/**
 * An empty Project, open, with nothing added to it yet.
 *
 * Split out of {@link projectWithImage} because adding the Map Image is now itself the thing
 * under test in two places — the write it can fail on and the window it can lose a rename in — and
 * both of those have to arrange something *before* the file is picked.
 */
async function emptyProject(page: Page): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page, 'Amsterdam 1625');
	await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
	await expect(addMapImageButton(page)).toBeVisible();
}

const pickLaFloride = (page: Page) =>
	pickMapImageFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});

async function addMapImage(page: Page): Promise<void> {
	await pickLaFloride(page);
	await expect.poll(() => completedPyramid(page), { timeout: 30_000 }).not.toBeNull();
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
 */
async function projectWithImageThroughTheInterface(page: Page): Promise<void> {
	await emptyProject(page);
	await addMapImage(page);
	await expect(page.getByRole('status')).toHaveText('Saved here');
}

async function openAlignment(page: Page): Promise<void> {
	await page.goto(`/?p=${PROJECT_DIRECTORY}`);
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await alignFromLayer(page);
	await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
	await expect(page.getByTestId('image-pane')).toBeVisible();
}

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
 */
async function alignedProjectThroughTheInterface(page: Page): Promise<void> {
	await projectWithImageThroughTheInterface(page);
	await openAlignment(page);
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');

	for (const [fx, fy] of [
		[0.3, 0.3],
		[0.7, 0.35],
		[0.5, 0.7]
	] as const) {
		await pairAt(page, fx, fy);
	}
	await expectWarpedDrawn(page);
	await expect(page.getByRole('status')).toHaveText('Saved here');
}

const mapLayer = async (page: Page) =>
	(await projectJson(page)).layers.find((entry: { kind: string }) => entry.kind === 'map');

async function seededWorkspace(
	page: Page,
	name: string,
	capture: (page: Page) => Promise<void>
): Promise<void> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, name, async (fresh) => {
		await capture(fresh);
		const { imageId, id } = await mapLayer(fresh);
		return { imageId, layerId: id };
	});
	await restoreWorkspace(page, snapshot.files);
}

const projectWithImage = (page: Page): Promise<void> =>
	seededWorkspace(page, 'layers-with-image', projectWithImageThroughTheInterface);

const alignedProject = (page: Page): Promise<void> =>
	seededWorkspace(page, 'layers-aligned', alignedProjectThroughTheInterface);

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
	{ drawn = 1, via = 'load' }: { drawn?: number; via?: 'load' | 'link' } = {}
): Promise<void> {
	if (via === 'load') await page.goto(`/?p=${PROJECT_DIRECTORY}`);
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expectDrawn(page, drawn, STACK_READY_MS);
	await waitForOpeningView(page);
}

const expectDrawn = (page: Page, drawn: number, timeout?: number) =>
	expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(drawn), {
		timeout
	});

const expectSaved = (page: Page) => expect(page.getByRole('status')).toHaveText('Saved here');

const rows = (page: Page) => page.getByTestId('layer-row');

async function addAnnotationLayer(page: Page): Promise<void> {
	await page.getByTestId('add-annotation-layer').click();
	await expect(rows(page)).toHaveCount(2);
}

type HeaderForeground = {
	control: string;
	opacity: string;
	color: string;
	ink: string;
};

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
	await projectWithImage(page);
	await openLayers(page, { drawn: 0 });
	await addAnnotationLayer(page);

	for (const theme of ['carto-light', 'bumblebee']) {
		const foregrounds = await headerForegrounds(page, theme);
		expect(foregrounds, theme).toHaveLength(6);
		for (const foreground of foregrounds) {
			expect(foreground.opacity, `${theme} ${foreground.control} opacity`).toBe('1');
			expect(foreground.color, `${theme} ${foreground.control} colour`).toBe(foreground.ink);
		}
	}
});

const stackOrder = async (page: Page): Promise<string[]> =>
	(await page.evaluate(() => window.ballastellaLayerStack?.map.getLayersOrder() ?? [])).filter(
		(id) => id.startsWith('ballastella-layer-')
	);

const WARPED_TILE_WAIT_MS = 30_000;

const warpedTiles = (page: Page, layerId: string): Promise<number> =>
	page.evaluate(
		async ([id, ceiling]) => {
			const live = () => window.ballastellaLayerStack?.warped[id as string];
			const cached = () => {
				const layer = live();
				return layer === undefined
					? -1
					: (layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
			};

			let framed: unknown;
			for (let waited = 0; waited <= (ceiling as number); waited += 200) {
				const layer = live();
				if (layer !== undefined && layer !== framed) {
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

const rowIds = (page: Page): Promise<(string | null)[]> =>
	rows(page).evaluateAll((elements) =>
		elements.map((element) => element.getAttribute('data-layer-id'))
	);

const firstLayerId = async (page: Page): Promise<string> => (await rowIds(page))[0] as string;

interface DragImage {
	testid: string | null;
	layerId: string | null;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface DragWindow {
	ballastellaDragImages: DragImage[];
}

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

async function tabTo(page: Page, target: Locator, what: string): Promise<void> {
	for (let press = 0; press < 200; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

async function rename(row: Locator, name: string): Promise<void> {
	await row.getByTestId('layer-rename').click();
	await row.getByTestId('layer-name').fill(name);
	await row.getByTestId('layer-name').blur();
}

const layerRow = (page: Page, id: string) =>
	page.locator(`[data-testid="layer-row"][data-layer-id="${id}"]`);

const mapRow = (page: Page) => page.locator('[data-testid="layer-row"][data-layer-kind="map"]');

const alignmentRefOf = async (page: Page): Promise<string> =>
	`alignments/${(await mapLayer(page)).imageId}.json`;

const NOT_ALIGNED = 'Not aligned yet, so there is nothing to draw.';

test.describe('a Layer for a Map Image that has just been added', () => {
	test('adding a Map Image produces a kind: map Layer in project.json, with no Control Point', async ({
		page
	}) => {
		await projectWithImageThroughTheInterface(page);
		const file = await projectJson(page);
		expect(file.layers).toHaveLength(1);
		expect(file.layers[0]).toMatchObject({
			kind: 'map',
			name: 'la-floride.png',
			visible: true,
			order: 0,
			opacity: 1
		});
		expect(file.layers[0].imageId).toMatch(/^[a-z0-9]+$/i);
		expect(file.layers[0].alignmentRef).toBeUndefined();
		expect(file.layers[0].imageMode).toBeUndefined();
		expect(typeof file.layers[0].id).toBe('string');
		expect(file.layers[0].id).not.toBe('');

		const alignmentRef = `alignments/${file.layers[0].imageId}.json`;
		const alignment = JSON.parse(await readProjectFile(page, alignmentRef, ''));
		expect(alignment.type).toBe('Annotation');
		expect(alignment.body?.features ?? []).toHaveLength(0);
		expect(alignment.target?.selector?.value).toBe(
			'<svg width="700" height="500"><polygon points="0,0 700,0 700,500 0,500" /></svg>'
		);

		await expect(readProjectFile(page, alignmentRef)).rejects.toThrow();
	});

	test('does not create the Layer when the starter Alignment could not be written', async ({
		page
	}) => {
		await emptyProject(page);
		await failWritesUnderAlignments(page);

		await addMapImage(page);

		await expect(page.getByTestId('layer-row')).toHaveCount(0);
		expect((await projectJson(page)).layers).toEqual([]);
		expect(await storedImageIds(page)).toHaveLength(1);
		await expect(
			readProjectFile(page, `alignments/${(await storedImageIds(page))[0]}.json`, '')
		).rejects.toThrow();
		await expect(page.getByText('Quota exceeded')).toBeVisible();

		await expect(page.getByTestId('align-map-image')).toHaveCount(0);
		await expect(page.getByTestId('align-map-image-now')).toHaveCount(0);
		await expect(page.getByText('This Project has no Map Images yet.')).toBeVisible();
	});

	test('making the Layer does not discard a Project rename made while it was being made', async ({
		page
	}) => {
		await emptyProject(page);
		await delayReadsOf(page, 'manifest.json', 3000);

		await pickLaFloride(page);
		await expect
			.poll(() => completedPyramid(page), { timeout: 30_000, intervals: [50] })
			.not.toBeNull();
		const name = await projectNameField(page);
		await name.fill('Amsterdam, 1625');
		await name.blur();

		await expect(page.getByTestId('layer-row')).toHaveCount(1, { timeout: 15_000 });
		await expectSaved(page);

		const file = await projectJson(page);
		expect(file.layers).toHaveLength(1);
		expect(file.name).toBe('Amsterdam, 1625');
		await expect(name).toHaveValue('Amsterdam, 1625');
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam, 1625');
	});
});

test.describe('a Base Map that never finishes loading', () => {
	test.use({ serviceWorkers: 'block' });

	test('says why the Layer cannot be drawn rather than leaving the list silent', async ({
		page
	}) => {
		test.setTimeout(90_000);
		await alignedProject(page);

		await page.route(/\.pmtiles$/, () => undefined);
		await page.goto(`/?p=${PROJECT_DIRECTORY}`);
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(rows(page)).toHaveCount(1);

		await expect(rows(page).first().getByTestId('layer-problem')).toContainText(
			'Base Map has not finished loading',
			{ timeout: 40_000 }
		);
		await expectDrawn(page, 0);
	});
});

test.describe('an aligned map Layer', () => {
	test('draws warped without claiming it needs aligning, and leaves the map when hidden', async ({
		page
	}) => {
		test.setTimeout(30_000 + WARPED_TILE_WAIT_MS);
		await alignedProject(page);
		await openLayers(page);
		const layerId = await firstLayerId(page);

		expect(
			await warpedTiles(page, layerId),
			'no warped tile reached the renderer through the ProjectStore shim'
		).toBeGreaterThan(0);
		expect(await stackOrder(page)).toEqual([`ballastella-layer-${layerId}`]);

		const row = await openLayerRow(page, 0);
		await expect(row.getByTestId('layer-not-aligned')).toHaveCount(0);
		await expect(row.getByTestId('layer-problem')).toHaveCount(0);
		expect(await accessibleText(row)).not.toContain('Not aligned yet');

		await row.getByTestId('layer-visible').uncheck();
		await expectDrawn(page, 0);
		expect(await stackOrder(page)).toEqual([]);
		await expectSaved(page);
		await expect(row.getByTestId('layer-not-aligned')).toHaveCount(0);
		expect(await accessibleText(row)).not.toContain('Not aligned yet');
	});

	test('goes to Align and back, by link, keeping one Layer, one write and a drawn stack', async ({
		page
	}) => {
		await alignedProject(page);
		const crashes: string[] = [];
		page.on('pageerror', (error) => crashes.push(error.message));
		await openLayers(page);
		const before = await projectJson(page);

		await alignFromLayer(page, rows(page).first());
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();
		await expectWarpedDrawn(page);
		await expect(page.getByTestId('control-point-row')).toHaveCount(3);

		await clickAt(page.getByTestId('image-pane'), 0.4, 0.5);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await clickAt(page.getByTestId('base-map-pane'), 0.4, 0.5);
		await expect(page.getByTestId('control-point-row')).toHaveCount(4);
		await expectSaved(page);

		const after = await projectJson(page);
		expect(after.layers).toEqual(before.layers);
		expect(after.updatedAt).toBe(before.updatedAt);

		await page.getByTestId('back-to-project').click();

		await expect(page).toHaveURL(new RegExp(`\\?p=${PROJECT_DIRECTORY}$`));
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(addMapImageButton(page)).toBeVisible();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await openLayers(page, { via: 'link' });

		expect(await stackOrder(page)).toEqual([`ballastella-layer-${await firstLayerId(page)}`]);
		expect(await stackBuilds(page)).toBeGreaterThan(0);
		expect(crashes, 'the round trip threw while taking the stack off the map').toEqual([]);
	});
});

test.describe('opacity on a map Layer', () => {
	test('drags with the mouse, reaches the renderer without a rebuild, and survives a reload', async ({
		page
	}) => {
		await alignedProject(page);
		await openLayers(page);
		const layerId = await firstLayerId(page);
		const builtBefore = await stackBuilds(page);
		const row = await openLayerRow(page, 0);
		await expect(row.getByTestId('layer-opacity-value')).toHaveText('100%');

		const slider = await row.getByTestId('layer-opacity').boundingBox();
		if (!slider) throw new Error('the opacity slider has no box to drag in');
		await page.mouse.move(slider.x + slider.width - 2, slider.y + slider.height / 2);
		await page.mouse.down();
		await page.mouse.move(slider.x + slider.width * 0.5, slider.y + slider.height / 2, {
			steps: 10
		});
		await page.mouse.move(slider.x + slider.width * 0.3, slider.y + slider.height / 2, {
			steps: 10
		});
		await page.mouse.up();
		const dragged = await warpedOpacity(page, layerId);
		expect(dragged, 'dragging the opacity slider did not reach the warped renderer').toBeLessThan(
			0.6
		);
		await expectSaved(page);
		expect((await projectJson(page)).layers[0].opacity).toBeCloseTo(dragged, 5);

		await row.getByTestId('layer-opacity').fill('0.35');

		await expect(page.getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
		expect(await stackBuilds(page), 'the stack was rebuilt by an opacity change').toBe(builtBefore);

		await expectSaved(page);
		expect((await projectJson(page)).layers[0].opacity).toBeCloseTo(0.35, 5);

		await page.reload();
		await expectDrawn(page, 1, STACK_READY_MS);
		await expect((await openLayerRow(page)).getByTestId('layer-opacity-value')).toHaveText('35%');
		expect(await warpedOpacity(page, layerId)).toBeCloseTo(0.35, 5);
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
	 * @returns the two Layer ids, Annotation Layer first
	 */
	async function stackWithBothKinds(page: Page, defaultStyle: Record<string, unknown> = {}) {
		await alignedProject(page);
		await openLayers(page);
		await addAnnotationLayer(page);
		await expectSaved(page);
		const [annotationId, mapId] = (await rowIds(page)) as [string, string];

		if (Object.keys(defaultStyle).length > 0) {
			const file = await projectJson(page);
			await writeProjectJson(page, {
				...file,
				layers: file.layers.map((layer: { kind: string }) =>
					layer.kind === 'annotation' ? { ...layer, defaultStyle } : layer
				)
			});
		}

		await writeAnnotations(page, annotationId, [
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
		]);
		await page.reload();
		await expectDrawn(page, 2, STACK_READY_MS);
		return { annotationId, mapId };
	}

	const expectAnnotationBelow = async (page: Page, annotationId: string, mapId: string) => {
		const order = await stackOrder(page);
		expect(order.indexOf(`ballastella-layer-${annotationId}-fill`)).toBeLessThan(
			order.indexOf(`ballastella-layer-${mapId}`)
		);
	};

	for (const { title, style } of [
		{ title: 'an Annotation Layer', style: {} },
		{ title: 'an opaque annotation', style: { fill: '#aa0000', 'fill-opacity': 1 } }
	]) {
		test(`${title} above a map Layer draws above it, and moving it down reverses that and survives a reload`, async ({
			page
		}) => {
			test.setTimeout(30_000 + 2 * WARPED_TILE_WAIT_MS);
			const { annotationId, mapId } = await stackWithBothKinds(page, style);

			expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);
			expect(await renderedAtCentre(page)).toContain(`ballastella-layer-${annotationId}-fill`);
			const above = await stackOrder(page);
			expect(above.indexOf(`ballastella-layer-${mapId}`)).toBeLessThan(
				above.indexOf(`ballastella-layer-${annotationId}-fill`)
			);

			await (await openLayerRow(page, rows(page).nth(0))).getByTestId('layer-move-down').click();
			await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
			await expectDrawn(page, 2);
			await expectAnnotationBelow(page, annotationId, mapId);
			expect(await warpedTiles(page, mapId)).toBeGreaterThan(0);

			await expectSaved(page);
			await page.reload();
			await expect(rows(page)).toHaveCount(2);
			expect(await rowIds(page)).toEqual([mapId, annotationId]);
			expect((await projectJson(page)).layers.map((layer: { id: string }) => layer.id)).toEqual([
				mapId,
				annotationId
			]);
		});
	}

	test('dragging a picture of the card highlights the target once and reaches the same render order', async ({
		page
	}) => {
		await watchDragImages(page);
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

		await page.mouse.up();
		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-id', mapId);
		await expect(rows(page).nth(1)).toHaveAttribute('data-layer-id', annotationId);
		await expect(target).toHaveAttribute('data-drop-target', 'false');
		await expectDrawn(page, 2);
		await expectAnnotationBelow(page, annotationId, mapId);

		const drawn = await page.evaluate(
			() => (window as unknown as DragWindow).ballastellaDragImages
		);
		expect(drawn).toHaveLength(1);
		const [image] = drawn as [DragImage];
		expect(image.testid).toBe('layer-row');
		expect(image.layerId).toBe(annotationId);
		expect(image.x).toBeGreaterThanOrEqual(0);
		expect(image.x).toBeLessThan(image.width / 2);
		expect(image.y).toBeGreaterThanOrEqual(0);
		expect(image.y).toBeLessThanOrEqual(image.height);
	});
});

test.describe('display state never reaches a portability document (ADR-0002)', () => {
	test('a Layer’s name selects with the mouse, tabbing out writes nothing, and a rename changes only project.json', async ({
		page
	}) => {
		await alignedProject(page);
		await openLayers(page);
		const alignmentRef = await alignmentRefOf(page);
		const alignmentBefore = await readProjectFile(page, alignmentRef, '');
		const before = await readProjectFile(page, 'project.json');
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

		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await expectSaved(page);
		expect(await readProjectFile(page, 'project.json')).toBe(before);

		await rename(row, 'The 1625 plan');
		await expectSaved(page);

		expect((await projectJson(page)).layers[0].name).toBe('The 1625 plan');
		expect(await readProjectFile(page, alignmentRef, '')).toBe(alignmentBefore);
	});
});

test.describe('a Layer kind this build has never heard of (ADR-0014)', () => {
	test('is listed, is reorderable, and is written back intact', async ({ page }) => {
		await alignedProject(page);
		const file = await projectJson(page);
		await writeProjectJson(page, {
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
		});

		await openLayers(page);

		await expect(rows(page)).toHaveCount(2);
		await expect(rows(page).nth(0)).toHaveAttribute('data-layer-kind', 'foreign');
		await expectDrawn(page, 1);

		const foreign = await openLayerRow(page, rows(page).nth(0));
		await expect(foreign.getByTestId('layer-foreign-note')).toContainText(
			'you can still rename it, hide it, and move it in the stack'
		);
		await rename(foreign, 'The cartouche');
		await (await openLayerRow(page, rows(page).nth(0))).getByTestId('layer-move-down').click();
		await expectSaved(page);

		expect((await projectJson(page)).layers[1]).toEqual({
			kind: 'image-annotation',
			id: 'l-cartouche',
			name: 'The cartouche',
			visible: true,
			order: 1,
			webAnnotationRef: 'image-annotations/l-cartouche.json'
		});
	});
});

test.describe('adding an Annotation Layer', () => {
	test('gives two clicks two Layers, and leaves no orphaned FeatureCollection', async ({
		page
	}) => {
		await alignedProject(page);
		await openLayers(page);
		await delayWritesTo(page, '.geojson.', 1000);
		const add = page.getByTestId('add-annotation-layer');

		await add.click();
		await add.click();

		await expect(rows(page)).toHaveCount(3, { timeout: 15_000 });
		await expectSaved(page);

		const refs = (await projectJson(page)).layers
			.filter((layer: { kind: string }) => layer.kind === 'annotation')
			.map((layer: { geojsonRef: string }) => layer.geojsonRef)
			.sort();
		const files = (await hashesUnder(page, 'annotations/'))
			.map((line) => line.split(' ')[0])
			.sort();

		expect(refs).toHaveLength(2);
		expect(files).toEqual(refs);
	});
});

test.describe('one Layer opens at a time', () => {
	const disclosure = (page: Page, at: number) => rows(page).nth(at).getByTestId('layer-disclosure');

	test('a closed, unaligned map Layer says so as text, shown or hidden, and offers Align now; opened, Align is inside it', async ({
		page
	}) => {
		await projectWithImage(page);
		await openLayers(page, { drawn: 0 });
		const row = rows(page).first();
		const problem = row.getByTestId('layer-problem');
		const layerId = (await projectJson(page)).layers[0].id as string;

		await page.waitForTimeout(2000);
		await expect(problem).toHaveText(NOT_ALIGNED);
		await expect(disclosure(page, 0)).toHaveAttribute('aria-expanded', 'false');
		expect(await accessibleText(row)).toContain(NOT_ALIGNED);
		await expect(page.getByTestId('align-map-image')).toHaveCount(0);

		const now = row.getByTestId('align-map-image-now');
		await expect(now).toHaveRole('link');
		await expect(now).toHaveText('Align now');
		expect(await now.getAttribute('href')).toContain(`?p=${PROJECT_DIRECTORY}&layer=${layerId}`);

		await row.getByTestId('layer-visible').uncheck();
		await expect(problem).toHaveText(NOT_ALIGNED);
		await row.getByTestId('layer-visible').check();
		await expect(problem).toHaveText(NOT_ALIGNED);

		await openLayerRow(page, 0);
		await expect(row.getByTestId('layer-not-aligned')).toHaveText(NOT_ALIGNED);
		expect(await accessibleText(row)).toContain(NOT_ALIGNED);
		const align = row.getByTestId('align-map-image');
		await expect(align).toHaveRole('link');
		expect(await align.getAttribute('href')).toContain(`?p=${PROJECT_DIRECTORY}&layer=${layerId}`);
		expect(await align.getAttribute('href')).toMatch(/\/align\/?\?p=/);

		await disclosure(page, 0).click();
		await expect(disclosure(page, 0)).toHaveAttribute('aria-expanded', 'false');
		await now.click();
		await expect(page).toHaveURL(/\/align\/?\?p=[^&]+&layer=[^&]+/);
		expect(new URL(page.url()).searchParams.get('layer')).toBe(layerId);
	});

	test('an unreadable Alignment is not announced as needing alignment, and gets no Align now', async ({
		page
	}) => {
		await alignedProject(page);
		await writeProjectFile(page, await alignmentRefOf(page), '{ this is not JSON', '');
		await openLayers(page, { drawn: 0 });

		const row = rows(page).first();
		const problem = row.getByTestId('layer-problem');
		await expect(problem).not.toHaveText('');
		await expect(problem).not.toContainText('Not aligned yet');
		expect(await accessibleText(row)).not.toContain('Not aligned yet');
		await expect(row.getByTestId('align-map-image-now')).toHaveCount(0);
		const open = await openLayerRow(page, 0);
		await expect(open.getByTestId('layer-not-aligned')).toHaveCount(0);
		await expect(open.getByTestId('align-map-image')).toHaveCount(1);
	});

	test('every control is keyboard-reachable; opening writes nothing; display edits re-read no Layer document', async ({
		page
	}) => {
		await alignedProject(page);
		await openLayers(page);
		await addAnnotationLayer(page);
		await expectDrawn(page, 2);
		await expectSaved(page);

		const onTheRow = ['layer-visible', 'layer-disclosure'];
		const inTheCard: string[][] = [
			['layer-rename', 'layer-move-down', 'layer-delete'],
			['layer-rename', 'layer-move-up', 'layer-delete', 'layer-opacity']
		];
		for (const [index, card] of inTheCard.entries()) {
			const row = rows(page).nth(index);

			await page.keyboard.press('Tab');
			for (const control of onTheRow) {
				await tabTo(page, row.getByTestId(control), `row ${index} ${control}`);
			}

			await page.keyboard.press('Enter');
			await expect(row.getByTestId('layer-disclosure')).toHaveAttribute('aria-expanded', 'true');

			for (const control of card) {
				await tabTo(page, row.getByTestId(control), `row ${index} ${control}`);
			}
			await expect(row.getByTestId(card.at(-1) as string)).toBeFocused();
		}

		const before = await readProjectFile(page, 'project.json');
		const storageBefore = await page.evaluate(() => JSON.stringify({ ...localStorage }));
		await countFileWrites(page);

		const annotationId = await firstLayerId(page);
		await openLayerRow(page, 0);
		await openLayerRow(page, 1);
		await disclosure(page, 1).click();
		await expect(page.getByTestId('layer-contents')).toHaveCount(0);
		await page.waitForTimeout(1500);

		expect(await fileWrites(page), 'opening a Layer wrote to the store').toEqual([]);
		expect(await readProjectFile(page, 'project.json')).toBe(before);
		expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(storageBefore);
		expect(
			before.split(`"${annotationId}"`).length - 1,
			'the open Layer id appears more than once, so something beside the Layer itself names it'
		).toBe(1);

		const alignmentFile = (await alignmentRefOf(page)).split('/').at(-1) as string;
		await countFileReads(page);

		await (await openLayerRow(page, mapRow(page))).getByTestId('layer-opacity').fill('0.4');
		await expect(page.getByTestId('layer-opacity-value')).toHaveText('40%');
		await rename(await openLayerRow(page, rows(page).nth(0)), 'Trade routes');
		await expectSaved(page);
		await expectDrawn(page, 2);

		const reads = await fileReads(page);
		expect(reads[alignmentFile] ?? 0, 'the Alignment was read again for display state').toBe(0);
		expect(
			reads[`${annotationId}.geojson`] ?? 0,
			'the FeatureCollection was read again for display state'
		).toBe(0);
	});
});

test.describe('a Label obeys its Annotation Layer', () => {
	test('counts with every kind, follows visibility, and is untouched by a Map Image opacity change', async ({
		page
	}) => {
		await alignedProject(page);
		await openLayers(page);
		await addAnnotationLayer(page);
		await expectSaved(page);

		const [annotationLayerId, mapLayerId] = (await rowIds(page)) as [string, string];
		await writeAnnotations(page, annotationLayerId, [
			pointFeature('pin', [4.76, 52.43], { title: 'The harbour' }),
			pointFeature('label', [4.9, 52.37], {
				'marker-symbol': 'label',
				'marker-color': '#d32f2f',
				fill: '#1976d2'
			}),
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
		]);

		await openLayers(page, { drawn: 2 });
		await centreOnAmsterdam(page);
		await waitForPaintedAnnotations(page, ['pin', 'line', 'shape']);

		const annotationRow = layerRow(page, annotationLayerId);
		await openLayerRow(page, annotationRow);
		await expect(page.locator('#annotation-list-caption')).toHaveText('4 Annotations');
		await expect(
			annotationRow.getByTestId('layer-contents').getByTestId('layer-opacity')
		).toHaveCount(0);

		await selectAnnotation(page, 1);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Zuiderzee');
		await page.getByTestId('annotation-title').blur();
		await expectSaved(page);
		await expect(page.locator('#annotation-list-caption')).toHaveText('4 Annotations');
		await waitForPaintedAnnotations(page, ['label']);

		const mapContents = await openLayerRow(page, layerRow(page, mapLayerId));
		await expect(mapContents.getByTestId('layer-opacity')).toHaveCount(1);
		const labelBucket = `ballastella-layer-${annotationLayerId}-label`;
		const pointBucket = `ballastella-layer-${annotationLayerId}-point`;
		const beforeLabelOpacity = await paintProperty(page, labelBucket, 'icon-opacity');
		const beforePointOpacity = await paintProperty(page, pointBucket, 'icon-opacity');
		expect(beforeLabelOpacity).not.toBeNull();
		expect(beforePointOpacity).toBeNull();

		await mapContents.getByTestId('layer-opacity').fill('0.35');
		await expectSaved(page);
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
