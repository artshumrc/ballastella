import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addHistoricalMapButton } from './support/historical-maps.js';
import { alignFromLayer, openLayerRow } from './support/layers.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

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
	expectWarpedDrawn
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

/** Delay only the next matching read, so the replacement workspace can finish loading first. */
async function delayNextReadOf(page: Page, name: string, ms: number): Promise<void> {
	await page.evaluate(
		async ([match, delay]) => {
			const proto = FileSystemFileHandle.prototype;
			const original = proto.getFile;
			let delayed = false;
			proto.getFile = async function (this: FileSystemFileHandle) {
				if (!delayed && this.name === match) {
					delayed = true;
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
	await page.goto('/?p=amsterdam-1625');
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(drawn), {
		timeout: STACK_READY_MS
	});
}

const layerRows = (page: Page) => page.getByTestId('layer-row');

const rowIds = (page: Page): Promise<(string | null)[]> =>
	layerRows(page).evaluateAll((elements) =>
		elements.map((element) => element.getAttribute('data-layer-id'))
	);

/** One Layer's row, by its id, since a reorder moves rows about. */
const rowFor = (page: Page, layerId: string) =>
	page.locator(`[data-testid="layer-row"][data-layer-id="${layerId}"]`);

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
 * **By URL, so this is a reload and a new `EditorSession`** — which is what the callers below want:
 * the resurrection trap has to survive the page being closed and opened again, and a tombstone is the
 * only thing that can carry it there. Anything asserting what survives a *route change* must use the
 * links instead, because a reload throws the undo record away with the session it was held in
 * (ADR-0014 does not persist it). {@link throughLayersAndBack} is that route.
 */
async function openWorkspace(page: Page): Promise<void> {
	await page.goto('/?p=amsterdam-1625');
	// Aligning is `/align/?p=…&layer=…` since ticket 03, and it is entered by the link rather than by a
	// hand-written URL: the route is keyed by Layer id, which this test has no other way to learn. The
	// link is inside the Layer's own row since ticket 05, so the row is opened on the way.
	await alignFromLayer(page);
	await waitForSurface(page);
	await expect(page.getByTestId('pairing-status')).toContainText('Control Point');
}

/**
 * Leave the alignment workspace for the Layers pane and come back, **without reloading the page**.
 *
 * The two in-app links rather than `page.goto`, and that is the whole of the helper: a reload builds a
 * new session and the undo slot goes with it, so a round trip by URL would assert nothing at all about
 * a record surviving. What the round trip does to the workspace is the point — it is destroyed and
 * rebuilt, with a fresh `AlignmentPairing` read from the file, while the record stays where it was.
 *
 * @param resuming how many Control Points the rebuilt pairing must show before it is safe to click
 */
async function throughLayersAndBack(page: Page, resuming: number): Promise<void> {
	// Out of the alignment route onto the Project — which *is* the Layer stack since ticket 04 — and
	// back into aligning. Two in-app links rather than three, and still not one reload, which is the
	// whole of the helper: the undo record has to survive the workspace being destroyed and rebuilt,
	// and the stack being drawn on the way is what destroys it.
	await page.getByTestId('back-to-project').click();
	await expect(addHistoricalMapButton(page)).toBeVisible();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1', {
		timeout: STACK_READY_MS
	});

	await alignFromLayer(page);
	await waitForSurface(page);
	// **The rows are the barrier, not the pane.** `pairing` is `undefined` until the pyramid has been
	// read and the Alignment after it, and the status line reads "…your first Control Point" in the
	// meantime — which contains the same words as the resumed one. A click before the pairing exists is
	// dropped on the floor.
	await expect(controlPointRows(page)).toHaveCount(resuming);
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
	await expectWarpedDrawn(page);
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

	test('ignores a pane that finishes opening after its alignment route was destroyed', async ({
		page
	}) => {
		test.setTimeout(120_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const wasAt = await rowText(page, 1);

		await imagePoints(page).first().focus();
		await page.keyboard.press('Shift+ArrowRight');
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(before);
		expect(await rowText(page, 1)).not.toBe(wasAt);

		await page.getByTestId('back-to-project').click();
		await expect(addHistoricalMapButton(page)).toBeVisible();
		await delayNextReadOf(page, 'info.json', 3000);

		// This workspace starts opening, but is destroyed before its Historical Map pane calls `onpane`.
		await alignFromLayer(page);
		await page.getByTestId('back-to-project').click();
		await expect(addHistoricalMapButton(page)).toBeVisible();

		// A replacement workspace becomes live before the stale pane finishes its delayed read.
		await alignFromLayer(page);
		await waitForSurface(page);
		await expect(controlPointRows(page)).toHaveCount(3);
		await page.waitForTimeout(3500);

		await undoButton(page).click();
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		expect(await rowText(page, 1)).toBe(wasAt);
	});

	/**
	 * The record outlives the component that made it, and reversing it has to act on the pairing that is
	 * on screen **now**.
	 *
	 * `EditorSession.open` returns early for the Project already showing, and `forgetUndoOfOtherImages`
	 * drops a Control Point record only for a *different* Historical Map — so a trip to the Layers pane
	 * and back leaves the pending undo exactly where it was while the workspace builds a fresh
	 * `AlignmentPairing` out of the file. That is the ticket's premise working, and it is also what made
	 * a restore closure that had captured its pairing dangerous: undoing wrote *that* object's whole
	 * Alignment, so a Control Point placed after coming back was deleted out of the file with nothing on
	 * screen moving and the affordance claiming only that a point had been put back.
	 */
	test('reverses the pairing now on screen, keeping a pair made after the round trip', async ({
		page
	}) => {
		test.setTimeout(150_000);
		const imageId = await alignedProject(page);
		const before = await storedAlignment(page, imageId);
		const beforeMove = JSON.parse(before as string);
		const wasAt = await rowText(page, 1);

		const half = imagePoints(page).first();
		await half.focus();
		const wasAtPixel = await half.getAttribute('data-resource-x');
		await page.keyboard.press('Shift+ArrowRight');

		// The destructive change is on disk before anything else happens, as everywhere in this file.
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).not.toBe(before);

		await throughLayersAndBack(page, 3);
		// It survived the route change, which is what makes the rest of this test worth asserting.
		await expect(undoButton(page)).toHaveText('Undo move of Control Point 1');

		// A fourth pair, made after the remount: it exists only in the pairing now on screen, and never
		// existed in the one the record was made on.
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await saved(page);
		const fourth = await rowText(page, 4);

		await undoButton(page).click();
		await saved(page);
		await waitForStored(page, imageId, 4);

		// **Four pairs, not three.** The three originals are the file as it was before the move — so the
		// move really was reversed — and the fourth is untouched beside them.
		const after = JSON.parse((await storedAlignment(page, imageId)) as string);
		expect(after.body.features.slice(0, 3)).toEqual(beforeMove.body.features);
		expect(after.body.features).toHaveLength(4);

		// And on screen, which is the half that was silently not happening: the handle is drawn back at
		// the image pixel it started from, in a list that still has the fourth pair in it.
		await expect(controlPointRows(page)).toHaveCount(4);
		await expect(imagePoints(page).first()).toHaveAttribute(
			'data-resource-x',
			wasAtPixel as string
		);
		expect(await rowText(page, 1)).toBe(wasAt);
		expect(await rowText(page, 4)).toBe(fourth);
		await expect(undoButton(page)).toHaveCount(0);
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

	/**
	 * Which Annotation Layer is being drawn into is a **working choice**, not part of the work, and
	 * nothing stops a user changing it between the deletion and the undo — the picker sits a few
	 * centimetres from the affordance. `AnnotationDeletedUndo` carries the Layer the Annotation was in
	 * "so it cannot be restored into another one", and this is that claim asserted: an undo that read
	 * the chosen Layer instead would take the Annotation out of one `.geojson` and put it into another,
	 * which is not an undo of anything — it is a move into a file the user was not looking at.
	 */
	test('goes back into the Layer it was deleted from, not the one chosen when Undo is pressed', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const routes = await startAnnotating(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);
		// A new Layer goes on top of the stack; the older one is the one drawn into, so it is the one
		// opened before anything is drawn. Since ticket 05 opening a Layer *is* choosing it, so this is
		// the whole of the gesture rather than a click and then a picker.
		const places = (await rowIds(page)).find((id) => id !== routes) as string;
		await openLayerRow(page, rowFor(page, routes));

		await drawPin(page, 0.4, 0.45);
		await selectAnnotation(page);
		await page.getByTestId('annotation-title').fill('Fort Amsterdam');
		await page.getByTestId('annotation-title').blur();
		await saved(page);

		// Both files, so "the other Layer gained nothing" is a claim about bytes rather than about a list.
		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(2);
		const deleted = (await storedAnnotations(page, routes)).features[0];
		const annotationId = deleted?.id as string;

		await page.getByTestId('annotation-delete').click();
		await saved(page);
		expect((await storedAnnotations(page, routes)).features).toHaveLength(0);

		// The gesture the record's `layerId` exists to survive: the *other* Layer is opened, which closes
		// the one the Annotation was deleted from and makes it the Layer being drawn into.
		await openLayerRow(page, rowFor(page, places));
		await expect(page.getByTestId('annotation-list-empty')).toBeVisible();

		await expect(undoButton(page)).toHaveText('Undo delete of “Fort Amsterdam”');
		await undoButton(page).click();
		await saved(page);

		// Byte for byte back where it came from, and the chosen Layer's file is the one it was.
		await expect.poll(() => hashesUnder(page, 'annotations/')).toEqual(before);
		expect((await storedAnnotations(page, places)).features).toHaveLength(0);
		const back = (await storedAnnotations(page, routes)).features[0];
		expect(back?.id).toBe(annotationId);
		expect(back?.properties).toEqual(deleted?.properties);

		// The sidebar followed the record — the Layer the Annotation came from is the one now open — so
		// the user *watches* it come back rather than being told it happened somewhere they are not
		// looking. Asserted on `aria-expanded`, which is what the app promises a screen reader.
		await expect(rowFor(page, routes).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await expect(rowFor(page, places).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
		await expect(page.getByTestId('undo-refused')).toHaveText('');
		const restored = await waitForPaintedAnnotations(page, [annotationId]);
		expect(restored[annotationId]?.length ?? 0).toBeGreaterThan(0);
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
		// At the Workspace root (ADR-0023), which is what makes the claim below a claim about ADR-0023
		// rather than about undo: deleting the Layer must leave the Historical Map and its Alignment where
		// they are, because another Project may be drawing them (SPEC story 67).
		const before = await hashesUnder(page, 'alignments/', '');
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
		// **And the Alignment is still there.** It belongs to the Workspace and may place this map for
		// another Project, so a Layer delete takes nothing with it — which is the opposite of what this
		// assertion said before ADR-0023.
		expect(await hashesUnder(page, 'alignments/', '')).toEqual(before);
		// Off the map, asked of MapLibre: there is no longer a layer that could paint it.
		await expect.poll(() => stackOrder(page)).not.toContain(`ballastella-layer-${mapLayer}`);

		await expect(undoButton(page)).toHaveText('Undo delete of the Layer “la-floride.png”');
		await undoButton(page).click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		// The Alignment, still byte for byte what it was — untouched throughout — and the entry back,
		// field for field, at its own position.
		expect(await hashesUnder(page, 'alignments/', '')).toEqual(before);
		expect((await projectJson(page)).layers).toEqual(layersBefore);
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
 * The trap ticket 09's review recorded, **closed by construction in ticket 02** (ADR-0023).
 *
 * `EditorSession` used to bring a map Layer into existence on every Alignment write, so "is there a
 * Layer for this Alignment?" was not an idempotence key a deletion could survive: deleting a map Layer
 * and then writing the Alignment again recreated it, with a fresh id and at the top of the stack, and
 * undo could not help because nothing had been undone. `ProjectFile.removedMapLayers` was the record
 * that stopped it.
 *
 * A Layer is now created by exactly one thing — the user adding a Historical Map to a Project — so the
 * record is gone and these tests assert the property directly rather than the record: **no Alignment
 * write, in this session or a later one, touches the Layer stack at all.**
 */
test.describe('a deleted map Layer does not come back (the resurrection trap)', () => {
	/*
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE TEST THAT USED TO BE FIRST HERE, AND WHY THERE IS NOTHING LEFT FOR IT TO DRIVE
	 *
	 * "Delete the map Layer, then write the Alignment again" was the reproduction. Ticket 02 closed it
	 * in the model — only adding a Historical Map makes a Layer — and ticket 03 closed the *gesture* as
	 * well: aligning is `/align/?p=…&layer=…`, keyed by Layer id, so a Historical Map with no Layer in
	 * this Project has no alignment view to be on. There is no click sequence that writes an Alignment
	 * for a map this Project does not draw, so the test could only be kept by driving something the
	 * interface does not offer.
	 *
	 * What it asserted is still asserted, by the two tests below: the stack survives an Alignment write
	 * with the Layer restored, and a whole pairing session leaves `project.json` byte for byte.
	 *
	 * **What is genuinely no longer covered end to end** is the cross-Project form, which *is* reachable
	 * and is new with ADR-0023: two Projects draw one Workspace map, the Layer is deleted in Project A,
	 * and Project B goes on aligning it. Nothing should reach Project A's stack. It is left here as a
	 * named gap rather than a test, because it needs a second Project with a second ingest and belongs
	 * beside the other Workspace-sharing specs rather than in the undo file.
	 */

	/**
	 * And undoing the deletion has to leave the *opposite* invariant in place: one Layer, the original
	 * one, with a later Alignment write adding nothing. `parseLayers` drops a duplicate id (ticket 09's
	 * remediation), so a second Layer for the same image would produce a document whose next read loses
	 * one of the two.
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
		// The Alignment was never removed — it is the Workspace's, not this Project's (ADR-0023) — so the
		// workspace resumes the three pairs rather than starting from nothing.
		await expect(controlPointRows(page)).toHaveCount(3);
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await saved(page);

		expect((await projectJson(page)).layers).toEqual([layerBefore]);
	});

	/**
	 * The strongest form of the same claim, and the one that catches a Layer being *renamed* or
	 * *reordered* rather than created: a whole pairing session leaves `project.json` byte-identical.
	 *
	 * This is where the old race lived — `#ensureMapLayer` asked "is there a Layer?" and then `await`ed
	 * a read of the image's `manifest.json` for the name, so two Alignment writes in flight could each
	 * see no Layer and each add one. The read is still delayed here, so the window is still as wide as
	 * it ever was; there is simply nothing in it any more. Byte identity is what makes that a real
	 * assertion rather than a count that a rewrite of the same content would satisfy — ADR-0010, and
	 * the reason `updatedAt` must not move for an edit that is not to the document.
	 *
	 * **The delayed read is honestly inert, and the assertion is not.** Nothing on the pairing path
	 * reads `manifest.json` any more, so `delayReadsOf` widens a window that no longer has anything in
	 * it; it is kept because it costs one line and because a future re-introduction of a read there is
	 * precisely what this should catch. What carries the test is the byte comparison, which goes red
	 * the moment anything at all writes `project.json` during a pairing session — that is the claim,
	 * and it is the claim ticket 03 could most easily have broken by making the route create a Layer.
	 */
	test('a whole pairing session leaves project.json byte-identical', async ({ page }) => {
		test.setTimeout(120_000);
		await start(page);
		await saved(page);
		// The Layer is already there: adding the Historical Map is what put it in the stack (ADR-0023),
		// before any Control Point exists.
		const before = await readProjectFile(page, 'project.json');
		expect(JSON.parse(before).layers).toHaveLength(1);

		await delayReadsOf(page, 'manifest.json', 1500);

		// Two completed pairs in quick succession, the second landing inside the first's manifest read.
		await clickAt(historicalMap(page), 0.3, 0.3);
		await clickAt(page.getByTestId('base-map-pane'), 0.3, 0.3);
		await clickAt(historicalMap(page), 0.7, 0.35);
		await clickAt(page.getByTestId('base-map-pane'), 0.7, 0.35);
		await expect(controlPointRows(page)).toHaveCount(2);

		await page.waitForTimeout(3000);
		await saved(page);

		expect(await readProjectFile(page, 'project.json')).toBe(before);
		// And the count the interface shows agrees. On the Project page since ticket 03: this test now
		// runs on `/align/`, which has no Layer count on it, so the trip back is what puts the assertion
		// in front of the number a user would actually read.
		await page.getByTestId('back-to-project').click();
		await expect(page.getByTestId('layer-row')).toHaveCount(1);
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
