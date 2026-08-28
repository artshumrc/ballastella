// Shared driving for the Annotation surface: get a Project open on the Layers pane with
// one Annotation Layer, draw into it, and read back what landed in OPFS.
//
// Separate from `alignment-workspace.ts` because these tests need **no Map Image at all** — an
// Annotation is on real geography and needs only the Base Map, so ingesting a pyramid would add
// twenty seconds per test to assert nothing this slice is about. Nothing here reaches into the app's
// own state: the assertions are on the written file and on what MapLibre reports it drew.

import { expect, type Locator, type Page } from './test.js';
import { createHash } from 'node:crypto';

import { openLayerRow } from './layers';
import { readStoredFile } from './stored-file';
import { restoreWorkspace, snapshotWorkspace } from './workspace-snapshot.js';

export const PROJECT_NAME = 'Amsterdam 1625';
export const PROJECT_DIRECTORY = 'amsterdam-1625';

/**
 * The live map, as this file needs to question it.
 *
 * A local type reached through a cast rather than a `declare global`, because
 * `editor-layers.e2e.ts` already augments `Window.ballastellaLayerStack` with the subset *it* needs,
 * and TypeScript requires every declaration of the same property to be identical. Two files each
 * declaring the shape they use is the shape that cannot be made to agree; a cast per call site can.
 * The real fix is one shared declaration — worth doing when a third file needs it, rather than
 * churning a green suite now.
 *
 * These are all real `maplibre-gl` methods; the handle is the map itself (`layers/browser-test-handle.ts`).
 */
export interface StackMap {
	getLayer(id: string): unknown;
	getPaintProperty(layerId: string, name: string): unknown;
	queryRenderedFeatures(
		point?: unknown,
		options?: unknown
	): { layer: { id: string }; properties: Record<string, unknown> }[];
	getCenter(): { lng: number; lat: number };
	/** Where a place on the earth lands in the pane, in CSS pixels from its top-left corner. */
	project(lngLat: [number, number]): { x: number; y: number };
	/** {@link project} backwards: which place on the earth is under a point in the pane. */
	unproject(point: [number, number]): { lng: number; lat: number };
	/**
	 * MapLibre's own canvas.
	 *
	 * Read for its box, which is the pane {@link project} and {@link unproject} answer in. Asked of the
	 * map rather than measured with a Playwright locator so that a claim about where the camera is
	 * pointing is made against one origin rather than two — the canvas's container is a zero-height div,
	 * and the difference has already cost a bug in `BaseMapPane.svelte`.
	 */
	getCanvas(): HTMLCanvasElement;
	setCenter(lngLat: [number, number]): void;
	setZoom(zoom: number): void;
	getZoom(): number;
	once(event: string, listener: () => void): unknown;
	/** Ask for one more frame, so a `render` listener registered just above it is reached. */
	triggerRepaint(): void;
	isMoving(): boolean;
	/** What `StackRender.setSelectedAnnotation` wrote onto a feature, keyed by source and feature id. */
	getFeatureState(target: { source: string; id: string }): Record<string, unknown>;
}

/**
 * The window as this file reads it.
 *
 * Applied as a cast at each `page.evaluate` boundary rather than through a helper, because the body of
 * an `evaluate` is serialised and sent to the browser — it cannot close over anything defined out
 * here, so a shared accessor would be `undefined` at the only place it was needed.
 */
export type StackWindow = { ballastellaLayerStack?: { map: StackMap; builds: number } };

declare global {
	interface Window {
		ballastellaAnnotationWrites?: { path: string; annotations: number; bytes: number }[];
	}
}

/** Empty the origin's OPFS, so no test can see another's Projects. */
export async function emptyWorkspace(page: Page): Promise<void> {
	await page.evaluate(async () => {
		// The whole of browser storage, which is **every named Workspace** rather than one — so no test
		// can see another's, whichever Workspace it was in.
		//
		// ⚠ **The Workspace the app is holding open is emptied, not removed.** `DirectoryHandleStore`
		// caches its root handle once it resolves (ADR-0008), and that handle is now a *named
		// subdirectory* rather than the OPFS root, which cannot vanish. Deleting the directory out from
		// under a running app therefore latches it "unreachable" until a reload — a state about the
		// harness rather than about the product, and one that used to be unreachable because emptying
		// the root left the root itself in place. Emptying it is exactly what this always meant.
		const root = await navigator.storage.getDirectory();
		const open = await workspaceRoot();
		const names: string[] = [];
		for await (const name of root.keys()) names.push(name);
		await Promise.all(
			names
				.filter((name) => name !== open.name)
				.map((name) => root.removeEntry(name, { recursive: true }))
		);
		const inside: string[] = [];
		for await (const name of open.keys()) inside.push(name);
		await Promise.all(inside.map((name) => open.removeEntry(name, { recursive: true })));
	});
}

/**
 * One file of a Project, straight out of OPFS.
 *
 * **Retried, because the app writes atomically** — a temp file, then `move()` over the destination
 * (ADR-0017 rule 4) — so a read that lands inside that window throws instead of returning stale bytes:
 * a `NotFoundError` while the destination is momentarily gone, or a failure to read it as it is
 * replaced. That is transient by construction, and it propagates out of `expect.poll`, whose retry
 * covers a failed assertion rather than a callback that throws. `editor-workspace.ts`'s
 * `readProjectName` carries the same fix, for the same window, after this was the flakiest test in the
 * suite.
 *
 * A fix to the read and not to any assertion: the bytes on disk are still what is compared, and a file
 * that is really missing still fails — with the last failure named, so a persistent problem does not
 * read as a slow one.
 */
export const readProjectFile = (page: Page, path: string, directory = PROJECT_DIRECTORY) =>
	// `''` reads from the Workspace root (ADR-0023): an Alignment and a pyramid belong there, not
	// inside a Project. The retry itself is `support/stored-file.ts`, which is where this loop now
	// lives for all four of the helpers that had grown their own copy of it.
	readStoredFile(page, directory === '' ? path : `${directory}/${path}`);

/** Write a file behind the app's back, for a fixture the UI has no way to produce yet. */
export const writeProjectFile = (
	page: Page,
	path: string,
	text: string,
	directory = PROJECT_DIRECTORY
): Promise<void> =>
	page.evaluate(
		async ([directory, path, text]) => {
			const root = await workspaceRoot();
			// `''` writes at the Workspace root (ADR-0023): a pyramid and an Alignment belong there.
			let handle =
				directory === ''
					? root
					: await root.getDirectoryHandle(directory as string, { create: true });
			const segments = (path as string).split('/');
			for (const segment of segments.slice(0, -1)) {
				handle = await handle.getDirectoryHandle(segment, { create: true });
			}
			const file = await handle.getFileHandle(segments.at(-1) as string, { create: true });
			const writable = await file.createWritable();
			await writable.write(text as string);
			await writable.close();
		},
		[directory, path, text]
	);

/** Every file under `prefix`, as a sha256 per path. The bytes are the assertion. */
export async function hashesUnder(
	page: Page,
	prefix: string,
	directory = PROJECT_DIRECTORY
): Promise<string[]> {
	const files = await page.evaluate(
		async ([directory, prefix]) => {
			const out: [string, number[]][] = [];
			const root = await workspaceRoot();
			// `''` walks the Workspace root, which is where a Map Image's pyramid and its Alignment now
			// live (ADR-0023) — shared by every Project, so not under any one of them.
			const project = directory === '' ? root : await root.getDirectoryHandle(directory as string);
			const walk = async (handle: FileSystemDirectoryHandle, at: string): Promise<void> => {
				for await (const [name, entry] of handle.entries()) {
					const path = at === '' ? name : `${at}/${name}`;
					if (entry.kind === 'directory') {
						await walk(entry as FileSystemDirectoryHandle, path);
					} else if (path.startsWith(prefix as string)) {
						const bytes = await (await (entry as FileSystemFileHandle).getFile()).arrayBuffer();
						out.push([path, [...new Uint8Array(bytes)]]);
					}
				}
			};
			await walk(project, '');
			return out.sort(([a], [b]) => a.localeCompare(b));
		},
		[directory, prefix]
	);
	return files.map(
		([path, bytes]) => `${path} ${createHash('sha256').update(Buffer.from(bytes)).digest('hex')}`
	);
}

/** The open Project's `project.json`, parsed. */
export const projectJson = async (page: Page, directory = PROJECT_DIRECTORY) =>
	JSON.parse(await readProjectFile(page, 'project.json', directory));

/**
 * The Annotation Layer's id, taken from `project.json` rather than guessed.
 *
 * **Waits for the Layer to have been written, rather than assuming it has been.** Adding a Layer
 * changes `project.json`, which autosave writes on a 400 ms debounce (ADR-0017 rule 2), so the row
 * is in the sidebar before the bytes are on disk. Reading once produced
 * `TypeError: Cannot read properties of undefined (reading 'id')` — an absence, one line from where
 * it was created — in 1 of the 10 baseline runs of 2026-08-07, and a 30 s timeout for the same
 * absence in two more.
 *
 * A poll for existence rather than for a transient state: a Layer that has been added is there for
 * good, so the only question is whether the write has landed yet.
 */
export async function annotationLayerId(page: Page, at = 0): Promise<string> {
	const annotationLayers = async () => {
		try {
			const { layers } = await projectJson(page);
			return (layers as { kind: string; id: string }[]).filter(
				(layer) => layer.kind === 'annotation'
			);
		} catch {
			// `project.json` is written atomically — a temp file moved over the destination (rule 4) —
			// so a read inside that window raises rather than returning stale bytes. A retry, not a
			// failure.
			return [];
		}
	};
	await expect
		.poll(async () => (await annotationLayers()).length, {
			message: `project.json should hold at least ${at + 1} Annotation Layer(s)`
		})
		.toBeGreaterThan(at);
	return (await annotationLayers())[at]!.id;
}

/** The Annotation Layer's `FeatureCollection`, parsed out of OPFS. */
export async function storedAnnotations(
	page: Page,
	layerId: string
): Promise<{
	type: string;
	features: {
		type: string;
		id: string;
		properties: Record<string, unknown>;
		geometry: { type: string; coordinates: unknown } | null;
	}[];
}> {
	return JSON.parse(await readProjectFile(page, `annotations/${layerId}.geojson`));
}

/**
 * Watch every Annotation write the app makes.
 *
 * The count is the criterion: editing a vertex must cost exactly one store write, on gesture end
 * (ADR-0017 rule 1). A per-pointer-move implementation passes any "did it save?" assertion and fails
 * this, and a write into OPFS issues no request so there is nothing outside the page to count.
 */
export const watchAnnotationWrites = (page: Page) =>
	page.evaluate(() => {
		window.ballastellaAnnotationWrites = [];
	});

export const annotationWrites = (page: Page) =>
	page.evaluate(() => window.ballastellaAnnotationWrites ?? []);

/** Create a Project through the interface, as a user would. */
export async function createProject(page: Page, name = PROJECT_NAME): Promise<void> {
	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill(name);
	await dialog.getByRole('button', { name: 'Create' }).click();
}

/**
 * The journey that is recorded once: a Project created through the dialog, with one Annotation Layer
 * added through the interface.
 *
 * Kept whole and driven for real, because it is what {@link seedAnnotationProject} replays — see
 * `workspace-snapshot.ts` for why the fixture is a recording rather than a literal.
 */
async function projectWithAnnotationLayerThroughTheInterface(page: Page): Promise<string> {
	await page.reload();
	await createProject(page);
	await expect(page.getByRole('link', { name: PROJECT_NAME })).toBeVisible();

	await openLayers(page);
	await page.getByTestId('add-annotation-layer').click();
	await expect(page.getByTestId('layer-row')).toHaveCount(1);
	await expect(page.getByRole('status')).toHaveText('Saved locally');

	return annotationLayerId(page);
}

/**
 * A Project with one empty Annotation Layer on disk, seeded — page left on the hub, nothing read yet.
 *
 * ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ THE PROJECT AND THE LAYER ARE SCENERY IN EVERY TEST IN THIS FAMILY.                           │
 * └───────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Every Annotation test used to boot the application three times before its first assertion: once to
 * empty storage, once more to see it emptied, and a third time to open the Project the New Project
 * dialog had just made. None of them is about creating a Project or adding a Layer, and the two
 * screens that do those things are proved by `editor-project-screen` and `editor-layers`.
 *
 * Callers that need a fixture file written behind the app's back use this directly and navigate once
 * themselves; {@link startAnnotating} is the common case, which navigates straight to the Layer.
 *
 * @returns the Annotation Layer's id
 */
export async function seedAnnotationProject(page: Page): Promise<string> {
	await page.goto('/');
	await emptyWorkspace(page);
	const snapshot = await snapshotWorkspace(page, 'annotations-one-layer', async (fresh) => ({
		imageId: '',
		layerId: await projectWithAnnotationLayerThroughTheInterface(fresh)
	}));
	await restoreWorkspace(page, snapshot.files);
	return snapshot.layerId;
}

/**
 * A Project open on the Layers pane with one Annotation Layer **open**, ready to draw into.
 *
 * Opening the row is a step because the drawing tools, the Annotation list, the style controls and
 * the Layer's default style all live inside the Layer's own row, and opening that row is what
 * chooses the Layer to draw into.
 *
 * @returns the Annotation Layer's id
 */
export async function startAnnotating(page: Page): Promise<string> {
	const layerId = await seedAnnotationProject(page);
	await reopenLayers(page);
	return layerId;
}

/**
 * Centre and zoom the map somewhere definite.
 *
 * So that a click at a fraction across the canvas is a stable coordinate rather than one that depends
 * on the catalog's initial view — and so that two Annotations placed at different fractions are far
 * enough apart in degrees to be told apart by a hit test.
 */
export async function centreOnAmsterdam(page: Page): Promise<void> {
	await page.evaluate(async () => {
		const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
		if (!map) return;
		map.setCenter([4.9, 52.37]);
		map.setZoom(10);
		// **Wait for the map to settle before returning.** `setCenter` only schedules a render, so
		// `queryRenderedFeatures` immediately afterwards asks about a frame that has not been drawn and
		// answers with nothing — which reads exactly like "the Annotation is not on the map". That is a
		// flake in the direction that hides a defect, so it is waited on rather than tolerated.
		//
		// Raced against a deadline because `idle` does not fire when the view did not actually change —
		// re-centring on the coordinates the map is already at is a no-op, and waiting for ever on it
		// would turn a passing test into a timeout.
		await Promise.race([
			new Promise<void>((resolve) => map.once('idle', () => resolve())),
			new Promise<void>((resolve) => setTimeout(resolve, 3000))
		]);
	});
}

/**
 * Open the Project: a Base Map with the Layer stack beside it.
 *
 * `/?p=<dir>`, because `/layers/` is gone — the Layer stack is not a page of its own any more, it is
 * one column of the Project. The name is kept: every caller means "get me to the Layers", and that is
 * still what this does.
 *
 * Deliberately does **not** wait for the map's stack handle: `drawLayerStack` is not called at all
 * when the Project has no visible Layers, so a Project that has only just been created would wait for
 * something that is correctly never going to appear. {@link waitForStack} is the separate wait, for
 * after a Layer exists.
 */
export async function openLayers(page: Page, directory = PROJECT_DIRECTORY): Promise<void> {
	await page.goto(`/?p=${directory}`);
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
	await expect(page.getByTestId('stack-status')).toBeVisible();
	await waitForOpeningView(page);
}

/**
 * Wait until the opening view has been settled (ADR-0026).
 *
 * The pane frames itself on the Project's content after an asynchronous read of every Layer's
 * documents, so anything that positions the map before that read lands — {@link centreOnAmsterdam},
 * above all — would have its viewport moved out from under it a moment later. Not a workaround for a
 * race: the fit happens exactly once, on open, and this is how a test waits for the one time it does.
 */
export async function waitForOpeningView(page: Page): Promise<void> {
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
}

/**
 * Wait until the Layer stack has been put on the map.
 *
 * The handle appears when `drawLayerStack` has run, which is what every assertion about what MapLibre
 * drew depends on. `styledata` fires long before a style is complete, so the app gates on
 * `isStyleLoaded()`; this is generous for the same reason.
 */
export async function waitForStack(page: Page): Promise<void> {
	await expect
		.poll(
			() =>
				page.evaluate(() => (window as unknown as StackWindow).ballastellaLayerStack !== undefined),
			{
				timeout: 30_000
			}
		)
		.toBe(true);
}

/**
 * Reload the Layers pane on a Project that already has a Layer, ready to assert against the map.
 *
 * What every test that seeds a fixture behind the app's back needs: open, wait for the stack, put the
 * view back where the fixture's coordinates are, and **open the Layer**.
 *
 * That last step is the same one {@link startAnnotating} takes, and it is here for the reason it is a
 * step at all: which Layer is open is component state and is deliberately not persisted (ADR-0002,
 * ADR-0010), so a reload correctly leaves every row closed. A test that reloads and expects
 * to find the Annotation list where it left it is asking for the Layer to be opened again, and this
 * is where that is said once rather than in seven specs.
 */
export async function reopenLayers(page: Page, directory = PROJECT_DIRECTORY): Promise<void> {
	await openLayers(page, directory);
	await waitForStack(page);
	await centreOnAmsterdam(page);
	await openLayerRow(page);
}

export const baseMap = (page: Page) => page.getByTestId('base-map-pane');

/** Click at a fraction across the Base Map pane. */
export async function clickAt(target: Locator, fx: number, fy: number): Promise<void> {
	const box = await target.boundingBox();
	if (!box) throw new Error('the pane has no box to click in');
	await target.click({ position: { x: box.width * fx, y: box.height * fy } });
}

/**
 * Choose a drawing tool.
 *
 * **Two clicks, not one.** Selecting is the resting behaviour rather than a tool, so the shapes
 * live behind "New Annotation" and `select` is reached by cancelling them. Every test drives the
 * tools through here, so what a scholar presses is stated once.
 *
 * **And "New Annotation" is pressed once per shape**, because finishing a gesture disarms the tool and
 * puts the shapes away: one press, one Annotation. That is why this asks whether the shapes are on
 * offer rather than assuming they are — a caller drawing two shapes in a row arrives here with the
 * button showing, not the shapes.
 */
export async function chooseTool(
	page: Page,
	tool: 'select' | 'point' | 'line' | 'polygon' | 'text'
): Promise<void> {
	const shapes = page.getByTestId('annotation-tools');
	if (tool === 'select') {
		if ((await shapes.count()) > 0) await page.getByTestId('annotation-cancel').click();
		await expect(page.getByTestId('annotation-new')).toBeVisible();
		return;
	}
	if ((await shapes.count()) === 0) await page.getByTestId('annotation-new').click();
	await page.getByTestId(`annotation-tool-${tool}`).click();
}

/** The Annotation Inspector, docked over the Base Map pane's top-right (ADR-0035). */
export const inspector = (page: Page) => page.getByTestId('annotation-inspector');

/**
 * Make sure the Annotation at `index` in the list is the selected one.
 *
 * **Not simply a click**, because the row toggles the selection and drawing something already selects
 * it — a newly drawn shape is selected so that it can be titled straight away, which is the point of
 * drawing it. Clicking it unconditionally would therefore *deselect* it, and the Inspector and the
 * vertex handles would both vanish. That is not a hypothetical: it is what the first run of this
 * suite did, and eleven tests failed on it with the row still focused and looking selected.
 *
 * **Puts the drawing tools away first**, which is only ever about the tools: the list is on screen
 * throughout, and a finished gesture puts the shapes away by itself. What is left for this to do is
 * the case where the shapes are on offer and nothing was drawn, so that a caller asking for a row is
 * not left with a half-started gesture behind it.
 *
 * **Waits for the Inspector to be showing the row's own Annotation**, by the ordinal both draw from
 * one rule (`annotationOrdinal`): one Inspector on the screen, headed by the number the row carries.
 * A caller that went straight on would be reaching into a panel that had not yet been handed the new
 * selection.
 */
export async function selectAnnotation(page: Page, index = 0): Promise<void> {
	await chooseTool(page, 'select');
	const row = page.getByTestId('annotation-row').nth(index);
	await expect(row).toBeVisible();
	if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
	await expect(row).toHaveAttribute('aria-expanded', 'true');
	await expect(inspector(page)).toHaveCount(1);
	await expect(page.getByTestId('annotation-inspector-ordinal')).toHaveText(String(index + 1));
}

/**
 * Put the selected Annotation's title and description into their fields.
 *
 * The Inspector's Text face shows them as **text** until *Edit text* is pressed, so every test that
 * types into them goes through here. Idempotent: pressing the button again once the fields are open
 * would be a click on whatever moved under it — which is also what makes it right to call after
 * drawing, where the fields are open already because a shape just drawn arrives with the keyboard in
 * its title.
 *
 * **Asks for the Text face first**, because a test that styled something before typing left the Style
 * face showing and there is no *Edit text* on it. One press of the strip's own Text tab, which is what
 * a scholar does.
 */
export async function editAnnotationText(page: Page): Promise<void> {
	await openFace(page, 'text');
	const edit = page.getByTestId('annotation-edit-text');
	if ((await edit.count()) > 0) await edit.click();
	await expect(page.getByTestId('annotation-title')).toBeVisible();
}

/**
 * Show one of the Inspector's two faces.
 *
 * **The Style face is one deliberate press away and never simply present**, so every test that
 * touches a swatch or a slider comes through here — and the strip has no memory, so selecting another
 * Annotation puts it back on Text and the next caller has to ask again.
 *
 * A click on the tab's own `<label>`, which is where daisyUI puts the hit target; the radio inside it
 * is `opacity: 0` and spread over the label.
 */
export async function openFace(page: Page, face: 'text' | 'style'): Promise<void> {
	const showing = page.getByTestId('annotation-inspector-face');
	if ((await showing.getAttribute('data-face')) === face) return;
	await page.getByTestId(`annotation-inspector-tab-${face}`).click();
	await expect(showing).toHaveAttribute('data-face', face);
}

/**
 * Delete the selected Annotation from the Inspector.
 *
 * **Through the Text face**, which is where the delete is: beside the words it destroys rather than on
 * the row or in the Layer card's footer beside *Delete Layer*. A caller that has just styled something
 * is looking at the Style face, so the face is asked for rather than assumed.
 */
export async function deleteAnnotation(page: Page): Promise<void> {
	await openFace(page, 'text');
	await page.getByTestId('annotation-delete').click();
}

/** Choose the selected Annotation's line style. A radio group, so this is a click, not a select. */
export async function chooseLineStyle(
	page: Page,
	style: 'solid' | 'dashed' | 'dotted'
): Promise<void> {
	await openFace(page, 'style');
	await page.getByTestId(`annotation-line-style-${style}`).click();
}

/**
 * The nine colours an Annotation can be, by the name each swatch carries. See `ColorPicker.svelte`.
 *
 * Spelled out here rather than imported from `@ballastella/core` **on purpose**: a test that took its
 * expected value from the same constant the app draws from would pass if the palette were changed to
 * nine shades of the same green. The hex is what lands in the file, so the hex is what the suite states.
 */
export const ANNOTATION_COLOR = {
	black: '#000000',
	grey: '#555555',
	white: '#ffffff',
	red: '#d32f2f',
	orange: '#ef6c00',
	yellow: '#fbc02d',
	green: '#388e3c',
	blue: '#1976d2',
	purple: '#7b1fa2'
} as const;

/**
 * Choose one of the nine colours for the pin, the line, or the fill.
 *
 * A click on a named swatch, not `fill()` on a colour well: the wells are gone, and the point of the
 * palette is that there is no way to type `#aa3311` into this app any more.
 *
 * @param which the control — `annotation-marker-color`, `annotation-stroke`, or `annotation-fill`
 * @returns the hex the app should now have written, so a caller can assert on it without restating it
 */
export async function chooseColour(
	page: Page,
	which: 'annotation-marker-color' | 'annotation-stroke' | 'annotation-fill',
	colour: keyof typeof ANNOTATION_COLOR
): Promise<string> {
	await openFace(page, 'style');
	await page.getByTestId(`${which}-${colour}`).click();
	// The chosen swatch says so, so a caller that goes straight to the file is asserting on a choice the
	// interface has actually taken rather than on a click that landed somewhere.
	await expect(page.getByTestId(`${which}-${colour}`)).toHaveAttribute('data-chosen', 'true');
	return ANNOTATION_COLOR[colour];
}

/** Draw a pin at a fraction across the pane, and wait for it to reach the file. */
export async function drawPin(page: Page, fx: number, fy: number): Promise<void> {
	await chooseTool(page, 'point');
	await clickAt(baseMap(page), fx, fy);
	await expect(page.getByRole('status')).toHaveText('Saved locally');
}

/** Draw a line or a shape through the given fractions, finishing with the Done button. */
export async function drawShape(
	page: Page,
	tool: 'line' | 'polygon',
	points: readonly (readonly [number, number])[]
): Promise<void> {
	await chooseTool(page, tool);
	for (const [fx, fy] of points) await clickAt(baseMap(page), fx, fy);
	await expect(page.getByTestId('annotation-done')).toBeEnabled();
	await page.getByTestId('annotation-done').click();
	await expect(page.getByRole('status')).toHaveText('Saved locally');
}

/**
 * The **distinct** MapLibre layers that painted an Annotation, keyed by the Annotation's own id.
 *
 * Deduplicated, and that is not tidying. `queryRenderedFeatures` returns a geometry **once per tile it
 * spans**, so one line long enough to cross a tile boundary comes back two or three times from the same
 * layer. Counting those as separate layers made "exactly one line layer painted this" fail
 * intermittently — depending on where the viewport happened to put the tile seams, which is precisely
 * the kind of assertion that passes on a developer's machine and fails in CI. The question being asked
 * is *which* layers painted it, and that is a set.
 */
export const renderedAnnotationLayers = (page: Page) =>
	page.evaluate(() => {
		const stack = (window as unknown as StackWindow).ballastellaLayerStack;
		if (!stack) return {};
		const byId: Record<string, string[]> = {};
		for (const feature of stack.map.queryRenderedFeatures()) {
			const id = feature.properties?.['ballastella:id'];
			if (typeof id !== 'string') continue;
			const seen = (byId[id] ??= []);
			if (!seen.includes(feature.layer.id)) seen.push(feature.layer.id);
		}
		return byId;
	});

/**
 * Wait until every one of `annotationIds` has been painted, then return what painted each.
 *
 * **Polled rather than sampled once.** `queryRenderedFeatures` answers about the frame that has been
 * drawn, so asking too early returns nothing — and nothing is indistinguishable from "the Annotation is
 * not on the map", which is a flake in the direction that hides a defect. Re-centring the map already
 * waits for `idle`, but `idle` can fire before a GeoJSON source has finished parsing, and the suite runs
 * four workers each driving a real WebGL context (see `playwright.config.ts` on contention).
 *
 * The assertion is still on what MapLibre reports it drew; only the *timing* is tolerant.
 */
export async function waitForPaintedAnnotations(
	page: Page,
	annotationIds: readonly string[]
): Promise<Record<string, string[]>> {
	await expect
		.poll(
			async () => {
				const painted = await renderedAnnotationLayers(page);
				return annotationIds.every((id) => (painted[id] ?? []).length > 0);
			},
			{ timeout: 20_000 }
		)
		.toBe(true);
	return renderedAnnotationLayers(page);
}

/** One MapLibre paint property of one of the stack's layers. */
export const paintProperty = (page: Page, layerId: string, name: string) =>
	page.evaluate(
		([layerId, name]) => {
			const map = (window as unknown as StackWindow).ballastellaLayerStack?.map;
			if (!map || !map.getLayer(layerId as string)) return null;
			return map.getPaintProperty(layerId as string, name as string) ?? null;
		},
		[layerId, name]
	);
