import { expect, test as base, type Locator, type Page } from './support/test.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openLayerRow } from './support/layers.js';
import { leaderIsDrawn, leaderLayer, leaderPoints } from './support/leader.js';
import { countFileReads, countFileWrites, fileReads, fileWrites } from './support/store-traffic.js';
import { AMBIGUOUS_QUERY, candidateAt, routePlaceLookup } from './support/places.js';
import {
	ANNOTATION_COLOR,
	annotationLayerId,
	annotationWrites,
	baseMap,
	centreOnAmsterdam,
	chooseColour,
	chooseTool,
	chooseLineStyle,
	clickAt,
	createProject,
	deleteAnnotation,
	drawPin,
	drawCircle,
	drawShape,
	editAnnotationText,
	featureState,
	hashesUnder,
	inspector,
	openFace,
	moveMap,
	openLayers,
	pointFeature,
	PROJECT_DIRECTORY,
	PROJECT_NAME,
	readProjectFile,
	reopenLayers,
	selectAnnotation,
	paintProperty,
	projectJson,
	projectOnMap,
	seedAnnotationProject,
	seedAnnotations,
	stackBuilds,
	waitForPaintedAnnotations,
	startAnnotating,
	storedAnnotations,
	watchAnnotationWrites,
	writeAnnotations,
	writeProjectFile,
	type StackWindow
} from './support/annotations';
import { emptyWorkspace } from './support/workspace.js';

const test = base.extend<{ failures: string[] }>({
	failures: [
		async ({ page }, use) => {
			const failures: string[] = [];
			page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
			page.on('dialog', (dialog) => {
				failures.push(`dialog: ${dialog.message()}`);
				void dialog.dismiss();
			});
			await use(failures);
			expect(failures).toEqual([]);
		},
		{ auto: true }
	]
});

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

type Point = { x: number; y: number };

const saved = (page: Page) => expect(page.getByRole('status')).toHaveText('Saved here');
const gap = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centreOf = (box: Point & { width: number; height: number }): Point => ({
	x: box.x + box.width / 2,
	y: box.y + box.height / 2
});
const vertexHandles = (page: Page) => page.getByTestId('pane-overlay-point-annotation-vertex');
const layerRow = (page: Page, layerId: string) =>
	page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`);
const mapIsMoving = (page: Page) =>
	page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack!.map.isMoving());
const mapCentre = (page: Page) =>
	page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack!.map.getCenter());

async function withOnePin(page: Page, fx = 0.4, fy = 0.4): Promise<string> {
	const layerId = await startAnnotating(page);
	await drawPin(page, fx, fy);
	await chooseTool(page, 'select');
	await selectAnnotation(page);
	return layerId;
}

async function addAnnotationLayer(page: Page, existing: string): Promise<string> {
	await page.getByTestId('add-annotation-layer').click();
	await expect(page.getByTestId('layer-row')).toHaveCount(2);
	await saved(page);
	await annotationLayerId(page, 1);
	const first = await annotationLayerId(page, 0);
	return first === existing ? annotationLayerId(page, 1) : first;
}

async function dragHandle(page: Page, handle: Locator, dx: number, dy: number): Promise<void> {
	const from = centreOf((await handle.boundingBox())!);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(from.x + dx, from.y + dy);
	await page.mouse.up();
}

async function tabTo(page: Page, target: Locator, what: string, resetFocus = true) {
	if (resetFocus) await page.locator('body').click({ position: { x: 2, y: 2 } });
	for (let press = 0; press < 250; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

const MARK_CLEARANCE = 2;
const RESERVATION_EASE_MS = 300;

const SIMPLESTYLE_NAMES = new Set([
	'title',
	'description',
	'marker-size',
	'marker-symbol',
	'marker-color',
	'stroke',
	'stroke-opacity',
	'stroke-width',
	'fill',
	'fill-opacity',
	'stroke-dasharray'
]);

const circleOf = (feature: unknown) =>
	(feature as Record<string, { radiusMeters: number }>)['ballastella:circle']!;

test.describe('drawing', () => {
	test('a pin, a line, an announced shape, and a circle land in the Annotation Layer’s own file as portable GeoJSON', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		const status = page.getByTestId('annotation-status');

		await drawPin(page, 0.3, 0.3);
		await drawShape(page, 'line', [
			[0.4, 0.4],
			[0.6, 0.45]
		]);
		await chooseTool(page, 'polygon');
		await expect(status).toContainText('Click the map to start');
		await clickAt(baseMap(page), 0.5, 0.6);
		await expect(status).toContainText('1 point. 2 more needed');
		await clickAt(baseMap(page), 0.7, 0.6);
		await clickAt(baseMap(page), 0.6, 0.8);
		await expect(status).toContainText('3 points. Done to finish');
		await page.getByTestId('annotation-done').click();
		await expect(status).toContainText('Shape added');
		await expect(status).toHaveAttribute('data-tool', 'select');
		await saved(page);
		await drawCircle(page, [0.3, 0.65], [0.45, 0.8]);

		const stored = await storedAnnotations(page, layerId);
		expect(stored.type).toBe('FeatureCollection');
		expect(stored.features.map((feature) => feature.geometry?.type)).toEqual([
			'Point',
			'LineString',
			'Polygon',
			'Polygon'
		]);
		expect((await projectJson(page)).layers[0].geojsonRef).toBe(`annotations/${layerId}.geojson`);
		for (const [feature, length] of [
			[stored.features[2], 4],
			[stored.features[3], 65]
		] as const) {
			const ring = feature?.geometry?.coordinates as number[][][];
			expect(ring[0]).toHaveLength(length);
			expect(ring[0]?.at(0)).toEqual(ring[0]?.at(-1));
		}
		const circle = stored.features[3]!;
		expect(circleOf(circle)).toMatchObject({ radiusMeters: expect.any(Number) });
		const painted = await waitForPaintedAnnotations(page, [circle.id]);
		expect(painted[circle.id]).toContain(`ballastella-layer-${layerId}-fill`);
		const handles = vertexHandles(page);
		await expect(handles).toHaveCount(2);
		await expect(handles.nth(0)).toHaveAccessibleName(/Center of/);
		await expect(handles.nth(1)).toHaveAccessibleName(/Radius of/);
		await watchAnnotationWrites(page);
		await dragHandle(page, handles.nth(1), 40, 0);
		await saved(page);
		expect(await annotationWrites(page)).toHaveLength(1);
		const resized = (await storedAnnotations(page, layerId)).features[3];
		expect(circleOf(resized).radiusMeters).toBeGreaterThan(circleOf(circle).radiusMeters);
	});

	test('all three appear on the map, each painted by the layer for its geometry', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawShape(page, 'line', [
			[0.4, 0.4],
			[0.6, 0.45]
		]);
		await drawShape(page, 'polygon', [
			[0.45, 0.6],
			[0.75, 0.6],
			[0.6, 0.85]
		]);
		const stored = await storedAnnotations(page, layerId);
		const [pin, line, shape] = stored.features.map((feature) => feature.id);
		const painted = await waitForPaintedAnnotations(page, [pin!, line!, shape!]);
		expect(painted[pin!]).toContain(`ballastella-layer-${layerId}-point`);
		expect(painted[line!]).toContain(`ballastella-layer-${layerId}-line-solid`);
		expect(painted[shape!]).toContain(`ballastella-layer-${layerId}-fill`);
		await expect(page.getByTestId('annotation-row-ordinal')).toHaveText(['1', '2', '3']);

		const ring = stored.features[2]!.geometry!.coordinates as number[][][];
		const extent = (axis: 0 | 1) =>
			(Math.min(...ring[0]!.map((at) => at[axis]!)) +
				Math.max(...ring[0]!.map((at) => at[axis]!))) /
			2;
		const middle: [number, number] = [extent(0), extent(1)];
		const firstVertex = ring[0]![0] as [number, number];

		const projected = async (lngLat: [number, number]) => {
			const pane = (await baseMap(page).boundingBox())!;
			const at = await projectOnMap(page, lngLat);
			return { x: pane.x + at.x, y: pane.y + at.y };
		};

		await moveMap(page, [middle[0] + 0.02, middle[1] - 0.01], 11);

		await selectAnnotation(page, 2);
		const shapeRow = page.getByTestId('annotation-row').nth(2);

		const endFor = (target: Point, stub: Point) => {
			const run = gap(target, stub);
			return {
				x: target.x - ((target.x - stub.x) * MARK_CLEARANCE) / run,
				y: target.y - ((target.y - stub.y) * MARK_CLEARANCE) / run
			};
		};

		const drawn = await leaderPoints(page);
		expect(drawn, 'no leader was drawn for the selected Annotation').not.toBeNull();
		expect(drawn).toHaveLength(3);
		const [atRow, stub, atMark] = drawn as [Point, Point, Point];

		expect(
			gap(atMark, endFor(await projected(middle), stub)),
			'the leader’s canvas end is not where map.project() puts the coordinate on disk'
		).toBeLessThan(2);
		expect(gap(atMark, endFor(await projected(firstVertex), stub))).toBeGreaterThan(20);

		const rowBox = (await shapeRow.boundingBox())!;
		expect(atRow.x).toBeCloseTo(rowBox.x + rowBox.width, 0);
		expect(atRow.y).toBeCloseTo(rowBox.y + rowBox.height / 2, 0);

		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');
		expect(
			await leaderLayer(page).evaluate(
				(svg) => svg.querySelectorAll('a, button, input, [tabindex]').length
			)
		).toBe(0);
		expect(await leaderLayer(page).evaluate((svg) => getComputedStyle(svg).pointerEvents)).toBe(
			'none'
		);

		await moveMap(page, [middle[0] + 4, middle[1] + 2]);
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');

		await moveMap(page, middle);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		const [, followedStub, followedEnd] = (await leaderPoints(page)) as [Point, Point, Point];
		expect(
			gap(followedEnd, endFor(await projected(middle), followedStub)),
			'the leader did not follow the map back'
		).toBeLessThan(2);

		await page.setViewportSize({ width: 1280, height: 320 });
		const column = page.getByTestId('layer-scroller');
		const rowOutsideColumn = () =>
			column.evaluate((element) => {
				const rows = [...element.querySelectorAll('[data-testid="annotation-row-item"]')];
				const at = rows[rows.length - 1]!.getBoundingClientRect();
				const box = element.getBoundingClientRect();
				return at.top >= box.bottom || at.bottom <= box.top;
			});

		await column.evaluate((element) => (element.scrollTop = 0));
		expect(
			await rowOutsideColumn(),
			'the selected row is still inside its column, so this asserts nothing'
		).toBe(true);
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');

		const straddleTheEdge = () =>
			column.evaluate((element) => {
				const rows = [...element.querySelectorAll('[data-testid="annotation-row"]')];
				const at = rows[rows.length - 1]!.getBoundingClientRect();
				const box = element.getBoundingClientRect();
				element.scrollTop += (at.top + at.bottom) / 2 - box.bottom - 4;
			});
		const straddling = () =>
			column.evaluate((element) => {
				const rows = [...element.querySelectorAll('[data-testid="annotation-row"]')];
				const at = rows[rows.length - 1]!.getBoundingClientRect();
				const box = element.getBoundingClientRect();
				return {
					centreOutside: (at.top + at.bottom) / 2 > box.bottom,
					overlapping: at.top < box.bottom
				};
			});

		await straddleTheEdge();
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		expect(
			await straddling(),
			'the row is not half out of its column, so this asserts nothing about the centre'
		).toEqual({ centreOutside: true, overlapping: true });
		expect(await leaderIsDrawn(page)).toBe('no');

		await column.evaluate((element) => {
			const rows = [...element.querySelectorAll('[data-testid="annotation-row-item"]')];
			rows[rows.length - 1]!.scrollIntoView({ block: 'center' });
		});
		expect(await rowOutsideColumn()).toBe(false);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		await page.setViewportSize({ width: 1280, height: 720 });
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');

		const selectedOnMap = (id: string) => featureState(page, layerId, id);
		await expect.poll(() => selectedOnMap(shape!)).toEqual({ selected: true });
		expect(await selectedOnMap(pin!)).toEqual({});

		await selectAnnotation(page, 0);
		await expect.poll(() => selectedOnMap(pin!)).toEqual({ selected: true });
		expect(await selectedOnMap(shape!)).toEqual({});

		expect(
			await paintProperty(page, `ballastella-layer-${layerId}-line-solid`, 'line-width'),
			'the selection changed the width the scholar chose'
		).toEqual(['to-number', ['get', 'stroke-width']]);
		for (const [name, value] of [
			['line-width', ['+', ['to-number', ['get', 'stroke-width']], 6]],
			['line-opacity', ['case', ['boolean', ['feature-state', 'selected'], false], 0.3, 0]],
			['line-color', ['get', 'stroke']]
		] as const) {
			expect(await paintProperty(page, `ballastella-layer-${layerId}-selected`, name)).toEqual(
				value
			);
		}

		const topmostAt = (at: Point) =>
			page.evaluate(({ x, y }) => {
				const layer = document.querySelector<SVGSVGElement>('[data-testid="leader-line"]');
				if (layer === null) return 'no leader is drawn';
				layer.style.pointerEvents = 'auto';
				const hit = document.elementFromPoint(x, y);
				layer.style.pointerEvents = '';
				if (hit === null) return 'nothing';
				if (hit === layer || layer.contains(hit)) return 'the leader';
				if (hit.closest('[data-testid="annotation-inspector"]')) return 'the Inspector';
				if (hit.closest('.maplibregl-ctrl')) return 'a map control';
				if (hit instanceof HTMLCanvasElement) return 'the map';
				return `${hit.tagName}${hit.getAttribute('data-testid') ?? ''}`;
			}, at);

		await expect.poll(() => mapIsMoving(page)).toBe(false);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		const pane = (await baseMap(page).boundingBox())!;
		const panel = (await inspector(page).boundingBox())!;
		const zoomIn = (await page.locator('button.maplibregl-ctrl-zoom-in').boundingBox())!;

		expect(
			await topmostAt({ x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.25 }),
			'the probe cannot see the leader at all, so it cannot see it covering anything'
		).toBe('the leader');
		expect(await topmostAt(centreOf(panel)), 'the leader is drawn across the Inspector').toBe(
			'the Inspector'
		);
		expect(await topmostAt(centreOf(zoomIn)), 'the leader is drawn across the zoom control').toBe(
			'a map control'
		);
	});

	test('Escape abandons a part-drawn shape first, and then collapses the open row', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawPin(page, 0.6, 0.6);
		const rows = page.getByTestId('annotation-row');
		const status = page.getByTestId('annotation-status');
		await expect(rows).toHaveCount(2);
		const row = rows.nth(1);
		await expect(row).toHaveAttribute('aria-expanded', 'true');

		await editAnnotationText(page);
		for (const field of ['annotation-title', 'annotation-description']) {
			await page.getByTestId(field).focus();
			await page.keyboard.press('Escape');
			await expect(row).toHaveAttribute('aria-expanded', 'true');
			await expect(inspector(page)).toHaveCount(1);
		}

		await page.getByTestId('edit-project-name').click();
		await page.getByTestId('make-offline').click();
		await expect(page.locator('dialog[open]')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(page.locator('dialog[open]')).toHaveCount(0);
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(inspector(page)).toHaveCount(1);

		const ids = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		await waitForPaintedAnnotations(page, ids);
		await watchAnnotationWrites(page);

		await chooseTool(page, 'polygon');
		await expect(inspector(page)).toHaveCount(0);
		await clickAt(baseMap(page), 0.3, 0.3);
		await expect(status).toContainText('1 point. 2 more needed');
		await expect(inspector(page)).toHaveCount(0);
		await clickAt(baseMap(page), 0.5, 0.4);
		await expect(status).toHaveAttribute('data-drawing', 'true');

		const reopened = rows.nth(0);
		await reopened.click();
		await expect(reopened).toHaveAttribute('aria-expanded', 'true');
		await expect(status).toHaveAttribute('data-drawing', 'true');

		await page.keyboard.press('Escape');

		await expect(status).toHaveAttribute('data-drawing', 'false');
		await expect(status).toHaveAttribute('data-tool', 'select');
		await expect(reopened).toHaveAttribute('aria-expanded', 'true');

		await page.keyboard.press('Escape');
		await expect(inspector(page)).toHaveCount(0);
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'false');
		await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');

		expect((await storedAnnotations(page, layerId)).features).toHaveLength(2);
		expect(await annotationWrites(page)).toEqual([]);
	});

	test('a shape drawn on the map arrives selected, at rest, with its title ready to type', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);

		await expect(page.getByTestId('annotation-new')).toBeVisible();
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		const status = page.getByTestId('annotation-status');
		await expect(status).toHaveAttribute('data-tool', 'select');
		await expect(status).toHaveAttribute('data-drawing', 'false');

		const row = page.getByTestId('annotation-row');
		await expect(row).toHaveCount(1);
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(inspector(page)).toBeVisible();
		await expect(page.getByTestId('annotation-title')).toBeFocused();
		expect(
			await row.evaluate((element) => element.closest('li')!.children.length),
			'the selected row opened something inside itself'
		).toBe(1);

		await page.getByTestId('annotation-title').fill('The west quay');
		await page.getByTestId('annotation-text-done').click();
		await expect(inspector(page)).toContainText('The west quay');

		await openFace(page, 'style');
		await openFace(page, 'text');
		await expect(page.getByTestId('annotation-title')).toHaveCount(0);
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('The west quay');

		await row.click();
		await expect(inspector(page)).toHaveCount(0);
		await clickAt(baseMap(page), 0.4, 0.4);
		await expect(inspector(page)).toContainText('The west quay');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		await page.getByTestId('annotation-new').click();
		await expect(inspector(page)).toHaveCount(0);
		await page.getByTestId('annotation-tool-point').click();
		await clickAt(baseMap(page), 0.6, 0.6);
		await saved(page);
		await expect(inspector(page)).not.toContainText('The west quay');
	});

	test('the selected row wears the Layer’s own wash and a spine in its ink', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await drawPin(page, 0.6, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page, 0);

		const rows = page.getByTestId('annotation-row-item');
		const [marked, plain] = [rows.nth(0), rows.nth(1)];
		const style = (target: Locator) =>
			target.evaluate((element) => {
				const { backgroundColor, color, boxShadow, borderLeftWidth } = getComputedStyle(element);
				return { backgroundColor, color, boxShadow, borderLeftWidth };
			});

		const wash = (await style(layerRow(page, layerId).getByTestId('layer-header'))).backgroundColor;
		await expect.poll(async () => (await style(marked)).backgroundColor).toBe(wash);
		await expect.poll(async () => (await style(plain)).backgroundColor).toBe('rgba(0, 0, 0, 0)');

		const nameInk = async (target: Locator) =>
			(await style(target.getByTestId('annotation-row-name'))).color;
		expect(await nameInk(marked)).not.toBe(await nameInk(plain));
		const ink = (await style(marked.getByTestId('annotation-row-ordinal'))).color;
		const spine = (await style(marked)).boxShadow;
		expect(spine).toMatch(/2px 0px 0px 0px inset/);
		expect(spine).toContain(ink);
		expect((await style(plain)).boxShadow).toBe('none');
		for (const row of [marked, plain]) expect((await style(row)).borderLeftWidth).toBe('0px');
	});
});

test.describe('editing a vertex costs exactly one write, on gesture end (ADR-0017 rule 1)', () => {
	test('a held arrow key, a reshaped polygon, and a dragged vertex each write once, and the ring stays closed', async ({
		page
	}) => {
		const layerId = await withOnePin(page);
		const handles = vertexHandles(page);
		await handles.focus();
		const before = await storedAnnotations(page, layerId);
		await watchAnnotationWrites(page);

		await page.keyboard.down('ArrowRight');
		for (let repeat = 0; repeat < 5; repeat += 1) await page.keyboard.down('ArrowRight');
		await page.keyboard.up('ArrowRight');
		await saved(page);

		expect(await annotationWrites(page)).toHaveLength(1);
		expect((await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates).not.toEqual(
			before.features[0]?.geometry?.coordinates
		);

		await drawShape(page, 'polygon', [
			[0.5, 0.5],
			[0.8, 0.5],
			[0.65, 0.8]
		]);
		await selectAnnotation(page, 1);
		await expect(handles).toHaveCount(3);
		await handles.first().focus();
		await page.keyboard.press('Shift+ArrowRight');
		await saved(page);

		const ring = (await storedAnnotations(page, layerId)).features[1]?.geometry
			?.coordinates as number[][][];
		expect(ring[0]).toHaveLength(4);
		expect(ring[0]?.at(0)).toEqual(ring[0]?.at(-1));

		await drawShape(page, 'line', [
			[0.15, 0.7],
			[0.4, 0.75]
		]);
		await chooseTool(page, 'select');
		await selectAnnotation(page, 2);
		const handle = vertexHandles(page);
		await expect(handle).toHaveCount(2);

		const lineBefore = await storedAnnotations(page, layerId);
		await watchAnnotationWrites(page);

		const from = centreOf((await handle.first().boundingBox())!);
		const to = { x: from.x + 50, y: from.y - 50 };
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y);
		await expect
			.poll(() =>
				page.evaluate(({ x, y }) => {
					const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
					if (!map) return false;
					const canvas = map.getCanvas().getBoundingClientRect();
					const at: [number, number] = [x - canvas.left, y - canvas.top];
					return map
						.queryRenderedFeatures(
							[
								[at[0] - 6, at[1] - 6],
								[at[0] + 6, at[1] + 6]
							],
							{}
						)
						.some((feature) => feature.properties['ballastella:id'] !== undefined);
				}, to)
			)
			.toBe(true);
		await page.mouse.up();
		await saved(page);

		expect(await annotationWrites(page)).toHaveLength(1);
		const after = await storedAnnotations(page, layerId);
		expect(after.features[2]?.geometry?.coordinates).not.toEqual(
			lineBefore.features[2]?.geometry?.coordinates
		);
	});
});

test.describe('title and description', () => {
	test('both persist across a reload, and a session that only looked leaves the file byte-identical (ADR-0002, ADR-0010)', async ({
		page
	}) => {
		const layerId = await withOnePin(page);

		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Warehouses');
		await page.getByTestId('annotation-title').blur();
		await page.getByTestId('annotation-description').fill('The *west* quay.');
		await page.getByTestId('annotation-description').blur();
		await saved(page);

		expect((await storedAnnotations(page, layerId)).features[0]?.properties).toEqual({
			title: 'Warehouses',
			description: 'The *west* quay.',
			'marker-color': ANNOTATION_COLOR.grey,
			stroke: ANNOTATION_COLOR.grey,
			fill: ANNOTATION_COLOR.grey
		});
		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(1);
		await watchAnnotationWrites(page);

		await reopenLayers(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('Warehouses');
		await expect(page.getByTestId('annotation-description-text')).toContainText('The west quay.');
		expect((await inspector(page).innerText()).match(/Warehouses/g)).toHaveLength(1);

		const row = page.getByTestId('annotation-row').first();
		await row.click();
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect(inspector(page)).toHaveCount(0);
		await row.click();
		await expect(row).toHaveAttribute('aria-expanded', 'true');

		await clickAt(baseMap(page), 0.4, 0.4);
		await editAnnotationText(page);
		await expect(page.getByTestId('annotation-title')).toHaveValue('Warehouses');
		await expect(page.getByTestId('annotation-description')).toHaveValue('The *west* quay.');
		for (const field of ['annotation-title', 'annotation-description']) {
			await page.getByTestId(field).focus();
			await page.getByTestId(field).blur();
		}
		await page.getByTestId('layer-rename').click();
		await page.getByTestId('layer-name').fill('Trade routes');
		await page.getByTestId('layer-name').blur();
		await saved(page);

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect(await annotationWrites(page)).toEqual([]);
		expect((await projectJson(page)).layers[0].name).toBe('Trade routes');
	});

	test('typing or recolouring does not rebuild the Layer stack, so the map does not thrash', async ({
		page
	}) => {
		const layerId = await withOnePin(page);
		const before = await stackBuilds(page);
		expect(before).toBeGreaterThan(0);
		const onlyRow = page.getByTestId('annotation-row').first();
		await onlyRow.click();
		await expect(onlyRow).toHaveAttribute('aria-expanded', 'false');
		await countFileReads(page);
		await countFileWrites(page);
		const camera = await mapCentre(page);
		await onlyRow.click();
		await expect(onlyRow).toHaveAttribute('aria-expanded', 'true');
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		expect(await fileReads(page), 'selecting an Annotation read from the store').toEqual({});
		expect(await fileWrites(page), 'selecting an Annotation wrote to the store').toEqual([]);
		expect(await mapIsMoving(page), 'selecting a mark already in view started a camera move').toBe(
			false
		);
		expect(await mapCentre(page)).toEqual(camera);
		await page.waitForTimeout(RESERVATION_EASE_MS + 200);
		expect(await mapIsMoving(page), 'the camera moved a moment after the selection').toBe(false);
		expect(await mapCentre(page)).toEqual(camera);

		await editAnnotationText(page);
		await page.getByTestId('annotation-title').click();

		await page.keyboard.type('The old mill', { delay: 40 });
		await page.getByTestId('annotation-description').click();
		await page.keyboard.type('Built 1780.', { delay: 40 });
		await saved(page);

		expect(await stackBuilds(page)).toBe(before);
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features[0]?.properties).toMatchObject({
			title: 'The old mill',
			description: 'Built 1780.'
		});
		expect(
			await featureState(page, layerId, stored.features[0]!.id),
			'the selected Annotation lost its emphasis while its title was typed'
		).toEqual({ selected: true });
		expect(
			(await fileWrites(page)).length,
			'no write was counted at all, so the empty write assertion above is vacuous'
		).toBeGreaterThan(0);
		expect(
			Object.keys(await fileReads(page)),
			'no read was counted at all, so the empty read assertion above is vacuous'
		).not.toEqual([]);

		const purple = await chooseColour(page, 'annotation-marker-color', 'purple');
		await expect
			.poll(async () => (await storedAnnotations(page, layerId)).features[0]?.properties)
			.toMatchObject({ 'marker-color': purple });
		expect(await stackBuilds(page)).toBe(before);
	});
});

test.describe('a description is untrusted, and this is asserted not assumed (ADR-0009)', () => {
	const PROSE = 'The **west** quay, per the survey.';

	const PAYLOAD =
		`${PROSE}` +
		'<img src=x onerror="window.__xss=1">' +
		'<script>window.__xss=1</script>' +
		'[click](javascript:window.__xss=1)' +
		'<a href="data:text/html,&lt;script&gt;1&lt;/script&gt;">d</a>' +
		'<svg onload="window.__xss=1"></svg>';

	const INERT = {
		missing: false,
		scripts: 0,
		images: 0,
		svgs: 0,
		handlers: [],
		executableUrls: []
	};

	async function inertWithin(page: Page, selector: string) {
		return page.evaluate((selector) => {
			const host = document.querySelector(selector);
			if (!host) return { missing: true };
			const handlers: string[] = [];
			const urls: string[] = [];
			for (const element of host.querySelectorAll('*')) {
				for (const attribute of element.attributes) {
					if (attribute.name.toLowerCase().startsWith('on')) handlers.push(attribute.name);
				}
				for (const name of ['href', 'src', 'xlink:href', 'action']) {
					const value = element.getAttribute(name);
					if (value !== null) urls.push(value);
				}
			}
			return {
				missing: false,
				scripts: host.querySelectorAll('script').length,
				images: host.querySelectorAll('img').length,
				svgs: host.querySelectorAll('svg').length,
				iframes: host.querySelectorAll('iframe').length,
				ids: host.querySelectorAll('[id]').length,
				handlers,
				executableUrls: urls.filter((url) =>
					/^(javascript|data|vbscript):/i.test(
						[...url].filter((character) => (character.codePointAt(0) ?? 0) > 0x20).join('')
					)
				),
				text: host.textContent ?? ''
			};
		}, selector);
	}

	test('the payload is inert in the row where it is read, and rendering it does not rewrite its file', async ({
		page
	}) => {
		const layerId = await seedAnnotations(page, [
			pointFeature('payload', [4.9, 52.37], { title: PAYLOAD, description: PAYLOAD })
		]);
		const before = await hashesUnder(page, 'annotations/');
		await chooseTool(page, 'select');

		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

		const description = await inertWithin(page, '[data-testid="annotation-description-text"]');
		expect(description.text).toContain('The west quay, per the survey.');
		await expect(page.getByTestId('annotation-description-text').locator('strong')).toHaveText(
			'west'
		);
		expect(description).toMatchObject({ ...INERT, iframes: 0, ids: 0 });

		const title = await inertWithin(page, '[data-testid="annotation-inspector-name"]');
		expect(title.text).toContain('onerror');
		expect(title).toMatchObject(INERT);

		expect(
			await page.evaluate(() => ({
				ran: '__xss' in window,
				injectedImage: document.querySelector('img[src="x"]') !== null,
				injectedScript: [...document.querySelectorAll('script')].some((script) =>
					(script.textContent ?? '').includes('__xss')
				)
			}))
		).toEqual({ ran: false, injectedImage: false, injectedScript: false });

		await editAnnotationText(page);
		await page.getByTestId('annotation-title').focus();
		await page.getByTestId('annotation-title').blur();

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect((await storedAnnotations(page, layerId)).features[0]?.properties['title']).toBe(PAYLOAD);
	});
});

test.describe('style controls write simplestyle names exactly', () => {
	test('the nine colours fit on one line inside the Inspector, and a pin’s marker properties reach the file under simplestyle’s own names', async ({
		page
	}) => {
		const layerId = await withOnePin(page);
		await openFace(page, 'style');

		const boxes = await page
			.getByTestId('annotation-marker-color')
			.locator('label')
			.evaluateAll((labels) =>
				labels.map((label) => {
					const box = label.getBoundingClientRect();
					return { top: Math.round(box.top), right: Math.round(box.right) };
				})
			);
		expect(boxes).toHaveLength(9);
		expect(new Set(boxes.map((box) => box.top)).size).toBe(1);
		const panel = (await inspector(page).boundingBox())!;
		expect(Math.max(...boxes.map((box) => box.right))).toBeLessThanOrEqual(
			Math.round(panel.x + panel.width)
		);

		const chosen = await chooseColour(page, 'annotation-marker-color', 'purple');
		await expect(page.getByTestId('annotation-marker-color-chosen')).toHaveText('Purple');
		expect(chosen).toBe(ANNOTATION_COLOR.purple);
		await page.getByTestId('annotation-marker-size-large').click();
		await saved(page);
		await expect
			.poll(async () => (await storedAnnotations(page, layerId)).features[0]!.properties)
			.toMatchObject({ 'marker-color': chosen, 'marker-size': 'large' });
	});
});

const renderedStyles = (page: Page) =>
	page.evaluate(() => {
		const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
		const out: Record<string, Record<string, unknown>> = {};
		for (const feature of map?.queryRenderedFeatures() ?? []) {
			const id = feature.properties?.['ballastella:id'];
			if (typeof id === 'string') out[id] = feature.properties;
		}
		return out;
	});

const line = (
	id: string,
	from: [number, number],
	to: [number, number],
	properties: Record<string, unknown>
) => ({
	type: 'Feature',
	id,
	properties,
	geometry: { type: 'LineString', coordinates: [from, to] }
});

const labelFeature = (id: string, at: [number, number], properties: Record<string, unknown>) =>
	pointFeature(id, at, { 'marker-symbol': 'label', ...properties });

const annotationsAt = (page: Page, at: [number, number], dx = 0, dy = 0) =>
	page.evaluate(
		([coordinate, offsetX, offsetY]) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			const point = map.project(coordinate as [number, number]);
			return map
				.queryRenderedFeatures([point.x + (offsetX as number), point.y + (offsetY as number)], {})
				.filter((feature) => typeof feature.properties['ballastella:id'] === 'string')
				.map((feature) => ({
					id: feature.properties['ballastella:id'] as string,
					layer: feature.layer.id,
					title: feature.properties['title']
				}));
		},
		[at, dx, dy] as const
	);

const chipWidth = (page: Page, at: [number, number], id: string) =>
	page.evaluate(
		([coordinate, wanted]) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			const point = map.project(coordinate as [number, number]);
			const hits = (dx: number) =>
				map
					.queryRenderedFeatures([point.x + dx, point.y], {})
					.some((feature) => feature.properties['ballastella:id'] === wanted);
			let reach = 0;
			for (let dx = 0; dx <= 300; dx += 2) {
				if (!hits(dx)) break;
				reach = dx;
			}
			return reach * 2;
		},
		[at, id] as const
	);

const pixelsAbove = (page: Page, at: [number, number], rows: number) =>
	page.evaluate(
		([coordinate, height]) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			const canvas = map.getCanvas();
			const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
			if (gl === null) throw new Error('the map canvas has no WebGL2 context to read');
			const point = map.project(coordinate as [number, number]);
			const ratio = canvas.width / canvas.clientWidth;
			return new Promise<string[]>((resolve) => {
				map.once('render', () => {
					const column: string[] = [];
					for (let up = 0; up < (height as number); up += 1) {
						const pixel = new Uint8Array(4);
						gl.readPixels(
							Math.round(point.x * ratio),
							Math.round(canvas.height - (point.y - up) * ratio),
							1,
							1,
							gl.RGBA,
							gl.UNSIGNED_BYTE,
							pixel
						);
						column.push([...pixel].join(','));
					}
					resolve(column);
				});
				map.triggerRepaint();
			});
		},
		[at, rows] as const
	);

const onlyPinAt = async (page: Page, at: [number, number], layerId: string, id: string) => {
	const hits = await annotationsAt(page, at, 0, -12);
	expect(new Set(hits.map((hit) => hit.layer))).toEqual(
		new Set([`ballastella-layer-${layerId}-point`])
	);
	expect(new Set(hits.map((hit) => hit.id))).toEqual(new Set([id]));
};

test.describe('solid, dashed, and dotted', () => {
	test('the three render distinctly, each by its own layer with its own dash pattern', async ({
		page
	}) => {
		const layerId = await seedAnnotations(page, [
			line('certain', [4.8, 52.3], [5.0, 52.3], {}),
			line('conjectural', [4.8, 52.35], [5.0, 52.35], { 'stroke-dasharray': [8, 4] }),
			line('guessed', [4.8, 52.4], [5.0, 52.4], { 'stroke-dasharray': [1, 3] })
		]);

		const painted = await waitForPaintedAnnotations(page, ['certain', 'conjectural', 'guessed']);
		for (const [id, style, dash] of [
			['certain', 'solid', null],
			['conjectural', 'dashed', [4, 2]],
			['guessed', 'dotted', [0.5, 1.5]]
		] as const) {
			const layer = `ballastella-layer-${layerId}-line-${style}`;
			expect(painted[id]).toContain(layer);
			expect((painted[id] ?? []).filter((name) => name.includes('-line-'))).toHaveLength(1);
			expect(await paintProperty(page, layer, 'line-dasharray')).toEqual(dash);
		}
	});
});

test.describe('a Label draws its words on the map', () => {
	const PAYLOAD = '<img src=x onerror=alert(1)>Zuiderzee';
	const SHORT: [number, number] = [4.9, 52.51];
	const LONG: [number, number] = [4.9, 52.44];
	const BLANK: [number, number] = [4.9, 52.37];
	const UNTRUSTED: [number, number] = [4.9, 52.3];
	const PIN: [number, number] = [4.9, 52.23];
	const SPACES: [number, number] = [5.05, 52.37];

	test('each Label is drawn from the Label bucket, the Pin beside it is not, and an empty one draws nothing', async ({
		page
	}) => {
		const layerId = await seedAnnotations(page, [
			labelFeature('short', SHORT, { title: 'Ee', fill: ANNOTATION_COLOR.blue }),
			labelFeature('long', LONG, {
				title: 'Zuiderzee en de Waddenzee',
				fill: ANNOTATION_COLOR.red
			}),
			labelFeature('blank', BLANK, { title: '' }),
			labelFeature('spaces', SPACES, { title: ' ', fill: ANNOTATION_COLOR.blue }),
			labelFeature('untrusted', UNTRUSTED, { title: PAYLOAD }),
			pointFeature('pin', PIN, { title: 'The old harbour' })
		]);
		await waitForPaintedAnnotations(page, ['short', 'long', 'untrusted', 'pin']);

		const labelLayer = `ballastella-layer-${layerId}-label`;
		expect(await annotationsAt(page, SHORT)).toContainEqual({
			id: 'short',
			layer: labelLayer,
			title: 'Ee'
		});

		await onlyPinAt(page, PIN, layerId, 'pin');
		expect(await annotationsAt(page, SHORT)).not.toContainEqual(
			expect.objectContaining({ layer: `ballastella-layer-${layerId}-point` })
		);

		expect(await annotationsAt(page, BLANK)).toEqual([]);
		expect(await annotationsAt(page, SPACES)).toEqual([]);
		const short = await chipWidth(page, SHORT, 'short');
		expect(short).toBeGreaterThan(0);
		expect(await chipWidth(page, LONG, 'long')).toBeGreaterThan(short);

		expect(await annotationsAt(page, UNTRUSTED)).toContainEqual({
			id: 'untrusted',
			layer: labelLayer,
			title: PAYLOAD
		});
		expect(await page.locator('img[src="x"]').count()).toBe(0);
		expect(await chipWidth(page, UNTRUSTED, 'untrusted')).toBeGreaterThan(
			await chipWidth(page, SHORT, 'short')
		);
	});

	test('a Label is selected by clicking it, given a leader, and moved by its vertex handle for one write', async ({
		page
	}) => {
		const layerId = await seedAnnotations(page, [
			labelFeature('zuiderzee', BLANK, { title: 'Zuiderzee' })
		]);
		await waitForPaintedAnnotations(page, ['zuiderzee']);

		const pane = (await baseMap(page).boundingBox())!;
		const at = await projectOnMap(page, BLANK);
		const onPage = { x: pane.x + at.x, y: pane.y + at.y };
		const beforeSelecting = await pixelsAbove(page, BLANK, 40);
		await page.mouse.click(onPage.x, onPage.y);

		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('Zuiderzee');
		expect(await featureState(page, layerId, 'zuiderzee')).toEqual({ selected: true });
		const afterSelecting = await pixelsAbove(page, BLANK, 40);
		const changed = beforeSelecting.filter((pixel, row) => pixel !== afterSelecting[row]).length;
		expect(changed).toBeGreaterThanOrEqual(2);

		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		expect(gap((await leaderPoints(page))!.at(-1)!, onPage)).toBeLessThanOrEqual(
			MARK_CLEARANCE + 1
		);

		const handle = vertexHandles(page);
		await expect(handle).toHaveCount(1);
		const before = (await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates;
		await watchAnnotationWrites(page);
		await dragHandle(page, handle, 40, -40);
		await saved(page);

		expect(await annotationWrites(page)).toHaveLength(1);
		expect((await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates).not.toEqual(
			before
		);
	});

	test('the chip fits its words at all three sizes, with a short word and a long phrase', async ({
		page
	}) => {
		const layerId = await seedAnnotationProject(page);
		const WORDS = { short: 'Ee', long: 'Zuiderzee en de Waddenzee' };
		const LON = { short: 4.7, long: 5.1 };
		const ROWS = [
			{ size: 'small', lat: 52.51 },
			{ size: 'medium', lat: 52.37 },
			{ size: 'large', lat: 52.23 }
		] as const;
		const LENGTHS = ['short', 'long'] as const;

		await writeAnnotations(
			page,
			layerId,
			ROWS.flatMap(({ size, lat }) =>
				LENGTHS.map((length) =>
					labelFeature(`${length}-${size}`, [LON[length], lat], {
						title: WORDS[length],
						'marker-size': size,
						fill: length === 'short' ? ANNOTATION_COLOR.blue : ANNOTATION_COLOR.red
					})
				)
			)
		);
		await reopenLayers(page);
		await centreOnAmsterdam(page);
		await waitForPaintedAnnotations(
			page,
			ROWS.flatMap(({ size }) => LENGTHS.map((length) => `${length}-${size}`))
		);

		const widths: Record<string, { short: number; long: number }> = {};
		for (const { size, lat } of ROWS) {
			const width = { short: 0, long: 0 };
			for (const length of LENGTHS) {
				expect(await annotationsAt(page, [LON[length], lat])).toContainEqual({
					id: `${length}-${size}`,
					layer: `ballastella-layer-${layerId}-label`,
					title: WORDS[length]
				});
				width[length] = await chipWidth(page, [LON[length], lat], `${length}-${size}`);
			}
			expect(width.long).toBeGreaterThan(width.short);
			widths[size] = width;
		}
		expect(widths['small']!.short).toBeLessThan(widths['medium']!.short);
		expect(widths['medium']!.short).toBeLessThan(widths['large']!.short);
	});
});

test.describe('a Label is placed and its words typed', () => {
	test('typed with the keyboard alone, the words draw and the file says label; its style is inherited and the Pin after it is a Pin', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await centreOnAmsterdam(page);
		await watchAnnotationWrites(page);

		await page.getByTestId('annotation-new').press('Enter');
		await page.getByTestId('annotation-tool-text').press('Enter');
		await expect(page.getByTestId('annotation-tool-text')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('annotation-status')).toHaveText(
			'Label tool. Click the map to place.'
		);

		await page.locator('canvas.maplibregl-canvas').focus();
		await page.keyboard.press('Enter');
		await saved(page);

		await expect(page.getByTestId('annotation-status')).toContainText('Label added');
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		await expect(page.getByTestId('annotation-title')).toBeFocused();

		const untitled = await readProjectFile(page, `annotations/${layerId}.geojson`);
		expect(untitled).not.toContain('title');
		expect(await annotationWrites(page)).toEqual([
			expect.objectContaining({
				annotations: 1,
				path: `${PROJECT_DIRECTORY}/annotations/${layerId}.geojson`,
				bytes: new TextEncoder().encode(untitled).length
			})
		]);

		await page.keyboard.type('Zuiderzee', { delay: 20 });
		await saved(page);

		const label = (await storedAnnotations(page, layerId)).features[0]!;
		const at = label.geometry!.coordinates as [number, number];
		expect(label.geometry?.type).toBe('Point');
		expect(label.properties).toMatchObject({ 'marker-symbol': 'label', title: 'Zuiderzee' });
		expect(await annotationWrites(page)).toHaveLength(1);

		await waitForPaintedAnnotations(page, [label.id]);
		expect(await annotationsAt(page, at)).toContainEqual({
			id: label.id,
			layer: `ballastella-layer-${layerId}-label`,
			title: 'Zuiderzee'
		});
		expect(await annotationsAt(page, at)).not.toContainEqual(
			expect.objectContaining({ layer: `ballastella-layer-${layerId}-point` })
		);
		expect(label.properties).toMatchObject({ 'marker-color': '#000000', fill: '#ffffff' });

		await openFace(page, 'style');
		for (const control of [
			'annotation-stroke',
			'annotation-stroke-width',
			'annotation-stroke-opacity',
			'annotation-line-style-dashed'
		]) {
			expect(await page.getByTestId(control).count()).toBe(0);
		}
		await page.getByTestId('annotation-marker-color').locator('input:checked').focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-color-grey')).toHaveAttribute(
			'data-chosen',
			'true'
		);

		await page.getByTestId('annotation-fill').locator('input:checked').focus();
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByTestId('annotation-fill-grey')).toHaveAttribute('data-chosen', 'true');

		await page.getByTestId('annotation-marker-size-medium').locator('input').focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-size-large').locator('input')).toBeChecked();

		const background = await chooseColour(page, 'annotation-fill', 'blue');
		await saved(page);

		const opacitySlider = page.getByTestId('annotation-fill-opacity');
		const opacityBeforeKeyboard = Number(await opacitySlider.inputValue());
		await opacitySlider.focus();
		await page.keyboard.press('ArrowLeft');
		const opacityAfterKeyboard = Number(await opacitySlider.inputValue());
		expect(
			opacityAfterKeyboard,
			'the Label background opacity slider ignored the keyboard'
		).toBeLessThan(opacityBeforeKeyboard);
		await expect
			.poll(async () =>
				Number((await storedAnnotations(page, layerId)).features[0]!.properties['fill-opacity'])
			)
			.toBe(opacityAfterKeyboard);

		await watchAnnotationWrites(page);
		const opacityBox = (await opacitySlider.boundingBox())!;
		const sliderY = opacityBox.y + opacityBox.height / 2;
		await page.mouse.move(opacityBox.x + opacityBox.width * 0.6, sliderY);
		await page.mouse.down();
		await page.mouse.move(opacityBox.x + opacityBox.width * 0.25, sliderY, { steps: 10 });
		await page.mouse.up();
		await saved(page);

		const opacity = Number(await opacitySlider.inputValue());
		expect(opacity, 'dragging the Label background opacity slider did not change it').toBeLessThan(
			0.6
		);
		expect(await annotationWrites(page)).toHaveLength(1);
		const style = {
			'marker-color': ANNOTATION_COLOR.grey,
			fill: background,
			'fill-opacity': opacity,
			'marker-size': 'large'
		};
		const restyled = (await storedAnnotations(page, layerId)).features[0]!;
		expect(restyled.properties).toMatchObject(style);
		await expect.poll(() => renderedStyles(page)).toMatchObject({ [restyled.id]: style });

		await chooseTool(page, 'text');
		await clickAt(baseMap(page), 0.62, 0.58);
		await saved(page);
		const secondLabel = (await storedAnnotations(page, layerId)).features[1]!;
		expect(secondLabel.properties).toMatchObject({ 'marker-symbol': 'label', ...style });

		await chooseTool(page, 'point');
		await clickAt(baseMap(page), 0.72, 0.68);
		await saved(page);

		const pin = (await storedAnnotations(page, layerId)).features[2]!;
		expect(pin.properties).not.toHaveProperty('marker-symbol');
		expect(pin.properties['marker-color']).toBe(secondLabel.properties['marker-color']);
		expect(pin.properties['fill']).toBe(secondLabel.properties['fill']);

		await waitForPaintedAnnotations(page, [pin.id]);
		await onlyPinAt(page, pin.geometry!.coordinates as [number, number], layerId, pin.id);
	});
});

test.describe('style is on each Annotation (ADR-0009, as amended)', () => {
	test('a defaultStyle from an earlier build is carried, not resolved and not deleted', async ({
		page
	}) => {
		const layerId = await seedAnnotationProject(page);
		await writeAnnotations(page, layerId, [
			line('plain', [4.8, 52.3], [5.0, 52.3], {}),
			line('own', [4.8, 52.35], [5.0, 52.35], { stroke: '#ff0000' })
		]);
		const project = await projectJson(page);
		project.layers[0].defaultStyle = { stroke: '#112233', 'stroke-width': 5 };
		await writeProjectFile(page, 'project.json', JSON.stringify(project, null, '\t'));
		await reopenLayers(page);

		const styles = await renderedStyles(page);
		expect(styles['plain']?.['stroke']).not.toBe('#112233');
		expect(styles['plain']?.['stroke-width']).not.toBe(5);
		expect(styles['own']?.['stroke']).toBe('#ff0000');

		await drawPin(page, 0.5, 0.5);
		const after = (await projectJson(page)).layers.find(
			(one: { id: string }) => one.id === layerId
		);
		expect(after.defaultStyle).toEqual({ stroke: '#112233', 'stroke-width': 5 });
	});

	test('a newly drawn Annotation is drawn with the last one’s style', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.3, 0.35],
			[0.7, 0.4]
		]);
		await selectAnnotation(page);
		const stroke = await chooseColour(page, 'annotation-stroke', 'green');
		await chooseLineStyle(page, 'dashed');
		await saved(page);

		await drawShape(page, 'line', [
			[0.3, 0.6],
			[0.7, 0.65]
		]);

		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		expect(stored.features[1]!.properties).toEqual({
			'marker-color': ANNOTATION_COLOR.grey,
			stroke,
			fill: ANNOTATION_COLOR.grey,
			'stroke-dasharray': [8, 4]
		});
		for (const name of Object.keys(stored.features[1]!.properties)) {
			expect(SIMPLESTYLE_NAMES).toContain(name);
		}

		const painted = await waitForPaintedAnnotations(
			page,
			stored.features.map((feature) => feature.id)
		);
		for (const feature of stored.features) {
			expect(painted[feature.id]).toContain(`ballastella-layer-${layerId}-line-dashed`);
		}
	});
});

test.describe('deleting an Annotation', () => {
	const focused = (page: Page): Promise<string> =>
		page.evaluate(() => {
			const at = document.activeElement;
			if (at === null || at === document.body) return 'BODY';
			return at.getAttribute('data-testid') ?? at.tagName;
		});

	test('removes it from the file and leaves the others', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawPin(page, 0.5, 0.3);
		await drawPin(page, 0.7, 0.3);
		await chooseTool(page, 'select');
		const rows = page.getByTestId('annotation-row');
		await expect(rows).toHaveCount(3);

		await selectAnnotation(page, 1);
		await page.getByTestId('annotation-inspector-close').click();
		await expect(inspector(page)).toHaveCount(0);
		await expect.poll(() => focused(page)).toBe('annotation-row');
		await expect(rows).toHaveCount(3);

		const before = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);

		const after = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		expect(after).toEqual([before[0], before[2]]);
		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).not.toContain(before[1]!);
		await expect(rows).toHaveCount(2);
		await expect(inspector(page)).toHaveCount(0);
		await expect.poll(() => focused(page)).toBe('annotation-row');

		await selectAnnotation(page, 0);
		await deleteAnnotation(page);
		await selectAnnotation(page, 0);
		await deleteAnnotation(page);
		await expect(rows).toHaveCount(0);
		await expect.poll(() => focused(page)).toBe('annotation-new');
	});
});

test.describe('the keyboard alone', () => {
	test('every drawing tool and style control is reachable and operable, and the tool is announced', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		const status = page.getByTestId('annotation-status');

		await expect(status).toHaveText('');

		await tabTo(page, page.getByTestId('annotation-new'), 'the New Annotation button');
		await page.keyboard.press('Enter');

		for (const [tool, spoken] of [
			['point', 'Pin tool.'],
			['line', 'Line tool.'],
			['polygon', 'Shape tool.'],
			['circle', 'Circle tool.']
		] as const) {
			const button = page.getByTestId(`annotation-tool-${tool}`);
			await tabTo(page, button, `the ${tool} tool`);
			await page.keyboard.press('Enter');
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			await expect(status).toContainText(spoken);
		}

		await tabTo(page, page.getByTestId('annotation-cancel'), 'the Cancel button');
		await page.keyboard.press('Enter');
		await expect(status).toHaveText('');
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		await page.getByTestId('annotation-new').click();

		await expect(page.getByTestId('annotation-tools')).toHaveAttribute('role', 'toolbar');
		await expect(page.getByTestId('annotation-tools')).toHaveAttribute(
			'aria-label',
			'Annotation tools'
		);

		const canvas = page.locator('canvas.maplibregl-canvas');
		await tabTo(page, page.getByTestId('annotation-tool-point'), 'the pin tool');
		await page.keyboard.press('Enter');
		await canvas.focus();
		await page.keyboard.press('Enter');
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		await tabTo(page, page.getByTestId('annotation-new'), 'the New Annotation button');
		await page.keyboard.press('Enter');

		await tabTo(page, page.getByTestId('annotation-tool-line'), 'the line tool');
		await page.keyboard.press('Enter');
		await canvas.focus();
		for (const key of ['Enter', 'ArrowRight', 'ArrowRight', 'Enter', 'Shift+Enter']) {
			await page.keyboard.press(key);
		}
		await saved(page);
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		expect(stored.features[1]?.geometry?.type).toBe('LineString');

		await chooseTool(page, 'select');
		await page.getByTestId('annotation-row').nth(1).click();
		await expect(inspector(page)).toHaveCount(0);
		await selectAnnotation(page, 1);
		await tabTo(page, page.getByTestId('annotation-edit-text'), 'the Edit text button');
		await page.keyboard.press('Enter');
		for (const control of ['annotation-title', 'annotation-description']) {
			await tabTo(page, page.getByTestId(control), control);
		}
		await page.getByTestId('annotation-text-done').click();

		await tabTo(page, page.getByTestId('annotation-delete'), 'annotation-delete');

		await tabTo(
			page,
			page.getByTestId('annotation-inspector-tab-text').locator('input'),
			'the Text tab'
		);
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-inspector-face')).toHaveAttribute(
			'data-face',
			'style'
		);

		await tabTo(
			page,
			page.getByTestId('annotation-stroke').locator('input:checked'),
			'the chosen line colour'
		);
		await tabTo(
			page,
			page.getByTestId('annotation-line-style-solid').locator('input'),
			'the line style choice'
		);
		for (const control of ['annotation-stroke-width', 'annotation-stroke-opacity']) {
			await tabTo(page, page.getByTestId(control), control);
		}
	});
});

test.describe('drawing into the Layer that is open', () => {
	test('a Project with no Annotation Layer says so, beside the button that fixes it', async ({
		page
	}) => {
		await page.goto('/');
		await emptyWorkspace(page);
		await page.reload();
		await createProject(page);
		await expect(page.getByRole('link', { name: PROJECT_NAME })).toBeVisible();
		await openLayers(page);

		const guidance = page.getByTestId('no-annotation-layers');
		await expect(guidance).toBeVisible();
		await expect(guidance).toContainText('No Annotation Layers yet');
		await expect(guidance).toContainText('open it to draw');
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);

		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await expect(guidance).toHaveCount(0);
	});

	test('the tools and the Annotations are inside the Layer, and with no Layer open a click writes nothing', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		const row = layerRow(page, layerId);

		await expect(page.getByTestId('annotation-new')).toHaveCount(1);
		await expect(row.getByTestId('annotation-new')).toHaveCount(1);
		await page.getByTestId('annotation-new').click();
		await expect(row.getByTestId('annotation-tools')).toHaveCount(1);

		await drawPin(page, 0.4, 0.45);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
		await expect(row.getByTestId('annotation-row')).toHaveCount(1);
		await chooseTool(page, 'point');
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-tool', 'point');

		await watchAnnotationWrites(page);
		await row.getByTestId('layer-disclosure').click();
		for (const gone of [
			'annotation-tools',
			'annotation-new',
			'annotation-list',
			'annotation-layer-choice',
			'layer-contents'
		]) {
			await expect(page.getByTestId(gone)).toHaveCount(0);
		}

		const drawn = (await storedAnnotations(page, layerId)).features[0]!.id;
		const painted = await waitForPaintedAnnotations(page, [drawn]);
		expect(painted[drawn]?.length ?? 0).toBeGreaterThan(0);

		await clickAt(baseMap(page), 0.6, 0.6);
		await page.waitForTimeout(1500);
		expect(await annotationWrites(page), 'a click with no Layer open wrote an Annotation').toEqual(
			[]
		);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		await openLayerRow(page, row);
		await chooseTool(page, 'point');
		await clickAt(baseMap(page), 0.6, 0.6);
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(2);
	});

	test('opening a different Layer abandons a part-drawn shape, and clicking an Annotation on the Base Map opens its Layer again', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const routes = await startAnnotating(page);
		const status = page.getByTestId('annotation-status');
		const disclosure = (layerId: string) => layerRow(page, layerId).getByTestId('layer-disclosure');

		await drawPin(page, 0.35, 0.4);
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Fort Amsterdam');
		await page.getByTestId('annotation-title').blur();
		await saved(page);
		const pinId = (await storedAnnotations(page, routes)).features[0]!.id;
		await expect(inspector(page)).toBeVisible();

		const places = await addAnnotationLayer(page, routes);

		await watchAnnotationWrites(page);
		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.45, 0.45);
		await clickAt(baseMap(page), 0.6, 0.45);
		await expect(status).toHaveAttribute('data-drawing', 'true');

		await openLayerRow(page, layerRow(page, places));

		await expect(status).toHaveAttribute('data-drawing', 'false');
		await expect(status).toHaveAttribute('data-tool', 'select');
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		await expect(inspector(page)).toHaveCount(0);
		await expect(page.getByTestId('annotation-list-empty')).toBeVisible();
		await expect(disclosure(routes)).toHaveAttribute('aria-expanded', 'false');

		expect(await annotationWrites(page)).toEqual([]);
		expect((await storedAnnotations(page, routes)).features).toHaveLength(1);
		expect((await storedAnnotations(page, places)).features).toHaveLength(0);

		await waitForPaintedAnnotations(page, [pinId]);
		await chooseTool(page, 'select');
		await clickAt(baseMap(page), 0.35, 0.4);

		await expect(disclosure(routes)).toHaveAttribute('aria-expanded', 'true');
		await expect(disclosure(places)).toHaveAttribute('aria-expanded', 'false');
		await expect(inspector(page)).toBeVisible();
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('Fort Amsterdam');
		await expect(layerRow(page, routes).getByTestId('annotation-row').first()).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
	});
});

test.describe('placing a Pin at a Place', () => {
	const HAMPDEN = { lng: -72.5886727, lat: 42.1018764 };
	const HAMPDEN_BOX = { west: -72.6221576, south: 42.0637364, east: -72.471087, north: 42.1622195 };
	const HAMPDEN_NAME = 'Hampden County';
	const pinSearch = (page: Page): Locator => page.getByTestId('annotation-place-search');

	async function search(page: Page, query: string, candidate: string): Promise<void> {
		const surface = pinSearch(page);
		await surface.getByTestId('place-search-query').fill(query);
		await surface.getByTestId('place-search-query').press('Enter');
		await surface.getByTestId('place-candidate').filter({ hasText: candidate }).click();
	}

	async function placeFrom(page: Page, query: string, candidate: string, layerId: string) {
		await search(page, query, candidate);
		await expect.poll(() => layerText(page, layerId)).toContain(`"title": "${query}"`);
	}

	async function layerText(page: Page, layerId: string): Promise<string> {
		try {
			return await readProjectFile(page, `annotations/${layerId}.geojson`);
		} catch {
			return '';
		}
	}

	test('from the shared search surface, one write drops a Pin titled as typed at the candidate’s point, frames it, and selects it', async ({
		page
	}) => {
		await routePlaceLookup(page);
		const layerId = await startAnnotating(page);
		expect((await mapCentre(page)).lng).toBeCloseTo(4.9, 1);
		const surface = pinSearch(page);

		await expect(surface.getByRole('button', { name: 'Find a place and pin it' })).toBeVisible();
		await expect(surface.getByTestId('place-attribution')).toHaveCount(0);
		await watchAnnotationWrites(page);

		await surface.getByTestId('place-search-query').fill(AMBIGUOUS_QUERY);
		await surface.getByTestId('place-search-query').press('Enter');
		await expect(surface.getByTestId('place-candidate')).toHaveCount(10);
		await expect(surface.getByTestId('place-search-status')).toContainText('10 places match');
		await expect(surface.getByTestId('place-attribution')).toContainText('OpenStreetMap');

		await surface.getByTestId('place-candidate').filter({ hasText: HAMPDEN_NAME }).click();
		await expect.poll(() => layerText(page, layerId)).toContain(`"title": "${AMBIGUOUS_QUERY}"`);
		const written = await layerText(page, layerId);
		const writes = await annotationWrites(page);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.bytes).toBe(new TextEncoder().encode(written).length);

		await expect(surface.getByTestId('place-candidate')).toHaveCount(0);
		await expect(surface.getByTestId('place-attribution')).toHaveCount(0);
		await expect(surface.getByTestId('place-search-status')).toHaveText('');
		const paneSearch = page.getByTestId('base-map-place-search');
		await expect(paneSearch.getByTestId('place-search-query')).toBeVisible();
		await expect(
			paneSearch.getByRole('button', { name: 'Find a place', exact: true })
		).toBeVisible();

		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(1);
		expect(stored.features[0]?.geometry?.type).toBe('Point');
		expect(stored.features[0]?.geometry?.coordinates).toEqual([HAMPDEN.lng, HAMPDEN.lat]);
		expect(stored.features[0]?.properties['title']).toBe(AMBIGUOUS_QUERY);
		expect(written).not.toContain(HAMPDEN_NAME);
		expect(
			Object.keys(stored.features[0]?.properties ?? {}).filter((key) => !SIMPLESTYLE_NAMES.has(key))
		).toEqual([]);
		expect(written).not.toMatch(/boundingbox|bbox|place_id|osm_|licence|nominatim/i);

		await expect
			.poll(async () => (await mapCentre(page)).lat, { timeout: 15_000 })
			.toBeCloseTo(HAMPDEN.lat, 1);
		expect((await mapCentre(page)).lng).toBeCloseTo(HAMPDEN.lng, 1);

		await expect.poll(() => mapIsMoving(page)).toBe(false);
		const pane = (await baseMap(page).boundingBox())!;
		const corners = await page.evaluate((box) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			return {
				southWest: map.project([box.west, box.south]),
				northEast: map.project([box.east, box.north])
			};
		}, HAMPDEN_BOX);
		for (const corner of [corners.southWest, corners.northEast]) {
			expect(corner.x).toBeGreaterThan(0);
			expect(corner.x).toBeLessThan(pane.width);
			expect(corner.y).toBeGreaterThan(0);
			expect(corner.y).toBeLessThan(pane.height);
		}
		const across = Math.abs(corners.northEast.x - corners.southWest.x) / pane.width;
		const down = Math.abs(corners.northEast.y - corners.southWest.y) / pane.height;
		expect(Math.max(across, down)).toBeGreaterThan(0.5);

		await expect(inspector(page)).toBeVisible();
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(vertexHandles(page)).toHaveCount(1);

		await saved(page);
		await page.waitForTimeout(1_000);
		expect(await annotationWrites(page)).toHaveLength(1);
	});

	test('produces a Pin byte-identical to one drawn by hand and given the same title', async ({
		page
	}) => {
		const service = await routePlaceLookup(page);
		const drawnLayer = await withOnePin(page, 0.45, 0.45);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill(AMBIGUOUS_QUERY);
		await page.getByTestId('annotation-title').blur();
		await saved(page);

		const drawn = await storedAnnotations(page, drawnLayer);
		const at = drawn.features[0]?.geometry?.coordinates as [number, number];
		expect(at).toHaveLength(2);

		service.answerWith(await candidateAt({ lng: at[0], lat: at[1] }));

		const placedLayer = await addAnnotationLayer(page, drawnLayer);
		await openLayerRow(page, layerRow(page, placedLayer));

		await placeFrom(page, AMBIGUOUS_QUERY, 'Springfield', placedLayer);

		const drawnText = await readProjectFile(page, `annotations/${drawnLayer}.geojson`);
		const placedText = await readProjectFile(page, `annotations/${placedLayer}.geojson`);

		const idOf = (text: string) =>
			(JSON.parse(text) as { features: { id: string }[] }).features[0]!.id;
		expect(placedText.split(idOf(placedText)).join('<id>')).toBe(
			drawnText.split(idOf(drawnText)).join('<id>')
		);
		expect(placedText).toContain(`"title": "${AMBIGUOUS_QUERY}"`);
		expect(placedText).toContain('"Point"');
	});

	test('takes the style the last Annotation was drawn with, as a drawn one would', async ({
		page
	}) => {
		await routePlaceLookup(page);
		const layerId = await withOnePin(page);
		const blue = await chooseColour(page, 'annotation-marker-color', 'blue');
		await saved(page);

		await placeFrom(page, AMBIGUOUS_QUERY, HAMPDEN_NAME, layerId);

		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		expect(stored.features[1]?.properties?.['marker-color']).toBe(blue);
	});
});

test.describe('a Label author journey uses only the keyboard', () => {
	test('reaches Label, places it, writes and styles it, then deletes it without a pointer', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		const face = page.getByTestId('annotation-inspector-face');

		await tabTo(page, page.getByTestId('annotation-new'), 'New Annotation', false);
		await page.keyboard.press('Enter');
		await tabTo(page, page.getByTestId('annotation-tool-text'), 'Label', false);
		await page.keyboard.press('Enter');

		await tabTo(page, page.locator('canvas.maplibregl-canvas'), 'the Base Map', false);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('annotation-title')).toBeFocused();
		await page.keyboard.type('Zuiderzee');
		await saved(page);

		const tabTab = page.getByTestId('annotation-inspector-tab-text').locator('input');
		await tabTo(page, tabTab, 'the Text tab', false);
		await page.keyboard.press('ArrowRight');
		await expect(face).toHaveAttribute('data-face', 'style');

		const textColour = page.getByTestId('annotation-marker-color').locator('input:checked');
		await tabTo(page, textColour, 'the Label text colour', false);
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-color-grey')).toHaveAttribute(
			'data-chosen',
			'true'
		);

		const size = page.getByTestId('annotation-marker-size-medium').locator('input');
		await tabTo(page, size, 'the Label size', false);
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-size-large').locator('input')).toBeChecked();
		await expect
			.poll(async () => (await storedAnnotations(page, layerId)).features[0]?.properties)
			.toMatchObject({
				title: 'Zuiderzee',
				'marker-symbol': 'label',
				'marker-color': ANNOTATION_COLOR.grey,
				'marker-size': 'large'
			});

		const styleTab = page.getByTestId('annotation-inspector-tab-style').locator('input:checked');
		await tabTo(page, styleTab, 'the Style tab', false);
		await page.keyboard.press('ArrowLeft');
		await expect(face).toHaveAttribute('data-face', 'text');
		await tabTo(page, page.getByTestId('annotation-delete'), 'Delete Annotation', false);
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await storedAnnotations(page, layerId)).features.length).toBe(0);
		await expect(page.getByTestId('annotation-row')).toHaveCount(0);
		await expect
			.poll(() =>
				page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? 'BODY')
			)
			.toBe('annotation-new');
	});
});

test.describe('reordering an Annotation, and moving one between Layers', () => {
	test('drags a row onto another row, and onto another Layer’s card', async ({ page }) => {
		const first = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawPin(page, 0.5, 0.3);
		await drawPin(page, 0.7, 0.3);
		await chooseTool(page, 'select');
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);

		const ids = (await storedAnnotations(page, first)).features.map((one) => one.id);
		const idsIn = async (layerId: string) =>
			(await storedAnnotations(page, layerId)).features.map((one) => one.id);
		const rows = page.getByTestId('annotation-row-item');
		await rows.nth(2).getByTestId('annotation-drag-handle').dragTo(rows.nth(0));

		await saved(page);
		expect(await idsIn(first)).toEqual([ids[2], ids[0], ids[1]]);
		await expect(page.getByTestId('annotation-row-ordinal')).toHaveText(['1', '2', '3']);

		const second = await addAnnotationLayer(page, first);
		await rows.nth(0).getByTestId('annotation-drag-handle').dragTo(layerRow(page, second));

		await saved(page);
		await expect.poll(() => idsIn(second)).toEqual([ids[2]]);
		expect(await idsIn(first)).toEqual([ids[0], ids[1]]);

		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('annotation-moved')).toContainText('moved to');
	});
});
