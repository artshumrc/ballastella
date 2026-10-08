import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addMapImageButton } from './support/map-images.js';
import { alignFromLayer, deleteLayerRow, openLayerRow, layerRows } from './support/layers.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

import {
	mapImage,
	imagePoints,
	makePairs,
	maskEdges,
	maskPointsAttribute,
	maskVertices,
	rows as controlPointRows,
	start,
	storedAlignment,
	waitForStored,
	waitForSurface,
	expectWarpedDrawn
} from './support/alignment-workspace.js';
import {
	annotationLayerId,
	chooseLineStyle,
	deleteAnnotation,
	drawPin,
	drawShape,
	editAnnotationText,
	hashesUnder,
	inspector,
	pointFeature,
	projectJson,
	readProjectFile,
	reopenLayers,
	renderedAnnotationLayers,
	selectAnnotation,
	startAnnotating,
	storedAnnotations,
	waitForPaintedAnnotations,
	waitForStack,
	writeAnnotations,
	clickAt
} from './support/annotations.js';
import { restoreWorkspace, snapshotWorkspace } from './support/workspace-snapshot.js';
import { delayReadsOf } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';

const editHistoryUndo = (page: Page) => page.getByTestId('edit-history-undo');
const editHistoryRedo = (page: Page) => page.getByTestId('edit-history-redo');

const stackOrder = async (page: Page): Promise<string[]> =>
	(
		await page.evaluate(
			() =>
				(
					window as unknown as { ballastellaLayerStack?: { map: { getLayersOrder(): string[] } } }
				).ballastellaLayerStack?.map.getLayersOrder() ?? []
		)
	).filter((id) => id.startsWith('ballastella-layer-'));

const saved = (page: Page) => expect(page.getByRole('status')).toHaveText('Saved here');

async function delayNextReadOf(page: Page, name: string, ms: number): Promise<void> {
	await page.evaluate(
		async ([match, delay]) => {
			const proto = FileSystemFileHandle.prototype;
			const original = proto.getFile;
			let delayed = false;
			proto.getFile = async function (this: FileSystemFileHandle) {
				if (!delayed && this.name === match) {
					delayed = true;
					await new Promise((resolve) => setTimeout(resolve, delay as number));
				}
				return original.call(this);
			};
		},
		[name, ms] as const
	);
}

const STACK_READY_MS = 20_000;

async function openLayers(page: Page): Promise<void> {
	await page.goto('/?p=amsterdam-1625');
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
		timeout: STACK_READY_MS
	});
}

const rowIds = (page: Page): Promise<(string | null)[]> =>
	layerRows(page).evaluateAll((elements) =>
		elements.map((element) => element.getAttribute('data-layer-id'))
	);

const rowFor = (page: Page, layerId: string) =>
	page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`);

const rowText = (page: Page, ordinal: number): Promise<string> =>
	page
		.getByTestId('control-point-row')
		.nth(ordinal - 1)
		.getByTestId('control-point-coordinates')
		.innerText();

async function addSecondLayer(page: Page, first: string): Promise<string> {
	await page.getByTestId('add-annotation-layer').click();
	await expect(layerRows(page)).toHaveCount(2);
	await saved(page);
	return (await rowIds(page)).find((id) => id !== first) as string;
}

async function titleAnnotation(page: Page, title: string): Promise<void> {
	await selectAnnotation(page);
	await editAnnotationText(page);
	await page.getByTestId('annotation-title').fill(title);
	await page.getByTestId('annotation-title').blur();
}

async function expectOrdinals(page: Page, names: string[]): Promise<void> {
	for (const [index, name] of names.entries()) {
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({ has: page.getByTestId('annotation-row-name').getByText(name, { exact: true }) })
				.getByTestId('annotation-row-ordinal')
		).toHaveText(String(index + 1));
	}
}

const writeAroundLabel = (page: Page, layerId: string, id: string, properties: object) =>
	writeAnnotations(
		page,
		layerId,
		[
			pointFeature('before', [4.78, 52.4], { title: 'The harbour' }),
			pointFeature(id, [4.9, 52.37], { ...properties, 'marker-symbol': 'label' }),
			pointFeature('after', [5.02, 52.34], { title: 'The parish' })
		],
		{ canonical: true }
	);

/**
 * Leave the alignment workspace for the Layers pane and come back, **without reloading the page**.
 *
 * The two in-app links rather than `page.goto`, and that is the whole of the helper: a reload builds a
 * new session and every Edit History goes with it, so a round trip by URL would assert nothing at all
 * about a history surviving. What the round trip does to the workspace is the point — it is destroyed
 * and rebuilt, with a fresh `AlignmentPairing` read from the file, while the Steps stay where they
 * were: a history is keyed by Map Image and outlives the screen that draws it (ADR-0039).
 *
 * @param resuming how many Control Points the rebuilt pairing must show before it is safe to click
 */
async function throughLayersAndBack(page: Page, resuming: number): Promise<void> {
	await page.getByTestId('back-to-project').click();
	await expect(addMapImageButton(page)).toBeVisible();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
		timeout: STACK_READY_MS
	});

	await alignFromLayer(page);
	await waitForSurface(page);
	await expect(controlPointRows(page)).toHaveCount(resuming);
}

async function alignedProjectThroughTheInterface(
	page: Page
): Promise<{ imageId: string; layerId: string }> {
	const imageId = await start(page);
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	await expectWarpedDrawn(page);
	await saved(page);
	const layer = (await projectJson(page)).layers.find(
		(entry: { kind: string }) => entry.kind === 'map'
	);
	return { imageId, layerId: layer.id as string };
}

async function seededWorkspace(
	page: Page,
	name: string,
	capture: (page: Page) => Promise<{ imageId: string; layerId: string }>
): Promise<{ imageId: string; layerId: string }> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, name, capture);
	await restoreWorkspace(page, snapshot.files);
	return { imageId: snapshot.imageId, layerId: snapshot.layerId };
}

const alignedWorkspace = (page: Page) =>
	seededWorkspace(page, 'undo-aligned', alignedProjectThroughTheInterface);

/**
 * …and on the alignment route, with the three recorded pairs resumed and clickable.
 *
 * **The rows are the barrier, not the pane**, for the reason {@link throughLayersAndBack} records:
 * `pairing` is `undefined` until the Alignment has been read, and a click before then is dropped.
 *
 * @returns the image id, which is the Alignment's file name
 */
async function alignedProject(page: Page): Promise<string> {
	const { imageId, layerId } = await alignedWorkspace(page);
	await page.goto(`/align/?p=amsterdam-1625&layer=${layerId}`);
	await waitForSurface(page);
	await expect(controlPointRows(page)).toHaveCount(3);
	return imageId;
}

/**
 * A Project with one empty Annotation Layer on disk — seeded from {@link startAnnotating}'s journey.
 *
 * @returns the Annotation Layer's id
 */
async function annotatingWorkspace(page: Page): Promise<string> {
	const { layerId } = await seededWorkspace(page, 'undo-annotating', async (fresh) => ({
		imageId: '',
		layerId: await startAnnotating(fresh)
	}));
	return layerId;
}

/**
 * …and on the Project with that Layer open, ready to draw into — {@link startAnnotating}'s end state.
 *
 * @returns the Annotation Layer's id
 */
async function annotating(page: Page): Promise<string> {
	const layerId = await annotatingWorkspace(page);
	await reopenLayers(page);
	return layerId;
}

test.describe('a Control Point', () => {
	test('moved goes back to exactly where it was, and a deleted pair comes back with its ordinal, each undone after Saved', async ({
		page
	}) => {
		test.setTimeout(120_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const wasAt = await rowText(page, 1);
		const half = imagePoints(page).first();
		await half.focus();
		const wasAtPixel = await half.getAttribute('data-resource-x');
		const box = await half.boundingBox();
		await page.keyboard.press('Shift+ArrowRight');

		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(before);
		const moved = await half.boundingBox();
		expect((moved?.x ?? 0) - (box?.x ?? 0)).toBeGreaterThan(5);
		expect(await half.getAttribute('data-resource-x')).not.toBe(wasAtPixel);

		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');
		await editHistoryUndo(page).click();

		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		await expect(half).toHaveAttribute('data-resource-x', wasAtPixel as string);
		expect(await rowText(page, 1)).toBe(wasAt);

		await expect(editHistoryUndo(page)).toHaveCount(0);
		await expect(page.getByTestId('edit-history-outcome')).toContainText(
			'Undone: move of Control Point 1.'
		);
		await page.keyboard.press('Control+z');
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);

		await expect(editHistoryRedo(page)).toHaveAttribute(
			'aria-label',
			'Redo move of Control Point 1'
		);

		const second = await rowText(page, 2);
		const third = await rowText(page, 3);

		await page.getByTestId('control-point-delete').nth(1).click();
		await expect(controlPointRows(page)).toHaveCount(2);
		expect(await rowText(page, 2)).toBe(third);

		await saved(page);
		await waitForStored(page, imageId, 2);
		await expect(editHistoryUndo(page)).toHaveText('Undo delete of Control Point 2');

		await page.keyboard.press('Control+z');

		await expect(controlPointRows(page)).toHaveCount(3);
		expect(await rowText(page, 2)).toBe(second);
		expect(await rowText(page, 3)).toBe(third);
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		await expect(editHistoryUndo(page)).toHaveCount(0);
	});

	test('move ignores a pane that finishes opening after its alignment route was destroyed', async ({
		page
	}) => {
		test.setTimeout(120_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const wasAt = await rowText(page, 1);

		await imagePoints(page).first().focus();
		await page.keyboard.press('Shift+ArrowRight');
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(before);
		expect(await rowText(page, 1)).not.toBe(wasAt);

		await page.getByTestId('back-to-project').click();
		await expect(addMapImageButton(page)).toBeVisible();
		await expect(editHistoryUndo(page)).toHaveCount(0);
		await delayNextReadOf(page, 'info.json', 3000);

		await alignFromLayer(page);
		await page.getByTestId('back-to-project').click();
		await expect(addMapImageButton(page)).toBeVisible();

		await alignFromLayer(page);
		await waitForSurface(page);
		await expect(controlPointRows(page)).toHaveCount(3);
		await page.waitForTimeout(3500);

		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');
		await editHistoryUndo(page).click();
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		expect(await rowText(page, 1)).toBe(wasAt);
	});

	test('move is walked back to through a pair made after a round trip', async ({ page }) => {
		test.setTimeout(150_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const beforeMove = JSON.parse(before as string);
		const wasAt = await rowText(page, 1);
		const half = imagePoints(page).first();
		await half.focus();
		const wasAtPixel = await half.getAttribute('data-resource-x');
		await page.keyboard.press('Shift+ArrowRight');

		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(before);
		const afterMove = await storedAlignment(page, imageId);

		await throughLayersAndBack(page, 3);
		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');

		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await saved(page);
		const fourth = await rowText(page, 4);
		const afterFourth = await storedAlignment(page, imageId);

		await expect(editHistoryUndo(page)).toHaveText('Undo placing Control Point 4');
		await editHistoryUndo(page).click();
		await saved(page);
		await expect(controlPointRows(page)).toHaveCount(3);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(afterMove);

		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');
		await editHistoryUndo(page).click();
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		const after = JSON.parse((await storedAlignment(page, imageId)) as string);
		expect(after.body.features).toEqual(beforeMove.body.features);

		await expect(controlPointRows(page)).toHaveCount(3);
		await expect(imagePoints(page).first()).toHaveAttribute(
			'data-resource-x',
			wasAtPixel as string
		);
		expect(await rowText(page, 1)).toBe(wasAt);
		await expect(editHistoryUndo(page)).toHaveCount(0);

		await editHistoryRedo(page).click();
		await saved(page);
		await editHistoryRedo(page).click();
		await saved(page);
		await expect(controlPointRows(page)).toHaveCount(4);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(afterFourth);
		expect(await rowText(page, 4)).toBe(fourth);
		await expect(editHistoryRedo(page)).toHaveCount(0);
	});
});

test.describe('a Resource Mask corner added or taken away', () => {
	test('is a Step of its own, so an earlier Step is left holding the outline it was taken over', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const imageId = await alignedProject(page);
		const beforeTheMove = await storedAlignment(page, imageId);
		const half = imagePoints(page).first();
		await half.focus();
		await page.keyboard.press('Shift+ArrowRight');
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(beforeTheMove);
		const afterTheMove = await storedAlignment(page, imageId);

		await page.getByTestId('mask-edit-toggle').check();
		await expect(maskVertices(page)).toHaveCount(4);

		await maskEdges(page).first().click();
		await expect(maskVertices(page)).toHaveCount(5);
		await saved(page);
		await expect
			.poll(async () => maskPointsAttribute((await storedAlignment(page, imageId)) as string))
			.not.toBe(maskPointsAttribute(afterTheMove as string));

		await expect(editHistoryUndo(page)).toHaveText(/^Undo the Crop of /);
		await editHistoryUndo(page).click();
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(afterTheMove);
		await expect(maskVertices(page)).toHaveCount(4);

		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');

		await editHistoryRedo(page).click();
		await saved(page);
		await expect(maskVertices(page)).toHaveCount(5);

		const withFive = await storedAlignment(page, imageId);
		await maskVertices(page).last().focus();
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(4);
		await saved(page);

		await expect(editHistoryUndo(page)).toHaveText(/^Undo the Crop of /);
		await editHistoryUndo(page).click();
		await saved(page);
		await expect(maskVertices(page)).toHaveCount(5);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(withFive);
	});
});

test.describe('a deleted Annotation', () => {
	test('comes back with every property and painted, into the Layer it was deleted from rather than the one chosen', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const routes = await annotating(page);
		const places = await addSecondLayer(page, routes);
		await openLayerRow(page, rowFor(page, routes));

		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.5, 0.5],
			[0.62, 0.45]
		]);
		await titleAnnotation(page, 'Fort Amsterdam');
		await chooseLineStyle(page, 'dotted');
		await saved(page);

		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(2);
		const file = await readProjectFile(page, `annotations/${routes}.geojson`);
		const deleted = (await storedAnnotations(page, routes)).features[0];
		expect(deleted?.properties['stroke-dasharray']).toEqual([1, 3]);
		const annotationId = deleted?.id as string;

		await deleteAnnotation(page);
		await saved(page);
		expect((await storedAnnotations(page, routes)).features).toHaveLength(0);

		await openLayerRow(page, rowFor(page, places));
		await expect(page.getByTestId('annotation-list-empty')).toBeVisible();

		await expect(editHistoryUndo(page)).toHaveText('Undo delete of “Fort Amsterdam”');
		await editHistoryUndo(page).click();
		await expect(editHistoryRedo(page)).toHaveAttribute(
			'aria-label',
			'Redo delete of “Fort Amsterdam”'
		);
		await saved(page);

		await expect.poll(() => hashesUnder(page, 'annotations/')).toEqual(before);
		expect(await readProjectFile(page, `annotations/${routes}.geojson`)).toBe(file);
		expect((await storedAnnotations(page, places)).features).toHaveLength(0);
		const back = (await storedAnnotations(page, routes)).features[0];
		expect(back?.id).toBe(annotationId);
		expect(back?.properties).toEqual(deleted?.properties);
		expect(back?.geometry).toEqual(deleted?.geometry);

		await expect(rowFor(page, places).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await openLayerRow(page, rowFor(page, routes));
		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
		const painted = await waitForPaintedAnnotations(page, [annotationId]);
		expect(painted[annotationId]?.length ?? 0).toBeGreaterThan(0);

		await expect(editHistoryUndo(page)).toHaveText('Undo restyling “Fort Amsterdam”');
	});
});

test.describe('a deleted Layer', () => {
	test('restores the project.json entry and the Alignment byte-for-byte, and one Alignment write later there is still exactly one', async ({
		page
	}) => {
		test.setTimeout(150_000);
		const { imageId } = await alignedWorkspace(page);
		await openLayers(page);
		const mapLayer = (await rowIds(page))[0] as string;
		const annotationLayer = await addSecondLayer(page, mapLayer);
		expect(await rowIds(page)).toEqual([annotationLayer, mapLayer]);

		const before = await hashesUnder(page, 'alignments/', '');
		expect(before).toHaveLength(1);
		const layersBefore = (await projectJson(page)).layers;
		expect(await stackOrder(page)).toContain(`ballastella-layer-${mapLayer}`);

		await deleteLayerRow(page, layerRows(page).nth(1));
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);

		const during = await projectJson(page);
		expect(during.layers.map((layer: { id: string }) => layer.id)).toEqual([annotationLayer]);
		expect(await hashesUnder(page, 'alignments/', '')).toEqual(before);
		await expect.poll(() => stackOrder(page)).not.toContain(`ballastella-layer-${mapLayer}`);

		await expect(editHistoryUndo(page)).toHaveText('Undo delete of the Layer “la-floride.png”');
		await editHistoryUndo(page).click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		expect(await hashesUnder(page, 'alignments/', '')).toEqual(before);
		expect((await projectJson(page)).layers).toEqual(layersBefore);
		expect(await rowIds(page)).toEqual([annotationLayer, mapLayer]);
		await expect
			.poll(() => stackOrder(page), { timeout: STACK_READY_MS })
			.toContain(`ballastella-layer-${mapLayer}`);
		await expect(editHistoryRedo(page)).toHaveAccessibleName(
			'Redo delete of the Layer “la-floride.png”'
		);
		await expect(editHistoryUndo(page)).toHaveText('Undo adding the Layer “Annotations 1”');

		await alignFromLayer(page, 1);
		await waitForSurface(page);
		await expect(editHistoryRedo(page)).toHaveCount(0);
		await expect(controlPointRows(page)).toHaveCount(3);
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await saved(page);
		expect((await projectJson(page)).layers).toEqual(layersBefore);

		await page.getByTestId('back-to-project').click();
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(editHistoryRedo(page)).toHaveCount(1);

		await page.getByTestId('all-projects').click();
		await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
		await expect(editHistoryRedo(page)).toHaveCount(0);
	});

	test('restores an Annotation Layer’s FeatureCollection byte-for-byte, with what was in it', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const layerId = await annotating(page);
		await drawPin(page, 0.4, 0.45);
		await titleAnnotation(page, 'Trade route');
		await saved(page);
		const before = await hashesUnder(page, 'annotations/');
		const annotationId = (await storedAnnotations(page, layerId)).features[0]?.id as string;

		await deleteLayerRow(page, layerRows(page).first());
		await expect(layerRows(page)).toHaveCount(0);
		await saved(page);
		expect(await hashesUnder(page, 'annotations/')).toEqual([]);
		expect((await projectJson(page)).layers).toEqual([]);

		await editHistoryUndo(page).click();
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect(await annotationLayerId(page)).toBe(layerId);
		await waitForStack(page);
		const painted = await waitForPaintedAnnotations(page, [annotationId]);
		expect(painted[annotationId]?.length ?? 0).toBeGreaterThan(0);
	});

	test('a whole pairing session leaves project.json byte-identical', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		await saved(page);
		const before = await readProjectFile(page, 'project.json');
		expect(JSON.parse(before).layers).toHaveLength(1);

		await delayReadsOf(page, 'manifest.json', 1500);

		await clickAt(mapImage(page), 0.3, 0.3);
		await clickAt(page.getByTestId('base-map-pane'), 0.3, 0.3);
		await clickAt(mapImage(page), 0.7, 0.35);
		await clickAt(page.getByTestId('base-map-pane'), 0.7, 0.35);
		await expect(controlPointRows(page)).toHaveCount(2);

		await page.waitForTimeout(3000);
		await saved(page);

		expect(await readProjectFile(page, 'project.json')).toBe(before);
		await page.getByTestId('back-to-project').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
	});
});

test.describe('what undo will and will not hold (ADR-0014, ADR-0039)', () => {
	test('a rename leaves the delete still undoable, Ctrl+Z in its field is the field’s own, and the delete survives it', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const original = await annotating(page);
		const added = await addSecondLayer(page, original);

		await deleteLayerRow(page, layerRows(page).nth(1));
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);
		const label = 'Undo delete of the Layer “Annotations 1”';
		await expect(editHistoryUndo(page)).toHaveText(label);

		const renaming = await openLayerRow(page, layerRows(page).first());
		await renaming.getByTestId('layer-rename').click();
		const name = renaming.getByTestId('layer-name');
		await name.click();
		await name.press('Control+z');
		await expect(editHistoryUndo(page)).toHaveText(label);
		await expect(layerRows(page)).toHaveCount(1);

		await name.fill('Trade routes');
		await name.blur();
		await saved(page);

		await expect(editHistoryUndo(page)).toHaveText(label);
		await editHistoryUndo(page).click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		expect(await rowIds(page)).toEqual([added, original]);
		expect((await projectJson(page)).layers[0].name).toBe('Trade routes');
	});

	test('undoing the drawing of an Annotation from the keyboard-reachable control closes its Inspector', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const layerId = await annotating(page);
		await drawPin(page, 0.45, 0.45);
		await expect(inspector(page)).toHaveCount(1);
		await expect(page.getByTestId('leader-line')).toHaveAttribute('data-drawn', 'yes');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
		await expect(editHistoryUndo(page)).toHaveText('Undo drawing this Annotation');

		for (let press = 0; press < 200; press += 1) {
			if (await editHistoryUndo(page).evaluate((element) => element === document.activeElement)) {
				break;
			}
			await page.keyboard.press('Tab');
		}
		await expect(editHistoryUndo(page)).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(inspector(page)).toHaveCount(0);
		await expect(page.getByTestId('leader-line')).toHaveAttribute('data-drawn', 'no');
		await expect(page.getByTestId('annotation-row')).toHaveCount(0);
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);
		await expect(page.getByTestId('edit-history-outcome')).toContainText(
			'Undone: drawing this Annotation.'
		);
	});
});

test.describe('a deleted Label', () => {
	test('leaves its row and map, then returns to its Layer and original position with its words and colours', async ({
		page
	}) => {
		const layerId = await annotatingWorkspace(page);
		await writeAroundLabel(page, layerId, 'label', {
			title: 'Zuiderzee',
			'marker-color': '#d32f2f',
			fill: '#1976d2',
			'fill-opacity': 0.4,
			'marker-size': 'large'
		});
		await reopenLayers(page);
		await waitForPaintedAnnotations(page, ['before', 'label', 'after']);

		const otherLayerId = await addSecondLayer(page, layerId);
		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(2);
		await openLayerRow(page, rowFor(page, layerId));

		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);

		expect((await storedAnnotations(page, layerId)).features.map((feature) => feature.id)).toEqual([
			'before',
			'after'
		]);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);
		await expect.poll(async () => 'label' in (await renderedAnnotationLayers(page))).toBe(false);

		await openLayerRow(page, rowFor(page, otherLayerId));
		await expect(editHistoryUndo(page)).toHaveText('Undo delete of “Zuiderzee”');
		await editHistoryUndo(page).click();
		await expect(editHistoryRedo(page)).toHaveCount(1);
		await saved(page);

		await expect.poll(() => hashesUnder(page, 'annotations/')).toEqual(before);
		await openLayerRow(page, rowFor(page, layerId));
		await expectOrdinals(page, ['The harbour', 'Zuiderzee', 'The parish']);
		await waitForPaintedAnnotations(page, ['label']);
	});

	test('an untitled Label is deleted and restored through the same Inspector path', async ({
		page
	}) => {
		const layerId = await annotatingWorkspace(page);
		await writeAroundLabel(page, layerId, 'empty-label', { fill: '#1976d2' });
		await reopenLayers(page);
		const before = await readProjectFile(page, `annotations/${layerId}.geojson`);

		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);
		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).not.toBe(before);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);

		await editHistoryUndo(page).click();
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);
		await saved(page);
		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).toBe(before);
		await expectOrdinals(page, ['The harbour', 'Untitled label 2', 'The parish']);

		for (const index of [0, 1, 0]) {
			await selectAnnotation(page, index);
			await deleteAnnotation(page);
			await saved(page);
		}
		await expect
			.poll(() =>
				page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? 'BODY')
			)
			.toBe('annotation-new');
	});
});
