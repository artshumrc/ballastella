import { expect, type Locator, type Page } from './test.js';
import { createHash } from 'node:crypto';

import { openLayerRow } from './layers';
import { readStoredFile, writeStoredFiles } from './stored-file';
import { emptyWorkspace } from './workspace.js';
import { restoreWorkspace, snapshotWorkspace } from './workspace-snapshot.js';

export const PROJECT_NAME = 'Amsterdam 1625';
export const PROJECT_DIRECTORY = 'amsterdam-1625';

export interface StackMap {
	getLayer(id: string): unknown;
	getPaintProperty(layerId: string, name: string): unknown;
	queryRenderedFeatures(
		point?: unknown,
		options?: unknown
	): { layer: { id: string }; properties: Record<string, unknown> }[];
	getCenter(): { lng: number; lat: number };
	project(lngLat: [number, number]): { x: number; y: number };
	getCanvas(): HTMLCanvasElement;
	setCenter(lngLat: [number, number]): void;
	setZoom(zoom: number): void;
	getZoom(): number;
	once(event: string, listener: () => void): unknown;
	triggerRepaint(): void;
	isMoving(): boolean;
	getFeatureState(target: { source: string; id: string }): Record<string, unknown>;
}

export type StackWindow = { ballastellaLayerStack?: { map: StackMap; builds: number } };

declare global {
	interface Window {
		ballastellaAnnotationWrites?: { path: string; annotations: number; bytes: number }[];
	}
}

export const readProjectFile = (page: Page, path: string, directory = PROJECT_DIRECTORY) =>
	readStoredFile(page, directory === '' ? path : `${directory}/${path}`);

export const writeProjectFile = (
	page: Page,
	path: string,
	text: string,
	directory = PROJECT_DIRECTORY
) => writeStoredFiles(page, { [directory === '' ? path : `${directory}/${path}`]: text });

export async function hashesUnder(
	page: Page,
	prefix: string,
	directory = PROJECT_DIRECTORY
): Promise<string[]> {
	const files = await page.evaluate(
		async ([directory, prefix]) => {
			const out: [string, number[]][] = [];
			const root = await workspaceRoot();
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
		([path, bytes]) => `${path} ${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`
	);
}

export const projectJson = async (page: Page, directory = PROJECT_DIRECTORY) =>
	JSON.parse(await readProjectFile(page, 'project.json', directory));

export async function annotationLayerId(page: Page, at = 0): Promise<string> {
	const annotationLayers = async () => {
		try {
			const { layers } = await projectJson(page);
			return (layers as { kind: string; id: string }[]).filter(
				(layer) => layer.kind === 'annotation'
			);
		} catch {
			return [];
		}
	};
	await expect
		.poll(async () => (await annotationLayers()).length, {
			message: `project.json should hold at least ${at + 1} Annotation Layer(s)`
		})
		.toBeGreaterThan(at);
	return (await annotationLayers())[at]!.id;
}

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

export const watchAnnotationWrites = (page: Page) =>
	page.evaluate(() => void (window.ballastellaAnnotationWrites = []));

export const annotationWrites = (page: Page) =>
	page.evaluate(() => window.ballastellaAnnotationWrites ?? []);

export async function openNewProject(page: Page, name = PROJECT_NAME): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByTestId('project-name')).toHaveText(name);
}

export async function createProject(page: Page, name = PROJECT_NAME): Promise<void> {
	await openNewProject(page, name);
	await page.getByTestId('all-projects').click();
	await expect(page.getByRole('heading', { level: 2, name: 'Projects' })).toBeVisible();
}

export async function openProjectEditor(page: Page, name?: string): Promise<Locator> {
	const control = name
		? page.getByRole('button', { name: `Edit ${name}` })
		: page.getByRole('button', { name: /^Edit/ });
	await control.click();
	return page.getByRole('dialog', { name: 'Edit Project' });
}

export async function deleteProject(page: Page, name?: string): Promise<void> {
	const editor = await openProjectEditor(page, name);
	await editor.getByRole('button', { name: 'Delete Project…' }).click();
	await page.getByRole('button', { name: 'Delete Project', exact: true }).click();
}

async function projectWithAnnotationLayerThroughTheInterface(page: Page): Promise<string> {
	await page.reload();
	await createProject(page);
	await expect(page.getByRole('link', { name: PROJECT_NAME })).toBeVisible();

	await openLayers(page);
	await page.getByTestId('add-annotation-layer').click();
	await expect(page.getByTestId('layer-row')).toHaveCount(1);
	await expect(page.getByRole('status')).toHaveText('Saved here');

	return annotationLayerId(page);
}

export async function seedAnnotationProject(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, 'annotations-one-layer', async (fresh) => ({
		imageId: '',
		layerId: await projectWithAnnotationLayerThroughTheInterface(fresh)
	}));
	await restoreWorkspace(page, snapshot.files);
	return snapshot.layerId;
}

export async function startAnnotating(page: Page): Promise<string> {
	const layerId = await seedAnnotationProject(page);
	await reopenLayers(page);
	return layerId;
}

export const moveMap = (page: Page, center: [number, number], zoom?: number): Promise<void> =>
	page.evaluate(
		async ([center, zoom]) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
			if (!map) return;
			if (zoom !== undefined) map.setZoom(zoom);
			map.setCenter(center);
			await Promise.race([
				new Promise<void>((resolve) => map.once('idle', () => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 3000))
			]);
		},
		[center, zoom] as const
	);

export const centreOnAmsterdam = (page: Page): Promise<void> => moveMap(page, [4.9, 52.37], 10);

export const featureState = (page: Page, layerId: string, id: string) =>
	page.evaluate(
		(target) =>
			(window as unknown as StackWindow).ballastellaLayerStack!.map.getFeatureState(target),
		{ source: `ballastella-layer-${layerId}-source`, id }
	);

export const projectOnMap = (page: Page, lngLat: [number, number]) =>
	page.evaluate(
		(at) => (window as unknown as StackWindow).ballastellaLayerStack!.map.project(at),
		lngLat
	);

export const stackBuilds = (page: Page): Promise<number> =>
	page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack?.builds ?? -1);

export const pointFeature = (
	id: string,
	at: [number, number],
	properties: Record<string, unknown> = {}
) => ({ type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: at } });

export const writeAnnotations = (
	page: Page,
	layerId: string,
	features: unknown[],
	{ canonical = false, directory = PROJECT_DIRECTORY } = {}
): Promise<void> => {
	const collection = { type: 'FeatureCollection', features };
	return writeProjectFile(
		page,
		`annotations/${layerId}.geojson`,
		canonical ? `${JSON.stringify(collection, null, '\t')}\n` : JSON.stringify(collection),
		directory
	);
};

export async function seedAnnotations(page: Page, features: unknown[]): Promise<string> {
	const layerId = await seedAnnotationProject(page);
	await writeAnnotations(page, layerId, features);
	await reopenLayers(page);
	return layerId;
}

export async function openLayers(page: Page, directory = PROJECT_DIRECTORY): Promise<void> {
	await page.goto(`/?p=${directory}`);
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toBeVisible();
	await waitForOpeningView(page);
}

export async function waitForOpeningView(page: Page): Promise<void> {
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
}

export async function waitForStack(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack !== undefined),
			{
				timeout: 30_000
			}
		)
		.toBe(true);
}

export async function reopenLayers(page: Page, directory = PROJECT_DIRECTORY): Promise<void> {
	await openLayers(page, directory);
	await waitForStack(page);
	await centreOnAmsterdam(page);
	await openLayerRow(page);
}

export const baseMap = (page: Page) => page.getByTestId('base-map-pane');

export async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

export async function chooseTool(
	page: Page,
	tool: 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'text'
): Promise<void> {
	const shapes = page.getByTestId('annotation-tools');
	if (tool === 'select') {
		if ((await shapes.count()) > 0) await page.getByTestId('annotation-cancel').click();
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		return;
	}
	if ((await shapes.count()) === 0) await page.getByTestId('annotation-new').click();
	await page.getByTestId(`annotation-tool-${tool}`).click();
}

export const inspector = (page: Page) => page.getByTestId('annotation-inspector');

export async function selectAnnotation(page: Page, index = 0): Promise<void> {
	await chooseTool(page, 'select');
	const row = page.getByTestId('annotation-row').nth(index);
	await expect(row).toBeVisible();
	if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
	await expect(row).toHaveAttribute('aria-expanded', 'true');
	await expect(inspector(page)).toHaveCount(1);
	await expect(page.getByTestId('annotation-inspector-ordinal')).toHaveText(String(index + 1));
}

export async function editAnnotationText(page: Page): Promise<void> {
	await openFace(page, 'text');
	const edit = page.getByTestId('annotation-edit-text');
	if ((await edit.count()) > 0) await edit.click();
	await expect(page.getByTestId('annotation-title')).toBeVisible();
}

export async function openFace(page: Page, face: 'text' | 'style'): Promise<void> {
	const showing = page.getByTestId('annotation-inspector-face');
	if ((await showing.getAttribute('data-face')) === face) return;
	await page.getByTestId(`annotation-inspector-tab-${face}`).click();
	await expect(showing).toHaveAttribute('data-face', face);
}

export async function deleteAnnotation(page: Page): Promise<void> {
	await openFace(page, 'text');
	await page.getByTestId('annotation-delete').click();
}

export async function chooseLineStyle(
	page: Page,
	style: 'solid' | 'dashed' | 'dotted'
): Promise<void> {
	await openFace(page, 'style');
	await page.getByTestId(`annotation-line-style-${style}`).click();
}

export const ANNOTATION_COLOR = {
	black: '#000000',
	grey: '#555555',
	white: '#ffffff',
	red: '#d32f2f',
	orange: '#ef6c00',
	yellow: '#fbc02d',
	green: '#388e3c',
	blue: '#1976d2',
	purple: '#7b1fa2'
} as const;

export async function chooseColour(
	page: Page,
	which: 'annotation-marker-color' | 'annotation-stroke' | 'annotation-fill',
	colour: keyof typeof ANNOTATION_COLOR
): Promise<string> {
	await openFace(page, 'style');
	await page.getByTestId(`${which}-${colour}`).click();
	await expect(page.getByTestId(`${which}-${colour}`)).toHaveAttribute('data-chosen', 'true');
	return ANNOTATION_COLOR[colour];
}

export async function drawPin(page: Page, fx: number, fy: number): Promise<void> {
	await chooseTool(page, 'point');
	await clickAt(baseMap(page), fx, fy);
	await expect(page.getByRole('status')).toHaveText('Saved here');
}

export async function drawShape(
	page: Page,
	tool: 'line' | 'polygon',
	points: readonly (readonly [number, number])[]
): Promise<void> {
	await chooseTool(page, tool);
	for (const [fx, fy] of points) await clickAt(baseMap(page), fx, fy);
	await expect(page.getByTestId('annotation-done')).toBeEnabled();
	await page.getByTestId('annotation-done').click();
	await expect(page.getByRole('status')).toHaveText('Saved here');
}

export async function drawCircle(
	page: Page,
	center: readonly [number, number],
	edge: readonly [number, number]
): Promise<void> {
	await chooseTool(page, 'circle');
	await clickAt(baseMap(page), center[0], center[1]);
	await clickAt(baseMap(page), edge[0], edge[1]);
	await expect(page.getByRole('status')).toHaveText('Saved here');
}

export const renderedAnnotationLayers = (page: Page) =>
	page.evaluate(() => {
		const stack = (window as unknown as StackWindow).ballastellaLayerStack;
		if (!stack) return {};
		const byId: Record<string, string[]> = {};
		for (const feature of stack.map.queryRenderedFeatures()) {
			const id = feature.properties?.['ballastella:id'];
			if (typeof id !== 'string') continue;
			const seen = (byId[id] ??= []);
			if (!seen.includes(feature.layer.id)) seen.push(feature.layer.id);
		}
		return byId;
	});

export async function waitForPaintedAnnotations(
	page: Page,
	annotationIds: readonly string[]
): Promise<Record<string, string[]>> {
	await expect
		.poll(
			async () => {
				const painted = await renderedAnnotationLayers(page);
				return annotationIds.every((id) => (painted[id] ?? []).length > 0);
			},
			{ timeout: 20_000 }
		)
		.toBe(true);
	return renderedAnnotationLayers(page);
}

export const paintProperty = (page: Page, layerId: string, name: string) =>
	page.evaluate(
		([layerId, name]) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
			if (!map || !map.getLayer(layerId as string)) return null;
			return map.getPaintProperty(layerId as string, name as string) ?? null;
		},
		[layerId, name]
	);

export const ZUIDERZEE_GEOJSON = JSON.stringify({
	type: 'FeatureCollection',
	features: [
		{
			type: 'Feature',
			id: 'label',
			geometry: { type: 'Point', coordinates: [4.9, 52.3676] },
			properties: {
				'marker-symbol': 'label',
				title: 'Zuiderzee',
				'marker-color': '#ffffff',
				fill: '#1976d2',
				'fill-opacity': 0.8,
				'marker-size': 'large'
			}
		}
	]
});
