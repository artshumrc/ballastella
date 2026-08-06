import { expect, test, type Page } from '@playwright/test';

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
	warpedStatus,
	warpedTiles,
	watchWrites,
	writes
} from './support/alignment-workspace';

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
const maskToggle = (page: Page) => page.getByTestId('mask-edit-toggle');
const maskSummary = (page: Page) => page.getByTestId('mask-summary');

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
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
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
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
		expect(await warpedTiles(page)).toBeGreaterThan(0);

		// **Off by default**: a colourised map is not what you want while placing Control Points.
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

	test('toggles the warped graticule', async ({ page }) => {
		const thrown: string[] = [];
		page.on('pageerror', (error) => thrown.push(`${error.name}: ${error.message}`));

		await start(page);
		await makePairs(page, 4);
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

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
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

		const before = await storedProjectFile(page);
		expect(before).not.toBeNull();

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

		// **With the overlay off.** The whole criterion: the warning is not a consequence of anything
		// being colourised.
		await expect(distortionToggle(page)).not.toBeChecked();
		await expect(distortionControls(page)).toHaveAttribute('data-distortion-measure', '');
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
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

		// **Not empty** (ADR-0013): an empty mask renders nothing, which reads as a broken tool on a
		// user's first Alignment.
		await expect(maskSummary(page)).toHaveAttribute('data-mask-vertices', '4');
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
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');

		const wholeSheet = await drawnMap(page);
		expect(ringArea(wholeSheet?.convexHull)).toBeGreaterThan(0);

		await maskToggle(page).check();
		await expect(maskVertices(page)).toHaveCount(4);

		// Drag the top-left corner well into the sheet: a real outlining gesture, and one that must
		// commit exactly once, on pointer-up (ADR-0017 rule 1).
		await watchWrites(page);
		const corner = maskVertices(page).first();
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
		await expect(maskSummary(page)).toHaveAttribute('data-mask-vertices', '5');

		// On disk: five vertices, and the first one is no longer the image origin.
		await expect
			.poll(async () => {
				const written = await storedAlignment(page, imageId);
				return written === null ? -1 : maskPointsAttribute(written).split(' ').length;
			})
			.toBe(5);
		const writtenPoints = maskPointsAttribute((await storedAlignment(page, imageId)) as string);
		expect(writtenPoints.startsWith('0,0 ')).toBe(false);
		// Plain decimal throughout: exponential notation matches no branch of upstream's polygon regex
		// and would make the *entire* Alignment unreadable on the next open.
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

		await expect(maskSummary(page)).toHaveAttribute('data-mask-vertices', '5');
		expect(maskPointsAttribute((await storedAlignment(page, imageId)) as string)).toBe(
			storedBefore
		);
		await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
		await expect.poll(async () => (await drawnMap(page))?.resourceMask.length).toBe(5);
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

		const before = await corner.boundingBox();
		await watchWrites(page);
		await page.keyboard.press('Shift+ArrowRight');
		await expect.poll(async () => (await writes(page)).length).toBe(1);
		const after = await corner.boundingBox();
		expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(5);

		// Delete takes a corner out…
		await maskVertices(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);

		// …and then refuses, with the reason said. A keypress that silently does nothing is
		// indistinguishable from a broken handle, and upstream refuses a ring of fewer than three
		// outright — so an unguarded delete would surface as a failed *save*, with the outline gone.
		await maskVertices(page).first().focus();
		await page.keyboard.press('Delete');
		await expect(maskVertices(page)).toHaveCount(3);
		await expect(page.getByTestId('mask-refusal')).toContainText('at least 3 corners');

		// The recovery, which matters because undo is a later slice.
		await page.getByTestId('mask-reset').click();
		await expect(maskVertices(page)).toHaveCount(4);
		await expect
			.poll(async () => maskPointsAttribute((await storedAlignment(page, imageId)) as string))
			.toBe(`0,0 ${IMAGE_WIDTH},0 ${IMAGE_WIDTH},${IMAGE_HEIGHT} 0,${IMAGE_HEIGHT}`);
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
