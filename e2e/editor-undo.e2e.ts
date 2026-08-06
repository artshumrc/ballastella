import { expect, test, type Page } from '@playwright/test';

import {
	clickAt,
	historicalMap,
	imagePoints,
	makePairs,
	rows as controlPointRows,
	start,
	storedAlignment,
	waitForStored,
	waitForSurface,
	warpedStatus
} from './support/alignment-workspace.js';
import {
	annotationLayerId,
	drawPin,
	drawShape,
	hashesUnder,
	projectJson,
	readProjectFile,
	reopenLayers,
	selectAnnotation,
	startAnnotating,
	storedAnnotations,
	waitForPaintedAnnotations,
	waitForStack
} from './support/annotations.js';

/**
 * SPEC's Seam 2 for single-level undo (story 38, ADR-0014): the four destructive actions undone in the
 * running app, **after autosave has already written each of them to disk**.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY EVERY TEST HERE WAITS FOR "SAVED" BEFORE PRESSING UNDO
 *
 * It is the criterion, not caution. With ADR-0017's sub-second per-file debounce, the deletion *is*
 * the last saved state by the time a user reaches for undo — so an implementation that reverts to the
 * last saved state passes a naive test and fails every one of these. Each test therefore does three
 * things in order: waits for the indicator, reads the file and asserts the destructive change is
 * really in it, and only then undoes. Weakening any of those three makes the suite pass with the
 * behaviour broken, which is the whole failure this ticket exists to prevent.
 *
 * The assertions are on **the bytes in OPFS and what the page rendered**, never on the undo record's
 * internals: undo is state-heavy and almost entirely invisible, which is exactly the shape that
 * produces a green test over a broken feature. Byte identity is the strongest form available — a
 * restored `alignments/*.json` or `annotations/*.geojson` has to be the file that was deleted, not a
 * re-serialisation of a parsed model that is merely equivalent (the same bar ticket 09 set for display
 * state).
 */

/** The undo affordance. Absent, not disabled, when there is nothing to undo. */
const undoButton = (page: Page) => page.getByTestId('undo');

/**
 * MapLibre's own account of which Layers of this stack are on the map, in drawing order.
 *
 * **The mechanism rather than the app's account of it.** `getLayersOrder()` *is* how one Layer draws
 * above another, so "the deleted Layer is off the map" and "the restored one is back on it" are read
 * from MapLibre — not from the page's `data-drawn`, which is the app's own bookkeeping and therefore
 * the thing a test should not lean on when what is being asserted is a deletion.
 *
 * A local cast rather than a `declare global`, for the reason `support/annotations.ts` records: two
 * files declaring the same window property have to agree exactly, and a cast per call site costs less
 * than churning a green file's types.
 */
const stackOrder = async (page: Page): Promise<string[]> =>
	(
		await page.evaluate(
			() =>
				(
					window as unknown as { ballastellaLayerStack?: { map: { getLayersOrder(): string[] } } }
				).ballastellaLayerStack?.map.getLayersOrder() ?? []
		)
	).filter((id) => id.startsWith('ballastella-layer-'));

const saved = (page: Page) => expect(page.getByRole('status')).toHaveText('Saved');

/**
 * Hold up every read of a file called `name` by `ms`, widening a window the machine usually closes.
 *
 * A check-then-act separated by an `await` is a race whether or not the await is usually fast, and a
 * test that depends on it being slow is a test that passes by luck.
 */
async function delayReadsOf(page: Page, name: string, ms: number): Promise<void> {
	await page.evaluate(
		async ([match, delay]) => {
			const proto = FileSystemFileHandle.prototype;
			const original = proto.getFile;
			proto.getFile = async function (this: FileSystemFileHandle) {
				if (this.name === match) {
					await new Promise((resolve) => setTimeout(resolve, delay as number));
				}
				return original.call(this);
			};
		},
		[name, ms] as const
	);
}

/** How long the Layer stack may take to reach the map — a whole Base Map style, then a warped map. */
const STACK_READY_MS = 20_000;

/** Open the Layers pane and wait until `drawn` Layers have been put on the map. */
async function openLayers(page: Page, drawn: number): Promise<void> {
	await page.goto('/layers?p=amsterdam-1625');
	await expect(page.getByRole('heading', { level: 1, name: 'Layers' })).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(drawn), {
		timeout: STACK_READY_MS
	});
}

const layerRows = (page: Page) => page.getByTestId('layer-row');

const rowIds = (page: Page): Promise<(string | null)[]> =>
	layerRows(page).evaluateAll((elements) =>
		elements.map((element) => element.getAttribute('data-layer-id'))
	);

/** The coordinates a Control Point row shows, which is what the file holds rounded for reading. */
const rowText = (page: Page, ordinal: number): Promise<string> =>
	page
		.getByTestId('control-point-row')
		.nth(ordinal - 1)
		.locator('code')
		.innerText();

/**
 * Load the alignment workspace on this Project, and wait until a click on it would land.
 *
 * **The wait is the point, not the navigation.** `pairing` does not exist until the pyramid has been
 * read and reported through `onpane`, and a click before then is dropped on the floor — which shows up
 * as `makePair` timing out on the pending state, indistinguishable from a broken pairing. The pairing
 * status is the barrier `start` uses for exactly this reason: it renders only once the Alignment has
 * been read.
 *
 * **Navigated by URL rather than by the in-app "Back to this Project" link**, which is not a
 * convenience: leaving the Layers pane while a map Layer is drawn currently throws
 * `Cannot read properties of undefined (reading 'getLayer')` out of the stack's teardown and kills the
 * next page's effects, so the workspace sits at "Opening the Historical Map…" for ever. It reproduces
 * with no undo involved (show a Layer, hide it, show it, follow the link), so it is a Layers-pane
 * lifecycle defect rather than this ticket's — recorded on ticket 11's findings, and another agent owns
 * that path.
 */
async function openWorkspace(page: Page): Promise<void> {
	await page.goto('/?p=amsterdam-1625');
	await waitForSurface(page);
	await expect(page.getByTestId('pairing-status')).toContainText('Control Point');
}

/**
 * A Project with one aligned Historical Map: three pairs, written, and drawn warped.
 *
 * @returns the image id, which is the Alignment's file name
 */
async function alignedProject(page: Page): Promise<string> {
	const imageId = await start(page);
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', 'drawn');
	await saved(page);
	return imageId;
}

test.describe('a moved Control Point (SPEC story 38)', () => {
	/**
	 * The gesture ADR-0014 refuses to ship without an undo of: the easiest thing in the application to
	 * mis-aim, on a WebGL canvas where "where was it before?" cannot be recovered by looking.
	 */
	test('goes back to exactly where it was, undone after the indicator says Saved', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const wasAt = await rowText(page, 1);

		const half = imagePoints(page).first();
		await half.focus();
		// The image pixel the handle claims to be drawn at, which the pane puts in the element itself —
		// the same value the marker is positioned from, so it is the drawn position rather than a report
		// of state. A bounding box would say the same thing less reliably: the affordance is in the page
		// header, so pressing it scrolls the panes.
		const wasAtPixel = await half.getAttribute('data-resource-x');
		const box = await half.boundingBox();
		// One key-hold is one gesture and therefore one record (ADR-0017 rule 1). Two presses would be
		// two, and undo would restore the *second* one's prior value — which is one level working as
		// specified, and would make the byte-identity assertion below wrong rather than the code.
		await page.keyboard.press('Shift+ArrowRight');

		// **The destructive change is on disk before undo is pressed.** Without this the test would pass
		// against an implementation that merely re-reads the last saved state, which is the one thing
		// this criterion exists to rule out.
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(before);
		// It really moved on screen, not merely in the file.
		const moved = await half.boundingBox();
		expect((moved?.x ?? 0) - (box?.x ?? 0)).toBeGreaterThan(5);
		expect(await half.getAttribute('data-resource-x')).not.toBe(wasAtPixel);

		// The affordance names what it will reverse. A bare "Undo" does not answer the user's question.
		await expect(undoButton(page)).toHaveText('Undo move of Control Point 1');
		await undoButton(page).click();

		// Byte-identical, which is stronger than "the coordinates are close": the file the undo wrote is
		// the file the move overwrote.
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		// And on screen, which is what the user is actually promised: the handle is drawn at the image
		// pixel it was drawn at before the gesture, and the list reads the same as it did.
		await expect(half).toHaveAttribute('data-resource-x', wasAtPixel as string);
		expect(await rowText(page, 1)).toBe(wasAt);

		// One level, not a stack: a second undo does nothing, and is not offered.
		await expect(undoButton(page)).toHaveCount(0);
		await expect(page.getByTestId('undo-done')).toHaveText('Undone: move of Control Point 1.');
		await page.keyboard.press('Control+z');
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
	});
});

test.describe('a deleted Control Point pair (SPEC story 38)', () => {
	/**
	 * The ordinal is derived from the pair's position in the file and is stored nowhere (ADR-0022), so
	 * "restores the pair with its original ordinal" is a claim about *where* it goes back — and the
	 * numbers a user reads on the map and in the list are the only place that shows.
	 */
	test('comes back with its original ordinal, undone by keyboard after Saved', async ({ page }) => {
		test.setTimeout(90_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const second = await rowText(page, 2);
		const third = await rowText(page, 3);

		await page.getByTestId('control-point-delete').nth(1).click();
		await expect(controlPointRows(page)).toHaveCount(2);
		// The renumbering that makes this criterion worth asserting: what was point 3 is now point 2.
		expect(await rowText(page, 2)).toBe(third);

		await saved(page);
		await waitForStored(page, imageId, 2);
		await expect(undoButton(page)).toHaveText('Undo delete of Control Point 2');

		// The standard shortcut, from wherever the user's hands are — here the document rather than the
		// affordance, because a deleted handle has taken the focus with it.
		await page.keyboard.press('Control+z');

		await expect(controlPointRows(page)).toHaveCount(3);
		expect(await rowText(page, 2)).toBe(second);
		expect(await rowText(page, 3)).toBe(third);
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		await expect(undoButton(page)).toHaveCount(0);
	});
});

test.describe('a deleted Annotation (SPEC stories 38 and 66)', () => {
	/**
	 * `stroke-dasharray` is the property named in the criterion, and for a reason: **solid is the
	 * property being absent** (ADR-0009). An undo that rebuilt the Annotation from the editor's current
	 * values rather than from what was deleted would turn a dotted conjectural route into a solid
	 * certain one — a change of scholarly claim, silently.
	 */
	test('comes back with every property, and painted again', async ({ page }) => {
		test.setTimeout(90_000);
		const layerId = await startAnnotating(page);
		// A line rather than a pin, because `stroke-dasharray` is what the criterion names and a pin has
		// no line style to set — a conjectural route is exactly the case where the property carries the
		// scholarly claim.
		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.5, 0.5],
			[0.62, 0.45]
		]);
		await selectAnnotation(page);
		await page.getByTestId('annotation-title').fill('Fort Amsterdam');
		await page.getByTestId('annotation-title').blur();
		await page.getByTestId('annotation-line-style').selectOption('dotted');
		await saved(page);

		const before = await readProjectFile(page, `annotations/${layerId}.geojson`);
		const deleted = (await storedAnnotations(page, layerId)).features[0];
		expect(deleted?.properties['stroke-dasharray']).toEqual([1, 3]);
		const annotationId = deleted?.id as string;

		await page.getByTestId('annotation-delete').click();
		await saved(page);
		// On disk, before the undo: the file the user would have been left with.
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);

		await expect(undoButton(page)).toHaveText('Undo delete of “Fort Amsterdam”');
		await undoButton(page).click();
		await saved(page);

		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).toBe(before);
		const back = (await storedAnnotations(page, layerId)).features[0];
		expect(back?.properties).toEqual(deleted?.properties);
		expect(back?.geometry).toEqual(deleted?.geometry);
		// And it is on the map again, which is the half no assertion about state can see.
		const painted = await waitForPaintedAnnotations(page, [annotationId]);
		expect(painted[annotationId]?.length ?? 0).toBeGreaterThan(0);
		await expect(undoButton(page)).toHaveCount(0);
	});
});

test.describe('a deleted Layer (SPEC stories 38 and 49)', () => {
	/**
	 * The case the ticket calls the one where the loss is largest, and the one the delete button could
	 * not exist without: deleting a map Layer deletes the Alignment it draws, so undo has to put a file
	 * back — byte for byte, not a re-serialisation that happens to parse the same.
	 */
	test('restores the project.json entry and the Alignment byte-for-byte', async ({ page }) => {
		test.setTimeout(120_000);
		await alignedProject(page);
		await openLayers(page, 1);
		// A second Layer, so the map Layer is not at the top: restoring it anywhere but its own position
		// would discard the user's ordering, which is display state ADR-0002 makes load-bearing.
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		const [annotationLayer, mapLayer] = (await rowIds(page)) as [string, string];
		const before = await hashesUnder(page, 'alignments/');
		expect(before).toHaveLength(1);
		const layersBefore = (await projectJson(page)).layers;
		expect(await stackOrder(page)).toContain(`ballastella-layer-${mapLayer}`);

		await layerRows(page).nth(1).getByTestId('layer-delete').click();
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);

		// The deletion reached storage: no entry, and no file. Asserted *before* the undo, so the undo
		// below cannot be satisfied by a revert to the last saved state.
		const during = await projectJson(page);
		expect(during.layers.map((layer: { id: string }) => layer.id)).toEqual([annotationLayer]);
		expect(during.removedMapLayers).toEqual([layersBefore[1].alignmentRef]);
		expect(await hashesUnder(page, 'alignments/')).toEqual([]);
		// Off the map, asked of MapLibre: there is no longer a layer that could paint it.
		await expect.poll(() => stackOrder(page)).not.toContain(`ballastella-layer-${mapLayer}`);

		await expect(undoButton(page)).toHaveText('Undo delete of the Layer “la-floride.png”');
		await undoButton(page).click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		// The file, byte for byte — the criterion — and the entry, field for field, at its own position.
		expect(await hashesUnder(page, 'alignments/')).toEqual(before);
		expect((await projectJson(page)).layers).toEqual(layersBefore);
		// The tombstone is lifted with the Layer, so the two can never both be true.
		expect((await projectJson(page)).removedMapLayers).toBeUndefined();
		expect(await rowIds(page)).toEqual([annotationLayer, mapLayer]);
		// And it is on the map again, which is the only honest signal that the restored file is usable:
		// the warped renderer was given the bytes the undo wrote and made a layer out of them.
		await expect
			.poll(() => stackOrder(page), { timeout: STACK_READY_MS })
			.toContain(`ballastella-layer-${mapLayer}`);
		await expect(undoButton(page)).toHaveCount(0);
	});

	// The other file kind. An Annotation Layer's `FeatureCollection` is the user's scholarship rather
	// than a placement, so losing it to a mis-aimed click is the worst of the four.
	test('restores an Annotation Layer’s FeatureCollection byte-for-byte, with what was in it', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.4, 0.45);
		await selectAnnotation(page);
		await page.getByTestId('annotation-title').fill('Trade route');
		await page.getByTestId('annotation-title').blur();
		await saved(page);
		const before = await hashesUnder(page, 'annotations/');
		const annotationId = (await storedAnnotations(page, layerId)).features[0]?.id as string;

		await layerRows(page).first().getByTestId('layer-delete').click();
		await expect(layerRows(page)).toHaveCount(0);
		await saved(page);
		expect(await hashesUnder(page, 'annotations/')).toEqual([]);
		expect((await projectJson(page)).layers).toEqual([]);

		await undoButton(page).click();
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);

		expect(await hashesUnder(page, 'annotations/')).toEqual(before);
		expect(await annotationLayerId(page)).toBe(layerId);
		// The Annotation inside it is back on the map, which no assertion about `project.json` can see.
		await waitForStack(page);
		const painted = await waitForPaintedAnnotations(page, [annotationId]);
		expect(painted[annotationId]?.length ?? 0).toBeGreaterThan(0);
	});
});

/**
 * The trap ticket 09's review recorded rather than left to be discovered.
 *
 * `EditorSession` brings a map Layer into existence on **every** Alignment write, so "is there a Layer
 * for this Alignment?" is not an idempotence key a deletion can survive: without a tombstone, deleting
 * a map Layer and then writing the Alignment again recreates it with a fresh id, a fresh name, and at
 * the top of the stack — and undo cannot help, because nothing was undone and a Layer was legitimately
 * created.
 */
test.describe('a deleted map Layer does not come back (the resurrection trap)', () => {
	test('survives an Alignment write, and survives one in a later session', async ({ page }) => {
		test.setTimeout(150_000);
		const imageId = await alignedProject(page);
		await openLayers(page, 1);
		const deletedRef = (await projectJson(page)).layers[0].alignmentRef;

		await layerRows(page).first().getByTestId('layer-delete').click();
		await expect(layerRows(page)).toHaveCount(0);
		await saved(page);
		expect((await projectJson(page)).removedMapLayers).toEqual([deletedRef]);

		// Back to the alignment workspace and an Alignment write — the exact gesture that resurrected the
		// Layer before the tombstone existed.
		await openWorkspace(page);
		await makePairs(page, 1);
		await waitForStored(page, imageId, 1);
		await saved(page);

		expect((await projectJson(page)).layers).toEqual([]);
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (0)');

		// **And in a later session**, which is the half that needs the record to be in the file rather
		// than in memory: a reload throws away everything the running page knew.
		await openWorkspace(page);
		await makePairs(page, 2);
		await waitForStored(page, imageId, 2);
		await saved(page);

		expect((await projectJson(page)).layers).toEqual([]);
		await expect(page.getByTestId('open-layers')).toHaveText('Layers (0)');
	});

	/**
	 * And undoing the deletion has to leave the *opposite* invariant in place: one Layer, the original
	 * one, with a later Alignment write adding nothing. `parseLayers` drops a duplicate id (ticket 09's
	 * remediation), so a restore that raced the ensure would produce a document whose next read loses a
	 * Layer.
	 */
	test('is put back by undo, and one Alignment write later there is still exactly one', async ({
		page
	}) => {
		test.setTimeout(150_000);
		const imageId = await alignedProject(page);
		await openLayers(page, 1);
		const layerBefore = (await projectJson(page)).layers[0];

		await layerRows(page).first().getByTestId('layer-delete').click();
		await expect(layerRows(page)).toHaveCount(0);
		await saved(page);
		await undoButton(page).click();
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);
		expect((await projectJson(page)).layers).toEqual([layerBefore]);

		await openWorkspace(page);
		// The restored Alignment is readable, so the workspace resumes the three pairs rather than
		// starting from nothing — the property byte-identity is *for*.
		await expect(controlPointRows(page)).toHaveCount(3);
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await saved(page);

		const after = await projectJson(page);
		expect(after.layers).toHaveLength(1);
		expect(after.layers[0].id).toBe(layerBefore.id);
		expect(after.removedMapLayers).toBeUndefined();
	});

	/**
	 * The same method's other defect: it asks "is there a Layer?" and then `await`s a read of the
	 * image's `manifest.json` for the Layer's name, so two Alignment writes in flight could each see no
	 * Layer and each add one — two rows and two `WarpedMapLayer`s fetching the same pyramid.
	 *
	 * Driven by widening the window rather than by luck: the window is real at any speed.
	 */
	test('two Alignment writes in flight produce one Layer, not two', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		await delayReadsOf(page, 'manifest.json', 1500);

		// Two completed pairs in quick succession, the second landing inside the first's manifest read.
		await clickAt(historicalMap(page), 0.3, 0.3);
		await clickAt(page.getByTestId('base-map-pane'), 0.3, 0.3);
		await clickAt(historicalMap(page), 0.7, 0.35);
		await clickAt(page.getByTestId('base-map-pane'), 0.7, 0.35);
		await expect(controlPointRows(page)).toHaveCount(2);

		await page.waitForTimeout(3000);
		await saved(page);

		await expect(page.getByTestId('open-layers')).toHaveText('Layers (1)');
		expect((await projectJson(page)).layers).toHaveLength(1);
	});
});

test.describe('what the one undo slot will and will not hold (ADR-0014)', () => {
	/**
	 * The fence. Toggling visibility, renaming, and reordering are non-destructive or trivially
	 * reversible by repeating them, so they must not consume the slot — otherwise a user who deletes
	 * something and then adjusts anything at all has quietly lost their way back.
	 */
	test('a visibility toggle and a rename leave the delete still undoable', async ({ page }) => {
		test.setTimeout(90_000);
		await startAnnotating(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);
		const [top, bottom] = (await rowIds(page)) as [string, string];

		await layerRows(page).nth(1).getByTestId('layer-delete').click();
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);
		const label = 'Undo delete of the Layer “Annotations 1”';
		await expect(undoButton(page)).toHaveText(label);

		// Two edits that are not destructive, both of them written.
		await layerRows(page).first().getByTestId('layer-visible').uncheck();
		await layerRows(page).first().getByTestId('layer-name').fill('Trade routes');
		await layerRows(page).first().getByTestId('layer-name').blur();
		await saved(page);

		// Still offered, still naming the deletion, and still able to carry it out.
		await expect(undoButton(page)).toHaveText(label);
		await undoButton(page).click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		expect(await rowIds(page)).toEqual([top, bottom]);
		// The non-destructive edits were not undone either: undo is one action, not a rollback.
		const layers = (await projectJson(page)).layers;
		expect(layers[0].name).toBe('Trade routes');
		expect(layers[0].visible).toBe(false);
	});

	// ADR-0014: the record does not persist. Closing the Project is where it goes.
	test('the record is cleared when the Project is closed', async ({ page }) => {
		test.setTimeout(90_000);
		await startAnnotating(page);
		await drawPin(page, 0.5, 0.5);
		await selectAnnotation(page);
		await page.getByTestId('annotation-delete').click();
		await saved(page);
		await expect(undoButton(page)).toHaveCount(1);

		// Out to the hub, which is what closing a Project is (ADR-0008: it is selected by `?p=`).
		await page.getByRole('link', { name: 'Back to all Projects' }).first().click();
		await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
		await expect(undoButton(page)).toHaveCount(0);

		await reopenLayers(page);
		await expect(undoButton(page)).toHaveCount(0);
	});

	/**
	 * ADR-0016 makes the keyboard path the contract. Both routes are asserted: the shortcut is used in
	 * the Control Point tests above, and here the *visible control* is reached by pressing Tab — which
	 * is what "reachable by keyboard" means, rather than calling `focus()` and pretending.
	 */
	test('the visible control is reachable with the keyboard and operable from there', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.5, 0.5);
		await selectAnnotation(page);
		await page.getByTestId('annotation-delete').click();
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);

		for (let press = 0; press < 200; press += 1) {
			if (await undoButton(page).evaluate((element) => element === document.activeElement)) break;
			await page.keyboard.press('Tab');
		}
		await expect(undoButton(page)).toBeFocused();

		await page.keyboard.press('Enter');
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
	});

	/**
	 * The shortcut must not take a text field's own undo away. Editing a title is deliberately *not*
	 * one of the four covered actions, so Ctrl+Z there has to keep meaning what the browser means by
	 * it — and must not put back a Control Point the user was not thinking about.
	 */
	test('Ctrl+Z inside a text field is the field’s own undo, not ours', async ({ page }) => {
		test.setTimeout(90_000);
		const layerId = await startAnnotating(page);
		await drawPin(page, 0.5, 0.5);
		await drawPin(page, 0.6, 0.55);
		await selectAnnotation(page, 1);
		await page.getByTestId('annotation-delete').click();
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		const name = layerRows(page).first().getByTestId('layer-name');
		await name.click();
		await name.press('Control+z');

		// Ours did not fire: the Annotation is still deleted and the affordance is still offered.
		await expect(undoButton(page)).toHaveCount(1);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
	});
});
