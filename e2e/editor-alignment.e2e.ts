import { parseAnnotation, validateAnnotation } from '@allmaps/annotation';
import { openBaseMapOptions, drawSwitch } from './support/base-map-options.js';
import { expect, test, type Locator, type Page } from './support/test.js';

import {
	expectWarpedDrawn,
	imagePoints,
	makePair,
	mapImage,
	rows,
	start,
	storedAlignment,
	waitForStored,
	warpedStatus,
	warpedTiles,
	watchWrites,
	writes
} from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment';
import { leaderIsDrawn, leaderLayer, leaderPoints } from './support/leader.js';
import { readStoredJsonOrNull } from './support/stored-file';
import { clickAt, baseMap, writeProjectFile } from './support/annotations.js';

test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

type WarpedWindow = { ballastellaWarped?: { layer: { getOpacity(): number } } };

const basePoints = (page: Page) =>
	baseMap(page).locator('[data-testid="pane-overlay-point-control-point"]');

test.describe('Control Point pairing', () => {
	test('clicking the Map Image then the Base Map creates a numbered pair, and ordinals count up', async ({
		page
	}) => {
		await start(page);

		await expect(imagePoints(page)).toHaveCount(0);
		await expect(basePoints(page)).toHaveCount(0);

		await clickAt(mapImage(page), 0.35, 0.4);

		await expect(imagePoints(page)).toHaveCount(1);
		await expect(imagePoints(page).first()).toHaveAttribute('data-pending', 'true');
		await expect(basePoints(page)).toHaveCount(0);
		await expect(page.getByTestId('pairing-status')).toContainText(
			'Waiting for the matching place on the Base Map'
		);

		await clickAt(baseMap(page), 0.5, 0.5);

		await expect(imagePoints(page)).toHaveCount(1);
		await expect(basePoints(page)).toHaveCount(1);
		await expect(imagePoints(page).first()).toHaveAttribute('data-ordinal', '1');
		await expect(basePoints(page).first()).toHaveAttribute('data-ordinal', '1');
		await expect(imagePoints(page).first()).toHaveAttribute('data-pending', 'false');
		await expect(imagePoints(page).first()).toHaveText('1');

		await expect(rows(page)).toHaveCount(1);
		await expect(page.getByTestId('control-point-select')).toHaveText('Point 1');

		await makePair(page, [0.5, 0.4]);
		await makePair(page, [0.7, 0.6]);

		await expect(imagePoints(page)).toHaveText(['1', '2', '3']);
		await expect(basePoints(page)).toHaveText(['1', '2', '3']);
		await expect(page.getByTestId('control-point-select')).toHaveText([
			'Point 1',
			'Point 2',
			'Point 3'
		]);

		const rowOrdinals = page.getByTestId('control-point-row-ordinal');
		await expect(rowOrdinals).toHaveText(['1', '2', '3']);
		expect(await rowOrdinals.allInnerTexts()).toEqual(await imagePoints(page).allInnerTexts());
		expect(await rowOrdinals.allInnerTexts()).toEqual(await basePoints(page).allInnerTexts());

		expect(
			await rowOrdinals.first().evaluate((element) => getComputedStyle(element).fontVariantNumeric)
		).toContain('tabular-nums');

		const destroyPointTwo = page.getByRole('button', { name: 'Delete Control Point 2' });
		await expect(destroyPointTwo).toHaveCount(1);
		await expect(destroyPointTwo).not.toHaveAttribute('title', /.+/);

		await page.getByTestId('control-point-delete').first().click();
		await expect(rowOrdinals).toHaveText(['1', '2']);
		await expect(imagePoints(page)).toHaveText(['1', '2']);
		await expect(basePoints(page)).toHaveText(['1', '2']);
	});

	test('Escape cancels the pending half, writing nothing for a first pair and leaving no trace after later ones', async ({
		page
	}) => {
		const imageId = await start(page);
		const starter = await storedAlignment(page, imageId);
		expect(starter).not.toBeNull();
		expect(JSON.parse(starter as string).body.features).toEqual([]);
		await watchWrites(page);
		const status = page.getByTestId('pairing-status');

		await clickAt(mapImage(page), 0.4, 0.4);
		await expect(status).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
		await expect(status).toHaveAttribute('data-pending', '');
		await page.waitForTimeout(2000);
		expect(await writes(page)).toEqual([]);
		expect(await storedAlignment(page, imageId)).toBe(starter);

		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.6, 0.5]);
		await waitForStored(page, imageId, 2);
		const afterPairs = await storedAlignment(page, imageId);

		await clickAt(mapImage(page), 0.8, 0.7);
		await expect(imagePoints(page)).toHaveCount(3);
		await expect(status).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');

		await expect(imagePoints(page)).toHaveCount(2);
		await expect(basePoints(page)).toHaveCount(2);
		await expect(rows(page)).toHaveCount(2);
		await expect(status).toHaveAttribute('data-pending', '');
		expect(await storedAlignment(page, imageId)).toBe(afterPairs);
	});

	test('dragging a half or editing its coordinates moves the pair', async ({ page }) => {
		const imageId = await start(page);
		await makePair(page, [0.4, 0.4]);
		await waitForStored(page, imageId, 1);

		const half = imagePoints(page).first();
		const before = await half.boundingBox();
		if (!before) throw new Error('the Control Point has no box to drag');

		await watchWrites(page);
		expect(await writes(page)).toEqual([]);

		await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
		await page.mouse.down();
		for (let step = 1; step <= 12; step += 1) {
			await page.mouse.move(
				before.x + before.width / 2 + step * 6,
				before.y + before.height / 2 + step * 3
			);
		}
		expect(await writes(page)).toEqual([]);

		await page.mouse.up();

		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const logged = await writes(page);
		expect(logged[0]?.controlPoints).toBe(1);
		expect(logged[0]?.path).toContain('alignments/');
		const after = await half.boundingBox();
		expect(after).not.toBeNull();
		expect(Math.abs((after?.x ?? 0) - before.x)).toBeGreaterThan(20);
		const row = rows(page).first();
		await row.getByTestId('control-point-coordinates').click();
		const editor = row.getByTestId('control-point-coordinate-editor');
		await expect(editor).toBeVisible();
		await editor.getByLabel('Map Image x coordinate').fill('123.5');
		await editor.getByLabel('Map Image y coordinate').fill('234.25');
		await editor.getByLabel('Longitude').fill('-71.1234');
		await editor.getByLabel('Latitude').fill('42.5');
		await editor.getByRole('button', { name: 'Save' }).click();
		await expect(editor).toHaveCount(0);

		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				if (written === null) return null;
				const feature = JSON.parse(written).body.features[0];
				return {
					resource: feature.properties.resourceCoords,
					geo: feature.geometry.coordinates
				};
			})
			.toStrictEqual({ resource: [123.5, 234.25], geo: [-71.1234, 42.5] });

		await row.getByTestId('control-point-coordinates').click();
		await editor.getByLabel('Latitude').fill('91');
		await editor.getByRole('button', { name: 'Save' }).click();
		await expect(editor).toContainText('Latitude must be between -90 and 90.');
		await editor.getByRole('button', { name: 'Cancel' }).click();
	});

	test('selecting either half highlights its partner in the other pane', async ({ page }) => {
		const imageId = await start(page);
		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.65, 0.6]);

		const drawing = (point: Locator) =>
			point.evaluate((element) => {
				const body = element.querySelector('.needle-body');
				if (body === null) throw new Error('the Control Point is not drawing a needle');
				return { fill: getComputedStyle(body).fill, filter: getComputedStyle(element).filter };
			});

		await page.getByTestId('control-point-select').nth(1).click();
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		await expect(basePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		const unselectedDrawing = await drawing(imagePoints(page).nth(0));

		await imagePoints(page).nth(0).click();
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'true');
		await expect(basePoints(page).nth(0)).toHaveAttribute('data-selected', 'true');
		await expect(imagePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		await expect(imagePoints(page).nth(0)).toHaveAttribute('aria-pressed', 'true');

		await expect(imagePoints(page).nth(0)).toHaveClass(/pane-overlay-point-selected/);
		await expect(basePoints(page).nth(0)).toHaveClass(/pane-overlay-point-selected/);
		await expect(imagePoints(page).nth(1)).not.toHaveClass(/pane-overlay-point-selected/);
		const selectedDrawing = await drawing(imagePoints(page).nth(0));
		expect(selectedDrawing.fill, 'a highlight nobody can see is not a highlight').not.toBe(
			unselectedDrawing.fill
		);
		expect(selectedDrawing.filter).toBe(unselectedDrawing.filter);
		expect(await drawing(basePoints(page).nth(0))).toEqual(selectedDrawing);
		expect(await drawing(imagePoints(page).nth(1))).toEqual(unselectedDrawing);

		await basePoints(page).nth(1).click();
		await expect(imagePoints(page).nth(1)).toHaveAttribute('data-selected', 'true');
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'true');
		await expect(imagePoints(page).nth(0)).toHaveAttribute('data-selected', 'false');
		await expect(imagePoints(page).nth(1)).toHaveClass(/pane-overlay-point-selected/);
		await expect(imagePoints(page).nth(0)).not.toHaveClass(/pane-overlay-point-selected/);
		expect(await drawing(imagePoints(page).nth(1))).toEqual(selectedDrawing);
		expect(await drawing(imagePoints(page).nth(0))).toEqual(unselectedDrawing);

		await waitForStored(page, imageId, 2);
		const written = JSON.parse((await storedAlignment(page, imageId)) as string);
		const geo = written.body.features[1].geometry.coordinates as [number, number];
		const drawn = await leaderPoints(page);
		expect(drawn, 'no leader was drawn for the selected Control Point').not.toBeNull();
		expect(drawn, 'more than one line was drawn for one selection').toHaveLength(3);
		type Point = { x: number; y: number };
		const [atRow, stub, atMark] = drawn as [Point, Point, Point];
		const leaderEnd = (target: Point, from: Point): Point => {
			const run = Math.hypot(target.x - from.x, target.y - from.y);
			return {
				x: target.x - ((target.x - from.x) * 14) / run,
				y: target.y - ((target.y - from.y) * 14) / run
			};
		};

		const pane = (await baseMap(page).boundingBox())!;
		const projected = await page.evaluate(
			(coordinate) =>
				(
					window as unknown as {
						ballastellaBaseMap: { project(at: [number, number]): Point };
					}
				).ballastellaBaseMap.project(coordinate as [number, number]),
			geo
		);
		const wanted = leaderEnd({ x: pane.x + projected.x, y: pane.y + projected.y }, stub);
		expect(
			Math.hypot(atMark.x - wanted.x, atMark.y - wanted.y),
			'the leader’s canvas end is not where map.project() puts the coordinate on disk'
		).toBeLessThan(2);

		const rowBox = (await rows(page).nth(1).boundingBox())!;
		expect(atRow.x).toBeCloseTo(rowBox.x, 0);
		expect(atRow.y).toBeCloseTo(rowBox.y + rowBox.height / 2, 0);
		expect(stub.x, 'the line left the row on the far side').toBeLessThan(rowBox.x);

		const followed = await page.evaluate((coordinate) => {
			const map = (
				window as unknown as {
					ballastellaBaseMap: {
						panBy(offset: [number, number], options: { duration: number }): void;
						project(at: [number, number]): { x: number; y: number };
					};
				}
			).ballastellaBaseMap;
			map.panBy([70, -50], { duration: 0 });
			return new Promise<{
				points: string | null;
				origin: { x: number; y: number };
				projected: { x: number; y: number };
			}>((resolve) =>
				requestAnimationFrame(() => {
					const svg = document.querySelector('[data-testid="leader-line"]') as SVGSVGElement;
					const box = svg.getBoundingClientRect();
					resolve({
						points: svg.querySelector('polyline')!.getAttribute('points'),
						origin: { x: box.x, y: box.y },
						projected: map.project(coordinate as [number, number])
					});
				})
			);
		}, geo);
		expect(followed.points, 'the leader was taken down by a pan rather than moved').not.toBeNull();
		const [, movedStub, movedMark] = followed.points!.split(' ').map((pair) => {
			const [x, y] = pair.split(',').map(Number);
			return { x: followed.origin.x + (x as number), y: followed.origin.y + (y as number) };
		}) as [Point, Point, Point];
		const movedWanted = leaderEnd(
			{ x: pane.x + followed.projected.x, y: pane.y + followed.projected.y },
			movedStub
		);
		expect(
			Math.hypot(movedMark.x - movedWanted.x, movedMark.y - movedWanted.y),
			'the leader stayed where the camera left it, so it is not following the map'
		).toBeLessThan(2);

		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');

		await page.getByTestId('control-point-select').nth(1).click();
		await expect(basePoints(page).nth(1)).toHaveAttribute('data-selected', 'false');
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
	});

	test('every pairing action is reachable by keyboard, and the pending state is announced', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, [0.4, 0.4]);
		await waitForStored(page, imageId, 1);

		const status = page.getByTestId('pairing-status');
		await expect(status).toHaveAttribute('aria-live', 'polite');
		await expect(status).toHaveAttribute('aria-atomic', 'true');

		const half = imagePoints(page).first();
		await half.focus();
		await expect(half).toBeFocused();
		await expect(half).toHaveAttribute('aria-label', /Control Point 1, Map Image half/);

		const before = await half.boundingBox();
		await watchWrites(page);
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const after = await half.boundingBox();
		expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(5);

		await page.getByTestId('control-point-select').first().focus();
		const selectedNow = await imagePoints(page).first().getAttribute('data-selected');
		const opposite = selectedNow === 'true' ? 'false' : 'true';

		await page.keyboard.press('Enter');
		await expect(imagePoints(page).first()).toHaveAttribute('data-selected', opposite);
		await expect(basePoints(page).first()).toHaveAttribute('data-selected', opposite);

		await page.keyboard.press('Enter');
		await expect(imagePoints(page).first()).toHaveAttribute(
			'data-selected',
			selectedNow ?? 'false'
		);
		await expect(basePoints(page).first()).toHaveAttribute('data-selected', selectedNow ?? 'false');

		await imagePoints(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(imagePoints(page)).toHaveCount(0);
		await expect(basePoints(page)).toHaveCount(0);

		await clickAt(mapImage(page), 0.5, 0.5);
		await expect(status).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
		await expect(status).toHaveAttribute('data-pending', '');
	});
});

test('the warped Map Image appears on the third pair and not before, translucent under the slider, and is withdrawn when too few remain', async ({
	page
}) => {
	await start(page);
	await makePair(page, [0.3, 0.3]);
	await makePair(page, [0.6, 0.35]);
	await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', '');
	await expect(warpedStatus(page)).toContainText('1 more Control Point');
	expect(
		await page.evaluate(() => Boolean((window as WarpedWindow).ballastellaWarped)),
		'the renderer must not be asked for an under-determined solve'
	).toBe(false);

	await makePair(page, [0.45, 0.7]);
	await expectWarpedDrawn(page);
	await expect(warpedStatus(page)).toContainText('from 3 Control Points');
	expect(
		await warpedTiles(page),
		'no warped tile reached the renderer through the ProjectStore shim'
	).toBeGreaterThan(0);

	const layerOpacity = () =>
		page.evaluate(() => (window as WarpedWindow).ballastellaWarped?.layer.getOpacity() ?? -1);
	const slider = page.getByTestId('overlay-opacity');
	await expect(slider).toHaveValue('50');
	await expect.poll(layerOpacity).toBeCloseTo(0.5, 5);
	await slider.fill('0');
	await expect.poll(layerOpacity).toBeCloseTo(0, 5);
	await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
	await slider.fill('100');
	await expect.poll(layerOpacity).toBeCloseTo(1, 5);

	await page.getByTestId('control-point-delete').first().click();
	await expect(rows(page)).toHaveCount(2);
	await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', '');
	await expect(warpedStatus(page)).toContainText('1 more Control Point');
});

test.describe('the Alignment on disk', () => {
	test('is a valid Georeference Annotation that excludes a pending pair without throwing, and restores across a reload', async ({
		page
	}) => {
		const consoleErrors: string[] = [];
		page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));
		const imageId = await start(page);
		await makePair(page, [0.3, 0.3]);
		await makePair(page, [0.55, 0.45]);
		await makePair(page, [0.75, 0.65]);
		await waitForStored(page, imageId, 3);

		const written = await storedAlignment(page, imageId);
		expect(written, 'no Alignment was written').not.toBeNull();
		const document = JSON.parse(written as string);
		expect(
			() => validateAnnotation(document),
			'upstream refused the file the app wrote'
		).not.toThrow();
		const parsed = parseAnnotation(document);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]?.gcps).toHaveLength(3);
		expect(parsed[0]?.resourceMask).toHaveLength(4);
		expect(parsed[0]?.resource.width).toBe(700);
		expect(parsed[0]?.transformation).toStrictEqual({ type: 'polynomial', options: { order: 1 } });
		expect(document).toMatchObject({
			type: 'Annotation',
			motivation: 'georeferencing',
			target: { source: { id: `https://unset.invalid/${imageId}`, width: 700, height: 500 } }
		});
		expect(document['@context']).toContain('http://iiif.io/api/extension/georef/1/context.json');
		expect(document.body.features).toHaveLength(3);
		expect(document.target.selector.value).toContain('points="0,0 700,0 700,500 0,500"');
		expect(document.body.transformation).toEqual({ type: 'polynomial', options: { order: 1 } });
		expect(written).not.toContain('straight');

		await clickAt(mapImage(page), 0.85, 0.2);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await expect(imagePoints(page)).toHaveCount(4);
		await watchWrites(page);
		const box = await imagePoints(page).first().boundingBox();
		if (!box) throw new Error('the Control Point has no box to drag');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10);
		await page.mouse.up();
		await expect.poll(async () => (await writes(page)).length).toBe(1);

		expect((await writes(page))[0]?.controlPoints).toBe(3);
		const pending = JSON.parse((await storedAlignment(page, imageId)) as string);
		expect(pending.body.features).toHaveLength(3);
		for (const feature of pending.body.features) {
			expect(feature.properties.resourceCoords).toHaveLength(2);
			expect(feature.geometry.coordinates).toHaveLength(2);
		}
		expect(consoleErrors, 'autosave must skip an incomplete pair, not throw on it').toEqual([]);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');

		const coordinatesBefore = await rows(page).allInnerTexts();
		await page.reload();
		await expect(page.getByRole('heading', { name: /^Align(?::|$)/ })).toBeVisible();
		await expect(page.getByTestId('image-pane')).toBeVisible();

		await expect(rows(page)).toHaveCount(3);
		await expect(imagePoints(page)).toHaveText(['1', '2', '3']);
		await expect(basePoints(page)).toHaveText(['1', '2', '3']);
		await expect(page.getByTestId('control-point-select')).toHaveText([
			'Point 1',
			'Point 2',
			'Point 3'
		]);
		expect(await rows(page).allInnerTexts()).toEqual(coordinatesBefore);
		await expectWarpedDrawn(page);
		expect(
			await warpedTiles(page),
			'the Map Image did not render warped after a reload'
		).toBeGreaterThan(0);
	});

	test('surfaces an Alignment that is there and cannot be read, rather than silently emptying it', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePair(page, [0.3, 0.3]);
		await waitForStored(page, imageId, 1);

		await writeProjectFile(page, `alignments/${imageId}.json`, '{ not an annotation', '');

		await page.reload();

		await expect(page.getByTestId('alignment-failure')).toBeVisible();
		await expect(page.getByTestId('alignment-failure')).toContainText(imageId);
		await expect(rows(page)).toHaveCount(0);
	});
});

test.describe('drawing the Base Map while aligning', () => {
	const storedAppearance = async (page: Page): Promise<unknown> =>
		(
			await readStoredJsonOrNull<{ baseMapAppearance?: unknown }>(
				page,
				'amsterdam-1625/project.json'
			)
		)?.baseMapAppearance ?? null;

	const WITHOUT_STREETS = { streets: false, relief: false, highContrast: false, imagery: false };

	test('operating one records it in the Project, leaves the pane live, and survives a reload', async ({
		page
	}) => {
		await start(page);
		await openBaseMapOptions(page);
		await drawSwitch(page, 'Streets').click();
		await expect.poll(() => storedAppearance(page)).toEqual(WITHOUT_STREETS);

		await expect(baseMap(page)).toBeVisible();
		await page.waitForFunction(
			() => window.ballastellaBaseMap?.isStyleLoaded() === true,
			undefined,
			{
				timeout: 30_000
			}
		);

		await page.reload();
		await openBaseMapOptions(page);
		await expect(drawSwitch(page, 'Streets')).not.toBeChecked();
	});
});
