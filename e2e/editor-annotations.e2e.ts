// Seam 2 for Annotations: drawing, editing, styling, and rendering Markdown in the running app.
//
// Two things about the shape of this file.
//
// **Every claim about styling is asserted on what MapLibre reports it drew**, never on the app's own
// state. `queryRenderedFeatures` names the layer that painted each Annotation, and
// `getPaintProperty` is the dash pattern that layer actually carries — which is the mechanism by which
// a dashed line looks different from a solid one. A whole slice's worth of distortion assertions was
// once lost to exactly this: the values were computed in a different object from the one that painted,
// so every assertion passed while the renderer threw once per frame. Hence also the `pageerror` watch
// on every test that renders.
//
// **The untrusted-text claim is asserted here only where a browser can falsify it.** The payload
// matrix — what survives `marked` and DOMPurify, in that order — lives in
// `packages/core/src/annotation/markdown.browser.test.ts`, over a real DOM and without an
// application. What stays here is one test on the Annotation's row, which is where an Annotation is
// read and the only place the *wiring* can fail: a perfect sanitiser and a surface that never calls
// it look identical one seam down.

import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openLayerRow } from './support/layers.js';
import { leaderIsDrawn, leaderLayer, leaderPoints } from './support/leader.js';
import { countFileReads, countFileWrites, fileReads, fileWrites } from './support/store-traffic.js';
import { AMBIGUOUS_QUERY, candidateAt, routePlaceLookup } from './support/places.js';
// The one test that needs a warped sheet over the Base Map borrows the alignment suite's ground
// rather than growing a second PNG encoder — see the header of `support/alignment-workspace.ts`.

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

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
	drawShape,
	editAnnotationText,
	emptyWorkspace,
	hashesUnder,
	inspector,
	openFace,
	openLayers,
	PROJECT_DIRECTORY,
	PROJECT_NAME,
	readProjectFile,
	reopenLayers,
	selectAnnotation,
	paintProperty,
	projectJson,
	seedAnnotationProject,
	waitForPaintedAnnotations,
	startAnnotating,
	storedAnnotations,
	watchAnnotationWrites,
	writeProjectFile,
	type StackWindow
} from './support/annotations';

/**
 * Anything the page threw, and any native dialog it opened.
 *
 * Installed on every test that renders. An `rgb()`-into-a-hex-parser bug threw once per frame inside
 * the draw path and was caught only by an unrelated test's `pageerror` watch, while every assertion
 * about the values passed. It doubles as an XSS probe: `alert(1)` in a payload is a dialog.
 */
function watchFailures(page: Page): string[] {
	const failures: string[] = [];
	page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
	page.on('dialog', (dialog) => {
		failures.push(`dialog: ${dialog.message()}`);
		void dialog.dismiss();
	});
	return failures;
}

/**
 * How far short of an Annotation's own coordinate the leader stops, in page pixels.
 *
 * A line and a shape are a *point* on the screen — there is no mark around them to clear — so the
 * only shortening is the leader's own two-pixel clearance (`leader-line.ts`). A Pin would be its
 * pin's half-height instead, and the Annotation this is asserted against is a shape. Written out
 * here rather than imported, for the reason `SIMPLESTYLE_NAMES` gives: the Playwright project
 * resolves nothing from `@ballastella/core`, and a number copied from the design is a better witness
 * than one imported from the code under test.
 */
const MARK_CLEARANCE = 2;

/**
 * How long the camera's move out from under the Inspector takes, in milliseconds.
 *
 * `RESERVATION_EASE_MS` in `apps/editor/src/lib/base-map/BaseMapPane.svelte`, written out again for the
 * reason {@link MARK_CLEARANCE} gives: this Playwright project resolves nothing from the applications.
 * Named on both sides so that the two copies can be found from each other, rather than a `500` in a
 * `waitForTimeout` that nobody can trace back to a duration.
 */
const RESERVATION_EASE_MS = 300;

/**
 * The style property names simplestyle 1.1.0 defines, plus ADR-0009's one extension.
 *
 * The same eleven names as `SIMPLESTYLE_PROPERTIES` in `@ballastella/core`, written out again because
 * the Playwright project cannot import them: it is the workspace root, which declares no dependency on
 * `@ballastella/core` and resolves nothing from it. Re-declaring is the lesser evil — the point of the
 * assertion is that the app writes *the spec's* names, and a list copied from the spec is a better
 * witness to that than one imported from the code under test.
 */
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

test.describe('drawing', () => {
	test('a pin, a line, and a shape are drawn and land in the Annotation Layer’s own file, with the polygon’s ring closed (RFC 7946 §3.1.6)', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);

		await drawPin(page, 0.3, 0.3);
		await drawShape(page, 'line', [
			[0.4, 0.4],
			[0.6, 0.45]
		]);
		await drawShape(page, 'polygon', [
			[0.5, 0.6],
			[0.7, 0.6],
			[0.6, 0.8]
		]);

		const stored = await storedAnnotations(page, layerId);

		expect(stored.type).toBe('FeatureCollection');
		expect(stored.features.map((feature) => feature.geometry?.type)) //
			.toEqual(['Point', 'LineString', 'Polygon']);
		// And they are in *this* Layer's file, which is the criterion — not in some other Layer's.
		expect((await projectJson(page)).layers[0].geojsonRef).toBe(`annotations/${layerId}.geojson`);

		// ── AND THE POLYGON'S RING IS CLOSED, WHICH IS WHAT OTHER TOOLS REQUIRE ──────────────
		//
		// RFC 7946 §3.1.6: a Polygon's ring is a LinearRing and its first and last positions must be
		// identical. An open ring is drawn happily by geojson.io and refused by PostGIS and shapely, so
		// it would break exactly the portability claim ADR-0009 is for. The user never places the closing
		// vertex, so nothing but the writer can.
		//
		// Asserted here rather than in a test of its own: this test already draws the polygon and reads
		// the collection it landed in, so the claim needed nothing but two more assertions on bytes
		// already in hand. What the ring does after a *reshape* is a different writer and stays its own
		// test — "a polygon reshaped by a vertex stays a closed ring", below.
		const ring = stored.features[2]?.geometry?.coordinates as number[][][];
		expect(ring[0]).toHaveLength(4);
		expect(ring[0]?.at(0)).toEqual(ring[0]?.at(-1));

		expect(failures).toEqual([]);
	});

	test('all three appear on the map, each painted by the layer for its geometry', async ({
		page
	}) => {
		const failures = watchFailures(page);
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

		// ─────────────────────────────────────────────────────────────────────────────────────
		// AND EACH IS NUMBERED IN THE SIDEBAR
		//
		// Folded in here rather than given a test of its own because this is already the suite's one
		// Project holding a pin, a line and a shape at once — and because the Seam 2 budget is spent
		// (`scripts/check-seam-2-size.mjs`). The *rule* is asserted where it is cheap:
		// `packages/core/src/annotation/ordinal.test.ts` for what the numbers are and that they reach
		// no file, `packages/ui/src/annotation-list.dom.test.ts` for the row. The number is the list's
		// own counting and is drawn nowhere on the map: a numbered disc floating over the geography
		// read as a second kind of pin, in a place the scholar had not put one.
		//
		// **Read with nothing put away first.** The list is on screen throughout a drawing run, so all
		// three rows are in it the moment the third shape lands, each numbered from its place in the
		// collection rather than from its place in the list.
		expect(await page.getByTestId('annotation-row-ordinal').allTextContents()).toEqual([
			'1',
			'2',
			'3'
		]);

		// ── WHERE A SHAPE IS POINTED AT ─────────────────────────────────────────────────────
		//
		// A line's and a shape's leader ends at the middle of the geometry's extent —
		// `annotationAnchor`'s answer, which is also where the Annotation's popup used to point —
		// rather than at the first vertex, which puts the end at the end of a coastline or in a corner
		// of a parish. The coordinate is asserted in
		// `packages/core/src/render/annotation-mark.test.ts`; what needs a real map is that the line is
		// *drawn* there, and drawn there again after the map has been zoomed and panned underneath it.
		const ring = stored.features[2]!.geometry!.coordinates as number[][][];
		const extent = (axis: 0 | 1) =>
			(Math.min(...ring[0]!.map((at) => at[axis]!)) +
				Math.max(...ring[0]!.map((at) => at[axis]!))) /
			2;
		const middle: [number, number] = [extent(0), extent(1)];
		const firstVertex = ring[0]![0] as [number, number];

		/** Where a place on the earth lands, in page pixels. */
		const projected = async (lngLat: [number, number]) => {
			const pane = (await baseMap(page).boundingBox())!;
			const at = await page.evaluate(
				(coordinate) =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.project(
						coordinate as [number, number]
					),
				lngLat
			);
			return { x: pane.x + at.x, y: pane.y + at.y };
		};

		// Zoomed in and moved off centre, which is the gesture "stable as the map pans and zooms" is
		// about. A line drawn to anything but the coordinate comes apart here and nowhere else.
		await page.evaluate(async (at) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			map.setZoom(11);
			map.setCenter([at[0] + 0.02, at[1] - 0.01]);
			await Promise.race([
				new Promise<void>((resolve) => map.once('idle', () => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 3000))
			]);
		}, middle);

		// ── AND THE LEADER JOINS THE SHAPE TO ITS ROW ────────────────────────────────────────
		//
		// Folded in here rather than given a test of its own, for the reason the ordinals above were:
		// this is already the suite's one Project holding a pin, a line and a shape at once, already
		// zoomed and panned off centre, and already carrying the projection helpers the claim needs.
		// The Seam 2 budget (`scripts/check-seam-2-size.mjs`) is spent.
		//
		// ⚠ **The canvas end is asserted against `map.project()` of the shape's coordinates as stored
		// on disk**, never against the leader's own box or the mark's. That is the defect shape this
		// repository has already been bitten by — a handle drawn 334 px from the geography it named,
		// missed by a whole browser suite because every assertion started from wherever the element
		// was. The mutation check for this criterion is to offset `projected` by a constant and watch
		// these two assertions go red.
		// Drawing a shape leaves it selected, so this is idempotent: the helper opens the row only if
		// it is not already open.
		await selectAnnotation(page, 2);
		const shapeRow = page.getByTestId('annotation-row').nth(2);

		/**
		 * Where the leader ought to end, given a place on the earth.
		 *
		 * The line stops at the edge of the mark rather than under it, so the end is the mark's own
		 * clearance short of the coordinate — *along the line*, which is why the stub is read off the
		 * drawn line and the coordinate is not. The stub sets the direction; the projection sets the
		 * place.
		 */
		const endFor = (target: { x: number; y: number }, stub: { x: number; y: number }) => {
			const run = Math.hypot(target.x - stub.x, target.y - stub.y);
			return {
				x: target.x - ((target.x - stub.x) * MARK_CLEARANCE) / run,
				y: target.y - ((target.y - stub.y) * MARK_CLEARANCE) / run
			};
		};

		const drawn = await leaderPoints(page);
		expect(drawn, 'no leader was drawn for the selected Annotation').not.toBeNull();
		// One polyline, three points: the row's near edge, a stub out of the column, and the mark.
		expect(drawn).toHaveLength(3);
		const [atRow, stub, atMark] = drawn as { x: number; y: number }[];

		const wanted = endFor(await projected(middle), stub as { x: number; y: number });
		expect(
			Math.hypot((atMark as { x: number }).x - wanted.x, (atMark as { y: number }).y - wanted.y),
			'the leader’s canvas end is not where map.project() puts the coordinate on disk'
		).toBeLessThan(2);

		// The negative control the criterion is written against, exactly as the mark's own has one: the
		// first vertex of this triangle is a long way from its middle, and a leader drawn to it would
		// pass any assertion that only asked "is there a line".
		const wrongEnd = endFor(await projected(firstVertex), stub as { x: number; y: number });
		expect(
			Math.hypot((atMark as { x: number }).x - wrongEnd.x, (atMark as { y: number }).y - wrongEnd.y)
		).toBeGreaterThan(20);

		// The sidebar end is on the row's own edge, which is the one end that has no truth on disk to
		// be checked against — a row is a DOM element and nothing else.
		const rowBox = (await shapeRow.boundingBox())!;
		expect((atRow as { x: number }).x).toBeCloseTo(rowBox.x + rowBox.width, 0);
		expect((atRow as { y: number }).y).toBeCloseTo(rowBox.y + rowBox.height / 2, 0);

		// ── IT CARRIES NOTHING, AND CANNOT BE REACHED ───────────────────────────────────────
		//
		// `aria-expanded` on the row is what says which Annotation is active, so this layer must add
		// nothing to either the accessibility tree or the tab order.
		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');
		expect(
			await leaderLayer(page).evaluate(
				(svg) => svg.querySelectorAll('a, button, input, [tabindex]').length
			)
		).toBe(0);
		expect(await leaderLayer(page).evaluate((svg) => getComputedStyle(svg).pointerEvents)).toBe(
			'none'
		);

		// ── AND IT IS NOT DRAWN TO SOMEWHERE THE MARK IS NOT ────────────────────────────────
		//
		// Panned until the shape's mark has left the canvas. A line to nowhere is worse than no line.
		await page.evaluate(async (at) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			map.setCenter([at[0] + 4, at[1] + 2]);
			await Promise.race([
				new Promise<void>((resolve) => map.once('idle', () => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 3000))
			]);
		}, middle);
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');

		// And back, so this is a leader that follows the map rather than one that was taken down.
		await page.evaluate(async (at) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			map.setCenter(at as [number, number]);
			await Promise.race([
				new Promise<void>((resolve) => map.once('idle', () => resolve())),
				new Promise<void>((resolve) => setTimeout(resolve, 3000))
			]);
		}, middle);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		const followed = (await leaderPoints(page)) as { x: number; y: number }[];
		const followedWanted = endFor(await projected(middle), followed[1] as { x: number; y: number });
		expect(
			Math.hypot(
				(followed[2] as { x: number }).x - followedWanted.x,
				(followed[2] as { y: number }).y - followedWanted.y
			),
			'the leader did not follow the map back'
		).toBeLessThan(2);

		// ── AND NOT TO A ROW THAT HAS LEFT ITS COLUMN ───────────────────────────────────────
		//
		// The other end's half: the column is scrolled until the selected row is outside it, which is
		// the moment the line would start pointing at a row that is not on the screen.
		//
		// ⚠ **The window is shortened to make that possible, and the shortening is not the assertion.**
		// An Annotation's content is read over the map now (ADR-0035), so this column is a stack of rows
		// and nothing else — at 720 px it does not overflow at all, and a scroll that cannot take the row
		// out of the column asserts nothing. **Both halves are measured at the same size**, so the only
		// thing that differs between "no line" and "a line" is where the row is: a shorter window also
		// shortens the canvas, and a mark that had left the pane would make the first half pass for the
		// wrong reason.
		await page.setViewportSize({ width: 1280, height: 320 });
		// ⚠ **The scroller inside the rail, not the rail.** The rail is a flex column whose last child is
		// the pinned add-Layer pair, so it is this box that scrolls and this box that clips a row out of
		// sight — which is the box `leaderPath` is given, and the one the rule below is about.
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

		// ── AND THE RULE IS THE ROW'S CENTRE, WHICH IS WHERE THE LINE STARTS ────────────────
		//
		// ⚠ **The boundary is the assertion, not the row being off the screen.** `leaderPath` puts the
		// sidebar end at the vertical *centre* of the row's near edge and draws nothing when that point
		// leaves the column — so a row half out of the column has a start point that is not on it, and a
		// line from there is drawn across the card above. Asserted only where the row has left the column
		// entirely, a rule keyed on `row.top`, on `row.bottom`, or on the boxes merely overlapping passes
		// just as well. So the row is scrolled until its centre is a few pixels past the bottom edge with
		// the rest of it still inside, which is the state that tells those apart.
		//
		// ⚠ **The row measured is the *button*, which is the box `leaderPath` is given.** The `<li>` around
		// it is a couple of pixels taller, and this margin is four.
		const straddleTheEdge = () =>
			column.evaluate((element) => {
				const rows = [...element.querySelectorAll('[data-testid="annotation-row"]')];
				const at = rows[rows.length - 1]!.getBoundingClientRect();
				const box = element.getBoundingClientRect();
				// Four pixels past the edge: far enough that no rounding puts the centre back inside, near
				// enough that the rest of the row is still in the column.
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

		// ⚠ **Read after two frames rather than polled, and that is the difference between asserting this
		// and not.** The redraw is a microtask off the scroll event, so `expect.poll` is satisfied by the one
		// frame between the scroll landing and the line being recomputed: with the rule changed to "the two
		// boxes overlap" the line came straight back afterwards and the poll had already passed. The settled
		// state is the claim.
		const afterTwoFrames = () =>
			page.evaluate(
				() =>
					new Promise<void>((resolve) =>
						requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
					)
			);

		await straddleTheEdge();
		await afterTwoFrames();
		expect(
			await straddling(),
			'the row is not half out of its column, so this asserts nothing about the centre'
		).toEqual({ centreOutside: true, overlapping: true });
		expect(await leaderIsDrawn(page)).toBe('no');

		// And the positive control at the same size, which is what makes the absence above a fact about
		// the row: scrolled to it, the same row in the same window gets its line back. Scrolled *to the
		// row* rather than to the bottom of the column — the status and guidance paragraphs render below
		// the stack inside this box, so the far end of the scroll takes the row off the top instead of
		// bringing it back.
		await column.evaluate((element) => {
			const rows = [...element.querySelectorAll('[data-testid="annotation-row-item"]')];
			rows[rows.length - 1]!.scrollIntoView({ block: 'center' });
		});
		expect(await rowOutsideColumn()).toBe(false);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		await page.setViewportSize({ width: 1280, height: 720 });
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');

		// ── AND THE MAP DRAWS THE SELECTED ANNOTATION MORE STRONGLY ──────────────────────────
		//
		// The other end's answer to "which one is this line about". **A change of weight and never of
		// colour** — `stroke` and `marker-color` are the scholar's own choices — so what is asserted is
		// the state the paint expressions read, on the feature MapLibre holds, rather than a pixel: a
		// widened outline is exactly the kind of difference a screenshot comparison reports as noise.
		//
		// Read back through the source's own feature id, which is `promoteId`'s doing: without it a
		// GeoJSON source numbers its features by position and the selected one would change identity
		// whenever the collection was reordered.
		const annotationSource = `ballastella-layer-${layerId}-source`;
		const selectedOnMap = (id: string) =>
			page.evaluate(
				(target) =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.getFeatureState(target),
				{ source: annotationSource, id }
			);
		await expect.poll(() => selectedOnMap(shape!)).toEqual({ selected: true });
		// And only that one, which is the claim a single `setFeatureState` would pass without.
		expect(await selectedOnMap(pin!)).toEqual({});

		// It follows the selection rather than being written once: the pin's row is opened, and the
		// shape gives the emphasis up.
		await selectAnnotation(page, 0);
		await expect.poll(() => selectedOnMap(pin!)).toEqual({ selected: true });
		expect(await selectedOnMap(shape!)).toEqual({});

		// ⚠ **AND THE ANNOTATION'S OWN WIDTH IS NOT WHAT CHANGED.** The emphasis is a halo behind the
		// drawing; the drawing is painted exactly as the file asks. A selection that widened the
		// outline instead would say nothing on a Layer whose Annotations have different
		// `stroke-width`s — a selected hairline stays thinner than an unselected quay wall — which is
		// why this is asserted as an *absence*: the line's own width reads the feature and nothing
		// else, with no `feature-state` anywhere in it.
		const lineWidth = await paintProperty(
			page,
			`ballastella-layer-${layerId}-line-solid`,
			'line-width'
		);
		expect(lineWidth, 'the selection changed the width the scholar chose').toEqual([
			'to-number',
			['get', 'stroke-width']
		]);
		// The halo is the layer that carries it: a fixed number of pixels wider than whatever the
		// feature asked for, so a hairline and a heavy outline get the same visible aura, and painted
		// only for the selected one.
		expect(await paintProperty(page, `ballastella-layer-${layerId}-selected`, 'line-width')) //
			.toEqual(['+', ['to-number', ['get', 'stroke-width']], 6]);
		expect(await paintProperty(page, `ballastella-layer-${layerId}-selected`, 'line-opacity')) //
			.toEqual(['case', ['boolean', ['feature-state', 'selected'], false], 0.3, 0]);
		// In the Annotation's own colour rather than an accent of ours, so nothing here is a theme
		// token copied into a paint value and left to drift.
		expect(await paintProperty(page, `ballastella-layer-${layerId}-selected`, 'line-color')) //
			.toEqual(['get', 'stroke']);

		// ── AND THE LEADER IS DRAWN UNDER THE PANEL AND UNDER THE CONTROLS ──────────────────
		//
		// The measurement `layout.css` records, repeated on the two things the line may never be drawn
		// across. `.maplibregl-map` opens no stacking context, so the leader's 5, MapLibre's control
		// corners at 6 and the Inspector's 7 are all compared in the one container they are painted in
		// — three numbers in two files, with nothing but a test to say they are still in that order.
		//
		// ⚠ **`pointer-events` has to be turned on for the probe, and that is the whole instrument.** The
		// leader takes none by design, so `elementFromPoint` answers straight past it whatever the stacking
		// order is: the same three assertions on the layer as it ships would pass with `z-index: 99`. This is
		// how the original measurement was taken, and it is why the first of the three is a *positive
		// control* over bare canvas — without it, a probe that never returns the leader at all would make
		// the other two vacuous.
		//
		// Folded in here rather than given a test of its own: this is already the suite's one test with a
		// leader drawn, an Inspector open and the pane's controls on the screen, and the Seam 2 budget
		// (`scripts/check-seam-2-size.mjs`) is spent.
		const topmostAt = (at: { x: number; y: number }) =>
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

		// Selecting the pin above brought its mark out from under the panel, which is a camera move: the
		// boxes are read once it has stopped, and with a line actually drawn to probe for.
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.isMoving()
				)
			)
			.toBe(false);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		const pane = (await baseMap(page).boundingBox())!;
		const panel = (await inspector(page).boundingBox())!;
		const zoomIn = (await page.locator('button.maplibregl-ctrl-zoom-in').boundingBox())!;

		// The control: over the canvas, where the leader is the topmost thing there is. If this stops saying
		// "the leader" the two assertions under it have stopped being about anything.
		expect(
			await topmostAt({ x: pane.x + pane.width * 0.5, y: pane.y + pane.height * 0.25 }),
			'the probe cannot see the leader at all, so it cannot see it covering anything'
		).toBe('the leader');
		expect(
			await topmostAt({ x: panel.x + panel.width / 2, y: panel.y + panel.height / 2 }),
			'the leader is drawn across the Inspector'
		).toBe('the Inspector');
		expect(
			await topmostAt({ x: zoomIn.x + zoomIn.width / 2, y: zoomIn.y + zoomIn.height / 2 }),
			'the leader is drawn across the zoom control'
		).toBe('a map control');

		expect(failures).toEqual([]);
	});

	test('Escape abandons a part-drawn shape first, and then collapses the open row', async ({
		page
	}) => {
		// **The ordering is the subject**. With no popup on this screen, Escape has two
		// jobs left and they are in a fixed order: a gesture in progress is what somebody pressing
		// Escape almost always means, and the open row is what is left when there is no gesture. An
		// Escape that collapsed the row first would throw away a shape's worth of clicks.
		const layerId = await startAnnotating(page);
		// **Two pins, and the second one is the selected one.** The first is therefore an Annotation
		// on the map carrying no drag handle of its own, which is what lets the click below land on it.
		await drawPin(page, 0.3, 0.3);
		await drawPin(page, 0.6, 0.6);
		const rows = page.getByTestId('annotation-row');
		// Both of them, in the list that no longer stands aside — and the one just drawn is the open one.
		await expect(rows).toHaveCount(2);
		const row = rows.nth(1);
		await expect(row).toHaveAttribute('aria-expanded', 'true');

		// **An Escape the row's own fields already answered is not this screen's to act on.** The
		// title input treats it as "leave this field" and the description textarea ignores it, and
		// neither stops it propagating — so a window handler that collapsed the row on it would shut
		// the panel the scholar was typing in, on a keypress that meant far less. Asserted for both
		// fields, because they answer Escape differently and only one of them answers it at all.
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').focus();
		await page.keyboard.press('Escape');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(inspector(page)).toHaveCount(1);

		await page.getByTestId('annotation-description').focus();
		await page.keyboard.press('Escape');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(inspector(page)).toHaveCount(1);

		// **And nor is the Escape that closed a dialog.** `MakeOfflineDialog` is one of the two on this
		// screen the handler holds no flag for, so it stands for the class: a `<dialog>` consumes
		// Escape and keeps it propagating, and the row behind it was never what the user was dismissing.
		await page.getByTestId('edit-project-name').click();
		await page.getByTestId('make-offline').click();
		await expect(page.locator('dialog[open]')).toHaveCount(1);
		await page.keyboard.press('Escape');
		await expect(page.locator('dialog[open]')).toHaveCount(0);
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(inspector(page)).toHaveCount(1);

		const ids = (await storedAnnotations(page, layerId)).features.map((one) => one.id as string);
		await waitForPaintedAnnotations(page, ids);
		await watchAnnotationWrites(page);

		// **With a tool armed, a click on the map is a vertex** — including this one, which lands
		// straight on the first pin. Without the guard on the page it would open that Annotation's row
		// instead of placing a point. The other half of the pair is `clicking an Annotation on the Base
		// Map opens its Layer and selects it`, which is the same click with the select tool in hand.
		//
		// Pressing "New Annotation" — which is what `chooseTool` does — collapses the row that was open,
		// because a new Annotation is not an edit to the old one. So the selection is made *again* below,
		// from the list, which is what gives this Escape two jobs to do in order.
		await chooseTool(page, 'polygon');
		await expect(inspector(page)).toHaveCount(0);
		await clickAt(baseMap(page), 0.3, 0.3);
		await expect(page.getByTestId('annotation-status')).toContainText('1 point. 2 more needed');
		// And neither click opened the Annotation under it: the pin is still there, unselected.
		await expect(inspector(page)).toHaveCount(0);
		await clickAt(baseMap(page), 0.5, 0.4);
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'true');

		const reopened = rows.nth(0);
		await reopened.click();
		await expect(reopened).toHaveAttribute('aria-expanded', 'true');
		// Opening a row is not abandoning a gesture: the two vertices are still in flight.
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'true');

		await page.keyboard.press('Escape');

		// The gesture went, and the row that was open stayed: one Escape, one job.
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'false');
		// **And the tool went with it**: an abandoned gesture is
		// over, so the next click on the map selects rather than starting the polygon again.
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-tool', 'select');
		await expect(reopened).toHaveAttribute('aria-expanded', 'true');

		// And the next Escape, with nothing left to abandon, collapses it.
		await page.keyboard.press('Escape');
		await expect(inspector(page)).toHaveCount(0);
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0)).toHaveAttribute('aria-expanded', 'false');
		await expect(rows.nth(1)).toHaveAttribute('aria-expanded', 'false');

		// Escape leaves no trace on disk, which is the whole of the first half: the abandoned polygon
		// was never written, and the two pins drawn before the watch started are all the Layer holds.
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(2);
		expect(await annotationWrites(page)).toEqual([]);
	});

	/**
	 * **The wiring of the selection, which is the half of it a browser is needed for.**
	 *
	 * That a row is a *disclosure* — pressed once it opens and selects, pressed again it collapses and
	 * clears, and a second row displaces the first rather than joining it — is
	 * `AnnotationLayerContents`' own behaviour and is
	 * asserted against the component in `annotation-layer-contents.dom.test.ts`, handed a collection
	 * and a selection by the test. What that seam cannot fail for is the reason this test's title
	 * gives: that a shape *drawn on the map* becomes the selection, which is `AnnotationDrawing` and
	 * `ProjectScreen` and the canvas, none of which the component can see.
	 *
	 * Load-bearing for the rest of this suite, which is why it is asserted rather than assumed: a
	 * helper that clicked a row unconditionally would deselect the new shape and take the editor and
	 * the vertex handles with it.
	 *
	 * **It is also where "finishing returns everything to rest" is asserted**. The tool disarming
	 * itself is `AnnotationDrawing`'s and is asserted directly in `drawing.svelte.test.ts`; what needs
	 * a browser is the whole surface answering to it at once — the resting button back, the shapes
	 * gone, the keyboard in the new Annotation's title, and the next click on the canvas selecting
	 * rather than drawing. None of those five is visible to the node seam or to the component seam.
	 */
	test('a shape drawn on the map arrives selected, at rest, with its title ready to type', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);

		// **Back to rest, with nothing put away by hand.** One press of "New Annotation" made one
		// Annotation: the resting button is showing, the shapes are not, and the tool is down.
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		const status = page.getByTestId('annotation-status');
		await expect(status).toHaveAttribute('data-tool', 'select');
		await expect(status).toHaveAttribute('data-drawing', 'false');

		// The drawn Annotation is the selected one, in the ordinary list, and **the keyboard is in its
		// title** — titling a shape straight after drawing it is one gesture.
		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(inspector(page)).toBeVisible();
		await expect(page.getByTestId('annotation-title')).toBeFocused();
		// **And the row opened nothing inside itself** (ADR-0035): the row is a selector, the
		// Annotation's content is read in the Inspector, and the list stays the same length however
		// much any one Annotation has to say. Asserted as the `<li>`'s children rather than as the
		// absence of a `data-testid`, because a renamed id is exactly how an absence assertion goes
		// quietly green — there is nothing left in the row that could carry one.
		expect(
			await page
				.getByTestId('annotation-row')
				.evaluate((row) => row.closest('li')!.children.length),
			'the selected row opened something inside itself'
		).toBe(1);

		await page.getByTestId('annotation-title').fill('The west quay');
		await page.getByTestId('annotation-text-done').click();
		await expect(inspector(page)).toContainText('The west quay');

		// ⚠ **And looking at the swatches does not hand the keyboard back to the title.** The Text face is
		// unmounted while Style is showing and mounted again on the way back, so the offer to title a shape
		// just drawn has to be *spent* when it is taken up rather than standing while the shape stays
		// selected: with it standing, a press of *Text* meant to read the words reopened the field and took
		// the keyboard, minutes after the drawing. This is the gesture an author makes — draw, title, look
		// at the style, look back at the words.
		await openFace(page, 'style');
		await openFace(page, 'text');
		await expect(page.getByTestId('annotation-title')).toHaveCount(0);
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('The west quay');

		// **And the next click on the map selects rather than draws**, which is what disarming the tool
		// is for. The row is collapsed first, so the click lands on the canvas rather than on the drag
		// handle a selected Annotation puts over its own coordinate — and so that the selection this
		// makes is a change.
		await page.getByTestId('annotation-row').click();
		await expect(inspector(page)).toHaveCount(0);
		await clickAt(baseMap(page), 0.4, 0.4);
		await expect(inspector(page)).toContainText('The west quay');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		// So a second shape takes a second press of "New Annotation" — and the panel that appears then
		// belongs to the shape just drawn rather than to the previous Annotation, because pressing the
		// button deselects.
		await page.getByTestId('annotation-new').click();
		await expect(inspector(page)).toHaveCount(0);
		await page.getByTestId('annotation-tool-point').click();
		await clickAt(baseMap(page), 0.6, 0.6);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await expect(inspector(page)).not.toContainText('The west quay');
	});

	test('the selected row wears the Layer’s own wash and a spine in its ink', async ({ page }) => {
		// **Measured, because the defect was two colours making two claims.** The row carried
		// `border-primary` — the app's action colour, which belongs to the controls *outside* the Layer
		// cards — over daisyUI's `menu-active`, which paints `base-content`: a blue rule against a
		// near-black slab, in a card whose every other control is the Annotation kind's `info`.
		//
		// ⚠ **Both marks are read off the `<li>` rather than off the row's header button.** Nothing about
		// the mark is on the button, so a locator on `annotation-row` would report "no background"
		// whatever the row looked like.
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await drawPin(page, 0.6, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page, 0);

		const rows = page.getByTestId('annotation-row-item');
		const marked = rows.nth(0);
		const plain = rows.nth(1);
		const backgroundOf = (target: typeof marked) =>
			target.evaluate((element) => getComputedStyle(element).backgroundColor);

		// The wash is the *kind's*, asserted by comparing it with the wash on the card's own header rather
		// than by naming a token here — the one table both read from is `layer-kind-style.ts`, and a row
		// repainted in the app's action colour is exactly what this catches.
		const header = page
			.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`)
			.getByTestId('layer-header');

		// **Polled, because `menu` transitions its background.** Read once, a row that has just gained or
		// lost the wash reports whatever alpha the fade is passing through — the same colour at 0.04
		// instead of 0.1, which is a true reading of a moving value and a useless assertion. This settles.
		const wash = await backgroundOf(header);
		await expect.poll(() => backgroundOf(marked)).toBe(wash);
		// And only the chosen row wears it: the other one settles back to no background at all.
		await expect.poll(() => backgroundOf(plain)).toBe('rgba(0, 0, 0, 0)');

		// The selected row uses the content token paired with its info fill; the unselected row keeps the
		// card's base-content ink.
		const inkOf = (target: typeof marked) =>
			target.evaluate((element) => getComputedStyle(element).color);
		const namesOf = (target: typeof marked) => target.getByTestId('annotation-row-name');
		expect(await inkOf(namesOf(marked))).not.toBe(await inkOf(namesOf(plain)));

		// **The spine uses the Annotation Layer's own content colour rather than a colour named here.** Read
		// it by comparing it with the ordinal on the same row, which comes from the same `info-content`
		// token in `layer-kind-style.ts`.
		const ink = await inkOf(marked.getByTestId('annotation-row-ordinal'));
		const spineOf = (target: typeof marked) =>
			target.evaluate((element) => getComputedStyle(element).boxShadow);
		const spine = await spineOf(marked);
		// The offsets are matched as a group rather than as substrings: computed `box-shadow` serialises
		// as `<color> <x> <y> <blur> <spread> inset`, so a 2px rule across the row's *top* would satisfy
		// any test that only looked for "2px" somewhere in it.
		expect(spine).toMatch(/2px 0px 0px 0px inset/);
		expect(spine).toContain(ink);
		// And only the chosen row draws one.
		expect(await spineOf(plain)).toBe('none');

		// **A shadow rather than a border, on both rows, because a border is layout**: two pixels arriving
		// on the left of the selected row would shift its text sideways as the selection moved down the
		// list. `border-l-2` is all it would take for that to start happening.
		for (const row of [marked, plain]) {
			expect(await row.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe(
				'0px'
			);
		}
	});

	// **The gesture, not the region.** That the announcement lives in a `polite`, `atomic` region that
	// is on the page before there is anything to say — so a screen reader announces a change of text
	// rather than an arrival — is `AnnotationTools`' own markup and is asserted in
	// `annotation-tools.dom.test.ts`. What needs a canvas is that each click on the map advances the
	// sentence, and that is the whole of what is left here.
	test('the gesture is announced, so it is legible without seeing the canvas', async ({ page }) => {
		await startAnnotating(page);
		const status = page.getByTestId('annotation-status');

		await chooseTool(page, 'polygon');
		await expect(status).toContainText('Click the map to start');
		await clickAt(baseMap(page), 0.4, 0.4);
		await expect(status).toContainText('1 point. 2 more needed');
		await clickAt(baseMap(page), 0.6, 0.4);
		await clickAt(baseMap(page), 0.5, 0.6);
		await expect(status).toContainText('3 points. Done to finish');

		await page.getByTestId('annotation-done').click();

		// **And finishing says what happened rather than falling silent.** The tool puts itself down
		// without being asked, and a region that simply went empty would leave somebody holding a Shape
		// tool that is no longer in their hand.
		await expect(status).toContainText('Shape added');
		await expect(status).toHaveAttribute('data-tool', 'select');
	});
});

test.describe('editing a vertex costs exactly one write, on gesture end (ADR-0017 rule 1)', () => {
	test('dragging a vertex writes once', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.3, 0.4],
			[0.7, 0.5]
		]);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		const handle = page.getByTestId('pane-overlay-point-annotation-vertex');
		await expect(handle).toHaveCount(2);

		const before = await storedAnnotations(page, layerId);
		await watchAnnotationWrites(page);

		const box = await handle.first().boundingBox();
		if (!box) throw new Error('the vertex handle has no box');
		const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		const to = { x: from.x + 50, y: from.y - 50 };
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x, to.y);
		// The line's actual MapLibre feature follows the handle before the drag commits.
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
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await annotationWrites(page)).toHaveLength(1);
		const after = await storedAnnotations(page, layerId);
		expect(after.features[0]?.geometry?.coordinates) //
			.not.toEqual(before.features[0]?.geometry?.coordinates);
	});

	test('a held arrow key writes once, which is the keyboard’s pointer-up', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		const handle = page.getByTestId('pane-overlay-point-annotation-vertex');
		await handle.focus();
		const before = await storedAnnotations(page, layerId);
		await watchAnnotationWrites(page);

		// A genuine **hold**: repeated `down` with a single `up` at the end, which is what a held key
		// produces. `press` would be wrong here and measurably so — it sends a `keyup` each time, and
		// each `keyup` is a legitimate end of gesture, so five presses are five writes and the app is
		// right to make them. What this asserts is the other case: many `keydown` repeats inside one
		// hold, ending in one `keyup`, cost one write.
		await page.keyboard.down('ArrowRight');
		for (let repeat = 0; repeat < 5; repeat += 1) await page.keyboard.down('ArrowRight');
		await page.keyboard.up('ArrowRight');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await annotationWrites(page)).toHaveLength(1);
		expect((await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates) //
			.not.toEqual(before.features[0]?.geometry?.coordinates);
	});

	test('a polygon reshaped by a vertex stays a closed ring', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawShape(page, 'polygon', [
			[0.4, 0.4],
			[0.7, 0.4],
			[0.55, 0.7]
		]);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		// One handle per position of the ring *minus its closing repeat*, so the closing vertex is not a
		// second handle sitting on the first that silently has to follow it.
		const handles = page.getByTestId('pane-overlay-point-annotation-vertex');
		await expect(handles).toHaveCount(3);

		await handles.first().focus();
		await page.keyboard.press('Shift+ArrowRight');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const ring = (await storedAnnotations(page, layerId)).features[0]?.geometry
			?.coordinates as number[][][];
		expect(ring[0]).toHaveLength(4);
		expect(ring[0]?.at(0)).toEqual(ring[0]?.at(-1));
	});
});

test.describe('title and description', () => {
	/** Draw one pin and select it, which is the smallest thing that has a description. */
	async function withOnePin(page: Page): Promise<string> {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		return layerId;
	}

	test('both are editable and persist across a reload', async ({ page }) => {
		const layerId = await withOnePin(page);

		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Warehouses');
		await page.getByTestId('annotation-title').blur();
		await page.getByTestId('annotation-description').fill('The *west* quay.');
		await page.getByTestId('annotation-description').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// The three colours a drawn Annotation starts on are alongside the text, which is the point of
		// asserting the whole object: prose and style share one `properties` bag, and a title that landed
		// in it by clobbering the style would pass a `toMatchObject`.
		expect((await storedAnnotations(page, layerId)).features[0]?.properties).toEqual({
			title: 'Warehouses',
			description: 'The *west* quay.',
			'marker-color': ANNOTATION_COLOR.grey,
			stroke: ANNOTATION_COLOR.grey,
			fill: ANNOTATION_COLOR.grey
		});

		await reopenLayers(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		// Read as text; the pencil is what turns them back into fields. The title is read off the
		// Inspector's header, which is the one place the panel names its Annotation, and it appears
		// there exactly once.
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('Warehouses');
		await expect(page.getByTestId('annotation-description-text')).toContainText('The west quay.');
		expect((await inspector(page).innerText()).match(/Warehouses/g)).toHaveLength(1);
		await editAnnotationText(page);
		await expect(page.getByTestId('annotation-title')).toHaveValue('Warehouses');
		await expect(page.getByTestId('annotation-description')).toHaveValue('The *west* quay.');
	});

	// **"Typing a whole sentence does not shut the fields" is no longer here.** It is
	// `annotation-text-face.dom.test.ts`'s test of the same name, and the move is exact rather than
	// approximate: the regression is that `annotation` is a *fresh object with the same id* after
	// every save — which is after every keystroke — and a face that resets on identity rather than on
	// id slams the fields shut after one letter. `AnnotationTextFaceHarness.svelte` rebuilds the
	// Annotation on every write for precisely that reason, so the state the bug needs is constructed
	// there rather than merely arrived at. The wiring that this file still proves is the test above:
	// the fields are really reached from the running application, really write, and really survive a
	// reload.
	test('typing does not rebuild the Layer stack, so the map does not thrash', async ({ page }) => {
		// The bug: the collection was part of the key the stack was built from, so every keystroke —
		// each of which writes the file and hands the page a new collection — tore down and re-added
		// **every layer in the stack**, Map Images included, and the map flickered and refetched
		// tiles while a scholar typed a title. The structure key now carries only which MapLibre layers
		// the contents need; the features themselves are pushed into the source that is already there.
		//
		// Counted rather than looked at, through the stack's own build counter — the same one
		// `editor-layers.e2e.ts` uses to assert that dragging opacity is not a rebuild.
		await withOnePin(page);
		const builds = () =>
			page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack?.builds ?? -1);
		const before = await builds();
		expect(before).toBeGreaterThan(0);

		// ── AND SELECTING ONE COSTS THE STORE NOTHING AT ALL ────────────────────────────────
		//
		// The leader recomputes on every frame of a pan, and the way that goes wrong is not a slow
		// frame — it is a redraw that reaches back through the application for the coordinate it is
		// drawing to. So the gesture that turns the leader on is counted: choosing an Annotation must
		// not open a file for reading and must not open one for writing. `project.json` in particular:
		// a selection written as display state would restamp `updatedAt` on every click (ADR-0002).
		//
		// Here rather than in a test of its own because it is the same subject as the paragraph above
		// — what drawing over the map is allowed to cost — and the Seam 2 budget is spent.
		const onlyRow = page.getByTestId('annotation-row').first();
		// `withOnePin` leaves the row open, and the gesture under test is *opening* one — so it is put
		// away first, and the closing click is outside the count.
		await onlyRow.click();
		await expect(onlyRow).toHaveAttribute('aria-expanded', 'false');
		await countFileReads(page);
		await countFileWrites(page);
		// ⚠ **And it costs no camera move either.**
		// Selecting an Annotation reserves the Inspector's footprint in the camera so that the mark is never
		// behind the panel describing it — and that reservation must not be spent on a mark already
		// comfortably in view. This pin is in the middle of the pane, the gesture was a press of a row, and a
		// map that jumped under the pointer for it is the defect `keepInView` is careful about in the sidebar
		// today, and the one this camera inherits from it under ADR-0035. Asserted alongside the store's two counters
		// because it is the same subject — what choosing an Annotation is allowed to cost — and because this
		// test depends on the camera for nothing else, so a spurious move has nothing to break but this.
		const centre = () =>
			page.evaluate(() =>
				(window as unknown as StackWindow).ballastellaLayerStack!.map.getCenter()
			);
		const moving = () =>
			page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack!.map.isMoving());
		const camera = await centre();
		await onlyRow.click();
		await expect(onlyRow).toHaveAttribute('aria-expanded', 'true');
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		expect(await fileReads(page), 'selecting an Annotation read from the store').toEqual({});
		expect(await fileWrites(page), 'selecting an Annotation wrote to the store').toEqual([]);
		expect(await moving(), 'selecting a mark already in view started a camera move').toBe(false);
		expect(await centre()).toEqual(camera);
		// ⚠ **Read again once the move it refuses would have finished**, which is
		// {@link RESERVATION_EASE_MS} of `easeTo` plus room for the flush that would have started it. The
		// claim is stillness, and stillness asserted in the same task as the click is green whether a move
		// was started or not — the panel's own arrival is the only thing between them.
		await page.waitForTimeout(RESERVATION_EASE_MS + 200);
		expect(await moving(), 'the camera moved a moment after the selection').toBe(false);
		expect(await centre()).toEqual(camera);

		await editAnnotationText(page);
		await page.getByTestId('annotation-title').click();

		// ── AND THE EMPHASIS ON THE SELECTED PIN SURVIVES THE KEYSTROKES ────────────────────
		//
		// The same thrash arriving through the source instead of through the stack. Every keystroke
		// writes the file, every write hands the page a new collection, and a new collection is a
		// `setData` — which MapLibre answers by dropping the source's feature states. So an Annotation
		// that stayed selected through a rename would lose its emphasis on the first character typed,
		// with the row still open and nothing on the map saying which one it was about.
		// `StackRender.setAnnotations` re-applies the selection for exactly this, and this is what holds
		// it: counted rather than looked at, because the difference is a paint expression's input.

		await page.keyboard.type('The old mill', { delay: 40 });
		await page.getByTestId('annotation-description').click();
		await page.keyboard.type('Built 1780.', { delay: 40 });
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await builds()).toBe(before);
		// And the words did land, so this is not passing by having typed into nothing.
		const layerId = await annotationLayerId(page);
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features[0]?.properties) //
			.toMatchObject({ title: 'The old mill', description: 'Built 1780.' });
		// Still the selected one on the map, after two dozen writes of the file it lives in.
		expect(
			await page.evaluate(
				(target) =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.getFeatureState(target),
				{ source: `ballastella-layer-${layerId}-source`, id: stored.features[0]!.id! }
			),
			'the selected Annotation lost its emphasis while its title was typed'
		).toEqual({ selected: true });
		// **The positive control for the empty *write* assertion**, and the same watcher: typing did
		// reach the store, so "selecting wrote nothing" is a fact about the gesture rather than about an
		// instrumentation that was never installed. An absence asserted alone passes when the hook
		// silently stops working.
		expect(
			(await fileWrites(page)).length,
			'no write was counted at all, so the empty write assertion above is vacuous'
		).toBeGreaterThan(0);

		// **And the control for the empty *read* assertion**, which is a separate hook and so a separate
		// fact. `fileReads` reads `window.ballastellaFileReads`, which is `{}` when nothing was ever
		// installed — so "selecting read nothing" passes identically against a `countFileReads` that
		// silently stopped patching, which is the shape the write half above is here to rule out.
		//
		// ⚠ **The read this counts is the harness's own, and that is not a weaker control than the one
		// above.** Nothing the app does after the selection reads a file — measured, `{}` at this point
		// with the two lines above removed: saving writes what the editor already holds in memory and
		// opens nothing for reading — so there is no product gesture in this test to point at. What the
		// two `storedAnnotations`/`annotationLayerId` reads just above do go through is
		// `FileSystemFileHandle.prototype.getFile` *in the page*, which is the one call
		// `DirectoryHandleStore` reads through and the exact call `countFileReads` patches. So this
		// establishes what the empty assertion needs establishing: that the counter is installed and
		// counting.
		expect(
			Object.keys(await fileReads(page)),
			'no read was counted at all, so the empty read assertion above is vacuous'
		).not.toEqual([]);
	});

	test('recolouring an Annotation does not rebuild the stack either', async ({ page }) => {
		// The same seam from the other side: a paint property is set, which is the change that would be
		// most expensive if it tore the stack down and refetched (ADR-0017 rule 1 is about this shape).
		await withOnePin(page);
		const builds = () =>
			page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack?.builds ?? -1);
		const before = await builds();

		await chooseColour(page, 'annotation-marker-color', 'purple');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await builds()).toBe(before);
	});

	// **Footnote syntax is not asserted here.** ADR-0009's "the syntax degrades to literal text" is a
	// claim about the Markdown pipeline and nothing else, and it is asserted over the same input —
	// `A claim[^1] worth noting.` with its definition line — in
	// `packages/core/src/annotation/markdown.browser.test.ts`, over a real DOM and in milliseconds.
	// What a Seam 2 test can add is that this panel renders through that pipeline at all, and the test
	// above already fails if it does not.
});

test.describe('on a phone', () => {});

test.describe('a description is untrusted, and this is asserted not assumed (ADR-0009)', () => {
	/**
	 * Prose that **must survive**, carried in the same value as the attack.
	 *
	 * This is the anti-vacuous half, and it is not decoration. A surface that renders *nothing* passes
	 * every "no script, no handler, no dangerous URL" assertion perfectly — and rendering nothing is
	 * exactly what a `{@html}` does when Svelte has adopted prerendered nodes for it, which this app did
	 * until it was found. So each surface has to be shown to be **live** before its emptiness of markup
	 * means anything, and the way to show that is legitimate content in the same string.
	 *
	 * It also asserts the sanitiser is not simply deleting everything: emphasis inside a value that also
	 * contains an attack still renders.
	 */
	const PROSE = 'The **west** quay, per the survey.';

	/**
	 * The payload an import stores byte-identical, plus a `javascript:` link.
	 *
	 * The `javascript:` link is written in **Markdown** syntax deliberately: it contains no HTML, so a
	 * sanitise-then-parse implementation passes it through as inert text and then reconstructs an
	 * `<a href="javascript:…">` out of it. That is the bypass ADR-0009 names, and it is the payload that
	 * distinguishes the two possible orders — an `<img onerror>` is removed in either.
	 *
	 * Note what the correct outcome *is*, because it is not "the text is escaped": DOMPurify **removes**
	 * a disallowed element rather than escaping it, so `onerror` does not survive anywhere in the
	 * rendered description as text either. That is right — there was never anything to show — and it is
	 * why {@link PROSE} rather than the payload's own characters is what proves the surface rendered.
	 */
	const PAYLOAD =
		`${PROSE}` +
		'<img src=x onerror="window.__xss=1">' +
		'<script>window.__xss=1</script>' +
		'[click](javascript:window.__xss=1)' +
		'<a href="data:text/html,&lt;script&gt;1&lt;/script&gt;">d</a>' +
		'<svg onload="window.__xss=1"></svg>';

	/** Everything a rendered fragment must not contain, asked of the live DOM. */
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
				// Characters at or below the space are dropped before matching the scheme: browsers skip
				// them, so `java\tscript:` and a leading newline are both `javascript:` to a navigation and
				// are the classic way past a naive string check. A codepoint filter rather than a regex
				// character class, which would have to embed control characters to name them.
				executableUrls: urls.filter((url) =>
					/^(javascript|data|vbscript):/i.test(
						[...url].filter((character) => (character.codePointAt(0) ?? 0) > 0x20).join('')
					)
				),
				// The text is still readable, which is the other half: sanitising must not silently
				// swallow what a user wrote.
				text: host.textContent ?? ''
			};
		}, selector);
	}

	/**
	 * Nothing executed, and nothing from the payload reached the document at large.
	 *
	 * `injectedScript` looks for the payload's *own* text inside a `<script>` rather than for any script
	 * element: the app legitimately ships its own, so `querySelector('script')` is true on every page
	 * and would have made this probe report an injection on a page with none. That mistake is worth
	 * leaving a note about, because it fails in the safe direction — a probe that cries wolf gets
	 * loosened, and the loosening is where the real check gets lost.
	 */
	async function nothingRan(page: Page) {
		return page.evaluate(() => ({
			ran: '__xss' in window,
			injectedImage: document.querySelector('img[src="x"]') !== null,
			injectedScript: [...document.querySelectorAll('script')].some((script) =>
				(script.textContent ?? '').includes('__xss')
			)
		}));
	}

	/**
	 * A Project whose Annotation carries the payload in **both** its title and its description, seeded
	 * into the file the way a zip import would have left it.
	 *
	 * Seeded rather than typed, because that is the real threat model: the payload arrives in a zip or
	 * from a remote source, written by somebody else, and the first time this app touches it is when it
	 * renders it. Typing it would also work, and would prove less.
	 */
	async function withPayload(page: Page): Promise<string> {
		const layerId = await seedAnnotationProject(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					{
						type: 'Feature',
						id: 'payload',
						properties: { title: PAYLOAD, description: PAYLOAD },
						geometry: { type: 'Point', coordinates: [4.9, 52.37] }
					}
				]
			})
		);
		await reopenLayers(page);
		return layerId;
	}

	test('the payload is inert in the row where the Annotation is read', async ({ page }) => {
		// ┌───────────────────────────────────────────────────────────────────────────────────────┐
		// │ THE ONE PAYLOAD TEST THIS SEAM KEEPS, AND WHY IT IS THIS ONE.                         │
		// └───────────────────────────────────────────────────────────────────────────────────────┘
		//
		// The payload matrix itself is a claim about a pure pipeline — `marked` parses, DOMPurify
		// sanitises, in that order — and it is asserted over the same payload in
		// `packages/core/src/annotation/markdown.browser.test.ts`, where a real DOM is the assertion
		// and no application has to boot. That file still exercises `renderAnnotationPopup` as well as
		// `renderDescription`: the sanitiser did not retire with the popup.
		//
		// What no test there can fail for is **whether the application calls it**. The sanitiser could
		// be perfect and this row could set `innerHTML` from the raw `description`, and every assertion
		// one seam down would still pass. So the wiring is asserted here, on the reader's own path to
		// the Annotation — a click on the map, which opens its row — and it is asserted over both
		// fields, because a sanitiser applied to one of an Annotation's two text surfaces is a
		// vulnerability with a passing test.
		const failures = watchFailures(page);
		await withPayload(page);
		await chooseTool(page, 'select');

		// Clicked on the map, which is the reader's own path to it. The row it opens is the surface,
		// and no popup is drawn over the Base Map at all.
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

		// **Two hosts rather than one**, because the panel around them is full of this app's own
		// controls: Lucide glyphs are first-party `<svg>`, which the probe counts as an embed
		// because in a *stranger's description* an `<svg>` is an execution route. Probing the whole
		// editor would be asking about the swatches rather than about the author's string.
		const description = await inertWithin(page, '[data-testid="annotation-description-text"]');
		expect(description.missing).toBe(false);
		// **The prose first.** A description that renders nothing at all passes every assertion
		// below it, and nothing is exactly what `{@html}` produces when Svelte has adopted
		// prerendered nodes for it.
		expect(description.text).toContain('The west quay, per the survey.');
		await expect(page.getByTestId('annotation-description-text').locator('strong')).toHaveText(
			'west'
		);
		expect(description.scripts).toBe(0);
		expect(description.images).toBe(0);
		expect(description.svgs).toBe(0);
		expect(description.iframes).toBe(0);
		expect(description.ids).toBe(0);
		expect(description.handlers).toEqual([]);
		expect(description.executableUrls).toEqual([]);

		// The title reached the Inspector's header as characters — a Svelte interpolation, which is a
		// different mechanism from the description's and is why it is asserted separately.
		const title = await inertWithin(page, '[data-testid="annotation-inspector-name"]');
		expect(title.missing).toBe(false);
		expect(title.text).toContain('onerror');
		expect(title.scripts).toBe(0);
		expect(title.images).toBe(0);
		expect(title.svgs).toBe(0);
		expect(title.handlers).toEqual([]);
		expect(title.executableUrls).toEqual([]);

		expect(await nothingRan(page)).toEqual({
			ran: false,
			injectedImage: false,
			injectedScript: false
		});
		expect(failures).toEqual([]);
	});

	test('rendering the payload does not rewrite the file it came from', async ({ page }) => {
		// ADR-0010: merely looking at somebody else's Project must not modify a byte of it. This also
		// carries forward the import's own claim — the payload is stored as it arrived — through a
		// session that has now *rendered* it three ways.
		const layerId = await withPayload(page);
		const before = await hashesUnder(page, 'annotations/');

		// Selected *by the click on the map*, with nothing selected before it — see the row test above
		// for why the click is not made on top of a drag handle.
		await chooseTool(page, 'select');
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.getByTestId('annotation-description-text')).toBeVisible();
		// Tab out of the title field: a blur must not rewrite.
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').focus();
		await page.getByTestId('annotation-title').blur();

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect((await storedAnnotations(page, layerId)).features[0]?.properties['title']).toBe(PAYLOAD);
	});
});

test.describe('style controls write simplestyle names exactly', () => {
	/**
	 * **The nine swatches fit on one line inside the Inspector**, which is the half of this claim that
	 * needs a laid-out page.
	 *
	 * That there are nine and no more, that each is a real radio named "Red" rather than "option 4",
	 * that the chosen one wears a tick in the ink the contrast table calls for, and that the choice is
	 * said in words, are all `ColorPicker`'s own markup and are asserted in
	 * `annotation-style-face.dom.test.ts`. None of them needed a Project, a boot, or a map: the six
	 * `chooseColour` round trips this test used to make to check the tick's ink were most of its
	 * thirty-six seconds.
	 *
	 * The measurement cannot follow them. There is no layout at the component seam — no
	 * `getBoundingClientRect`, no panel to be inside — and `vitest.config.ts` records that as a
	 * known absence rather than a gap to work around. So what stays is the geometry, plus one
	 * choice made end to end, which is what proves this picker is really rendered on the Inspector's
	 * Style face and really writes.
	 */
	test('the nine colours fit on one line inside the Inspector, and choosing one writes', async ({
		page
	}) => {
		await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await openFace(page, 'style');

		// **All nine on one line, and inside the panel they are drawn in.** This was a 3×3 grid, and
		// three of these pickers made the selected Annotation's card the tallest thing in the sidebar it
		// used to be in. A wrapped row is the failure this asserts against — it looks like a design
		// choice rather than a bug — so the measurement is that every swatch shares a top edge and the
		// last one ends inside the Inspector, which is now the box that has to be wide enough for them.
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

		// One choice, made the way a scholar makes it, reaching the file. The *vocabulary* — which nine,
		// what each is called, which ink its tick takes — is the component seam's; what this adds is
		// that the control is wired to the Annotation in front of it.
		const chosen = await chooseColour(page, 'annotation-marker-color', 'purple');
		await expect(page.getByTestId('annotation-marker-color-chosen')).toHaveText('Purple');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect(chosen).toBe(ANNOTATION_COLOR.purple);
	});

	// **Which controls a pin is offered is the Style face's and has moved** — that there is no fill on a
	// pin so there is no control for one, and that the whole Line group is absent rather than empty, are
	// asserted per geometry in `annotation-style-face.dom.test.ts` against a component handed a
	// `Point`. What that seam cannot see is the other end of the same union: that what those
	// controls write lands in the Layer's own file under simplestyle's exact names, which is storage
	// and stays here.
	test('a pin’s marker properties reach the file under simplestyle’s own names', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		const markerColor = await chooseColour(page, 'annotation-marker-color', 'purple');
		await page.getByTestId('annotation-marker-size-large').click();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;
		expect(properties['marker-color']).toBe(markerColor);
		expect(properties['marker-size']).toBe('large');
	});
});

/** The Annotation Layer's file as text, for asserting what is *not* in it. */
const readAnnotationText = async (page: Page, layerId: string): Promise<string> =>
	JSON.stringify(await storedAnnotations(page, layerId));

test.describe('solid, dashed, and dotted', () => {
	test('the three render distinctly, each by its own layer with its own dash pattern', async ({
		page
	}) => {
		// Asserted on **what MapLibre drew**. `line-dasharray` is the one paint property MapLibre will not
		// evaluate per feature, so three line styles inside one Annotation Layer means three MapLibre
		// layers filtered on the bucket — and this is the assertion that they exist, that each Annotation
		// went to the right one, and that their dash patterns actually differ.
		const failures = watchFailures(page);
		const layerId = await seedAnnotationProject(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					line('certain', [4.8, 52.3], [5.0, 52.3], {}),
					line('conjectural', [4.8, 52.35], [5.0, 52.35], { 'stroke-dasharray': [8, 4] }),
					line('guessed', [4.8, 52.4], [5.0, 52.4], { 'stroke-dasharray': [1, 3] })
				]
			})
		);
		await reopenLayers(page);

		const painted = await waitForPaintedAnnotations(page, ['certain', 'conjectural', 'guessed']);

		expect(painted['certain']).toContain(`ballastella-layer-${layerId}-line-solid`);
		expect(painted['conjectural']).toContain(`ballastella-layer-${layerId}-line-dashed`);
		expect(painted['guessed']).toContain(`ballastella-layer-${layerId}-line-dotted`);
		// Each Annotation went to exactly one line layer, so a dashed line is not also painted solid
		// underneath — which is what "render distinctly" would otherwise quietly fail to mean.
		for (const id of ['certain', 'conjectural', 'guessed']) {
			const lineLayers = (painted[id] ?? []).filter((name) => name.includes('-line-'));
			expect(lineLayers).toHaveLength(1);
		}

		// And the patterns differ, in MapLibre's own line-width units.
		expect(await paintProperty(page, `ballastella-layer-${layerId}-line-solid`, 'line-dasharray')) //
			.toBeNull();
		expect(await paintProperty(page, `ballastella-layer-${layerId}-line-dashed`, 'line-dasharray')) //
			.toEqual([4, 2]);
		expect(await paintProperty(page, `ballastella-layer-${layerId}-line-dotted`, 'line-dasharray')) //
			.toEqual([0.5, 1.5]);
		expect(failures).toEqual([]);
	});
});

/**
 * What MapLibre says it painted each Annotation with, by the Annotation's own id.
 *
 * The resolved style off the render copy, which is the only place the whole precedence chain is
 * visible: the file holds what the user set, the Layer holds its default, and this is the answer.
 */
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

/** One LineString `Feature`, for a seeded fixture. */
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

/**
 * One Point `Feature` for a seeded fixture, Label or Pin.
 *
 * `marker-symbol: 'label'` is the discriminator, spelled here as the literal a file carries rather than
 * imported: the Playwright project resolves nothing from `@ballastella/core`, and a convention copied
 * from the spec is a better witness to it than one taken from the code under test.
 */
const pointFeature = (id: string, at: [number, number], properties: Record<string, unknown>) => ({
	type: 'Feature',
	id,
	properties,
	geometry: { type: 'Point', coordinates: at }
});

const labelFeature = (id: string, at: [number, number], properties: Record<string, unknown>) =>
	pointFeature(id, at, { 'marker-symbol': 'label', ...properties });

/**
 * What MapLibre reports at one place on the earth, as Annotation ids and the layers that painted them.
 *
 * Scoped to features carrying `ballastella:id`, because a point query answers with the Base Map's own
 * roads and place names too — and "nothing of ours is drawn here" is one of the claims below.
 */
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

/**
 * How wide the chip drawn for one Label is, in CSS pixels, measured by where it stops being hit.
 *
 * ⚠ **Asked of the renderer rather than of the style.** `icon-text-fit` is MapLibre's arithmetic over a
 * text block this test never sees, so the only honest way to ask how wide a chip came out is to walk
 * outwards from its coordinate until the hit test stops naming it. The step is coarse because the claim
 * is a comparison between two chips, not a measurement of either.
 */
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

/**
 * A column of pixels straight up from one coordinate, read off the map's own framebuffer.
 *
 * ⚠ **Not a screenshot comparison.** Nothing here is compared against a stored image; the caller reads
 * the same column twice and asks which rows changed, which is a question about one paint value and not
 * about how the map looks. It is the only way to ask whether an `icon-halo` was drawn: a halo is not a
 * feature, so `queryRenderedFeatures` cannot see it.
 *
 * `readPixels` has to happen inside a `render` handler, before the frame is presented — after that the
 * default framebuffer is undefined unless MapLibre was built with `preserveDrawingBuffer`.
 */
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

test.describe('a Label draws its words on the map', () => {
	/**
	 * A title a stranger wrote, drawn on the map by a renderer that has no HTML parser in it.
	 *
	 * The `<img>` fires nothing — there is no network and no loader — so the assertion is on the
	 * characters and on the absence of an element. `watchFailures` catches the `alert` besides.
	 */
	const PAYLOAD = '<img src=x onerror=alert(1)>Zuiderzee';

	/** Well apart in latitude, so a point query at one Label’s place cannot land on another’s chip. */
	const SHORT: [number, number] = [4.9, 52.51];
	const LONG: [number, number] = [4.9, 52.44];
	const BLANK: [number, number] = [4.9, 52.37];
	const UNTRUSTED: [number, number] = [4.9, 52.3];
	const PIN: [number, number] = [4.9, 52.23];
	/** Beside `BLANK` rather than below it, so the column of Labels stays inside the viewport. */
	const SPACES: [number, number] = [5.05, 52.37];

	test('each Label is drawn from the Label bucket, the Pin beside it is not, and an empty one draws nothing', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await seedAnnotationProject(page);
		// Seeded rather than drawn: nothing in this slice creates a Label, and the file is where the
		// convention lives. Two `fill` colours, because one registered SDF tinted per feature is what the
		// design rests on.
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					labelFeature('short', SHORT, { title: 'Ee', fill: ANNOTATION_COLOR.blue }),
					labelFeature('long', LONG, {
						title: 'Zuiderzee en de Waddenzee',
						fill: ANNOTATION_COLOR.red
					}),
					labelFeature('blank', BLANK, { title: '' }),
					labelFeature('spaces', SPACES, { title: ' ', fill: ANNOTATION_COLOR.blue }),
					labelFeature('untrusted', UNTRUSTED, { title: PAYLOAD }),
					pointFeature('pin', PIN, { title: 'The old harbour' })
				]
			})
		);
		await reopenLayers(page);
		await waitForPaintedAnnotations(page, ['short', 'long', 'untrusted', 'pin']);

		// ── THE WORDS ARE WHERE THE POINT SAID, AND THEY COME OUT OF THE LABEL BUCKET ────────
		const labelLayer = `ballastella-layer-${layerId}-label`;
		const pointLayer = `ballastella-layer-${layerId}-point`;
		// `toContainEqual` rather than an exact array: `queryRenderedFeatures` answers once per tile a
		// geometry spans, so what is being asked is *which* layer painted this Label, not how many rows
		// the query returned. That nothing else painted it is the assertion below.
		expect(await annotationsAt(page, SHORT)) //
			.toContainEqual({ id: 'short', layer: labelLayer, title: 'Ee' });

		// ── AND A PIN IS STILL A PIN, AND ONLY A PIN ────────────────────────────────────────
		//
		// The `point` bucket's filter carries the negation of the Label's, and `['get', 'marker-symbol']`
		// is `null` on a Pin: without both halves a Label draws a pin under its words, or a Pin stops
		// drawing at all. Asserted rather than reasoned about.
		const atPin = await annotationsAt(page, PIN, 0, -12);
		expect(new Set(atPin.map((hit) => hit.layer))).toEqual(new Set([pointLayer]));
		expect(new Set(atPin.map((hit) => hit.id))).toEqual(new Set(['pin']));
		expect(await annotationsAt(page, SHORT)).not.toContainEqual(
			expect.objectContaining({ layer: pointLayer })
		);

		// ── AN EMPTY TITLE DRAWS NOTHING, RATHER THAN AN EMPTY COLOURED BOX ─────────────────
		//
		// Neither the words nor the chip they would have sat on — which is a stronger claim than "no
		// text", and the reason `icon-image` is chosen per feature: MapLibre draws a symbol that has an
		// icon and no text, so an empty title used to leave a bare coloured box behind. This is the
		// assertion that caught it.
		expect(await annotationsAt(page, BLANK)).toEqual([]);

		// ── AND SO DOES A TITLE OF NOTHING BUT WHITESPACE ───────────────────────────────────
		//
		// The other half, and the one `!== ''` missed: MapLibre's shaping trims each line before it
		// measures anything, so a single space shapes to no text at all while the icon still resolves
		// — a bare coloured box for an author who typed a space, or who deleted a word back to one.
		expect(await annotationsAt(page, SPACES)).toEqual([]);

		// ── THE CHIP GROWS WITH THE WORDS ───────────────────────────────────────────────────
		const short = await chipWidth(page, SHORT, 'short');
		const long = await chipWidth(page, LONG, 'long');
		expect(short).toBeGreaterThan(0);
		expect(long).toBeGreaterThan(short);

		// ── AND A TITLE THAT LOOKS LIKE MARKUP IS CHARACTERS ────────────────────────────────
		//
		// The map is a WebGL canvas, so the payload cannot become an element there; what this asserts is
		// that it did not become one anywhere else on the way, and that every character was typeset —
		// a renderer that had swallowed the tag would draw a chip no wider than the words after it.
		expect(await annotationsAt(page, UNTRUSTED)) //
			.toContainEqual({ id: 'untrusted', layer: labelLayer, title: PAYLOAD });
		expect(await page.locator('img[src="x"]').count()).toBe(0);
		expect(await chipWidth(page, UNTRUSTED, 'untrusted')) //
			.toBeGreaterThan(await chipWidth(page, SHORT, 'short'));

		expect(failures).toEqual([]);
	});

	test('a Label is selected by clicking it, given a leader, and moved by its vertex handle for one write', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await seedAnnotationProject(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [labelFeature('zuiderzee', BLANK, { title: 'Zuiderzee' })]
			})
		);
		await reopenLayers(page);
		await waitForPaintedAnnotations(page, ['zuiderzee']);

		// ── CLICKED ON THE MAP, LIKE A PIN ──────────────────────────────────────────────────
		//
		// Hit-testing is by layer id, so a Label absent from `annotationLayerIds` is a mark nobody can
		// click — and nothing about the click path is Label-specific, which is the point.
		const pane = (await baseMap(page).boundingBox())!;
		const at = await page.evaluate(
			(coordinate) =>
				(window as unknown as StackWindow).ballastellaLayerStack!.map.project(
					coordinate as [number, number]
				),
			BLANK
		);
		// Straight up from the coordinate is the middle of the chip's flat top edge — as far from a corner
		// as the shape gets, and the place a field with no outward falloff has nothing to draw a halo on.
		const beforeSelecting = await pixelsAbove(page, BLANK, 40);
		await page.mouse.click(pane.x + at.x, pane.y + at.y);

		const row = page.getByTestId('annotation-row');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('Zuiderzee');
		// The emphasis on the map is a feature state the chip's `icon-halo-width` reads, so the selected
		// Label is drawn exactly as the file asks with an aura around it and never recoloured.
		expect(
			await page.evaluate(
				(source) =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.getFeatureState({
						source: source as string,
						id: 'zuiderzee'
					}),
				`ballastella-layer-${layerId}-source`
			)
		).toEqual({ selected: true });

		// ── AND THE AURA IS AROUND THE CHIP, NOT FOUR ARCS AT ITS CORNERS ───────────────────
		//
		// ⚠ **The claim `label-chip.ts`'s transparent margin exists for.** The chip is an SDF and its halo
		// is drawn wherever the field has fallen below the shader's own edge value; a field clipped at the
		// shape's outline has none of that beside a flat edge, so `icon-halo-width` used to paint four
		// small corner arcs with nothing between them instead of an aura around the whole chip. Read on
		// the column above the coordinate, which is the middle of the flat top edge.
		//
		// Only the halo can have changed: `icon-color`, `icon-opacity` and `text-color` are all read from
		// the feature and selection touches none of them.
		const afterSelecting = await pixelsAbove(page, BLANK, 40);
		const changed = beforeSelecting.filter((pixel, row) => pixel !== afterSelecting[row]).length;
		expect(changed).toBeGreaterThanOrEqual(2);

		// ── AND THE LEADER RUNS TO THE WORDS THEMSELVES ─────────────────────────────────────
		//
		// A Label is centred on its coordinate and has no pin standing above it, so the line ends on the
		// drawing rather than half a pin's height over the ground beside it. The coordinate is the file's
		// and the projection the live camera's, never the mark's own box — see `support/leader.ts`.
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		const end = (await leaderPoints(page))!.at(-1)!;
		expect(Math.hypot(end.x - (pane.x + at.x), end.y - (pane.y + at.y))) //
			.toBeLessThanOrEqual(MARK_CLEARANCE + 1);

		// ── AND IT IS DRAGGED BY ITS VERTEX HANDLE FOR EXACTLY ONE WRITE ────────────────────
		const handle = page.getByTestId('pane-overlay-point-annotation-vertex');
		await expect(handle).toHaveCount(1);
		const before = (await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates;
		await watchAnnotationWrites(page);

		const box = (await handle.boundingBox())!;
		const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x + 40, from.y - 40);
		await page.mouse.up();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await annotationWrites(page)).toHaveLength(1);
		expect((await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates) //
			.not.toEqual(before);
		expect(failures).toEqual([]);
	});

	test('the chip fits its words at all three sizes, with a short word and a long phrase', async ({
		page
	}) => {
		// ⚠ **`label-chip.ts`'s shape stops short of the image's own border so the halo has somewhere to
		// be**, which moves `content`, both stretch zones and the icon's total extent. Nothing in a unit
		// test can say whether `icon-text-fit` still lands on the words after that, so all six cases are
		// asserted here in a browser instead of being trusted.
		const failures = watchFailures(page);
		const layerId = await seedAnnotationProject(page);
		const SHORT_WORD = 'Ee';
		const LONG_PHRASE = 'Zuiderzee en de Waddenzee';
		/** Two columns far enough apart that the widest chip cannot reach the other column's coordinate. */
		const SHORT_LON = 4.7;
		const LONG_LON = 5.1;
		const ROWS = [
			{ size: 'small', lat: 52.51 },
			{ size: 'medium', lat: 52.37 },
			{ size: 'large', lat: 52.23 }
		] as const;

		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: ROWS.flatMap(({ size, lat }) => [
					labelFeature(`short-${size}`, [SHORT_LON, lat], {
						title: SHORT_WORD,
						'marker-size': size,
						fill: ANNOTATION_COLOR.blue
					}),
					labelFeature(`long-${size}`, [LONG_LON, lat], {
						title: LONG_PHRASE,
						'marker-size': size,
						fill: ANNOTATION_COLOR.red
					})
				])
			})
		);
		await reopenLayers(page);
		await centreOnAmsterdam(page);
		await waitForPaintedAnnotations(
			page,
			ROWS.flatMap(({ size }) => [`short-${size}`, `long-${size}`])
		);

		const labelLayer = `ballastella-layer-${layerId}-label`;
		const widths: Record<string, { short: number; long: number }> = {};
		for (const { size, lat } of ROWS) {
			// Drawn at all, from the Label bucket, at every size — `text-size` is a `match` on `marker-size`
			// and a size it does not name resolves to nothing rather than to medium.
			expect(await annotationsAt(page, [SHORT_LON, lat])) //
				.toContainEqual({ id: `short-${size}`, layer: labelLayer, title: SHORT_WORD });
			expect(await annotationsAt(page, [LONG_LON, lat])) //
				.toContainEqual({ id: `long-${size}`, layer: labelLayer, title: LONG_PHRASE });
			widths[size] = {
				short: await chipWidth(page, [SHORT_LON, lat], `short-${size}`),
				long: await chipWidth(page, [LONG_LON, lat], `long-${size}`)
			};
		}

		for (const { size } of ROWS) {
			// The chip is fitted to its words on both axes, so a long phrase's chip is wider than a short
			// word's at the same size — at each size rather than only at the default one.
			expect(widths[size]!.long).toBeGreaterThan(widths[size]!.short);
		}
		// And the three sizes are three sizes: larger words, a larger chip around them.
		expect(widths['small']!.short).toBeLessThan(widths['medium']!.short);
		expect(widths['medium']!.short).toBeLessThan(widths['large']!.short);

		expect(failures).toEqual([]);
	});
});

test.describe('a Label is placed and its words typed', () => {
	/**
	 * ⚠ **The one test in this suite that *creates* a Label rather than seeding one**, which is why it
	 * carries the claims a seeded fixture cannot: what the creation path wrote, what it cost, and what
	 * the next tool drew after it. Everything about the Label bucket's arithmetic is asserted at Seam 1
	 * (`stack-layers.test.ts`, `label-chip.test.ts`) and everything about the style it is created with
	 * at Seam 1 too (`annotation.test.ts`, `annotation-editing.svelte.test.ts`); what needs a browser is
	 * that the whole gesture — a keyboard, a real canvas, real OPFS — comes out as words on a map and a
	 * Point in a file.
	 *
	 * **Driven by the keyboard alone**, so "the map pane is operable without a pointer" is part of this
	 * gesture rather than a separate test: every control is a native button, and `Enter` on the focused
	 * canvas places a vertex at the crosshair.
	 */
	test('typed with the keyboard alone, the words draw and the file says label; its style is inherited and the Pin after it is a Pin', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
		await centreOnAmsterdam(page);
		await watchAnnotationWrites(page);

		// ── REACHED THE SAME WAY AS THE OTHER THREE: NEW ANNOTATION, THEN CHOOSE ────────────
		await page.getByTestId('annotation-new').press('Enter');
		await page.getByTestId('annotation-tool-text').press('Enter');
		await expect(page.getByTestId('annotation-tool-text')).toHaveAttribute('aria-pressed', 'true');
		// The tool names itself and says what to do with it — "Label", never the `'text'` the union
		// spells it.
		await expect(page.getByTestId('annotation-status')) //
			.toHaveText('Label tool. Click the map to place.');

		// ── ONE PRESS OF ENTER ON THE MAP IS THE WHOLE GESTURE ──────────────────────────────
		await page.locator('canvas.maplibregl-canvas').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Placed, announced, and the tool put itself down: one press of New Annotation, one Annotation.
		await expect(page.getByTestId('annotation-status')).toContainText('Label added');
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		// And the keyboard is in the field the words go in, so clicking and typing is one gesture.
		await expect(page.getByTestId('annotation-title')).toBeFocused();

		// **The placement is exactly one write** (ADR-0017 rule 1), and it is the *untitled* document,
		// because a Label drawn by hand has no words yet. The count alone cannot say the second half: a
		// creation followed by a debounced retitle records nothing for the second write, so the count would
		// stay at 1 while the gesture cost two. The bytes say which document was the one counted.
		const untitled = await readProjectFile(page, `annotations/${layerId}.geojson`);
		expect(untitled).not.toContain('title');
		expect(await annotationWrites(page)).toEqual([
			expect.objectContaining({
				annotations: 1,
				path: `${PROJECT_DIRECTORY}/annotations/${layerId}.geojson`,
				bytes: new TextEncoder().encode(untitled).length
			})
		]);

		// ── AND THE WORDS ARE THE ONES THAT WERE TYPED ──────────────────────────────────────
		await page.keyboard.type('Zuiderzee', { delay: 20 });
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const labelLayer = `ballastella-layer-${layerId}-label`;
		const pointLayer = `ballastella-layer-${layerId}-point`;
		const placed = await storedAnnotations(page, layerId);
		const label = placed.features[0]!;
		const at = label.geometry!.coordinates as [number, number];

		// The file is the product: a Point carrying the discriminator and the words, and nothing this app
		// invented.
		expect(label.geometry?.type).toBe('Point');
		expect(label.properties).toMatchObject({ 'marker-symbol': 'label', title: 'Zuiderzee' });

		// **And nine keystrokes added no counted write at all**, because typing is rule 2's coalesced path
		// and `recordAnnotationWrite` deliberately records nothing for a debounced write. So this counter
		// cannot see the coalescing itself, and does not claim to: that nine debounced writes to one
		// Annotation Layer's path become *one* store write is asserted against the store in
		// `editor-session.test.ts` ("collapses nine keystrokes' worth of debounced writes into one store
		// write"). What this adds is that the browser's own path is the debounced one, so the words reached
		// the file without a counted write per character.
		expect(await annotationWrites(page)).toHaveLength(1);

		// Drawn where the point said, out of the Label bucket, with the words on it.
		await waitForPaintedAnnotations(page, [label.id]);
		expect(await annotationsAt(page, at)) //
			.toContainEqual({ id: label.id, layer: labelLayer, title: 'Zuiderzee' });
		// And no pin under them: the `point` bucket's filter carries the negation of the Label's.
		expect(await annotationsAt(page, at)).not.toContainEqual(
			expect.objectContaining({ layer: pointLayer })
		);
		// The words a scholar typed are legible against the chip they sit on, which the creation path is
		// what guarantees: the first Annotation in a Layer would otherwise inherit one grey for both.
		expect(label.properties).toMatchObject({ 'marker-color': '#000000', fill: '#ffffff' });

		// ── THE LABEL'S STYLE IS A NATIVE, KEYBOARD-REACHABLE SET OF CONTROLS ────────────────
		await openFace(page, 'style');
		expect(await page.getByTestId('annotation-stroke').count()).toBe(0);
		expect(await page.getByTestId('annotation-stroke-width').count()).toBe(0);
		expect(await page.getByTestId('annotation-stroke-opacity').count()).toBe(0);
		expect(await page.getByTestId('annotation-line-style-dashed').count()).toBe(0);

		const textColour = page.getByTestId('annotation-marker-color').locator('input:checked');
		await textColour.focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-color-grey')).toHaveAttribute(
			'data-chosen',
			'true'
		);

		const backgroundColour = page.getByTestId('annotation-fill').locator('input:checked');
		await backgroundColour.focus();
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByTestId('annotation-fill-grey')).toHaveAttribute('data-chosen', 'true');

		const size = page.getByTestId('annotation-marker-size-medium').locator('input');
		await size.focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-size-large').locator('input')).toBeChecked();

		const background = await chooseColour(page, 'annotation-fill', 'blue');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

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

		// And then a real drag: `fill()` cannot prove the thumb accepts a pointer gesture, and only a
		// gesture with a release can prove the debounced write is flushed once rather than per step.
		await watchAnnotationWrites(page);
		const opacityBox = await opacitySlider.boundingBox();
		if (!opacityBox) throw new Error('the Label background opacity slider has no box to drag in');
		await page.mouse.move(
			opacityBox.x + opacityBox.width * 0.6,
			opacityBox.y + opacityBox.height / 2
		);
		await page.mouse.down();
		await page.mouse.move(
			opacityBox.x + opacityBox.width * 0.25,
			opacityBox.y + opacityBox.height / 2,
			{
				steps: 10
			}
		);
		await page.mouse.up();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const opacity = Number(await opacitySlider.inputValue());
		expect(opacity, 'dragging the Label background opacity slider did not change it').toBeLessThan(
			0.6
		);
		expect(await annotationWrites(page)).toHaveLength(1);
		const restyled = (await storedAnnotations(page, layerId)).features[0]!;
		expect(restyled.properties).toMatchObject({
			'marker-color': ANNOTATION_COLOR.grey,
			fill: background,
			'fill-opacity': opacity,
			'marker-size': 'large'
		});
		await expect
			.poll(() => renderedStyles(page))
			.toMatchObject({
				[restyled.id]: {
					'marker-color': ANNOTATION_COLOR.grey,
					fill: background,
					'fill-opacity': opacity,
					'marker-size': 'large'
				}
			});

		// ── THE NEXT LABEL STARTS WITH THAT STYLE ─────────────────────────────────────────────
		await chooseTool(page, 'text');
		await clickAt(baseMap(page), 0.62, 0.58);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const secondLabel = (await storedAnnotations(page, layerId)).features[1]!;
		expect(secondLabel.properties).toMatchObject({
			'marker-symbol': 'label',
			'marker-color': ANNOTATION_COLOR.grey,
			fill: background,
			'fill-opacity': opacity,
			'marker-size': 'large'
		});

		// ── AND DRAWING A PIN STRAIGHT AFTER IT GIVES A PIN ─────────────────────────────────
		//
		// The inheritance carve-out's whole consequence, and the reason `marker-symbol` left the copied
		// set: with it copied, this click produced a second Label — the tool the author chose overridden
		// by the style of what they drew last.
		await chooseTool(page, 'point');
		await clickAt(baseMap(page), 0.72, 0.68);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const withPin = await storedAnnotations(page, layerId);
		const pin = withPin.features[2]!;
		expect(pin.properties).not.toHaveProperty('marker-symbol');
		// The colours it *did* inherit from the Label are the Label's: only the property that says what
		// kind of thing this is stopped inheriting.
		expect(pin.properties['marker-color']).toBe(secondLabel.properties['marker-color']);
		expect(pin.properties['fill']).toBe(secondLabel.properties['fill']);

		// Drawn as a pin, and only as a pin. The query is offset up because a pin stands above its
		// coordinate while a Label is centred on it.
		await waitForPaintedAnnotations(page, [pin.id]);
		const atPin = await annotationsAt(page, pin.geometry!.coordinates as [number, number], 0, -12);
		expect(new Set(atPin.map((hit) => hit.layer))).toEqual(new Set([pointLayer]));
		expect(new Set(atPin.map((hit) => hit.id))).toEqual(new Set([pin.id]));

		expect(failures).toEqual([]);
	});
});

test.describe('style is on each Annotation (ADR-0009, as amended)', () => {
	test('a defaultStyle from an earlier build is carried, not resolved and not deleted', async ({
		page
	}) => {
		// A Layer no longer has a default style, and the amendment accepts that a Project which relied
		// on one changes appearance. What it does **not** accept is destroying the field: it is a user's
		// bytes, and opening a Project must not rewrite it (ADR-0010). So it rides through
		// `unknownFields` and is written back exactly as it arrived, while nothing resolves against it.
		const failures = watchFailures(page);
		const layerId = await seedAnnotationProject(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					line('plain', [4.8, 52.3], [5.0, 52.3], {}),
					line('own', [4.8, 52.35], [5.0, 52.35], { stroke: '#ff0000' })
				]
			})
		);
		const project = await projectJson(page);
		project.layers[0].defaultStyle = { stroke: '#112233', 'stroke-width': 5 };
		await writeProjectFile(page, 'project.json', JSON.stringify(project, null, '\t'));
		await reopenLayers(page);

		const styles = await renderedStyles(page);

		// The Annotation with no style of its own draws with simplestyle's, not the Layer's.
		expect(styles['plain']?.['stroke']).not.toBe('#112233');
		expect(styles['plain']?.['stroke-width']).not.toBe(5);
		// The one with its own colour still draws with it.
		expect(styles['own']?.['stroke']).toBe('#ff0000');

		// And the field is still in `project.json`, untouched, after a session that opened and drew.
		await drawPin(page, 0.5, 0.5);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const after = (await projectJson(page)).layers.find(
			(one: { id: string }) => one.id === layerId
		);
		expect(after.defaultStyle).toEqual({ stroke: '#112233', 'stroke-width': 5 });
		expect(failures).toEqual([]);
	});

	test('a newly drawn Annotation is drawn with the last one’s style', async ({ page }) => {
		// What replaced the Layer default, and the whole of it: pick a colour once, and everything drawn
		// after it is that colour — with the file saying so on each Annotation rather than a reader
		// having to resolve it against something on the Layer.
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.3, 0.35],
			[0.7, 0.4]
		]);
		await selectAnnotation(page);
		const stroke = await chooseColour(page, 'annotation-stroke', 'green');
		await chooseLineStyle(page, 'dashed');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// A second line, drawn after that choice.
		await drawShape(page, 'line', [
			[0.3, 0.6],
			[0.7, 0.65]
		]);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		// Stamped onto the new one, as ordinary properties, under the spec's own names. The two colours
		// nobody touched come along as well, at the palette's grey: a new Annotation starts on a swatch
		// rather than on simplestyle's own defaults, so "the last one's style" is the whole style.
		expect(stored.features[1]!.properties).toEqual({
			'marker-color': ANNOTATION_COLOR.grey,
			stroke,
			fill: ANNOTATION_COLOR.grey,
			'stroke-dasharray': [8, 4]
		});
		for (const name of Object.keys(stored.features[1]!.properties)) {
			expect(SIMPLESTYLE_NAMES).toContain(name);
		}

		// And it draws that way: same colour, same dash bucket as the one it was copied from.
		const painted = await waitForPaintedAnnotations(
			page,
			stored.features.map((feature) => feature.id)
		);
		for (const feature of stored.features) {
			expect(painted[feature.id]).toContain(`ballastella-layer-${layerId}-line-dashed`);
		}
		expect(failures).toEqual([]);
	});
});

test.describe('deleting an Annotation', () => {
	/**
	 * Which element has the keyboard, by its `data-testid`, or `'BODY'` for nowhere.
	 *
	 * ⚠ **Polled rather than read once.** The keyboard is put back *after* the deletion's store write, so
	 * "the row is gone" is reached before the focus has moved — measured either side of the same
	 * assertion on two runs of this test. `document.body` is the failing answer this claim is about, and a
	 * single read would report it while the fix was on its way.
	 */
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
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);

		// ── DISMISSING LEAVES THE KEYBOARD IN THE LIST ──────────────────────────────────────
		//
		// Folded in here rather than given a test of its own: this is the suite's Project with three
		// Annotations in one Layer, which is what both halves of the claim need, and the Seam 2 budget
		// (`scripts/check-seam-2-size.mjs`) is spent.
		//
		// **Both controls that take the Inspector off the map are inside it**, so the keyboard has nowhere
		// to be unless it is put somewhere: without this it is on `document.body` and the way back into the
		// list is Tab from the top of the document, past MapLibre's own controls.
		await selectAnnotation(page, 1);
		await page.getByTestId('annotation-inspector-close').click();
		await expect(inspector(page)).toHaveCount(0);
		await expect.poll(() => focused(page)).toBe('annotation-row');
		// And dismissing left the list alone: the Layer's card is still open and the rows are still there.
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);

		const before = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const after = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		expect(after).toEqual([before[0], before[2]]);
		expect(await readAnnotationText(page, layerId)).not.toContain(before[1]!);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);
		// The editor closes with it, rather than showing an Annotation that is no longer there.
		await expect(inspector(page)).toHaveCount(0);
		// And the keyboard goes to the row that took its place, for the same reason as above.
		await expect.poll(() => focused(page)).toBe('annotation-row');

		// ── AND WHEN THE LAST ANNOTATION GOES, TO *NEW ANNOTATION* IN THE SAME CARD ──────────
		//
		// The commonest delete of all — undoing a shape drawn by mistake in a Layer just made — and the
		// one case where "a row in the list" does not exist to be focused. With `rows.length === 0` the
		// keyboard was left on `document.body`, and a delete must never leave it there.
		await selectAnnotation(page, 0);
		await deleteAnnotation(page);
		await selectAnnotation(page, 0);
		await deleteAnnotation(page);
		await expect(page.getByTestId('annotation-row')).toHaveCount(0);
		await expect.poll(() => focused(page)).toBe('annotation-new');
	});
});

test.describe('display state never reaches the GeoJSON (ADR-0002, ADR-0010)', () => {
	test('an unchanged Annotation Layer stays byte-identical across a session that only looked', async ({
		page
	}) => {
		// `editor-layers.e2e.ts` asserts that reorder, rename, toggle, and opacity leave
		// `annotations/*.geojson` byte-identical; this carries that forward through the surface that
		// *edits* them. Selecting,
		// previewing, opening a popup, and tabbing through the fields are all looking, and ADR-0010 is
		// explicit that looking must not modify files.
		//
		// **This one stays at Seam 2 while its sibling round-trip claim moved.** The subject is what the
		// running application writes — or rather does not write — during a session of real gestures over
		// real OPFS, and the assertion is the hashes of the files on disk plus a count of writes that
		// never happened. Asserted one seam down it would become the serialiser agreeing with itself,
		// which cannot fail for the reason the title gives.
		await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Warehouses');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(1);
		await watchAnnotationWrites(page);

		// A whole session of looking: reload, select, open the popup, tab through both text fields, and
		// reorder and rename the Layer itself.
		await reopenLayers(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		// **Opening and closing the row, which is now where the Annotation is read.** The editor lives
		// inside its own row, so a disclosure that saved on open or on close would charge a write per
		// press — and pressing a row is the most ordinary thing a scholar does in this list.
		const row = page.getByTestId('annotation-row').first();
		await row.click();
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect(inspector(page)).toHaveCount(0);
		await row.click();
		await expect(row).toHaveAttribute('aria-expanded', 'true');

		await clickAt(baseMap(page), 0.4, 0.4);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').focus();
		await page.getByTestId('annotation-title').blur();
		await page.getByTestId('annotation-description').focus();
		await page.getByTestId('annotation-description').blur();
		// The Layer's name is text until its own pencil is pressed, the same rule the Annotation's text
		// follows — so renaming now starts there rather than in a field that is always on the card.
		await page.getByTestId('layer-rename').click();
		await page.getByTestId('layer-name').fill('Trade routes');
		await page.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect(await annotationWrites(page)).toEqual([]);
		// And the rename did land, in the one place display state lives.
		expect((await projectJson(page)).layers[0].name).toBe('Trade routes');
	});
});

test.describe('the keyboard alone', () => {
	test('every drawing tool and style control is reachable and operable, and the tool is announced', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);

		// Selecting is the resting behaviour: no button to press for it, and **nothing announced about
		// it** — the region is there and empty, which is what lets the next real status be heard.
		await expect(page.getByTestId('annotation-status')).toHaveText('');

		// The way to a shape is one button, reached and pressed with the keyboard.
		await tabTo(page, page.getByTestId('annotation-new'), 'the New Annotation button');
		await page.keyboard.press('Enter');

		// Each shape is a real button whose pressed state is announced, not merely drawn — and the
		// region **names the tool in words**. The criterion is that the active tool is announced, so
		// what is asserted is the announced text: `data-tool` is a test attribute and reaches nobody,
		// and a toolbar could satisfy it while the live region said nothing about which tool was in
		// hand.
		for (const [tool, spoken] of [
			['point', 'Pin tool.'],
			['line', 'Line tool.'],
			['polygon', 'Shape tool.']
		] as const) {
			const button = page.getByTestId(`annotation-tool-${tool}`);
			await tabTo(page, button, `the ${tool} tool`);
			await page.keyboard.press('Enter');
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByTestId('annotation-status')).toContainText(spoken);
		}

		// And the way back out, which is what selecting is reached by.
		await tabTo(page, page.getByTestId('annotation-cancel'), 'the Cancel button');
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('annotation-status')).toHaveText('');
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		await page.getByTestId('annotation-new').click();

		// The toolbar announces itself as one set of alternatives.
		await expect(page.getByTestId('annotation-tools')).toHaveAttribute('role', 'toolbar');
		await expect(page.getByTestId('annotation-tools')).toHaveAttribute(
			'aria-label',
			'Annotation tools'
		);

		// A pin drawn with no pointer at all: the tool by keyboard, then Enter over the map.
		await tabTo(page, page.getByTestId('annotation-tool-point'), 'the pin tool');
		await page.keyboard.press('Enter');
		await page.locator('canvas.maplibregl-canvas').focus();
		await page.keyboard.press('Enter');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		// **The shapes are behind the button again, because that gesture is over** — so a second shape
		// takes a second press, reached by keyboard like the first.
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		await tabTo(page, page.getByTestId('annotation-new'), 'the New Annotation button');
		await page.keyboard.press('Enter');

		// And a line finished with Shift+Enter, which is the keyboard's double-click.
		await tabTo(page, page.getByTestId('annotation-tool-line'), 'the line tool');
		await page.keyboard.press('Enter');
		const canvas = page.locator('canvas.maplibregl-canvas');
		await canvas.focus();
		await page.keyboard.press('Enter');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.press('Enter');
		await page.keyboard.press('Shift+Enter');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		expect(stored.features[1]?.geometry?.type).toBe('LineString');

		// Every control in the Inspector is reachable too — including the one that now stands between the
		// keyboard and the text: the *Edit text* button that turns it into fields. It is native, which is
		// why it needed no key handler of its own (ADR-0016); this is what asserts that.
		await chooseTool(page, 'select');
		// **Opened as text first, which is how the Inspector opens for every Annotation but a freshly
		// drawn one.** The line just finished arrives with its title as a field and the keyboard in it, so
		// the selection is cleared and made again — the ordinary read gesture, where *Edit text* is what
		// stands between the words and the fields.
		await page.getByTestId('annotation-row').nth(1).click();
		await expect(inspector(page)).toHaveCount(0);
		await selectAnnotation(page, 1);
		await tabTo(page, page.getByTestId('annotation-edit-text'), 'the Edit text button');
		await page.keyboard.press('Enter');
		for (const control of ['annotation-title', 'annotation-description']) {
			await tabTo(page, page.getByTestId(control), control);
		}
		await page.getByTestId('annotation-text-done').click();

		// Delete is on the Text face, beside the words it destroys, and it is reached by Tab like the rest.
		await tabTo(page, page.getByTestId('annotation-delete'), 'annotation-delete');

		// **And the Style face is reached from the keyboard as well, with a strip in front of the
		// controls.** The tab strip is a radio group, so it is one tab stop that lands on the checked
		// member and arrow keys move along it — nothing was written to make that work, which is what
		// "every control is a native element" buys.
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

		// A radio group is one tab stop and it lands on the checked member, which is why this asks for the
		// checked swatch rather than for the row: the row itself is a `<div>` and never takes focus.
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
		// The measured properties are reached by Tab and nothing else, now that no disclosure stands in
		// front of them — and in the order the Line group draws them, which is the order they are read in.
		for (const control of ['annotation-stroke-width', 'annotation-stroke-opacity']) {
			await tabTo(page, page.getByTestId(control), control);
		}
		expect(failures).toEqual([]);
	});
});

/**
 * Press Tab until `target` has focus, so "operable by keyboard" is asserted by *getting there* with
 * the keyboard rather than by calling `focus()` and pretending.
 */
async function tabTo(page: Page, target: Locator, what: string, resetFocus = true) {
	// Without the body reset, a target earlier in the document relies on Tab wrapping past its end.
	if (resetFocus) await page.locator('body').click({ position: { x: 2, y: 2 } });
	for (let press = 0; press < 250; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE OPEN LAYER IS THE LAYER BEING DRAWN INTO
//
// There used to be two values — which Layer the sidebar was showing, and which one the "Drawing into"
// picker had selected — and nothing stopped them disagreeing. They are one now, so opening a Layer is
// what chooses it, and the tools are inside the Layer they draw into rather than in a panel beneath
// the stack. What follows is that identity asserted from both ends.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe('drawing into the Layer that is open', () => {
	/** One Layer's row, by its id, because adding a Layer puts it on top and moves the others down. */
	const rowFor = (page: Page, layerId: string) =>
		page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`);

	/**
	 * A Project with no Annotation Layer says what to do about it, and stops saying it once done.
	 *
	 * **Guidance, not an announcement, and the difference is why this test exists.** This was once said
	 * twice: `AnnotationPanel` had a "No Annotation Layers yet" branch, and the toolbar beneath it
	 * announced "Add an Annotation Layer to start drawing." from a `disabled` state. Putting
	 * the toolbar inside an open Layer's row makes the disabled state unreachable — there is no render
	 * path to it that is not already inside an Annotation Layer — so *that* sentence went with the
	 * state it described, which is the only condition under which removing an announcement is not an
	 * accessibility regression.
	 *
	 * What could not go with it is the guidance, because the state it is about — a Project with Layers
	 * and no Annotation Layer — is as reachable as it ever was. It is beside the button that resolves
	 * it, and asserted as visible text rather than as a `title`.
	 */
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
		// It names the two steps the interface takes, the second of which is opening the Layer.
		await expect(guidance).toContainText('open it to draw');
		// And there are no drawing tools anywhere, which is the state it is explaining.
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);

		// It goes when it stops being true, rather than sitting under a Layer that exists.
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
		await expect(guidance).toHaveCount(0);
	});

	/**
	 * The drawing tools exist only inside an open Annotation Layer.
	 *
	 * The "Drawing into" picker is gone and this is the assertion that it did not simply move: with
	 * every row closed there is no way to draw and no Annotation list anywhere on the screen, because
	 * there is no Layer chosen to draw into.
	 */
	test('the tools and the Annotations are inside the Layer, and nowhere else', async ({ page }) => {
		const layerId = await startAnnotating(page);
		const failures = watchFailures(page);

		// `startAnnotating` leaves the Layer open, so the way to draw is there — one button, with the
		// shapes behind it, because selecting is the resting behaviour rather than a fourth tool.
		await expect(page.getByTestId('annotation-new')).toHaveCount(1);
		// And it is inside that Layer's own row rather than merely somewhere on the page.
		await expect(rowFor(page, layerId).getByTestId('annotation-new')).toHaveCount(1);
		await page.getByTestId('annotation-new').click();
		await expect(rowFor(page, layerId).getByTestId('annotation-tools')).toHaveCount(1);

		// Drawing into the open Layer works, and lands in that Layer's file.
		await drawPin(page, 0.4, 0.45);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
		await expect(rowFor(page, layerId).getByTestId('annotation-row')).toHaveCount(1);

		// Closed, none of it is on the screen — and the picker it replaced is not there either.
		await rowFor(page, layerId).getByTestId('layer-disclosure').click();
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		await expect(page.getByTestId('annotation-new')).toHaveCount(0);
		await expect(page.getByTestId('annotation-list')).toHaveCount(0);
		await expect(page.getByTestId('annotation-layer-choice')).toHaveCount(0);

		// The Annotation is still on the map: closing a Layer is not hiding it.
		const drawn = (await storedAnnotations(page, layerId)).features[0]!.id;
		const painted = await waitForPaintedAnnotations(page, [drawn]);
		expect(painted[drawn]?.length ?? 0).toBeGreaterThan(0);

		expect(failures).toEqual([]);
	});

	/**
	 * **With no Layer open, nothing is being drawn into, and a click on the map writes nowhere.**
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THIS IS THE DEFECT THE CONTRACT NAMES, AND IT IS REACHABLE BY THREE CLICKS
	 *
	 * `activeLayer` has no fallback to `annotationLayers[0]` when nothing is chosen, and nothing else
	 * in this suite can see that absence: the drawing tools, the Annotation list and the editor all
	 * render *inside* the open row, so restoring the fallback changes no markup and leaves every other
	 * test green.
	 *
	 * What it does change is the one path into the annotation writes that is live whether a row is
	 * open or not: `BaseMapPane`'s `onclickpoint`, which is mounted for the whole screen. Closing a
	 * Layer abandons a part-drawn shape but deliberately leaves the *tool* in hand — `cancel()` clears
	 * vertices and nothing else — so a scholar who picks the pin tool, closes the row, and then clicks
	 * the map reaches `placePoint` with no tools anywhere on screen. With the fallback that click
	 * writes an Annotation into whichever Layer happens to be topmost: a file they were not looking
	 * at, from a gesture the interface gave them no way to attribute. Without it `activeLayer` is
	 * `null`, `commitAnnotations` returns, and the click does nothing at all.
	 *
	 * Asserted on the **bytes and the write count**, not on the absence of a list row: a list that is
	 * not rendered proves nothing about a file, and the file is the user's work.
	 */
	test('with no Layer open, a click on the map writes into no Layer at all', async ({ page }) => {
		const layerId = await startAnnotating(page);
		const failures = watchFailures(page);

		// A second Layer, so "the topmost one" is a real and distinguishable answer for the fallback to
		// give. It goes on top, so it is the one a restored fallback would choose.
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const topmost = (await projectJson(page)).layers.find(
			(layer: { kind: string; id: string }) => layer.kind === 'annotation' && layer.id !== layerId
		).id as string;

		// The pin tool is taken while a row is open, because that is the only place it exists.
		await openLayerRow(page, rowFor(page, layerId));
		await chooseTool(page, 'point');
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-tool', 'point');

		// And the row is closed with it still in hand. No tools are on the screen now — which is the
		// whole of what the interface says about which Layer a click would go to.
		await watchAnnotationWrites(page);
		await rowFor(page, layerId).getByTestId('layer-disclosure').click();
		await expect(page.getByTestId('annotation-tools')).toHaveCount(0);
		await expect(page.getByTestId('layer-contents')).toHaveCount(0);

		await clickAt(baseMap(page), 0.45, 0.45);
		// Given long enough for a write to have been debounced and flushed if one had been queued
		// (ADR-0017 rule 2), so this is "nothing was written" rather than "nothing yet".
		await page.waitForTimeout(1500);

		expect(await annotationWrites(page), 'a click with no Layer open wrote an Annotation').toEqual(
			[]
		);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);
		expect((await storedAnnotations(page, topmost)).features).toHaveLength(0);

		// **The control.** The same click, with the same tool, into an open Layer does write — so the
		// assertions above are about the absent Layer and not about a click that never landed, a tool
		// that was never held, or a pane that was not listening.
		await openLayerRow(page, rowFor(page, layerId));
		await chooseTool(page, 'point');
		await clickAt(baseMap(page), 0.45, 0.45);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
		expect((await storedAnnotations(page, topmost)).features).toHaveLength(0);

		expect(failures).toEqual([]);
	});

	/**
	 * The rule `chooseLayer` has always carried, now reached by opening a row.
	 *
	 * A gesture in progress belongs to the Layer being left: carrying a half-drawn shape into another
	 * Layer would drop it into a file the user was not drawing in. Asserted on the *file* as well as on
	 * the toolbar's own state, because "the vertices are gone from the screen" and "nothing was
	 * written" are different claims and only the second one is about the user's work.
	 */
	test('opening a different Layer abandons a part-drawn shape and clears the selection', async ({
		page
	}) => {
		const routes = await startAnnotating(page);
		const failures = watchFailures(page);

		// Something already drawn and selected, so the cleared selection is a change rather than a
		// starting state.
		await drawPin(page, 0.35, 0.4);
		await selectAnnotation(page);
		await expect(inspector(page)).toBeVisible();

		// A second Layer to open. It goes on top, so `routes` moves down and stays open.
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const places = (await projectJson(page)).layers.find(
			(layer: { kind: string; id: string }) => layer.kind === 'annotation' && layer.id !== routes
		).id as string;

		// A shape half drawn: two vertices of a polygon, unfinished and unwritten.
		await watchAnnotationWrites(page);
		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.45, 0.45);
		await clickAt(baseMap(page), 0.6, 0.45);
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'true');

		await openLayerRow(page, rowFor(page, places));

		// The gesture is gone and the selection with it — and **the tool went down with the gesture**,
		// which is `AnnotationDrawing`'s rule: an abandoned gesture is over too, so the surface a Layer
		// away is at rest rather than armed with nothing being drawn. A tool carried across would be
		// pointing at a file the scholar was not drawing in.
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'false');
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-tool', 'select');
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		await expect(inspector(page)).toHaveCount(0);
		// And the Layer that was opened is empty, said in this app's own words.
		await expect(page.getByTestId('annotation-list-empty')).toBeVisible();

		// And nothing was written into either Layer: the abandoned polygon is not in the file it was
		// being drawn in, and it did not land in the one that was opened.
		expect(await annotationWrites(page)).toEqual([]);
		expect((await storedAnnotations(page, routes)).features).toHaveLength(1);
		expect((await storedAnnotations(page, places)).features).toHaveLength(0);

		expect(failures).toEqual([]);
	});

	/**
	 * The reason the two values had to become one.
	 *
	 * Clicking an Annotation on the Base Map already selected it; with the picker sitting elsewhere, a
	 * user could be shown the editor for something they could not find in the sidebar. Now the click
	 * *opens the Layer it lives in*, so the answer to "where is this?" is on the screen.
	 *
	 * The click is on a Layer that is **not** the open one, which is what makes it a claim about
	 * opening rather than about selecting.
	 */
	test('clicking an Annotation on the Base Map opens its Layer and selects it', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const routes = await startAnnotating(page);
		const failures = watchFailures(page);

		// One Annotation in the first Layer, titled so the editor is identifiable.
		await drawPin(page, 0.4, 0.45);
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Fort Amsterdam');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const pinId = (await storedAnnotations(page, routes)).features[0]!.id;

		// A second Layer, opened, so the first is closed and its Annotation is not the selected one.
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const places = (await projectJson(page)).layers.find(
			(layer: { kind: string; id: string }) => layer.kind === 'annotation' && layer.id !== routes
		).id as string;
		await openLayerRow(page, rowFor(page, places));
		await expect(rowFor(page, routes).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		await expect(inspector(page)).toHaveCount(0);

		// The pin is still painted, so the click below has something to hit.
		await waitForPaintedAnnotations(page, [pinId]);
		await chooseTool(page, 'select');
		await clickAt(baseMap(page), 0.4, 0.45);

		// Its Layer is open, the other is closed, and the Annotation is selected inside it.
		await expect(rowFor(page, routes).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect(rowFor(page, places).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		await expect(inspector(page)).toBeVisible();
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('Fort Amsterdam');
		await expect(rowFor(page, routes).getByTestId('annotation-row').first()).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		// And nothing was drawn over the map: the row is the destination, so a bubble over the pin
		// would be a second place to read one Annotation.
		await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

		expect(failures).toEqual([]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PLACING A PIN AT A PLACE (ADR-0029)
//
// The gesture place lookup exists for: look up an address, watch the Pin land in the middle of a
// river, and drag it onto the quay. **The lookup is the cheap step and the correction is the scholarship**,
// so nothing here treats the service's answer as authoritative and nothing records that it was
// consulted.
//
// Three of these are counted or compared rather than looked at, and each says at its site what it
// was mutated with:
//
//   - **exactly one store write per placement**, counted through `ballastellaAnnotationWrites`. The
//     obvious construction — add the Annotation, then set its title — is two commits and violates
//     ADR-0017 rule 1, and every assertion about the *file* passes against it.
//   - **byte-identical to a hand-drawn Pin** with the same title, compared as text rather than as a
//     parsed object, so a provenance property, a reordered `properties` bag, or a different style
//     would all fail it.
//   - **the search surface is the one slice 1 built**, asserted by driving the shared component's own
//     wording and attribution through this surface.
//
// The lookup is routed to the committed fixture in every one of them; nothing here reaches a network.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe('placing a Pin at a Place', () => {
	/** The fixture's Springfield, Massachusetts — its point, which is what a Pin is placed at. */
	const HAMPDEN = { lng: -72.5886727, lat: 42.1018764 };
	/** The box the same candidate carries, which frames the camera and never reaches the file. */
	const HAMPDEN_BOX = { west: -72.6221576, south: 42.0637364, east: -72.471087, north: 42.1622195 };
	/** Part of its display name, which must reach the candidate list and never the file. */
	const HAMPDEN_NAME = 'Hampden County';

	/** The search that places a Pin: the one inside the open Annotation Layer, not the pane's. */
	const pinSearch = (page: Page): Locator => page.getByTestId('annotation-place-search');

	/**
	 * Look a place up from the Annotation Layer's own search and take one of the candidates.
	 *
	 * ⚠ **Scoped to that surface throughout.** Two of these searches are on the Project screen at once
	 * — the pane's, which only moves the camera, and this one — so an unscoped `getByTestId` would be
	 * ambiguous, and a test that reached the pane's by accident would assert that placing a Pin places
	 * no Pin.
	 *
	 * ⚠ **Waited out on the file, not on the save indicator.** By the time a Layer is open the
	 * indicator already reads `Saved`, so a `toHaveText('Saved locally')` here is satisfied by the write
	 * *before* this one (`support/saved.ts` says so in as many words) and every caller would then read
	 * the file too early. The Pin's title in that Layer's document is the placement itself arriving.
	 */
	async function placeFrom(
		page: Page,
		query: string,
		candidate: string,
		layerId: string
	): Promise<void> {
		const surface = pinSearch(page);
		await surface.getByTestId('place-search-query').fill(query);
		await surface.getByTestId('place-search-query').press('Enter');
		await surface.getByTestId('place-candidate').filter({ hasText: candidate }).click();
		await expect.poll(() => layerText(page, layerId)).toContain(`"title": "${query}"`);
	}

	/**
	 * A Layer's document as text, or `''` while it has none.
	 *
	 * A Layer added a moment ago has no `.geojson` at all until something is written into it, and an
	 * absent file is what {@link placeFrom} is waiting out rather than a failure — `readProjectFile`
	 * throws for a caller whose next line would fail anyway, which is not this one.
	 */
	async function layerText(page: Page, layerId: string): Promise<string> {
		try {
			return await readProjectFile(page, `annotations/${layerId}.geojson`);
		} catch {
			return '';
		}
	}

	/** Whether the camera is still moving, so a handle's position is not yet a place to click. */
	const stillMoving = (page: Page) =>
		page.evaluate(
			() => (window as unknown as StackWindow).ballastellaLayerStack?.map.isMoving() ?? false
		);

	/** Where the Base Map is looking now. */
	const centre = (page: Page) =>
		page.evaluate(() => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
			return map ? map.getCenter() : { lng: 0, lat: 0 };
		});

	test('drops a Pin at the candidate’s point, frames the map on it, and selects it', async ({
		page
	}) => {
		const failures = watchFailures(page);
		await routePlaceLookup(page);
		const layerId = await startAnnotating(page);

		// Amsterdam, where `startAnnotating` leaves the map — so the move is unmistakable, and a Pin
		// that landed off screen would be visible as one.
		expect((await centre(page)).lng).toBeCloseTo(4.9, 1);

		await placeFrom(page, AMBIGUOUS_QUERY, HAMPDEN_NAME, layerId);

		// **A `Point`, asserted on geometry type and coordinates.** A bounding box reaching the file —
		// as a Polygon, or as a `bbox` beside the geometry — fails this: the box is the axis-aligned
		// rectangle around a place and not its shape, and a rectangle labelled *Paris* takes in
		// Boulogne (ADR-0029).
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(1);
		expect(stored.features[0]?.geometry?.type).toBe('Point');
		expect(stored.features[0]?.geometry?.coordinates).toEqual([HAMPDEN.lng, HAMPDEN.lat]);

		// **Placing always frames.** A scholar looking at Amsterdam who picks a Boston address must not
		// get a Pin off screen — invisible, unverifiable, and uncorrectable, when correcting it is the
		// entire point of the feature.
		await expect
			.poll(async () => (await centre(page)).lat, { timeout: 15_000 })
			.toBeCloseTo(HAMPDEN.lat, 1);
		expect((await centre(page)).lng).toBeCloseTo(HAMPDEN.lng, 1);

		// ⚠ **Framed on the candidate's box, not centred on its point.** The centre alone cannot tell
		// those apart — for this candidate they are 0.011° apart, well inside any tolerance a moving
		// camera allows — so a `setCenter(place.point)` at whatever zoom the map already had would
		// satisfy everything above. ADR-0029 is explicit that framing goes through the opening-view fit
		// with its padding and maximum zoom, and that **no zoom heuristic exists anywhere in the
		// feature**: a city fills the pane and a house address frames tight.
		//
		// Asserted where a scholar sees it — the box projected into the pane — rather than against a
		// zoom number, which would be this test computing the fit for itself.
		//
		// **Mutation:** replace `frameOnPlace(place)` in `ProjectScreen.placeAtPlace` with a
		// `setCenter(place.point)`. Everything above stays green; both halves of this go red.
		await expect.poll(() => stillMoving(page)).toBe(false);
		const pane = await baseMap(page).boundingBox();
		if (!pane) throw new Error('the pane has no box');
		const corners = await page.evaluate((box) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
			const at = (lngLat: [number, number]) => map?.project(lngLat) ?? { x: -1, y: -1 };
			return { southWest: at([box.west, box.south]), northEast: at([box.east, box.north]) };
		}, HAMPDEN_BOX);
		// The whole box is on screen, which is what the fit's padding guarantees.
		for (const corner of [corners.southWest, corners.northEast]) {
			expect(corner.x).toBeGreaterThan(0);
			expect(corner.x).toBeLessThan(pane.width);
			expect(corner.y).toBeGreaterThan(0);
			expect(corner.y).toBeLessThan(pane.height);
		}
		// And it fills the pane along one axis, which is what makes it a fit rather than a jump: at the
		// zoom a Project opens on, this box would be a smudge a few pixels across.
		const across = Math.abs(corners.northEast.x - corners.southWest.x) / pane.width;
		const down = Math.abs(corners.northEast.y - corners.southWest.y) / pane.height;
		expect(Math.max(across, down)).toBeGreaterThan(0.5);

		// **Selected on placement**, exactly as a drawn one is, so retitling it does not begin with
		// hunting for it. Asserted on the editor and on the row's own expanded state rather than on a
		// highlight.
		await expect(inspector(page)).toBeVisible();
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		// And its vertex handle is on the map, which is the affordance the correction is made with.
		await expect(page.getByTestId('pane-overlay-point-annotation-vertex')).toHaveCount(1);

		expect(failures).toEqual([]);
	});

	test('titles it with what the scholar typed, and records nothing about the lookup', async ({
		page
	}) => {
		await routePlaceLookup(page);
		const layerId = await startAnnotating(page);

		await placeFrom(page, AMBIGUOUS_QUERY, HAMPDEN_NAME, layerId);

		// ⚠ **Asserted against the written bytes rather than against the field.** The title is what a
		// scholar publishes, and a field that shows the query while the file holds the service's postal
		// address is exactly the failure this criterion is about.
		const written = await readProjectFile(page, `annotations/${layerId}.geojson`);
		const stored = JSON.parse(written) as { features: { properties: Record<string, unknown> }[] };
		expect(stored.features[0]?.properties?.['title']).toBe(AMBIGUOUS_QUERY);

		// **Not the service's display name**, which for this candidate is
		// `Springfield, Hampden County, Massachusetts, United States` — a pre-fill people delete every
		// time is worse than an empty field, because now they must notice it.
		expect(written).not.toContain(HAMPDEN_NAME);

		// **No property naming a service, a query, a status, or an origin** (ADR-0029). Asserted as
		// "every property is one simplestyle defines" rather than as a list of names not to use: a
		// provenance stamp nobody thought of is still caught.
		expect(
			Object.keys(stored.features[0]?.properties ?? {}).filter((key) => !SIMPLESTYLE_NAMES.has(key))
		).toEqual([]);
		// And nothing of the box, the response, or the search survives anywhere in the document.
		expect(written).not.toMatch(/boundingbox|bbox|place_id|osm_|licence|nominatim/i);
	});

	test('produces a Pin byte-identical to one drawn by hand and given the same title', async ({
		page
	}) => {
		// ⚠ **The central claim, and it is directly checkable.** Both Pins are produced through
		// the interface and the two written files are compared **as text**, so a provenance property, a
		// `properties` bag in a different order, or a style that did not inherit the same way all fail
		// this — none of which a parsed `toMatchObject` would see.
		//
		// **Mutation:** give the placed Pin any extra property at all (`newAnnotation` with a
		// `ballastella:source`), or build it outside `#addDrawn` so it takes no inherited style. Either
		// leaves every other test in this block green and turns this one red.
		const service = await routePlaceLookup(page);
		const drawnLayer = await startAnnotating(page);

		// The hand-drawn half: an ordinary pin, titled through the editor exactly as a scholar would.
		await drawPin(page, 0.45, 0.45);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill(AMBIGUOUS_QUERY);
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const drawn = await storedAnnotations(page, drawnLayer);
		const at = drawn.features[0]?.geometry?.coordinates as [number, number];
		expect(at).toHaveLength(2);

		// ⚠ **The service is made to answer at the drawn Pin's own coordinates**, which is what lets
		// two files be compared byte for byte at all — see `candidateAt` in `support/places.ts`. It is
		// still the committed capture, moved.
		service.answerWith(await candidateAt({ lng: at[0], lat: at[1] }));

		// A second Annotation Layer, so the placed Pin is the only thing in its file and the two
		// documents are comparable whole.
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		// ⚠ **The new Layer is the one on top.** `addLayer` puts it at the head of the stack, so it is
		// the *first* Annotation Layer in `project.json` and not the last — read as the second one, this
		// test compared the hand-drawn file with itself and was green against every mutation. The index-1
		// read is the wait for the second Layer to have reached the file, which is written atomically.
		await annotationLayerId(page, 1);
		const placedLayer = await annotationLayerId(page, 0);
		expect(placedLayer).not.toBe(drawnLayer);
		await openLayerRow(
			page,
			page.locator(`[data-testid="layer-row"][data-layer-id="${placedLayer}"]`)
		);

		await placeFrom(page, AMBIGUOUS_QUERY, 'Springfield', placedLayer);

		const drawnText = await readProjectFile(page, `annotations/${drawnLayer}.geojson`);
		const placedText = await readProjectFile(page, `annotations/${placedLayer}.geojson`);

		// The one difference that cannot be removed is the identifier, which is a fresh UUID per
		// Annotation and is fresh for a hand-drawn one too. Everything else — every byte — is compared.
		const idOf = (text: string) =>
			(JSON.parse(text) as { features: { id: string }[] }).features[0]!.id;
		expect(placedText.split(idOf(placedText)).join('<id>')) //
			.toBe(drawnText.split(idOf(drawnText)).join('<id>'));
		// Not vacuous: the comparison above is of a document that really holds the Pin and its title.
		expect(placedText).toContain(`"title": "${AMBIGUOUS_QUERY}"`);
		expect(placedText).toContain('"Point"');
	});

	test('costs exactly one store write, which is what makes it one gesture', async ({ page }) => {
		// ⚠ **Counted, not inferred from the file.** The obvious construction — add the Annotation, then
		// set its title — leaves exactly the same bytes on disk and is two commits, which ADR-0017
		// rule 1 forbids and this repository asserts by counting.
		//
		// **Mutation:** in `AnnotationEditing.placePin`, follow `#addDrawn` with
		// `commitAnnotations(setText(…))`. Every other assertion in this block stays green; this one
		// goes to 2.
		//
		// ⚠ **A second split does not move the count at all, so the count is not what catches it.**
		// `typeText` is rule 2's *coalesced* path and `recordAnnotationWrite` deliberately records
		// nothing for a debounced write, so `#addDrawn` followed by `typeText({ title })` leaves the
		// count at 1 forever — and the only witness is that the write that *was* counted went out
		// **untitled**, 400 ms before the title did. That is caught here by comparing the counted
		// write's own size against the document the title finally arrived in: one gesture means the
		// write that was counted is the document that was kept.
		//
		// **Mutation:** `#addDrawn(…)` then `await this.typeText({ title })`. The count stays at 1 and
		// the sizes differ by the length of the `title` property.
		//
		// No clock is involved in either direction: the title is *waited for* in the file rather than
		// read at a moment, so a split has landed its second write before the comparison is made.
		await routePlaceLookup(page);
		const layerId = await startAnnotating(page);
		await watchAnnotationWrites(page);

		const surface = pinSearch(page);
		await surface.getByTestId('place-search-query').fill(AMBIGUOUS_QUERY);
		await surface.getByTestId('place-search-query').press('Enter');
		await surface.getByTestId('place-candidate').filter({ hasText: HAMPDEN_NAME }).click();

		await expect.poll(() => layerText(page, layerId)).toContain(`"title": "${AMBIGUOUS_QUERY}"`);
		const writes = await annotationWrites(page);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.bytes).toBe(new TextEncoder().encode(await layerText(page, layerId)).length);

		// And still one once everything has settled: nothing was queued behind it.
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await page.waitForTimeout(1_000);
		expect(await annotationWrites(page)).toHaveLength(1);
	});

	test('takes the style the last Annotation was drawn with, as a drawn one would', async ({
		page
	}) => {
		// Lookup and drawing must not produce visibly different objects. Asserted by making the
		// difference visible first — a colour nobody would get by accident — and then placing.
		await routePlaceLookup(page);
		const layerId = await startAnnotating(page);

		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		const blue = await chooseColour(page, 'annotation-marker-color', 'blue');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		await placeFrom(page, AMBIGUOUS_QUERY, HAMPDEN_NAME, layerId);

		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		expect(stored.features[1]?.properties?.['marker-color']).toBe(blue);
	});

	test('uses the search surface slice 1 built, not a copy of it', async ({ page }) => {
		// ⚠ **Asserted by driving the shared component's own behaviour through this surface**: the
		// candidate list, the attribution that appears only while candidates are shown, and the outcome
		// sentence — which is composed in `@ballastella/core` and is the same one the Base Map pane
		// shows.
		//
		// **Mutation:** change any wording in `PlaceSearch.svelte` or in `placeLookupNotice`, and both
		// this and `editor-base-map.e2e.ts`'s "says all four things" go red together. A forked copy
		// would move only one of them.
		await routePlaceLookup(page);
		const layerId = await startAnnotating(page);
		const surface = pinSearch(page);

		// The same field, the same button, the same list, inside the open Annotation Layer. **Its own
		// name**, because two searches on one screen may not both be called "Find a place" when only
		// one of them writes to the scholar's file — the words are the caller's and everything else is
		// the component's.
		await expect(surface.getByRole('button', { name: 'Find a place and pin it' })).toBeVisible();
		await expect(surface.getByTestId('place-attribution')).toHaveCount(0);

		await surface.getByTestId('place-search-query').fill(AMBIGUOUS_QUERY);
		await surface.getByTestId('place-search-query').press('Enter');

		await expect(surface.getByTestId('place-candidate')).toHaveCount(10);
		await expect(surface.getByTestId('place-search-status')).toContainText('10 places match');
		// Whose data it is, on screen exactly while that data is — and gone once the Pin is placed,
		// because nothing on screen is then OSM's (ADR-0029).
		await expect(surface.getByTestId('place-attribution')).toContainText('OpenStreetMap');

		await surface.getByTestId('place-candidate').filter({ hasText: HAMPDEN_NAME }).click();
		await expect.poll(() => layerText(page, layerId)).toContain(`"title": "${AMBIGUOUS_QUERY}"`);

		// Put away once the Pin is placed, so it holds no row of a two-pane sidebar open through the
		// gestures that follow.
		await expect(surface.getByTestId('place-candidate')).toHaveCount(0);
		await expect(surface.getByTestId('place-attribution')).toHaveCount(0);
		await expect(surface.getByTestId('place-search-status')).toHaveText('');

		// And the pane's own search is still there, still navigation-only — it dropped nothing — and
		// still called what it does, which is the other half of two searches on one screen.
		const paneSearch = page.getByTestId('base-map-place-search');
		await expect(paneSearch.getByTestId('place-search-query')).toBeVisible();
		await expect(paneSearch.getByRole('button', { name: 'Find a place', exact: true })) //
			.toBeVisible();
	});
});

test.describe('a Label author journey uses only the keyboard', () => {
	/**
	 * Only a browser can prove that focus traverses the authored surfaces from the tool through styling
	 * and deletion without a pointer, including MapLibre's keyboard-operated Base Map.
	 */
	test('reaches Label, places it, writes and styles it, then deletes it without a pointer', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);

		await tabTo(page, page.getByTestId('annotation-new'), 'New Annotation', false);
		await page.keyboard.press('Enter');
		await tabTo(page, page.getByTestId('annotation-tool-text'), 'Label', false);
		await page.keyboard.press('Enter');

		await tabTo(page, page.locator('canvas.maplibregl-canvas'), 'the Base Map', false);
		await page.keyboard.press('Enter');
		await expect(page.getByTestId('annotation-title')).toBeFocused();
		await page.keyboard.type('Zuiderzee');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		await tabTo(
			page,
			page.getByTestId('annotation-inspector-tab-text').locator('input'),
			'the Text tab',
			false
		);
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-inspector-face')).toHaveAttribute(
			'data-face',
			'style'
		);

		await tabTo(
			page,
			page.getByTestId('annotation-marker-color').locator('input:checked'),
			'the Label text colour',
			false
		);
		await page.keyboard.press('ArrowRight');
		await expect(page.getByTestId('annotation-marker-color-grey')).toHaveAttribute(
			'data-chosen',
			'true'
		);

		await tabTo(
			page,
			page.getByTestId('annotation-marker-size-medium').locator('input'),
			'the Label size',
			false
		);
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

		await tabTo(
			page,
			page.getByTestId('annotation-inspector-tab-style').locator('input:checked'),
			'the Style tab',
			false
		);
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByTestId('annotation-inspector-face')).toHaveAttribute(
			'data-face',
			'text'
		);
		await tabTo(page, page.getByTestId('annotation-delete'), 'Delete Annotation', false);
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await storedAnnotations(page, layerId)).features.length).toBe(0);
		await expect(page.getByTestId('annotation-row')).toHaveCount(0);
		await expect
			.poll(() =>
				page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? 'BODY')
			)
			.toBe('annotation-new');
		expect(failures).toEqual([]);
	});
});

test.describe('reordering an Annotation, and moving one between Layers', () => {
	// ⚠ **Seam 2 or nowhere, and that was measured rather than assumed.** happy-dom's `DragEvent` is
	// not a `MouseEvent` and its constructor drops `dataTransfer` entirely — which is the member every
	// claim here turns on, since what tells an Annotation being dragged from a Layer being dragged is
	// the *format* the drag carries (`packages/ui/src/annotation-drag.ts`). A dispatched plain `Event`
	// at Seam 1c can prove a row highlights; it cannot prove a drop moved the right thing into the
	// right file, because the fake gets wrong exactly the member the decision reads.
	//
	// The arithmetic underneath is asserted where it costs nothing: `moveAnnotation`'s ordering and
	// clamping in `packages/core/src/annotation/annotation.test.ts`, and the two-file write order,
	// the hidden-Layer read and the refusal in
	// `apps/editor/src/lib/annotations/annotation-editing.svelte.test.ts`. **One browser test**, for
	// the two gestures that only exist in a browser.
	test('drags a row onto another row, and onto another Layer’s card', async ({ page }) => {
		const failures = watchFailures(page);
		const first = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawPin(page, 0.5, 0.3);
		await drawPin(page, 0.7, 0.3);
		await chooseTool(page, 'select');
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);

		const ids = (await storedAnnotations(page, first)).features.map((one) => one.id);

		// ── THE REORDER, FROM THE HANDLE ────────────────────────────────────────────────────
		//
		// The handle is the drag *source* and the row is only the drop target: a pointer drag beginning
		// anywhere inside a `draggable` element is claimed by the drag machinery rather than by the
		// button under the cursor, which is why the whole row is not `draggable`.
		const rows = page.getByTestId('annotation-row-item');
		await rows.nth(2).getByTestId('annotation-drag-handle').dragTo(rows.nth(0));

		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect((await storedAnnotations(page, first)).features.map((one) => one.id)).toEqual([
			ids[2],
			ids[0],
			ids[1]
		]);
		// The ordinals are the collection's positions, so the list renumbers itself and nothing writes
		// them (ADR-0002).
		expect(await page.getByTestId('annotation-row-ordinal').allTextContents()).toEqual([
			'1',
			'2',
			'3'
		]);

		// ── AND THE MOVE INTO ANOTHER LAYER, ONTO ITS CARD ──────────────────────────────────
		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(2);
		// **The one that is not the Layer already open**, rather than a position in `project.json`: a new
		// Layer goes to the top of the stack, so an index here would name whichever end this build
		// happens to add at.
		const second =
			(await annotationLayerId(page, 0)) === first
				? await annotationLayerId(page, 1)
				: await annotationLayerId(page, 0);

		// The card the row is dropped on is a *collapsed* one, which is the whole gesture: the only open
		// Annotation Layer is the one the row is already in.
		const target = page.locator(`[data-testid="layer-row"][data-layer-id="${second}"]`);
		await rows.nth(0).getByTestId('annotation-drag-handle').dragTo(target);

		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await expect
			.poll(async () => (await storedAnnotations(page, second)).features.map((one) => one.id))
			.toEqual([ids[2]]);
		expect((await storedAnnotations(page, first)).features.map((one) => one.id)).toEqual([
			ids[0],
			ids[1]
		]);

		// The sidebar followed the Annotation: the Layer it went into is open, with it selected, so the
		// scholar watches where their work went rather than being told.
		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('annotation-moved')).toContainText('moved to');

		expect(failures).toEqual([]);
	});
});
