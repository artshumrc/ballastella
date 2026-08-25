import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addMapImageButton } from './support/map-images.js';
import { alignFromLayer, deleteLayerRow, openLayerRow } from './support/layers.js';

test.beforeEach(async ({ page }) => routeBaseMapArchive(page));

import {
	clickAt,
	emptyWorkspace,
	mapImage,
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
	chooseLineStyle,
	deleteAnnotation,
	drawPin,
	drawShape,
	editAnnotationText,
	hashesUnder,
	inspector,
	projectJson,
	readProjectFile,
	reopenLayers,
	renderedAnnotationLayers,
	selectAnnotation,
	startAnnotating,
	storedAnnotations,
	waitForPaintedAnnotations,
	waitForStack,
	writeProjectFile
} from './support/annotations.js';
import { restoreWorkspace, snapshotWorkspace } from './support/workspace-snapshot.js';

/**
 * SPEC's Seam 2 for the Edit History of a screen (ADR-0039): gestures walked back and forward in the
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
 * behaviour broken, which is the whole failure this suite exists to prevent.
 *
 * The assertions are on **the bytes in OPFS and what the page rendered**, never on a Step's internals:
 * undo is state-heavy and almost entirely invisible, which is exactly the shape that produces a green
 * test over a broken feature. Byte identity is the strongest form available — a restored
 * `alignments/*.json` or `annotations/*.geojson` has to be the file that was deleted, not a
 * re-serialisation of a parsed model that is merely equivalent (the same bar ticket 09 set for display
 * state).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THE TWO ALIGNMENT ROUND-TRIP TESTS ARE FOR
 *
 * "ignores a pane that finishes opening after its alignment route was destroyed" and "walks back
 * through a pair made after a round trip to the move behind it" are bugs somebody has already paid
 * for: the single-level undo held a restore closure over the `AlignmentPairing` the gesture happened
 * on, and a route change built a new one — so undo wrote a superseded object's whole Alignment, with
 * nothing on screen moving. Byte Steps make that unrepresentable, because a Step holds the file either
 * side of one gesture and there is no pairing instance in it to go stale. These two are what prove it.
 */

/**
 * The Edit History's two controls, drawn for whatever history the screen on show declares (ADR-0039).
 *
 * Each is absent, not disabled, when its end of the history is empty — so `toHaveCount(0)` is the
 * assertion for "there is nothing to undo here", and it is also the assertion for "this screen has no
 * Edit History at all", which is the same thing as far as the bar is concerned.
 */
const editHistoryUndo = (page: Page) => page.getByTestId('edit-history-undo');
const editHistoryRedo = (page: Page) => page.getByTestId('edit-history-redo');

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

const saved = (page: Page) => expect(page.getByRole('status')).toHaveText('Saved locally');

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
 * links instead, because a reload throws every Edit History away with the session it was held in
 * (ADR-0039 does not persist one). {@link throughLayersAndBack} is that route.
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
 * new session and every Edit History goes with it, so a round trip by URL would assert nothing at all
 * about a history surviving. What the round trip does to the workspace is the point — it is destroyed
 * and rebuilt, with a fresh `AlignmentPairing` read from the file, while the Steps stay where they
 * were: a history is keyed by Map Image and outlives the screen that draws it (ADR-0039).
 *
 * @param resuming how many Control Points the rebuilt pairing must show before it is safe to click
 */
async function throughLayersAndBack(page: Page, resuming: number): Promise<void> {
	// Out of the alignment route onto the Project — which *is* the Layer stack since ticket 04 — and
	// back into aligning. Two in-app links rather than three, and still not one reload, which is the
	// whole of the helper: the Steps have to survive the workspace being destroyed and rebuilt, and
	// the stack being drawn on the way is what destroys it.
	await page.getByTestId('back-to-project').click();
	await expect(addMapImageButton(page)).toBeVisible();
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
 * A Project with one aligned Map Image: three pairs, written, and drawn warped.
 *
 * **The recorded journey.** This is what every aligned test in this file used to run for itself, and
 * it is still what runs on the first test through a cold worker; {@link alignedWorkspace} keeps the
 * files it produced and replays them after that. Kept as its own function so what gets recorded stays
 * a real user journey rather than something inferred from a cache format.
 */
async function alignedProjectThroughTheInterface(
	page: Page
): Promise<{ imageId: string; layerId: string }> {
	const imageId = await start(page);
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	await expectWarpedDrawn(page);
	await saved(page);
	const layer = (await projectJson(page)).layers.find(
		(entry: { kind: string }) => entry.kind === 'map'
	);
	return { imageId, layerId: layer.id as string };
}

/**
 * Replay a Workspace this build's own interface once produced, instead of producing it again.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ NOTHING IN THIS FILE IS ABOUT INGESTING AN IMAGE OR ABOUT MAKING A CONTROL POINT PAIR.         │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Every test here is about undo. The pyramid, the Annotation Layer and the three pairs are the ground
 * a destructive action is performed on, and building them through two live map panes per test — a
 * Base Map load, three click-pairs and a warped solve — was the largest cost in the file.
 *
 * `workspace-snapshot.ts` carries the full argument for why the fixture is a **recording** rather
 * than a literal or a construction from `core`'s own functions, and it is the argument this file
 * depends on more than any other: the assertions here are byte-identity assertions, and they are only
 * a comparison of the application against itself because these bytes are by construction what this
 * build wrote. The recording is keyed to the build fingerprint, so a changed tiler or serialiser
 * discards it.
 *
 * Leaves the page on the hub with the files on disk and nothing read yet, because every caller's next
 * move is a navigation.
 */
async function seededWorkspace(
	page: Page,
	name: string,
	capture: (page: Page) => Promise<{ imageId: string; layerId: string }>
): Promise<{ imageId: string; layerId: string }> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, name, capture);
	await restoreWorkspace(page, snapshot.files);
	return { imageId: snapshot.imageId, layerId: snapshot.layerId };
}

/** A Project with one aligned Map Image on disk — seeded. See {@link seededWorkspace}. */
const alignedWorkspace = (page: Page) =>
	seededWorkspace(page, 'undo-aligned', alignedProjectThroughTheInterface);

/**
 * …and on the alignment route, with the three recorded pairs resumed and clickable.
 *
 * **The rows are the barrier, not the pane**, for the reason {@link throughLayersAndBack} records:
 * `pairing` is `undefined` until the Alignment has been read, and a click before then is dropped.
 *
 * @returns the image id, which is the Alignment's file name
 */
async function alignedProject(page: Page): Promise<string> {
	const { imageId, layerId } = await alignedWorkspace(page);
	await page.goto(`/align/?p=amsterdam-1625&layer=${layerId}`);
	await waitForSurface(page);
	await expect(controlPointRows(page)).toHaveCount(3);
	return imageId;
}

/**
 * A Project with one empty Annotation Layer on disk — seeded from {@link startAnnotating}'s journey.
 *
 * @returns the Annotation Layer's id
 */
async function annotatingWorkspace(page: Page): Promise<string> {
	const { layerId } = await seededWorkspace(page, 'undo-annotating', async (fresh) => ({
		// The ingest's two ids are the recording's vocabulary and there is no Map Image here, so
		// the image id is deliberately empty: nothing in this fixture has a pyramid to name.
		imageId: '',
		layerId: await startAnnotating(fresh)
	}));
	return layerId;
}

/**
 * …and on the Project with that Layer open, ready to draw into — {@link startAnnotating}'s end state.
 *
 * @returns the Annotation Layer's id
 */
async function annotating(page: Page): Promise<string> {
	const layerId = await annotatingWorkspace(page);
	await reopenLayers(page);
	return layerId;
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
		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');
		await editHistoryUndo(page).click();

		// Byte-identical, which is stronger than "the coordinates are close": the file the undo wrote is
		// the file the move overwrote.
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		// And on screen, which is what the user is actually promised: the handle is drawn at the image
		// pixel it was drawn at before the gesture, and the list reads the same as it did.
		await expect(half).toHaveAttribute('data-resource-x', wasAtPixel as string);
		expect(await rowText(page, 1)).toBe(wasAt);

		// The one Step in this history is spent, so that end of it is empty — and absent rather than
		// disabled, which is how "there is nothing to undo" stays one piece of state (SPEC story 45).
		await expect(editHistoryUndo(page)).toHaveCount(0);
		await expect(page.getByTestId('edit-history-outcome')).toContainText(
			'Undone: move of Control Point 1.'
		);
		await page.keyboard.press('Control+z');
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);

		// And the other end is not: an undo pressed by mistake is itself reversible (SPEC story 7).
		await expect(editHistoryRedo(page)).toHaveAttribute(
			'aria-label',
			'Redo move of Control Point 1'
		);
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
		await expect(addMapImageButton(page)).toBeVisible();
		// ⚠ **The reported defect, on the screen it was reported on** (SPEC story 1). The edit was made
		// while aligning, and the Project screen's own Edit History is empty — so the bar offers nothing
		// here rather than offering to reverse a Control Point that is not on this screen.
		await expect(editHistoryUndo(page)).toHaveCount(0);
		await delayNextReadOf(page, 'info.json', 3000);

		// This workspace starts opening, but is destroyed before its Map Image pane calls `onpane`.
		await alignFromLayer(page);
		await page.getByTestId('back-to-project').click();
		await expect(addMapImageButton(page)).toBeVisible();

		// A replacement workspace becomes live before the stale pane finishes its delayed read.
		await alignFromLayer(page);
		await waitForSurface(page);
		await expect(controlPointRows(page)).toHaveCount(3);
		await page.waitForTimeout(3500);

		// …and back on the Align screen it is offered again, still naming the move (SPEC story 2).
		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');
		await editHistoryUndo(page).click();
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		expect(await rowText(page, 1)).toBe(wasAt);
	});

	/**
	 * The Edit History outlives the component that made it, and reversing a Step has to act on the
	 * pairing that is on screen **now**.
	 *
	 * `EditorSession.open` returns early for the Project already showing, and a history is keyed by Map
	 * Image rather than by Project (ADR-0039) — so a trip to the Layers pane and back leaves this
	 * Alignment's Steps exactly where they were while the workspace builds a fresh `AlignmentPairing`
	 * out of the file. That is the epic's premise working, and it is also what made a restore closure
	 * that had captured its pairing dangerous: undoing wrote *that* object's whole Alignment, so a
	 * Control Point placed after coming back was deleted out of the file with nothing on screen moving
	 * and the affordance claiming only that a point had been put back.
	 *
	 * **Byte Steps make that unrepresentable, and the walk back is what shows it.** A Step holds the
	 * file either side of one gesture, so there is no pairing instance in it to go stale: the pair made
	 * after the round trip is its own Step, undone first, and the move behind it comes back to the
	 * bytes it overwrote whichever component was on screen when it was made.
	 */
	test('walks back through a pair made after a round trip to the move behind it', async ({
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
		const afterMove = await storedAlignment(page, imageId);

		await throughLayersAndBack(page, 3);
		// It survived the route change, which is what makes the rest of this test worth asserting.
		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');

		// A fourth pair, made after the remount: it exists only in the pairing now on screen, and never
		// existed in the one the move was made on.
		await makePairs(page, 4);
		await waitForStored(page, imageId, 4);
		await saved(page);
		const fourth = await rowText(page, 4);
		const afterFourth = await storedAlignment(page, imageId);

		// **The newest Step first, and only that one.** The three originals are the file as the move
		// left it, so the fourth pair went and nothing else did.
		await expect(editHistoryUndo(page)).toHaveText('Undo placing Control Point 4');
		await editHistoryUndo(page).click();
		await saved(page);
		await expect(controlPointRows(page)).toHaveCount(3);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(afterMove);

		// …and then the move behind it, byte for byte, on a pairing built long after it was recorded.
		await expect(editHistoryUndo(page)).toHaveText('Undo move of Control Point 1');
		await editHistoryUndo(page).click();
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		const after = JSON.parse((await storedAlignment(page, imageId)) as string);
		expect(after.body.features).toEqual(beforeMove.body.features);

		// And on screen, which is the half that was silently not happening: the handle is drawn back at
		// the image pixel it started from, in a rebuilt list of three.
		await expect(controlPointRows(page)).toHaveCount(3);
		await expect(imagePoints(page).first()).toHaveAttribute(
			'data-resource-x',
			wasAtPixel as string
		);
		expect(await rowText(page, 1)).toBe(wasAt);
		await expect(editHistoryUndo(page)).toHaveCount(0);

		// Both directions, back to where the walk started (SPEC story 8).
		await editHistoryRedo(page).click();
		await saved(page);
		await editHistoryRedo(page).click();
		await saved(page);
		await expect(controlPointRows(page)).toHaveCount(4);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(afterFourth);
		expect(await rowText(page, 4)).toBe(fourth);
		await expect(editHistoryRedo(page)).toHaveCount(0);
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
		await expect(editHistoryUndo(page)).toHaveText('Undo delete of Control Point 2');

		// The standard shortcut, from wherever the user's hands are — here the document rather than the
		// affordance, because a deleted handle has taken the focus with it.
		await page.keyboard.press('Control+z');

		await expect(controlPointRows(page)).toHaveCount(3);
		expect(await rowText(page, 2)).toBe(second);
		expect(await rowText(page, 3)).toBe(third);
		await saved(page);
		await expect.poll(() => storedAlignment(page, imageId)).toBe(before);
		await expect(editHistoryUndo(page)).toHaveCount(0);
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
		const layerId = await annotating(page);
		// A line rather than a pin, because `stroke-dasharray` is what the criterion names and a pin has
		// no line style to set — a conjectural route is exactly the case where the property carries the
		// scholarly claim.
		await drawShape(page, 'line', [
			[0.35, 0.4],
			[0.5, 0.5],
			[0.62, 0.45]
		]);
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Fort Amsterdam');
		await page.getByTestId('annotation-title').blur();
		await chooseLineStyle(page, 'dotted');
		await saved(page);

		const before = await readProjectFile(page, `annotations/${layerId}.geojson`);
		const deleted = (await storedAnnotations(page, layerId)).features[0];
		expect(deleted?.properties['stroke-dasharray']).toEqual([1, 3]);
		const annotationId = deleted?.id as string;

		await deleteAnnotation(page);
		await saved(page);
		// On disk, before the undo: the file the user would have been left with.
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);

		await expect(editHistoryUndo(page)).toHaveText('Undo delete of “Fort Amsterdam”');
		await editHistoryUndo(page).click();
		// **A visible consequence before the bytes are read.** An undo is dispatched and then runs, and
		// the indicator is still saying what the gesture before it left it saying — so waiting for
		// "Saved locally" alone reads the file the undo is in the middle of replacing. The redo control
		// appears only once the cursor has moved, and the cursor moves only on a write that landed.
		// The deletion is now what redo offers, in the same sentence with one word swapped (SPEC story 7).
		await expect(editHistoryRedo(page)).toHaveAttribute(
			'aria-label',
			'Redo delete of “Fort Amsterdam”'
		);
		await saved(page);

		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).toBe(before);
		const back = (await storedAnnotations(page, layerId)).features[0];
		expect(back?.properties).toEqual(deleted?.properties);
		expect(back?.geometry).toEqual(deleted?.geometry);
		// And it is on the map again, which is the half no assertion about state can see.
		const painted = await waitForPaintedAnnotations(page, [annotationId]);
		expect(painted[annotationId]?.length ?? 0).toBeGreaterThan(0);

		// The drawing and the line style that preceded the deletion are still behind the cursor, which is
		// what makes this a history rather than a slot (SPEC story 6).
		await expect(editHistoryUndo(page)).toHaveText('Undo restyling “Fort Amsterdam”');
	});

	/**
	 * Which Annotation Layer is being drawn into is a **working choice**, not part of the work, and
	 * nothing stops a user changing it between the deletion and the undo — the picker sits a few
	 * centimetres from the affordance. An undo that wrote into whichever Layer happened to be open
	 * would take the Annotation out of one `.geojson` and put it into another, which is not an undo of
	 * anything: it is a move into a file the user was not looking at.
	 *
	 * A Step names the files its gesture wrote (ADR-0039), so which file an undo writes into is not a
	 * lookup that can go wrong. This asserts the class of defect rather than any one mechanism for it.
	 */
	test('goes back into the Layer it was deleted from, not the one chosen when Undo is pressed', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const routes = await annotating(page);
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
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Fort Amsterdam');
		await page.getByTestId('annotation-title').blur();
		await saved(page);

		// Both files, so "the other Layer gained nothing" is a claim about bytes rather than about a list.
		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(2);
		const deleted = (await storedAnnotations(page, routes)).features[0];
		const annotationId = deleted?.id as string;

		await deleteAnnotation(page);
		await saved(page);
		expect((await storedAnnotations(page, routes)).features).toHaveLength(0);

		// The Annotation goes back into the Layer whose file it came from, not into whichever Layer is
		// open: the *other* Layer is opened here, which closes the one it was deleted from and makes it the
		// Layer being drawn into.
		await openLayerRow(page, rowFor(page, places));
		await expect(page.getByTestId('annotation-list-empty')).toBeVisible();

		await expect(editHistoryUndo(page)).toHaveText('Undo delete of “Fort Amsterdam”');
		await editHistoryUndo(page).click();
		// **A visible consequence before the bytes are read.** An undo is dispatched and then runs, and
		// the indicator is still saying what the gesture before it left it saying — so waiting for
		// "Saved locally" alone reads the file the undo is in the middle of replacing. The redo control
		// appears only once the cursor has moved, and the cursor moves only on a write that landed.
		await expect(editHistoryRedo(page)).toHaveCount(1);
		await saved(page);

		// Byte for byte back where it came from, and the chosen Layer's file is the one it was.
		await expect.poll(() => hashesUnder(page, 'annotations/')).toEqual(before);
		expect((await storedAnnotations(page, places)).features).toHaveLength(0);
		const back = (await storedAnnotations(page, routes)).features[0];
		expect(back?.id).toBe(annotationId);
		expect(back?.properties).toEqual(deleted?.properties);

		// The Layer the scholar had open stays open: a Step writes bytes and moves nothing about the
		// sidebar, so the row that was on screen is still the row under the pointer. Its own Layer's
		// contents are where the Annotation is, which is what the file assertions above say and what
		// opening that row now shows.
		await expect(rowFor(page, places).getByTestId('layer-disclosure')).toHaveAttribute(
			'aria-expanded',
			'true'
		);
		await openLayerRow(page, rowFor(page, routes));
		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
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
		await alignedWorkspace(page);
		await openLayers(page, 1);
		// A second Layer, so the map Layer is not at the top: restoring it anywhere but its own position
		// would discard the user's ordering, which is display state ADR-0002 makes load-bearing.
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		const [annotationLayer, mapLayer] = (await rowIds(page)) as [string, string];
		// At the Workspace root (ADR-0023), which is what makes the claim below a claim about ADR-0023
		// rather than about undo: deleting the Layer must leave the Map Image and its Alignment where
		// they are, because another Project may be drawing them (SPEC story 67).
		const before = await hashesUnder(page, 'alignments/', '');
		expect(before).toHaveLength(1);
		const layersBefore = (await projectJson(page)).layers;
		expect(await stackOrder(page)).toContain(`ballastella-layer-${mapLayer}`);

		// Delete is inside the open card since the Layers revision.
		await deleteLayerRow(page, layerRows(page).nth(1));
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

		await expect(editHistoryUndo(page)).toHaveText('Undo delete of the Layer “la-floride.png”');
		await editHistoryUndo(page).click();
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
		// Redo has appeared, naming the same action with one word swapped (SPEC stories 43, 44) — and
		// undo has moved back one place, to the Annotation Layer this test added at the top, which is
		// its own Step since ticket 3 (SPEC stories 6, 15). Whether a control is absent rather than
		// greyed out at each end of the history is asserted at Seam 1c.
		await expect(editHistoryRedo(page)).toHaveAccessibleName(
			'Redo delete of the Layer “la-floride.png”'
		);
		await expect(editHistoryUndo(page)).toHaveText('Undo adding the Layer “Annotations 1”');

		// ─────────────────────────────────────────────────────────────────────────────────────
		// THE EDIT HISTORY BELONGS TO THE SCREEN, WHICH IS THE DEFECT THIS EPIC EXISTS FOR
		//
		// A claim about two routes and one navigation bar, so it cannot be made below a real browser.
		// The links rather than `page.goto`, because a reload builds a new session and would assert
		// nothing: what is asserted is that the *slot* empties and fills as the screen changes while
		// the history itself stays exactly where it was.
		// The map Layer's own row, which is the second: aligning is keyed by Layer id (ticket 03).
		await alignFromLayer(page, 1);
		await waitForSurface(page);
		// `/align` declares no Edit History yet (ticket 5), so the bar draws neither control there.
		await expect(editHistoryRedo(page)).toHaveCount(0);

		await page.getByTestId('back-to-project').click();
		await expect(page.getByTestId('layer-sidebar')).toBeVisible();
		await expect(editHistoryRedo(page)).toHaveCount(1);

		// And Workspace Home has none of its own, so it is undo-free without being named anywhere.
		await page.getByTestId('all-projects').click();
		await expect(page.getByRole('button', { name: 'New Project' })).toBeVisible();
		await expect(editHistoryRedo(page)).toHaveCount(0);
	});

	// The other file kind. An Annotation Layer's `FeatureCollection` is the user's scholarship rather
	// than a placement, so losing it to a mis-aimed click is the worst of the four.
	test('restores an Annotation Layer’s FeatureCollection byte-for-byte, with what was in it', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const layerId = await annotating(page);
		await drawPin(page, 0.4, 0.45);
		await selectAnnotation(page);
		await editAnnotationText(page);
		await page.getByTestId('annotation-title').fill('Trade route');
		await page.getByTestId('annotation-title').blur();
		await saved(page);
		const before = await hashesUnder(page, 'annotations/');
		const annotationId = (await storedAnnotations(page, layerId)).features[0]?.id as string;

		// Delete is inside the open card since the Layers revision.
		await deleteLayerRow(page, layerRows(page).first());
		await expect(layerRows(page)).toHaveCount(0);
		await saved(page);
		expect(await hashesUnder(page, 'annotations/')).toEqual([]);
		expect((await projectJson(page)).layers).toEqual([]);

		await editHistoryUndo(page).click();
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
 * A Layer is now created by exactly one thing — the user adding a Map Image to a Project — so the
 * record is gone and these tests assert the property directly rather than the record: **no Alignment
 * write, in this session or a later one, touches the Layer stack at all.**
 */
test.describe('a deleted map Layer does not come back (the resurrection trap)', () => {
	/*
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE TEST THAT USED TO BE FIRST HERE, AND WHY THERE IS NOTHING LEFT FOR IT TO DRIVE
	 *
	 * "Delete the map Layer, then write the Alignment again" was the reproduction. Ticket 02 closed it
	 * in the model — only adding a Map Image makes a Layer — and ticket 03 closed the *gesture* as
	 * well: aligning is `/align/?p=…&layer=…`, keyed by Layer id, so a Map Image with no Layer in
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
		const { imageId } = await alignedWorkspace(page);
		await openLayers(page, 1);
		const layerBefore = (await projectJson(page)).layers[0];

		// Delete is inside the open card since the Layers revision.
		await deleteLayerRow(page, layerRows(page).first());
		await expect(layerRows(page)).toHaveCount(0);
		await saved(page);
		await editHistoryUndo(page).click();
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
		// The Layer is already there: adding the Map Image is what put it in the stack (ADR-0023),
		// before any Control Point exists.
		const before = await readProjectFile(page, 'project.json');
		expect(JSON.parse(before).layers).toHaveLength(1);

		await delayReadsOf(page, 'manifest.json', 1500);

		// Two completed pairs in quick succession, the second landing inside the first's manifest read.
		await clickAt(mapImage(page), 0.3, 0.3);
		await clickAt(page.getByTestId('base-map-pane'), 0.3, 0.3);
		await clickAt(mapImage(page), 0.7, 0.35);
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

test.describe('what undo will and will not hold (ADR-0014, ADR-0039)', () => {
	/**
	 * The fence. Naming things stays the browser's to undo (SPEC story 30), so a rename must not
	 * consume a Step — otherwise a user who deletes something and then tidies a name has quietly lost
	 * their way back (SPEC stories 31, 32).
	 *
	 * **And it must not cost the scholar the name either.** A Step holds byte images, and undo writes
	 * one back with the typed text on disk spliced into it (ADR-0039), so the name typed after the
	 * deletion survives the undo of that deletion (SPEC story 33). The pair is the assertion: the
	 * reverted half comes from the image and the typed half from the file as it stands.
	 */
	test('a rename leaves the delete still undoable, and survives it', async ({ page }) => {
		test.setTimeout(90_000);
		await annotating(page);
		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);
		const [top, bottom] = (await rowIds(page)) as [string, string];

		// Delete is inside the open card since the Layers revision.
		await deleteLayerRow(page, layerRows(page).nth(1));
		await expect(layerRows(page)).toHaveCount(1);
		await saved(page);
		const label = 'Undo delete of the Layer “Annotations 1”';
		await expect(editHistoryUndo(page)).toHaveText(label);

		// An edit that is the browser's to undo, and written.
		// Renaming starts at the pencil in an open card since the Layers revision.
		const renaming = await openLayerRow(page, layerRows(page).first());
		await renaming.getByTestId('layer-rename').click();
		await renaming.getByTestId('layer-name').fill('Trade routes');
		await renaming.getByTestId('layer-name').blur();
		await saved(page);

		// Still offered, still naming the deletion, and still able to carry it out.
		await expect(editHistoryUndo(page)).toHaveText(label);
		await editHistoryUndo(page).click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);

		expect(await rowIds(page)).toEqual([top, bottom]);
		// The name the scholar typed after the Step is carried across into what undo writes: it is
		// theirs, it is not part of the deletion, and taking it back would be undoing words nobody
		// asked to have undone (SPEC story 33).
		const layers = (await projectJson(page)).layers;
		expect(layers[0].name).toBe('Trade routes');
	});

	/**
	 * SPEC stories 52 and 53, and a claim only the running app can make: the Inspector is a real panel
	 * over a real MapLibre canvas and the leader is drawn between two measured boxes, so "the panel
	 * closed and the line went with it" cannot be asserted against a DOM implementation with no layout.
	 *
	 * **A history's own lifetime is asserted away from here, which is why it is not asserted twice.**
	 * That an Edit History belongs to its subject — surviving a walk off the screen, dropped when the
	 * Project is opened afresh — is a claim about a memory store and is made in
	 * `editor-session.test.ts`; that the bar draws whatever the screen on show declares is made a few
	 * tests above, on the walk from `/align` to the Project screen to Workspace Home. Neither needs a
	 * browser, and the Seam 2 budget is why anything that does not have one does not get one
	 * (ADR-0039).
	 */
	test('undoing the drawing of an Annotation closes the Inspector it was open on', async ({
		page
	}) => {
		test.setTimeout(90_000);
		const layerId = await annotating(page);
		await drawPin(page, 0.45, 0.45);
		// A shape just drawn arrives selected so that it can be titled, so the Inspector is open on it
		// and the leader is drawn from its row to the mark — without either, this test asserts nothing.
		await expect(inspector(page)).toHaveCount(1);
		// `data-drawn` rather than the element, which is always there: an SVG polyline with no `points`
		// is otherwise indistinguishable from one nobody asked for (see `LeaderLine.svelte`).
		await expect(page.getByTestId('leader-line')).toHaveAttribute('data-drawn', 'yes');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		await expect(editHistoryUndo(page)).toHaveText('Undo drawing this Annotation');
		await editHistoryUndo(page).click();

		// The panel describing an Annotation that is no longer there goes, and the selection goes with
		// it — one value, so the row's highlight and the leader cannot disagree with the panel.
		await expect(inspector(page)).toHaveCount(0);
		await expect(page.getByTestId('leader-line')).toHaveAttribute('data-drawn', 'no');
		await expect(page.getByTestId('annotation-row')).toHaveCount(0);
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);
		// And nothing is said about the panel closing: the toast already reports what was undone, and a
		// second sentence about a side effect of it is noise.
		await expect(page.getByTestId('edit-history-outcome')).toContainText(
			'Undone: drawing this Annotation.'
		);
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
		const layerId = await annotating(page);
		await drawPin(page, 0.5, 0.5);
		await selectAnnotation(page);
		await deleteAnnotation(page);
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(0);

		for (let press = 0; press < 200; press += 1) {
			if (await editHistoryUndo(page).evaluate((element) => element === document.activeElement)) {
				break;
			}
			await page.keyboard.press('Tab');
		}
		await expect(editHistoryUndo(page)).toBeFocused();

		await page.keyboard.press('Enter');
		await expect(page.getByTestId('annotation-row')).toHaveCount(1);
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
		const layerId = await annotating(page);
		await drawPin(page, 0.5, 0.5);
		await drawPin(page, 0.6, 0.55);
		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);

		// The name is a text field only in an open card with the pencil pressed since the Layers
		// revision — and a text field is precisely what this test needs Ctrl+Z to be caught by.
		const renaming = await openLayerRow(page, layerRows(page).first());
		await renaming.getByTestId('layer-rename').click();
		const name = renaming.getByTestId('layer-name');
		await name.click();
		await name.press('Control+z');

		// Ours did not fire: the Annotation is still deleted and the affordance still names its deletion.
		await expect(editHistoryUndo(page)).toHaveText('Undo delete of this Annotation');
		expect((await storedAnnotations(page, layerId)).features).toHaveLength(1);
	});
});

test.describe('a deleted Label (write-on-the-map stories 42 and 43)', () => {
	/**
	 * Only the running app can connect an Inspector delete and undo to OPFS bytes, Layer choice, and
	 * MapLibre paint rather than merely to a reconstructed Annotation value.
	 */
	test('leaves its row and map, then returns to its Layer and original position with its words and colours', async ({
		page
	}) => {
		const layerId = await annotatingWorkspace(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			`${JSON.stringify(
				{
					type: 'FeatureCollection',
					features: [
						{
							type: 'Feature',
							id: 'before',
							properties: { title: 'The harbour' },
							geometry: { type: 'Point', coordinates: [4.78, 52.4] }
						},
						{
							type: 'Feature',
							id: 'label',
							properties: {
								title: 'Zuiderzee',
								'marker-symbol': 'label',
								'marker-color': '#d32f2f',
								fill: '#1976d2',
								'fill-opacity': 0.4,
								'marker-size': 'large'
							},
							geometry: { type: 'Point', coordinates: [4.9, 52.37] }
						},
						{
							type: 'Feature',
							id: 'after',
							properties: { title: 'The parish' },
							geometry: { type: 'Point', coordinates: [5.02, 52.34] }
						}
					]
				},
				null,
				'\t'
			)}\n`
		);
		await reopenLayers(page);
		await waitForPaintedAnnotations(page, ['before', 'label', 'after']);

		await page.getByTestId('add-annotation-layer').click();
		await expect(layerRows(page)).toHaveCount(2);
		await saved(page);
		const otherLayerId = (await rowIds(page)).find((id) => id !== layerId) as string;
		const before = await hashesUnder(page, 'annotations/');
		expect(before).toHaveLength(2);
		await openLayerRow(page, rowFor(page, layerId));

		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);

		expect((await storedAnnotations(page, layerId)).features.map((feature) => feature.id)).toEqual([
			'before',
			'after'
		]);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);
		await expect.poll(async () => 'label' in (await renderedAnnotationLayers(page))).toBe(false);

		await openLayerRow(page, rowFor(page, otherLayerId));
		await expect(editHistoryUndo(page)).toHaveText('Undo delete of “Zuiderzee”');
		await editHistoryUndo(page).click();
		// **A visible consequence before the bytes are read.** An undo is dispatched and then runs, and
		// the indicator is still saying what the gesture before it left it saying — so waiting for
		// "Saved locally" alone reads the file the undo is in the middle of replacing. The redo control
		// appears only once the cursor has moved, and the cursor moves only on a write that landed.
		await expect(editHistoryRedo(page)).toHaveCount(1);
		await saved(page);

		await expect.poll(() => hashesUnder(page, 'annotations/')).toEqual(before);
		// A Step writes bytes and moves nothing about the sidebar, so the Layer the Label went back
		// into is opened here rather than being expected to have opened itself.
		await openLayerRow(page, rowFor(page, layerId));
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({
					has: page.getByTestId('annotation-row-name').getByText('The harbour', { exact: true })
				})
				.getByTestId('annotation-row-ordinal')
		).toHaveText('1');
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({
					has: page.getByTestId('annotation-row-name').getByText('Zuiderzee', { exact: true })
				})
				.getByTestId('annotation-row-ordinal')
		).toHaveText('2');
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({
					has: page.getByTestId('annotation-row-name').getByText('The parish', { exact: true })
				})
				.getByTestId('annotation-row-ordinal')
		).toHaveText('3');
		await waitForPaintedAnnotations(page, ['label']);
	});

	/**
	 * A browser is required to prove that an invisible Label still follows the Inspector's delete,
	 * focus, and undo path while OPFS restores the exact file the author had.
	 */
	test('an untitled Label is deleted and restored through the same Inspector path', async ({
		page
	}) => {
		const layerId = await annotatingWorkspace(page);
		await writeProjectFile(
			page,
			`annotations/${layerId}.geojson`,
			`${JSON.stringify(
				{
					type: 'FeatureCollection',
					features: [
						{
							type: 'Feature',
							id: 'before',
							properties: { title: 'The harbour' },
							geometry: { type: 'Point', coordinates: [4.78, 52.4] }
						},
						{
							type: 'Feature',
							id: 'empty-label',
							properties: { 'marker-symbol': 'label', fill: '#1976d2' },
							geometry: { type: 'Point', coordinates: [4.9, 52.37] }
						},
						{
							type: 'Feature',
							id: 'after',
							properties: { title: 'The parish' },
							geometry: { type: 'Point', coordinates: [5.02, 52.34] }
						}
					]
				},
				null,
				'\t'
			)}\n`
		);
		await reopenLayers(page);
		const before = await readProjectFile(page, `annotations/${layerId}.geojson`);

		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);
		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).not.toBe(before);
		await expect(page.getByTestId('annotation-row')).toHaveCount(2);

		await editHistoryUndo(page).click();
		await expect(page.getByTestId('annotation-row')).toHaveCount(3);
		await saved(page);
		expect(await readProjectFile(page, `annotations/${layerId}.geojson`)).toBe(before);
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({
					has: page.getByTestId('annotation-row-name').getByText('The harbour', { exact: true })
				})
				.getByTestId('annotation-row-ordinal')
		).toHaveText('1');
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({
					has: page
						.getByTestId('annotation-row-name')
						.getByText('Untitled label 2', { exact: true })
				})
				.getByTestId('annotation-row-ordinal')
		).toHaveText('2');
		await expect(
			page
				.getByTestId('annotation-row')
				.filter({
					has: page.getByTestId('annotation-row-name').getByText('The parish', { exact: true })
				})
				.getByTestId('annotation-row-ordinal')
		).toHaveText('3');

		await selectAnnotation(page);
		await deleteAnnotation(page);
		await saved(page);
		await selectAnnotation(page, 1);
		await deleteAnnotation(page);
		await saved(page);
		await selectAnnotation(page);
		await deleteAnnotation(page);
		await saved(page);
		await expect
			.poll(() =>
				page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? 'BODY')
			)
			.toBe('annotation-new');
	});
});
