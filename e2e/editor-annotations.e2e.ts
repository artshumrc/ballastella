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
// **The XSS assertions are on the rendered DOM**, and on *all three* surfaces that show untrusted
// text: the map popup, the Annotation's name in the list, and the description preview. A sanitiser
// applied to one of three render sites is a vulnerability with a passing test. Ticket 13 proved the
// payload reaches storage byte-identical and that import never parses it; nothing rendered a
// `description` until now, and closing its `[~]` criterion is what the `untrusted` describe below is
// for.

import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { openLayerRow } from './support/layers.js';
import { AMBIGUOUS_QUERY, candidateAt, routePlaceLookup } from './support/places.js';
// The one test that needs a warped sheet over the Base Map borrows the alignment suite's ground
// rather than growing a second PNG encoder — see the header of `support/alignment-workspace.ts`.
import { makePairs, start as startAlignment } from './support/alignment-workspace.js';

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
	drawPin,
	drawShape,
	editAnnotationText,
	emptyWorkspace,
	hashesUnder,
	openLayers,
	PROJECT_NAME,
	readProjectFile,
	reopenLayers,
	selectAnnotation,
	paintProperty,
	projectJson,
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
	test('a pin, a line, and a shape are drawn and land in the Annotation Layer’s own file', async ({
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
		expect(failures).toEqual([]);
	});

	test('a polygon’s ring is closed, which is what other tools require', async ({ page }) => {
		// RFC 7946 §3.1.6: a Polygon's ring is a LinearRing and its first and last positions must be
		// identical. An open ring is drawn happily by geojson.io and refused by PostGIS and shapely, so
		// it would break exactly the portability claim ADR-0009 is for. The user never places the closing
		// vertex, so nothing but the writer can.
		const layerId = await startAnnotating(page);
		await drawShape(page, 'polygon', [
			[0.4, 0.4],
			[0.7, 0.4],
			[0.55, 0.7]
		]);

		const ring = (await storedAnnotations(page, layerId)).features[0]?.geometry
			?.coordinates as number[][][];

		expect(ring[0]).toHaveLength(4);
		expect(ring[0]?.at(0)).toEqual(ring[0]?.at(-1));
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
		expect(failures).toEqual([]);
	});

	test('a part-drawn shape is abandoned by Escape and writes nothing', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await watchAnnotationWrites(page);

		await chooseTool(page, 'polygon');
		await clickAt(baseMap(page), 0.4, 0.4);
		await clickAt(baseMap(page), 0.6, 0.4);
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'true');

		await page.keyboard.press('Escape');

		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'false');
		expect((await storedAnnotations(page, layerId)).features).toEqual([]);
		// Escape leaves no trace on disk, which is the whole of it: nothing was ever written.
		expect(await annotationWrites(page)).toEqual([]);
	});

	test('a newly drawn Annotation is selected, and its row toggles the selection', async ({
		page
	}) => {
		// Drawing selects what was drawn, so it can be titled straight away — which is the reason for
		// drawing it. Asserted rather than assumed because it is load-bearing for the rest of this suite:
		// a row is a toggle, so a helper that clicked one unconditionally would *deselect* the new shape
		// and take the editor and the vertex handles with it.
		await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		// The list is back once the tools are put away; the new pin is selected in it.
		await chooseTool(page, 'select');

		const row = page.getByTestId('annotation-row');
		await expect(row).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('annotation-editor')).toBeVisible();

		await row.click();
		await expect(row).toHaveAttribute('aria-pressed', 'false');
		await expect(page.getByTestId('annotation-editor')).toHaveCount(0);

		await row.click();
		await expect(row).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByTestId('annotation-editor')).toBeVisible();
	});

	test('“New Annotation” closes the Annotation that was open', async ({ page }) => {
		// The editor is not part of the list, so it used to stay on screen when the list stepped aside for
		// the shape buttons: a panel titled after the *previous* Annotation, sitting directly under the
		// tool that is about to draw a different one, in the place the new one's own panel will appear.
		await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('The west quay');
		await page.getByTestId('annotation-text-done').click();
		await expect(page.getByTestId('annotation-editor')).toContainText('The west quay');

		await page.getByTestId('annotation-new').click();
		await expect(page.getByTestId('annotation-editor')).toHaveCount(0);

		// And the shape drawn next opens in an editor of its own, which is the panel that belongs there.
		await page.getByTestId('annotation-tool-point').click();
		await clickAt(baseMap(page), 0.6, 0.6);
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await expect(page.getByTestId('annotation-editor')).not.toContainText('The west quay');
	});

	test('the selected row wears the Layer’s own wash, and no rule of its own', async ({ page }) => {
		// **Measured, because the defect was two colours making two claims.** The row carried
		// `border-primary` — the app's action colour, which belongs to the controls *outside* the Layer
		// cards — over daisyUI's `menu-active`, which paints `base-content`: a blue rule against a
		// near-black slab, in a card whose every other control is the Annotation kind's `info`.
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await drawPin(page, 0.6, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page, 0);

		const rows = page.getByTestId('annotation-row');
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
		expect(await inkOf(marked)).toBe(await inkOf(plain));

		// No rule down the left edge, on either row. The list already draws a hairline between rows and a
		// border around itself, and a two-pixel line inside that was a fourth vertical edge in a 384px
		// column. A one-line `border-l-2` is all it would take to come back.
		for (const row of [marked, plain]) {
			expect(await row.evaluate((element) => getComputedStyle(element).borderLeftWidth)).toBe(
				'0px'
			);
		}
	});

	test('the gesture is announced, so it is legible without seeing the canvas', async ({ page }) => {
		await startAnnotating(page);
		const status = page.getByTestId('annotation-status');

		await expect(status).toHaveAttribute('aria-live', 'polite');
		await expect(status).toHaveAttribute('aria-atomic', 'true');

		await chooseTool(page, 'polygon');
		await expect(status).toContainText('to start a shape');
		await clickAt(baseMap(page), 0.4, 0.4);
		await expect(status).toContainText('1 point placed');
		await expect(status).toContainText('2 more');
		await clickAt(baseMap(page), 0.6, 0.4);
		await clickAt(baseMap(page), 0.5, 0.6);
		await expect(status).toContainText('3 points placed');
		await expect(status).toContainText('Finish');
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
		// Read as text; the pencil is what turns them back into fields.
		await expect(page.getByTestId('annotation-title-text')).toHaveText('Warehouses');
		await expect(page.getByTestId('annotation-description-text')).toContainText('The west quay.');
		await editAnnotationText(page);
		await expect(page.getByTestId('annotation-title')).toHaveValue('Warehouses');
		await expect(page.getByTestId('annotation-description')).toHaveValue('The *west* quay.');
	});

	test('typing a whole sentence does not shut the fields', async ({ page }) => {
		// The regression this is here for: the panel resets its editing state when **a different
		// Annotation arrives**, and `annotation` is a fresh object after every save — which is after
		// every keystroke. Written as an effect that merely read `annotation.id`, that reset fired on
		// each character, and a scholar could type exactly one letter before the fields turned back into
		// text and they had to press the pencil again. Typed character by character, because `fill()`
		// sets the value once and would never have seen it.
		await withOnePin(page);
		await editAnnotationText(page);

		const title = page.getByTestId('annotation-title');
		await title.click();
		await page.keyboard.type('Fort Amsterdam', { delay: 60 });
		await expect(title).toHaveValue('Fort Amsterdam');

		const description = page.getByTestId('annotation-description');
		await description.click();
		await page.keyboard.type('Built in 1625.', { delay: 60 });
		await expect(description).toHaveValue('Built in 1625.');
	});

	test('typing does not rebuild the Layer stack, so the map does not thrash', async ({ page }) => {
		// The bug: the collection was part of the key the stack was built from, so every keystroke —
		// each of which writes the file and hands the page a new collection — tore down and re-added
		// **every layer in the stack**, Historical Maps included, and the map flickered and refetched
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

		await editAnnotationText(page);
		await page.getByTestId('annotation-title').click();
		await page.keyboard.type('The old mill', { delay: 40 });
		await page.getByTestId('annotation-description').click();
		await page.keyboard.type('Built 1780.', { delay: 40 });
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		expect(await builds()).toBe(before);
		// And the words did land, so this is not passing by having typed into nothing.
		expect((await storedAnnotations(page, await annotationLayerId(page))).features[0]?.properties) //
			.toMatchObject({ title: 'The old mill', description: 'Built 1780.' });
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
	});

	test('footnote syntax renders as literal text, with no anchors and no ids', async ({ page }) => {
		// ADR-0009 defers footnotes and asks the syntax degrade "as behaviour, not accident". Left to
		// `marked` it is neither: `^1` is a legal CommonMark link label, so `[^1]: <url>` really is a link
		// reference definition — it produces no output of its own and turns every `[^1]` into an anchor.
		await withOnePin(page);
		const description = page.getByTestId('annotation-description-text');

		await editAnnotationText(page);
		await page
			.getByTestId('annotation-description')
			.fill('A claim[^1] worth noting.\n\n[^1]: https://example.org/note');
		await page.getByTestId('annotation-text-done').click();

		await expect(description).toContainText('A claim[^1] worth noting.');
		// The definition line is kept as text rather than silently deleted.
		await expect(description).toContainText('[^1]: https://example.org/note');
		await expect(description.locator('a')).toHaveCount(0);
		await expect(description.locator('[id]')).toHaveCount(0);
	});

	test('a description is shown in a popup over the map, rendered', async ({ page }) => {
		const failures = watchFailures(page);
		await withOnePin(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-description').fill('The *west* quay.');
		await page.getByTestId('annotation-description').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Clicking the Annotation on the map is what a reader does, and it is the same popup. **With
		// nothing selected**, which is the state a reader is in: a selected Annotation carries its
		// drag handle on top of itself, and the handle is a drag target rather than a way into the
		// popup. That was true before and invisible, because the handle was drawn in the wrong place
		// (see the note in `layout.css`).
		await page.getByTestId('annotation-row').click();
		await expect(page.getByTestId('pane-overlay-point-annotation-vertex')).toHaveCount(0);
		await clickAt(baseMap(page), 0.4, 0.4);

		const popup = page.locator('.maplibregl-popup');
		await expect(popup).toBeVisible();
		await expect(popup.locator('em')).toHaveText('west');
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
		const layerId = await startAnnotating(page);
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

	test('the payload is inert in the Annotation’s name in the list', async ({ page }) => {
		// The surface most likely to be missed. A description obviously holds a stranger's prose; a title
		// looks like a label, and a list row looks like chrome. It is safe here for a different reason
		// from the popup and the preview — Svelte interpolates it as text, so the DOM never parses it as
		// markup — and that reason has to be asserted rather than trusted, because one `{@html}` added
		// here for "formatting in titles" would undo it silently.
		const failures = watchFailures(page);
		await withPayload(page);

		const row = page.getByTestId('annotation-row');
		await expect(row).toHaveCount(1);

		// Scoped to the **name**, which is the element a stranger's title is interpolated into, rather
		// than to the whole list. The list legitimately holds an `<svg>` per row now — the glyph for what
		// each Annotation is — and a probe that counts every `<svg>` under it would be satisfied by our
		// own icon rather than by the payload's absence. Narrowing keeps every count at zero and keeps
		// the claim exact: nothing the payload carries becomes an element here.
		const inert = await inertWithin(page, '[data-testid="annotation-row-name"]');
		expect(inert.missing).toBe(false);
		expect(inert.scripts).toBe(0);
		expect(inert.images).toBe(0);
		expect(inert.svgs).toBe(0);
		expect(inert.handlers).toEqual([]);
		expect(inert.executableUrls).toEqual([]);
		// The row is not silently blank: a title is inserted as *text*, so the payload's own characters
		// survive there as characters — which is the correct outcome for a title and different from the
		// description, where DOMPurify removes the elements outright.
		expect(inert.text).toContain('onerror');
		expect(inert.text).toContain('The **west** quay');
		expect(await nothingRan(page)).toEqual({
			ran: false,
			injectedImage: false,
			injectedScript: false
		});
		expect(failures).toEqual([]);
	});

	test('the payload is inert in the rendered description', async ({ page }) => {
		const failures = watchFailures(page);
		await withPayload(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await expect(page.getByTestId('annotation-description-text')).toBeVisible();

		const inert = await inertWithin(page, '[data-testid="annotation-description-text"]');
		expect(inert.missing).toBe(false);
		// **First**, that something rendered at all. A blank description passes every assertion below it,
		// and blank is exactly what a `{@html}` adopted from prerendered output looks like — so the anti-
		// vacuous assertion comes before the security ones rather than after them. The prose proves the
		// surface is live; the payload's own characters do not survive here, because DOMPurify removes a
		// disallowed element rather than escaping it.
		expect(inert.text).toContain('The west quay, per the survey.');
		await expect(page.getByTestId('annotation-description-text').locator('strong')).toHaveText(
			'west'
		);
		expect(inert.scripts).toBe(0);
		expect(inert.images).toBe(0);
		expect(inert.svgs).toBe(0);
		expect(inert.iframes).toBe(0);
		expect(inert.ids).toBe(0);
		expect(inert.handlers).toEqual([]);
		expect(inert.executableUrls).toEqual([]);
		expect(await nothingRan(page)).toEqual({
			ran: false,
			injectedImage: false,
			injectedScript: false
		});
		expect(failures).toEqual([]);
	});

	test('the payload is inert in the popup on the map', async ({ page }) => {
		const failures = watchFailures(page);
		await withPayload(page);
		await chooseTool(page, 'select');

		// Clicked on the map, which is the reader's own path to it and the one ticket 17 inherits.
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.locator('.maplibregl-popup')).toBeVisible();

		const inert = await inertWithin(page, '.maplibregl-popup-content');
		expect(inert.missing).toBe(false);
		expect(inert.scripts).toBe(0);
		expect(inert.images).toBe(0);
		expect(inert.svgs).toBe(0);
		expect(inert.iframes).toBe(0);
		expect(inert.ids).toBe(0);
		expect(inert.handlers).toEqual([]);
		expect(inert.executableUrls).toEqual([]);
		// Both the title and the description are in this popup, so these cover both fields: the title's
		// characters survive as text, and the description's prose renders with its emphasis.
		expect(inert.text).toContain('onerror');
		expect(inert.text).toContain('The west quay, per the survey.');
		await expect(page.locator('.maplibregl-popup-content strong')).toHaveText('west');
		expect(await nothingRan(page)).toEqual({
			ran: false,
			injectedImage: false,
			injectedScript: false
		});
		expect(failures).toEqual([]);
	});

	test('nothing anywhere in the document carries the payload’s markup', async ({ page }) => {
		// The catch-all, in case a fourth render site is added later without a test of its own: asked of
		// the whole document rather than of a named surface.
		const failures = watchFailures(page);
		await withPayload(page);
		// The reader's path, with nothing selected — the sibling test above takes the same one, and for
		// the reason given there: a selected Annotation's drag handle sits on top of it.
		await chooseTool(page, 'select');
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.locator('.maplibregl-popup')).toBeVisible();

		// Asked of the whole document, but **only about the payload** — not "are there any scripts", which
		// is true of every page the app serves, nor "are there any inline event handlers", which MapLibre's
		// own controls may legitimately have. The question here is whether anything the payload asked for
		// exists anywhere, and the payload is specific enough to ask about directly.
		const traces = await page.evaluate(() => {
			const all = [...document.querySelectorAll('*')];
			return {
				payloadScripts: [...document.querySelectorAll('script')].filter((script) =>
					(script.textContent ?? '').includes('__xss')
				).length,
				payloadImages: document.querySelectorAll('img[src="x"], img[onerror]').length,
				payloadSvgs: document.querySelectorAll('svg[onload]').length,
				xssHandlers: all.flatMap((element) =>
					[...element.attributes]
						.filter(
							(attribute) =>
								attribute.name.toLowerCase().startsWith('on') && attribute.value.includes('__xss')
						)
						.map((attribute) => `${element.tagName}.${attribute.name}`)
				),
				// `javascript:` anywhere, and `data:` only where it could carry markup. Any `data:` at all
				// would be wrong here: the app's own favicon is a `data:image/svg+xml` link in `<head>`, and
				// a check that flagged it would be a probe that cries wolf — which is how a real check gets
				// loosened away.
				xssUrls: all
					.flatMap((element) => [element.getAttribute('href'), element.getAttribute('src')])
					.filter(
						(value): value is string =>
							value !== null && /^(javascript:|data:text\/html|data:.*script)/i.test(value)
					)
			};
		});

		expect(traces).toEqual({
			payloadScripts: 0,
			payloadImages: 0,
			payloadSvgs: 0,
			xssHandlers: [],
			xssUrls: []
		});
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

		// Selected *by the click on the map*, with nothing selected before it — see the popup test above
		// for why the click is not made on top of a drag handle.
		await chooseTool(page, 'select');
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.locator('.maplibregl-popup')).toBeVisible();
		// Tab out of the title field, which is the shape ticket 02 got wrong: a blur must not rewrite.
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').focus();
		await page.getByTestId('annotation-title').blur();

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect((await storedAnnotations(page, layerId)).features[0]?.properties['title']).toBe(PAYLOAD);
	});
});

test.describe('style controls write simplestyle names exactly (SPEC stories 63, 64, 65)', () => {
	async function withOneLine(page: Page): Promise<string> {
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.65, 0.45]
		]);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		return layerId;
	}

	test('a colour, a width, and an opacity are written under the spec’s own names', async ({
		page
	}) => {
		const layerId = await withOneLine(page);

		const stroke = await chooseColour(page, 'annotation-stroke', 'red');
		await page.getByTestId('annotation-stroke-width').fill('4');
		await page.getByTestId('annotation-stroke-opacity').fill('0.5');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;

		expect(properties['stroke']).toBe(stroke);
		expect(properties['stroke-width']).toBe(4);
		expect(properties['stroke-opacity']).toBe(0.5);
		// Every name written is one simplestyle defines. A camelCase name would look right in the app and
		// make the file unreadable to every other tool, which is the whole portability claim.
		for (const name of Object.keys(properties)) expect(SIMPLESTYLE_NAMES).toContain(name);
	});

	test('a fill colour and opacity are written for a shape', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawShape(page, 'polygon', [
			[0.4, 0.4],
			[0.7, 0.4],
			[0.55, 0.7]
		]);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		const fill = await chooseColour(page, 'annotation-fill', 'blue');
		await page.getByTestId('annotation-fill-opacity').fill('0.25');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;
		expect(properties['fill']).toBe(fill);
		expect(properties['fill-opacity']).toBe(0.25);
		for (const name of Object.keys(properties)) expect(SIMPLESTYLE_NAMES).toContain(name);
	});

	// **The palette is nine colours and there is no way to type a tenth** (ticket 10's amendment). The
	// well this replaced offered sixteen million, which is how a Project ends up with nine
	// indistinguishable near-reds and no way to say "the blue route" out loud.
	test('an Annotation can only be one of the nine colours, each named and legibly ticked', async ({
		page
	}) => {
		await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		// Nine swatches, each a real radio: the count *and* the element, because a row of nine
		// `<div>`s that looked identical would pass a count and be unreachable from a keyboard.
		const swatches = page.getByTestId('annotation-marker-color').locator('input[type=radio]');
		await expect(swatches).toHaveCount(9);

		// **All nine on one line, and inside the sidebar.** This was a 3×3 grid, and three of these
		// pickers made the selected Annotation's card the tallest thing in the column. A wrapped row is
		// the failure this asserts against — it looks like a design choice rather than a bug — so the
		// measurement is that every swatch shares a top edge and the last one ends inside the sidebar.
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
		const sidebar = (await page.getByTestId('layer-sidebar').boundingBox())!;
		expect(Math.max(...boxes.map((box) => box.right))).toBeLessThanOrEqual(
			Math.round(sidebar.x + sidebar.width)
		);

		// Every swatch is named, so the accessible name is "Red" rather than "option 4" (SPEC story 111).
		for (const [name, hex] of Object.entries(ANNOTATION_COLOR)) {
			const swatch = page.getByTestId(`annotation-marker-color-${name}`);
			await expect(swatch).toHaveText(new RegExp(name, 'i'));
			await expect(swatch.locator('input')).toHaveValue(hex);
		}

		// The tick is white on the seven dark swatches and black on the two light ones, which is a
		// contrast fact rather than a taste one: a white tick carries 1.7:1 on Yellow and 1.0:1 on White.
		// `ColorPicker.svelte` records the measured ratio for all nine.
		for (const [name, ink] of [
			['black', '#ffffff'],
			['blue', '#ffffff'],
			['green', '#ffffff'],
			['orange', '#ffffff'],
			['white', '#000000'],
			['yellow', '#000000']
		] as const) {
			await chooseColour(page, 'annotation-marker-color', name);
			await expect(
				page.getByTestId(`annotation-marker-color-${name}`).locator('[data-ink]')
			).toHaveAttribute('data-ink', ink);
		}

		// And the choice is said in words, which is the channel that survives a monochrome screen.
		await chooseColour(page, 'annotation-marker-color', 'purple');
		await expect(page.getByTestId('annotation-marker-color-chosen')).toHaveText('Purple');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
	});

	test('a pin gets marker properties and no line or fill controls', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		// The union doing its job in the UI: there is no fill on a pin, so there is no control for one.
		await expect(page.getByTestId('annotation-fill')).toHaveCount(0);
		await expect(page.getByTestId('annotation-marker-color')).toHaveCount(1);

		const markerColor = await chooseColour(page, 'annotation-marker-color', 'purple');
		// There is no line on a pin either, so the whole Line group is absent rather than empty.
		await expect(page.getByTestId('annotation-stroke')).toHaveCount(0);
		await expect(page.getByTestId('annotation-stroke-width')).toHaveCount(0);
		await page.getByTestId('annotation-marker-size-large').click();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;
		expect(properties['marker-color']).toBe(markerColor);
		expect(properties['marker-size']).toBe('large');
	});

	test('an Annotation drawn with default styling carries the palette’s grey and nothing more', async ({
		page
	}) => {
		// **This used to assert `{}` — no style properties at all** — on the grounds that precedence let a
		// Layer be restyled in bulk. That precedence is gone: ADR-0009's amendment deleted the Layer's
		// `defaultStyle` and writes style onto each Annotation as it is drawn, so there is no longer a
		// bulk restyle for an absent property to preserve.
		//
		// What replaced it is the palette. simplestyle's own defaults are two *different* greys —
		// `#555555` for a line and a fill, `#7e7e7e` for a pin — and only the first is one of the nine
		// colours a scholar is offered, so a pin drawn with defaults would have reported a colour the
		// picker could not show. Writing the palette's grey explicitly is what makes every freshly drawn
		// shape sit on a swatch.
		//
		// The three colours and *nothing else*: `stroke-width`, the opacities and `marker-size` stay
		// absent, because simplestyle has one default for each and this app does not contradict it.
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await drawShape(page, 'line', [
			[0.5, 0.5],
			[0.7, 0.55]
		]);

		for (const feature of (await storedAnnotations(page, layerId)).features) {
			expect(feature.properties).toEqual({
				'marker-color': ANNOTATION_COLOR.grey,
				stroke: ANNOTATION_COLOR.grey,
				fill: ANNOTATION_COLOR.grey
			});
		}
		// And the picker says so in words, rather than only in a coloured square (SPEC story 111).
		await chooseTool(page, 'select');
		await selectAnnotation(page, 0);
		await expect(page.getByTestId('annotation-marker-color-chosen')).toHaveText('Grey');
		expect(await readAnnotationText(page, layerId)).not.toContain('stroke-width');
	});

	test('the written file is valid GeoJSON with simplestyle values of the right types', async ({
		page
	}) => {
		const layerId = await withOneLine(page);
		await chooseColour(page, 'annotation-stroke', 'red');
		await page.getByTestId('annotation-stroke-width').fill('3');
		await page.getByTestId('annotation-stroke-opacity').fill('0.8');
		await chooseLineStyle(page, 'dotted');
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const stored = await storedAnnotations(page, layerId);

		expect(stored.type).toBe('FeatureCollection');
		expect(Array.isArray(stored.features)).toBe(true);
		const properties = stored.features[0]!.properties;
		expect(stored.features[0]!.type).toBe('Feature');
		expect(stored.features[0]!.geometry?.type).toBe('LineString');
		expect(properties['stroke']).toMatch(/^#[0-9a-f]{6}$/i);
		expect(typeof properties['stroke-width']).toBe('number');
		expect(typeof properties['stroke-opacity']).toBe('number');
		expect(properties['stroke-opacity'] as number).toBeGreaterThanOrEqual(0);
		expect(properties['stroke-opacity'] as number).toBeLessThanOrEqual(1);
		expect(properties['stroke-dasharray']).toEqual([1, 3]);
	});
});

/** The Annotation Layer's file as text, for asserting what is *not* in it. */
const readAnnotationText = async (page: Page, layerId: string): Promise<string> =>
	JSON.stringify(await storedAnnotations(page, layerId));

test.describe('solid, dashed, and dotted (SPEC story 61)', () => {
	test('solid is the absence of stroke-dasharray, and the tuples are stored not keywords', async ({
		page
	}) => {
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.65, 0.45]
		]);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		// Solid is the default and writes **no `stroke-dasharray`** — which is the claim, and is now worth
		// stating exactly, because the Annotation does carry the three colours it was drawn with. A
		// `toEqual({})` here would have been asserting the palette's absence by accident.
		const drawn = (await storedAnnotations(page, layerId)).features[0]!.properties;
		expect(drawn).not.toHaveProperty('stroke-dasharray');
		expect(drawn).toEqual({
			'marker-color': ANNOTATION_COLOR.grey,
			stroke: ANNOTATION_COLOR.grey,
			fill: ANNOTATION_COLOR.grey
		});

		await chooseLineStyle(page, 'dashed');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect((await storedAnnotations(page, layerId)).features[0]!.properties['stroke-dasharray']) //
			.toEqual([8, 4]);

		await chooseLineStyle(page, 'dotted');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect((await storedAnnotations(page, layerId)).features[0]!.properties['stroke-dasharray']) //
			.toEqual([1, 3]);

		// No keyword ever reaches the file — a keyword would be legible only to us (ADR-0009).
		const text = await readAnnotationText(page, layerId);
		for (const keyword of ['"dashed"', '"dotted"', '"solid"']) expect(text).not.toContain(keyword);

		// And going back to solid *removes* the property rather than blanking it.
		await chooseLineStyle(page, 'solid');
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		expect((await storedAnnotations(page, layerId)).features[0]!.properties) //
			.not.toHaveProperty('stroke-dasharray');
	});

	test('the three render distinctly, each by its own layer with its own dash pattern', async ({
		page
	}) => {
		// Asserted on **what MapLibre drew**. `line-dasharray` is the one paint property MapLibre will not
		// evaluate per feature, so three line styles inside one Annotation Layer means three MapLibre
		// layers filtered on the bucket — and this is the assertion that they exist, that each Annotation
		// went to the right one, and that their dash patterns actually differ.
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
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
		const layerId = await startAnnotating(page);
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

	test('the first Annotation in a Layer carries the palette’s grey and nothing else', async ({
		page
	}) => {
		// There is nothing to copy from in an empty Layer, so this is where the palette's own starting
		// colour is written — and it is written rather than left absent because simplestyle's defaults are
		// two different greys, only one of which is a colour the picker can show. See
		// `styleForNewAnnotation`.
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);

		expect((await storedAnnotations(page, layerId)).features[0]!.properties).toEqual({
			'marker-color': ANNOTATION_COLOR.grey,
			stroke: ANNOTATION_COLOR.grey,
			fill: ANNOTATION_COLOR.grey
		});
	});

	test('simplestyle’s own defaults apply where neither says anything', async ({ page }) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.65, 0.45]
		]);
		const id = (await storedAnnotations(page, layerId)).features[0]!.id;

		const drawnWith = (await renderedStyles(page))[id];

		expect(drawnWith?.['stroke']).toBe('#555555');
		expect(drawnWith?.['stroke-width']).toBe(2);
		expect(drawnWith?.['stroke-opacity']).toBe(1);
		expect(failures).toEqual([]);
	});
});

test.describe('deleting an Annotation (SPEC story 66)', () => {
	test('removes it from the file and leaves the others', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawPin(page, 0.5, 0.3);
		await drawPin(page, 0.7, 0.3);
		await chooseTool(page, 'select');
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);

		const before = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		await selectAnnotation(page, 1);
		await page.getByTestId('annotation-delete').click();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		const after = (await storedAnnotations(page, layerId)).features.map((one) => one.id);
		expect(after).toEqual([before[0], before[2]]);
		expect(await readAnnotationText(page, layerId)).not.toContain(before[1]!);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);
		// The editor closes with it, rather than showing an Annotation that is no longer there.
		await expect(page.getByTestId('annotation-editor')).toHaveCount(0);
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

	test('a file this app wrote is byte-identical after being parsed and written again', async ({
		page
	}) => {
		// The round trip, on real files: editing one Annotation must not reformat the rest of the
		// document. Byte-identity is what keeps a Workspace in git producing diffs a human can read.
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.3, 0.3);
		await drawShape(page, 'line', [
			[0.5, 0.5],
			[0.7, 0.55]
		]);
		const original = await readAnnotationText(page, layerId);

		// A reload parses the file; then one Annotation is edited, which writes the whole document back.
		await reopenLayers(page);
		await chooseTool(page, 'select');
		await page.getByTestId('annotation-row').first().click();
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('A');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		await page.getByTestId('annotation-title').fill('');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		// Back to exactly what it was: a title typed and cleared leaves no empty string behind.
		expect(await readAnnotationText(page, layerId)).toBe(original);
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

		// Every control on the selected Annotation is reachable too — including the one that now stands
		// between the keyboard and the text: the pencil that turns it into fields. It is native, which is
		// why it needed no key handler of its own (ADR-0016); this is what asserts that.
		await chooseTool(page, 'select');
		await selectAnnotation(page, 1);
		await tabTo(page, page.getByTestId('annotation-edit-text'), 'the edit pencil');
		await page.keyboard.press('Enter');
		for (const control of ['annotation-title', 'annotation-description']) {
			await tabTo(page, page.getByTestId(control), control);
		}
		await page.getByTestId('annotation-text-done').click();

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
		for (const control of [
			'annotation-stroke-width',
			'annotation-stroke-opacity',
			'annotation-delete'
		]) {
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
		await chooseTool(page, 'select');
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
		await expect(page.getByTestId('annotation-editor')).toBeVisible();

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

		// The gesture is gone and the selection with it. **The tool stays in hand**, which is
		// `AnnotationDrawing.cancel()`'s existing behaviour and not an oversight: cancelling a shape
		// almost always means drawing another, and Escape has always left the tool selected too. Ticket
		// 05 moved where the toolbar is drawn and changed nothing about what it holds.
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-drawing', 'false');
		await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-tool', 'polygon');
		await expect(page.getByTestId('annotation-editor')).toHaveCount(0);
		// The Layer that was opened is empty — read once the tool is put down, because the list stands
		// aside while a shape is armed.
		await chooseTool(page, 'select');
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
		await expect(page.getByTestId('annotation-editor')).toHaveCount(0);

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
		await expect(page.getByTestId('annotation-editor')).toBeVisible();
		await expect(page.getByTestId('annotation-title-text')).toHaveText('Fort Amsterdam');
		await expect(rowFor(page, routes).getByTestId('annotation-row').first()).toHaveAttribute(
			'aria-pressed',
			'true'
		);

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
		// hunting for it. Asserted on the editor and on the row's own pressed state rather than on a
		// highlight.
		await expect(page.getByTestId('annotation-editor')).toBeVisible();
		await expect(page.getByTestId('annotation-row')).toHaveAttribute('aria-pressed', 'true');
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

	test('leaves the Pin draggable and arrow-key movable under a Historical Map', async ({
		page
	}) => {
		// ⚠ **The stakeholder's actual gesture**, and the reason this one pays for a real pyramid and a
		// real solve: the Pin lands in the middle of a river and is dragged onto the quay *while reading
		// against a Historical Map layered over the Base Map*. Vertex handles are DOM `<button>`s on
		// MapLibre `Marker`s, which sit above the WebGL canvas the warped sheet is drawn into — so this
		// asserts that the correction needs no new code rather than assuming it.
		test.setTimeout(180_000);
		const service = await routePlaceLookup(page);

		await startAlignment(page);
		await makePairs(page, 3);
		await expect(page.getByRole('status')).toHaveText('Saved locally');

		await openLayers(page);
		// The Historical Map is drawn over the Base Map. Read off the stack's own count, so a sheet that
		// silently failed to draw would fail here rather than further down as a missing handle.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');

		await page.getByTestId('add-annotation-layer').click();
		await expect(page.getByRole('status')).toHaveText('Saved locally');
		const layerId = await annotationLayerId(page);
		await openLayerRow(page, page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`));
		await waitForStack(page);

		// ⚠ **The lookup answers where the sheet is.** The Project opened framed on the Historical Map
		// (ADR-0026), so this is the one candidate that leaves the sheet under the Pin — and the whole
		// criterion is that the correction is made *against* the Historical Map. A Pin placed in
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
