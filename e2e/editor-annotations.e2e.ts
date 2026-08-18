// SPEC's Seam 2 for Annotations: drawing, editing, styling, and rendering Markdown in the running app
// (stories 55–67).
//
// Two things about the shape of this file.
//
// **Every claim about styling is asserted on what MapLibre reports it drew**, never on the app's own
// state. `queryRenderedFeatures` names the layer that painted each Annotation, and
// `getPaintProperty` is the dash pattern that layer actually carries — which is the mechanism by which
// a dashed line looks different from a solid one. Ticket 08 lost a whole slice's worth of assertions to
// exactly this: its distortion values were computed in a different object from the one that painted,
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
import { makePairs, start as startAlignment } from './support/alignment-workspace.js';
import { restoreWorkspace, snapshotWorkspace } from './support/workspace-snapshot.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

import {
	ANNOTATION_COLOR,
	annotationLayerId,
	annotationWrites,
	baseMap,
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
	PROJECT_NAME,
	readProjectFile,
	reopenLayers,
	selectAnnotation,
	paintProperty,
	projectJson,
	seedAnnotationProject,
	waitForPaintedAnnotations,
	waitForStack,
	startAnnotating,
	storedAnnotations,
	watchAnnotationWrites,
	writeProjectFile,
	type StackWindow
} from './support/annotations';

/**
 * Anything the page threw, and any native dialog it opened.
 *
 * Installed on every test that renders. Ticket 08's `rgb()`-into-a-hex-parser bug threw once per frame
 * inside the draw path and was caught only by an unrelated test's `pageerror` watch, while every
 * assertion about the values passed. It doubles as an XSS probe: `alert(1)` in a payload is a dialog.
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

test.describe('drawing (SPEC stories 57, 58, 59)', () => {
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
		// AND EACH IS NUMBERED IN THE SIDEBAR (stories 37, 38, 42)
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

		// ── AND THE LEADER JOINS THE SHAPE TO ITS ROW (ticket 12, stories 39–42) ─────────────
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
		// Story 42: `aria-expanded` on the row is what says which Annotation is active, so this layer
		// must add nothing to either the accessibility tree or the tab order.
		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');
		expect(
			await leaderLayer(page).evaluate(
				(svg) => svg.querySelectorAll('a, button, input, [tabindex]').length
			)
		).toBe(0);
		expect(await leaderLayer(page).evaluate((svg) => getComputedStyle(svg).pointerEvents)).toBe(
			'none'
		);

		// ── AND IT IS NOT DRAWN TO SOMEWHERE THE MARK IS NOT (story 41) ─────────────────────
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
		// The other end's half of story 41: the column is scrolled until the selected row is outside it,
		// which is the moment the line would start pointing at a row that is not on the screen.
		//
		// ⚠ **The window is shortened to make that possible, and the shortening is not the assertion.**
		// An Annotation's content is read over the map now (ADR-0035), so this column is a stack of rows
		// and nothing else — at 720 px it does not overflow at all, and a scroll that cannot take the row
		// out of the column asserts nothing. **Both halves are measured at the same size**, so the only
		// thing that differs between "no line" and "a line" is where the row is: a shorter window also
		// shortens the canvas, and a mark that had left the pane would make the first half pass for the
		// wrong reason.
		await page.setViewportSize({ width: 1280, height: 320 });
		const column = page.getByTestId('layer-sidebar');
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
		// row* rather than to the bottom of the column — there is a button below the stack, so the far
		// end of the scroll takes the row off the top instead of bringing it back.
		await column.evaluate((element) => {
			const rows = [...element.querySelectorAll('[data-testid="annotation-row-item"]')];
			rows[rows.length - 1]!.scrollIntoView({ block: 'center' });
		});
		expect(await rowOutsideColumn()).toBe(false);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		await page.setViewportSize({ width: 1280, height: 720 });
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');

		// ── AND THE MAP DRAWS THE SELECTED ANNOTATION MORE STRONGLY (story 40) ───────────────
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
		// The-annotation-inspector story 22, and the measurement `layout.css` records, repeated on the two
		// things the line may never be drawn across. `.maplibregl-map` opens no stacking context, so the
		// leader's 5, MapLibre's control corners at 6 and the Inspector's 7 are all compared in the one
		// container they are painted in — three numbers in two files, with nothing but a test to say they are
		// still in that order.
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
		// **The ordering is the subject** (ticket 07). With no popup on this screen, Escape has two
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
		await expect(page.getByTestId('annotation-status')).toContainText('1 point placed');
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
		// **And the tool went with it** (the-annotation-inspector stories 38, 41): an abandoned gesture is
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
	 * **It is also where "finishing returns everything to rest" is asserted**
	 * (the-annotation-inspector stories 37, 38, 39, 40). The tool disarming itself is
	 * `AnnotationDrawing`'s and is asserted directly in `drawing.svelte.test.ts`; what needs a browser
	 * is the whole surface answering to it at once — the resting button back, the shapes gone, the
	 * keyboard in the new Annotation's title, and the next click on the canvas selecting rather than
	 * drawing. None of those five is visible to the node seam or to the component seam.
	 */
	test('a shape drawn on the map arrives selected, at rest, with its title ready to type', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);

		// **Back to rest, with nothing put away by hand.** One press of "New Annotation" made one
		// Annotation: the resting button is showing, the three shapes are not, and the tool is down.
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
		// **And the row opened nothing inside itself** (ADR-0035, the-annotation-inspector story 10): the
		// row is a selector, the Annotation's content is read in the Inspector, and the list stays the
		// same length however much any one Annotation has to say. Asserted as the `<li>`'s children
		// rather than as the absence of a `data-testid`, because a renamed id is exactly how an absence
		// assertion goes quietly green — there is nothing left in the row that could carry one.
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

		// And it marks the row without repainting what is written on it: `menu-active` swapped the text to
		// `base-100` because it had to, having made the row near-black.
		const inkOf = (target: typeof marked) =>
			target.evaluate((element) => getComputedStyle(element).color);
		const namesOf = (target: typeof marked) => target.getByTestId('annotation-row-name');
		expect(await inkOf(namesOf(marked))).toBe(await inkOf(namesOf(plain)));

		// **The spine, and it is the Annotation Layer's own ink rather than a colour named here.** Read by
		// comparing it with the ordinal on the same row, which is set in `--layer-kind-ink-annotation` from
		// the one table (`layer-kind-style.ts`): a spine repainted in the app's action colour is what this
		// catches, and it catches it without this file holding a second copy of what the ink is.
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
		await expect(status).toContainText('to start a shape');
		await clickAt(baseMap(page), 0.4, 0.4);
		await expect(status).toContainText('1 point placed');
		await expect(status).toContainText('2 more');
		await clickAt(baseMap(page), 0.6, 0.4);
		await clickAt(baseMap(page), 0.5, 0.6);
		await expect(status).toContainText('3 points placed');
		await expect(status).toContainText('Finish');

		await page.getByTestId('annotation-finish').click();

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
		await drawPin(page, 0.4, 0.4);
		// Selecting the pin is what puts its vertex handle on the map.
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		const handle = page.getByTestId('pane-overlay-point-annotation-vertex');
		await expect(handle).toHaveCount(1);

		const before = await storedAnnotations(page, layerId);
		await watchAnnotationWrites(page);

		const box = await handle.boundingBox();
		if (!box) throw new Error('the vertex handle has no box');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		// Several moves, so a per-pointer-move implementation would record several writes. This is the
		// distinction the count exists to make: "did it save" cannot see it.
		for (const dx of [10, 20, 30, 40, 50]) {
			await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dx);
		}
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

test.describe('title and description (SPEC stories 62 and 67)', () => {
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
		// Inspector's header, which is the one place the panel names its Annotation
		// (the-annotation-inspector story 4), and it appears there exactly once.
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
		// Counted rather than looked at, through the stack's own build counter — the same one ticket
		// 09 used to assert that dragging opacity is not a rebuild.
		await withOnePin(page);
		const builds = () =>
			page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack?.builds ?? -1);
		const before = await builds();
		expect(before).toBeGreaterThan(0);

		// ── AND SELECTING ONE COSTS THE STORE NOTHING AT ALL (ticket 12) ────────────────────
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
		// ⚠ **And it costs no camera move either** (the-annotation-inspector story 19, the restraint half).
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

	test('the description reads as rendered Markdown, not as source', async ({ page }) => {
		// ADR-0009 chose Markdown, and a scholar who has never written any has to be able to see what
		// they wrote. The live preview used to be where that happened; now the **resting state** of the
		// panel is the rendered description, which is why the preview went rather than the rendering.
		await withOnePin(page);
		const description = page.getByTestId('annotation-description-text');

		await editAnnotationText(page);
		await page.getByTestId('annotation-description').fill('A *conjectural* route');
		await page.getByTestId('annotation-text-done').click();
		await expect(description.locator('em')).toHaveText('conjectural');

		await editAnnotationText(page);
		await page
			.getByTestId('annotation-description')
			.fill('See [the survey](https://example.org/s).');
		await page.getByTestId('annotation-text-done').click();
		await expect(description.locator('a')).toHaveText('the survey');
		await expect(description.locator('a')).toHaveAttribute('href', 'https://example.org/s');

		await editAnnotationText(page);
		await page.getByTestId('annotation-description').fill('**Certainly** the west quay');
		await page.getByTestId('annotation-text-done').click();
		await expect(description.locator('strong')).toHaveText('Certainly');

		// ── AND A LONG ONE SCROLLS INSIDE THE PANEL ─────────────────────────────────────────
		//
		// Folded in here rather than given a test of its own because this is already the suite's Project for
		// what the description does on the screen, and the Seam 2 budget (`scripts/check-seam-2-size.mjs`)
		// is spent. It cannot be asserted anywhere cheaper: Seam 1c has no layout at all — no scroll
		// geometry, no `offsetHeight`, no attribution — so a panel growing past the licence it may not cover
		// is Seam 2 or nothing (the-annotation-inspector story 73).
		//
		// **The attribution is the boundary and it is a licence condition** (ODbL), not decoration
		// (the-annotation-inspector stories 9, 21): the panel is capped so that the words underneath it stay
		// uncovered, and a description longer than the cap scrolls inside the panel's own body rather than
		// making the panel taller.
		await editAnnotationText(page);
		await page
			.getByTestId('annotation-description')
			.fill(
				Array.from(
					{ length: 20 },
					(_, at) => `Paragraph ${at + 1}: the quay, the warehouses, and the survey of 1625.`
				).join('\n\n')
			);
		await page.getByTestId('annotation-text-done').click();
		await expect(description).toContainText('Paragraph 20');

		const attribution = page.locator('.maplibregl-ctrl-attrib');
		await expect(attribution).toBeVisible();
		const panel = (await inspector(page).boundingBox())!;
		const licence = (await attribution.boundingBox())!;
		expect(
			panel.y + panel.height,
			'the Inspector grew over the Base Map’s attribution'
		).toBeLessThan(licence.y);

		// **The body scrolls, and the header does not go with it.** Both halves are the claim: a panel that
		// scrolled as a whole would take the ordinal and the name — the one place the panel says which
		// Annotation this is — off the top of itself.
		const face = page.getByTestId('annotation-inspector-face');
		expect(
			await face.evaluate((element) => ({
				scrolls: element.scrollHeight > element.clientHeight,
				overflow: getComputedStyle(element).overflowY
			})),
			'the description is not scrolling inside the panel'
		).toEqual({ scrolls: true, overflow: 'auto' });
		// ⚠ **Scrolled by the wheel over the panel rather than by assigning `scrollTop` to the body**, and
		// that is what gives the second half teeth: a wheel scrolls whatever the pointer is over, so a panel
		// that scrolled *as a whole* would answer this gesture by moving its own header off the top of itself
		// — while `element.scrollTop = …` on the body would report nothing at all, the body having nothing to
		// scroll.
		const headerTop = () =>
			page
				.getByTestId('annotation-inspector-header')
				.evaluate((element) => Math.round(element.getBoundingClientRect().top));
		const restingHeader = await headerTop();
		await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 2);
		await page.mouse.wheel(0, 2000);
		// Settled rather than sampled: the wheel's scroll is not over in the task that dispatched it.
		await expect.poll(() => face.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		expect(await headerTop(), 'the panel scrolled its own header away').toBe(restingHeader);

		// ── AND THE MAP IS STILL THE MAP BELOW IT ───────────────────────────────────────────
		//
		// The-annotation-inspector story 17, read at the panel's tallest, which is the hardest case: the
		// panel is docked *over* the map rather than beside it, so below its bottom edge — in its own column
		// — the canvas is still the canvas.
		//
		// The point probed is halfway between the panel's bottom edge and the attribution's top, so it is
		// clear of both: the attribution is in this same column and its links are real links.
		const pane = (await baseMap(page).boundingBox())!;
		const below = {
			x: panel.x + panel.width / 2,
			y: (panel.y + panel.height + licence.y) / 2
		};
		// ⚠ **`elementFromPoint` rather than the click alone, and that is the assertion with the teeth.** A
		// click driven at the pane is *dispatched* at the pane, so the pin below lands whether or not
		// anything else is over that spot: measured with the panel's own container deliberately spread down
		// the column, and the pin was drawn regardless. "The map is visible below it" means the map is the
		// topmost thing there, and only this asks that.
		expect(
			await page.evaluate((at) => {
				const hit = document.elementFromPoint(at.x, at.y);
				if (hit === null) return 'nothing';
				if (hit instanceof HTMLCanvasElement) return 'the map';
				if (hit.closest('[data-testid="annotation-inspector"]')) return 'the Inspector';
				return `${hit.tagName}.${hit.className}`;
			}, below),
			'something of the Inspector’s is over the map below its bottom edge'
		).toBe('the map');
		// And a mark placed there really is drawn on the canvas, which is the same claim in the app's own
		// terms: the Annotation lands, is numbered 2, and its row joins the list.
		await drawPin(page, (below.x - pane.x) / pane.width, (below.y - pane.y) / pane.height);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);
		await expect(page.getByTestId('annotation-inspector-ordinal')).toHaveText('2');
	});

	// **Footnote syntax is not asserted here.** ADR-0009's "the syntax degrades to literal text" is a
	// claim about the Markdown pipeline and nothing else, and it is asserted over the same input —
	// `A claim[^1] worth noting.` with its definition line — in
	// `packages/core/src/annotation/markdown.browser.test.ts`, over a real DOM and in milliseconds.
	// What a Seam 2 test can add is that this panel renders through that pipeline at all, and the test
	// above already fails if it does not.

	test('clicking the Annotation on the map opens its row, where the description is rendered', async ({
		page
	}) => {
		// **The map draws no popup on this screen** (ticket 07). Clicking an Annotation opens its own
		// row instead, which is where an Annotation is read in both apps — so "what is this shape?" has
		// one answer rather than a bubble over the map and a row in the sidebar that can disagree.
		const failures = watchFailures(page);
		const layerId = await withOnePin(page);
		await editAnnotationText(page);
		// ⚠ **Long enough that the panel stands at its cap**, which the camera claims below depend on: a
		// short panel is clear of the middle of the pane, so centring a mark anywhere would satisfy "the mark
		// is not behind the panel" without the panel's footprint being reserved at all. A panel as tall as it
		// may get is the case the reservation is actually for.
		await page
			.getByTestId('annotation-description')
			.fill(
				`The *west* quay.\n\n${Array.from(
					{ length: 20 },
					(_, at) => `Paragraph ${at + 1}: the warehouses, and the survey of 1625.`
				).join('\n\n')}`
			);
		// **Put away rather than blurred**, because the panel's resting state is the rendered
		// description and its editing state is the fields: what a click on the map opens is the
		// former, and leaving the fields up would be asserting against the wrong half of the panel.
		await page.getByTestId('annotation-text-done').click();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Clicked **with nothing selected**, which is the state somebody reading is in: a selected
		// Annotation carries its drag handle on top of itself, and the handle is a drag target rather
		// than a way into the Annotation.
		const row = page.getByTestId('annotation-row');
		// The panel's own box, while it is on the screen to be measured: the mark is put behind it further
		// down, and by then nothing is selected and there is no panel to ask.
		const panelBox = (await inspector(page).boundingBox())!;
		await row.click();
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByTestId('pane-overlay-point-annotation-vertex')).toHaveCount(0);

		await clickAt(baseMap(page), 0.4, 0.4);

		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await expect(page.getByTestId('annotation-description-text').locator('em')).toHaveText('west');
		await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

		// ── AND A MARK THAT WOULD BE BEHIND THE PANEL IS BROUGHT OUT FROM UNDER IT ──────────
		//
		// The-annotation-inspector story 19, and the case a scholar most needs the leader in: the Inspector
		// docks over the top-right, so a mark in that quadrant ends up behind the panel describing it and the
		// leader's end goes with it. Nothing throws — the one thing the line exists to show is simply
		// invisible. Selecting the Annotation therefore reserves the panel's footprint in the camera and
		// brings the mark out into the part of the pane nothing is covering.
		//
		// Folded in here rather than given a test of its own because this is already the suite's Project
		// with a long description on the screen — which is what makes the panel stand at its cap, and the
		// cap is what makes the reservation necessary rather than incidental — and the Seam 2 budget
		// (`scripts/check-seam-2-size.mjs`) is spent.
		//
		// ⚠ **The gesture the camera claims are made on is the press of the row below, not the click on the
		// canvas above.** Both run the same effect, and it deliberately does not care which: the canvas
		// click is what proves the effect is not wired to the sidebar, and it is asserted for by everything
		// between here and it. But the occlusion has to be *set up* with nothing selected — there is no
		// panel to measure once the mark is behind where it will be — so getting back to a selection means
		// pressing the row. The restraint that stops all this firing on a mark already in view is asserted
		// where a spurious move is the only thing that could fail: "selecting one costs nothing at all",
		// above.
		//
		// The map is moved rather than the Annotation, so the mark is exactly the one whose description is
		// on the screen above. `unproject(project(mark) + centre − target)` is the shift that puts a
		// coordinate at a chosen screen point: Web Mercator is linear at a fixed zoom, and the centre is
		// asked for by projecting it rather than assumed to be the middle of the pane, because it is the
		// camera's centre this arithmetic is relative to and nothing promises that is the middle of the pane.
		await row.click();
		await expect(inspector(page)).toHaveCount(0);
		const paneBox = (await baseMap(page).boundingBox())!;
		const behindThePanel = {
			x: panelBox.x + panelBox.width / 2 - paneBox.x,
			y: panelBox.y + panelBox.height / 2 - paneBox.y
		};
		const pinAt = (await storedAnnotations(page, layerId)).features[0]!.geometry!.coordinates as [
			number,
			number
		];
		/** Pan the map — never the Annotation — until the pin lands at `target` in the pane's own pixels. */
		const panThePinTo = (target: { x: number; y: number }) =>
			page.evaluate(
				async ([coordinate, wanted]) => {
					const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
					const at = map.project(coordinate as [number, number]);
					const middle = map.project([map.getCenter().lng, map.getCenter().lat]);
					const to = wanted as { x: number; y: number };
					const moved = map.unproject([at.x + middle.x - to.x, at.y + middle.y - to.y]);
					map.setCenter([moved.lng, moved.lat]);
					await Promise.race([
						new Promise<void>((resolve) => map.once('idle', () => resolve())),
						new Promise<void>((resolve) => setTimeout(resolve, 3000))
					]);
				},
				[pinAt, target] as const
			);
		await panThePinTo(behindThePanel);

		/** Where the pin lands in the page's own pixels, against the camera as it is now. */
		const pinOnScreen = async () => {
			const at = await page.evaluate(
				(coordinate) =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.project(
						coordinate as [number, number]
					),
				pinAt
			);
			return { x: paneBox.x + at.x, y: paneBox.y + at.y };
		};
		const covers = (
			box: { x: number; y: number; width: number; height: number },
			at: { x: number; y: number }
		) => at.x >= box.x && at.x <= box.x + box.width && at.y >= box.y && at.y <= box.y + box.height;

		// The precondition, stated rather than assumed: with the panel back this pin would be under it.
		expect(
			covers(panelBox, await pinOnScreen()),
			'the pin is not where the Inspector will be, so this asserts nothing'
		).toBe(true);

		const centre = () =>
			page.evaluate(() =>
				(window as unknown as StackWindow).ballastellaLayerStack!.map.getCenter()
			);
		const moving = () =>
			page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack!.map.isMoving());
		const displaced = await centre();
		await selectAnnotation(page, 0);
		// Settled rather than sampled: the answer is where the camera *stopped*, and a reading taken while
		// the ease is running is a true reading of a moving value and a useless assertion.
		await expect.poll(moving).toBe(false);

		expect(await centre(), 'the occluded mark did not move the camera').not.toEqual(displaced);
		const shown = (await inspector(page).boundingBox())!;
		expect(
			covers(shown, await pinOnScreen()),
			'the selected mark is still behind the panel that describes it'
		).toBe(false);

		// **And the leader's end is on the screen with it**, which is the whole reason the mark had to come
		// out: the line is `z-index: 5` and the Inspector is above MapLibre's controls at 7, so an end under
		// the panel is an end nobody can see.
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		const end = (await leaderPoints(page))!.at(-1)!;
		expect(covers(shown, end), 'the leader ends underneath the Inspector').toBe(false);
		expect(covers(paneBox, end), 'the leader ends outside the map pane').toBe(true);

		// **And the row that was pressed still has the keyboard.** The camera moves and nothing else, which
		// is what lets this run for a selection made on the canvas without stealing the pointer's place:
		// focus follows the gesture — a press of the row — and never the camera the gesture provoked.
		expect(
			await page.evaluate(() => {
				const at = document.activeElement;
				if (at === null || at === document.body) return 'BODY';
				return at.getAttribute('data-testid') ?? at.getAttribute('aria-label') ?? at.tagName;
			}),
			'the camera move took the keyboard'
		).toBe('annotation-row');

		// ── AND NOTHING ASKS THE CAMERA TO MOVE WHILE SOMEBODY IS TYPING ─────────────────────
		//
		// ⚠ **A camera move per keystroke is a real hazard of the mechanism above, not a hypothetical.**
		// Every keystroke saves, every save replaces the collection, and `selectedAnnotation` is therefore a
		// fresh object on each character; an effect that read the Annotation rather than its id would ask
		// for the reservation again on every one of them. `ProjectScreen.svelte`'s effect is keyed on the id
		// and holds a `cleared` note besides, and the note there says which of the two is load-bearing.
		//
		// **The mark is panned back under the panel first, and that is what gives this teeth.** With the
		// mark out in the clear `keepAnnotationClear` refuses the move on its own, so every version of the
		// effect looks correct — which is what happened when the effect was replaced with an object-keyed,
		// memo-free one and all 37 tests in this file went on passing. A scholar is allowed to pan the mark
		// back under the panel; the camera does not fight the user. What must not then happen is the map
		// being yanked out from under the sentence they are in the middle of.
		await panThePinTo(behindThePanel);
		expect(covers(shown, await pinOnScreen()), 'the mark is not back under the panel').toBe(true);
		const beforeTyping = await centre();
		await editAnnotationText(page);
		await page.getByTestId('annotation-description').pressSequentially(' Rebuilt in 1631.');
		// Waited for on the file rather than on the status line, which may already be reading "Saved
		// locally" from the description typed further up: what this needs is that the *keystrokes* reached
		// saves, because that is the thing the effect would have re-run on.
		await expect
			.poll(async () =>
				String((await storedAnnotations(page, layerId)).features[0]!.properties.description)
			)
			.toContain('Rebuilt in 1631.');
		expect(await centre(), 'the camera was asked to move while somebody was typing').toEqual(
			beforeTyping
		);
		expect(await moving(), 'the camera is moving in the middle of a sentence').toBe(false);
		await page.getByTestId('annotation-text-done').click();

		// ── AND THE RESERVATION IS RELEASED WHEN THE PANEL GOES ──────────────────────────────
		//
		// ⚠ **The reservation is a property of one move, not of the viewport.** It was `padding` once, and
		// `padding` is camera state that survives the move that set it: `getCenter` went on answering with
		// the centre of a viewport 344 px narrower than the one on the screen, for the rest of the session.
		// The user-visible fault is below — Enter with the pin tool places a point at `map.getCenter()`, so
		// the pin landed half a reservation left of the crosshair — and the same phantom viewport anchored
		// every later ease and zoom. `offset` leaves nothing behind, and this is the assertion that says so.
		await page.getByTestId('annotation-inspector-close').click();
		await expect(inspector(page)).toHaveCount(0);
		expect(
			await page.evaluate(() => {
				const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
				const at = map.getCenter();
				const on = map.project([at.lng, at.lat]);
				const canvas = map.getCanvas().getBoundingClientRect();
				// `|| 0` because `Math.round` of any negative fraction is `-0`, and `toEqual` holds `-0`
				// and `0` to be different values — so a camera a third of a pixel left of centre would
				// fail this as though the reservation had leaked.
				return {
					right: Math.round(on.x - canvas.width / 2) || 0,
					down: Math.round(on.y - canvas.height / 2) || 0
				};
			}),
			'the camera is still centred on a viewport nobody can see'
		).toEqual({ right: 0, down: 0 });

		// And in the terms a user meets it in: the place under the middle of the pane is the place the pin
		// lands, one dismissal after a reservation was spent.
		const underTheCrosshair = await page.evaluate(() => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
			const canvas = map.getCanvas().getBoundingClientRect();
			return map.unproject([canvas.width / 2, canvas.height / 2]);
		});
		await chooseTool(page, 'point');
		await page.locator('canvas.maplibregl-canvas').focus();
		await page.keyboard.press('Enter');
		await expect.poll(async () => (await storedAnnotations(page, layerId)).features.length).toBe(2);
		const placed = (await storedAnnotations(page, layerId)).features[1]!.geometry!.coordinates as [
			number,
			number
		];
		expect(placed[0], 'the pin landed east or west of the crosshair').toBeCloseTo(
			underTheCrosshair.lng,
			6
		);
		expect(placed[1], 'the pin landed north or south of the crosshair').toBeCloseTo(
			underTheCrosshair.lat,
			6
		);
		expect(failures).toEqual([]);
	});
});

/**
 * The narrowest viewport at which the Project screen is still two columns, in CSS pixels.
 *
 * Tailwind's `lg`, which the viewer's Project grid and the alignment route's panes already used and
 * which `ProjectScreen` adopts — so both applications stack at the same width and `leaderPath`'s
 * refusal on a stacked layout begins in both at the same place.
 *
 * ⚠ **Written out here and again in `e2e/viewer-reader.e2e.ts`, deliberately**, for the reason
 * {@link MARK_CLEARANCE} gives: this Playwright project resolves nothing from the applications or
 * from their stylesheet. The claim "the same width that stacks one stacks the other" is the two
 * copies being asserted independently against the two built apps; a single shared constant would
 * only prove that both tests read one number. Named on both sides so each can be found from the
 * other.
 */
const STACKS_BELOW = 1024;

test.describe('on a phone (the-annotation-inspector stories 60, 61, 62)', () => {
	/**
	 * The Project screen has never had a breakpoint: a 24 rem sidebar and whatever was left. At 390 px
	 * that is the whole window given to the stack and nothing at all to the map.
	 *
	 * **One test, and the folding is the Seam 2 budget** (`scripts/check-seam-2-size.mjs`): the three
	 * stories are one layout — the screen stacks, and *because* it stacks the panel has no corner to
	 * dock to and the leader has no two columns to run between. Every one of them is a claim about
	 * rendered geometry, which Seam 1c cannot hold at all: it has no `offsetWidth`, no scroll
	 * geometry, and no attribution (the-annotation-inspector story 73).
	 *
	 * **Driven by resizing rather than by a Playwright project**, which is what the ticket's scope
	 * refuses: a project per viewport multiplies every spec in the suite. Resizing also buys the
	 * comparison the desktop assertions here are for — the same run measures both sides of the
	 * breakpoint, so "unchanged on a desktop" is asserted against the same Project rather than
	 * inferred from another test.
	 */
	test('the screen stacks, the Inspector becomes a sheet at the bottom, and no leader is drawn', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
		// **A polygon rather than a pin**, because the Style face is the taller of the two only for a
		// geometry that has a fill and a line: a Pin's face is a colour row and a size row, and measuring
		// the cap against it would be measuring the cap against the shorter face twice.
		await drawShape(page, 'polygon', [
			[0.35, 0.3],
			[0.65, 0.3],
			[0.5, 0.55]
		]);
		await selectAnnotation(page);
		await editAnnotationText(page);
		// Long enough that the sheet stands at its cap, which is the only state in which "the body
		// scrolls inside it" and "it does not cover the attribution" can fail.
		await page
			.getByTestId('annotation-description')
			.fill(
				Array.from(
					{ length: 20 },
					(_, at) => `Paragraph ${at + 1}: the quay, the warehouses, and the survey of 1625.`
				).join('\n\n')
			);
		await page.getByTestId('annotation-text-done').click();
		await expect(page.getByTestId('annotation-description-text')).toContainText('Paragraph 20');

		const sidebar = page.getByTestId('layer-sidebar');
		const map = page.getByTestId('project-map');
		const attribution = page.locator('.maplibregl-ctrl-attrib');

		/** Whether the two columns overlap horizontally, which is exactly `leaderPath`'s own test. */
		const columnsOverlap = async (): Promise<boolean> => {
			const column = (await sidebar.boundingBox())!;
			const pane = (await map.boundingBox())!;
			return column.x < pane.x + pane.width && pane.x < column.x + column.width;
		};

		/**
		 * Where the sidebar sits across the screen, and whether it is also the first of the two in the
		 * document — which is the sequential focus order, and the one thing `order` cannot change.
		 */
		const columnsAcross = async () => {
			const column = (await sidebar.boundingBox())!;
			const pane = (await map.boundingBox())!;
			return {
				sidebarIsLeft: column.x + column.width <= pane.x + 1,
				sidebarIsFirstInTheDocument: await page.evaluate(
					() =>
						(document
							.querySelector('[data-testid="layer-sidebar"]')!
							.compareDocumentPosition(document.querySelector('[data-testid="project-map"]')!) &
							Node.DOCUMENT_POSITION_FOLLOWING) !==
						0
				)
			};
		};

		// ── THE BREAKPOINT, FROM BOTH SIDES ────────────────────────────────────────────────
		//
		// One pixel apart, so this fails for the breakpoint moving rather than for a phone being narrow.
		await page.setViewportSize({ width: STACKS_BELOW, height: 900 });
		await expect.poll(columnsOverlap, 'two columns at the breakpoint').toBe(false);
		// ⚠ **And the sidebar is the left-hand one, which is what `lg:order-first` buys and what it
		// costs.** The map column is first in the document so that stacked it sits above the stack, so
		// above this width the two orders disagree: the sidebar is on the left and the keyboard still
		// reaches the map column before it. Asserted as it is rather than as would be preferred — a
		// keyboard order this markup does not produce is not a claim this test gets to make.
		//
		// The document order is one fact and it is asserted here only, because this is the width where it
		// costs something. Stacked, the two orders agree, and that they do is what the map sitting above
		// the stack — asserted below in the pixels a thumb meets — already says.
		expect(
			await columnsAcross(),
			'the sidebar is not the left-hand column above the breakpoint'
		).toEqual({ sidebarIsLeft: true, sidebarIsFirstInTheDocument: false });
		// And on a desktop the leader is still drawn, which is the other half of "unchanged above it".
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
		await page.setViewportSize({ width: STACKS_BELOW - 1, height: 900 });
		await expect.poll(columnsOverlap, 'still two columns one pixel below it').toBe(true);

		// ── AT A PHONE'S OWN SIZE, BOTH HALVES OF THE SCREEN ARE USABLE ─────────────────────
		//
		// The-annotation-inspector story 60.
		await page.setViewportSize({ width: 390, height: 844 });
		const column = (await sidebar.boundingBox())!;
		const pane = (await map.boundingBox())!;

		// **Not a 24 rem column but the width of the screen.** `w-96` is 384 px whatever the window is, so
		// "wider than 384" would say this too — and would say it with 6 px to spare at this viewport, then
		// go red at a 384 px-wide phone on a layout behaving perfectly. The claim is the whole width, which
		// is a number this test already knows and which no fixed column of any size can satisfy.
		expect(column.width, 'the sidebar is not the width of the screen').toBe(
			page.viewportSize()!.width
		);
		// And the map got something rather than nothing, which is the fault story 60 names.
		expect(pane.width).toBeGreaterThan(0);
		expect(pane.height).toBeGreaterThan(0);
		// **The map is the first thing on the screen and the stack is beneath it**, because the Inspector is
		// a sheet over the map: a stack above it puts the sheet below the fold.
		expect(pane.y + pane.height, 'the map is not above the stack').toBeLessThanOrEqual(
			column.y + 1
		);
		// ⚠ **And nothing had to be scrolled to reach it, which is the user-visible point of the map being
		// first.** With the Layer stack first this pane began about 428 px down a 739 px scroller, so the
		// sheet a tap on a mark opens was below the fold and the panel describing the selection had to be
		// scrolled to; every measurement below — `boundingBox()` answers in viewport coordinates — named a
		// spot no gesture could reach until the pane had been scrolled into view. So the whole pane is
		// asserted to be inside the window with nothing on the page scrolled, which is what makes the rest
		// of this a measurement of what a thumb meets.
		expect(
			await map.evaluate((element) => {
				const box = element.getBoundingClientRect();
				let scrolled = 0;
				for (let node = element.parentElement; node !== null; node = node.parentElement)
					scrolled += node.scrollTop;
				return { inTheWindow: box.top >= 0 && box.bottom <= window.innerHeight, scrolled };
			}),
			'the map has to be scrolled to before it can be touched'
		).toEqual({ inTheWindow: true, scrolled: 0 });
		// Both are really usable rather than merely boxed: a live canvas, and the stack with the
		// Annotation's own row in it.
		await expect(map.locator('canvas.maplibregl-canvas')).toBeVisible();
		await expect(sidebar.getByTestId('annotation-row')).toHaveCount(1);

		// ── THE PANEL IS A SHEET ACROSS THE BOTTOM OF THE PANE ──────────────────────────────
		//
		// The-annotation-inspector story 61.
		const sheet = (await inspector(page).boundingBox())!;
		expect(sheet.x, 'the sheet does not reach the pane’s left edge').toBeLessThan(pane.x + 16);
		expect(sheet.x + sheet.width, 'the sheet does not reach the pane’s right edge').toBeGreaterThan(
			pane.x + pane.width - 16
		);
		// **8 rem, because the sheet's bottom inset is the pane's bottom furniture** — 6.25 rem of it, to
		// clear MapLibre's bottom-left control block and the attribution, both asserted below. Anchored to
		// the bottom is still what this fails for: a sheet docked to the top or centred in the pane at this
		// cap ends more than 8 rem short of the bottom edge.
		expect(
			sheet.y + sheet.height,
			'the sheet is not anchored to the bottom of the pane'
		).toBeGreaterThan(pane.y + pane.height - 128);
		// And the map is still the map above it, which is what stops the sheet being a second screen.
		expect(sheet.y, 'the sheet took the whole pane').toBeGreaterThan(pane.y + 24);

		// **The attribution is a licence condition** (ODbL) and the sheet is across the axis it sits on,
		// which is the whole reason the bottom inset exists.
		await expect(attribution).toBeVisible();
		const licence = (await attribution.boundingBox())!;
		expect(sheet.y + sheet.height, 'the sheet covered the Base Map’s attribution').toBeLessThan(
			licence.y
		);

		// ── AND MAPLIBRE'S ZOOM CONTROL IS STILL TAPPABLE UNDER IT ──────────────────────────
		//
		// ⚠ **The-annotation-inspector story 18, and a sheet is the layout that reinstates the fault it
		// names.** The sheet is `z-index: 7` and `layout.css` pins MapLibre's control corners to 6, so a
		// full-width band across the pane's bottom edge covers the zoom control the dock decision moved to
		// the bottom-left *precisely* so that it could never be under the Inspector. Measured at 390 × 844
		// with a 2 rem inset: the zoom-in button 100% overlapped, and `elementFromPoint` at its centre
		// answering with a paragraph of the description — "I never have to dismiss a panel to zoom" gone,
		// on the one layout where dismissing costs the most.
		//
		// **`elementFromPoint` at the button's centre is the assertion that can actually fail**, because
		// what the story is about is whether the button can be pressed. The overlap is asserted beside it so
		// that a sheet clearing the centre and covering the corners cannot pass, and the button is then
		// really pressed and the zoom really read — the three together are the claim in the terms a thumb
		// meets it in.
		expect(
			await page.evaluate(() => {
				const button = document.querySelector('.maplibregl-ctrl-zoom-in')!;
				const band = document.getElementById('annotation-inspector')!.getBoundingClientRect();
				const box = button.getBoundingClientRect();
				const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
				const across = Math.max(0, Math.min(box.right, band.right) - Math.max(box.left, band.left));
				const down = Math.max(0, Math.min(box.bottom, band.bottom) - Math.max(box.top, band.top));
				return {
					topmost:
						at === null
							? 'nothing'
							: at.closest('.maplibregl-ctrl') === null
								? at.tagName
								: 'the zoom control',
					overlapped: Math.round(across * down)
				};
			}),
			'the sheet is over MapLibre’s zoom control'
		).toEqual({ topmost: 'the zoom control', overlapped: 0 });
		const zoomedTo = () =>
			page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack!.map.getZoom());
		const beforeZooming = await zoomedTo();
		await page.locator('.maplibregl-ctrl-zoom-in').click();
		await expect.poll(zoomedTo, 'the zoom control did not zoom').toBeGreaterThan(beforeZooming);

		// ── AND THE SELECTED MARK IS BROUGHT OUT FROM UNDER THE SHEET, ON THE Y AXIS ────────
		//
		// ⚠ **The-annotation-inspector story 19 on the other axis, which is the whole difference a sheet
		// makes.** The docked panel is a column inset from the pane's right edge, so `keepAnnotationClear`
		// reserves *width* and the mark moves sideways into the strip beside it. A sheet spans the pane's
		// width and there is no such strip: a reservation computed from the occluder's left edge clamps to
		// half the pane and shoves the mark sideways for nothing. Measured at 390 × 844 before this was
		// fixed, the mark landed at x 97 — exactly half the pane less half the reservation — and was still
		// fully inside the sheet's box, and re-selecting moved it no further.
		//
		// **Measured in the pane's own pixels rather than the viewport's**, which every camera assertion on
		// a stacked screen has to be: pressing a row in the stack scrolls the page to reach it, so a mark
		// and a sheet read in viewport coordinates on either side of a selection are read against two
		// different page offsets.
		//
		// The map is panned rather than the Annotation, so the mark under the sheet is exactly the one whose
		// description is on the screen above. `unproject(project(mark) + centre − target)` is the shift that
		// puts a coordinate at a chosen screen point: Web Mercator is linear at a fixed zoom.
		const ring = (await storedAnnotations(page, layerId)).features[0]!.geometry
			?.coordinates as number[][][];
		/**
		 * The point the mark is drawn at: `annotationAnchor`'s middle of the shape's extent.
		 *
		 * Computed here rather than imported, for the reason {@link MARK_CLEARANCE} gives — this project
		 * resolves nothing from the applications — and a shape's anchor is the one geometry rule simple
		 * enough to restate: the middle of the ring's bounding box.
		 */
		const anchor: [number, number] = [
			(Math.min(...ring[0]!.map(([lng]) => lng!)) + Math.max(...ring[0]!.map(([lng]) => lng!))) / 2,
			(Math.min(...ring[0]!.map(([, lat]) => lat!)) +
				Math.max(...ring[0]!.map(([, lat]) => lat!))) /
				2
		];
		/** Where the mark lands in the pane's own pixels, against the camera as it is now. */
		const markOnPane = () =>
			page.evaluate(
				(at) =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.project(
						at as [number, number]
					),
				anchor
			);
		/** The sheet's box in the pane's own pixels, read as the difference of two viewport boxes. */
		const sheetOnPane = async () => {
			const shown = (await inspector(page).boundingBox())!;
			const box = (await map.boundingBox())!;
			return {
				left: shown.x - box.x,
				top: shown.y - box.y,
				right: shown.x - box.x + shown.width,
				bottom: shown.y - box.y + shown.height
			};
		};
		const inside = (
			box: { left: number; top: number; right: number; bottom: number },
			at: { x: number; y: number }
		) => at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;
		const band = await sheetOnPane();
		await page.getByTestId('annotation-inspector-close').click();
		await expect(inspector(page)).toHaveCount(0);
		await page.evaluate(
			async ([at, wanted]) => {
				const map = (window as unknown as StackWindow).ballastellaLayerStack!.map;
				const from = map.project(at as [number, number]);
				const middle = map.project([map.getCenter().lng, map.getCenter().lat]);
				const to = wanted as { x: number; y: number };
				const moved = map.unproject([from.x + middle.x - to.x, from.y + middle.y - to.y]);
				map.setCenter([moved.lng, moved.lat]);
				await Promise.race([
					new Promise<void>((resolve) => map.once('idle', () => resolve())),
					new Promise<void>((resolve) => setTimeout(resolve, 3000))
				]);
			},
			[anchor, { x: (band.left + band.right) / 2, y: (band.top + band.bottom) / 2 }] as const
		);
		// The precondition, stated rather than assumed: with the sheet back this mark would be under it.
		const under = await markOnPane();
		expect(
			inside(band, under),
			'the mark is not where the sheet will be, so this asserts nothing'
		).toBe(true);
		await selectAnnotation(page, 0);
		// Settled rather than sampled: the answer is where the camera *stopped*.
		await expect
			.poll(() =>
				page.evaluate(() =>
					(window as unknown as StackWindow).ballastellaLayerStack!.map.isMoving()
				)
			)
			.toBe(false);
		const cleared = await markOnPane();
		const standing = await sheetOnPane();
		expect(inside(standing, cleared), 'the selected mark is still behind the sheet').toBe(false);
		// ⚠ **Clear by `keepAnnotationClear`'s own 16 px comfort rather than by a pixel**, which is what
		// makes the sheet's `max-h` load-bearing rather than incidental. That margin is the function's
		// definition of "behind the panel": a mark that clears the sheet's edge by less than it is one the
		// same function would move again, so a geometry that leaves it clear by 9 px has not satisfied the
		// rule — it has landed just outside the rectangle. This is the assertion the desktop's 70% cap fails
		// on a phone and 60% passes, and a Pin — whose mark box is 30 px tall where a shape's anchor is a
		// point — cannot be got clear at 70% at all.
		expect(
			cleared.y,
			'the mark was not brought comfortably up into the map above the sheet'
		).toBeLessThan(standing.top - 16);
		// **And it did not travel sideways to get there**, which is what a reservation on the x axis does
		// with a sheet: the mark's own column is untouched, because the sheet leaves no column to move into.
		expect(
			Math.round(Math.abs(cleared.x - under.x)),
			'the mark was moved sideways for a sheet that spans the pane'
		).toBeLessThan(4);

		// ── AND BOTH FACES SCROLL INSIDE IT AT THE CAP ──────────────────────────────────────
		//
		// ⚠ **The Style face as well as the Text one**, which ticket 07 left for this ticket: it is the
		// taller of the two — some twenty-five controls — and it had never been measured against a cap.
		const face = page.getByTestId('annotation-inspector-face');
		/**
		 * How far the identity header sits below the top of the sheet, in pixels.
		 *
		 * ⚠ **Relative to the sheet rather than to the viewport**, which the docked panel's own scroll
		 * test can afford to be and this one cannot: everything on a stacked screen is inside a page
		 * that scrolls and that a live region can lengthen, so a header measured against the window
		 * moves for reasons that have nothing to do with what the sheet did. What the claim is about is
		 * the header holding its place *in the sheet* — a sheet that scrolled as a whole would take it
		 * up past its own top edge, and this goes negative when it does.
		 */
		const headerOffset = () =>
			inspector(page).evaluate((element) =>
				Math.round(
					element
						.querySelector('[data-testid="annotation-inspector-header"]')!
						.getBoundingClientRect().top - element.getBoundingClientRect().top
				)
			);
		for (const which of ['text', 'style'] as const) {
			await openFace(page, which);
			expect(
				await face.evaluate((element) => ({
					scrolls: element.scrollHeight > element.clientHeight,
					overflow: getComputedStyle(element).overflowY
				})),
				`the ${which} face is not scrolling inside the sheet`
			).toEqual({ scrolls: true, overflow: 'auto' });
			// Scrolled by the wheel over the sheet, so a sheet that scrolled *as a whole* would answer by
			// taking its own identity header off the top of itself.
			//
			// ⚠ **The resting header is read after the pointer is placed, not before.** `hover()` scrolls
			// its own target into view, and on this layout the sheet is in a page that scrolls — so a
			// reading taken first is a reading of the sheet at a different page offset, and the second
			// half of this would fail by the height the page moved rather than by anything the sheet did.
			//
			// ⚠ **A short wheel, unlike the desktop test's**, for the same reason: a wheel longer than the
			// face has left to give chains out of the sheet and takes the whole page with it.
			//
			// ⚠ **The header assertion below corroborates rather than falsifies on its own.** Every mutation
			// that makes the sheet scroll as a whole instead of the face scrolling inside it — dropping the
			// `max-height`, dropping the `flex`, moving `overflow-y` off the face — trips the two-value check
			// above first, because the face then has nothing to scroll. It is kept because it is the claim
			// stated in the terms a scholar meets it in (the Annotation's name stays on the screen while the
			// prose moves), and it is the assertion that would notice a *future* sheet that scrolled itself.
			await face.hover();
			const resting = await headerOffset();
			await page.mouse.wheel(0, 120);
			await expect.poll(() => face.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
			expect(await headerOffset(), `the ${which} face scrolled the sheet’s header away`).toBe(
				resting
			);
		}

		// ── AND NO LEADER IS DRAWN, BECAUSE `leaderPath` REFUSED ────────────────────────────
		//
		// The-annotation-inspector story 62.
		//
		// ⚠ **Not "the line is invisible".** A media query hiding the element would satisfy any
		// assertion about what can be seen; what the contract asks is that the *function* declines, so
		// the polyline carries no `points` at all. The layer itself is asserted still rendered and still
		// displayed, which is what stops this passing for the wrong reason.
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
		expect(await leaderPoints(page)).toBeNull();
		expect(
			await leaderLayer(page).evaluate((element) => ({
				points: element.querySelector('polyline')!.getAttribute('points'),
				display: getComputedStyle(element).display
			})),
			'the leader was hidden by CSS rather than refused by leaderPath'
		).toEqual({ points: null, display: 'block' });

		// ── AND A PHONE IN LANDSCAPE STILL REACHES THE STYLE FACE ───────────────────────────
		//
		// ⚠ **What this holds is the pane's fixed `h-[26rem]`, not a phone in landscape.** The fault ticket
		// 07 left here is a *short pane*: the identity header and the tab strip are `shrink-0`, so once the
		// sheet's cap falls below their combined height the face is clipped to nothing while the Style tab
		// goes on pressing. No viewport below `lg` can produce one — the pane is `h-[26rem]` there, measured
		// at 416 px from 320 × 320 to 1023 × 400, so this reads a comfortable 176 px against its 24 px
		// floor. What the floor therefore guards is the pane's fixed height, which is the choice worth
		// holding: a fraction of a phone in landscape is exactly the short pane that clips the face.
		// Measured — `h-[10rem]` in place of `h-[26rem]` takes this test red, at the sheet's own anchoring
		// above rather than here, because a pane shorter than the sheet's cap and its bottom inset together
		// fails the geometry before the face has anything to report.
		//
		// **The residual survives above `lg`, where the pane still tracks the window**, and it is recorded
		// as a known limit in `ProjectScreen.svelte`'s note above the `max-height` — with the measurements,
		// and with why an assertion there would be a test of the defect rather than of a regression.
		//
		// ⚠ **Measured as the part of the face that is inside the sheet, not as the face's own box.**
		// `boundingBox()` answers with the layout rectangle whatever an ancestor clips, and the sheet
		// clips with `overflow-hidden` — so a face laid out entirely below the sheet's bottom edge
		// reports its full height and nothing of it is on the screen. The intersection is what a scholar
		// can actually see, and 24 px is a row of controls rather than a hairline.
		await page.setViewportSize({ width: 844, height: 390 });
		await openFace(page, 'text');
		await openFace(page, 'style');
		const showing = () =>
			inspector(page).evaluate((element) => {
				const sheetBox = element.getBoundingClientRect();
				// The face's own box, not a control inside it: a control's rectangle moves with the face's
				// `scrollTop`, so it would report a row scrolled off the top as though the sheet were short.
				const faceBox = element
					.querySelector('[data-testid="annotation-inspector-face"]')!
					.getBoundingClientRect();
				return Math.round(
					Math.min(faceBox.bottom, sheetBox.bottom) - Math.max(faceBox.top, sheetBox.top)
				);
			});
		expect(
			await showing(),
			'the Style face is clipped out of the sheet on a short pane'
		).toBeGreaterThan(24);

		expect(failures).toEqual([]);
	});
});

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
	 * The payload ticket 13 proved reaches storage byte-identical, plus a `javascript:` link.
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
	 * into the file the way ticket 13's import would have left it.
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
		// `renderDescription`: the sanitiser did not retire with the popup (ticket 07).
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
		// carries forward what ticket 13 asserted — the payload is stored as it arrived — through a
		// session that has now *rendered* it three ways.
		const layerId = await withPayload(page);
		const before = await hashesUnder(page, 'annotations/');

		// Selected *by the click on the map*, with nothing selected before it — see the row test above
		// for why the click is not made on top of a drag handle.
		await chooseTool(page, 'select');
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.getByTestId('annotation-description-text')).toBeVisible();
		// Tab out of the title field, which is the shape ticket 02 got wrong: a blur must not rewrite.
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').focus();
		await page.getByTestId('annotation-title').blur();

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect((await storedAnnotations(page, layerId)).features[0]?.properties['title']).toBe(PAYLOAD);
	});
});

test.describe('style controls write simplestyle names exactly (SPEC stories 63, 64, 65)', () => {
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

test.describe('solid, dashed, and dotted (SPEC story 61)', () => {
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

test.describe('deleting an Annotation (SPEC story 66)', () => {
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

		// ── DISMISSING LEAVES THE KEYBOARD IN THE LIST (story 56) ───────────────────────────
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
		// And dismissing left the list alone: the Layer's card is still open and the rows are still there,
		// which is the whole of story 20.
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
		// keyboard was left on `document.body`, which is exactly what story 56 is against.
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
		// Ticket 09 asserts that reorder, rename, toggle, and opacity leave `annotations/*.geojson`
		// byte-identical; this carries that forward through the surface that now *edits* them. Selecting,
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

test.describe('the keyboard alone (SPEC stories 95 and 96)', () => {
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
		await tabTo(page, page.getByTestId('annotation-tool-cancel'), 'the Done button');
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

		// **And the Style face is reached from the keyboard as well, which is the whole of story 59 now
		// that there is a strip in front of the controls.** The tab strip is a radio group, so it is one
		// tab stop that lands on the checked member and arrow keys move along it — nothing was written to
		// make that work, which is what "every control is a native element" buys.
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
async function tabTo(page: Page, target: import('@playwright/test').Locator, what: string) {
	await page.locator('body').click({ position: { x: 2, y: 2 } });
	for (let press = 0; press < 250; press += 1) {
		if (await target.evaluate((element) => element === document.activeElement)) return;
		await page.keyboard.press('Tab');
	}
	throw new Error(`“${what}” could not be reached with the keyboard`);
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE OPEN LAYER IS THE LAYER BEING DRAWN INTO (ticket 05)
//
// There used to be two values — which Layer the sidebar was showing, and which one the "Drawing into"
// picker had selected — and nothing stopped them disagreeing. They are one now, so opening a Layer is
// what chooses it, and the tools are inside the Layer they draw into rather than in a panel beneath
// the stack. What follows is that identity asserted from both ends.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test.describe('drawing into the Layer that is open (ticket 05)', () => {
	/** One Layer's row, by its id, because adding a Layer puts it on top and moves the others down. */
	const rowFor = (page: Page, layerId: string) =>
		page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`);

	/**
	 * A Project with no Annotation Layer says what to do about it, and stops saying it once done.
	 *
	 * **Guidance, not an announcement, and the difference is why this test exists.** Before ticket 05
	 * this was said twice: `AnnotationPanel` had a "No Annotation Layers yet" branch, and the toolbar
	 * beneath it announced "Add an Annotation Layer to start drawing." from a `disabled` state. Putting
	 * the toolbar inside an open Layer's row makes the disabled state unreachable — there is no render
	 * path to it that is not already inside an Annotation Layer — so *that* sentence went with the
	 * state it described, which is the only condition under which removing an announcement is not an
	 * accessibility regression (SPEC story 112).
	 *
	 * What could not go with it is the guidance, because the state it is about — a Project with Layers
	 * and no Annotation Layer — is as reachable as it ever was. It is beside the button that resolves
	 * it, and asserted as visible text rather than as a `title` (SPEC story 111).
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
		// It names the two steps the interface now takes, the second of which is ticket 05's.
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
	 * `activeLayer` used to fall back to `annotationLayers[0]` when nothing was chosen, and ticket 05
	 * removed that fallback. Nothing else in this suite can see the removal: the drawing tools, the
	 * Annotation list and the editor all render *inside* the open row, so restoring the fallback
	 * changes no markup and leaves every other test green.
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
	 * SPEC story 20, and the reason the two values had to become one.
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
		// would be a second place to read one Annotation (ticket 07).
		await expect(page.locator('.maplibregl-popup')).toHaveCount(0);

		expect(failures).toEqual([]);
	});
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PLACING A PIN AT A PLACE (ADR-0029, SPEC stories 6–14)
//
// The gesture this epic exists for: look up an address, watch the Pin land in the middle of a river,
// and drag it onto the quay. **The lookup is the cheap step and the correction is the scholarship**,
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

/**
 * A Project with an aligned Map Image **and** an empty Annotation Layer, seeded.
 *
 * The one test below that needs a warped sheet under its Pin is about correcting a Pin, not about
 * ingesting an image or making Control Points: it used to drive a whole alignment — two live map
 * panes, six clicks, a warped solve — before its first assertion. `alignment-workspace.ts` already
 * seeds the pyramid; this records the pairs and the Layer on top of it, and the alignment itself is
 * still proved by `editor-alignment.e2e.ts` where it is the subject.
 *
 * @returns the Annotation Layer's id
 */
async function seedAlignedProjectWithAnnotationLayer(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, 'annotations-aligned', async (fresh) => {
		await startAlignment(fresh);
		await makePairs(fresh, 3);
		await expect(fresh.getByRole('status')).toHaveText('Saved locally');
		await openLayers(fresh);
		await fresh.getByTestId('add-annotation-layer').click();
		await expect(fresh.getByRole('status')).toHaveText('Saved locally');
		return { imageId: '', layerId: await annotationLayerId(fresh) };
	});
	await restoreWorkspace(page, snapshot.files);
	return snapshot.layerId;
}

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
		// ⚠ **The epic's central claim, and it is directly checkable.** Both Pins are produced through
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
		// SPEC story 14: lookup and drawing must not produce visibly different objects. Asserted by
		// making the difference visible first — a colour nobody would get by accident — and then placing.
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

	test('leaves the Pin draggable and arrow-key movable under a Map Image', async ({ page }) => {
		// ⚠ **The stakeholder's actual gesture**, and the reason this one pays for a real pyramid and a
		// real solve: the Pin lands in the middle of a river and is dragged onto the quay *while reading
		// against a Map Image layered over the Base Map*. Vertex handles are DOM `<button>`s on
		// MapLibre `Marker`s, which sit above the WebGL canvas the warped sheet is drawn into — so this
		// asserts that the correction needs no new code rather than assuming it.
		test.setTimeout(180_000);
		const service = await routePlaceLookup(page);

		const layerId = await seedAlignedProjectWithAnnotationLayer(page);
		await openLayers(page);
		// Both Layers are drawn: the warped sheet over the Base Map, and the Annotation Layer over it.
		// Read off the stack's own count, so a sheet that silently failed to draw would fail here rather
		// than further down as a missing handle.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		await openLayerRow(page, page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`));
		await waitForStack(page);

		// ⚠ **The lookup answers where the sheet is.** The Project opened framed on the Map Image
		// (ADR-0026), so this is the one candidate that leaves the sheet under the Pin — and the whole
		// criterion is that the correction is made *against* the Map Image. A Pin placed in
		// Massachusetts would be dragged over an empty Base Map, which asserts something else.
		const onTheSheet = await centre(page);
		service.answerWith(await candidateAt(onTheSheet));

		await placeFrom(page, AMBIGUOUS_QUERY, 'Springfield', layerId);
		// Both Layers are still drawn: placing a Pin did not take the sheet off the map.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const handle = page.getByTestId('pane-overlay-point-annotation-vertex');
		await expect(handle).toHaveCount(1);
		// ⚠ **Wait for the framing to land before taking hold of the handle.** Placing moves the camera,
		// and a `boundingBox()` read while it is still moving names a spot the Pin is about to leave —
		// so the drag below would begin on empty map, move nothing, and be reported as a Pin that cannot
		// be corrected. Waited on rather than tolerated: that failure is in the direction that hides a
		// defect.
		await expect
			.poll(async () => (await centre(page)).lat, { timeout: 15_000 }) //
			.toBeCloseTo(onTheSheet.lat, 1);
		await expect.poll(() => stillMoving(page)).toBe(false);

		const placed = (await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates;

		// Dragged — immediately, with no reselection and no redraw, which is the "one gesture rather
		// than a delete and a redraw" of SPEC story 9.
		const box = await handle.boundingBox();
		if (!box) throw new Error('the vertex handle has no box');
		// ⚠ **The handle is drawn where the Pin is** — asserted because it was not. A CSS `rotate` on
		// the handle composes *before* the `transform` MapLibre positions a `Marker` with, so the
		// translation was rotated with it and the handle was drawn over the sidebar (`layout.css`).
		// Every existing drag test survived that, because a drag begins wherever the handle happens to
		// be and the coordinate it writes is still right; this compares the handle's own box against
		// where the renderer projects the written coordinate, which is the claim that was false.
		const pane = await baseMap(page).boundingBox();
		if (!pane) throw new Error('the pane has no box');
		const at = placed as [number, number];
		const projected = await page.evaluate(
			(lngLat) =>
				(window as unknown as StackWindow).ballastellaLayerStack?.map.project(
					lngLat as [number, number]
				) ?? { x: -1, y: -1 },
			at
		);
		expect(box.x + box.width / 2).toBeCloseTo(pane.x + projected.x, 0);
		expect(box.y + box.height / 2).toBeCloseTo(pane.y + projected.y, 0);

		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		for (const dx of [10, 20, 30]) {
			await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dx);
		}
		await page.mouse.up();
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		// Polled on the **file**, because the save indicator was already reading `Saved` from the
		// placement: a single read here would be satisfied by the bytes the drag was supposed to change.
		await expect
			.poll(async () => (await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates)
			.not.toEqual(placed);
		const dragged = (await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates;

		// And by keyboard, because a precise correction should not need a steady hand on a trackpad
		// (SPEC story 11).
		await handle.focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await expect
			.poll(async () => (await storedAnnotations(page, layerId)).features[0]?.geometry?.coordinates)
			.not.toEqual(dragged);
	});
});
