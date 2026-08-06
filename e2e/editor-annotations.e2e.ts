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

import { expect, test, type Page } from '@playwright/test';

import {
	annotationWrites,
	baseMap,
	chooseTool,
	clickAt,
	drawPin,
	drawShape,
	hashesUnder,
	reopenLayers,
	selectAnnotation,
	paintProperty,
	projectJson,
	renderedAnnotationLayers,
	startAnnotating,
	storedAnnotations,
	watchAnnotationWrites,
	writeProjectFile
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

/** The style property names simplestyle 1.1.0 defines, plus ADR-0009's one extension. */
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

		const painted = await renderedAnnotationLayers(page);
		const stored = await storedAnnotations(page, layerId);
		const [pin, line, shape] = stored.features.map((feature) => feature.id);

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
		await expect(page.getByRole('status')).toHaveText('Saved');

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

		// `down`/`up` rather than `press`, so this is one hold with repeats inside it rather than five
		// separate presses — the keyboard's equivalent of a drag.
		await page.keyboard.down('ArrowRight');
		for (let repeat = 0; repeat < 5; repeat += 1) await page.keyboard.press('ArrowRight');
		await page.keyboard.up('ArrowRight');
		await expect(page.getByRole('status')).toHaveText('Saved');

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
		await expect(page.getByRole('status')).toHaveText('Saved');

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

		await page.getByTestId('annotation-title').fill('Warehouses');
		await page.getByTestId('annotation-title').blur();
		await page.getByTestId('annotation-description').fill('The *west* quay.');
		await page.getByTestId('annotation-description').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

		expect((await storedAnnotations(page, layerId)).features[0]?.properties).toEqual({
			title: 'Warehouses',
			description: 'The *west* quay.'
		});

		await reopenLayers(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await expect(page.getByTestId('annotation-title')).toHaveValue('Warehouses');
		await expect(page.getByTestId('annotation-description')).toHaveValue('The *west* quay.');
	});

	test('the preview renders emphasis and links while typing', async ({ page }) => {
		// The live preview is the deliverable, not a nicety: ADR-0009 chose Markdown, and the preview is
		// what makes it acceptable to a scholar who has never written any.
		await withOnePin(page);
		const preview = page.getByTestId('annotation-preview');

		await page.getByTestId('annotation-description').fill('A *conjectural* route');
		// No blur and no commit: this is asserted *while typing*.
		await expect(preview.locator('em')).toHaveText('conjectural');

		await page
			.getByTestId('annotation-description')
			.fill('See [the survey](https://example.org/s).');
		await expect(preview.locator('a')).toHaveText('the survey');
		await expect(preview.locator('a')).toHaveAttribute('href', 'https://example.org/s');

		await page.getByTestId('annotation-description').fill('**Certainly** the west quay');
		await expect(preview.locator('strong')).toHaveText('Certainly');
	});

	test('footnote syntax renders as literal text, with no anchors and no ids', async ({ page }) => {
		// ADR-0009 defers footnotes and asks the syntax degrade "as behaviour, not accident". Left to
		// `marked` it is neither: `^1` is a legal CommonMark link label, so `[^1]: <url>` really is a link
		// reference definition — it produces no output of its own and turns every `[^1]` into an anchor.
		await withOnePin(page);
		const preview = page.getByTestId('annotation-preview');

		await page
			.getByTestId('annotation-description')
			.fill('A claim[^1] worth noting.\n\n[^1]: https://example.org/note');

		await expect(preview).toContainText('A claim[^1] worth noting.');
		// The definition line is kept as text rather than silently deleted.
		await expect(preview).toContainText('[^1]: https://example.org/note');
		await expect(preview.locator('a')).toHaveCount(0);
		await expect(preview.locator('[id]')).toHaveCount(0);
	});

	test('a description is shown in a popup over the map, rendered', async ({ page }) => {
		const failures = watchFailures(page);
		await withOnePin(page);
		await page.getByTestId('annotation-description').fill('The *west* quay.');
		await page.getByTestId('annotation-description').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

		// Clicking the Annotation on the map is what a reader does, and it is the same popup.
		await clickAt(baseMap(page), 0.4, 0.4);

		const popup = page.locator('.maplibregl-popup');
		await expect(popup).toBeVisible();
		await expect(popup.locator('em')).toHaveText('west');
		expect(failures).toEqual([]);
	});
});

test.describe('a description is untrusted, and this is asserted not assumed (ADR-0009)', () => {
	/**
	 * The payload ticket 13 proved reaches storage byte-identical, plus a `javascript:` link.
	 *
	 * The `javascript:` link is written in **Markdown** syntax deliberately: it contains no HTML, so a
	 * sanitise-then-parse implementation passes it through as inert text and then reconstructs an
	 * `<a href="javascript:…">` out of it. That is the bypass ADR-0009 names, and it is the payload that
	 * distinguishes the two possible orders — an `<img onerror>` is removed in either.
	 */
	const PAYLOAD =
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

	/** Nothing executed, and nothing from the payload reached the document at large. */
	async function nothingRan(page: Page) {
		return page.evaluate(() => ({
			ran: '__xss' in window,
			injectedImage: document.querySelector('img[src="x"]') !== null,
			injectedScript: document.querySelector('script[src], script:not([type])') !== null
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

		const inert = await inertWithin(page, '[data-testid="annotation-list"]');
		expect(inert.missing).toBe(false);
		expect(inert.scripts).toBe(0);
		expect(inert.images).toBe(0);
		expect(inert.svgs).toBe(0);
		expect(inert.handlers).toEqual([]);
		expect(inert.executableUrls).toEqual([]);
		// The payload's text is shown, so the row is not silently blank either.
		expect(inert.text).toContain('onerror');
		expect(await nothingRan(page)).toEqual({
			ran: false,
			injectedImage: false,
			injectedScript: false
		});
		expect(failures).toEqual([]);
	});

	test('the payload is inert in the description preview', async ({ page }) => {
		const failures = watchFailures(page);
		await withPayload(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await expect(page.getByTestId('annotation-preview')).toBeVisible();

		const inert = await inertWithin(page, '[data-testid="annotation-preview"]');
		expect(inert.missing).toBe(false);
		// **First**, that something rendered at all. A blank preview passes every assertion below it, and
		// blank is exactly what a `{@html}` adopted from prerendered output looks like — so the anti-
		// vacuous assertion comes before the security ones rather than after them.
		expect(inert.text).toContain('onerror');
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
		// Both the title and the description are in this popup, so this one assertion covers both fields.
		expect(inert.text).toContain('onerror');
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
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.locator('.maplibregl-popup')).toBeVisible();

		const inert = await inertWithin(page, 'body');
		expect(inert.missing).toBe(false);
		expect(inert.scripts).toBe(0);
		expect(inert.images).toBe(0);
		expect(inert.handlers).toEqual([]);
		expect(inert.executableUrls).toEqual([]);
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

		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await clickAt(baseMap(page), 0.5, 0.5);
		await expect(page.locator('.maplibregl-popup')).toBeVisible();
		// Tab out of the title field, which is the shape ticket 02 got wrong: a blur must not rewrite.
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

		await page.getByTestId('annotation-stroke').fill('#aa3311');
		await page.getByTestId('annotation-stroke-width').fill('4');
		await page.getByTestId('annotation-stroke-opacity').fill('0.5');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;

		expect(properties['stroke']).toBe('#aa3311');
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

		await page.getByTestId('annotation-fill').fill('#223344');
		await page.getByTestId('annotation-fill-opacity').fill('0.25');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;
		expect(properties['fill']).toBe('#223344');
		expect(properties['fill-opacity']).toBe(0.25);
		for (const name of Object.keys(properties)) expect(SIMPLESTYLE_NAMES).toContain(name);
	});

	test('a pin gets marker properties and no line or fill controls', async ({ page }) => {
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await chooseTool(page, 'select');
		await selectAnnotation(page);

		// The union doing its job in the UI: there is no fill on a pin, so there is no control for one.
		await expect(page.getByTestId('annotation-fill')).toHaveCount(0);
		await expect(page.getByTestId('annotation-marker-color')).toHaveCount(1);

		await page.getByTestId('annotation-marker-color').fill('#7e00ff');
		await page.getByTestId('annotation-marker-size').selectOption('large');
		await expect(page.getByRole('status')).toHaveText('Saved');

		const properties = (await storedAnnotations(page, layerId)).features[0]!.properties;
		expect(properties['marker-color']).toBe('#7e00ff');
		expect(properties['marker-size']).toBe('large');
	});

	test('an Annotation drawn with default styling carries no style properties at all', async ({
		page
	}) => {
		// A criterion, not an omission: precedence is what lets a Layer be restyled in bulk, and stamping
		// defaults at creation time would break that on the first thing drawn and make every file several
		// times larger.
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.4);
		await drawShape(page, 'line', [
			[0.5, 0.5],
			[0.7, 0.55]
		]);

		for (const feature of (await storedAnnotations(page, layerId)).features) {
			expect(feature.properties).toEqual({});
		}
		expect(await readAnnotationText(page, layerId)).not.toContain('stroke');
	});

	test('the written file is valid GeoJSON with simplestyle values of the right types', async ({
		page
	}) => {
		const layerId = await withOneLine(page);
		await page.getByTestId('annotation-stroke').fill('#aa3311');
		await page.getByTestId('annotation-stroke-width').fill('3');
		await page.getByTestId('annotation-stroke-opacity').fill('0.8');
		await page.getByTestId('annotation-line-style').selectOption('dotted');
		await expect(page.getByRole('status')).toHaveText('Saved');

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

		// Solid is the default and writes nothing.
		expect((await storedAnnotations(page, layerId)).features[0]!.properties).toEqual({});

		await page.getByTestId('annotation-line-style').selectOption('dashed');
		await expect(page.getByRole('status')).toHaveText('Saved');
		expect((await storedAnnotations(page, layerId)).features[0]!.properties['stroke-dasharray']) //
			.toEqual([8, 4]);

		await page.getByTestId('annotation-line-style').selectOption('dotted');
		await expect(page.getByRole('status')).toHaveText('Saved');
		expect((await storedAnnotations(page, layerId)).features[0]!.properties['stroke-dasharray']) //
			.toEqual([1, 3]);

		// No keyword ever reaches the file — a keyword would be legible only to us (ADR-0009).
		const text = await readAnnotationText(page, layerId);
		for (const keyword of ['"dashed"', '"dotted"', '"solid"']) expect(text).not.toContain(keyword);

		// And going back to solid *removes* the property rather than blanking it.
		await page.getByTestId('annotation-line-style').selectOption('solid');
		await expect(page.getByRole('status')).toHaveText('Saved');
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

		const painted = await renderedAnnotationLayers(page);

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

test.describe('style precedence: properties → Layer defaultStyle → simplestyle (ADR-0009)', () => {
	test('a Layer defaultStyle reaches an Annotation with none of its own, and a property overrides it', async ({
		page
	}) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			JSON.stringify({
				type: 'FeatureCollection',
				features: [
					line('inherits', [4.8, 52.3], [5.0, 52.3], {}),
					line('overrides', [4.8, 52.35], [5.0, 52.35], { stroke: '#ff0000' })
				]
			})
		);
		// The Layer's default, set in `project.json` — which is where display state lives (ADR-0002) and
		// never in the GeoJSON.
		const project = await projectJson(page);
		project.layers[0].defaultStyle = { stroke: '#112233', 'stroke-width': 5 };
		await writeProjectFile(page, 'project.json', JSON.stringify(project, null, '\t'));
		await reopenLayers(page);

		const styles = await page.evaluate(() => {
			const map = window.ballastellaLayerStack?.map;
			const out: Record<string, Record<string, unknown>> = {};
			for (const feature of map?.queryRenderedFeatures() ?? []) {
				const id = feature.properties?.['ballastella:id'];
				if (typeof id === 'string') out[id] = feature.properties;
			}
			return out;
		});

		// The inheriting Annotation draws with the Layer's colour and width.
		expect(styles['inherits']?.['stroke']).toBe('#112233');
		expect(styles['inherits']?.['stroke-width']).toBe(5);
		// The overriding one takes its own colour and keeps the Layer's width — per property, not per
		// object. An object-level fallback would silently discard every other value the Layer carried.
		expect(styles['overrides']?.['stroke']).toBe('#ff0000');
		expect(styles['overrides']?.['stroke-width']).toBe(5);
		// And neither has had the Layer's default stamped into its own file.
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features[0]!.properties).toEqual({});
		expect(stored.features[1]!.properties).toEqual({ stroke: '#ff0000' });
		expect(failures).toEqual([]);
	});

	test('simplestyle’s own defaults apply where neither says anything', async ({ page }) => {
		const failures = watchFailures(page);
		const layerId = await startAnnotating(page);
		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.65, 0.45]
		]);
		const id = (await storedAnnotations(page, layerId)).features[0]!.id;

		const drawnWith = await page.evaluate((id) => {
			const map = window.ballastellaLayerStack?.map;
			for (const feature of map?.queryRenderedFeatures() ?? []) {
				if (feature.properties?.['ballastella:id'] === id) return feature.properties;
			}
			return null;
		}, id);

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
		await expect(page.getByRole('status')).toHaveText('Saved');

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
		await page.getByTestId('annotation-title').fill('Warehouses');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(1);
		await watchAnnotationWrites(page);

		// A whole session of looking: reload, select, open the popup, tab through both text fields, and
		// reorder and rename the Layer itself.
		await reopenLayers(page);
		await chooseTool(page, 'select');
		await selectAnnotation(page);
		await clickAt(baseMap(page), 0.4, 0.4);
		await page.getByTestId('annotation-title').focus();
		await page.getByTestId('annotation-title').blur();
		await page.getByTestId('annotation-description').focus();
		await page.getByTestId('annotation-description').blur();
		await page.getByTestId('layer-name').fill('Trade routes');
		await page.getByTestId('layer-name').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

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
		await page.getByTestId('annotation-title').fill('A');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');
		await page.getByTestId('annotation-title').fill('');
		await page.getByTestId('annotation-title').blur();
		await expect(page.getByRole('status')).toHaveText('Saved');

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

		// Each tool is a real button whose pressed state is announced, not merely drawn.
		for (const tool of ['select', 'point', 'line', 'polygon'] as const) {
			const button = page.getByTestId(`annotation-tool-${tool}`);
			await tabTo(page, button, `the ${tool} tool`);
			await page.keyboard.press('Enter');
			await expect(button).toHaveAttribute('aria-pressed', 'true');
			await expect(page.getByTestId('annotation-status')).toHaveAttribute('data-tool', tool);
		}

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
		await expect(page.getByRole('status')).toHaveText('Saved');
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
		await expect(page.getByRole('status')).toHaveText('Saved');
		const stored = await storedAnnotations(page, layerId);
		expect(stored.features).toHaveLength(2);
		expect(stored.features[1]?.geometry?.type).toBe('LineString');

		// Every style control on the selected Annotation is reachable too.
		await chooseTool(page, 'select');
		await selectAnnotation(page, 1);
		for (const control of [
			'annotation-title',
			'annotation-description',
			'annotation-stroke',
			'annotation-line-style',
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
