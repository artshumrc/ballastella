import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unavailableNotice } from './support/base-map-notice.js';
import { openLayerRow } from './support/layers.js';
import { leaderIsDrawn, leaderLayer, leaderPoints } from './support/leader.js';
import {
	baseMapArchiveFixture,
	byteRange,
	cachedBaseMapTiles,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	routePartialBaseMapArchive
} from './support/editor-deployment';

import {
	asJson,
	servePublishedSite,
	siteRecord,
	writePublishedSite,
	writeSiteFile,
	type SiteFiles
} from './support/published-site.js';
import {
	annotation,
	ANNOTATION_LAYER_ID,
	IMAGE_ID,
	infoJson,
	MAP_LAYER_ID,
	projectFiles,
	type ProjectFixture
} from './support/reader-project.js';
import { serveDirectory, type StaticSite } from './support/static-site.js';
import { tilesServerErrorNotice, tilesUnavailableNotice } from './support/tile-failure-notice.js';

// Every catalog entry reads a remote archive since ticket 10, so a Reader test that wants a map to
// actually draw has to serve real pmtiles bytes from somewhere. The fixture, not the real host: an
// internet dependency in this suite would be a flake with a good excuse.
test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

/**
 * SPEC's Seam 2 for ticket 17: the read-only experience a Reader gets from a Published Site, driven in a
 * real browser against a real static server.
 *
 * Everything here runs against **the built viewer** — `apps/viewer/build`, the same bytes
 * `scripts/stage-viewer-bundle.mjs` stages and `publishSite` writes — served over plain HTTP out of a
 * directory with no server-side logic, no rewriting, and no SPA fallback, because a static host has none
 * of those (ADR-0006). `e2e/support/static-site.ts` is ticket 16's harness, reused unchanged; ticket 16
 * mutation-verified that the **subdirectory** is the load-bearing half of it, since pointing data reads
 * at `/` instead of at the document leaves the root site green and only the subdirectory red.
 */

/**
 * The Reader's live map, as `apps/viewer/src/lib/browser-test-handle.ts` exposes it.
 *
 * Declared here rather than imported, because this suite's tsconfig does not include the app's source —
 * the same arrangement `editor-publish.e2e.ts` uses for `ballastellaServedTiles`. The shapes are read
 * structurally, so `warped` is deliberately loose: what a `WarpedMapLayer` is belongs to
 * `@allmaps/maplibre`, and naming it here would make this file depend on the render stack.
 */
type ReaderMapHandle = {
	map: {
		getLayersOrder(): string[];
		getStyle(): { layers: Record<string, unknown>[] };
		queryRenderedFeatures(at?: [number, number]): {
			layer: { id: string };
			properties: Record<string, unknown>;
		}[];
		project(lngLat: [number, number]): { x: number; y: number };
		/** The map's own canvas, for the one claim `queryRenderedFeatures` cannot answer: what colour. */
		getCanvas(): HTMLCanvasElement;
		once(event: 'render', listener: () => void): void;
		triggerRepaint(): void;
		jumpTo(options: { center: [number, number]; zoom?: number }): void;
		fitBounds(bounds: unknown, options?: Record<string, unknown>): void;
		getCenter(): { lng: number; lat: number };
		getZoom(): number;
		getBounds(): { contains(lngLat: [number, number]): boolean };
	};
	warped: Record<
		string,
		{
			getBounds(): unknown;
			getOpacity?(): number;
			renderer?: { tileCache?: { getCachedTiles?: () => unknown[] } };
		}
	>;
	builds: number;
};

declare global {
	interface Window {
		/** Set by an XSS payload that ran. Nothing in the app touches it. */
		__xss?: unknown;
		ballastellaReaderMap?: ReaderMapHandle;
		/** Cached Base Map tiles the protocol handler answered **with bytes** (ticket 11). */
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		/** What {@link watchNoticeArrivals} has recorded, in this page's own DOM order. */
		__noticeArrivals?: { kind: 'insert' | 'change'; text: string }[];
	}
}

/** Everything a payload could do that a page would let us see. */
type PageWatch = {
	/** Uncaught exceptions, dialogs, and console errors, in order. */
	readonly failures: string[];
	/** Every request the browser made, with its method. */
	readonly requests: { method: string; url: string }[];
};

/**
 * Watch a page for the four things an XSS payload does, plus every request it made.
 *
 * `pageerror` and `dialog` because a payload that ran usually throws or opens something; `window.__xss`
 * because the payloads below set it and a page that never threw could still have run one; and the request
 * log because "a view control makes no write attempt" is a claim about HTTP methods.
 */
function watch(page: Page): PageWatch {
	const failures: string[] = [];
	const requests: { method: string; url: string }[] = [];
	page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
	page.on('dialog', (dialog) => {
		failures.push(`dialog: ${dialog.message()}`);
		void dialog.dismiss();
	});
	page.on('request', (request) => requests.push({ method: request.method(), url: request.url() }));
	return { failures, requests };
}

/**
 * How an always-present notice's sentence reached the page: with the element, or after it.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THE ATTRIBUTES ARE NOT ENOUGH, AND WHAT THIS ASSERTS INSTEAD
 *
 * `aria-live` announces a **change of text inside a region that is already there**. So asserting
 * `aria-live="polite"` and `aria-atomic="true"` on a notice says only that the mechanism is spelled
 * right; it says nothing about whether the browser ever performed a change for that mechanism to
 * announce. A region inserted with its sentence already in it carries both attributes, reads
 * correctly in every snapshot, and is heard by nobody — which is exactly what these two notices did
 * while they sat in the map's controls column, because that column is built client-side once the
 * Project file resolves and both sentences are settled before it exists.
 *
 * A `MutationObserver` installed from document creation is the only thing that can tell the two
 * apart, because the difference is a sequence rather than a state and nothing is left on the page
 * afterwards to read. The consecutive-duplicate collapse is what makes the log an assertion instead
 * of a transcript: hydration writes the same empty string several times over.
 */
type NoticeArrival = { kind: 'insert' | 'change'; text: string };

/**
 * Record every arrival of one notice's text, from document creation, before the page has any of
 * its own script.
 */
async function watchNoticeArrivals(page: Page, testid: string): Promise<void> {
	await page.addInitScript((id) => {
		const selector = `[data-testid="${id}"]`;
		const arrivals: NoticeArrival[] = [];
		window.__noticeArrivals = arrivals;
		let last: string | null = null;
		const say = (kind: NoticeArrival['kind'], element: Element) => {
			const text = (element.textContent ?? '').trim();
			if (text === last) return;
			last = text;
			arrivals.push({ kind, text });
		};
		const asElement = (node: Node): Element | null =>
			node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
		new MutationObserver((records) => {
			for (const record of records) {
				let inserted = false;
				for (const node of record.addedNodes) {
					const element = asElement(node);
					const found = element?.matches(selector)
						? element
						: (element?.querySelector(selector) ?? null);
					if (found === null || found === undefined) continue;
					say('insert', found);
					inserted = true;
				}
				// Anything that is not the element arriving is text moving inside one already on the page.
				if (inserted) continue;
				const host = asElement(record.target)?.closest(selector) ?? null;
				if (host !== null) say('change', host);
			}
		}).observe(document, { childList: true, subtree: true, characterData: true });
	}, testid);
}

/** What {@link watchNoticeArrivals} saw, in order. */
const noticeArrivals = (page: Page): Promise<NoticeArrival[]> =>
	page.evaluate(() => window.__noticeArrivals ?? []);

/**
 * The dangerous shapes inside `host`, as the **rendered DOM** has them.
 *
 * Read off the live DOM rather than off the HTML string, deliberately: a sanitiser is a claim about what
 * the browser ends up holding, and a string comparison would pass on markup the parser had already
 * mangled into something live. Six probes, because each one is a different way through:
 *
 *   - `<script>` at all, at any depth
 *   - any `on*` attribute, whatever its case
 *   - a `javascript:` or `data:` URL on `href` or `src`, whitespace and case normalised the way a
 *     browser does before dispatching a navigation
 *   - `<img>` at all, which is what makes `<img src=x onerror=…>` *disappear* rather than merely lose
 *     an attribute (`img` is absent from the allowlist, which also takes the surface out of DOMPurify's
 *     `DATA_URI_TAGS`)
 *   - `<iframe>`, `<object>`, `<embed>`, `<form>`, and `<svg>`, each of which carries its own execution
 *     or credential-collection route
 */
async function dangerousIn(host: Locator): Promise<Record<string, unknown>> {
	return host.evaluate((element) => {
		const handlers: string[] = [];
		const urls: string[] = [];
		for (const node of [element, ...element.querySelectorAll('*')]) {
			for (const attribute of node.attributes) {
				const name = attribute.name.toLowerCase();
				if (name.startsWith('on')) handlers.push(name);
				if (name === 'href' || name === 'src' || name === 'xlink:href') {
					// Whitespace and C0 control characters dropped and the rest lower-cased, which is what a
					// browser does before it decides a URL's scheme. `java\nscript:` is a **live** scheme rather
					// than inert text, so a probe reading the raw attribute would miss it — which is why one of
					// the payloads above breaks a scheme across a newline. A filter rather than a character-class
					// regex, so the control range is legible instead of escaped.
					const value = [...attribute.value]
						.filter((character) => (character.codePointAt(0) ?? 0) > 0x20)
						.join('')
						.toLowerCase();
					if (value.startsWith('javascript:') || value.startsWith('data:')) urls.push(value);
				}
			}
		}
		const count = (selector: string) => element.querySelectorAll(selector).length;
		return {
			scripts: count('script'),
			handlers,
			dangerousUrls: urls,
			images: count('img'),
			embeds: count('iframe, object, embed, form, svg')
		};
	});
}

/** Nothing dangerous survived, in the shape `dangerousIn` reports. */
const INERT = {
	scripts: 0,
	handlers: [],
	dangerousUrls: [],
	images: 0,
	embeds: 0
} as const;

/**
 * Every payload shape asserted on every untrusted-text surface.
 *
 * Each carries **legitimate prose as well**, and that is not decoration. `{@html}` is not re-rendered
 * during hydration — Svelte adopts the server's nodes and never compares them — so a surface that
 * renders *nothing at all*, permanently and with no warning, passes every "is it inert?" assertion
 * there is. Ticket 10 established that discipline; this is the viewer, which is exactly where it bit.
 * So each payload's `prose` is asserted **present** before anything about what is absent.
 */
const PAYLOADS = [
	{
		what: 'a script element',
		prose: 'The warehouse district',
		markdown: 'The warehouse district<script>window.__xss = "script"</script>'
	},
	{
		what: 'an img onerror handler',
		prose: 'Rebuilt after the fire',
		markdown: 'Rebuilt after the fire <img src=x onerror="window.__xss = \'img\'">'
	},
	{
		what: 'a javascript: link, which only exists if marked ran before DOMPurify',
		prose: 'See the survey',
		markdown: 'See the survey: [the survey](javascript:window.__xss="href")'
	},
	{
		what: 'a data: URL link',
		prose: 'A note on sources',
		markdown:
			'A note on sources: [note](data:text/html;base64,PHNjcmlwdD53aW5kb3cuX194c3M9MTwvc2NyaXB0Pg==)'
	},
	{
		what: 'an event handler on a tag the allowlist permits',
		prose: 'Emphatically so',
		markdown: '*Emphatically so* <span onmouseover="window.__xss=1">hover</span>'
	},
	{
		what: 'an iframe and a form',
		prose: 'The 1625 survey',
		markdown:
			'The 1625 survey <iframe src="javascript:window.__xss=1"></iframe>' +
			'<form action="https://evil.example"><input name="password"></form>'
	},
	{
		what: 'an svg carrying its own script',
		prose: 'Drawn from the original',
		markdown: 'Drawn from the original <svg><script>window.__xss=1</script></svg>'
	},
	{
		what: 'a scheme broken across a newline, which a browser still dispatches',
		prose: 'Compare the 1649 edition',
		markdown: 'Compare the 1649 edition: <a href="java&#x0A;script:window.__xss=1">here</a>'
	}
] as const;

/** Open a site holding one Project, and hand back the two served base paths. */
async function published(
	files: SiteFiles,
	options: { withoutBaseMap?: boolean } = {}
): Promise<{ sites: StaticSite[]; directory: string; close(): Promise<void> }> {
	return servePublishedSite(files, options);
}

/** The Workspace of one Project, plus the site record that lists it. */
function oneProject(fixture: ProjectFixture = {}, record: Record<string, unknown> = {}): SiteFiles {
	const directory = fixture.directory ?? 'amsterdam-1625';
	return {
		'ballastella-site.json': siteRecord(
			[{ directory, name: fixture.name ?? 'Amsterdam 1625' }],
			record
		),
		...projectFiles(fixture)
	};
}

/**
 * The editor instance a site's return links point at (SPEC story 51).
 *
 * A **different origin** from the site, which is the ordinary topology under ADR-0032 and the reason
 * these are plain links: nothing is handed across, so nothing has to be.
 */
const EDITOR_INSTANCE = 'https://maps.example.edu/ballastella/';

/**
 * A site as a publish to a Remote leaves it: the record naming the instance that wrote it, and the
 * binding naming the repository, which is inside the published tree deliberately (ADR-0032).
 */
function publishedByEditor(): SiteFiles {
	return {
		...oneProject({}, { editorUrl: EDITOR_INSTANCE }),
		'remote.json': asJson({ formatVersion: 1, owner: 'ada', repository: 'atlas' })
	};
}

/** Wait until the Reader's map has built its stack, so assertions are about a drawn map. */
async function mapReady(page: Page): Promise<void> {
	await expect(page.getByTestId('reader-map-pane')).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.ballastellaReaderMap !== undefined), { timeout: 30_000 })
		.toBe(true);
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE LAYER STACK, WHICH IS THE EDITOR'S CARD (ticket 05)
//
// A Reader reads the same component a scholar authors on, so these are the *shared* identities
// rather than a `reader-` alias for them: one element, one id, and a suite that reads the same in
// both apps. `e2e/support/layers.ts` — written for the editor — drives it here unchanged, which is
// the property worth having.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Layer stack, by the name the shared `<ol>` carries.
 *
 * By role and accessible name rather than by a test id, because the list has none and should not
 * gain one for a test: what makes the stack findable is the same label a screen reader is given, and
 * ADR-0002's ordering claim rides on it being an `<ol>`.
 */
const layerStack = (page: Page): Locator => page.getByRole('list', { name: 'Layers, top first' });

/**
 * One Layer's card.
 *
 * ⚠ **The test id is part of the selector, not decoration.** `data-layer-id` is on the card *and* on
 * the contents it reveals, so a bare attribute selector matches two elements the moment the card is
 * open and every assertion scoped to it fails Playwright's strict mode instead of failing honestly.
 */
const layerRow = (page: Page, id: string): Locator =>
	page.locator(`[data-testid="layer-row"][data-layer-id="${id}"]`);

/** The visibility toggle of one Layer's card. */
const layerVisible = (page: Page, id: string): Locator =>
	layerRow(page, id).getByTestId('layer-visible');

/**
 * Every control the shared card offers the editor and must never offer a Reader (SPEC story 19).
 *
 * ⚠ **These absences are not asserted alone**, which is the rule this epic keeps: every id below
 * except `layer-name` is asserted *present* against the editor's prop set in
 * `packages/ui/src/layer-list.dom.test.ts`, and `layer-image-mode` is asserted present in the running
 * editor by `e2e/editor-layers.e2e.ts`'s "shows the Layer as a local copy". Rename one of these
 * strings and those go red rather than these going quietly green.
 *
 * `layer-name` is the rename *field*, which only exists behind the pencil — so its absence here says
 * the pencil could not have been pressed either. Its positive control is the pencil being *pressed*
 * rather than a prop set: `layer-list.dom.test.ts`'s "offers the rename pencil, and the name as a
 * field, only with ontypename and oncommit" and `e2e/editor-layers.e2e.ts`'s "reorder, rename, toggle,
 * and opacity leave alignments and annotations byte-identical" both press it and then fill the field
 * that appears.
 */
const EDITING_CONTROLS = [
	'layer-rename',
	'layer-name',
	'layer-move-up',
	'layer-move-down',
	'layer-delete',
	'layer-drag-handle',
	'layer-image-mode'
] as const;

/**
 * Words that only make sense to somebody who can edit, which must reach no Reader.
 *
 * ⚠ **Prose, because a sweep that looks only for controls misses the sentences about them.** The
 * shared card's empty state was the editor's own guidance verbatim, so a published Project with no
 * Layers told a Reader to press two buttons that do not exist there and named the Workspace they draw
 * from — invisible to every assertion above, because the two Add names are `<strong>` text inside a
 * `<p>` and nothing on that page is a `button` at all.
 *
 * Each phrase is one the editor really says: the two Add labels are the words on
 * `ProjectScreen`'s own buttons, "this Workspace" is the concept a published site does not have, and
 * the fourth is the open card of a Layer this build cannot draw promising three editing affordances a
 * Reader is offered none of two of. That one was the same bug found a second time, in a sentence
 * rather than in an empty state, which is why this list is a list rather than a special case.
 *
 * **The fifth is that bug a third time, one level further in**: the shared Annotation list's empty
 * state said "Nothing in this Layer yet", and on a Published Site there is no control that could ever
 * put anything in it — so "yet" promised a Reader something that cannot happen. The word is the whole
 * of the phrase that matters, and it is the editor's own guidance now, beside the button it names.
 *
 * The last three are the sentences the map pane's shared components carry past (ticket 11): the
 * editor's own empty-stack line, which `MapCommentary` renders through a snippet rather than
 * composing, and its offline reassurance, which `MapNotice` takes as children. Both are one edit away
 * from being written into shared code — that edit has been made four times in this epic — and neither
 * was matched by anything above: "this Workspace" is not "your Workspace", and an `sr-only`
 * commentary is invisible to every control sweep. This one reads `textContent`, so it reaches both.
 */
const EDITOR_ONLY_PROSE = [
	'Add a Map Image',
	'Add an Annotation Layer',
	'this Workspace',
	'you can still rename',
	'Nothing in this Layer yet',
	'New Annotation',
	'Nothing is on the map yet.',
	'Everything in your Workspace still works',
	'you can add a Map Image now'
] as const;

/**
 * Nothing on this page could change the author's work, or tell a Reader how to.
 *
 * A count of zero rather than "not visible": a control that is not in the document cannot be clicked,
 * cannot be tabbed to, and cannot be reached by a screen reader — which is the whole of the claim,
 * and stronger than anything a focus walk could assert. The Add controls are the editor's Project
 * screen's rather than the card's, and are named by the words on them for the same reason.
 *
 * The prose sweep reads `textContent` rather than `innerText`, so a sentence in an `sr-only` region
 * is caught too: an instruction only a screen-reader user is given is the worst version of this bug,
 * not an acceptable one.
 */
async function expectNothingEditable(page: Page): Promise<void> {
	for (const control of EDITING_CONTROLS) {
		await expect(page.getByTestId(control), `${control} in the viewer`).toHaveCount(0);
	}
	await expect(page.getByRole('button', { name: /^Add a/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Add an/ })).toHaveCount(0);
	await expectNoEditorProse(page);
}

/**
 * No sentence on this page was written for somebody who can edit.
 *
 * Its own function because the Annotation sweep needs it too and had only ids: nine `data-testid`s
 * would catch a renamed control and never an editor-only sentence, which is the defect that has now
 * been found in shared code four times — twice in `LayerList`, once in a Layer card body, and once in
 * the Annotation list's empty state.
 */
async function expectNoEditorProse(page: Page): Promise<void> {
	for (const phrase of EDITOR_ONLY_PROSE) {
		await expect(page.locator('body'), `“${phrase}” in the viewer`).not.toContainText(phrase);
	}
}

/**
 * Where the fixture Annotation sits. Must match `annotation()`'s default in `support/reader-project`.
 *
 * Named here rather than exported from the fixture because it is what this file *clicks on*, and a
 * coordinate the fixture could change without this file noticing is a test that silently starts clicking
 * empty geography — which would make every popup assertion below pass vacuously on an absent popup.
 */
const ANNOTATION_AT: [number, number] = [4.9, 52.3676];

/**
 * The Annotation that sits at {@link ANNOTATION_AT}, and so the one a click there opens.
 *
 * Must match `annotation()`'s default id in `support/reader-project`. Named because a fixture with
 * more than one Annotation has more than one row, and "the first row in the DOM" is then a different
 * Annotation from the one the test tapped.
 */
const TAPPED_ANNOTATION_ID = '11111111-1111-4111-8111-111111111111';

/**
 * One render bucket of the fixture Annotation Layer, by the MapLibre layer id the stack gives it.
 *
 * Spelled out here rather than imported from `@ballastella/core`: hit-testing is by layer id, so the
 * id *is* the contract between the render stack and everything that points at a drawing, and a
 * fixture that composed it from the same helper the application composes it with would agree with
 * itself however wrong both were.
 */
const bucket = (part: string): string => `ballastella-layer-${ANNOTATION_LAYER_ID}-${part}`;

/**
 * The archive every entry in this deployment's catalog points at (ADR-0020).
 *
 * Named here because a site's cached tiles sit in a directory keyed on it (ticket 12), and because
 * the site record has to say which archive its tiles are for — a Reader's HTTP store cannot list a
 * directory to find out, and drawing one archive's tiles under another entry is the wrong-map
 * failure the key exists to end. `scripts/check-base-map-catalog.mjs` exempts `*.e2e.ts`; this file
 * already names entry ids for the same reason.
 */
const ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';

/**
 * The narrowest viewport at which a Project's stack and its map are still two columns, in CSS pixels.
 *
 * Tailwind's `lg`, which this page's Project grid has always used and which the editor's Project
 * screen adopted — so both applications stack at the same width and `leaderPath`'s refusal on a
 * stacked layout begins in both at the same place.
 *
 * ⚠ **Written out here and again in `e2e/editor-annotations.e2e.ts`, deliberately.** The Playwright
 * project resolves nothing from the applications or from their stylesheet, and the claim "the same
 * width that stacks one stacks the other" *is* the two copies being asserted independently against
 * the two built apps; one shared constant would only prove that both tests read one number. Named on
 * both sides so each can be found from the other.
 */
const STACKS_BELOW = 1024;

/**
 * The host that archive is fetched from — what an outage notice names at a Reader.
 *
 * Derived rather than written a second time, so a repoint of the catalog is one edit here instead
 * of two that can disagree. When it does drift from `base-map/catalog.ts`, this suite is what says
 * so: `scripts/check-base-map-catalog.mjs` exempts `*.e2e.ts`.
 */
const ARCHIVE_HOST = new URL(ARCHIVE).host;

/**
 * Click the fixture Annotation's pin on the map, and hand back the Inspector's showing face.
 *
 * **A pin selects the Annotation's own row and no popup is drawn** (ticket 07), and the Annotation is
 * read in the Annotation Inspector docked over the pane (ADR-0035) — one destination in both apps, so
 * the answer to "what is this pin?" is in one place rather than two. This waits on the row's
 * `aria-expanded` rather than on a bubble over the map. Its Layer's card opens with it, because a row
 * inside a closed card is not on the screen at all.
 *
 * **The face rather than the whole panel**, because the panel carries the identity header's Lucide
 * glyphs and the dismiss control's — first-party `<svg>`, which {@link dangerousIn} counts as an
 * embed. The face holds the description and nothing else, so it is what a payload probe can be
 * pointed at; the header's own inertness is asserted separately, where it is a title.
 *
 * The click lands on the Annotation's **projected screen position** rather than on the middle of the
 * pane, and that distinction is why this helper exists: the Base Map catalog's initial centre is
 * deployment configuration a fork may change, so "the middle of the pane" is the Annotation's position
 * only by coincidence. It was off by about 24 px, so the first run of this suite clicked empty geography
 * — a failure that looked like a broken feature.
 *
 * Retried, because the GeoJSON source may not have painted on the first frame: `queryRenderedFeatures`
 * answers about what is *rendered*, so a click one frame early is a genuine miss rather than a defect.
 * Clicking a pin is not a toggle — it names the Annotation to open rather than flipping it — so a
 * second click while the first is settling cannot close what it just opened.
 *
 * `at` and `annotationId` are for a fixture carrying more than one Annotation, where "some row is
 * expanded" is satisfied by the wrong one: naming the id makes the poll wait for the row belonging to
 * the drawing that was clicked, which is what turns "a Label is clickable" into a claim about *that*
 * Label rather than about the list having a selection.
 */
async function openAnnotationFromMap(
	page: Page,
	at: [number, number] = ANNOTATION_AT,
	annotationId?: string
): Promise<Locator> {
	const opened =
		annotationId === undefined
			? '[data-testid="annotation-row"][aria-expanded="true"]'
			: `[data-testid="annotation-row"][data-annotation-id="${annotationId}"][aria-expanded="true"]`;
	const pane = page.getByTestId('reader-map-pane');
	// **Scrolled into view, and the box re-read inside the loop.** `page.mouse.click` takes *viewport*
	// coordinates while `boundingBox()` gives page ones, so on the 375 px layout — where the controls come
	// first in the DOM and the map is below the fold — a click composed from a stale box lands somewhere
	// else entirely. That is a real difference between the desktop and phone runs, and it is exactly the
	// kind of thing a desktop-only suite would never see.
	await pane.scrollIntoViewIfNeeded();
	await expect
		.poll(
			async () => {
				const box = (await pane.boundingBox())!;
				const point = await page.evaluate(
					(lngLat) => window.ballastellaReaderMap!.map.project(lngLat),
					at
				);
				await page.mouse.click(box.x + point.x, box.y + point.y);
				return page.locator(opened).count();
			},
			{ timeout: 30_000, intervals: [250, 500, 1000] }
		)
		.toBeGreaterThan(0);
	// Nothing was drawn over the map: the Inspector is the destination, and a bubble over the pin would
	// be a second place to read the same Annotation.
	await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
	await expect(page.getByTestId('annotation-inspector')).toHaveCount(1);
	return page.getByTestId('annotation-inspector-face');
}

/**
 * Select the fixture Annotation from its row in the Layer's card, and hand back the Inspector's face.
 *
 * **This is where a Reader actually reads an Annotation** (SPEC stories 32–34): the Annotation Layer
 * is the top card in the fixture's stack, its card lists what is in it, a row selects, and the words
 * arrive in the Inspector over the map (ADR-0035). No pin, no map and no popup are involved in
 * getting here, which is the whole point — the row is reachable from the sidebar by somebody who has
 * not found the pin.
 *
 * Idempotent for the same reason `openLayerRow` is, and here it is load-bearing rather than
 * defensive: clicking a pin on the map selects that Annotation's row too — one Annotation is active
 * and there is one answer to which — so a caller that clicked the pin first arrives with the row
 * already selected, and an unconditional click would deselect it.
 *
 * **The face rather than the whole panel**, for the reason {@link openAnnotationFromMap} records.
 */
async function openAnnotationRow(page: Page): Promise<Locator> {
	const card = await openLayerRow(page, layerRow(page, ANNOTATION_LAYER_ID));
	const row = card.getByTestId('annotation-row').first();
	await expect(row).toBeVisible();
	if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
	await expect(row).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('annotation-inspector')).toHaveCount(1);
	return page.getByTestId('annotation-inspector-face');
}

/**
 * Everything an author can do to an Annotation, which must reach no Reader (SPEC story 19).
 *
 * ⚠ **Asserted against an open row rather than against the page**, which is what stops it passing
 * vacuously: with the Annotation Layer's card closed, every id below is absent because there is no
 * row on the screen at all, and the assertion would say nothing about what a row contains.
 *
 * ⚠ **`annotation-place-search` and the drawing tools are the sharpest of these.** A place search
 * issues a lookup to a third-party service, and a Published Site quietly doing that for a Reader who
 * asked for nothing is the outcome ADR-0029 is written against. They are absent because this app
 * passes `AnnotationList` no `tools` snippet — not because a flag turned them off.
 *
 * ⚠ **Ids alone are not the whole sweep**, which is why {@link expectNoEditorProse} runs beside this
 * list: nine `data-testid`s catch a renamed control and never an editor-only sentence, and a sentence
 * is how this same defect reached the shared Annotation list's empty state.
 *
 * Each is asserted **present** against the editor's own prop set, so none of these can go quietly
 * green on a renamed id: `annotation-tools` and `annotation-new` in
 * `apps/editor/src/lib/annotations/annotation-layer-contents.dom.test.ts`, the editor's own fields and
 * Delete in `apps/editor/src/lib/annotations/annotation-text-face.dom.test.ts`,
 * `annotation-stroke-width` in `annotation-style-face.dom.test.ts` beside it, and
 * `annotation-place-search` in `e2e/editor-annotations.e2e.ts`.
 */
const ANNOTATION_EDITING_CONTROLS = [
	'annotation-text-face',
	'annotation-style-face',
	'annotation-edit-text',
	'annotation-title',
	'annotation-description',
	'annotation-delete',
	'annotation-stroke-width',
	'annotation-new',
	'annotation-tools',
	'annotation-place-search',
	// **No tab strip at all, and not a lone Text tab** (the-annotation-inspector stories 45, 46): the
	// viewer passes no `style` snippet, and the strip's absence falls out of that absence rather than
	// out of a case written for a Reader. All three are asserted *present* against the editor's prop
	// set in `packages/ui/src/annotation-inspector.dom.test.ts`, and the strip is driven in a real
	// browser in `e2e/editor-annotations.e2e.ts`.
	'annotation-inspector-tabs',
	'annotation-inspector-tab-text',
	'annotation-inspector-tab-style'
] as const;

// ─────────────────────────────────────────────────────────────────────────────────────────
// SANITISATION. The one place in this epic where a bug is a security vulnerability.
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('untrusted text on a Published Site', () => {
	/**
	 * The tracker asserts Markdown sanitisation **twice on purpose**: in ticket 10 where it is written,
	 * and again here, because a Published Site runs on the author's own domain — `student.github.io`, or
	 * `maps.digitalhumanities.harvard.edu` — and the Project it renders may have arrived from a stranger
	 * by zip import (ticket 13) or from a remote library (ticket 14).
	 *
	 * **Two surfaces, and they are safe for different reasons.** That distinction is inherited from
	 * ticket 10 rather than rediscovered, and it is what stops a future edit "simplifying" the wrong one:
	 *
	 *   1. the **Annotation Inspector's Text face** — `AnnotationDescription` in `@ballastella/ui`,
	 *      which is the package's one `{@html}` and is fed core's `renderDescription` — `marked` then
	 *      DOMPurify, in that order and not separately reachable. A **title** is not this surface: it
	 *      is drawn by the Inspector's identity header and by the row, interpolated as text by Svelte,
	 *      and it belongs with the names below;
	 *   2. the **names** — a Project's on the hub and a Layer's in the controls — where safety is
	 *      **Svelte's text interpolation** and DOMPurify is not involved at all.
	 *
	 * Breaking the sanitiser therefore reddens the first and correctly leaves the second green. That
	 * asymmetry was verified by mutation, not assumed: `sanitise` in
	 * `packages/core/src/annotation/markdown.ts` was made to return its input, and the payload tests
	 * below went red while the name test stayed green.
	 *
	 * ⚠ **The Inspector is now the only place a Reader meets a stranger's description.** The map
	 * popup retired from the Project screen in both apps (ticket 07), and the row stopped revealing
	 * anything when the Inspector took the content over (ADR-0035), so this claim has no second surface
	 * behind it: nothing else on a Published Site turns a `description` into HTML. `showAnnotationPopup`
	 * and `renderAnnotationPopup` are still in `core` — the sanitiser did not retire with the popup, and
	 * `packages/core/src/annotation/markdown.browser.test.ts` still exercises the payload matrix through
	 * it — but no screen in this app calls them.
	 *
	 * **There was a third surface and it is deliberately gone.** The hub page used to author its own
	 * blurb as a pseudo-Annotation and `{@html}` it, so that the shared renderer stayed live in the
	 * shipped bundle and a `{@html}` hydrating permanently blank would be caught. Ticket 10's review
	 * found that surface was Reader-side popup behaviour, so it was removed along with the app's last
	 * `{@html}`. Nothing was lost: the tests below load a Published Site in this build and select a
	 * real Annotation, so they already prove the shared path is live here — and each of them asserts
	 * the prose arrived *before* asserting what did not, which is the same blank-surface guard the
	 * prose block was carrying.
	 */
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	for (const payload of PAYLOADS) {
		test(`an Annotation renders ${payload.what} inert in the Inspector, and its prose visibly`, async ({
			page
		}) => {
			site = await published(
				oneProject({
					annotations: [
						annotation({
							// The title is untrusted text too, and it is the surface most likely to be missed: a
							// `description` obviously holds a stranger's prose, whereas a `title` looks like a label.
							title: `Warehouse ${payload.markdown}`,
							description: payload.markdown
						})
					]
				})
			);
			const seen = watch(page);

			await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
			await mapReady(page);

			// **The pin's own path, which is the only wiring a browser is needed for.** Clicking the
			// Annotation on the map opens its Layer's card and its row rather than a popup over it, so
			// this is where the click-to-open-row wiring is falsifiable — and the surface it lands on
			// is the one the rest of this test then probes.
			await openAnnotationFromMap(page);

			// ─────────────────────────────────────────────────────────────────────────────────────
			// AND THE SAME ROW REACHED FROM THE SIDEBAR, WHICH IS WHERE A READER READS IT
			// (SPEC stories 32–34)
			//
			// Reached from the sidebar rather than from the map: the Layer's card lists what is in it
			// and the row opens on itself, so a Reader who never found the pin still meets this text.
			// Idempotent, so it finds the row the click above already opened rather than closing it.
			const reading = await openAnnotationRow(page);

			// **The prose first**, for the reason the popup's is: `{@html}` is not re-rendered during
			// hydration, so a surface that renders nothing at all — permanently, with no warning —
			// passes every assertion about what is absent.
			await expect(reading).toContainText(payload.prose);
			expect(await dangerousIn(reading)).toEqual(INERT);

			// **The title, by an entirely different mechanism, on the two surfaces that draw it.** It is
			// a Svelte interpolation in the Inspector's identity header and on the row's own button, so
			// the DOM never parses it as markup and DOMPurify is not involved at all — which is why the
			// characters that look like a tag survive as characters.
			// `packages/ui/src/annotation-list.dom.test.ts` pins the row's half with a negative control.
			const named = page.getByTestId('annotation-inspector-name');
			await expect(named).toContainText('Warehouse');
			expect(await dangerousIn(named)).toEqual(INERT);

			expect(await page.evaluate(() => '__xss' in window)).toBe(false);

			// Nothing on the screen could change the author's work, and nothing on it reaches a
			// third-party service. See {@link ANNOTATION_EDITING_CONTROLS} for where each of these is
			// asserted *present*, which is what stops this passing on a renamed id.
			for (const control of ANNOTATION_EDITING_CONTROLS) {
				await expect(page.getByTestId(control), `${control} in the viewer`).toHaveCount(0);
			}
			// And nothing on the page is *written* for somebody who can edit, which the ids above
			// cannot see: an editor-only sentence in shared code has no `data-testid` of its own.
			await expectNoEditorProse(page);

			expect(seen.failures).toEqual([]);
			// **No lookup was issued**, which is the ADR-0029 half said as a fact about the network
			// rather than about a missing control: the fence already refuses a non-localhost request,
			// so this catches the shape it cannot — a lookup at an origin the fence would allow.
			expect(seen.requests.filter((made) => /search|geocod|nominatim/i.test(made.url))).toEqual([]);
		});
	}

	test('a Project’s name and a Layer’s name are text, never markup — a different mechanism', async ({
		page
	}) => {
		// **DOMPurify is not what makes this safe.** Svelte interpolates these as text nodes, so the
		// payload appears as itself and no element is created. Recorded because a reader who assumes one
		// mechanism covers all three surfaces will eventually "simplify" the wrong one: breaking the
		// sanitiser leaves this test green, which is correct and is exactly why it is a separate test.
		const payload =
			'Amsterdam <img src=x onerror="window.__xss=1"> 1625<script>window.__xss=1</script>';
		// **The payload is on the Layer as well as on the Project**, which it was not before: the second
		// half of this test probed the whole stack while the only payload in the file was the Project's
		// name, so it was asking a region that could not have carried one. The Layer card is where a
		// Layer's name is drawn, and it is the element the probe is now pointed at.
		site = await published(
			oneProject({
				name: payload,
				projectOverrides: {
					layers: [
						{
							kind: 'map',
							id: MAP_LAYER_ID,
							name: payload,
							visible: true,
							order: 0,
							opacity: 1,
							imageId: IMAGE_ID
						}
					]
				}
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url);

		const list = page.getByTestId('published-projects');
		// The text is there, in full, including the parts that look like markup.
		await expect(list).toContainText(payload);
		expect(await dangerousIn(list)).toEqual(INERT);

		// And the same again on the Layer name, which is the other place a `project.json` string is drawn.
		//
		// ⚠ **The name, not the card around it.** Since ticket 05 the card is the editor's own, and it
		// carries Lucide glyphs — first-party `<svg>`, which `dangerousIn` counts as an embed because in
		// a *stranger's description* an `<svg>` is an execution route. Probing the whole stack would
		// therefore be asking about this repository's icons rather than about the author's string.
		await page.getByRole('link', { name: /Amsterdam/ }).click();
		const layerName = layerRow(page, MAP_LAYER_ID).getByTestId('layer-name-text');
		await expect(layerName).toHaveText(payload);
		expect(await dangerousIn(layerName)).toEqual(INERT);

		expect(await page.evaluate(() => '__xss' in window)).toBe(false);
		expect(seen.failures).toEqual([]);
	});

	test('parses before sanitising, so the anchor the parser builds is seen by the sanitiser', async ({
		page
	}) => {
		// **Order, and nothing else.** Sanitising before parsing is a known bypass shape: the sanitiser sees
		// `[link](javascript:…)`, which is inert *text* and passes untouched, and the Markdown parser
		// downstream then builds a live anchor out of it. `renderDescription` therefore owns both stages in
		// one function with no separately-reachable "parse" or "sanitise" — and this is that claim asserted
		// on the rendered DOM of a Published Site.
		//
		// The assertion is deliberately two-sided. A `javascript:` link must lose its `href` **and keep its
		// text**, and an ordinary `https:` link in the same description must survive intact: a test that
		// only checked for the absence of `javascript:` would also pass on a renderer that had stopped
		// producing anchors at all, or on one that had stopped producing anything.
		site = await published(
			await oneProject({
				annotations: [
					annotation({
						description:
							'Compare [the modern survey](https://example.org/survey) with ' +
							'[the 1625 plan](javascript:window.__xss=1).'
					})
				]
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		// ─────────────────────────────────────────────────────────────────────────────────────
		// THE TWO-SIDED CLAIM, IN THE INSPECTOR (one-shell-two-apps story 33)
		//
		// **This is what says the panel renders the description rather than showing its source.** The
		// payload tests above assert the prose is present, and prose survives either way — a face
		// showing `[the modern survey](https://example.org/survey)` verbatim contains those words
		// too. An anchor does not: it exists only if `marked` ran, which is the whole difference
		// between reading what the scholar wrote and reading their punctuation.
		const reading = await openAnnotationRow(page);
		await expect(reading).toContainText('Compare the modern survey with the 1625 plan.');
		const renderedLinks = await reading.evaluate((element) =>
			[...element.querySelectorAll('a')].map((anchor) => ({
				text: anchor.textContent,
				href: anchor.getAttribute('href')
			}))
		);
		expect(renderedLinks).toContainEqual({
			text: 'the modern survey',
			href: 'https://example.org/survey'
		});
		expect(renderedLinks).toContainEqual({ text: 'the 1625 plan', href: null });
		expect(await dangerousIn(reading)).toEqual(INERT);

		expect(await page.evaluate(() => '__xss' in window)).toBe(false);
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The site itself, at both base paths
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Published Site a Reader arrives at', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	test('serves the hub and one Project over plain HTTP, at a domain root and in a subdirectory', async ({
		page
	}) => {
		site = await published(oneProject());

		for (const served of site.sites) {
			const seen = watch(page);
			await page.goto(served.url);

			await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
			await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');
			// ⚠ **The reassurance about opening this Workspace in Ballastella is absent, and that is the
			// claim** (SPEC story 55). This fixture records no editor instance and carries no
			// `remote.json` — the state of a site published into a folder, and of every site published
			// before this epic — so the bar offers no "Open in Ballastella". A sentence saying what
			// following that link costs would be describing a control that is nowhere on the screen.
			// **The other half of this pair is in `leads back to the editor that published it`**, which
			// asserts the same sentence *present* on a site that does offer the link; neither half means
			// anything without the other.
			await expect(page.getByTestId('no-account-needed')).toHaveCount(0);

			// `?p=` opens one, reached by clicking the link the hub rendered rather than by a URL this test
			// composed — so the link is relative in the way the base path needs (ADR-0006).
			await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
			// The Project's name is on the bar, as the place the Reader is currently in (SPEC story 5).
			await expect(page.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
			await expect(page).toHaveURL(`${served.url}?p=amsterdam-1625`);

			// The Project's own data was read over HTTP, relative to the site.
			await expect(layerStack(page)).toContainText('Blaeu’s plan of 1625');
			await expect(layerStack(page)).toContainText('Warehouses');
			await mapReady(page);

			// Nothing was asked for outside the published folder. This is the assertion that fails when an
			// asset or a data file is referenced as `/…`: answered at a domain root, and outside the folder
			// in a subdirectory, which is the GitHub Pages case ADR-0006 exists for.
			expect(
				served.requests.filter((asked) => !asked.startsWith(`${served.prefix}/`)),
				`requests outside ${served.prefix}/`
			).toEqual([]);
			// And the subdirectory case really was a subdirectory rather than a second root.
			expect(served.requests.some((asked) => asked !== `${served.prefix}/`)).toBe(true);
			// No 404 for anything the *page* asked for. Warped tiles are excluded: `@allmaps/maplibre`
			// derives its own tile requests from the `info.json` and asks for cells this fixture pyramid
			// deliberately does not have, exactly as a partly-uploaded site would.
			expect(served.failures.filter((failure) => !failure.path.includes('/default.jpg'))).toEqual(
				[]
			);
			expect(seen.failures).toEqual([]);
			page.removeAllListeners('pageerror');
			page.removeAllListeners('dialog');
			page.removeAllListeners('request');
		}
	});

	/**
	 * The Front Page lists what the author put on it — and the other Projects are still there
	 * (SPEC stories 25, 52; ADR-0032).
	 *
	 * ⚠ **The second half is the half that matters.** A Project taken off the Front Page is *absent from
	 * one list* and nothing else: the repository is public, its files are fetchable, and `?p=<folder>`
	 * opens it for anyone who knows the name. The editor's control says exactly that, and a scholar with
	 * embargoed material will act on it — so the site had better behave the way the sentence promises,
	 * with no gate, no warning banner, and no half-rendered page in the way.
	 *
	 * Run at both base paths, because the filter is the *viewer's* and a Reader in a subdirectory reads
	 * the same record through a different prefix.
	 */
	test('lists only the Projects on the Front Page, and still opens one that is not', async ({
		page
	}) => {
		site = await published({
			'ballastella-site.json': siteRecord([
				{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: false },
				{ directory: 'boston-1775', name: 'Boston 1775', onFrontPage: true }
			]),
			...projectFiles(),
			...projectFiles({ directory: 'boston-1775', name: 'Boston 1775' })
		});

		for (const served of site.sites) {
			const seen = watch(page);
			await page.goto(served.url);

			await expect(page.getByTestId('published-projects')).toContainText('Boston 1775');
			await expect(page.getByTestId('published-projects')).not.toContainText('Amsterdam 1625');

			// Not listed, and not withheld: the same Project renders exactly as a listed one does, Layers,
			// Annotations, map and all.
			await page.goto(`${served.url}?p=amsterdam-1625`);
			await expect(page.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
			await expect(layerStack(page)).toContainText('Blaeu’s plan of 1625');
			await expect(layerStack(page)).toContainText('Warehouses');
			await mapReady(page);

			expect(seen.failures).toEqual([]);
			page.removeAllListeners('pageerror');
			page.removeAllListeners('dialog');
			page.removeAllListeners('request');
		}
	});

	/**
	 * An empty Front Page says which empty it is (ADR-0032).
	 *
	 * "This site has no Projects on it yet" is true of a site nothing has been published to, and reads
	 * as *the files are missing* — so an author who took every Project off their Front Page would go
	 * looking for work that is exactly where they left it. The other sentence names what they did and
	 * repeats what the editor's control promised: the Projects are here, and a link still opens one.
	 *
	 * ⚠ **Both empty sites, in one test, each asserted to say its own sentence and not the other's.**
	 * Either half alone is green on a page that has stopped telling the two apart: collapse the branch
	 * that chooses between them and whichever sentence survived still matches its own assertion. It is
	 * the pair that carries the claim.
	 */
	test('says which of the two empty Front Pages a Reader is looking at', async ({ page }) => {
		site = await published({
			'ballastella-site.json': siteRecord([
				{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: false }
			]),
			...projectFiles()
		});

		await page.goto(site.sites[0]!.url);

		const empty = page.getByTestId('none-on-front-page');
		await expect(empty).toContainText('None of this site’s Projects are on the front page');
		await expect(empty).toContainText('still published');
		await expect(page.getByTestId('no-projects-yet')).toHaveCount(0);
		await expect(page.getByTestId('published-projects')).toHaveCount(0);

		// And the Project itself is untouched by the wording: still there, still opening.
		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await expect(page.getByTestId('page-heading')).toHaveText('Amsterdam 1625');

		// A site nothing has been published to: no Project files at all, and a record listing none.
		await site.close();
		site = await published({ 'ballastella-site.json': siteRecord([]) });
		await page.goto(site.sites[0]!.url);

		await expect(page.getByTestId('no-projects-yet')).toContainText(
			'This site has no Projects on it yet'
		);
		await expect(page.getByTestId('none-on-front-page')).toHaveCount(0);
		await expect(page.getByTestId('published-projects')).toHaveCount(0);
		// Nothing published is not a fault: no alert, and no invitation to go looking for the files.
		await expect(page.getByTestId('site-problem')).toHaveCount(0);
	});

	/**
	 * The loop closes: a Reader who was given nothing but a URL can take the work onto their own
	 * machine (SPEC stories 49–51).
	 *
	 * ⚠ **Asserted at both base paths, and the subdirectory is the load-bearing half.** These are the
	 * only *absolute* addresses this app renders — everything else goes through `resolve` — and they
	 * are built from two files read relative to the document: the site record's `editorUrl` and the
	 * published `remote.json`. A read pointed at `/` instead of at the document leaves the root site
	 * green and only the subdirectory red, which is what ticket 16 mutation-verified about this
	 * harness.
	 *
	 * The links are read rather than followed: the destination is a different origin under ADR-0032
	 * and there is no editor on this port. What the editor does when it is landed on is
	 * `editor-clone-remote` and `editor-review-remote`.
	 */
	test('leads back to the editor that published it, from the Front Page and from a Project', async ({
		page
	}) => {
		site = await published(publishedByEditor());

		for (const served of site.sites) {
			await page.goto(served.url);

			// On the bar, with the other things that are true on every screen, rather than buried in a
			// paragraph of prose halfway down the Front Page (SPEC story 9).
			const bar = page.getByTestId('navigation-bar');
			const clone = bar.getByRole('link', { name: 'Open in Ballastella' });
			await expect(clone).toHaveAttribute('href', `${EDITOR_INSTANCE}?clone=ada/atlas`);

			// And the sentence that says what following it costs, on the one screen that offers it
			// (SPEC story 55): a student with no GitHub account is exactly the Reader who will not
			// follow a link that looks like it wants one. **Present here and absent in `serves the hub
			// and one Project over plain HTTP`**, whose site has no way back — the reassurance goes
			// wherever the invitation goes, and nowhere else.
			await expect(page.getByTestId('no-account-needed')).toContainText(
				'You do not need an account, and nothing published here is changed'
			);

			// And the rest of what the bar is for: the way home in the same place on every page, the
			// list of Projects, and the theme control where the editor keeps its own (stories 3, 4, 7).
			await expect(bar.getByTestId('site-name')).toBeVisible();
			await expect(bar.getByTestId('all-projects')).toBeVisible();
			await expect(bar.getByTestId('theme-toggle')).toBeVisible();
			await expect(bar.getByTestId('page-heading')).toHaveText('Front Page');

			await page.goto(`${served.url}?p=amsterdam-1625`);

			// The same bar, saying where the Reader is now (story 5).
			await expect(bar.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
			await expect(bar.getByTestId('all-projects')).toBeVisible();

			const review = bar.getByRole('link', { name: 'Review this Project in Ballastella' });
			await expect(review).toHaveAttribute(
				'href',
				`${EDITOR_INSTANCE}?review=ada/atlas&p=amsterdam-1625`
			);
			// The whole-Workspace invitation is the Front Page's, not a Project's: a Reader looking at
			// one piece of work is offered that piece of work — and the sentence about what that
			// invitation costs goes with it.
			await expect(clone).toHaveCount(0);
			await expect(page.getByTestId('no-account-needed')).toHaveCount(0);

			// And the site's own name is the way home, in the same place on every page (story 4).
			await bar.getByTestId('site-name').click();
			await expect(bar.getByTestId('page-heading')).toHaveText('Front Page');
		}
	});

	/**
	 * A record with no instance address renders no link and no error (SPEC story 51).
	 *
	 * Every site published before ticket 09 is in this state and is in front of Readers now. A guess
	 * at a canonical deployment would be worse than the absence: it would offer a stranger's editor a
	 * repository the stranger has nothing to do with.
	 */
	test('says nothing about an editor when the site does not record one', async ({ page }) => {
		site = await published({
			...oneProject(),
			// ⚠ **A binding the page must not go looking for.** The site records no instance, so there is
			// no link to build and the repository's name is of no use — and this file is here precisely
			// so that "no extra request" is a claim about the wire rather than about a missing fixture.
			'remote.json': asJson({ formatVersion: 1, owner: 'ada', repository: 'atlas' })
		});
		const seen = watch(page);
		const served = site.sites[0]!;

		await page.goto(served.url);

		await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');
		await expect(page.getByRole('link', { name: /in Ballastella$/ })).toHaveCount(0);
		await expect(page.getByTestId('site-problem')).toHaveCount(0);
		// Every site published before ticket 09 is in this state, and the binding is a whole extra
		// round trip on the Front Page of every one of them.
		expect(served.requests.filter((asked) => asked.endsWith('/remote.json'))).toEqual([]);
		expect(seen.failures).toEqual([]);
	});

	/**
	 * A site published to a folder rather than to a Remote has no `remote.json`, so there is no
	 * repository to name in a link — and a Reader meets a Front Page, not a 404 or an alert.
	 */
	test('says nothing about an editor when the site is bound to no repository', async ({ page }) => {
		site = await published(oneProject({}, { editorUrl: EDITOR_INSTANCE }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url);

		await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');
		await expect(page.getByRole('link', { name: /in Ballastella$/ })).toHaveCount(0);
		await expect(page.getByTestId('site-problem')).toHaveCount(0);
		expect(seen.failures).toEqual([]);
	});

	test('reads everything through the HTTP store, and makes no request that could change a byte', async ({
		page
	}) => {
		// Ticket 17: the viewer reads exclusively through the HTTP `ProjectStore` adapter and exposes no
		// `write`; and changing a view control makes **no** write attempt and produces no error.
		//
		// Asserted on the wire, which is the only place a Reader's browser could give it away: every request
		// the page made, by method. A `write` that rejected in the app would leave no trace here — which is
		// why the *other* half of this claim is the type: `createHttpProjectStore` returns an object whose
		// only method is `read` (`packages/core/src/store/http-project-store.test.ts`).
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		// **And there is nothing here that could be an edit** (SPEC stories 19 and 58). Asserted in the
		// built viewer a Reader is actually served, once, against the thing that ships — the paired
		// present/absent claims for each of these controls are at the component seam.
		//
		// ⚠ **The card is opened first, and that is the difference between this claim and a vacuous
		// one.** Rename, Move up, Move down, Delete and the tiles badge live *inside* the open card, so
		// every one of them is absent from a closed card in the editor too. A version of this sweep run
		// before the disclosure would be reporting that the card was shut.
		await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await expectNothingEditable(page);

		// Every kind of view change a Reader can make.
		await layerVisible(page, MAP_LAYER_ID).uncheck();
		await layerVisible(page, MAP_LAYER_ID).check();
		// Inside the open card, which is where a Layer's contents are since the stack became the shared
		// one: the row a Reader opened above is the row the slider belongs to.
		const opacity = page.getByTestId('layer-opacity');
		await opacity.fill('0.35');
		await page.getByTestId('base-map-switcher').selectOption({ index: 1 });
		await page.getByRole('button', { name: /Switch to .* theme/ }).click();
		await expect(page.getByTestId('layer-view-status')).toContainText('%');

		expect(seen.requests.filter((request) => request.method !== 'GET')).toEqual([]);
		expect(seen.failures).toEqual([]);

		// **And nothing was written to this origin either** — the other half of "a visit that only looks
		// writes nothing", and the half the wire cannot see.
		//
		// ⚠ **The whole of `localStorage`, with no filter before the comparison.** The Base Map tests
		// below read the same storage through a `startsWith('ballastella.baseMap')` filter, which is right
		// for what *they* claim — that the preference is keyed by site — and useless for this one: a key
		// this app should not be writing at all is exactly the key such a filter drops. The Layer card is
		// now shared with the editor, so a card that learned to remember its open row would start writing
		// on every published site, and this is the assertion that would go red for it.
		//
		// The one key allowed is the Base Map choice this test just made, asserted by its value as well as
		// its name so that "the preference" means the preference rather than anything of that shape.
		const chosenBaseMap = await page.getByTestId('base-map-switcher').inputValue();
		expect(await page.evaluate(() => ({ ...window.localStorage }))).toEqual({
			[`ballastella.baseMap:${site.sites[0]!.url}`]: chosenBaseMap
		});

		// And the Project's own bytes on disk are untouched — the stronger form of the same claim, since a
		// static host would refuse a write and the app must not even have tried.
		const before = await readFile(path.join(site.directory, 'amsterdam-1625/project.json'), 'utf8');
		expect(before).toContain('"opacity": 0.8');
		expect(before).not.toContain('0.35');
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Exploring: Layers, opacity, order, popups
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('exploring a Project', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	test('draws the stack in the author’s order with zoom at the bottom-left, the Annotation Layer above the map Layer, and the Inspector docked over the pane’s top-right', async ({
		page
	}) => {
		// ADR-0002's cross-kind rule, asserted through the mechanism that implements it: MapLibre's own
		// layer order. Asking the app's array instead would only prove the app agrees with itself.
		//
		// Three Annotations rather than the fixture's one, because this test also carries the Reader's
		// half of the numbering claim below and one Annotation cannot show an order.
		const numbered = ['a', 'b', 'c'].map((letter, at) =>
			annotation({
				id: `1111111${at}-1111-4111-8111-11111111111${at}`,
				title: `Warehouse ${letter}`,
				coordinates: [4.9 + at * 0.01, 52.3676]
			})
		);
		site = await published(oneProject({ annotations: numbered }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		// Zoom is at the bottom-left in the reader pane as in every other map pane
		// (the-annotation-inspector story 18), asserted against the rendered control rather than the call
		// that placed it: MapLibre creates all four corner containers whatever is put in them, so the
		// claim is which corner holds the buttons.
		const readerPane = page.getByTestId('reader-map-pane');
		const bottomLeft = readerPane.locator('.maplibregl-ctrl-bottom-left');
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-in')).toBeVisible();
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-out')).toBeVisible();
		await expect(readerPane.locator('.maplibregl-ctrl-top-right .maplibregl-ctrl')).toHaveCount(0);

		// The reader wears the editor's Project workspace: a fixed layer sidebar at the left and a map
		// that takes the remaining viewport, rather than a centred card with a capped map.
		const sidebarBox = (await page.getByTestId('layer-sidebar').boundingBox())!;
		const mapBox = (await readerPane.boundingBox())!;
		expect(mapBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1);
		expect(mapBox.width).toBeGreaterThan(sidebarBox.width);
		expect(mapBox.height).toBeGreaterThan(sidebarBox.width);

		const order = await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder());
		const mapLayerAt = order.findIndex((id) => id === `ballastella-layer-${MAP_LAYER_ID}`);
		const annotationAt = order.findIndex((id) =>
			id.startsWith(`ballastella-layer-${ANNOTATION_LAYER_ID}-`)
		);
		expect(mapLayerAt, 'the warped Map Image is on the map').toBeGreaterThan(-1);
		expect(annotationAt, 'the Annotation Layer is on the map').toBeGreaterThan(-1);
		// Later in MapLibre's order is drawn above, and the Annotation Layer is `order: 0` — the top of the
		// stack the author composed.
		expect(annotationAt).toBeGreaterThan(mapLayerAt);

		// And the Map Image really carried bytes rather than merely being named: the pre-patch failure
		// in `@allmaps/render` was an error upstream logged and swallowed, so a console check went green
		// while the map rendered blank. `isCachedTile()` is `data !== undefined` and `data` is the ImageData
		// the tile worker produced, so this counts tiles that made it all the way through the ADR-0011 shim
		// rather than tiles that were merely asked for.
		//
		// `fitBounds` first, for the reason the editor's own helper gives: a renderer with the warped map
		// off screen has no reason to ask for a tile at all, so without this the assertion measures the
		// initial viewport rather than the tile path.
		await expect
			.poll(
				() =>
					page.evaluate(async (id) => {
						const handle = window.ballastellaReaderMap!;
						const layer = handle.warped[id]!;
						handle.map.fitBounds(layer.getBounds(), { animate: false });
						await new Promise((resolve) => setTimeout(resolve, 500));
						return (layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
					}, MAP_LAYER_ID),
				{ timeout: 30_000 }
			)
			.toBeGreaterThan(0);

		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		// ─────────────────────────────────────────────────────────────────────────────────────
		// AND THE READER SEES THE SAME NUMBERS THE SCHOLAR DOES (SPEC story 38)
		//
		// A scholar's written reference to "3" has to name the same Annotation on a Published Site as
		// it does in the editor, which is why the rule is one function in `core` rather than an
		// `index + 1` in each app. The editor's half of this claim is in `e2e/editor-annotations.e2e.ts`
		// against a pin, a line and a shape; this is the same rule reaching a real published build over
		// HTTP. It is the sidebar's numbering and nothing is numbered on the map: a disc of digits
		// floating over the geography read as a second kind of pin.
		//
		// Folded in here rather than given a test of its own because the Seam 2 budget is spent
		// (`scripts/check-seam-2-size.mjs`), and because this test already has a published Project with
		// a drawn Annotation Layer on a real map.
		const card = await openLayerRow(page, layerRow(page, ANNOTATION_LAYER_ID));
		expect(await card.getByTestId('annotation-row-ordinal').allTextContents()).toEqual([
			'1',
			'2',
			'3'
		]);
		// The number is added to the row rather than put in place of what it said, so a Reader still
		// meets the Annotation's own name beside it.
		expect(await card.getByTestId('annotation-row-name').allTextContents()).toEqual([
			'Warehouse a',
			'Warehouse b',
			'Warehouse c'
		]);

		// ─────────────────────────────────────────────────────────────────────────────────────
		// AND THE LEADER JOINS THE OPEN ROW TO ITS PIN (ticket 12, SPEC stories 39, 46)
		//
		// The line the editor draws, drawn by the same component in a real published build. Folded in
		// here for the reason the numbering above was: the Seam 2 budget is spent, and this test
		// already has a published Project with a drawn Annotation Layer on a real map.
		//
		// ⚠ **The canvas end is asserted against `map.project()` of the coordinate in the published
		// GeoJSON on disk**, never against the leader's own box or the mark's — the defect shape
		// recorded in `apps/editor/src/routes/layout.css`, where a mark 334 px from the geography it
		// named passed a whole browser suite. The mutation check is to offset the projection by a
		// constant and watch this go red.
		const projectFile = JSON.parse(
			await readFile(path.join(site.directory, 'amsterdam-1625/project.json'), 'utf8')
		);
		const geojsonRef = projectFile.layers.find(
			(layer: { kind: string }) => layer.kind === 'annotation'
		).geojsonRef;
		const collection = JSON.parse(
			await readFile(path.join(site.directory, 'amsterdam-1625', geojsonRef), 'utf8')
		);
		const at = collection.features[0].geometry.coordinates as [number, number];

		// Framed on the Annotation, because the tile assertion above left the camera on the Map
		// Image's bounds — a mark outside the canvas is deliberately not pointed at.
		await page.evaluate(
			(centre) =>
				window.ballastellaReaderMap!.map.jumpTo({ center: centre as [number, number], zoom: 14 }),
			at
		);
		const firstRow = card.getByTestId('annotation-row').first();
		await firstRow.click();
		await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');

		// ─────────────────────────────────────────────────────────────────────────────────────
		// AND THE ANNOTATION IS READ IN THE INSPECTOR, DOCKED OVER THIS PANE (ADR-0035)
		//
		// The-annotation-inspector stories 43, 44 and 15–17: a Published Site looks like the tool it was
		// made in, so the Reader's panel is the author's panel in the same corner of the same kind of
		// pane. **A layout claim, so it is Seam 2 or nothing** (story 73) — there is no `offsetWidth` and
		// no paint at Seam 1c. Folded in here rather than given a test of its own for the reason the
		// numbering and the leader above were: the Seam 2 budget is spent
		// (`scripts/check-seam-2-size.mjs`), and this test already has a published Project with a drawn
		// Annotation Layer on a real map and a row just selected.
		//
		// Read after the arrival has settled, because the panel travels 8 px on the way in and a box read
		// mid-flight is neither where it started nor where it lands.
		const panel = page.getByTestId('annotation-inspector');
		await expect(panel).toHaveCount(1);
		await expect
			.poll(async () => {
				const at = await panel.boundingBox();
				const over = await page.getByTestId('reader-map-pane').boundingBox();
				if (!at || !over) return null;
				return {
					insideThePane: at.x >= over.x - 1 && at.x + at.width <= over.x + over.width + 1,
					atTheTop: at.y - over.y < over.height / 4,
					atTheRight: over.x + over.width - (at.x + at.width) < at.width,
					mapLeftBelowIt: over.y + over.height - (at.y + at.height) > 0
				};
			})
			.toEqual({
				insideThePane: true,
				atTheTop: true,
				atTheRight: true,
				mapLeftBelowIt: true
			});
		// **The panel is never under the zoom control** (story 18) without a second assertion for it: the
		// zoom buttons are at the bottom-left, asserted above, and the four answers here put the panel in
		// the opposite corner with map left below it. An assertion restating that could not be made to
		// fail on its own, which is the test this suite refuses to write.

		const drawn = (await leaderPoints(page)) as { x: number; y: number }[];
		expect(drawn, 'more than one line was drawn for one open row').toHaveLength(3);
		const pane = (await page.getByTestId('reader-map-pane').boundingBox())!;
		const projected = await page.evaluate(
			(centre) => window.ballastellaReaderMap!.map.project(centre as [number, number]),
			at
		);
		// ⚠ **A Pin is anchored at its tip, so the line is aimed at the middle of the pin rather than at
		// the coordinate** — half the pin's own height above it, which is `annotationMarkBox`'s answer.
		// The pin is a 96 px sprite at a device pixel ratio of 2, scaled by the Annotation's
		// `marker-size`. Restated here rather than imported, for the reason every other constant in
		// this suite is: the Playwright project resolves nothing from `@ballastella/core`, and numbers
		// stated from the design are a better witness than ones taken from the code under test. Read
		// off the *stored* `marker-size`, so a fixture drawn at another size moves this assertion
		// rather than quietly breaking it.
		const pinScale: Record<string, number> = { small: 0.5, medium: 0.7, large: 0.95 };
		const markerSize = (collection.features[0].properties['marker-size'] ?? 'medium') as string;
		const pinHeight = Math.round(48 * (pinScale[markerSize] ?? 0.7));
		const target = { x: pane.x + projected.x, y: pane.y + projected.y - pinHeight / 2 };
		// The line then stops at the edge of the pin and two pixels clear of it, along its own
		// direction — so the stub sets the direction and the file sets the place.
		const shorten = pinHeight / 2 + 2;
		const stub = drawn[1]!;
		const run = Math.hypot(target.x - stub.x, target.y - stub.y);
		const wanted = {
			x: target.x - ((target.x - stub.x) * shorten) / run,
			y: target.y - ((target.y - stub.y) * shorten) / run
		};
		expect(
			Math.hypot(drawn[2]!.x - wanted.x, drawn[2]!.y - wanted.y),
			'the leader’s canvas end is not where map.project() puts the coordinate on disk'
		).toBeLessThan(2);

		// ── AND IT FOLLOWS THE CAMERA, IN THE FRAME THE CAMERA MOVED IN (story 40) ──────────
		//
		// ⚠ **The camera is moved *after* the row was opened, and the line is read one animation frame
		// later without leaving the page.** Both halves of that are load-bearing.
		//
		// The framing `jumpTo` above happens before the click, so every drawn state asserted so far
		// comes from `LeaderLine`'s selection effect. Without this paragraph, deleting
		// `ReaderMapPane`'s `created.on('move' | 'zoom')` pair — the whole of the viewer's camera wiring
		// — left all 63 tests in this file green while a Reader panning a Published Site got a dashed
		// line pointing at open water.
		//
		// And a *polled* read from the test process does not catch that either: measured with the pair
		// deleted, the leader was 126 px from its pin one frame after the jump and back within half a
		// pixel a moment later, put right by something incidental in the map pane rather than by the
		// camera. So the frame is what is read, which is also what the criterion says — it never lags a
		// frame behind at rest. `move` fires inside `jumpTo` and the redraw is a microtask, so the
		// queue has drained long before the frame callback runs; there is nothing racy in reading here.
		const followed = await page.evaluate((centre) => {
			const [longitude, latitude] = centre as [number, number];
			const map = window.ballastellaReaderMap!.map;
			map.jumpTo({ center: [longitude + 0.004, latitude - 0.003], zoom: 13 });
			return new Promise<{
				points: string | null;
				origin: { x: number; y: number };
				projected: { x: number; y: number };
			}>((resolve) =>
				requestAnimationFrame(() => {
					const svg = document.querySelector('[data-testid="leader-line"]') as SVGSVGElement;
					const box = svg.getBoundingClientRect();
					resolve({
						points: svg.querySelector('polyline')!.getAttribute('points'),
						origin: { x: box.x, y: box.y },
						projected: map.project(centre as [number, number])
					});
				})
			);
		}, at);
		expect(followed.points, 'the leader was taken down by a pan rather than moved').not.toBeNull();
		// The same conversion `leaderPoints` does, done here because the read had to happen in the page.
		const movedPoints = followed.points!.split(' ').map((pair) => {
			const [x, y] = pair.split(',').map(Number);
			return { x: followed.origin.x + (x as number), y: followed.origin.y + (y as number) };
		});
		const movedStub = movedPoints[1]!;
		const movedTarget = {
			x: pane.x + followed.projected.x,
			y: pane.y + followed.projected.y - pinHeight / 2
		};
		const movedRun = Math.hypot(movedTarget.x - movedStub.x, movedTarget.y - movedStub.y);
		expect(
			Math.hypot(
				movedPoints[2]!.x - (movedTarget.x - ((movedTarget.x - movedStub.x) * shorten) / movedRun),
				movedPoints[2]!.y - (movedTarget.y - ((movedTarget.y - movedStub.y) * shorten) / movedRun)
			),
			'the leader stayed where the camera left it, so it is not following the map'
		).toBeLessThan(2);

		// It says nothing a Reader is not already told: `aria-expanded` says which row is open, and the
		// map draws that Annotation more strongly (story 42).
		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');

		// ── AND ON A NARROW SCREEN THERE IS NO LINE AT ALL (story 46) ────────────────────────
		//
		// Below the breakpoint the map sits under the stack, and a line drawn across a stacked layout
		// claims a left-to-right relationship the layout does not have. What is left is the row being
		// open and washed in its kind's colour, which is what carries the connection there — so the
		// row is asserted to still be open rather than the absence being asserted on its own.
		const viewport = page.viewportSize()!;
		await page.setViewportSize({ width: 800, height: viewport.height });
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
		await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
		await page.setViewportSize(viewport);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');

		expect(seen.failures).toEqual([]);
	});

	test('hiding a Layer takes it off the map and off the count, and shows it again', async ({
		page
	}) => {
		// The `data-drawn` count is a fact about the map rather than a high-water mark. The editor's
		// equivalent merges over a record it never prunes, so a hidden Layer went on being counted as drawn
		// — a defect recorded against the editor's Layer stack, which ticket 04 moved into
		// `apps/editor/src/lib/project/ProjectScreen.svelte`, and the reason this count is built from the
		// Layers that are currently shown and nothing else.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		await layerVisible(page, MAP_LAYER_ID).uncheck();

		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		// Drained of its colour and marked "Hidden" in words, so the Layer that has gone missing is
		// findable without relying on colour alone (SPEC story 16).
		await expect(layerRow(page, MAP_LAYER_ID).getByTestId('layer-hidden')).toHaveText('Hidden');
		expect(
			await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder())
		).not.toContain(`ballastella-layer-${MAP_LAYER_ID}`);

		await layerVisible(page, MAP_LAYER_ID).check();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		await expect(page.getByTestId('layer-view-status')).toContainText('shown');
		await expect(layerRow(page, MAP_LAYER_ID).getByTestId('layer-hidden')).toHaveCount(0);
		expect(await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder())).toContain(
			`ballastella-layer-${MAP_LAYER_ID}`
		);
		expect(seen.failures).toEqual([]);
	});

	test('opacity reaches the warped Layer in place, without rebuilding the stack', async ({
		page
	}) => {
		// A rebuild throws away every renderer and refetches every tile, and opacity is dragged — so on the
		// phone most Readers arrive on, including it in the rebuild key would make a continuous gesture the
		// most expensive thing on the page (ADR-0017 rule 1 is about exactly this shape).
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		const builds = await page.evaluate(() => window.ballastellaReaderMap!.builds);

		// The slider is inside the Layer's own card, which a Reader opens — SPEC story 11, and the same
		// step the editor's suite takes.
		const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await card.getByTestId('layer-opacity').fill('0.25');

		await expect(card.getByTestId('layer-opacity-value')).toHaveText('25%');
		await expect(page.getByTestId('layer-view-status')).toContainText('25%');
		expect(
			await page.evaluate(
				(id) => window.ballastellaReaderMap!.warped[id]!.getOpacity?.() ?? -1,
				MAP_LAYER_ID
			)
		).toBeCloseTo(0.25, 5);
		expect(await page.evaluate(() => window.ballastellaReaderMap!.builds)).toBe(builds);
		expect(seen.failures).toEqual([]);
	});

	test('a Layer whose kind this build cannot draw is listed and says so (ADR-0014)', async ({
		page
	}) => {
		site = await published(
			await oneProject({
				projectOverrides: {
					layers: [
						{
							kind: 'image-space-annotation',
							id: 'l-future',
							name: 'Notes on the sheet itself',
							visible: true,
							order: 0
						},
						{
							kind: 'map',
							id: MAP_LAYER_ID,
							name: 'Blaeu’s plan of 1625',
							visible: true,
							order: 1,
							opacity: 1,
							imageId: IMAGE_ID
						}
					]
				}
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		const row = layerRow(page, 'l-future');
		await expect(row).toContainText('Notes on the sheet itself');
		await expect(row.getByTestId('layer-kind')).toContainText('image-space-annotation');
		// The rest of the Project is unaffected.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');

		// **Opened, and swept while open** — this is the one state in the viewer where the foreign-kind
		// sentence exists at all, and it is where that sentence used to tell a Reader they could still
		// rename and move the Layer. The sweep in "reads everything through the HTTP store" runs on a
		// Project of drawable kinds and could never have seen it, which is why it also runs here.
		const opened = await openLayerRow(page, row);
		await expect(opened.getByTestId('layer-foreign-note')).toContainText(
			'nothing of it is drawn on the map'
		);
		await expectNothingEditable(page);
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// A READER MEETS THE AUTHOR'S LABELS (write-on-the-map stories 54–57)
//
// **Against a real published build, and that is the whole of why these two tests are here.** A Label
// draws through the same shared stack the editor draws through, and the Inspector withholds an
// author's controls by not being handed a snippet rather than by asking who is looking — so nothing
// below needs a line of Label-specific code in `apps/viewer`. What publishing *can* break is
// everything around that: the glyphs a Label's words are shaped from are files copied into the site,
// the stack is rebuilt from a Project parsed out of static HTTP, and the Inspector is compiled into a
// second application. "Publishing changes nothing about how the work looks" is therefore a claim only
// a served site can falsify, and `editor-annotations.e2e.ts` — which drives the same buckets against
// the editor's dev server — cannot stand in for it.
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Published Site draws the author’s Labels', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	/** The words on every Label in the fixture, so a chip's width varies by `marker-size` alone. */
	const WORDS = 'Zuiderzee';

	/**
	 * The colours the fixture's file states, and which part of the drawing each one is.
	 *
	 * White on blue rather than a subtle pair, because these are read back **out of the framebuffer**:
	 * the words have to be a colour the chip they sit on is nowhere near, or a sampled pixel cannot say
	 * which of the two it came from.
	 */
	const TEXT_COLOUR = '#ffffff';
	const CHIP_COLOUR = '#1976d2';

	/**
	 * Three Labels, one per `marker-size`, far enough apart that a query at one cannot reach another.
	 *
	 * Stacked in latitude at one longitude, so the horizontal probe {@link labelChip} walks outwards
	 * along has nothing but empty geography either side of it. The fixture's sheet lies below them,
	 * which keeps the opening frame on content the whole Project shares.
	 */
	const LABEL_AT = {
		small: [4.9, 52.42] as [number, number],
		medium: [4.9, 52.4] as [number, number],
		large: [4.9, 52.38] as [number, number]
	};

	const labelId = (size: keyof typeof LABEL_AT) => `a-label-${size}`;

	/**
	 * One Label as a Project file carries it.
	 *
	 * `marker-symbol: 'label'` is spelled as the literal rather than imported from
	 * `@ballastella/core`: this suite resolves nothing from the code under test, and the discriminator
	 * is a convention of the file format.
	 *
	 * ⚠ **`fill-opacity: 1`.** The default is 0.6, which is right for a Label over a map and wrong for
	 * a test that reads the chip's colour off the canvas: at 0.6 the sampled pixel is the author's
	 * colour mixed with whatever geography is under it, and the assertion would have to become a
	 * tolerance around a number nothing states.
	 */
	const labelFeature = (size: keyof typeof LABEL_AT, extra: Record<string, unknown> = {}) => ({
		type: 'Feature',
		id: labelId(size),
		geometry: { type: 'Point', coordinates: LABEL_AT[size] },
		properties: {
			'marker-symbol': 'label',
			title: WORDS,
			'marker-size': size,
			'marker-color': TEXT_COLOUR,
			fill: CHIP_COLOUR,
			'fill-opacity': 1,
			...extra
		}
	});

	/** The Workspace this section publishes: one Annotation Layer of Labels, and one ordinary Pin. */
	const labelledProject = (): SiteFiles =>
		oneProject({
			baseMap: 'physical',
			annotations: [
				labelFeature('small'),
				labelFeature('medium'),
				// The described one, so the Inspector's description face has something to render and the
				// two undescribed ones are the control for what it says when the file carries nothing.
				labelFeature('large', { description: 'Silted by 1600, and drained in 1932.' }),
				// **The control for "from the Label bucket only".** The stack builds the `point` bucket
				// only for a Layer that holds a Point which is not a Label, so a Project of Labels alone
				// leaves that layer out of the style altogether and the set assertion below would compare
				// the Label bucket against itself. This Pin puts the bucket in the style, which is what
				// makes that assertion a claim about the point filter's negation of the Label's. It sits
				// west of the Labels' meridian and down on the sheet, clear of every horizontal probe.
				annotation({ id: 'a-pin', title: 'Haarlemmerpoort', coordinates: [4.885, 52.37] })
			]
		});

	/**
	 * What the running stack painted at one coordinate, with the Annotation's own id and style.
	 *
	 * Filtered to features carrying `ballastella:id` because the Base Map draws under this and answers
	 * the same query with its own roads and water; every mark this application makes carries that
	 * property and nothing else on the map does.
	 */
	const paintedAt = (page: Page, at: [number, number], dx = 0) =>
		page.evaluate(
			({ at, dx }) => {
				const map = window.ballastellaReaderMap!.map;
				const point = map.project(at);
				return map
					.queryRenderedFeatures([point.x + dx, point.y])
					.filter((feature) => typeof feature.properties['ballastella:id'] === 'string')
					.map((feature) => ({
						id: feature.properties['ballastella:id'] as string,
						layer: feature.layer.id,
						title: feature.properties['title'],
						'marker-size': feature.properties['marker-size'],
						'marker-color': feature.properties['marker-color'],
						fill: feature.properties['fill']
					}));
			},
			{ at, dx }
		);

	/**
	 * How wide one Label's chip came out, and the colours across the middle of it.
	 *
	 * ⚠ **Both are asked of the renderer rather than of the style**, and neither can be asked any other
	 * way. `icon-text-fit` is MapLibre's arithmetic over a shaped text block nothing here ever sees, so
	 * the honest way to ask how wide a chip is is to walk outwards from its coordinate until the hit
	 * test stops naming it. And a paint value read back off the layer is an *expression* —
	 * `['get', 'marker-color']` — which says the renderer was told where to look and nothing at all
	 * about what colour was drawn; the framebuffer is the only surface that answers that.
	 *
	 * **A band across the middle of the chip rather than a single row of pixels**, because the words are
	 * shaped inside it and where their strokes fall is MapLibre's business: one row can cross the gap
	 * between two lines of a wrapped title, or sit under the letters entirely. The band is read in one
	 * `readPixels` — a call per pixel is a GPU stall per pixel — inside a `render` handler, because
	 * after the frame is presented the default framebuffer is undefined unless MapLibre was built with
	 * `preserveDrawingBuffer`. The repaint is asked for rather than waited on: a settled map draws no
	 * further frames on its own.
	 *
	 * ⚠ **The band is deliberately narrower than the reach the walk measured.** What the walk finds is
	 * the *hit box*, and a Label's hit box is wider than its chip — the stretchable SDF keeps a
	 * transparent margin for the selection halo — so a band that ran out to the reach would sample
	 * through that margin onto the geography beneath, and `#ffffff` would be satisfied by any pale
	 * patch of base map rather than by the words. Six tenths of the reach is chip interior throughout.
	 */
	const labelChip = (page: Page, at: [number, number], id: string) =>
		page.evaluate(
			({ at, id }) => {
				const map = window.ballastellaReaderMap!.map;
				const canvas = map.getCanvas();
				const gl = canvas.getContext('webgl2');
				if (gl === null) throw new Error('the map canvas has no WebGL2 context to read');
				const point = map.project(at);
				const hits = (dx: number) =>
					map
						.queryRenderedFeatures([point.x + dx, point.y])
						.some((feature) => feature.properties['ballastella:id'] === id);
				let reach = 0;
				for (let dx = 0; dx <= 300; dx += 2) {
					if (!hits(dx)) break;
					reach = dx;
				}
				// Refused here rather than inside the handler below, where a negative band would throw a
				// `RangeError` the promise never settles on and the test would only ever report a timeout.
				const half = Math.round(reach * 0.6);
				if (half < 1) throw new Error(`nothing drawn at ${id}`);
				const ratio = canvas.width / canvas.clientWidth;
				const band = { width: Math.round(half * 2 * ratio), height: Math.round(24 * ratio) };
				return new Promise<{ width: number; colours: string[] }>((resolve) => {
					map.once('render', () => {
						const pixels = new Uint8Array(band.width * band.height * 4);
						gl.readPixels(
							Math.round((point.x - half) * ratio),
							Math.round(canvas.height - (point.y + 12) * ratio),
							band.width,
							band.height,
							gl.RGBA,
							gl.UNSIGNED_BYTE,
							pixels
						);
						const colours: string[] = [];
						for (let offset = 0; offset < pixels.length; offset += 4) {
							colours.push(
								`#${[...pixels.slice(offset, offset + 3)]
									.map((channel) => channel.toString(16).padStart(2, '0'))
									.join('')}`
							);
						}
						resolve({ width: reach * 2, colours });
					});
					map.triggerRepaint();
				});
			},
			{ at, id }
		);

	test('draws every Label from the Label bucket, in the colour, at the size and at the place its file states (stories 54, 57)', async ({
		page
	}) => {
		site = await published(labelledProject());
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		// ── DRAWN, AND OUT OF THE LABEL BUCKET (story 54) ───────────────────────────────────
		//
		// Polled, because a GeoJSON source may not have painted on the first frame and the glyphs a
		// Label's words are shaped from arrive over HTTP out of the site's own `base-map/` — so a first
		// query here is early rather than wrong.
		await expect
			.poll(() => paintedAt(page, LABEL_AT.medium), { timeout: 30_000 })
			.toContainEqual(expect.objectContaining({ id: labelId('medium'), layer: bucket('label') }));

		for (const size of ['small', 'medium', 'large'] as const) {
			const painted = await paintedAt(page, LABEL_AT[size]);
			// **The colours and the size the file states**, read back off the feature the renderer is
			// drawing: this Project was parsed out of static HTTP by the published build, and these are
			// the values its paint and layout expressions read per feature.
			expect(painted).toContainEqual({
				id: labelId(size),
				layer: bucket('label'),
				title: WORDS,
				'marker-size': size,
				'marker-color': TEXT_COLOUR,
				fill: CHIP_COLOUR
			});
			// **And from that bucket only**: the `point` bucket's filter carries the negation of the
			// Label's, so a Label that also drew a pin under its words would show up here as a second
			// layer id — on a Published Site as in the editor. The fixture's one ordinary Pin is what
			// gives that sentence something to be false about: without it the stack never builds the
			// point bucket, and this would compare the Label bucket against itself.
			expect(new Set(painted.map((hit) => hit.layer))).toEqual(new Set([bucket('label')]));
			// **At its own place, and not everywhere.** 200 px along the parallel is well past the widest
			// chip measured below and past nothing else this Layer drew, so an empty answer says the
			// words are where the coordinate put them rather than that this query is satisfied anywhere.
			// It is also still on the canvas: Desktop Chrome is 1280 wide, the viewer's sidebar takes
			// `lg:w-96` of it, and the fit centres the Labels in the ~896 px that remain — so x ≈ 448,
			// and both this probe and the 300 px the chip walk can reach land inside the pane.
			expect(await paintedAt(page, LABEL_AT[size], 200)).toEqual([]);
		}

		// ── AT THE AUTHOR'S SIZE, AND IN THE AUTHOR'S COLOURS (story 57) ────────────────────
		//
		// Identical words on all three, so the only thing that can separate these widths is
		// `marker-size` reaching `text-size` through the published build.
		const chips = {
			small: await labelChip(page, LABEL_AT.small, labelId('small')),
			medium: await labelChip(page, LABEL_AT.medium, labelId('medium')),
			large: await labelChip(page, LABEL_AT.large, labelId('large'))
		};
		expect(chips.small.width).toBeGreaterThan(0);
		expect(chips.small.width).toBeLessThan(chips.medium.width);
		expect(chips.medium.width).toBeLessThan(chips.large.width);

		// The chip is the author's `fill` and the words are the author's `marker-color`, both exactly:
		// the chip is one SDF tinted per feature at `fill-opacity: 1`, so a saturated pixel of each is
		// the colour the file states rather than a blend of it with the geography underneath.
		expect(chips.large.colours).toContain(CHIP_COLOUR);
		expect(chips.large.colours).toContain(TEXT_COLOUR);

		expect(served.failures).toEqual([]);
		expect(seen.failures).toEqual([]);
	});

	test('opens a clicked Label’s Layer card with it selected, and reads its words and description with nothing to edit (stories 55, 56)', async ({
		page
	}) => {
		site = await published(labelledProject());
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);
		await expect
			.poll(() => paintedAt(page, LABEL_AT.large), { timeout: 30_000 })
			.toContainEqual(expect.objectContaining({ id: labelId('large') }));

		// ── CLICKED ON ITS OWN WORDS (story 55) ─────────────────────────────────────────────
		//
		// The id is named, so this waits for *that* Label's row rather than for the list acquiring a
		// selection: with three Labels on the map, "some row is expanded" would be satisfied by the
		// wrong one. A Label is clickable at all because `annotationLayerIds` carries the bucket — a
		// bucket absent from that list is a mark nobody can select — and that list is `core`'s, shared,
		// which is what this asserts survived publishing.
		const face = await openAnnotationFromMap(page, LABEL_AT.large, labelId('large'));

		// Its Layer's card is open, and exactly one row inside it is the chosen one.
		await expect(
			layerRow(page, ANNOTATION_LAYER_ID).getByTestId('layer-disclosure')
		).toHaveAttribute('aria-expanded', 'true');
		const selected = page.locator('[data-testid="annotation-row"][aria-expanded="true"]');
		await expect(selected).toHaveCount(1);
		await expect(selected).toHaveAttribute('data-annotation-id', labelId('large'));

		// ── ITS WORDS IN THE IDENTITY HEADER, AND ITS DESCRIPTION IN THE FACE (story 56) ────
		//
		// A Label's title is the drawing on the map, so the header is where a Reader meets those same
		// words as text — from `annotationName`, the rule the row draws from, which is why the two
		// cannot disagree. The shape word beside it says which kind this is without anyone having to
		// see a glyph.
		await expect(page.getByTestId('annotation-inspector-name')).toHaveText(WORDS);
		await expect(page.getByTestId('annotation-inspector-shape')).toHaveText('label');
		await expect(face).toContainText('Silted by 1600');

		// ── AND NOTHING AT ALL TO EDIT IT WITH (story 56) ───────────────────────────────────
		//
		// The sweep every Reader-side Annotation claim in this file makes, run with a **Label**
		// selected: the absences are the viewer passing no `style` and no `tools` snippet, so a Label
		// meeting a face nobody wrote a case for is exactly the intended outcome. See
		// {@link ANNOTATION_EDITING_CONTROLS} for where each of these is asserted *present*, which is
		// what stops this passing on a renamed id.
		for (const control of ANNOTATION_EDITING_CONTROLS) {
			await expect(page.getByTestId(control), `${control} beside a Label`).toHaveCount(0);
		}
		await expectNoEditorProse(page);

		// ── AND A LABEL THE FILE DESCRIBES NOTHING ABOUT SAYS SO ────────────────────────────
		//
		// The Contract's claim that a Label needs no case of its own: this is the description face's
		// own answer to an absent `description`, reached by the path an undescribed Pin already takes.
		await page
			.locator(`[data-testid="annotation-row"][data-annotation-id="${labelId('small')}"]`)
			.click();
		// All three Labels carry the same words, so the header cannot say which one is selected. The
		// expanded row can, and it is the same witness the click on the map was read through above.
		await expect(selected).toHaveAttribute('data-annotation-id', labelId('small'));
		await expect(page.getByTestId('annotation-description-text')).toHaveText('No description.');

		expect(served.failures).toEqual([]);
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The Base Map (ADR-0020)
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('the Base Map a Reader sees', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	/**
	 * Teardown for the one test here that needs two Published Sites on **one** origin, which the shared
	 * harness cannot give it: that serves each base path from its own port, and two ports are two
	 * origins. A function rather than a site record, because what has to come down is a server plus the
	 * two temporary directories behind it.
	 */
	let sharedOrigin: (() => Promise<void>) | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
		await sharedOrigin?.();
		sharedOrigin = null;
	});

	/** The option labels the site's catalog offers, and which of them need the network. */
	const options = (page: Page) =>
		page.evaluate(() =>
			[
				...document.querySelectorAll<HTMLOptionElement>('[data-testid="base-map-switcher"] option')
			].map((option) => ({
				value: option.value,
				text: option.textContent?.trim() ?? '',
				needsNetwork: option.dataset.needsNetwork === 'true'
			}))
		);

	/**
	 * The Base Map's own painted colours, which is what a flavor is.
	 *
	 * Read before and after each of the two assertions below that a Base Map *changed*, because the
	 * interesting failure is the one where the control moves and the map does not: a `<select>` that
	 * agrees with itself satisfies the letter of both criteria while the Reader still looks at the
	 * same paint. The paint is what a Reader with low vision actually receives, so it is what is
	 * compared — and comparing it against a value captured beforehand is what makes a style that
	 * never changed a failure rather than a pass.
	 */
	const paint = (page: Page) =>
		page.evaluate(() =>
			JSON.stringify(
				window
					.ballastellaReaderMap!.map.getStyle()
					.layers.map((layer) => ('paint' in layer ? layer.paint : null))
			)
		);

	test('starts at the author’s default, not at the deployment’s', async ({ page }) => {
		// SPEC story 69: the framing of the work is the author's, and first contact is the moment that
		// carries it. The fixture names a Base Map that is deliberately **not** the catalog default.
		site = await published(oneProject({ baseMap: 'physical' }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		await expect(page.getByTestId('base-map-switcher')).toHaveValue('physical');
		const catalog = await options(page);
		expect(catalog.find((entry) => entry.value === 'physical')?.value).toBe('physical');
		// The default the *deployment* would have chosen is a different entry, so this cannot be passing by
		// coincidence.
		expect(catalog[0]?.value).not.toBe('physical');
		expect(seen.failures).toEqual([]);
	});

	test('offers the catalog that travelled with the site, not this build’s (ADR-0020)', async ({
		page
	}) => {
		// The whole point of putting the catalog in `ballastella-site.json`: a Published Site keeps working
		// when the authoring deployment later changes its own catalog. Asserted with a catalog naming an
		// entry **this build does not have**, so it cannot pass on the fallback — the switcher offers
		// exactly what the record says, and none of the entries the viewer was built with.
		//
		// The archive is the site's own bundled one, reached relatively, so the map still draws.
		const travelled = {
			entries: [
				{
					id: 'a-deployment-of-its-own',
					label: 'Somebody else’s Base Map',
					needsNetwork: false,
					archive: 'base-map/amsterdam-centre.pmtiles',
					emphasis: 'streets-and-labels',
					flavor: { light: 'light', dark: 'dark' }
				}
			],
			defaultId: 'a-deployment-of-its-own',
			initialView: { center: [4.9041, 52.3676], zoom: 13 },
			glyphs: 'base-map/fonts/{fontstack}/{range}.pbf',
			sprite: 'base-map/sprites/{flavor}',
			attribution: '© OpenStreetMap'
		};
		site = await published(oneProject({}, { baseMap: travelled }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		expect(await options(page)).toEqual([
			{ value: 'a-deployment-of-its-own', text: 'Somebody else’s Base Map', needsNetwork: false }
		]);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('a-deployment-of-its-own');
		// And it is a working map rather than a named one: the stack drew on it.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	test('switching persists in localStorage and is restored on return', async ({ page }) => {
		site = await published(oneProject({ baseMap: 'physical' }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await page.getByTestId('base-map-switcher').selectOption('muted');
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('muted');

		// Reloaded, so the choice has to have come out of storage rather than out of memory.
		await page.reload();
		await mapReady(page);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('muted');

		// Under a key named after this site, and holding the id and nothing else.
		expect(
			await page.evaluate(() =>
				Object.fromEntries(
					Object.entries({ ...window.localStorage }).filter(([key]) =>
						key.startsWith('ballastella.baseMap')
					)
				)
			)
		).toEqual({ [`ballastella.baseMap:${site!.sites[0]!.url}`]: 'muted' });
		expect(seen.failures).toEqual([]);
	});

	test('two Published Sites on different paths of one origin do not share a preference', async ({
		page
	}) => {
		// `localStorage` is per **origin**, and a department domain with a folder per student — or one
		// `username.github.io` with a repository per semester — is the ordinary case rather than an edge
		// one. One key would mean a Reader's choice on one scholar's site silently reframing another's.
		//
		// **One server, two paths**, which is the whole point of this test and why it does not use the
		// harness's two base paths: those are two ports, so they are two origins, and two origins get
		// separate `localStorage` from the browser whatever this code does. A test at two ports would go
		// green with the site's path dropped from the key entirely — the one defect it exists to catch.
		//
		// Both paths are the **same directory**, reached through two symlinks, so nothing here can become
		// a test of two builds and the two sites cannot drift apart.
		const directory = await writePublishedSite(oneProject({ baseMap: 'physical' }));
		const origin = await mkdtemp(path.join(tmpdir(), 'ballastella-origin-'));
		await symlink(directory, path.join(origin, 'tracy'), 'dir');
		await symlink(directory, path.join(origin, 'sam'), 'dir');
		const server = await serveDirectory(origin);
		sharedOrigin = async () => {
			await server.close();
			await rm(origin, { recursive: true, force: true });
			await rm(directory, { recursive: true, force: true });
		};

		const tracy = `${server.url}tracy/?p=amsterdam-1625`;
		const sam = `${server.url}sam/?p=amsterdam-1625`;
		const seen = watch(page);

		await page.goto(tracy);
		await mapReady(page);
		await page.getByTestId('base-map-switcher').selectOption('muted');
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('muted');

		// The second site starts at the author's default rather than at the stranger's choice, and then
		// takes a different one of its own.
		await page.goto(sam);
		await mapReady(page);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('physical');
		await page.getByTestId('base-map-switcher').selectOption('streets');
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('streets');

		// Each site still has its own choice on return, which is the criterion.
		await page.goto(tracy);
		await mapReady(page);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('muted');
		await page.goto(sam);
		await mapReady(page);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('streets');

		// And in one origin's storage there are two keys, named after the two paths — the shape the
		// behaviour above rests on, asserted directly so that a regression names itself.
		expect(
			await page.evaluate(() =>
				Object.fromEntries(
					Object.entries({ ...window.localStorage }).filter(([key]) =>
						key.startsWith('ballastella.baseMap')
					)
				)
			)
		).toEqual({
			[`ballastella.baseMap:${server.url}tracy/`]: 'muted',
			[`ballastella.baseMap:${server.url}sam/`]: 'streets'
		});
		expect(seen.failures).toEqual([]);
	});

	test('marks the entries that need a network, in words rather than in colour', async ({
		page
	}) => {
		// SPEC story 72, and ADR-0020's reason: a Reader offline who picks satellite imagery gets a blank
		// map with no explanation. A tooltip would not do — daisyUI renders those via CSS `::before`, which
		// no screen reader announces — so the marking is in the option's own visible text.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		const catalog = await options(page);
		const remote = catalog.filter((entry) => entry.needsNetwork);
		expect(
			remote.length,
			'the catalog offers at least one entry needing a network'
		).toBeGreaterThan(0);
		for (const entry of remote) expect(entry.text).toContain('needs network');
		for (const entry of catalog.filter((one) => !one.needsNetwork)) {
			expect(entry.text).not.toContain('needs network');
		}
		expect(seen.failures).toEqual([]);
	});

	test('a low-contrast-sensitive Reader can select a muted, high-contrast Base Map', async ({
		page
	}) => {
		// SPEC story 98, whose other half is ticket 04's catalog entry. Asserted on the *painted style*
		// rather than on the `<select>`, because a choice that changed the control and not the map would
		// satisfy the letter of it only.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		const muted = (await options(page)).find((entry) => /muted|contrast/i.test(entry.text));
		expect(muted, 'the catalog offers a muted or high-contrast Base Map').toBeDefined();

		// **Before the switch**, and the Base Map the Reader starts on has to be a different one, or the
		// comparison below would be asking whether selecting an option changes the option.
		await expect(page.getByTestId('base-map-switcher')).not.toHaveValue(muted!.value);
		const before = await paint(page);

		await page.getByTestId('base-map-switcher').selectOption(muted!.value);

		// The style was repainted, and its layers now carry the muted flavor's own colours rather than the
		// default's. Compared against the paint before the switch, so this cannot pass on a style that
		// never changed.
		await expect.poll(() => paint(page)).not.toBe(before);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue(muted!.value);
		expect(seen.failures).toEqual([]);
	});

	test('toggling the theme changes the Base Map flavor in the same action (ADR-0016)', async ({
		page
	}) => {
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		const before = await paint(page);
		const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);

		await page.getByRole('button', { name: /Switch to .* theme/ }).click();

		// One signal drove both: the interface's `data-theme` and the map's paint changed together.
		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.theme))
			.not.toBe(themeBefore);
		await mapReady(page);
		await expect.poll(() => paint(page)).not.toBe(before);
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Reading a Map Image as a document (SPEC story 85)
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Map Image read unwarped', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	/**
	 * Both ways in, because a whole class of navigation bug in this codebase was invisible for exactly
	 * this reason: every test used the link route or the direct-load route, never both. A pane that builds
	 * something on mount has two distinct entry states, and the destructive one is the *link*, where an
	 * outgoing map-bearing pane is torn down in the same Svelte flush as the incoming mount.
	 *
	 * The Project here is one the author published **with an address** (SPEC story 92), so
	 * `stampCanonicalUrl` has rewritten the pyramid's `info.json` `id` to this site. That is not a
	 * convenience: it is the only shape in which a tiling viewer can read the sheet at all, because
	 * OpenSeadragon builds every tile URL from the fetched document's own `id` and nothing in the Manifest
	 * can override it. The unstamped case is the test below these two.
	 */
	for (const entry of ['by link', 'by loading the URL'] as const) {
		test(`opens over HTTP ${entry}, and the navigation throws nothing`, async ({ page }) => {
			// The stamp *is* the address the site is served at, and a port cannot be chosen in advance — so
			// the site is served first and the `info.json` rewritten afterwards, which is the order publishing
			// happens in too (`stampCanonicalUrl` takes the address the author typed). The file server reads
			// from disk per request, as a static host does, so this takes effect with no restart.
			site = await published(oneProject());
			const served = site.sites[0]!;
			// At the **site root**, and stamped with an address that names no Project (ADR-0023): a Map
			// Image is shared, so it answers at one citable endpoint however many Projects draw it.
			await writeSiteFile(
				site.directory,
				`images/${IMAGE_ID}/info.json`,
				infoJson(`${served.url}images/${IMAGE_ID}`)
			);
			const seen = watch(page);
			const url = `${served.url}?p=amsterdam-1625`;

			// **Where the tile assertion below starts counting.** The warped Map Image on the Project
			// page fetches the very same pyramid, so a filter over the whole request log would be satisfied by
			// the *map's* tiles and say nothing about the unwarped viewer. Not hypothetical: it is how the
			// `by link` case first passed while the direct-load case failed for a real reason.
			let from = 0;
			if (entry === 'by link') {
				await page.goto(url);
				await mapReady(page);
				from = seen.requests.length;
				// Offered inside the Map Image's own card, which is where a Layer's contents are.
				const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
				await card.getByTestId('read-as-document').click();
			} else {
				await page.goto(`${url}&unwarped=${MAP_LAYER_ID}`);
			}

			const view = page.getByTestId('unwarped-view');
			await expect(view).toBeVisible();
			await expect(view.getByRole('heading', { name: 'Blaeu’s plan of 1625' })).toBeVisible();
			// triiiceratops mounted OpenSeadragon over a container with a real height. The editor measured
			// `#triiiceratops-viewer` at 830 × **0** when the parent had only a `min-h`, and the panel then drew
			// its toolbar over nothing.
			await expect
				.poll(
					() =>
						page.evaluate(() => {
							const root = document.querySelector('#triiiceratops-viewer');
							return root instanceof HTMLElement ? root.clientHeight : 0;
						}),
					{ timeout: 30_000 }
				)
				.toBeGreaterThan(100);
			// The sheet's own tiles were fetched from **this site**, which is the whole of why this works here
			// and not in the editor: a published pyramid has a URL. Counted from `from`, so the warped map's own
			// tiles cannot satisfy it.
			await expect
				.poll(
					() =>
						seen.requests
							.slice(from)
							.filter(
								(request) =>
									request.url.startsWith(served.url) &&
									request.url.includes(`/images/${IMAGE_ID}/`) &&
									request.url.endsWith('.jpg')
							).length,
					{ timeout: 30_000 }
				)
				.toBeGreaterThan(0);
			// Nothing went to the ADR-0004 placeholder host. On an unstamped Project every tile would, which is
			// what the next test is about.
			expect(seen.requests.filter((request) => request.url.includes('unset.invalid'))).toEqual([]);
			expect(seen.failures, 'the navigation into the unwarped view').toEqual([]);

			// And back again — the other direction of the same hazard, and the one that once produced a page
			// containing no map at all with nothing logged beyond a `TypeError` from a page already left.
			await page.getByTestId('back-to-project').click();
			await mapReady(page);
			await expect(page.getByTestId('reader-map-pane')).toBeVisible();
			expect(seen.failures, 'the navigation back to the map').toEqual([]);
		});
	}

	test('refuses plainly, and requests nothing, when the pyramid carries no web address', async ({
		page
	}) => {
		// The unstamped case, which is the **default** for a locally ingested Map Image: its `info.json`
		// still carries the ADR-0004 `https://unset.invalid/<image-id>` placeholder, OpenSeadragon builds
		// every tile URL from that document's own `id`, and nothing a Manifest says can override it —
		// measured, see `apps/viewer/src/lib/unwarped-manifest.ts`.
		//
		// So the page refuses rather than mounting a viewer that could only draw nothing. The assertion that
		// matters most is the request one: **not one request went to the placeholder host**, because the
		// alternative outcome is a Reader looking at an empty rectangle and eight DNS failures.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625&unwarped=${MAP_LAYER_ID}`);

		const problem = page.getByTestId('unwarped-problem');
		await expect(problem).toContainText('cannot be opened on its own');
		// Phrased for the Reader, and it names the way out for the person who can act on it.
		await expect(problem).toContainText('publishing again');
		await expect(page.getByTestId('unwarped-view')).toBeHidden();
		expect(seen.requests.filter((request) => request.url.includes('unset.invalid'))).toEqual([]);
		// And it is not a dead end: the map is still there.
		await page.getByTestId('back-to-project').click();
		await mapReady(page);
		expect(seen.failures).toEqual([]);
	});

	test('says so when the image behind a Map Image is not on the site', async ({ page }) => {
		site = await published(oneProject({ withoutPyramid: true }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + `?p=amsterdam-1625&unwarped=${MAP_LAYER_ID}`);

		await expect(page.getByTestId('unwarped-problem')).toContainText('not on this site');
		// And the way back still works, so one missing image is not a dead end. **On the bar**, which
		// is where it is on every other screen of the site — this one included (SPEC story 3).
		const bar = page.getByTestId('navigation-bar');
		await expect(bar.getByTestId('back-to-project')).toBeVisible();
		await expect(bar.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Graceful degradation: a Published Site outlives the app that wrote it
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Published Site that is not entirely well', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	/**
	 * The whole sentence a site published without the Base Map's display assets shows a Reader.
	 *
	 * Named once and asserted with `toHaveText` in the three rows below — the archive answering, the
	 * archive refusing, and the connection gone — because it is **one** sentence about the site's own
	 * files and the point of pinning it in three rows is that it stays one. A conditional version of it
	 * was where this notice went wrong twice; `resolve.test.ts` drives all four rows of the table.
	 *
	 * It names the author's Labels since ticket 09: a Label's words are shaped from these very
	 * typefaces, so the stack omits the Label bucket on such a site and the sentence that used to
	 * promise "the Annotations are not affected" would have been false.
	 */
	const NOT_PUBLISHED_NOTICE =
		'This site was published without the Base Map’s labels and symbols, so the modern reference ' +
		'map here carries no place names at all, and the author’s Labels are not drawn. The Map ' +
		'Images and the other Annotations — Pins, Lines and Shapes — are not affected.';

	/**
	 * One Annotation of each kind a Layer can draw, close enough together to share a viewport.
	 *
	 * The Label is the one that needs glyphs; the other three are the control that makes "the Label is
	 * not drawn" a claim about typefaces rather than about a Layer that drew nothing at all. The
	 * `marker-symbol: 'label'` literal is spelled out rather than imported: this suite resolves nothing
	 * from `@ballastella/core`, and a convention copied from the file format is a better witness to it
	 * than one taken from the code under test.
	 */
	const everyKind = () => [
		annotation({ title: 'A warehouse' }),
		{
			type: 'Feature',
			id: 'a-label',
			geometry: { type: 'Point', coordinates: [4.92, 52.372] },
			properties: { 'marker-symbol': 'label', title: 'Zuiderzee', fill: '#1976d2' }
		},
		{
			type: 'Feature',
			id: 'a-line',
			geometry: {
				type: 'LineString',
				coordinates: [
					[4.88, 52.36],
					[4.93, 52.365]
				]
			},
			properties: { stroke: '#cc0000', 'stroke-width': 4 }
		},
		{
			type: 'Feature',
			id: 'a-shape',
			geometry: {
				type: 'Polygon',
				coordinates: [
					[
						[4.885, 52.374],
						[4.9, 52.374],
						[4.9, 52.379],
						[4.885, 52.374]
					]
				]
			},
			properties: { stroke: '#cc0000', fill: '#00aa55' }
		}
	];

	/** Which of this stack's buckets MapLibre reports drawing something, anywhere in the viewport. */
	const drawnBuckets = (page: Page): Promise<string[]> =>
		page.evaluate(() => [
			...new Set(
				(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? [])
					.filter((feature) => feature.layer.id.startsWith('ballastella-layer-'))
					.map((feature) => feature.layer.id)
			)
		]);

	test('names the host when a referenced Map Image’s record cannot be read', async ({ page }) => {
		// Ticket 17's degradation table: "Referenced image whose host is unreachable → say so, naming the
		// host; keep the rest of the site working."
		//
		// The failure is injected at the *site* rather than by unplugging a real library: the `remote.json`
		// that says which server holds the image is answered 503, which is the shape of a site whose own
		// host is failing on one file. **`service: ''` is not the fallback** — that would be a warped Layer
		// asking the injection shim for a pyramid a referenced image does not have locally, which draws
		// blank while the page reports it drawn. That is the defect recorded on ticket 09, and the reason
		// this Layer is `unreadable` instead.
		//
		// Since ADR-0023 the 503 also takes away the *only* thing that says where the tiles are: the viewer
		// probes for an `info.json` of ours first and asks `remote.json` when there is none, so an
		// unanswerable `remote.json` leaves it with no address at all rather than with a stale claim.
		site = await published(
			await oneProject({
				imageMode: 'referenced',
				remoteService: 'https://maps.library.example/iiif/x'
			})
		);
		const seen = watch(page);
		await page.route('**/images/aaa/remote.json', (route) =>
			route.fulfill({ status: 503, body: 'the library is down' })
		);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		// The problem band on the *closed* card, which is where a Layer that could not be drawn says so.
		const problem = layerRow(page, MAP_LAYER_ID).getByTestId('layer-problem');
		await expect(problem).toContainText('Blaeu’s plan of 1625');
		await expect(problem).toContainText('did not answer');
		// The **rest of the site still works**: the Annotation Layer is drawn, and the count says one.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		await expect(layerStack(page)).toContainText('Warehouses');
		// Not reported drawn from an address that never arrived.
		expect(
			await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder())
		).not.toContain(`ballastella-layer-${MAP_LAYER_ID}`);
		expect(seen.failures).toEqual([]);
	});

	test('falls back with a quiet notice when the Base Map id is absent from the catalog', async ({
		page
	}) => {
		site = await published(oneProject({ baseMap: 'a-base-map-from-another-deployment' }));
		const seen = watch(page);
		await watchNoticeArrivals(page, 'base-map-notice');

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		await expect(page.getByTestId('base-map-notice')).toContainText(
			'a-base-map-from-another-deployment'
		);
		await expect(page.getByTestId('base-map-notice')).toContainText('not available here');
		// **And a screen reader was told**, which the sentence being on screen does not establish: this
		// is a live region, so it has to have been on the page *before* the sentence for the arrival to
		// be a change. See {@link watchNoticeArrivals} — the fallback is decided by `resolveBaseMap` the
		// moment the Project file lands, so a region rendered anywhere inside the Project's own markup
		// is inserted with this text and announced to nobody.
		expect(
			await noticeArrivals(page),
			'the fallback sentence arrived with the element rather than as a change'
		).toEqual([
			{ kind: 'insert', text: '' },
			{ kind: 'change', text: expect.stringContaining('not available here') }
		]);
		// A working map, not a blank pane: the switcher settled on something the site can serve.
		const chosen = await page.getByTestId('base-map-switcher').inputValue();
		expect(chosen).not.toBe('a-base-map-from-another-deployment');
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	test('draws the work over a network Base Map without shipping a tile archive', async ({
		page
	}) => {
		const archive = await baseMapArchiveFixture();
		let networkArchiveRequests = 0;
		await page.route(/\.pmtiles$/, async (route) => {
			networkArchiveRequests += 1;
			const served = byteRange(
				archive,
				route.request().headers()['range'],
				'application/octet-stream'
			);
			await route.fulfill({
				status: served.status,
				headers: { ...served.headers, 'access-control-allow-origin': '*' },
				body: served.body
			});
		});
		site = await published(
			oneProject({ baseMap: 'physical', annotations: everyKind() }, { baseMapAssetsBundled: true })
		);
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		// **Empty rather than absent**, and that is the mechanism rather than a detail (ticket 11): this
		// notice is a live region, so it has to be on the page before its sentence arrives for the
		// arrival to be a *change* — a live region inserted with its text already in it is announced to
		// nobody. It says nothing here, and `aria-live` is asserted with the sentence up below.
		await expect(page.getByTestId('base-map-not-published')).toHaveText('');
		// And no outage claimed either: the archive answered, so `base-map-unavailable` — the notice for
		// an archive that did not — must stay off the screen. A warning that is always on is unreadable.
		// This one *does* come and go, so it is absent outright: `MapNotice` gives the two shapes the two
		// mechanisms, and `packages/ui/src/map-notice.dom.test.ts` holds the rule.
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		const options = page.getByTestId('base-map-switcher').locator('option');
		await expect(options).toHaveCount(4);
		for (const option of await options.allTextContents()) expect(option).toContain('needs network');
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(networkArchiveRequests).toBeGreaterThan(0);
		expect(
			seen.requests.filter(
				(request) => request.url.startsWith(served.url) && request.url.endsWith('.pmtiles')
			)
		).toEqual([]);

		// ── AND A LABEL DRAWS, BECAUSE THIS SITE CARRIES THE TYPEFACES (story 60's Reader half) ──
		//
		// The control for the site that carries none, where the Label bucket is omitted: without this,
		// that test's "the Label is not drawn" would be satisfied by a Label that never draws anywhere.
		// The glyphs come from this site's own `base-map/`, which is why the assertion belongs to the row
		// where the display assets are bundled.
		await expect
			.poll(() => drawnBuckets(page), { timeout: 30_000 })
			.toEqual(expect.arrayContaining([bucket('label'), bucket('point')]));

		expect(served.failures).toEqual([]);
		expect(seen.failures).toEqual([]);
	});

	test('draws its Base Map from its own cached tiles with the archive unreachable', async ({
		page
	}) => {
		// ADR-0025 from the Reader's side. A scholar made a Project available offline before publishing,
		// so `base-map/tiles/…` is part of the site — publishing copied nothing extra, because the tiles
		// were already in the Workspace that *is* the published root.
		//
		// **The archive is aborted, not merely unused.** Every catalog entry points at somebody else's
		// bucket, so leaving it reachable would let this pass with the cache doing nothing at all. With
		// it refused, anything drawn came out of the site's own files.
		//
		// And the claim rests on served bytes *and* the **Base Map's own geography** being on screen,
		// never on the absence of an error and never on "some feature rendered": the compression mistake
		// ADR-0025 names serves bytes, parses nothing, and throws nothing — and this Project draws two
		// Layers of the Reader's own over the same map, so a bare feature count is satisfied by those
		// while the reference map is blank. `roads_` and `water` are Protomaps layer prefixes and belong
		// to no Layer this app produces (`ballastella-layer-…`).
		const cached = await cachedBaseMapTiles(ARCHIVE);
		site = await published({
			...oneProject(
				{ baseMap: 'physical' },
				{
					baseMapBundled: true,
					baseMapCaches: [{ archive: ARCHIVE, maxZoom: cached.maxZoom }]
				}
			),
			...cached.files
		});
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.route(/\.pmtiles$/, (route) => route.abort());

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		await expect
			.poll(
				async () => (await page.evaluate(() => window.ballastellaServedBaseMapTiles ?? [])).length,
				{ timeout: 60_000 }
			)
			.toBeGreaterThan(0);
		await expect
			.poll(
				() =>
					page.evaluate(() =>
						(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
							(feature) =>
								feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
						)
					),
				{ timeout: 60_000 }
			)
			.toBe(true);

		// The Reader's own work still draws over it, and the licence still says whose data this is.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		await expect(page.locator('.maplibregl-ctrl-attrib')).toContainText('OpenStreetMap');
		// Nothing was missing from the site, and the page threw nothing.
		expect(served.failures).toEqual([]);
		expect(seen.failures).toEqual([]);
	});

	test('says so when the site carries no copy of the Base Map’s labels and symbols', async ({
		page
	}) => {
		// Legacy Published Sites may not carry the Base Map's own glyphs and sprites. New publishes
		// include them, but the Reader still has to explain this older state rather than silently
		// dropping every place name.
		//
		// Since ticket 10 this state looks different from the way it used to. Every catalog entry now
		// reads a remote archive, so the geography still draws — and what a site without those files
		// loses is **every place name on the map**. `ReaderMapPane` drops `glyphs`, `sprite`, and the
		// symbol layers rather than 404ing at files that are not there, and the question this test
		// exists to answer is whether the Reader is told. A geography-only map with no account of
		// itself is precisely the silent failure this ticket forbids.
		//
		// **And since ticket 09 the author's own Labels go with the place names**, because a Label's
		// words are shaped from those same typefaces. So this Project holds one of every kind: the Label
		// must not be drawn, and the Pin, the Line and the Shape beside it must — an assertion about the
		// Label alone would pass on a site that drew nothing at all.
		site = await published(
			oneProject(
				{ baseMap: 'physical', annotations: everyKind() },
				{ baseMapAssetsBundled: false }
			),
			{ withoutBaseMap: true }
		);
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		// The whole sentence, in the row where the archive answers. Two more tests below assert the
		// **same** string with the archive refusing, and with the connection gone as well: it is one
		// sentence about the site's own files, and the point of pinning it in three rows is that it
		// stays one. A conditional version of it was where this notice went wrong.
		const notice = page.getByTestId('base-map-not-published');
		await expect(notice).toHaveText(NOT_PUBLISHED_NOTICE);
		// **And no outage claimed.** The archive answers here (the global `beforeEach` serves the
		// fixture), so this site is short of its labels and of nothing else.
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		// The scholar's own work is still drawn, and so is the geography: this is a reference map
		// missing its lettering, not a missing Project.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		// ── THE LABEL IS NOT DRAWN, AND THE REST OF THE LAYER IS (stories 58 and 59) ────────────
		//
		// The three other kinds are polled for, because a GeoJSON source may not have painted on the
		// first frame; the Label's absence is then asserted against the same answer, so it is read from a
		// map that has demonstrably finished drawing this Layer.
		await expect
			.poll(() => drawnBuckets(page), { timeout: 30_000 })
			.toEqual(expect.arrayContaining([bucket('point'), bucket('line-solid'), bucket('fill')]));
		expect(await drawnBuckets(page)).not.toContain(bucket('label'));
		// And the bucket was never added at all, rather than added and painting nothing — which is the
		// difference between omitting it and asking MapLibre for a font this site does not carry.
		expect(
			await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder())
		).not.toContain(bucket('label'));
		// And not one request for a file the site does not hold — the 404s the old empty-rectangle
		// path existed to prevent are still prevented, glyph ranges and sprites included.
		expect(seen.requests.filter((request) => request.url.includes('/base-map/'))).toEqual([]);
		expect(served.failures).toEqual([]);
		expect(seen.failures).toEqual([]);
	});

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// AN ARCHIVE THAT DOES NOT ANSWER, SAID OUT LOUD TO A READER (ticket 22, SPEC stories 111–112)
	//
	// The editor got this in ticket 20. The viewer did not, and the viewer is the side that needed it
	// more: `ReaderMapPane` says so itself — "a Published Site has no console anyone is watching". A
	// Reader handed an empty rectangle cannot tell an outage from a broken tool, and cannot rule out
	// the third possibility either, that the scholar's work failed to draw.
	//
	// **This is not hypothetical.** `demo-bucket.protomaps.com` — the host every entry in this
	// deployment's catalog read until the repoint to the source.coop mirror — began refusing the
	// archive on 2026-08-07, and a blank map with no explanation was then the behaviour of every
	// published site. ADR-0025 predicted exactly that, and the mirror is borrowed too.
	//
	// **The refusal is the fixture, not the network.** `refuseBaseMapArchive` aborts it deliberately,
	// so these assertions hold on a machine with a working connection and on the day the bucket
	// returns.
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/**
	 * The whole sentence, for the entry these tests ask for and the host this deployment's catalog
	 * names. `support/base-map-notice.ts` builds it, and `editor-base-map.e2e.ts` asserts the same
	 * function's output against the editor — which is what makes "one outage, one sentence, two
	 * applications" a contract rather than an intention. Its header says why it is a function.
	 *
	 * The three things it carries, in the order the questions arrive: **it is not you**, **your work
	 * is safe**, **here is what would fix it**.
	 */
	const UNAVAILABLE_NOTICE = unavailableNotice('Physical geography', ARCHIVE_HOST);

	test('says so when the Base Map’s archive answers nothing, and keeps drawing the work', async ({
		page
	}) => {
		// The global `beforeEach` routes the archive to the real-byte fixture, so it is unrouted first:
		// leaving both handlers registered would make this test's subject depend on Playwright's
		// matching order rather than on a decision made here.
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);

		// **Not `mapReady`.** That waits for the Layer stack, which is a different question and one this
		// test also asks below. What is waited for first is the notice, because the whole defect was that
		// nothing ever appeared.
		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });

		// Announced, and by the mechanism the editor reasoned out: `role="alert"` rather than a live
		// region, because this element is *inserted* when its text first exists and an `aria-live` region
		// is announced on a text **change** rather than on insertion — a live region here is a notice a
		// screen-reader user never hears.
		await expect(notice).toHaveAttribute('role', 'alert');

		// Visible text and not a tooltip (SPEC story 111, ADR-0016: daisyUI renders tooltips through CSS
		// `::before`, so they are neither announced nor dismissable).
		//
		// **One assertion, and it is the whole sentence.** The fragments that used to follow — the host,
		// "Nothing in your Workspace is affected", "available offline", "usually that server rather than
		// your connection" — were each a substring of the string already pinned exactly, so no edit could
		// turn one red without turning this red first. CONTRIBUTING is explicit that such an assertion
		// should go, and go in the commit that made it so: they were documentation dressed as coverage,
		// and they made this criterion look four times as well covered as it is.
		await expect(notice.locator('p')).toHaveText(UNAVAILABLE_NOTICE);
		// An alert, because it was inserted with its text already in it: an `aria-live` region is
		// announced when its text changes, so this notice as a live region would reach nobody at all
		// (ticket 11, and the amendment to ADR-0016 the shared component now holds).
		await expect(notice).toHaveAttribute('role', 'alert');
		await expect(notice).not.toHaveAttribute('aria-live', /.*/);
		// Nothing about the site's own files is wrong here, so that notice is up and empty.
		await expect(page.getByTestId('base-map-not-published')).toHaveText('');

		// ── The notice explains an absence; it does not replace the map ─────────────────────────────
		// A fix that blanked the pane on error would satisfy every assertion above. So the Reader's own
		// work is asserted **drawn**, by rendered features and not by a count of what the page claims.
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		await expect
			.poll(
				() =>
					page.evaluate(
						() =>
							(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).filter((feature) =>
								feature.layer.id.startsWith('ballastella-layer-')
							).length
					),
				{ timeout: 60_000 }
			)
			.toBeGreaterThan(0);
		// **And the Map Image, which the assertion above cannot see.** A `kind: 'map'` Layer is a
		// `WarpedMapLayer` — a custom WebGL layer — and `queryRenderedFeatures()` returns nothing for
		// one, so the filter above is satisfied by the Annotation Layer alone. `data-drawn="2"` is the
		// page's own count of itself, which is exactly the kind of evidence this ticket refuses. Tiles
		// in the renderer's cache are the Map Image's equivalent of a rendered feature, and the
		// idiom is this suite's own — see "draws the stack in the author's order". Mutation-checked by
		// 404ing the Map Image's tiles: `data-drawn` stayed at `2` and this went to `0`.
		await expect
			.poll(
				() =>
					page.evaluate(async (id) => {
						const handle = window.ballastellaReaderMap!;
						const layer = handle.warped[id]!;
						handle.map.fitBounds(layer.getBounds(), { animate: false });
						await new Promise((resolve) => setTimeout(resolve, 500));
						return (layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
					}, MAP_LAYER_ID),
				{ timeout: 60_000 }
			)
			.toBeGreaterThan(0);
		// And the refusal was real rather than a fixture that quietly answered: none of the Base Map's
		// own geography is on screen. `roads_` and `water` are Protomaps layer prefixes and belong to no
		// Layer this app produces.
		expect(
			await page.evaluate(() =>
				(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
					(feature) => feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
				)
			)
		).toBe(false);

		// A notice, not a broken page: the switcher still works and nothing threw.
		await expect(page.getByTestId('base-map-switcher')).toBeVisible();
		expect(seen.failures).toEqual([]);
	});

	test('withdraws the outage notice when the Reader’s own connection goes', async ({
		page,
		context
	}) => {
		// The other half of "it is not you". `baseMapUnavailableNotice` tells a Reader that a failing
		// remote archive "is usually that server rather than your connection" — true while the connection
		// is fine and a plain falsehood once it is not. A Reader whose wifi has dropped being told a
		// bucket in another country is having a bad afternoon is worse off than one told nothing, so the
		// claim is withdrawn rather than restated.
		//
		// The transition is driven rather than the state set up, deliberately: the notice is asserted
		// **present** first, so its later absence is this signal acting and not a page that never got
		// there. `navigator.onLine` is a weak signal — a link, not reachability — which is exactly why it
		// is used only to *withhold* a claim and never to make one. This viewer has no offline notice at
		// all, and that is the intended end state, not an omission.
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await expect(page.getByTestId('base-map-unavailable')).toBeVisible({ timeout: 45_000 });
		// **Drawn before the connection goes**, and this wait is load-bearing rather than tidy.
		// `setOffline` refuses `localhost` too, so it takes away the site's own files as well as the
		// archive — and the Map Image's tiles are site files, fetched as the renderer needs them.
		// Cutting the connection mid-fetch leaves one Layer of two drawn, which is a true report of a
		// Project that had not finished arriving and not the claim below. Without this the assertion
		// after the cut is a race, and it lost one run in four here.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2', {
			timeout: 60_000
		});

		await context.setOffline(true);
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		// And the Reader's work is still on the map: losing a connection loses no Layer, because every
		// byte of this Project already arrived.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		// Back again, and the account of the outage comes back with it rather than staying suppressed.
		await context.setOffline(false);
		await expect(page.getByTestId('base-map-unavailable')).toBeVisible();

		// ── No exception, and that is ticket 04's proof ─────────────────────────────────────────────
		// This assertion used to carry a named exception for one message. Cutting the connection while a
		// warped Layer is on screen makes `@allmaps/render`'s `loadImage` ask this site for the
		// Map Image's `info.json`, and the store's rejection — `SiteFileUnreachableError` —
		// escaped it uncaught, arriving as a `pageerror`. It was measured at three runs in eight, here
		// and at the commit before the work that found it, so it was neither that change nor
		// contention.
		//
		// **What this line defends, stated from the mutation rather than from the intention.** Restoring
		// the `throw cause` that `createStoreImageFetch` used to do leaves this line GREEN — measured —
		// because the patch to `@allmaps/render`'s `WebGL2Renderer` now settles the promise that
		// carried the rejection. "The Reader is told" is guarded by the three tests at the end of this
		// describe instead.
		//
		// ⚠ **And this is a WEAK guard on the patch, which is worth knowing before trusting it.** With
		// the hunk reverted this test fails **1 run in 8** — its refusal is a race between the
		// connection being cut and the `info.json` fetch — while `tells a server that is failing apart
		// from a connection that is gone` fails **4 of 4**, because it drives the refusal deliberately.
		// A green run with this test merely *retried* is exactly what a reverted patch looks like, so
		// the retry budget is not the instrument here. That test is.
		expect(seen.failures).toEqual([]);
	});

	test('makes no claim about the Base Map when the page is opened with no connection', async ({
		page
	}) => {
		// The case the test above cannot reach. `context.setOffline(true)` drives the `offline` **event**,
		// and an event only tells a page that something changed — so a page *loaded* while already
		// offline hears nothing, and `online.svelte.ts` reads `navigator.onLine` once at `start()` for
		// exactly that Reader. Delete that one line and the suite above stays entirely green while an
		// offline Reader is handed the sentence the whole module exists to withhold: that a bucket in
		// another country is having a bad afternoon and their own connection is fine.
		//
		// ⚠ **`navigator.onLine` is overridden rather than the context taken offline**, and that is the
		// only lever there is: Playwright's offline emulation refuses `localhost` too, so the site could
		// not be fetched at all and there would be no page to assert about. This is not a network stub —
		// nothing here answers or refuses a request (the archive is refused by a route, as everywhere
		// else in this section) — it is the browser being asked to report the state a Reader on a train
		// arrives in.
		await page.addInitScript(() =>
			Object.defineProperty(window.navigator, 'onLine', { get: () => false })
		);
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await mapReady(page);

		// **The archive genuinely failed**, asserted rather than said in a comment. Every other check
		// here is an *absence*, and absences are satisfied just as well by a Base Map that worked
		// perfectly: delete the two lines above that refuse the archive and this test would otherwise
		// stay green with the global fixture serving it, proving nothing about the gate at all. None of
		// the Base Map's own geography being on screen is what makes the silence below a suppression.
		expect(
			await page.evaluate(() =>
				(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
					(feature) => feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
				)
			)
		).toBe(false);
		// And the page still says nothing about whose fault it is, because it does not know. Long enough
		// for the source error to have arrived and been suppressed rather than merely not having
		// happened yet — an absence asserted one frame after `goto` is an absence of nothing.
		await page.waitForTimeout(3_000);
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		// And the Reader's work is drawn regardless, which is the whole of ADR-0012's promise.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	test('does not blame the Base Map for a failure that is not the Base Map’s', async ({ page }) => {
		// `error` carries everything MapLibre could not do — a sprite, a glyph range, a warped Layer's
		// tiles — and the handler in `ReaderMapPane` filters it to the one source `baseMapStyle`
		// declares. Delete that filter and every other test in this section stays green, because in all
		// of them the Base Map is the thing that failed. So one where it is not: the sprite is refused
		// and the archive answers, and the Reader must be told nothing, because there is nothing wrong
		// with their Base Map.
		//
		// The sprite rather than the glyphs, because MapLibre asks for a sprite unconditionally while a
		// glyph range is only fetched once a label needs one — an assertion resting on a request nobody
		// makes is the vacuity CONTRIBUTING names.
		//
		// ⚠ **Asserted as "was never observed on screen", not as "is not there now"**, and that
		// distinction is the whole of this test. The pane reports `'drawing'` when the source loads, so a Base Map that
		// works takes down any notice raised a moment earlier — which means an unfiltered `error` from
		// the sprite would raise this notice, have it withdrawn, and leave a `toHaveCount(0)` at the
		// end of the test green. It did, until this observer replaced it. Recording every insertion is
		// the only way to fail on a notice that was on screen for two frames, and two frames of "the
		// Base Map did not load" over a Base Map that plainly did is exactly the accusation the filter
		// exists to prevent.
		await page.addInitScript(() => {
			const seenNotice = { at: false };
			(window as unknown as { ballastellaNoticeSeen: { at: boolean } }).ballastellaNoticeSeen =
				seenNotice;
			new MutationObserver(() => {
				if (document.querySelector('[data-testid="base-map-unavailable"]')) seenNotice.at = true;
			}).observe(document, { childList: true, subtree: true });
			// The callback re-queries rather than scanning `record.addedNodes`, so an insertion and a
			// removal collapsed into one Svelte flush would leave it seeing nothing. `error` and
			// `sourcedata` arrive in separate tasks, so the regression this guards against does render a
			// frame — but "never on screen" is the claim it can support, not "never in the DOM".
		});
		await page.route(/\/base-map\/sprites\//, (route) =>
			route.fulfill({ status: 404, body: 'not here' })
		);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await mapReady(page);

		// The Base Map itself drew: its own geography is on screen, so the refusal above cost a symbol
		// and not the map.
		await expect
			.poll(
				() =>
					page.evaluate(() =>
						(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
							(feature) =>
								feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
						)
					),
				{ timeout: 60_000 }
			)
			.toBe(true);
		// And the sprite really was refused, so this is not a test of nothing.
		expect(seen.requests.some((request) => request.url.includes('/base-map/sprites/'))).toBe(true);
		await page.waitForTimeout(2_000);
		expect(
			await page.evaluate(
				() =>
					(window as unknown as { ballastellaNoticeSeen?: { at: boolean } }).ballastellaNoticeSeen
						?.at
			),
			'the outage notice was never observed on screen'
		).toBe(false);
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		expect(seen.failures).toEqual([]);
	});

	test('says both things when a site published without those files also meets an outage', async ({
		page
	}) => {
		// **The combination, which is the state of a `withoutBaseMap` site today.** The code claimed in
		// prose that these two notices were mutually exclusive — that the not-published style "declares
		// no source at all, so it can never reach this". That is true only of the bare background style,
		// which is built for a *site-relative* archive; every entry in this deployment's catalog is
		// absolute, so a site published without its Base Map files draws the remote style with its
		// symbol layers stripped, and that style declares the source, fails with it, and raises the
		// outage notice alongside.
		//
		// The pair then read: "the modern reference map is drawn from the network without any place
		// names on it — the geography, the Map Images, and the Annotations are all here", directly
		// above "The Base Map could not be loaded from" the archive's host. The first sentence is
		// a flat falsehood in that state, and it was the live behaviour of every site this deployment
		// published. The claim about the geography is gone rather than made conditional — see the next
		// test for the row a conditional one would still have got wrong.
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: false }), {
			withoutBaseMap: true
		});
		const seen = watch(page);
		await watchNoticeArrivals(page, 'base-map-not-published');

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await expect(page.getByTestId('base-map-unavailable')).toBeVisible({ timeout: 45_000 });
		await mapReady(page);

		// Both are up, because both are true and they have different remedies: the outage is the
		// Reader's to work around by switching Base Map, the missing labels are the publisher's to fix.
		const notPublished = page.getByTestId('base-map-not-published');
		await expect(notPublished).toBeVisible();
		// The other mechanism, on the same screen as the alert above: this notice is always on the page
		// and says nothing until there is something to say, so what a screen reader hears is the text
		// changing. Both halves are asserted here because a page that got them the same way round would
		// silently lose one of the two announcements (ticket 11).
		await expect(notPublished).toHaveAttribute('aria-live', 'polite');
		await expect(notPublished).toHaveAttribute('aria-atomic', 'true');
		await expect(notPublished).not.toHaveAttribute('role', /.*/);
		// ⚠ **And the change those attributes exist for actually happened**, which the attributes cannot
		// say. This sentence is true from the first frame — the site record has not been read, so no
		// bundled assets are known — so it is the notice most easily inserted already carrying its text,
		// and it was. {@link watchNoticeArrivals} records the sequence from document creation.
		expect(
			await noticeArrivals(page),
			'the missing-labels sentence arrived with the element rather than as a change'
		).toEqual([
			{ kind: 'insert', text: '' },
			{ kind: 'change', text: expect.stringContaining('no place names at all') }
		]);
		await expect(notPublished).toHaveText(NOT_PUBLISHED_NOTICE);
		await expect(page.getByTestId('base-map-unavailable').locator('p')).toHaveText(
			UNAVAILABLE_NOTICE
		);

		// The Reader's own work is drawn under both notices, which is what makes them notices rather
		// than an error page.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	test('says the same thing about its missing labels with no connection at all', async ({
		page
	}) => {
		// **The row a conditional sentence would still have got wrong**, and the worse of the two: with
		// no connection the archive fails exactly as it does above, and the outage alert is deliberately
		// withheld — its remedy reads "this is usually that server rather than your connection", which
		// is a falsehood to hand somebody whose wifi is off. So a sentence keyed on *the notice* rather
		// than on *the failure* would print "the geography, the Map Images, and the Annotations are
		// all here" in front of an empty rectangle, alone, with nothing underneath it to contradict it.
		//
		// The fix was not a third branch. This notice is about files the site does not carry, which is
		// knowable without asking anything of the network, so it says one thing in every row — and this
		// test is here because that is a property worth being unable to lose.
		await page.addInitScript(() =>
			Object.defineProperty(window.navigator, 'onLine', { get: () => false })
		);
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: false }), {
			withoutBaseMap: true
		});
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await mapReady(page);

		await expect(page.getByTestId('base-map-not-published')).toHaveText(NOT_PUBLISHED_NOTICE);
		// The archive did fail — no Base Map geography is on screen — and nothing on the page blames
		// the server for it.
		expect(
			await page.evaluate(() =>
				(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
					(feature) => feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
				)
			)
		).toBe(false);
		await page.waitForTimeout(3_000);
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// AN ARCHIVE THAT ANSWERS ITS HEADER AND THEN STOPS
	//
	// Every test above refuses the archive outright, which is one failure shape out of two, and the
	// easier one. {@link routePartialBaseMapArchive} produces the other: the first range — the header
	// and the root directory — is served from the real fixture, and every range after it is refused.
	// A bucket rate-limiting mid-session looks exactly like this, and so does a proxy with a partial
	// cache.
	//
	// It reaches a different path through the application, and the difference is the whole reason the
	// pane reports `'drawing'` as well as `'unavailable'`. An outright refusal is a failed **header**,
	// and `pmtiles` caches that rejection under the archive URL for the life of the page, so it can
	// never come back. A tile **data** range goes through an uncached read, so this one **can**: the
	// three tests below are the notice going up, staying up while the refusal lasts, and coming down
	// when it does not. (A leaf directory is neither — it shares the header's promise cache. The
	// fixture's header says what that means for an archive larger than one city.)
	//
	// One hazard was chased here and is not present. MapLibre's `SourceCache.loaded()` is documented as
	// true once every tile is loaded *or errored*, so the fear was that this shape fires `error` and
	// then `sourcedata` with `isSourceLoaded`, taking a true notice down. Instrumented, the sequence
	// while the refusal lasts is `sourcedata` × 3, all `isSourceLoaded: false` (`visibility`,
	// `metadata`, `content`), then ten `error`s — and "stays up" is asserted rather than left to that
	// measurement.
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/**
	 * Serve the archive's first range from the real fixture and refuse the rest, until told to hang.
	 *
	 * `bytes=0-…` is the header read and nothing else: `pmtiles`' `FetchSource.getBytes` asks for
	 * `bytes=0-16383` once per archive and every later read is at `tileDataOffset + …`, which is past
	 * the end of a 4 MB fixture's header. So the discriminator is the offset, not a counter, and it
	 * does not care how many tiles a viewport happens to want.
	 *
	 * `hang()` switches the refusal for silence — a request that is never answered and never fails —
	 * which is the only way to hold a source in "asked, not yet told" for the length of an assertion.
	 * Held handlers are dropped rather than resolved when the test ends; `unrouteAll` is called with
	 * `ignoreErrors` so Playwright does not wait for a promise that by construction never settles.
	 * `serve()` is the bucket's limit lifting: tile ranges begin answering with the fixture's real
	 * bytes while the header stays exactly as it was.
	 *
	 * ⚠ **`tileRangesAsked` is this fixture's positive control, and it is asserted.** Everything else
	 * these two tests assert — a notice, no geography, a drawn stack — holds identically if the
	 * serving branch above is deleted and the whole archive is refused, which is what makes "this
	 * reaches a different path" documentation rather than coverage. A tile range can only be *asked
	 * for* once `getHeader` resolved, so a non-zero count is the one observation that separates a
	 * partial refusal from an outright one.
	 */
	test('keeps the outage notice up when the archive answers its header and then stops', async ({
		page
	}) => {
		const archive = await routePartialBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await mapReady(page);

		// **And it stays up**, which no test asserted before: a notice that flickered off would have
		// surfaced only as a flake, in a suite that retries. Five seconds, which is an order of
		// magnitude longer than the whole load takes here.
		await page.waitForTimeout(5_000);
		await expect(notice).toBeVisible();
		await expect(notice.locator('p')).toHaveText(UNAVAILABLE_NOTICE);

		// The refusal was real: no Base Map geography drew, despite the header having answered.
		expect(
			await page.evaluate(() =>
				(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
					(feature) => feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
				)
			)
		).toBe(false);
		// **And it really was a partial refusal**, which is the only assertion here that an
		// outright one would not also satisfy: tile ranges were asked for, so the header answered.
		expect(archive.tileRangesAsked()).toBeGreaterThan(0);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	test('takes the notice down when the archive starts answering again', async ({ page }) => {
		// **The recovery the `'drawing'` half of the pane's report exists for**, and the reason it is
		// not dead code. `pmtiles` caches the archive *header* promise per URL, and nothing evicts it
		// on rejection — only `prune()` does, dropping the least recently used once the cache reaches
		// its hundred entries — so a header that refuses is sticky for the life of a page that reads
		// one archive. A tile **data** range is not cached at any level, so it is asked again every
		// time, and a bucket that rate-limits mid-session therefore comes back: the limit lifts, the
		// Reader pans, tiles arrive, and geography draws. Without `'drawing'` the alert would sit over
		// a working Base Map for as long as the Reader stayed on the page, which is a worse lie than
		// the silence this ticket was written to end.
		//
		// ⚠ A **leaf directory** read is neither of those: it is a non-header range that `getDirectory`
		// caches in the same promise cache, keyed `${key}|${etag}|${offset}|${length}`. So it refuses
		// once and is refused from cache thereafter, and an archive large enough to have leaf
		// directories does not recover this way. `routePartialBaseMapArchive`'s header has the whole
		// of it; the committed fixture is one city and has none.
		//
		// The pan is what makes it a recovery rather than a wait. MapLibre has no reason to re-ask for
		// a tile it has already given up on, so a fixture that merely starts answering changes nothing
		// until the viewport wants tiles it does not hold.
		const archive = await routePartialBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await mapReady(page);

		archive.serve();

		// The geography arrives… **with the pan inside the poll**, which is the same idiom this suite
		// uses for a warped Layer's tile cache and for the same reason: one nudge is a bet that a
		// single round of tile requests lands, and this test measured that bet losing about one run in
		// six. Alternating the zoom asks for a fresh set of tiles on every attempt, so the loop is what
		// drives the recovery rather than what waits for it. The centre stays where the fixture's data
		// is — this archive is one city — so a failure here is a Base Map that did not come back rather
		// than a viewport pointed at empty ocean.
		let step = 0;
		await expect
			.poll(
				() =>
					page.evaluate(
						async (zoom: number) => {
							const map = window.ballastellaReaderMap!.map;
							map.jumpTo({ center: [4.9041, 52.3676], zoom });
							await new Promise((resolve) => setTimeout(resolve, 500));
							return map
								.queryRenderedFeatures()
								.some(
									(feature) =>
										feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
								);
						},
						12 + (step++ % 2)
					),
				{ timeout: 60_000 }
			)
			.toBe(true);
		// …and the accusation goes with it, rather than being left over a map that is plainly drawing.
		//
		// **Panned here too, and that is a fact about the mechanism rather than about the harness.**
		// `'drawing'` is `sourcedata` with `isSourceLoaded`, and MapLibre reports a source loaded only
		// when *every* tile it holds for the viewport has settled — so geography can be on screen from
		// the tiles that arrived while one that was refused earlier is still sitting in the cache as
		// errored, and the notice correctly stays up. What takes it down is the Reader carrying on
		// moving, which is what a Reader does. On a quiet machine the first settle is usually enough;
		// under two other suites this assertion is what went red, once in three, with the geography
		// already drawn. So the nudging continues until the claim is withdrawn.
		await expect
			.poll(
				async () => {
					await page.evaluate(
						async (zoom: number) => {
							window.ballastellaReaderMap!.map.jumpTo({ center: [4.9041, 52.3676], zoom });
							await new Promise((resolve) => setTimeout(resolve, 500));
						},
						12 + (step++ % 2)
					);
					return notice.count();
				},
				{ timeout: 60_000 }
			)
			.toBe(0);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	test('withdraws the claim when the Reader switches to a Base Map it has not asked yet', async ({
		page
	}) => {
		// The other half of the clearing mechanism, and the only half there is: the page drops what it
		// knows when the shown entry changes, because a switch asks a fresh question and the answer to
		// the old one is not an answer to it. "Could not be loaded" carries the *new* entry's label —
		// `archiveUnavailable` composes it from whichever entry is shown — so an unreset flag does not
		// merely linger, it accuses a Base Map that has not failed.
		//
		// Driving that needs a Base Map whose fate is genuinely undecided, which is what `hang()` is
		// for: after the switch the tile requests are neither answered nor refused, so nothing can
		// clear the flag except the reset under test. A fixture that answered would clear it by
		// drawing, and one that refused would replace the notice with a true one — both green either
		// way, which is why this was untested.
		const archive = await routePartialBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice.locator('p')).toContainText('Physical geography');

		archive.hang();
		await page.getByTestId('base-map-switcher').selectOption('muted');

		// Nothing is said about “Muted, high contrast” until it has answered for itself.
		await expect(notice).toHaveCount(0);
		await page.waitForTimeout(3_000);
		await expect(notice).toHaveCount(0);
		// And the switch really happened rather than the notice having gone for some other reason.
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('muted');
		// **The Layer stack is deliberately not asserted drawn here**, and the reason is the fixture:
		// a style whose source never settles never finishes loading, and `whenStyleLoaded` gives the
		// wait up rather than holding a Reader for ever — so `data-drawn` is `0`, correctly. That the
		// work keeps drawing through an outage is asserted where the outage is a real one, above.
		expect(seen.failures).toEqual([]);
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	test('refuses a Project from a newer version plainly, naming where to open it (ADR-0010)', async ({
		page
	}) => {
		site = await published(oneProject({ projectOverrides: { formatVersion: 99 } }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');

		const problem = page.getByTestId('project-problem');
		await expect(problem).toContainText('newer version of Ballastella');
		await expect(problem).toContainText('format 99');
		// Nothing was misrendered in its place, and the hub is still reachable.
		await expect(page.getByTestId('reader-map-pane')).toBeHidden();
		await expect(page.getByTestId('all-projects')).toBeVisible();
		expect(seen.failures).toEqual([]);
	});

	test('says which Project is missing when ?p= names one that is not here', async ({ page }) => {
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=not-a-project');

		await expect(page.getByTestId('project-problem')).toContainText('not-a-project');
		await expect(page.getByTestId('all-projects')).toBeVisible();
		expect(seen.failures).toEqual([]);
	});

	test('tells a Reader the site has nothing published into it yet, rather than throwing', async ({
		page
	}) => {
		// The bundle sitting in a half-set-up GitHub Pages repository with no site record beside it — which
		// is what the viewer's own files look like before publishing has written one.
		site = await published({});
		const seen = watch(page);

		await page.goto(site.sites[0]!.url);

		await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
		await expect(page.getByTestId('site-problem')).toContainText('nothing has been published');
		expect(seen.failures).toEqual([]);
	});

	test('warns that a referenced Map Image leaves a Reader with no network seeing nothing', async ({
		page
	}) => {
		// SPEC story 29 from the Reader's side. What decides whether a Reader needs the network is the
		// **site's own files** — a `remote.json` with no `info.json` of ours beside it (ADR-0023) — rather
		// than a field of `project.json`, and the Reader is the person who meets the consequence.
		site = await published(
			await oneProject({
				imageMode: 'referenced',
				remoteService: 'https://maps.library.example/iiif/x'
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');

		await expect(page.getByTestId('project-needs-network')).toContainText('Blaeu’s plan of 1625');
		await expect(page.getByTestId('project-needs-network')).toContainText('network');

		// ⚠ **And no per-Layer badge, which is a different thing from the paragraph above** (SPEC
		// stories 20 and 21, ticket 05). Where a Map Image's tiles are held is the author's
		// publishing decision: a Reader cannot copy a pyramid, cannot repoint a service, and cannot make
		// the badge say the other thing. The warning above survives because it names what will not draw
		// on a train, which is a consequence a Reader meets.
		//
		// **The card is opened first**, because the badge is inside the open card in the editor: asked
		// of a closed one this would be true of both apps and would say nothing. And its positive
		// control is the editor's own — `e2e/editor-layers.e2e.ts`'s "shows the Layer as a local copy",
		// which asserts the same `layer-image-mode` **present** — so passing `referencedImageIds` from
		// the viewer turns this red rather than leaving the pair silently agreeing.
		const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await expect(card.getByTestId('layer-image-mode')).toHaveCount(0);
		await expect(page.locator('[data-image-mode]')).toHaveCount(0);
		expect(seen.failures).toEqual([]);
	});

	// ═════════════════════════════════════════════════════════════════════════════════════════════
	// A MAP IMAGE WHOSE TILES STOP ARRIVING, SAID OUT LOUD (ticket 04, SPEC stories 14–21)
	//
	// The failure this section exists for was invisible by construction: the store's refusal escaped
	// `@allmaps/render`'s `loadImage` as an uncaught `pageerror` — measured at three runs in eight —
	// and **nothing a Reader saw changed at all**. A published site has no console anyone is watching,
	// so that error reached nobody. The suite's own "no uncaught page error" assertion is the only
	// reason anyone knew.
	//
	// **The refusal is a route, never the network.** `route.abort()` is what a dropped connection
	// looks like to `fetch`, and it holds on a machine with working wifi and inside the default-deny
	// fence.
	// ═════════════════════════════════════════════════════════════════════════════════════════════

	/** Tiles this Layer's renderer holds — the Map Image's equivalent of a rendered feature. */
	const cachedTiles = (page: Page): Promise<number> =>
		page.evaluate(
			(id) =>
				(window.ballastellaReaderMap?.warped[id]?.renderer?.tileCache?.getCachedTiles?.() ?? [])
					.length,
			MAP_LAYER_ID
		);

	const mapLayerVisible = (page: Page): Locator => layerVisible(page, MAP_LAYER_ID);

	/**
	 * Hide the Map Image and show it again — the gesture that makes its tiles be fetched afresh.
	 *
	 * ⚠ **A viewport change is not a lever here, and that is measured rather than assumed.** The first
	 * attempt at this test zoomed a level and counted the requests the route intercepted: **zero**.
	 * This fixture pyramid is nine tiles over a 700 × 500 sheet, so the first load fetches every cell
	 * of every scale factor and nothing later needs anything. `@allmaps/render` fetches strictly on
	 * demand, so a page left alone after a refusal starts asks for nothing at all.
	 *
	 * Hiding a Layer and showing it again rebuilds the stack (`ReaderMapPane`'s `stackStructure`
	 * effect), which builds a new `WarpedMapLayer` with a new renderer and an empty tile cache — so
	 * the tiles are genuinely fetched again, over the same page, with no navigation. It is also a
	 * gesture a Reader actually makes, and it is the shape SPEC story 22 describes.
	 */
	const redrawMapLayer = async (page: Page): Promise<void> => {
		await mapLayerVisible(page).uncheck();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		await mapLayerVisible(page).check();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2', {
			timeout: 60_000
		});
	};

	/**
	 * Refuse every other request for this Map Image's bytes, leaving its `info.json` alone.
	 *
	 * **Every other one, deliberately.** Refusing them all would leave the renderer's cache empty, and
	 * "the tiles that arrived are still drawn" would then be a claim with no subject — the assertion
	 * would pass over a blank map. Alternating produces the state the contract is actually about: some
	 * cells on screen, some refused, and one sentence over the top of it. It also drives the harder
	 * half of the withdrawal rule, since successes and failures interleave inside one burst.
	 *
	 * The `info.json` is answered because without it there is no map at all — that is the
	 * `file-missing` row, which belongs to the unit seam where a status can be invented.
	 */
	const refuseEveryOtherTile = async (page: Page): Promise<void> => {
		let seen = 0;
		await page.route(TILE_ROUTE, (route) => {
			if (route.request().url().endsWith('.json')) return route.continue();
			seen += 1;
			return seen % 2 === 0 ? route.continue() : route.abort();
		});
	};

	const askForMoreTiles = async (page: Page, delta: number): Promise<void> => {
		await page.evaluate((by) => {
			const handle = window.ballastellaReaderMap!;
			handle.map.jumpTo({
				center: [handle.map.getCenter().lng, handle.map.getCenter().lat],
				zoom: handle.map.getZoom() + by
			});
		}, delta);
	};

	/**
	 * Whether `locator` is still on screen after long enough for a withdrawal to have happened.
	 *
	 * A bounded wait rather than an instant `toHaveCount(1)`, because the claim is about an *absence
	 * of change over time*: the notice is **not** withdrawn, as against not having been withdrawn yet.
	 *
	 * ⚠ **8 s is chosen against a measurement, not picked.** The withdrawal this is asserting the
	 * absence of is the same one `takes the notice down by itself when the map's own record answers
	 * again` asserts the presence of, and that one clears inside a second. And the negative has a
	 * positive control **in its own test**: a few lines later the same locator does reach count 0, so
	 * "it stayed" cannot be a locator that could never have cleared.
	 */
	const stillThereAfter = async (locator: Locator): Promise<boolean> =>
		locator
			.waitFor({ state: 'detached', timeout: 8_000 })
			.then(() => false)
			.catch(() => true);

	const TILE_ROUTE = `**/images/${IMAGE_ID}/**`;

	test('tells a Reader when a Map Image’s tiles stop arriving, and keeps what arrived', async ({
		page
	}) => {
		site = await published(oneProject());
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		// ── The map is drawing before anything is taken away ────────────────────────────────────────
		// Load-bearing rather than tidy. Every assertion below is about a failure met **mid-session**,
		// with the page already up — the case a Reader meets when their train enters a tunnel — and one
		// driven before anything had drawn would be a different failure making a different claim.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2', {
			timeout: 60_000
		});
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);
		// **The notice is asserted absent first**, so that its appearance below is this signal acting
		// rather than a page that renders it always. A warning that is always on is unreadable.
		await expect(page.getByTestId('map-image-tiles-unavailable')).toHaveCount(0);

		// ── The tiles stop arriving ─────────────────────────────────────────────────────────────────
		await refuseEveryOtherTile(page);
		await redrawMapLayer(page);

		const notice = page.getByTestId('map-image-tiles-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });

		// Announced, and by the mechanism this repository settled on: `role="alert"` rather than a live
		// region, because the element is *inserted* when its text first exists and an `aria-live` region
		// is announced on a text **change** rather than on insertion — a live region here is a notice a
		// screen-reader user never hears.
		await expect(notice).toHaveAttribute('role', 'alert');

		// Visible text and not a tooltip (SPEC story 33, ADR-0016), and **the whole sentence**, built in
		// `support/tile-failure-notice.ts` rather than written out here: that is what makes "the editor
		// and the viewer say the same thing about the same failure" (SPEC story 19) a contract instead
		// of an intention, and what makes a reword in core turn this red. One assertion, because any
		// fragment of it would be a substring of the string already pinned exactly and so could never
		// fail on its own.
		//
		// ⚠ **The host is the site's own, and it is named rather than called "this site".** The store's
		// `resolve` builds an absolute URL, so `SiteFileUnreachableError` carries a real host even for
		// the site the Reader is already on — and naming it is the honest sentence: it is the server
		// that holds the tiles, and it is the one that stopped answering. The `this site` wording is
		// what the other rows use when there is no host to name (a missing file, or a Workspace in the
		// browser's own storage), and `tile-failure.test.ts` drives both.
		await expect(notice.locator('p')).toHaveText(
			tilesUnavailableNotice('Blaeu’s plan of 1625', new URL(served.url).host)
		);

		// ── What arrived is still drawn ─────────────────────────────────────────────────────────────
		// A fix that blanked the map on error would satisfy every assertion above. So the tiles that did
		// arrive are asserted **in the renderer's cache** — the Map Image's equivalent of a
		// rendered feature, since `queryRenderedFeatures()` returns nothing for a custom WebGL layer —
		// rather than by `data-drawn`, which is the page's own count of itself.
		// Polled rather than read once: the notice goes up on the *first* refusal, and the cells that do
		// arrive in the same burst are still decoding at that moment. Reading the cache immediately
		// gives zero and says nothing about whether they survive.
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);
		// **And the notice is still up over them**, which is the actual claim — tiles that arrived are
		// drawn *while the message is on screen*, rather than the message having quietly gone.
		await expect(notice).toBeVisible();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		// And the page still works: one unreachable image does not take the Project screen down.
		await expect(page.getByTestId('fit-to-project')).toBeVisible();
		// The Reader's Annotations are drawn too, which is what the sentence promises them.
		//
		// ⚠ **Polled, because an Annotation Layer is a symbol layer and `queryRenderedFeatures` answers
		// about placement rather than about the style.** `redrawMapLayer` rebuilds the whole stack, so
		// this layer has just been re-added; it is present in `getStyle().layers` immediately and
		// answers no query until the frame that places its symbols. Read once, this asks whether that
		// frame happened to have run yet — which is a question about the rasteriser's speed, and one
		// the software rasteriser answers "yes" to only because it is slow enough to have got there.
		await expect
			.poll(
				() =>
					page.evaluate(
						() =>
							(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).filter((feature) =>
								feature.layer.id.startsWith('ballastella-layer-')
							).length
					),
				{ timeout: 60_000 }
			)
			.toBeGreaterThan(0);

		// ── A refused cell is NOT re-asked for, and the notice says so rather than waiting ──────────
		// **Measured, and it is why the sentence above says what it says.** With the route lifted the
		// tiles are fetchable again — and the renderer never asks. `askForMoreTiles` is a whole zoom
		// level and does not shift it either, because the failed cell is already in the tile cache. So
		// the notice stays, correctly: those bytes really are missing from the map.
		//
		// The wait is bounded, and it has a positive control a few lines down: the same locator does
		// reach count 0 once the Layer is redrawn, so "it stayed" is not a locator that could never
		// have cleared.
		await page.unroute(TILE_ROUTE);
		await askForMoreTiles(page, 1);
		expect(
			await stillThereAfter(notice),
			'a refused tile cell is not re-requested, so its notice stays'
		).toBe(true);

		// ── …and it withdraws itself the moment those cells do arrive ───────────────────────────────
		// SPEC story 17, driven as error → recovery, with the notice asserted visible above so this
		// cannot pass by never having raised it. The gesture is the one the sentence names.
		await redrawMapLayer(page);
		await expect(notice).toHaveCount(0, { timeout: 45_000 });
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);

		// ── And nothing was thrown, on any of it ────────────────────────────────────────────────────
		// The whole point of the ticket. This is the assertion the escaping rejection used to fail, and
		// it now covers a refusal driven deliberately rather than one that happened to race.
		expect(seen.failures).toEqual([]);
	});

	test('tells a server that is failing apart from a connection that is gone', async ({ page }) => {
		// **The other remedy, and the path the original defect was actually on.** A refused `info.json`
		// is what `@allmaps/render`'s `loadImage` asks for, and its rejection is what used to arrive as
		// an uncaught `pageerror`. Here it is driven deliberately — a status rather than a race — and
		// the Reader is told something *different* from the aborted case above, because the remedies
		// are opposites: a server that answered proves the connection works, and sending that Reader to
		// check their wifi is sending them to fix a thing that is not broken.
		site = await published(oneProject());
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2', {
			timeout: 60_000
		});
		await expect(page.getByTestId('map-image-tiles-unavailable')).toHaveCount(0);

		await page.route(`**/images/${IMAGE_ID}/info.json`, (route) =>
			route.fulfill({ status: 503, body: 'the site is having a bad afternoon' })
		);
		await redrawMapLayer(page);

		const notice = page.getByTestId('map-image-tiles-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice.locator('p')).toHaveText(
			tilesServerErrorNotice('Blaeu’s plan of 1625', new URL(served.url).host, 503)
		);
		// The rest of the site is unharmed, which is what the sentence promises: the Annotation Layer is
		// listed, drawn, and clickable, and the controls still work.
		await expect(layerStack(page)).toContainText('Warehouses');
		// Polled for the same reason as its twin in the test above: the stack was rebuilt a moment ago
		// and this symbol layer answers no query until the frame that places its symbols.
		await expect
			.poll(
				() =>
					page.evaluate(
						() =>
							(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).filter((feature) =>
								feature.layer.id.startsWith('ballastella-layer-')
							).length
					),
				{ timeout: 60_000 }
			)
			.toBeGreaterThan(0);

		// And nothing was thrown. **This is the assertion the patch to `@allmaps/render` exists for**:
		// core's shim answers the refusal with a `Response`, `@allmaps/stdlib`'s `fetchUrl` throws its
		// own error for any non-ok answer, and `WebGL2Renderer.render` used to drop the promise that
		// carried it. Revert either half and this goes red.
		//
		// ⚠ **This is the deterministic guard on the patch, and the offline test above is not.** With
		// the hunk reverted this test failed 4 of 4; the offline test failed 1 of 8, because its own
		// refusal is a race. A green run with one retried offline test is exactly what a reverted patch
		// looks like, so the retry budget is not the instrument here — this test is.
		expect(seen.failures).toEqual([]);
	});

	test('takes the notice down by itself when the map’s own record answers again', async ({
		page
	}) => {
		// ═══════════════════════════════════════════════════════════════════════════════════════════
		// SPEC STORY 17, AND THE HALF THAT REALLY DOES HEAL WITH NO GESTURE AT ALL
		//
		// ⚠ **The two shapes of this failure recover differently, and the difference is measured here
		// and in the test above rather than reasoned about.** A refused `info.json` is re-asked for on
		// every frame — `WebGL2Renderer.render` calls `loadMissingImagesInViewport()` unconditionally —
		// so the moment the site answers, the map heals and this notice goes, with the Reader doing
		// nothing whatever. A refused tile **cell** is never re-asked, not even after a zoom.
		//
		// Both tests exist because the earlier single test drove recovery through a Layer redraw, which
		// rebuilds the renderer with an empty cache and therefore makes **both** shapes recover. It
		// passed either way and the asymmetry was invisible to it — while the sentence on screen
		// promised every Reader that the map "finishes drawing on its own".
		// ═══════════════════════════════════════════════════════════════════════════════════════════
		site = await published(oneProject());
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2', {
			timeout: 60_000
		});
		const notice = page.getByTestId('map-image-tiles-unavailable');
		await expect(notice).toHaveCount(0);

		const INFO_ROUTE = `**/images/${IMAGE_ID}/info.json`;
		await page.route(INFO_ROUTE, (route) => route.abort());
		await redrawMapLayer(page);
		// Asserted **visible first**, so the disappearance below is this signal acting rather than a
		// notice that was never raised.
		await expect(notice).toBeVisible({ timeout: 45_000 });

		// ── No gesture. None. ───────────────────────────────────────────────────────────────────────
		// The route is lifted and nothing else happens: no click, no zoom, no redraw. This is the one
		// place in the suite where the Reader does nothing and the interface is still expected to
		// correct itself, which is exactly what story 17 asks for.
		await page.unroute(INFO_ROUTE);
		await expect(notice).toHaveCount(0, { timeout: 45_000 });
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);

		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// The phone, and the keyboard
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Reader on a phone', () => {
	// SPEC story 84, and the one surface in this epic with a genuine mobile requirement: authoring is
	// desktop-only and settled (ADR-0014), but a published site is what a scholar shows colleagues and
	// what most people will ever see. A desktop-only run would pass while the phone experience stayed
	// broken, so the viewport here is real.
	test.use({ viewport: { width: 375, height: 667 } });

	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	test('never scrolls sideways, and every Reader control is reachable and usable', async ({
		page
	}) => {
		site = await published(oneProject());
		const seen = watch(page);

		for (const where of ['', '?p=amsterdam-1625'] as const) {
			await page.goto(site.sites[0]!.url + where);
			if (where === '') {
				// The Front Page's own heading and its list, at the width most Readers arrive at.
				await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
				await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');
			} else {
				await mapReady(page);
			}

			// No horizontal page scroll. Measured on the document rather than eyeballed: a fixed-width
			// control or an unbroken string is what produces one, and both are easy to add by accident.
			expect(
				await page.evaluate(() => ({
					scrollWidth: document.documentElement.scrollWidth,
					clientWidth: document.documentElement.clientWidth
				})),
				`horizontal scroll at ${where || 'the hub'}`
			).toEqual(
				await page.evaluate(() => ({
					scrollWidth: document.documentElement.clientWidth,
					clientWidth: document.documentElement.clientWidth
				}))
			);
		}

		// The controls are operable at this width, not merely present.
		await page.getByTestId('base-map-switcher').selectOption('muted');
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('muted');
		await layerVisible(page, MAP_LAYER_ID).uncheck();
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await card.getByTestId('layer-opacity').fill('0.5');
		await expect(card.getByTestId('layer-opacity-value')).toHaveText('50%');

		// **And nothing a Reader could edit, at the width most Readers arrive at** — the same sweep the
		// desktop run makes, because a control the desktop layout withholds and a narrow one restores
		// would be exactly the kind of thing a desktop-only suite never sees. The card is open, which is
		// where those controls would be.
		await expectNothingEditable(page);
		expect(seen.failures).toEqual([]);
	});

	/**
	 * The bar folds, and the return links read well at 375 px (SPEC stories 6 and 84).
	 *
	 * ⚠ **What must survive the fold is named, not counted.** A Reader on a phone keeps the way home
	 * and the Project's own name; everything else goes behind one menu, and nothing that goes there
	 * may become unreachable — which is why the menu is opened *from the keyboard* here rather than
	 * clicked.
	 *
	 * A link is also where a long unbroken string usually gets onto a page, and these carry an
	 * absolute URL — so the other failure to look for is a page that scrolls sideways on the width
	 * most Readers arrive at.
	 */
	test('the links back to the editor are readable and do not widen the page', async ({ page }) => {
		site = await published(publishedByEditor());
		const seen = watch(page);

		for (const where of ['', '?p=amsterdam-1625'] as const) {
			await page.goto(site.sites[0]!.url + where);

			const bar = page.getByTestId('navigation-bar');
			// The two things a Reader needs are never the two things that were dropped.
			await expect(bar.getByTestId('site-name')).toBeVisible();
			if (where !== '') {
				await expect(bar.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
			}

			// Everything else is behind one menu — including the theme control, which is the shell's
			// rather than this app's and folds with the rest.
			const menu = bar.getByTestId('bar-menu');
			await expect(menu).toBeVisible();
			await expect(bar.getByRole('link', { name: /in Ballastella$/ })).toBeHidden();

			await menu.focus();
			await page.keyboard.press('Enter');
			await expect(menu).toHaveAttribute('aria-expanded', 'true');
			await expect(bar.getByTestId('theme-toggle')).toBeVisible();
			await expect(bar.getByTestId('all-projects')).toBeVisible();

			const link = bar.getByRole('link', { name: /in Ballastella$/ });
			await expect(link).toBeVisible();
			const box = (await link.boundingBox())!;
			expect(box.width, `link width at ${where || 'the Front Page'}`).toBeLessThanOrEqual(375);
			expect(box.x, `link off screen at ${where || 'the Front Page'}`).toBeGreaterThanOrEqual(-1);

			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
				`horizontal scroll at ${where || 'the Front Page'}`
			).toBe(await page.evaluate(() => document.documentElement.clientWidth));
		}

		expect(seen.failures).toEqual([]);
	});

	test('tapping an Annotation reads it in a sheet at the bottom of the map, with the same subtraction and no leader', async ({
		page
	}) => {
		// **The phone is why the popup retired** (ticket 07). A 375 px screen has no room for a bubble
		// over the pin *and* the words in it — so a tap that opened a popup put the Annotation in one
		// place and the row that names it in another. One destination, and it is the Inspector docked
		// over the pane the tap landed on (ADR-0035).
		//
		// ⚠ **Fifteen Annotations, and the tapped one is the last of them.** The fillers are what make
		// "the tapped row is the one that got selected" falsifiable at all: with one Annotation in the
		// fixture, the first row in the DOM is the tapped row whether the click wiring works or not.
		// They share a coordinate inside the sheet's own extent — far enough from the tapped pin in
		// screen pixels that they cannot take its click, close enough that they do not widen the
		// opening view and move it.
		//
		// **Nothing scrolls a row into view here, and nothing needs to** (ADR-0035's "What is given
		// up"). A row opens nothing inside itself, so it cannot push its own header off the top of the
		// column — what a tap shows is the Inspector, which arrives over the pane the Reader is already
		// looking at. The phone *layout* of that panel is ticket 09's.
		site = await published(
			await oneProject({
				annotations: [
					...Array.from({ length: 14 }, (_, index) =>
						annotation({
							id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
							title: `A warehouse on the west quay, number ${index + 1}`,
							coordinates: [4.885, 52.361]
						})
					),
					annotation({
						title: 'The east warehouse',
						// Long enough that the sheet stands at its cap, which is the only state in which "the
						// body scrolls inside it" and "it does not cover the attribution" can fail.
						description: `Rebuilt in **1663** after the fire, and rebuilt again a century later.\n\n${Array.from(
							{ length: 20 },
							(_, at) => `Paragraph ${at + 1}: the quay, the warehouses, and the survey of 1625.`
						).join('\n\n')}`
					})
				]
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		const reading = await openAnnotationFromMap(page);

		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('The east warehouse');
		await expect(reading).toContainText('Rebuilt in 1663');
		await expect(reading.locator('strong')).toHaveText('1663');

		// **The row that was tapped, addressed by the Annotation it names.** The first row in the DOM is
		// a different Annotation here, and asking for it would be asking about a row nobody touched.
		const tapped = page.locator('[data-testid="annotation-row"][aria-expanded="true"]');
		await expect(tapped).toHaveAttribute('data-annotation-id', TAPPED_ANNOTATION_ID);
		// And exactly one row is selected: fifteen rows and one answer to which Annotation is active.
		await expect(tapped).toHaveCount(1);

		// **Nothing opened inside the row** (the-annotation-inspector stories 10, 69), which is what
		// keeps the list the same length however much any one Annotation has to say — and is why the
		// fourteen rows above the tapped one do not move when it is tapped.
		expect(
			await tapped.evaluate((row) => row.closest('li')!.children.length),
			'the selected row opened something inside itself'
		).toBe(1);

		// And the panel is inside the viewport horizontally, which is what "readable" means at 375 px.
		const sheet = (await page.getByTestId('annotation-inspector').boundingBox())!;
		expect(sheet.width).toBeLessThanOrEqual(375);
		expect(sheet.x).toBeGreaterThanOrEqual(-1);

		// ── AND IT IS A SHEET ACROSS THE BOTTOM OF THE PANE ─────────────────────────────────
		//
		// The-annotation-inspector story 61.
		//
		// The same `AnnotationInspector` the desktop docks to the top-right, positioned differently by
		// the page that renders it — there is no `variant` and no `asSheet`, so what changes at this
		// width is a class list and nothing about the component.
		const pane = page.getByTestId('reader-map-pane');
		const paneBox = (await pane.boundingBox())!;
		expect(sheet.x, 'the sheet does not reach the pane’s left edge').toBeLessThan(paneBox.x + 16);
		expect(sheet.x + sheet.width, 'the sheet does not reach the pane’s right edge').toBeGreaterThan(
			paneBox.x + paneBox.width - 16
		);
		// **8 rem, because the sheet's bottom inset is the pane's bottom furniture** — 6.25 rem of it, to
		// clear MapLibre's bottom-left control block and the attribution, both asserted below. Anchored to
		// the bottom is still what this fails for: a sheet docked to the top or centred in the pane at this
		// cap ends more than 8 rem short of the bottom edge.
		expect(
			sheet.y + sheet.height,
			'the sheet is not anchored to the bottom of the pane'
		).toBeGreaterThan(paneBox.y + paneBox.height - 128);
		// And the map is still the map above it, which is what stops the sheet being a second screen.
		expect(sheet.y, 'the sheet took the whole pane').toBeGreaterThan(paneBox.y + 24);

		// **The attribution is a licence condition** (ODbL) and the sheet is across the axis it sits on,
		// which is the whole reason the bottom inset exists.
		const attribution = page.locator('.maplibregl-ctrl-attrib');
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
		// the bottom-left *precisely* so that it could never be under the Inspector. Measured on this
		// published site at 375 px with a 2 rem inset: the zoom-in button 100% overlapped, and
		// `elementFromPoint` at its centre answering with a paragraph of the description.
		//
		// **`elementFromPoint` at the button's centre is the assertion that can actually fail**, because
		// what the story is about is whether the button can be pressed. The overlap is asserted beside it so
		// that a sheet clearing the centre and covering the corners cannot pass, and the button is then
		// really pressed and the zoom really read.
		// ⚠ **Scrolled to first, because `elementFromPoint` is viewport arithmetic.** At 375 px the pane's
		// bottom edge is below the fold, and a point below the window answers `null` — which would fail this
		// whether the sheet covered the button or not.
		await page.locator('.maplibregl-ctrl-zoom-in').scrollIntoViewIfNeeded();
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
		const zoomedTo = () => page.evaluate(() => window.ballastellaReaderMap!.map.getZoom());
		const beforeZooming = await zoomedTo();
		await page.locator('.maplibregl-ctrl-zoom-in').click();
		await expect.poll(zoomedTo, 'the zoom control did not zoom').toBeGreaterThan(beforeZooming);

		// **And the prose is read inside it rather than growing it**, with the identity header holding
		// its place: a sheet that scrolled as a whole would take the one thing naming the Annotation off
		// the top of itself. Scrolled by the wheel over the sheet, which is what gives that teeth.
		//
		// ⚠ **A short wheel.** At this width the map is below the fold and the page itself scrolls, so a
		// wheel longer than the face has left to give would chain out of the sheet and move the whole
		// page — taking the header with it, and failing the second half of this for a reason that is not
		// the sheet's.
		expect(
			await reading.evaluate((element) => ({
				scrolls: element.scrollHeight > element.clientHeight,
				overflow: getComputedStyle(element).overflowY
			})),
			'the description is not scrolling inside the sheet'
		).toEqual({ scrolls: true, overflow: 'auto' });
		//
		// ⚠ **The header is measured against the sheet rather than against the window.** At this width
		// everything is inside a page that scrolls and that a live region can lengthen, so a header
		// measured against the viewport moves for reasons that have nothing to do with what the sheet
		// did. What the claim is about is the header holding its place *in the sheet*: a sheet that
		// scrolled as a whole would take it up past its own top edge, and this goes negative when it
		// does.
		const headerOffset = () =>
			page
				.getByTestId('annotation-inspector')
				.evaluate((element) =>
					Math.round(
						element
							.querySelector('[data-testid="annotation-inspector-header"]')!
							.getBoundingClientRect().top - element.getBoundingClientRect().top
					)
				);
		//
		// ⚠ **The header assertion below corroborates rather than falsifies on its own.** Every mutation
		// that makes the sheet scroll as a whole instead of the description scrolling inside it trips the
		// two-value check above first, because the description then has nothing to scroll. It is kept because
		// it is the claim in the terms a Reader meets it in — the Annotation's name stays on the screen while
		// the prose moves — and it is what would notice a future sheet that scrolled itself.
		await reading.hover();
		const restingHeader = await headerOffset();
		await page.mouse.wheel(0, 120);
		await expect.poll(() => reading.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		expect(await headerOffset(), 'the sheet scrolled its own header away').toBe(restingHeader);

		// ── AND THE SUBTRACTION IS UNCHANGED ON A PHONE ─────────────────────────────────────
		//
		// The-annotation-inspector story 63.
		//
		// ⚠ **Not a phone branch restating it.** This app passes no `style` snippet and no callbacks at
		// any width, so the strip and the two controls are absent here for the one reason they are
		// absent on a desktop. If a narrow layout ever had to say any of this again, the design would
		// have been abandoned — which is what these four counts would fail to notice and
		// `expectNothingEditable` would.
		await expect(page.getByTestId('annotation-inspector-tabs')).toHaveCount(0);
		await expect(page.getByTestId('annotation-inspector-tab-style')).toHaveCount(0);
		await expect(page.getByTestId('annotation-edit-text')).toHaveCount(0);
		await expect(page.getByTestId('annotation-delete')).toHaveCount(0);
		// The stack too, with the Annotation Layer's card open, which is where a drag handle, a rename,
		// a reorder and a Layer delete would be.
		await expectNothingEditable(page);

		// ── AND NO LEADER IS DRAWN, BECAUSE `leaderPath` REFUSED ────────────────────────────
		//
		// The-annotation-inspector story 62.
		//
		// ⚠ **Not "the line is invisible".** A media query hiding the element would satisfy any
		// assertion about what can be seen; the contract asks that the *function* declines, so the
		// polyline carries no `points` at all. The layer is asserted still rendered and still displayed,
		// which is what stops this passing for the wrong reason.
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
		expect(await leaderPoints(page)).toBeNull();
		expect(
			await leaderLayer(page).evaluate((element) => ({
				points: element.querySelector('polyline')!.getAttribute('points'),
				display: getComputedStyle(element).display
			})),
			'the leader was hidden by CSS rather than refused by leaderPath'
		).toEqual({ points: null, display: 'block' });

		// ── AND THE WIDTH AT WHICH THIS BEGINS IS THE EDITOR'S ──────────────────────────────
		//
		// One pixel apart, so this fails for the breakpoint moving rather than for a phone being narrow.
		// `e2e/editor-annotations.e2e.ts` makes the same two measurements against the built editor and
		// its own copy of the number; the two independent runs are the whole of "the same viewport width
		// that stacks one stacks the other".
		// The stack's own live region stands in for the column it is in: the column itself carries no
		// testid, and what is being measured is whether the stack's horizontal range and the map's
		// overlap — which is `leaderPath`'s own test, and which a full-width child answers as its parent
		// does.
		const columnsOverlap = async (): Promise<boolean> => {
			const column = (await page.getByTestId('layer-view-status').boundingBox())!;
			const map = (await pane.boundingBox())!;
			return column.x < map.x + map.width && map.x < column.x + column.width;
		};
		await page.setViewportSize({ width: STACKS_BELOW, height: 900 });
		await expect.poll(columnsOverlap, 'two columns at the breakpoint').toBe(false);
		await page.setViewportSize({ width: STACKS_BELOW - 1, height: 900 });
		await expect.poll(columnsOverlap, 'still two columns one pixel below it').toBe(true);

		expect(seen.failures).toEqual([]);
	});
});

test.describe('a Reader using a keyboard', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	test('reaches and operates every control by tabbing, and hears what changed', async ({
		page
	}) => {
		// SPEC stories 95 and 96. Reached by tabbing rather than by locating and clicking, because a
		// control that a locator can click is not necessarily one a keyboard can get to.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		/** Tab until `locator` has focus, or give up after a sane number of stops. */
		const tabTo = async (locator: Locator, from?: Locator): Promise<void> => {
			await (from ?? page.getByTestId('all-projects')).focus();
			for (let stop = 0; stop < 40; stop += 1) {
				await page.keyboard.press('Tab');
				if (await locator.evaluate((element) => element === document.activeElement)) return;
			}
			throw new Error(`could not reach ${await locator.evaluate((element) => element.outerHTML)}`);
		};

		await tabTo(page.getByTestId('base-map-switcher'));
		await tabTo(layerVisible(page, ANNOTATION_LAYER_ID));
		// Space toggles a checkbox — the platform's own behaviour, which is the whole reason ADR-0016
		// mandates a native one.
		await page.keyboard.press('Space');
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		// A live region, so the change is announced rather than only drawn.
		expect(
			await page
				.getByTestId('layer-view-status')
				.evaluate((element) => [
					element.getAttribute('aria-live'),
					element.getAttribute('aria-atomic')
				])
		).toEqual(['polite', 'true']);
		await page.keyboard.press('Space');
		await expect(page.getByTestId('layer-view-status')).toContainText('shown');

		// The way into a Layer's contents is a plain `<button>` with `aria-expanded`, so the disclosure
		// is reached and operated with nothing to learn (SPEC stories 66 and 67).
		const disclosure = layerRow(page, MAP_LAYER_ID).getByTestId('layer-disclosure');
		await tabTo(disclosure);
		await page.keyboard.press('Enter');
		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

		// The opacity range, moved by arrow key, inside the card that has just been opened.
		const opacity = page.getByTestId('layer-opacity');
		await tabTo(opacity, disclosure);
		const before = await opacity.inputValue();
		await page.keyboard.press('ArrowLeft');
		expect(await opacity.inputValue()).not.toBe(before);
		await expect(page.getByTestId('layer-view-status')).toContainText('%');

		// And the way into reading a Map Image on its own is a real control the keyboard can activate.
		// Asserted on the *navigation* rather than on the viewer, because this Project is unstamped and
		// therefore takes the refusal branch — which is its own test. What is under test here is that a
		// keyboard reaches the control and Enter acts on it.
		await tabTo(page.getByTestId('read-as-document'), opacity);
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(new RegExp(`unwarped=${MAP_LAYER_ID}`));
		await expect(page.getByTestId('back-to-project')).toBeVisible();
		expect(seen.failures).toEqual([]);
	});

	test('opens the Annotation at the centre of the map with Enter, and closes it with Escape', async ({
		page
	}) => {
		// The keyboard route to an Annotation. MapLibre already pans with the arrow keys and zooms
		// with `+`/`-`, so "move the map to it, then press Enter" is a whole path with nothing new to
		// learn — and without it selecting an Annotation from the canvas would be pointer-only.
		site = await published(
			await oneProject({
				annotations: [annotation({ title: 'The east warehouse', description: 'Rebuilt in 1663.' })]
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		// Enter reports the **centre of the map**, so the Annotation has to be there. Centred through
		// MapLibre rather than with the arrow keys, because what is under test is the keyboard path from a
		// focused canvas — arrow-key panning would be testing MapLibre's own key handling instead.
		await page.evaluate(
			(lngLat) => window.ballastellaReaderMap!.map.jumpTo({ center: lngLat }),
			ANNOTATION_AT
		);
		await page.getByTestId('reader-map-pane').locator('canvas').focus();
		const row = page.getByTestId('annotation-row').first();
		await expect
			.poll(
				async () => {
					await page.keyboard.press('Enter');
					return page.locator('[data-testid="annotation-row"][aria-expanded="true"]').count();
				},
				{ timeout: 30_000, intervals: [250, 500, 1000] }
			)
			.toBeGreaterThan(0);
		await expect(page.getByTestId('annotation-inspector-face')).toContainText('Rebuilt in 1663');

		// ── AND DISMISSING IT LEAVES THE KEYBOARD IN THE LIST ────────────────────────────────
		//
		// The control that was pressed is inside the panel that is leaving, so without the page putting
		// the keyboard back the way on is Tab from the top of the document, past MapLibre's own
		// controls. Polled rather than read once: the panel leaves over 220 ms and the pressed button is
		// still `document.activeElement` one microtask after the selection is cleared, so a single read
		// lands on the outgoing control and would pass whatever the page did.
		//
		// Folded into this test rather than given one of its own because the Seam 2 budget is spent
		// (`scripts/check-seam-2-size.mjs`), and this test already has the Inspector open on a real
		// published build.
		await page.getByTestId('annotation-inspector-close').click();
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect
			.poll(() => row.evaluate((element) => element === document.activeElement))
			.toBe(true);

		// And Escape deselects from anywhere on the page. It is the whole of what Escape does on this
		// screen — there is nothing else on it a Reader can put away — so the key that dismissed the
		// popup dismisses its replacement. Selected again from the row the keyboard has just been
		// handed, which is the gesture a Reader who dismissed by mistake actually makes.
		await page.keyboard.press('Enter');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await page.keyboard.press('Escape');
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByTestId('annotation-inspector')).toHaveCount(0);
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// THE OPENING VIEW (ticket 09, ADR-0026)
//
// ADR-0026 names the Published Site as **the half most likely to be forgotten**: ticket 17 is already
// merged, so nothing would fail if the viewer went on opening on the deployment's default while the
// editor opened on the author's work. The Reader is the one person who could not tell.
//
// So these assert the same numbers `e2e/editor-opening-view.e2e.ts` asserts, from the same content,
// through the same `projectOpeningBounds` in `@ballastella/core`: a Project whose stack is three pins
// around Boston Common opens on Boston, four thousand miles from where this deployment's catalog would
// otherwise put it.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** The same three pins the editor suite frames on, and the same centre. */
const BOSTON_PINS: readonly [number, number][] = [
	[-71.0912, 42.3601],
	[-71.0656, 42.3554],
	[-71.0402, 42.3522]
];
const BOSTON_CENTRE = { lng: -71.0657, lat: 42.35615 };
/** The deployment default, which is what a Project with nothing on the earth must open on. */
const DEPLOYMENT_VIEW = { lng: 4.9041, lat: 52.3676, zoom: 13 };

/**
 * The fixture sheet moved to Boston, for the one test that is about a *map* Layer's place on the earth.
 *
 * The Control Points cover pixels 70 → 630 of a 700-wide sheet and 50 → 450 of a 500-tall one, so the
 * Resource Mask extends an eighth of the point span past each edge: −71.1075 → −71.0325 by
 * 42.33625 → 42.37375. That overshoot is the Resource-Mask-versus-Control-Points distinction, asserted
 * numerically in `packages/core/src/project/opening-view.test.ts`.
 */
const BOSTON_SHEET = { west: -71.1, east: -71.04, south: 42.34, north: 42.37 };
const BOSTON_SHEET_CENTRE = { lng: -71.07, lat: 42.355 };

/**
 * A Project whose whole stack is one Annotation Layer of pins, wherever the test wants them.
 *
 * **The Layer is present even when there are no pins**, which is what makes "nothing on the earth"
 * assertable at all: the Reader's map handle is published by `drawLayerStack`, so a Project with an
 * empty `layers` array never builds a stack and never exposes a map to ask where it is looking. An
 * Annotation Layer with no Annotations in it is the ordinary shape of that case anyway — an author
 * who has made a Layer and not yet drawn in it.
 */
function pinnedProject(pins: readonly [number, number][]): SiteFiles {
	return oneProject({
		annotations: pins.map((coordinates, index) =>
			annotation({ id: `1111111${index}-1111-4111-8111-111111111111`, coordinates })
		),
		// The stack replaced outright, so the Amsterdam Map Image the fixture also carries cannot
		// stretch the box across the Atlantic and make "it framed on Boston" unassertable.
		projectOverrides: {
			layers: [
				{
					kind: 'annotation',
					id: ANNOTATION_LAYER_ID,
					name: 'Pins',
					visible: true,
					order: 0,
					geojsonRef: `annotations/${ANNOTATION_LAYER_ID}.geojson`,
					defaultStyle: {}
				}
			]
		}
	});
}

/** Wait until the page has settled its opening view, so the map is not sampled mid-fit. */
async function openingSettled(page: Page): Promise<void> {
	await expect(page.getByTestId('opening-view')).toHaveAttribute(
		'data-opening-view',
		/^(content|default)$/,
		{ timeout: 30_000 }
	);
}

const readerViewport = (page: Page) =>
	page.evaluate(() => ({
		lng: window.ballastellaReaderMap!.map.getCenter().lng,
		lat: window.ballastellaReaderMap!.map.getCenter().lat,
		zoom: window.ballastellaReaderMap!.map.getZoom()
	}));

const readerShowing = (page: Page, pins: readonly [number, number][]) =>
	page.evaluate(
		(points) =>
			points.every((point) => window.ballastellaReaderMap!.map.getBounds().contains(point)),
		pins as [number, number][]
	);

test.describe('a Published Site opens on the Project’s content', () => {
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	test('frames on the work, at both base paths, exactly as the editor frames it', async ({
		page
	}) => {
		site = await published(pinnedProject(BOSTON_PINS));
		const seen = watch(page);

		// Both base paths, because ADR-0006's whole claim is that one build serves a domain root and a
		// subdirectory — and the opening view is computed from documents reached by relative path.
		for (const served of site.sites) {
			await page.goto(served.url + '?p=amsterdam-1625');
			await mapReady(page);
			await openingSettled(page);

			const at = await readerViewport(page);
			expect(at.lng, `at ${served.prefix || '/'}`).toBeCloseTo(BOSTON_CENTRE.lng, 3);
			expect(at.lat, `at ${served.prefix || '/'}`).toBeCloseTo(BOSTON_CENTRE.lat, 3);
			// Not the deployment default, which is the answer a viewer that never adopted the shared
			// function gives — and which looks like a perfectly working map.
			expect(Math.abs(at.lng - DEPLOYMENT_VIEW.lng)).toBeGreaterThan(50);
			expect(await readerShowing(page, BOSTON_PINS)).toBe(true);
		}

		// And says where it is looking, in an announced live region (SPEC story 112).
		await expect(page.getByTestId('opening-view')).toContainText('this Project’s own content');
		expect(seen.failures).toEqual([]);
	});

	test('caps the zoom on a Project whose only content is one pin', async ({ page }) => {
		site = await published(pinnedProject([BOSTON_PINS[1]!]));

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await openingSettled(page);

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_PINS[1]![0], 4);
		expect(at.zoom).toBeLessThanOrEqual(16);
		expect(at.zoom).toBeCloseTo(16, 4);
	});

	test('opens on the deployment default when the Project has nothing on the earth', async ({
		page
	}) => {
		site = await published(pinnedProject([]));

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await openingSettled(page);

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(DEPLOYMENT_VIEW.lng, 4);
		expect(at.lat).toBeCloseTo(DEPLOYMENT_VIEW.lat, 4);
		expect(at.zoom).toBeCloseTo(DEPLOYMENT_VIEW.zoom, 4);
		await expect(page.getByTestId('opening-view')).toContainText('default view');

		// **And what that Layer's card says when a Reader opens it**, folded in here because this is the
		// suite's only Project with an Annotation Layer a Reader can open and find nothing in — the
		// state the shared empty state is *entitled* to describe, having been given a collection that
		// really is empty. The bare fact, in words that are true in both apps; the editor's "Nothing in
		// this Layer yet" is its own guidance now and is swept for by {@link expectNoEditorProse},
		// because on a Published Site nothing will ever be put in this Layer.
		const card = await openLayerRow(page, layerRow(page, ANNOTATION_LAYER_ID));
		await expect(card.getByTestId('annotation-list-empty')).toHaveText(
			'This Layer has no Annotations in it.'
		);
		await expectNothingEditable(page);
	});

	test('frames on a sheet whose Alignment reads, even when its image record does not', async ({
		page
	}) => {
		// The divergence this criterion exists to catch. The editor's `readProjectContent` reads the
		// Alignment and nothing else, so a Layer whose Alignment parses places its sheet there whatever
		// happened to its tiles. The viewer used to contribute a Layer only at `status: 'ready'`, which
		// is a claim about *drawing* — so a Map Image whose library server was down was on the earth
		// in the editor and nowhere at all on the Published Site, and the two apps framed one Project two
		// ways.
		//
		// Set up with the failure ticket 17's degradation table already covers: the `remote.json` that
		// says which server holds the tiles is answered 503. The Alignment beside it is untouched and
		// puts the sheet in Boston, four thousand miles from this deployment's default — so "framed on the
		// work" and "framed on the default" are different answers rather than the same coordinates twice.
		site = await published(
			oneProject({
				imageMode: 'referenced',
				remoteService: 'https://maps.library.example/iiif/x',
				sheetAt: BOSTON_SHEET,
				// No Annotations, so the box can only have come from the sheet. The Layer itself stays, so
				// the stack is built and the Reader's map handle is published.
				annotations: []
			})
		);
		await page.route('**/images/aaa/remote.json', (route) =>
			route.fulfill({ status: 503, body: 'the library is down' })
		);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await openingSettled(page);

		// The Layer is still reported unreadable and still not drawn — this changes what the sheet
		// contributes to the *box*, not what goes on the map.
		await expect(layerRow(page, MAP_LAYER_ID).getByTestId('layer-problem')).toContainText(
			'did not answer'
		);
		expect(
			await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder())
		).not.toContain(`ballastella-layer-${MAP_LAYER_ID}`);

		// And the map is on the sheet's own Resource Mask extent, which for these Control Points over a
		// 700 × 500 sheet is −71.1075 → −71.0325 by 42.33625 → 42.37375.
		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_SHEET_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(BOSTON_SHEET_CENTRE.lat, 3);
		expect(Math.abs(at.lng - DEPLOYMENT_VIEW.lng)).toBeGreaterThan(50);
		await expect(page.getByTestId('opening-view')).toContainText('this Project’s own content');
	});

	test('does not move the map when a Reader hides a Layer, and re-frames when asked', async ({
		page
	}) => {
		site = await published(pinnedProject(BOSTON_PINS));

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await openingSettled(page);

		// Somewhere the content is not, so any refit at all reads as a move.
		const parked = { lng: 2.3522, lat: 48.8566, zoom: 11 };
		await page.evaluate(
			(at) => window.ballastellaReaderMap!.map.jumpTo({ center: [at.lng, at.lat], zoom: at.zoom }),
			parked
		);

		// Hidden, then shown again. The handle is republished by `drawLayerStack`, so it is gone while the
		// only Layer is off — which is why the viewport is read after the Layer comes back rather than
		// in between. What is being asserted is unaffected: a refit on either toggle would have moved the
		// map, and the pane's own map is never rebuilt by a stack rebuild.
		await page.getByTestId('layer-visible').first().uncheck();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');
		await page.getByTestId('layer-visible').first().check();
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(parked.lng, 6);
		expect(at.lat).toBeCloseTo(parked.lat, 6);
		expect(at.zoom).toBeCloseTo(parked.zoom, 6);

		// The explicit control, with words on it, is what covers everything the once-only fit does not.
		await page.getByRole('button', { name: 'Fit project' }).click();
		await expect
			.poll(async () => (await readerViewport(page)).lat)
			.toBeCloseTo(BOSTON_CENTRE.lat, 3);
		expect((await readerViewport(page)).lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
	});
});
