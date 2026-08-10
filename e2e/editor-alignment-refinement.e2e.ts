import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';

import {
	IMAGE_HEIGHT,
	IMAGE_WIDTH,
	clickAt,
	drawnMap,
	historicalMap,
	imagePoints,
	makePair,
	makePairs,
	maskEdges,
	maskPointsAttribute,
	maskVertices,
	ringArea,
	rows,
	start,
	storedAlignment,
	storedProjectFile,
	waitForStored,
	waitForSurface,
	warpedTiles,
	watchWrites,
	writes,
	expectWarpedDrawn
} from './support/alignment-workspace';
import { routeBaseMapArchive } from './support/editor-deployment';

/**
 * SPEC's Seam 2 for Alignment refinement: choosing how the Historical Map is stretched, seeing where
 * the stretching is worst, being warned that the Alignment has folded, and outlining the part of the
 * sheet that is actually the map (stories 39–47, and 96 for the guidance in the accessibility tree).
 *
 * **Two things here reach past the interface, and both for the same reason ticket 07's suite did.**
 * `window.ballastellaWarped` is how the *renderer's own* options and computed distortion are read,
 * because "the overlay renders log2sigma" and "distortionMeasures includes every measure" are claims
 * about what `@allmaps/render` was actually told — asserting our intention instead would go green on
 * an option name we had misspelled. And OPFS is read directly, because the criteria about what
 * reaches disk are about bytes.
 *
 * Nothing here asserts an absence of console errors. That is the lesson of the `@allmaps/render`
 * defect: the failure was logged and swallowed, so a console check went green while the map rendered
 * blank. Rendering is asserted by tiles that arrived *and decoded*, and colourising by distortion
 * values that are actually non-zero at the triangulated points.
 */

const picker = (page: Page) => page.getByTestId('transformation-select');
const guidance = (page: Page) => page.getByTestId('transformation-guidance');
const advancedToggle = (page: Page) => page.getByTestId('transformation-advanced');
const shortfalls = (page: Page) => page.getByTestId('transformation-shortfalls');
const foldWarning = (page: Page) => page.getByTestId('fold-warning');
const distortionControls = (page: Page) => page.getByTestId('distortion-controls');
const distortionToggle = (page: Page) => page.getByTestId('distortion-toggle');
const gridToggle = (page: Page) => page.getByTestId('grid-toggle');
const checkToggle = (page: Page) => page.getByTestId('check-alignment-toggle');

/**
 * Open "Check this alignment" (ticket 03).
 *
 * The overlay, its measure and the graticule live behind one disclosure since ticket 03, and they are
 * *not rendered* while it is closed rather than merely hidden — so every test below that reaches for
 * one of them has to open it first, and the tests that assert one is absent must not open it.
 */
// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE BASE MAP COMES FROM THE COMMITTED FIXTURE, NOT FROM SOMEBODY ELSE'S BUCKET (ticket 17).
//
// Every entry in `base-map/catalog.ts` points at `demo-bucket.protomaps.com`, and on 2026-08-07 that
// bucket began answering **404** for `v4.pmtiles` — with no CORS headers on the 404 and a 403 on the
// preflight, so an unrouted request is blocked by the browser rather than answered. MapLibre's source
// then never initialises and the warped layer is never added, so the symptom is
// `data-warped-status=""` — which reads exactly like the feature being broken. It went red here, and
// identically on `main`, with nothing in this repository having changed.
//
// ADR-0025 is explicit that this bucket has "no published rate limit, no uptime promise, and no
// terms of use" and that "nothing about it is suitable to rely on". Fourteen other specs already
// route it to `e2e/fixtures/base-map/amsterdam-centre.pmtiles`; these three were the outliers, and
// not by design — see `routeBaseMapArchive` for what routing does and does not still exercise.
test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

async function openCheck(page: Page): Promise<void> {
	await checkToggle(page).click();
	await expect(distortionControls(page)).toBeVisible();
}
const maskToggle = (page: Page) => page.getByTestId('mask-edit-toggle');
/** The gesture instructions, which are on screen only while Crop is on. */
const maskSummary = (page: Page) => page.getByTestId('mask-summary');
/**
 * How many corners the Resource Mask has, off the element that is always there.
 *
 * On the wrapper rather than on the instructions: the sentence that used to carry the count also said
 * what a mask *is*, permanently, and a control labelled Crop says that by itself. The count is still
 * the pairing's own number rather than a count of handles — handles exist only while Crop is on, and
 * half these assertions are made with it off.
 */
const maskCorners = (page: Page) => page.getByTestId('resource-mask-controls');
const maskStatus = (page: Page) => page.getByTestId('mask-status');

/**
 * Drag `handle` by `(dx, dy)` screen pixels in `steps` moves, committing on pointer-up.
 *
 * The scroll is not decoration. `page.mouse` takes viewport coordinates and does no actionability
 * check of its own, so a handle below the fold gets a drag that lands on nothing and reports no
 * error — and switching the distortion overlay on adds a `<select>` and a paragraph above the panes,
 * which is enough to push them off a 720-pixel viewport.
 */
async function dragBy(
	page: Page,
	handle: Locator,
	dx: number,
	dy: number,
	steps = 10
): Promise<void> {
	await handle.scrollIntoViewIfNeeded();
	const box = await handle.boundingBox();
	if (!box) throw new Error('the handle has no box to drag');
	const fromX = box.x + box.width / 2;
	const fromY = box.y + box.height / 2;
	await page.mouse.move(fromX, fromY);
	await page.mouse.down();
	for (let step = 1; step <= steps; step += 1) {
		await page.mouse.move(fromX + (dx * step) / steps, fromY + (dy * step) / steps);
	}
	await page.mouse.up();
}

/** How far from zero the *displayed* distortion measure is at the triangulated points. */
const worstDistortion = async (page: Page): Promise<number> =>
	(await drawnMap(page))?.worstDistortion ?? -1;

/** Every `<option>` in the picker, disabled or not, as `[value, text]`. */
const options = (page: Page) =>
	page.evaluate(() => {
		const select = document.querySelector<HTMLSelectElement>(
			'[data-testid="transformation-select"]'
		);
		return Array.from(select?.options ?? []).map((option) => ({
			value: option.value,
			text: option.textContent?.trim() ?? '',
			disabled: option.disabled,
			group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : ''
		}));
	});

/** What the accessibility tree says about the picker: its name, and its description. */
const pickerDescription = (page: Page) =>
	page.evaluate(() => {
		const select = document.querySelector<HTMLSelectElement>(
			'[data-testid="transformation-select"]'
		);
		const id = select?.getAttribute('aria-describedby') ?? '';
		const described = id ? document.getElementById(id) : null;
		return {
			describedById: id,
			describedText: described?.textContent?.trim() ?? '',
			// `offsetParent` is null for anything `display: none`, so this is "actually on the page" and
			// not merely "in the DOM" — the distinction between real text and a CSS `::before` tooltip.
			describedIsVisible: described instanceof HTMLElement && described.offsetParent !== null
		};
	});

test.describe('the transformation picker (ADR-0013)', () => {
	test('offers four primary types with the guidance as the primary text, and two behind Advanced', async ({
		page
	}) => {
		await start(page);
		await makePairs(page, 10);

		// Four to begin with. The Advanced tier is not merely styled differently — it is not there.
		let listed = await options(page);
		expect(listed.map((one) => one.value)).toEqual([
			'helmert',
			'polynomial1',
			'projective',
			'thinPlateSpline'
		]);

		// **Guidance first, label second.** ADR-0013: "Most printed maps" is what a historian can act
		// on; "Standard" is not. Asserted as a prefix so the order is the assertion, not the presence.
		expect(listed[0]?.text).toBe('Accurate modern maps — rotate, scale, and move only (Simple)');
		expect(listed[1]?.text).toBe('Most printed and scanned maps (Standard)');
		expect(listed[2]?.text).toBe('Maps photographed at an angle (Perspective)');
		expect(listed[3]?.text).toBe('Hand-drawn or geometrically inconsistent maps (Flexible)');

		// The disclosure. Announced as a disclosure, not merely drawn as one.
		await expect(advancedToggle(page)).toHaveAttribute('aria-expanded', 'false');
		await advancedToggle(page).click();
		await expect(advancedToggle(page)).toHaveAttribute('aria-expanded', 'true');

		listed = await options(page);
		expect(listed.map((one) => one.value)).toEqual([
			'helmert',
			'polynomial1',
			'projective',
			'thinPlateSpline',
			'polynomial2',
			'polynomial3'
		]);
		// Grouped and named, so the tier is announced rather than being a matter of position.
		expect(listed[4]?.group).toBe('Advanced');
		expect(listed[5]?.group).toBe('Advanced');
		expect(listed[4]?.text).toBe('Only with many well-spread points (Higher-order (2nd))');

		// And it closes again.
		await advancedToggle(page).click();
		await expect(advancedToggle(page)).toHaveAttribute('aria-expanded', 'false');
		expect((await options(page)).length).toBe(4);
	});

	// ADR-0016: "anything a user *needs* is visible text or `aria-describedby`", because a daisyUI
	// tooltip renders through CSS `::before` — screen readers do not announce it and it cannot be
	// dismissed. This copy is named in the ADR as exactly the text that would otherwise be buried in
	// one, so it is asserted on both counts: reachable through the accessibility tree, and visible.
	test('puts the guidance in the accessibility tree and on the page, never in a tooltip', async ({
		page
	}) => {
		await start(page);
		await makePairs(page, 3);

		const described = await pickerDescription(page);
		expect(described.describedById).not.toBe('');
		expect(described.describedText).toBe('Most printed and scanned maps');
		expect(described.describedIsVisible).toBe(true);

		// The same text, found by role, which is what an assistive technology would traverse.
		await expect(guidance(page)).toHaveText('Most printed and scanned maps');
		await expect(guidance(page)).toBeVisible();

		// Nothing on this control leans on a tooltip. `title` is the native one and daisyUI's is a
		// `tooltip` class; neither may be how the guidance reaches the user.
		const leansOnTooltip = await page.evaluate(() => {
			const group = document.querySelector('[data-testid="transformation-picker"]');
			if (!group) return 'the picker is not on the page';
			if (group.querySelector('[title]')) return 'a native title attribute';
			if (group.querySelector('[class*="tooltip"]')) return 'a daisyUI tooltip class';
			return '';
		});
		expect(leansOnTooltip).toBe('');

		// It follows the selection, so it describes the type in the control rather than the default.
		await advancedToggle(page).click();
		await picker(page).selectOption('thinPlateSpline');
		await expect(guidance(page)).toHaveText('Hand-drawn or geometrically inconsistent maps');
	});

	test('disables a type below its minimum and names the shortfall', async ({ page }) => {
		await start(page);
		// Two pairs: enough for Simple, one short of Standard and Flexible, two short of Perspective.
		await makePairs(page, 2);
		await advancedToggle(page).click();

		const listed = await options(page);
		const byValue = (value: string) => listed.find((one) => one.value === value);

		expect(byValue('helmert')?.disabled, 'Simple needs 2 and there are 2').toBe(false);
		expect(byValue('polynomial1')?.disabled).toBe(true);
		expect(byValue('projective')?.disabled).toBe(true);
		expect(byValue('thinPlateSpline')?.disabled).toBe(true);
		expect(byValue('polynomial2')?.disabled).toBe(true);
		expect(byValue('polynomial3')?.disabled).toBe(true);

		// **The shortfall is named**, on the option itself, with both numbers — not merely greyed out.
		// ADR-0013's own example sentence.
		expect(byValue('thinPlateSpline')?.text).toContain(
			'Flexible needs at least 3 Control Points — you have 2'
		);
		expect(byValue('polynomial3')?.text).toContain(
			'Higher-order (3rd) needs at least 10 Control Points — you have 2'
		);

		// And on the page, so it answers a question the user has while placing points rather than one
		// they have while browsing a list.
		await expect(shortfalls(page)).toContainText(
			'Flexible needs at least 3 Control Points — you have 2'
		);
		await expect(shortfalls(page)).toContainText(
			'Perspective needs at least 4 Control Points — you have 2'
		);
		await expect(shortfalls(page)).toContainText(
			'Higher-order (3rd) needs at least 10 Control Points — you have 2'
		);

		// A third pair takes Standard and Flexible off the list and leaves Perspective on it.
		await makePairs(page, 3);
		await expect(shortfalls(page)).not.toContainText('Flexible needs');
		await expect(shortfalls(page)).toContainText('Perspective needs at least 4');
	});

	// The obvious implementation — reset on change — destroys the user's actual labour (ADR-0013).
	test('changing the type preserves every Control Point', async ({ page }) => {
		const imageId = await start(page);
		await makePairs(page, 10);
		await waitForStored(page, imageId, 10);

		const before = await rows(page).allInnerTexts();
		expect(before).toHaveLength(10);

		await advancedToggle(page).click();
		for (const type of ['helmert', 'projective', 'thinPlateSpline', 'polynomial2', 'polynomial3']) {
			await picker(page).selectOption(type);
			await expect(picker(page)).toHaveValue(type);
			// Ten pairs, the same ten coordinates, in the same order — and both halves still drawn.
			await expect(rows(page)).toHaveCount(10);
			expect(await rows(page).allInnerTexts(), `after choosing ${type}`).toEqual(before);
			await expect(imagePoints(page)).toHaveCount(10);
		}

		// And on disk, not merely on screen: the file still carries ten pairs after all that.
		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				return written === null ? null : JSON.parse(written).body.transformation;
			})
			.toStrictEqual({ type: 'polynomial', options: { order: 3 } });
		const document = JSON.parse((await storedAlignment(page, imageId)) as string);
		expect(document.body.features).toHaveLength(10);
	});

	// The criterion that would otherwise silently misplace every Alignment in the field:
	// `typeAndOrderToTransformationType` drops the polynomial order, so a third-order Alignment that
	// reloaded as affine would have every coordinate intact and the map in the wrong place.
	test('a chosen type survives a reload, order and all, and reaches the renderer', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 10);
		await advancedToggle(page).click();
		await picker(page).selectOption('polynomial3');

		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				return written === null ? null : JSON.parse(written).body.transformation;
			})
			.toStrictEqual({ type: 'polynomial', options: { order: 3 } });

		await page.reload();
		await waitForSurface(page);

		// Read back as third order and not as affine — the picker shows it, so the Advanced tier is
		// disclosed on load when the stored type is in it.
		await expect(picker(page)).toHaveValue('polynomial3');
		await expect(rows(page)).toHaveCount(10);

		// And the *renderer* was told third order, which the document alone cannot tell it: `WarpedMap`
		// reads `transformation.type` and ignores the order beside it, so `polynomial` would reach the
		// solver as first order.
		await expectWarpedDrawn(page);
		await expect.poll(async () => (await drawnMap(page))?.transformationType).toBe('polynomial3');
	});

	test('never writes straight, linear, or the bare polynomial alias, under any interaction', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 10);
		await advancedToggle(page).click();

		// Every offered type, in turn, and then back to the default: whatever the picker can be driven
		// through, the file must never carry a banned name.
		for (const type of [
			'helmert',
			'projective',
			'thinPlateSpline',
			'polynomial2',
			'polynomial3',
			'polynomial1'
		]) {
			await picker(page).selectOption(type);
			await expect(picker(page)).toHaveValue(type);

			await expect.poll(async () => (await storedAlignment(page, imageId)) ?? '').not.toBe('');
			const written = (await storedAlignment(page, imageId)) as string;
			expect(written, `after choosing ${type}`).not.toContain('straight');
			expect(written, `after choosing ${type}`).not.toContain('linear');

			// The bare alias is what ADR-0013 forbids: `polynomial` with the order left to be inferred.
			// So the assertion is not "the string never appears" — it must, it is the only name the
			// format has — but that it never appears *without* an order beside it.
			const transformation = JSON.parse(written).body.transformation;
			if (transformation?.type === 'polynomial') {
				expect(transformation.options?.order, `after choosing ${type}`).toBeGreaterThanOrEqual(1);
			}
		}
	});
});

test.describe('distortion (ADR-0013)', () => {
	test('is off by default, and colours the map by log2sigma from theme-derived colours', async ({
		page
	}) => {
		// **This watch is load-bearing, and it is the only thing that catches the failure this test is
		// really about.** `@allmaps/render` parses colours with `hexToFractionalRgb` — hex only — and
		// *throws* on anything else, inside the WebGL draw path where nothing surfaces it. Meanwhile the
		// distortion values are computed in a different object entirely, so `trianglePointsDistortion` is
		// full of correct non-zero numbers while nothing is painted. An earlier version of the ramp
		// handed the renderer `rgb(…)` and every assertion below still passed; this is what found it.
		const thrown: string[] = [];
		page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));

		await start(page);
		await makePairs(page, 4);
		await expectWarpedDrawn(page);
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		// **Off by default**: a colourised map is not what you want while placing Control Points — and
		// since ticket 03 the controls are not even on the page until "Check this alignment" is opened.
		await expect(distortionControls(page)).toHaveCount(0);
		await openCheck(page);
		await expect(distortionToggle(page)).not.toBeChecked();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', '');
		let drawn = await drawnMap(page);
		expect(drawn?.distortionMeasure, 'nothing is being displayed').toBeUndefined();
		expect(drawn?.worstDistortion, 'and nothing is being colourised').toBe(0);

		// …but every measure the interface can display is **computed** even so. These are two different
		// renderer settings, and conflating them fails silently: switching the display to a measure
		// that was never computed draws the map with no colouring at all.
		expect([...(drawn?.distortionMeasures ?? [])].sort()).toEqual(['log2sigma', 'signDetJ']);

		await distortionToggle(page).check();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', 'log2sigma');

		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('log2sigma');
		drawn = await drawnMap(page);

		// It is actually colourising, not merely configured to. `trianglePointsDistortion` is what the
		// shader reads, and it is zero everywhere until a measure is displayed — so a non-zero value is
		// the honest signal that the overlay is live.
		expect(drawn?.worstDistortion, 'the overlay is configured but draws nothing').toBeGreaterThan(
			0
		);

		// Theme-derived, not upstream's literal `red` / `darkblue` (ADR-0013) — and in the one notation
		// the renderer can parse, which is `#rrggbb` and nothing else.
		for (const stop of [
			drawn?.distortionColor00,
			drawn?.distortionColor01,
			drawn?.distortionColor3
		]) {
			expect(stop).toMatch(/^#[0-9a-f]{6}$/i);
		}
		// A diverging pair, so the two ends of `log2sigma` cannot be the same colour.
		expect(drawn?.distortionColor00).not.toBe(drawn?.distortionColor01);
		// Not upstream's defaults, which is what "from the theme" has to mean beyond "some colour".
		expect(['red', 'darkblue']).not.toContain(drawn?.distortionColor00);

		// The map is still drawn: turning a display option on must not rebuild the layer and throw away
		// the tile cache, which would make the Historical Map vanish and come back for a checkbox.
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		// And the other measure can be displayed, which is what computing both is for.
		await page.getByTestId('distortion-measure').selectOption('signDetJ');
		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('signDetJ');

		// Nothing threw in the renderer while all of that was drawn. Asserted last, because the throw
		// happens per frame in the draw path and needs the frames above to have been drawn.
		expect(thrown, 'the renderer refused a ramp colour, so nothing was painted').toEqual([]);
	});

	// **The test that was missing, and the reason it was missing is instructive.** Every distortion
	// assertion above is made on a map that has just been built, and the overlay is switched on
	// *afterwards* — which is the one order in which the renderer applies the measure. Edit the
	// Alignment while it is on and, before this, the map came back uncoloured with the checkbox still
	// checked, the `<select>` still naming the measure, `data-distortion-measure` still `log2sigma`,
	// and `getMapOptions(mapId).distortionMeasure` still reporting it. Nothing threw, so the
	// `pageerror` watch could not help either.
	//
	// Two defects in one. `BaseMapPane` rebuilt the whole warped layer whenever the Alignment prop
	// changed — and `AlignmentWorkspace` passes a `$derived` over a getter that returns a fresh object
	// on every read, so *every* edit rebuilt it. And `WarpedMap.applyOptions` never assigns
	// `this.distortionMeasure` in its `stage: 'init'` branch, while `trianglePointsDistortion` and the
	// shader both read the field — so a map built with a measure is never coloured by it.
	//
	// So this drives the four edits a user actually makes, and asserts after each that the map is
	// still being coloured *and* that it is the same drawn map rather than a rebuilt one.
	test('goes on colourising after every kind of Alignment edit, without rebuilding the map', async ({
		page
	}) => {
		const thrown: string[] = [];
		page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));

		const imageId = await start(page);
		await makePairs(page, 6);
		await waitForStored(page, imageId, 6);
		await expectWarpedDrawn(page);

		await openCheck(page);
		await distortionToggle(page).check();
		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('log2sigma');
		await expect.poll(() => worstDistortion(page)).toBeGreaterThan(0);

		const drawnBefore = await drawnMap(page);
		const mapId = drawnBefore?.mapId;
		expect(mapId, 'there has to be a drawn map to keep').toBeTruthy();
		const tilesBefore = await warpedTiles(page);
		expect(tilesBefore).toBeGreaterThan(0);

		/**
		 * The overlay is *still* colourising, and it is still the same map.
		 *
		 * `worstDistortion` is `trianglePointsDistortion`, which is what the shader reads — zero
		 * everywhere means nothing is painted, whatever the options say. The map id is a checksum of the
		 * document the layer was given, so an unchanged id is proof that nothing was re-added: every
		 * renderer and every warped tile survived the edit.
		 */
		const stillColouring = async (what: string): Promise<void> => {
			await expect.poll(() => worstDistortion(page), { message: what }).toBeGreaterThan(0);
			// The interface still claims the overlay is on, which is the half that never broke — and is
			// exactly why the failure was invisible.
			await expect(distortionToggle(page)).toBeChecked();
			await expect(distortionControls(page)).toHaveAttribute(
				'data-distortion-measure',
				'log2sigma'
			);
			expect((await drawnMap(page))?.mapId, `${what}: the layer was rebuilt`).toBe(mapId);
		};

		// 1. Changing how the map is stretched. ADR-0013's named pedagogical use: a student switches on
		//    "Colour the Historical Map by how much it is stretched" and then tries another type.
		await picker(page).selectOption('projective');
		await expect.poll(async () => (await drawnMap(page))?.transformationType).toBe('projective');
		await stillColouring('after changing the transformation type');

		// 2. Moving a Control Point — and the renderer is solving from where it now is, which is the
		//    other half of not rebuilding: the map has to follow the edit, in place.
		const movedBefore = (await drawnMap(page))?.gcps[0]?.resource ?? [];
		await dragBy(page, imagePoints(page).first(), 40, 24);
		await expect
			.poll(async () => (await drawnMap(page))?.gcps[0]?.resource?.[0])
			.not.toBe(movedBefore[0]);
		await stillColouring('after moving a Control Point');

		// 3. Deleting a pair. Six down to five is still above `projective`'s minimum of four, so the map
		//    stays drawn and this is an edit rather than a teardown.
		await page.getByTestId('control-point-delete').last().click();
		await expect(rows(page)).toHaveCount(5);
		await expect.poll(async () => (await drawnMap(page))?.gcps.length).toBe(5);
		await stillColouring('after deleting a Control Point pair');

		// 4. Every mask edit: drag a corner, insert one, and reset the whole outline.
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

		// And the tiles are still there, which is the cost the rebuild was paying: a rebuild discards
		// the cache and refetches every warped tile, once per gesture.
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		expect(thrown, 'nothing may throw while all of that is drawn').toEqual([]);
	});

	test('toggles the warped graticule', async ({ page }) => {
		const thrown: string[] = [];
		page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));

		await start(page);
		await makePairs(page, 4);
		await expectWarpedDrawn(page);

		await openCheck(page);
		await expect(gridToggle(page)).not.toBeChecked();
		expect((await drawnMap(page))?.renderGrid).toBe(false);

		await gridToggle(page).check();
		await expect.poll(async () => (await drawnMap(page))?.renderGrid).toBe(true);
		// Themed, like the ramp, and in hex for the same reason: the grid is drawn over the map by the
		// same shader, so it goes through the same hex-only parser.
		expect((await drawnMap(page))?.renderGridColor).toMatch(/^#[0-9a-f]{6}$/i);
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		await gridToggle(page).uncheck();
		await expect.poll(async () => (await drawnMap(page))?.renderGrid).toBe(false);

		expect(thrown, 'the renderer refused the graticule colour').toEqual([]);
	});

	// It is a working view, not a property of the work (ADR-0013). Persisted it would become layer
	// display state under ADR-0002, and a Published Site could load colourised with a Reader having no
	// way to interpret it.
	test('is absent from project.json after being switched on and off', async ({ page }) => {
		const imageId = await start(page);
		await makePairs(page, 4);
		await expectWarpedDrawn(page);

		const before = await storedProjectFile(page);
		expect(before).not.toBeNull();

		await openCheck(page);
		await distortionToggle(page).check();
		await gridToggle(page).check();
		await page.getByTestId('distortion-measure').selectOption('signDetJ');
		await expect.poll(async () => (await drawnMap(page))?.distortionMeasure).toBe('signDetJ');
		await gridToggle(page).uncheck();
		await distortionToggle(page).uncheck();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', '');

		const after = await storedProjectFile(page);
		// Byte-identical, which is stronger than "no `distortion` key": it says the toggles provoked no
		// write to `project.json` at all rather than a write that happened to omit them. `EditorSession`
		// stamps `updatedAt` on every write, so a single write would show here.
		expect(after).toBe(before);
		expect(after).not.toContain('distortion');
		expect(after).not.toContain('log2sigma');
		expect(after).not.toContain('renderGrid');

		// Nor in the Alignment, which is the other file this page writes.
		expect(await storedAlignment(page, imageId)).not.toContain('distortion');
	});
});

test.describe('the fold warning (ADR-0013)', () => {
	// "The single most useful piece of feedback a student can receive", and the criterion is that it
	// arrives with the overlay OFF — the colour overlay is a toggle, and the fold check is not.
	test('appears for a mirrored pair set under an affine transformation, with the overlay off', async ({
		page
	}) => {
		await start(page);
		await expect(foldWarning(page)).toHaveCount(0);

		// Left on the Historical Map to right on the Base Map, and right to left: the "I swapped two
		// Control Points" error, which is exactly what ADR-0013 says the warning catches on affine.
		await makePair(page, [0.25, 0.3], [0.75, 0.3]);
		await makePair(page, [0.75, 0.3], [0.25, 0.3]);
		// Still two pairs, so nothing can be solved and nothing can be claimed.
		await expect(foldWarning(page)).toHaveCount(0);

		await makePair(page, [0.5, 0.75], [0.5, 0.75]);

		// Standard is affine, which is in `nonWarpingTransformationTypes` and cannot fold *locally* —
		// but it can be globally mirrored, and that is the case under test.
		await expect(picker(page)).toHaveValue('polynomial1');
		await expect(foldWarning(page)).toBeVisible();
		await expect(foldWarning(page)).toContainText('mirrored');
		await expect(foldWarning(page)).toHaveAttribute('data-fold-kind', 'mirrored');

		// **With the overlay off, and with "Check this alignment" never opened.** The whole criterion:
		// the warning is not a consequence of anything being colourised, and since ticket 03 that is the
		// stronger statement it looks like — the overlay's controls are not on the page at all.
		await expect(checkToggle(page)).toHaveAttribute('aria-expanded', 'false');
		await expect(distortionControls(page)).toHaveCount(0);
		await expect(distortionToggle(page)).toHaveCount(0);
		expect((await drawnMap(page))?.distortionMeasure).toBeUndefined();

		// It is an alert, not a polite region: the user is in the middle of making this mistake and the
		// next thing they will do is place another point on top of it.
		await expect(foldWarning(page)).toHaveAttribute('role', 'alert');
	});

	test('goes away when the swapped pair is put right', async ({ page }) => {
		await start(page);
		await makePair(page, [0.25, 0.3], [0.75, 0.3]);
		await makePair(page, [0.75, 0.3], [0.25, 0.3]);
		await makePair(page, [0.5, 0.75], [0.5, 0.75]);
		await expect(foldWarning(page)).toBeVisible();

		// Delete the two crossed pairs and place them the right way round. The warning is derived from
		// the Control Points, so it has to follow them down as well as up — a warning that stuck would
		// be worse than none, because the user would stop believing it.
		await page.getByTestId('control-point-delete').first().click();
		await page.getByTestId('control-point-delete').first().click();
		await expect(rows(page)).toHaveCount(1);
		await makePair(page, [0.25, 0.3], [0.25, 0.3]);
		await makePair(page, [0.75, 0.3], [0.75, 0.3]);

		await expect(rows(page)).toHaveCount(3);
		await expect(foldWarning(page)).toHaveCount(0);
	});
});

test.describe('the Resource Mask (SPEC stories 46 and 47)', () => {
	test('starts as the whole image and draws the whole map', async ({ page }) => {
		const imageId = await start(page);
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await expectWarpedDrawn(page);

		// **Not empty** (ADR-0013): an empty mask renders nothing, which reads as a broken tool on a
		// user's first Alignment.
		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', '4');
		expect(maskPointsAttribute((await storedAlignment(page, imageId)) as string)).toBe(
			`0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}`
		);

		// The renderer has the whole rectangle, and is applying it — so "the whole map" is what is
		// drawn rather than what we hope is drawn.
		const drawn = await drawnMap(page);
		expect(drawn?.applyMask).toBe(true);
		expect(drawn?.resourceMask).toStrictEqual([
			[0, 0],
			[IMAGE_WIDTH, 0],
			[IMAGE_WIDTH, IMAGE_HEIGHT],
			[0, IMAGE_HEIGHT]
		]);
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		// The handles are asked for rather than always present: eight of them over a sheet you are
		// placing Control Points on is noise, and a mis-aimed click is a moved outline.
		await expect(maskVertices(page)).toHaveCount(0);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);
		await expect(maskEdges(page)).toHaveCount(4);
	});

	test('an edited mask narrows the warped render and survives a reload', async ({ page }) => {
		const imageId = await start(page);
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await expectWarpedDrawn(page);

		const wholeSheet = await drawnMap(page);
		expect(ringArea(wholeSheet?.convexHull)).toBeGreaterThan(0);

		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);

		// Drag the top-left corner well into the sheet: a real outlining gesture, and one that must
		// commit exactly once, on pointer-up (ADR-0017 rule 1).
		await watchWrites(page);
		const corner = maskVertices(page).first();
		// The scroll {@link dragBy} documents, needed here too now that the workspace is a route with a
		// header above it (ticket 03): `page.mouse` takes viewport coordinates and does no actionability
		// check, so a handle below the fold gets a drag that lands on nothing and reports no error.
		await corner.scrollIntoViewIfNeeded();
		const box = await corner.boundingBox();
		if (!box) throw new Error('the Resource Mask corner has no box to drag');
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		for (let step = 1; step <= 10; step += 1) {
			await page.mouse.move(box.x + box.width / 2 + step * 9, box.y + box.height / 2 + step * 6);
		}
		// **The step count is the assertion**: a per-pointer-move implementation writes once per move
		// and passes any "did it save?" test.
		expect(await writes(page)).toEqual([]);
		await page.mouse.up();
		await expect.poll(async () => (await writes(page)).length).toBe(1);

		// Add a corner on the first edge, which is what makes this an outline rather than four
		// draggable corners — the midpoint handle inserts without moving the outline.
		await maskEdges(page).first().click();
		await expect(maskVertices(page)).toHaveCount(5);
		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', '5');

		// On disk: five vertices, and the first one is no longer the image origin.
		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				return written === null ? -1 : maskPointsAttribute(written).split(' ').length;
			})
			.toBe(5);
		const writtenPoints = maskPointsAttribute((await storedAlignment(page, imageId)) as string);
		expect(writtenPoints.startsWith('0,0 ')).toBe(false);
		// Plain decimal, which is what upstream's polygon regex accepts. Kept here because it is what
		// the file must always be, but note that **none of these coordinates is anywhere near 1e-6**, so
		// this assertion alone would go on passing with the notation fix deleted. The test that actually
		// drives a coordinate under the threshold is the next one.
		expect(writtenPoints).not.toMatch(/e[+-]/);

		// The warped render is narrowed to it. Measured on the **convex hull of what the renderer is
		// drawing**, which is its own account rather than ours — and the hull rather than the bounding
		// box, because cutting a corner off a rectangle leaves the bounding box exactly where it was:
		// the three remaining corners still hold every extreme.
		await expect
			.poll(async () => {
				const now = await drawnMap(page);
				return now?.resourceMask.length ?? -1;
			})
			.toBe(5);
		const narrowed = await drawnMap(page);
		expect(narrowed?.applyMask).toBe(true);
		expect(ringArea(narrowed?.convexHull)).toBeLessThan(ringArea(wholeSheet?.convexHull) * 0.98);
		// Still drawing: a mask that narrows the render must not stop it.
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		// And it comes back. Nothing about the mask handles is persisted — the outline is read off disk
		// — so this says the whole path survives a reload.
		const storedBefore = maskPointsAttribute((await storedAlignment(page, imageId)) as string);
		await page.reload();
		await waitForSurface(page);

		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', '5');
		expect(maskPointsAttribute((await storedAlignment(page, imageId)) as string)).toBe(
			storedBefore
		);
		await expectWarpedDrawn(page);
		await expect.poll(async () => (await drawnMap(page))?.resourceMask.length).toBe(5);
	});

	// **A Resource Mask vertex below 1e-6, reached only by editing, and only through the real UI.**
	//
	// This is the one that makes ticket 07's note 3 more than a hypothesis. `Number#toString` switches
	// to exponential notation below 1e-6, upstream's `polygon points` regex is `-?\d+(\.\d+)?` — plain
	// decimal only — and `parseAnnotation` then throws on the *selector*, which takes the whole
	// Alignment down: every Control Point becomes unreachable, silently, on the next open.
	//
	// The gesture is ordinary. A dashed handle inserts a vertex at the midpoint of its edge, so
	// activating the handle on the edge that leaves the image origin halves that edge's far end each
	// time. Thirty activations take 700 image pixels to 6.51925802230835e-7 — which `String()` writes in
	// exponential notation, so this is the real thing and not a stand-in for it.
	//
	// Driven by `Enter` on the focused handle rather than by clicking, for two reasons: it is the
	// keyboard path the mask is required to have, and the handle converges on the corner it is halving
	// towards, so after a dozen halvings a click is hit-testing two overlapping 15-pixel buttons.
	//
	// Deliberately two Control Point pairs and not three, so nothing is drawn warped. The claim is about
	// the bytes and the reload, and a mask of thirty-four vertices re-triangulated thirty times is a lot
	// of renderer work to make that claim through.
	test('writes a Resource Mask vertex below 1e-6 in plain decimal, and reads it back', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 2);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);
		await expect(maskEdges(page)).toHaveCount(4);

		// The edge that leaves the image origin. Its handle keeps its element across inserts — the
		// handles are keyed by index and this one stays index 0 — so focus survives all thirty presses.
		const originEdge = maskEdges(page).first();
		await originEdge.focus();
		await expect(originEdge).toBeFocused();

		const HALVINGS = 30;
		for (let done = 0; done < HALVINGS; done += 1) {
			await page.keyboard.press('Enter');
			await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', String(5 + done));
		}

		// 700 / 2**30, which is 6.51925802230835e-7 — under the threshold, and non-zero.
		const tiny = IMAGE_WIDTH / 2 ** HALVINGS;
		expect(String(tiny), 'the value has to be one JavaScript writes exponentially').toMatch(/e-/);
		expect(tiny).toBeLessThan(1e-6);

		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				return written === null ? -1 : maskPointsAttribute(written).split(' ').length;
			})
			.toBe(4 + HALVINGS);

		const writtenPoints = maskPointsAttribute((await storedAlignment(page, imageId)) as string);
		// The value is there, in plain decimal, with every significant digit — the notation changed and
		// the number did not.
		expect(writtenPoints).toContain('0.000000651925802230835,0');
		// And nothing anywhere in the attribute is exponential. **This is the assertion that fails if
		// the notation fix is removed**, because now there is a coordinate that provokes it.
		expect(writtenPoints).not.toMatch(/e[+-]/);

		// **The disaster this prevents, asserted directly**: the Alignment is still readable, so the
		// Control Points are still there. An exponential vertex does not cost the vertex; it costs the
		// whole file, and it costs it on reopening rather than on saving.
		const storedBefore = await storedAlignment(page, imageId);
		await page.reload();
		await waitForSurface(page);

		await expect(page.getByTestId('alignment-failure')).toHaveCount(0);
		await expect(rows(page)).toHaveCount(2);
		await expect(maskCorners(page)).toHaveAttribute('data-mask-vertices', String(4 + HALVINGS));
		// Byte-identical, which says the value survived the round trip exactly rather than approximately.
		expect(await storedAlignment(page, imageId)).toBe(storedBefore);
	});

	test('is operable by keyboard, and refuses to go below three corners', async ({ page }) => {
		const imageId = await start(page);
		await makePairs(page, 3);
		await waitForStored(page, imageId, 3);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);

		// A corner is a real button: focusable, named, and movable by arrow key — one key-hold, one
		// write, the keyboard's version of pointer-up.
		const corner = maskVertices(page).first();
		await corner.focus();
		await expect(corner).toBeFocused();
		await expect(corner).toHaveAttribute('aria-label', /Resource Mask corner 1 of 4/);

		// **`aria-pressed` belongs to a toggle, and neither mask handle is one.** It was set for every
		// interactive kind, so a screen reader announced "Resource Mask corner 1 of 4 … toggle button,
		// not pressed" — for ever, since neither kind is ever `selected`.
		await expect(corner).not.toHaveAttribute('aria-pressed', /.*/);
		await expect(maskEdges(page).first()).not.toHaveAttribute('aria-pressed', /.*/);
		// And a Control Point still has it, because that is what it was added for (ADR-0022 contract 4).
		await expect(imagePoints(page).first()).toHaveAttribute('aria-pressed', /true|false/);

		const before = await corner.boundingBox();
		await watchWrites(page);
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const after = await corner.boundingBox();
		expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(5);

		// **A successful move is announced.** The handles sit on a WebGL canvas and the outline is drawn
		// into it, so without this a keyboard user is told when an edit fails and nothing when it works
		// — which teaches them that silence means failure.
		await expect(maskStatus(page)).toHaveAttribute('aria-live', 'polite');
		await expect(maskStatus(page)).toHaveAttribute('data-mask-status', 'done');
		await expect(maskStatus(page)).toContainText('corner 1 moved');

		// Delete takes a corner out…
		await maskVertices(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);
		await expect(maskStatus(page)).toHaveAttribute('data-mask-status', 'done');
		await expect(maskStatus(page)).toContainText('3 corners left');

		// …and then refuses, with the reason said. A keypress that silently does nothing is
		// indistinguishable from a broken handle, and upstream refuses a ring of fewer than three
		// outright — so an unguarded delete would surface as a failed *save*, with the outline gone.
		await maskVertices(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);
		await expect(maskStatus(page)).toHaveAttribute('data-mask-status', 'refused');
		await expect(maskStatus(page)).toContainText('at least 3 corners');

		// The recovery, which matters because undo is a later slice.
		await page.getByTestId('mask-reset').click();
		await expect(maskVertices(page)).toHaveCount(4);
		await expect(maskStatus(page)).toContainText('whole sheet');
		await expect
			.poll(async () => maskPointsAttribute((await storedAlignment(page, imageId)) as string))
			.toBe(`0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}`);
	});

	// **Deleting the handle the keyboard is on must not end the keyboard path.** `overlay-points.ts`
	// removed a handle without asking whether it held focus, so Delete on the *last* Resource Mask
	// corner dropped focus to `<body>` — and from there the arrow keys pan the map instead of moving
	// the next corner. CONTRIBUTING makes focus management a criterion of every change that adds UI.
	//
	// The last corner specifically, because the mask's handles are keyed by index: deleting corner 1 of
	// 4 leaves keys 0–2, so the focused element survives and is repainted as its neighbour. Only the
	// highest index actually loses its element, which is why this was invisible.
	test('keeps the keyboard on a Resource Mask corner after deleting the one it was on', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 3);
		await waitForStored(page, imageId, 3);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);

		const last = maskVertices(page).last();
		await last.focus();
		await expect(last).toBeFocused();
		await expect(last).toHaveAttribute('aria-label', /Resource Mask corner 4 of 4/);

		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);

		// Still on a corner, and on the one before it — not on `<body>`, and not on the map canvas.
		await expect(maskVertices(page).last()).toBeFocused();
		await expect(maskVertices(page).last()).toHaveAttribute(
			'aria-label',
			/Resource Mask corner 3 of 3/
		);

		// And the keyboard still moves *the corner* rather than panning the map — which is the thing the
		// dropped focus actually cost, and which a bounding box cannot tell apart: a panned map moves the
		// handle on screen too. What distinguishes them is the file. Panning writes nothing.
		const storedBefore = maskPointsAttribute((await storedAlignment(page, imageId)) as string);
		await page.keyboard.press('Shift+ArrowRight');
		await expect
			.poll(async () => maskPointsAttribute((await storedAlignment(page, imageId)) as string))
			.not.toBe(storedBefore);
	});

	// The same rule for a Control Point, where every delete loses the element: the keys are the pair's
	// own ids, so nothing is renumbered into the focused handle's place.
	test('keeps the keyboard on a Control Point after deleting the pair it was on', async ({
		page
	}) => {
		const imageId = await start(page);
		await makePairs(page, 3);
		await waitForStored(page, imageId, 3);

		const second = imagePoints(page).nth(1);
		await second.focus();
		await expect(second).toBeFocused();
		await expect(second).toHaveAttribute('aria-label', /Control Point 2, Historical Map half/);

		await page.keyboard.press('Delete');
		await expect(imagePoints(page)).toHaveCount(2);

		// The next half in drawing order, which after renumbering is the one now called point 2.
		await expect(imagePoints(page).nth(1)).toBeFocused();
		await expect(imagePoints(page).nth(1)).toHaveAttribute(
			'aria-label',
			/Control Point 2, Historical Map half/
		);

		// Arrow keys move the Control Point, not the map. Read off the list, which states the image pixel
		// the pair claims — a panned map moves the handle on screen without moving the point.
		const listedBefore = await rows(page).allInnerTexts();
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await rows(page).allInnerTexts())[1]).not.toBe(listedBefore[1]);
	});

	// **The help text and the cursor have to describe the gesture the handle actually has.** A dashed
	// handle carries only `onselect`, so `paint` calls `setDraggable(false)` and dragging it does
	// nothing — which is the right design (ticket 08: "a handle that both inserted and moved would make
	// 'I nudged it' and 'I added one' the same gesture"). The text said "drag a dashed handle to add
	// one" and the CSS gave it `cursor: grab` and `grabbing`, so the interface advertised the one
	// gesture the code refuses. On a teaching tool that reads as a broken handle.
	test('promises only the gestures the mask handles actually have', async ({ page }) => {
		await start(page);
		await makePairs(page, 3);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);

		await expect(maskSummary(page)).toContainText('Drag a corner to move it');
		await expect(maskSummary(page)).toContainText('Click a dashed handle to add a corner there');
		// Never "drag … to add", in either order of words.
		await expect(maskSummary(page)).not.toContainText(/drag[^.]*\bto add\b/i);

		const cursorOf = (testid: string) =>
			page.evaluate((id) => {
				const element = document.querySelector(`[data-testid="${id}"]`);
				return element ? getComputedStyle(element).cursor : '';
			}, testid);

		// A corner is dragged, so it says so; an edge handle is activated, so it says *that*. Read as a
		// computed style rather than as a class, because the promise the user sees is the cursor.
		expect(await cursorOf('pane-overlay-point-mask-vertex')).toBe('grab');
		expect(await cursorOf('pane-overlay-point-mask-edge')).toBe('pointer');
		// `grabbing` on `:active` is the other half of the same false promise, so the rule must be gone
		// from the dashed handle entirely rather than only from its resting state.
		const activeCursors = await page.evaluate(() => {
			// Flattened, because Tailwind 4 wraps authored CSS in `@layer` and a top-level walk of
			// `cssRules` would find nothing and report an empty list — which would pass for the wrong
			// reason.
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
						rule.selectorText.includes('pane-overlay-point-mask-edge') &&
						rule.selectorText.includes(':active')
				)
				.map((rule) => rule.style.cursor);
		});
		expect(activeCursors).not.toContain('grabbing');
		// The walk has to be able to see the rules at all, or the assertion above is vacuous: the
		// *corner* keeps its `grabbing` on `:active`, so finding that is the control.
		const vertexActiveCursors = await page.evaluate(() => {
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
						rule.selectorText.includes('pane-overlay-point-mask-vertex') &&
						rule.selectorText.includes(':active')
				)
				.map((rule) => rule.style.cursor);
		});
		expect(vertexActiveCursors).toContain('grabbing');
	});

	// The mask is in image pixel space and belongs to the image pane only (ticket 08, out of scope:
	// "Editing the mask on the Base Map pane").
	test('has no handles on the Base Map, which speaks a different coordinate space', async ({
		page
	}) => {
		await start(page);
		await makePairs(page, 3);
		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);

		const onBaseMap = page
			.getByTestId('base-map-pane')
			.locator('[data-testid="pane-overlay-point-mask-vertex"]');
		await expect(onBaseMap).toHaveCount(0);
		await expect(
			page.getByTestId('base-map-pane').locator('[data-testid="pane-overlay-point-mask-edge"]')
		).toHaveCount(0);
	});

	// Clicking the image pane starts a Control Point; clicking a mask handle must not. Both are live
	// at once, so this is the interaction the two features share and the one that can regress.
	test('does not start a Control Point when a mask handle is used', async ({ page }) => {
		await start(page);
		await makePairs(page, 3);
		await maskToggle(page).check();
		await expect(rows(page)).toHaveCount(3);

		await maskEdges(page).first().click();
		await expect(maskVertices(page)).toHaveCount(5);
		// No pending half, and no fourth pair: the click was about the outline.
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', '');
		await expect(rows(page)).toHaveCount(3);

		// And the pane still starts a Control Point where there is no handle.
		await clickAt(historicalMap(page), 0.55, 0.9);
		await expect(page.getByTestId('pairing-status')).toHaveAttribute('data-pending', 'resource');
		await page.keyboard.press('Escape');
	});
});
