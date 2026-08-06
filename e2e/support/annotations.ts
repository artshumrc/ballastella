// Shared driving for the Annotation surface (ticket 10): get a Project open on the Layers pane with
// one Annotation Layer, draw into it, and read back what landed in OPFS.
//
// Separate from `alignment-workspace.ts` because these tests need **no Historical Map at all** — an
// Annotation is on real geography and needs only the Base Map, so ingesting a pyramid would add
// twenty seconds per test to assert nothing this slice is about. Nothing here reaches into the app's
// own state: the assertions are on the written file and on what MapLibre reports it drew.

import { expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

export const PROJECT_NAME = 'Amsterdam 1625';
export const PROJECT_DIRECTORY = 'amsterdam-1625';

declare global {
	interface Window {
		ballastellaLayerStack?: {
			map: {
				getLayersOrder(): string[];
				getLayer(id: string): unknown;
				getPaintProperty(layerId: string, name: string): unknown;
				queryRenderedFeatures(
					point?: unknown,
					options?: unknown
				): { layer: { id: string }; properties: Record<string, unknown> }[];
				project(lngLat: [number, number]): { x: number; y: number };
				getCenter(): { lng: number; lat: number };
				getCanvas(): { width: number; height: number };
				setCenter(lngLat: [number, number]): void;
				setZoom(zoom: number): void;
			};
			builds: number;
		};
		ballastellaAnnotationWrites?: { path: string; annotations: number }[];
	}
}

/** Empty the origin's OPFS, so no test can see another's Projects. */
export async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const root = await navigator.storage.getDirectory();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(names.map((name) => root.removeEntry(name, { recursive: true })));
	});
}

/** One file of a Project, straight out of OPFS. */
export const readProjectFile = (page: Page, path: string, directory = PROJECT_DIRECTORY) =>
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

/** Write a file behind the app's back, for a fixture the UI has no way to produce yet. */
export const writeProjectFile = (
	page: Page,
	path: string,
	text: string,
	directory = PROJECT_DIRECTORY
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

/** Every file under `prefix`, as a sha256 per path. The bytes are the assertion. */
export async function hashesUnder(
	page: Page,
	prefix: string,
	directory = PROJECT_DIRECTORY
): Promise<string[]> {
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
		([path, bytes]) => `${path} ${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`
	);
}

/** The open Project's `project.json`, parsed. */
export const projectJson = async (page: Page, directory = PROJECT_DIRECTORY) =>
	JSON.parse(await readProjectFile(page, 'project.json', directory));

/** The one Annotation Layer's id, taken from `project.json` rather than guessed. */
export async function annotationLayerId(page: Page, at = 0): Promise<string> {
	const { layers } = await projectJson(page);
	return layers.filter((layer: { kind: string }) => layer.kind === 'annotation')[at].id;
}

/** The Annotation Layer's `FeatureCollection`, parsed out of OPFS. */
export async function storedAnnotations(
	page: Page,
	layerId: string
): Promise<{
	type: string;
	features: {
		type: string;
		id: string;
		properties: Record<string, unknown>;
		geometry: { type: string; coordinates: unknown } | null;
	}[];
}> {
	return JSON.parse(await readProjectFile(page, `annotations/${layerId}.geojson`));
}

/**
 * Watch every Annotation write the app makes.
 *
 * The count is the criterion: editing a vertex must cost exactly one store write, on gesture end
 * (ADR-0017 rule 1). A per-pointer-move implementation passes any "did it save?" assertion and fails
 * this, and a write into OPFS issues no request so there is nothing outside the page to count.
 */
export const watchAnnotationWrites = (page: Page) =>
	page.evaluate(() => {
		window.ballastellaAnnotationWrites = [];
	});

export const annotationWrites = (page: Page) =>
	page.evaluate(() => window.ballastellaAnnotationWrites ?? []);

/** Create a Project through the interface, as a user would. */
export async function createProject(page: Page, name = PROJECT_NAME): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
}

/**
 * A Project open on the Layers pane with one Annotation Layer, ready to draw into.
 *
 * @returns the Annotation Layer's id
 */
export async function startAnnotating(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await createProject(page);
	await expect(page.getByRole('link', { name: PROJECT_NAME })).toBeVisible();

	await openLayers(page);
	await page.getByTestId('add-annotation-layer').click();
	await expect(page.getByTestId('layer-row')).toHaveCount(1);
	await expect(page.getByRole('status')).toHaveText('Saved');
	await waitForStack(page);
	await centreOnAmsterdam(page);

	return annotationLayerId(page);
}

/**
 * Centre and zoom the map somewhere definite.
 *
 * So that a click at a fraction across the canvas is a stable coordinate rather than one that depends
 * on the catalog's initial view — and so that two Annotations placed at different fractions are far
 * enough apart in degrees to be told apart by a hit test.
 */
export async function centreOnAmsterdam(page: Page): Promise<void> {
	await page.evaluate(() => {
		window.ballastellaLayerStack?.map.setCenter([4.9, 52.37]);
		window.ballastellaLayerStack?.map.setZoom(10);
	});
}

/**
 * Open the Layers pane.
 *
 * Deliberately does **not** wait for the map's stack handle: `drawLayerStack` is not called at all
 * when the Project has no visible Layers, so a Project that has only just been created would wait for
 * something that is correctly never going to appear. {@link waitForStack} is the separate wait, for
 * after a Layer exists.
 */
export async function openLayers(page: Page, directory = PROJECT_DIRECTORY): Promise<void> {
	await page.goto(`/layers?p=${directory}`);
	await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
	await expect(page.getByTestId('stack-status')).toBeVisible();
}

/**
 * Wait until the Layer stack has been put on the map.
 *
 * The handle appears when `drawLayerStack` has run, which is what every assertion about what MapLibre
 * drew depends on. Ticket 09 found that `styledata` fires long before a style is complete, so the app
 * gates on `isStyleLoaded()`; this is generous for the same reason.
 */
export async function waitForStack(page: Page): Promise<void> {
	await expect
		.poll(() => page.evaluate(() => window.ballastellaLayerStack !== undefined), {
			timeout: 30_000
		})
		.toBe(true);
}

/**
 * Reload the Layers pane on a Project that already has a Layer, ready to assert against the map.
 *
 * What every test that seeds a fixture behind the app's back needs: open, wait for the stack, and put
 * the view back where the fixture's coordinates are.
 */
export async function reopenLayers(page: Page, directory = PROJECT_DIRECTORY): Promise<void> {
	await openLayers(page, directory);
	await waitForStack(page);
	await centreOnAmsterdam(page);
}

export const baseMap = (page: Page) => page.getByTestId('base-map-pane');

/** Click at a fraction across the Base Map pane. */
export async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/** Choose a drawing tool. */
export const chooseTool = (page: Page, tool: 'select' | 'point' | 'line' | 'polygon') =>
	page.getByTestId(`annotation-tool-${tool}`).click();

/**
 * Make sure the Annotation at `index` in the list is the selected one.
 *
 * **Not simply a click**, because a row is a toggle and drawing something already selects it — a
 * newly drawn shape is selected so that it can be titled straight away, which is the point of
 * drawing it. Clicking it unconditionally would therefore *deselect* it, and the editor and the
 * vertex handles would both vanish. That is not a hypothetical: it is what the first run of this
 * suite did, and eleven tests failed on it with the row still focused and looking selected.
 */
export async function selectAnnotation(page: Page, index = 0): Promise<void> {
	const row = page.getByTestId('annotation-row').nth(index);
	await expect(row).toBeVisible();
	if ((await row.getAttribute('aria-pressed')) !== 'true') await row.click();
	await expect(row).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByTestId('annotation-editor')).toBeVisible();
}

/** Draw a pin at a fraction across the pane, and wait for it to reach the file. */
export async function drawPin(page: Page, fx: number, fy: number): Promise<void> {
	await chooseTool(page, 'point');
	await clickAt(baseMap(page), fx, fy);
	await expect(page.getByRole('status')).toHaveText('Saved');
}

/** Draw a line or a shape through the given fractions, finishing with the Finish button. */
export async function drawShape(
	page: Page,
	tool: 'line' | 'polygon',
	points: readonly (readonly [number, number])[]
): Promise<void> {
	await chooseTool(page, tool);
	for (const [fx, fy] of points) await clickAt(baseMap(page), fx, fy);
	await expect(page.getByTestId('annotation-finish')).toBeEnabled();
	await page.getByTestId('annotation-finish').click();
	await expect(page.getByRole('status')).toHaveText('Saved');
}

/** The MapLibre layers that painted an Annotation, keyed by the Annotation's own id. */
export const renderedAnnotationLayers = (page: Page) =>
	page.evaluate(() => {
		const stack = window.ballastellaLayerStack;
		if (!stack) return {};
		const byId: Record<string, string[]> = {};
		for (const feature of stack.map.queryRenderedFeatures()) {
			const id = feature.properties?.['ballastella:id'];
			if (typeof id !== 'string') continue;
			(byId[id] ??= []).push(feature.layer.id);
		}
		return byId;
	});

/** One MapLibre paint property of one of the stack's layers. */
export const paintProperty = (page: Page, layerId: string, name: string) =>
	page.evaluate(
		([layerId, name]) => {
			const map = window.ballastellaLayerStack?.map;
			if (!map || !map.getLayer(layerId as string)) return null;
			return map.getPaintProperty(layerId as string, name as string) ?? null;
		},
		[layerId, name]
	);
