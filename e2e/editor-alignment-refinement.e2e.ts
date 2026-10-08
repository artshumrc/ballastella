import { expect, test, type Locator, type Page } from './support/test.js';

import {
	IMAGE_HEIGHT,
	IMAGE_WIDTH,
	drawnMap,
	mapImage,
	imagePoints,
	makePair,
	makePairs,
	maskEdges,
	maskVertices,
	ringArea,
	rows,
	start,
	storedAlignment,
	storedMask,
	storedProjectFile,
	waitForStored,
	waitForSurface,
	warpedTiles,
	watchWrites,
	writes,
	expectWarpedDrawn
} from './support/alignment-workspace';
import { routeBaseMapArchive } from './support/editor-deployment';
import { clickAt } from './support/annotations.js';

const picker = (page: Page) => page.getByTestId('transformation-select');
const guidance = (page: Page) => page.getByTestId('transformation-guidance');
const advancedToggle = (page: Page) => page.getByTestId('transformation-advanced');
const foldWarning = (page: Page) => page.getByTestId('fold-warning');
const distortionControls = (page: Page) => page.getByTestId('distortion-controls');
const distortionToggle = (page: Page) => page.getByTestId('distortion-toggle');
const gridToggle = (page: Page) => page.getByTestId('grid-toggle');
const checkToggle = (page: Page) => page.getByTestId('check-alignment-toggle');
const maskToggle = (page: Page) => page.getByTestId('mask-edit-toggle');
const maskSummary = (page: Page) => page.getByTestId('mask-summary');
const maskCorners = (page: Page) => page.getByTestId('resource-mask-controls');
const maskStatus = (page: Page) => page.getByTestId('mask-status');
const WHOLE_SHEET = `0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}`;

test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

async function openCheck(page: Page): Promise<void> {
	await checkToggle(page).click();
	await expect(distortionControls(page)).toBeVisible();
}

async function startWithMask(page: Page, pairs: number): Promise<string> {
	const imageId = await start(page);
	await makePairs(page, pairs);
	await waitForStored(page, imageId, pairs);
	await maskToggle(page).check();
	await expect(maskVertices(page)).toHaveCount(4);
	return imageId;
}

function recordErrors(page: Page): string[] {
	const thrown: string[] = [];
	page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));
	return thrown;
}

async function dragBy(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
	await handle.scrollIntoViewIfNeeded();
	const box = await handle.boundingBox();
	if (!box) throw new Error('the handle has no box to drag');
	const fromX = box.x + box.width / 2;
	const fromY = box.y + box.height / 2;
	await page.mouse.move(fromX, fromY);
	await page.mouse.down();
	for (let step = 1; step <= 10; step += 1) {
		await page.mouse.move(fromX + (dx * step) / 10, fromY + (dy * step) / 10);
	}
	await page.mouse.up();
}

const maskOutlineAt = (page: Page, point: { x: number; y: number }) =>
	page.evaluate(({ x, y }) => {
		const map = (
			window as unknown as {
				ballastellaImagePane?: {
					getCanvas(): HTMLCanvasElement;
					queryRenderedFeatures(
						geometry: [[number, number], [number, number]],
						options: { layers: string[] }
					): unknown[];
				};
			}
		).ballastellaImagePane;
		if (!map) return false;
		const canvas = map.getCanvas().getBoundingClientRect();
		const at: [number, number] = [x - canvas.left, y - canvas.top];
		return (
			map.queryRenderedFeatures(
				[
					[at[0] - 6, at[1] - 6],
					[at[0] + 6, at[1] + 6]
				],
				{ layers: ['resource-mask-outline'] }
			).length > 0
		);
	}, point);

const activeCursors = (page: Page, handle: string): Promise<string[]> =>
	page.evaluate((handle) => {
		const flatten = (rules: CSSRuleList): CSSRule[] =>
			[...rules].flatMap((rule) => [
				rule,
				...('cssRules' in rule ? flatten((rule as CSSGroupingRule).cssRules) : [])
			]);
		return [...document.styleSheets]
			.flatMap((sheet) => {
				try {
					return flatten(sheet.cssRules);
				} catch {
					return [];
				}
			})
			.filter(
				(rule): rule is CSSStyleRule =>
					rule instanceof CSSStyleRule &&
					rule.selectorText.includes(handle) &&
					rule.selectorText.includes(':active')
			)
			.map((rule) => rule.style.cursor);
	}, handle);

const storedTransformation = async (page: Page, imageId: string): Promise<unknown> => {
	const written = await storedAlignment(page, imageId);
	return written === null ? null : JSON.parse(written).body.transformation;
};

const worstDistortion = async (page: Page): Promise<number> =>
	(await drawnMap(page))?.worstDistortion ?? -1;

test.describe('the transformation picker (ADR-0013)', () => {
	test('names its guidance, keeps every Control Point across types, never writes straight or linear, and survives a reload', async ({
		page
	}) => {
		const imageId = await start(page);

		expect(
			await page.evaluate(() => {
				const select = document.querySelector('[data-testid="transformation-select"]');
				const id = select?.getAttribute('aria-describedby') ?? '';
				const described = id ? document.getElementById(id) : null;
				return {
					id: id !== '',
					text: described?.textContent?.trim() ?? '',
					visible: described instanceof HTMLElement && described.offsetParent !== null
				};
			})
		).toEqual({ id: true, text: 'Most printed and scanned maps', visible: true });
		await expect(guidance(page)).toHaveText('Most printed and scanned maps');
		await expect(guidance(page)).toBeVisible();

		await makePairs(page, 10);
		await waitForStored(page, imageId, 10);
		const before = await rows(page).allInnerTexts();
		expect(before).toHaveLength(10);

		const neverStraight = async (type: string) => {
			await expect.poll(async () => (await storedAlignment(page, imageId)) ?? '').not.toBe('');
			const written = (await storedAlignment(page, imageId)) as string;
			expect(written, `after choosing ${type}`).not.toContain('straight');
			expect(written, `after choosing ${type}`).not.toContain('linear');
			const transformation = JSON.parse(written).body.transformation;
			if (transformation?.type === 'polynomial') {
				expect(transformation.options?.order, `after choosing ${type}`).toBeGreaterThanOrEqual(1);
			}
		};

		await advancedToggle(page).click();
		for (const type of ['helmert', 'projective', 'thinPlateSpline', 'polynomial2', 'polynomial3']) {
			await picker(page).selectOption(type);
			await expect(picker(page)).toHaveValue(type);
			await expect(rows(page)).toHaveCount(10);
			expect(await rows(page).allInnerTexts(), `after choosing ${type}`).toEqual(before);
			await expect(imagePoints(page)).toHaveCount(10);
			await neverStraight(type);
		}

		await expect
			.poll(() => storedTransformation(page, imageId))
			.toStrictEqual({ type: 'polynomial', options: { order: 3 } });
		expect(JSON.parse((await storedAlignment(page, imageId)) as string).body.features).toHaveLength(
			10
		);

		await page.reload();
		await waitForSurface(page);
		await expect(picker(page)).toHaveValue('polynomial3');
		await expect(rows(page)).toHaveCount(10);
		await expectWarpedDrawn(page);
		await expect.poll(async () => (await drawnMap(page))?.transformationType).toBe('polynomial3');

		await picker(page).selectOption('polynomial1');
		await expect(picker(page)).toHaveValue('polynomial1');
		await neverStraight('polynomial1');
	});
});

test.describe('distortion (ADR-0013)', () => {
	test('is off by default, colours by log2sigma from theme colours, toggles the graticule, and never reaches project.json', async ({
		page
	}) => {
		const thrown = recordErrors(page);
		const imageId = await start(page);
		await makePairs(page, 4);
		await expectWarpedDrawn(page);
		expect(await warpedTiles(page)).toBeGreaterThan(0);
		const before = await storedProjectFile(page);
		expect(before).not.toBeNull();

		await expect(distortionControls(page)).toHaveCount(0);
		await openCheck(page);
		await expect(distortionToggle(page)).not.toBeChecked();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', '');
		let drawn = await drawnMap(page);
		expect(drawn?.distortionMeasure, 'nothing is being displayed').toBeUndefined();
		expect(drawn?.worstDistortion, 'and nothing is being colourised').toBe(0);
		expect([...(drawn?.distortionMeasures ?? [])].sort()).toEqual(['log2sigma', 'signDetJ']);
		await expect(gridToggle(page)).not.toBeChecked();
		expect(drawn?.renderGrid).toBe(false);

		await distortionToggle(page).check();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', 'log2sigma');
		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('log2sigma');
		drawn = await drawnMap(page);
		expect(drawn?.worstDistortion, 'the overlay is configured but draws nothing').toBeGreaterThan(
			0
		);
		for (const stop of [
			drawn?.distortionColor00,
			drawn?.distortionColor01,
			drawn?.distortionColor3
		]) {
			expect(stop).toMatch(/^#[0-9a-f]{6}$/i);
		}
		expect(drawn?.distortionColor00).not.toBe(drawn?.distortionColor01);
		expect(['red', 'darkblue']).not.toContain(drawn?.distortionColor00);
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		await page.getByTestId('distortion-measure').selectOption('signDetJ');
		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('signDetJ');

		await gridToggle(page).check();
		await expect.poll(async () => (await drawnMap(page))?.renderGrid).toBe(true);
		expect((await drawnMap(page))?.renderGridColor).toMatch(/^#[0-9a-f]{6}$/i);
		expect(await warpedTiles(page)).toBeGreaterThan(0);
		await gridToggle(page).uncheck();
		await expect.poll(async () => (await drawnMap(page))?.renderGrid).toBe(false);
		await distortionToggle(page).uncheck();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', '');

		const after = await storedProjectFile(page);
		expect(after).toBe(before);
		for (const word of ['distortion', 'log2sigma', 'renderGrid']) expect(after).not.toContain(word);
		expect(await storedAlignment(page, imageId)).not.toContain('distortion');
		expect(thrown, 'the renderer refused a ramp or graticule colour').toEqual([]);
	});

	test('goes on colourising after every kind of Alignment edit, without rebuilding the map', async ({
		page
	}) => {
		const thrown = recordErrors(page);
		const imageId = await start(page);
		await makePairs(page, 6);
		await waitForStored(page, imageId, 6);
		await expectWarpedDrawn(page);

		await openCheck(page);
		await distortionToggle(page).check();
		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('log2sigma');
		await expect.poll(() => worstDistortion(page)).toBeGreaterThan(0);

		const mapId = (await drawnMap(page))?.mapId;
		expect(mapId, 'there has to be a drawn map to keep').toBeTruthy();
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		const stillColouring = async (what: string): Promise<void> => {
			await expect.poll(() => worstDistortion(page), { message: what }).toBeGreaterThan(0);
			await expect(distortionToggle(page)).toBeChecked();
			await expect(distortionControls(page)).toHaveAttribute(
				'data-distortion-measure',
				'log2sigma'
			);
			expect((await drawnMap(page))?.mapId, `${what}: the layer was rebuilt`).toBe(mapId);
		};

		await picker(page).selectOption('projective');
		await expect.poll(async () => (await drawnMap(page))?.transformationType).toBe('projective');
		await stillColouring('after changing the transformation type');

		const movedBefore = (await drawnMap(page))?.gcps[0]?.resource ?? [];
		await dragBy(page, imagePoints(page).first(), 40, 24);
		await expect
			.poll(async () => (await drawnMap(page))?.gcps[0]?.resource?.[0])
			.not.toBe(movedBefore[0]);
		await stillColouring('after moving a Control Point');

		await page.getByTestId('control-point-delete').last().click();
		await expect(rows(page)).toHaveCount(5);
		await expect.poll(async () => (await drawnMap(page))?.gcps.length).toBe(5);
		await stillColouring('after deleting a Control Point pair');

		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);
		await dragBy(page, maskVertices(page).first(), 60, 40);
		await expect.poll(async () => (await drawnMap(page))?.resourceMask?.[0]?.[0]).not.toBe(0);
		await stillColouring('after dragging a Resource Mask corner');

		await maskEdges(page).first().click();
		await expect.poll(async () => (await drawnMap(page))?.resourceMask.length).toBe(5);
		await stillColouring('after inserting a Resource Mask corner');

		await page.getByTestId('mask-reset').click();
		await expect.poll(async () => (await drawnMap(page))?.resourceMask.length).toBe(4);
		await stillColouring('after showing the whole sheet again');

		expect(await warpedTiles(page)).toBeGreaterThan(0);
		expect(thrown, 'nothing may throw while all of that is drawn').toEqual([]);
	});
});

test('warns of a mirrored pair set under an affine transformation, with the overlay off, until the swapped pair is put right', async ({
	page
}) => {
	await start(page);
	await expect(foldWarning(page)).toHaveCount(0);

	await makePair(page, [0.25, 0.3], [0.75, 0.3]);
	await makePair(page, [0.75, 0.3], [0.25, 0.3]);
	await expect(foldWarning(page)).toHaveCount(0);
	await makePair(page, [0.5, 0.75], [0.5, 0.75]);

	await expect(picker(page)).toHaveValue('polynomial1');
	await expect(foldWarning(page)).toContainText('mirrored');
	await expect(foldWarning(page)).toHaveAttribute('data-fold-kind', 'mirrored');
	await expect(foldWarning(page)).toHaveAttribute('role', 'alert');
	await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
	await expect(distortionControls(page)).toHaveCount(0);
	await expect(distortionToggle(page)).toHaveCount(0);
	expect((await drawnMap(page))?.distortionMeasure).toBeUndefined();

	await page.getByTestId('control-point-delete').first().click();
	await page.getByTestId('control-point-delete').first().click();
	await expect(rows(page)).toHaveCount(1);
	await makePair(page, [0.25, 0.3], [0.25, 0.3]);
	await makePair(page, [0.75, 0.3], [0.75, 0.3]);
	await expect(rows(page)).toHaveCount(3);
	await expect(foldWarning(page)).toHaveCount(0);
});

test.describe('the Resource Mask', () => {
	test('starts as the whole image, outlines a corner while it is dragged, narrows the warped render, and survives a reload', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await expectWarpedDrawn(page);

		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', '4');
		expect(await storedMask(page, imageId)).toBe(WHOLE_SHEET);
		const wholeSheet = await drawnMap(page);
		expect(wholeSheet?.applyMask).toBe(true);
		expect(wholeSheet?.resourceMask).toStrictEqual([
			[0, 0],
			[IMAGE_WIDTH, 0],
			[IMAGE_WIDTH, IMAGE_HEIGHT],
			[0, IMAGE_HEIGHT]
		]);
		expect(ringArea(wholeSheet?.convexHull)).toBeGreaterThan(0);
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		await expect(maskVertices(page)).toHaveCount(0);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);
		await expect(maskEdges(page)).toHaveCount(4);

		await watchWrites(page);
		const corner = maskVertices(page).first();
		await corner.scrollIntoViewIfNeeded();
		const box = await corner.boundingBox();
		if (!box) throw new Error('the Resource Mask corner has no box to drag');
		const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		for (let step = 1; step <= 10; step += 1) {
			await page.mouse.move(from.x + step * 9, from.y + step * 6);
		}
		await expect.poll(() => maskOutlineAt(page, { x: from.x + 90, y: from.y + 60 })).toBe(true);
		expect(await writes(page)).toEqual([]);
		await page.mouse.up();
		await expect.poll(async () => (await writes(page)).length).toBe(1);

		await maskEdges(page).first().click();
		await expect(maskVertices(page)).toHaveCount(5);
		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', '5');

		await expect.poll(async () => (await storedMask(page, imageId)).split(' ').length).toBe(5);
		const writtenPoints = await storedMask(page, imageId);
		expect(writtenPoints.startsWith('0,0 ')).toBe(false);
		expect(writtenPoints).not.toMatch(/e[+-]/);

		await expect.poll(async () => (await drawnMap(page))?.resourceMask.length ?? -1).toBe(5);
		const narrowed = await drawnMap(page);
		expect(narrowed?.applyMask).toBe(true);
		expect(ringArea(narrowed?.convexHull)).toBeLessThan(ringArea(wholeSheet?.convexHull) * 0.98);
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		await page.reload();
		await waitForSurface(page);
		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', '5');
		expect(await storedMask(page, imageId)).toBe(writtenPoints);
		await expectWarpedDrawn(page);
		await expect.poll(async () => (await drawnMap(page))?.resourceMask.length).toBe(5);
	});

	test('writes a Resource Mask vertex below 1e-6 in plain decimal, and reads it back', async ({
		page
	}) => {
		const imageId = await startWithMask(page, 2);
		await expect(maskEdges(page)).toHaveCount(4);

		const originEdge = maskEdges(page).first();
		await originEdge.focus();
		await expect(originEdge).toBeFocused();

		const HALVINGS = 30;
		for (let done = 0; done < HALVINGS; done += 1) {
			await page.keyboard.press('Enter');
			await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', String(5 + done));
		}

		const tiny = IMAGE_WIDTH / 2 ** HALVINGS;
		expect(String(tiny), 'the value has to be one JavaScript writes exponentially').toMatch(/e-/);
		expect(tiny).toBeLessThan(1e-6);

		await expect
			.poll(async () => (await storedMask(page, imageId)).split(' ').length)
			.toBe(4 + HALVINGS);
		const writtenPoints = await storedMask(page, imageId);
		expect(writtenPoints).toContain('0.000000651925802230835,0');
		expect(writtenPoints).not.toMatch(/e[+-]/);
		const storedBefore = await storedAlignment(page, imageId);
		await page.reload();
		await waitForSurface(page);

		await expect(page.getByTestId('alignment-failure')).toHaveCount(0);
		await expect(rows(page)).toHaveCount(2);
		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', String(4 + HALVINGS));
		expect(await storedAlignment(page, imageId)).toBe(storedBefore);
	});

	test('is operable by keyboard, keeps focus on what follows a deleted corner or Control Point, and refuses to go below three corners', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 3);
		await waitForStored(page, imageId, 3);

		const second = imagePoints(page).nth(1);
		await second.focus();
		await expect(second).toHaveAttribute('aria-label', /Control Point 2, Map Image half/);
		await page.keyboard.press('Delete');
		await expect(imagePoints(page)).toHaveCount(2);
		await expect(imagePoints(page).nth(1)).toBeFocused();
		await expect(imagePoints(page).nth(1)).toHaveAttribute(
			'aria-label',
			/Control Point 2, Map Image half/
		);
		const listedBefore = await rows(page).allInnerTexts();
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await rows(page).allInnerTexts())[1]).not.toBe(listedBefore[1]);

		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);
		const corner = maskVertices(page).first();
		await corner.focus();
		await expect(corner).toBeFocused();
		await expect(corner).toHaveAttribute('aria-label', /Resource Mask corner 1 of 4/);
		await expect(corner).not.toHaveAttribute('aria-pressed', /.*/);
		await expect(maskEdges(page).first()).not.toHaveAttribute('aria-pressed', /.*/);
		await expect(imagePoints(page).first()).toHaveAttribute('aria-pressed', /true|false/);

		const before = await corner.boundingBox();
		await watchWrites(page);
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const after = await corner.boundingBox();
		expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(5);
		await expect(maskStatus(page)).toHaveAttribute('aria-live', 'polite');
		await expect(maskStatus(page)).toHaveAttribute('data-mask-status', 'done');
		await expect(maskStatus(page)).toContainText('corner 1 moved');

		const last = maskVertices(page).last();
		await last.focus();
		await expect(last).toHaveAttribute('aria-label', /Resource Mask corner 4 of 4/);
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);
		await expect(maskStatus(page)).toHaveAttribute('data-mask-status', 'done');
		await expect(maskStatus(page)).toContainText('3 corners left');
		await expect(maskVertices(page).last()).toBeFocused();
		await expect(maskVertices(page).last()).toHaveAttribute(
			'aria-label',
			/Resource Mask corner 3 of 3/
		);
		const storedBefore = await storedMask(page, imageId);
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(() => storedMask(page, imageId)).not.toBe(storedBefore);

		await maskVertices(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);
		await expect(maskStatus(page)).toHaveAttribute('data-mask-status', 'refused');
		await expect(maskStatus(page)).toContainText('at least 3 corners');

		await page.getByTestId('mask-reset').click();
		await expect(maskVertices(page)).toHaveCount(4);
		await expect(maskStatus(page)).toContainText('whole sheet');
		await expect.poll(() => storedMask(page, imageId)).toBe(WHOLE_SHEET);
	});

	test('promises only the gestures its handles have, puts none on the Base Map, and starts no Control Point from one', async ({
		page
	}) => {
		await startWithMask(page, 3);

		await expect(maskSummary(page)).toContainText('Drag a corner to move it');
		await expect(maskSummary(page)).toContainText('Click a dashed handle to add a corner there');
		await expect(maskSummary(page)).not.toContainText(/drag[^.]*\bto add\b/i);

		const cursorOf = (testid: string) =>
			page.evaluate((id) => {
				const element = document.querySelector(`[data-testid="${id}"]`);
				return element ? getComputedStyle(element).cursor : '';
			}, testid);
		expect(await cursorOf('pane-overlay-point-mask-vertex')).toBe('grab');
		expect(await cursorOf('pane-overlay-point-mask-edge')).toBe('pointer');
		expect(await activeCursors(page, 'pane-overlay-point-mask-edge')).not.toContain('grabbing');
		expect(await activeCursors(page, 'pane-overlay-point-mask-vertex')).toContain('grabbing');

		const baseMap = page.getByTestId('base-map-pane');
		for (const handle of ['pane-overlay-point-mask-vertex', 'pane-overlay-point-mask-edge']) {
			await expect(baseMap.locator(`[data-testid="${handle}"]`)).toHaveCount(0);
		}

		await maskEdges(page).first().click();
		await expect(maskVertices(page)).toHaveCount(5);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
		await expect(rows(page)).toHaveCount(3);

		await clickAt(mapImage(page), 0.55, 0.9);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
	});
});
