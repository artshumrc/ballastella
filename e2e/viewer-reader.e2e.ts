import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
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
		project(lngLat: [number, number]): { x: number; y: number };
		jumpTo(options: { center: [number, number] }): void;
		fitBounds(bounds: unknown, options?: Record<string, unknown>): void;
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

/** Wait until the Reader's map has built its stack, so assertions are about a drawn map. */
async function mapReady(page: Page): Promise<void> {
	await expect(page.getByTestId('reader-map-pane')).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.ballastellaReaderMap !== undefined), { timeout: 30_000 })
		.toBe(true);
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
 * Open the fixture Annotation's popup, and hand back the popup.
 *
 * The click lands on the Annotation's **projected screen position** rather than on the middle of the
 * pane, and that distinction is why this helper exists: the Base Map catalog's initial centre is
 * deployment configuration a fork may change, so "the middle of the pane" is the Annotation's position
 * only by coincidence. It was off by about 24 px, so the first run of this suite clicked empty geography
 * — a failure that looked like a broken popup.
 *
 * Retried, because the GeoJSON source may not have painted on the first frame: `queryRenderedFeatures`
 * answers about what is *rendered*, so a click one frame early is a genuine miss rather than a defect.
 */
async function openAnnotationPopup(page: Page): Promise<Locator> {
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
				const at = await page.evaluate(
					(lngLat) => window.ballastellaReaderMap!.map.project(lngLat),
					ANNOTATION_AT
				);
				await page.mouse.click(box.x + at.x, box.y + at.y);
				return page.locator('.maplibregl-popup-content').count();
			},
			{ timeout: 30_000, intervals: [250, 500, 1000] }
		)
		.toBeGreaterThan(0);
	return page.locator('.maplibregl-popup-content');
}

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
	 *   1. the **Annotation popup** — `renderAnnotationPopup`: the title HTML-escaped, the description
	 *      through `marked` then DOMPurify, and the assembled document through DOMPurify again;
	 *   2. the **names** — a Project's on the hub and a Layer's in the controls — where safety is
	 *      **Svelte's text interpolation** and DOMPurify is not involved at all.
	 *
	 * Breaking the sanitiser therefore reddens the first and correctly leaves the second green. That
	 * asymmetry was verified by mutation, not assumed: `sanitise` in
	 * `packages/core/src/annotation/markdown.ts` was made to return its input, and the popup tests
	 * below went red while the name test stayed green.
	 *
	 * **There was a third surface and it is deliberately gone.** The hub page used to author its own
	 * blurb as a pseudo-Annotation and `{@html}` it, so that the shared renderer stayed live in the
	 * shipped bundle and a `{@html}` hydrating permanently blank would be caught. Ticket 10's review
	 * found that surface was Reader-side popup behaviour this ticket owns, so it was removed along with
	 * the app's last `{@html}`. Nothing was lost: the popup tests above load a Published Site in this
	 * build and open a real popup, so they already prove the shared path is live here — and each of
	 * them asserts the prose arrived *before* asserting what did not, which is the same blank-surface
	 * guard the prose block was carrying.
	 */
	let site: { sites: StaticSite[]; directory: string; close(): Promise<void> } | null = null;

	test.afterEach(async () => {
		await site?.close();
		site = null;
	});

	for (const payload of PAYLOADS) {
		test(`an Annotation popup renders ${payload.what} inert, and its prose visibly`, async ({
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
			const popup = await openAnnotationPopup(page);

			// **The prose first.** A blank popup passes every assertion below it, and blank is exactly what
			// `{@html}` and `setHTML` look like when something upstream has quietly stopped producing HTML.
			await expect(popup).toContainText(payload.prose);
			// And the title arrived, as text, including the parts of the payload that look like markup.
			await expect(popup).toContainText('Warehouse');

			expect(await dangerousIn(popup)).toEqual(INERT);
			expect(await page.evaluate(() => '__xss' in window)).toBe(false);
			// **A positive fingerprint that DOMPurify ran on the assembled document**, not only on the
			// description. `renderAnnotationPopup` wraps the title in
			// `<p class="ballastella-annotation-title">` and then sanitises the whole thing again, and `class`
			// is absent from the allowlist — so the class surviving would mean the second pass did not happen.
			// Worth asserting because that pass is what makes the function's *return value* always DOMPurify's
			// output rather than a string some of which happens to have been sanitised, and because an absence
			// assertion alone cannot tell "stripped" from "never rendered".
			expect(await popup.locator('[class*="ballastella"]').count()).toBe(0);
			expect(seen.failures).toEqual([]);
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
		site = await published(oneProject({ name: payload }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url);

		const list = page.getByTestId('published-projects');
		// The text is there, in full, including the parts that look like markup.
		await expect(list).toContainText(payload);
		expect(await dangerousIn(list)).toEqual(INERT);

		// And the same again on the Layer name, which is the other place a `project.json` string is drawn.
		await page.getByRole('link', { name: /Amsterdam/ }).click();
		const layers = page.getByTestId('reader-layers');
		await expect(layers).toContainText('Blaeu’s plan of 1625');
		expect(await dangerousIn(layers)).toEqual(INERT);

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
		const popup = await openAnnotationPopup(page);

		await expect(popup).toContainText('Compare the modern survey with the 1625 plan.');
		const links = await popup.evaluate((element) =>
			[...element.querySelectorAll('a')].map((anchor) => ({
				text: anchor.textContent,
				href: anchor.getAttribute('href')
			}))
		);
		// The legitimate anchor is an anchor — proof the parser ran and produced markup for the sanitiser
		// to inspect, which is the half that fails if the two stages are swapped.
		expect(links).toContainEqual({ text: 'the modern survey', href: 'https://example.org/survey' });
		// And the dangerous one kept its words and lost its destination.
		expect(links).toContainEqual({ text: 'the 1625 plan', href: null });
		expect(await dangerousIn(popup)).toEqual(INERT);
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

			await expect(
				page.getByRole('heading', { level: 1, name: 'Published Projects' })
			).toBeVisible();
			await expect(page.getByTestId('published-projects')).toContainText('Amsterdam 1625');

			// `?p=` opens one, reached by clicking the link the hub rendered rather than by a URL this test
			// composed — so the link is relative in the way the base path needs (ADR-0006).
			await page.getByRole('link', { name: 'Amsterdam 1625' }).click();
			await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
			await expect(page).toHaveURL(`${served.url}?p=amsterdam-1625`);

			// The Project's own data was read over HTTP, relative to the site.
			await expect(page.getByTestId('reader-layers')).toContainText('Blaeu’s plan of 1625');
			await expect(page.getByTestId('reader-layers')).toContainText('Warehouses');
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

		// Every kind of view change a Reader can make.
		await page.getByTestId('reader-layer-visible').first().uncheck();
		await page.getByTestId('reader-layer-visible').first().check();
		const opacity = page.getByTestId('reader-layer-opacity');
		await opacity.fill('0.35');
		await page.getByTestId('base-map-switcher').selectOption({ index: 1 });
		await page.getByRole('button', { name: /Switch to .* theme/ }).click();
		await expect(page.getByTestId('layer-view-status')).toContainText('%');

		expect(seen.requests.filter((request) => request.method !== 'GET')).toEqual([]);
		expect(seen.failures).toEqual([]);

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

	test('draws the stack in the author’s order, with the Annotation Layer above the map Layer', async ({
		page
	}) => {
		// ADR-0002's cross-kind rule, asserted through the mechanism that implements it: MapLibre's own
		// layer order. Asking the app's array instead would only prove the app agrees with itself.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		const order = await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder());
		const mapLayerAt = order.findIndex((id) => id === `ballastella-layer-${MAP_LAYER_ID}`);
		const annotationAt = order.findIndex((id) =>
			id.startsWith(`ballastella-layer-${ANNOTATION_LAYER_ID}-`)
		);
		expect(mapLayerAt, 'the warped Historical Map is on the map').toBeGreaterThan(-1);
		expect(annotationAt, 'the Annotation Layer is on the map').toBeGreaterThan(-1);
		// Later in MapLibre's order is drawn above, and the Annotation Layer is `order: 0` — the top of the
		// stack the author composed.
		expect(annotationAt).toBeGreaterThan(mapLayerAt);

		// And the Historical Map really carried bytes rather than merely being named: the pre-patch failure
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
		expect(seen.failures).toEqual([]);
	});

	test('hiding a Layer takes it off the map and off the count, and shows it again', async ({
		page
	}) => {
		// The `data-drawn` count is a fact about the map rather than a high-water mark. The editor's
		// equivalent merges over a record it never prunes, so a hidden Layer went on being counted as drawn
		// — a defect recorded against `apps/editor/src/routes/layers/+page.svelte`, and the reason this
		// count is built from the Layers that are currently shown and nothing else.
		site = await published(oneProject());
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');

		const mapRow = page.locator(`[data-layer-id="${MAP_LAYER_ID}"]`);
		await mapRow.getByTestId('reader-layer-visible').uncheck();

		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		expect(
			await page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder())
		).not.toContain(`ballastella-layer-${MAP_LAYER_ID}`);

		await mapRow.getByTestId('reader-layer-visible').check();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		await expect(page.getByTestId('layer-view-status')).toContainText('shown');
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

		await page.getByTestId('reader-layer-opacity').fill('0.25');

		await expect(page.getByTestId('reader-layer-opacity-value')).toHaveText('25%');
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

		const row = page.locator('[data-layer-id="l-future"]');
		await expect(row).toContainText('Notes on the sheet itself');
		await expect(row.getByTestId('reader-layer-kind')).toContainText('image-space-annotation');
		// The rest of the Project is unaffected.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
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
		await expect.poll(() => paint(page)).not.toBe(before);
		expect(seen.failures).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// Reading a Historical Map as a document (SPEC story 85)
// ─────────────────────────────────────────────────────────────────────────────────────────

test.describe('a Historical Map read unwarped', () => {
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
			// At the **site root**, and stamped with an address that names no Project (ADR-0023): a Historical
			// Map is shared, so it answers at one citable endpoint however many Projects draw it.
			await writeSiteFile(
				site.directory,
				`images/${IMAGE_ID}/info.json`,
				infoJson(`${served.url}images/${IMAGE_ID}`)
			);
			const seen = watch(page);
			const url = `${served.url}?p=amsterdam-1625`;

			// **Where the tile assertion below starts counting.** The warped Historical Map on the Project
			// page fetches the very same pyramid, so a filter over the whole request log would be satisfied by
			// the *map's* tiles and say nothing about the unwarped viewer. Not hypothetical: it is how the
			// `by link` case first passed while the direct-load case failed for a real reason.
			let from = 0;
			if (entry === 'by link') {
				await page.goto(url);
				await mapReady(page);
				from = seen.requests.length;
				await page.getByTestId('reader-layer-unwarped').click();
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
		// The unstamped case, which is the **default** for a locally ingested Historical Map: its `info.json`
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

	test('says so when the image behind a Historical Map is not on the site', async ({ page }) => {
		site = await published(oneProject({ withoutPyramid: true }));
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + `?p=amsterdam-1625&unwarped=${MAP_LAYER_ID}`);

		await expect(page.getByTestId('unwarped-problem')).toContainText('not on this site');
		// And the way back still works, so one missing image is not a dead end.
		await expect(page.getByTestId('back-to-project')).toBeVisible();
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

	test('names the host when a referenced Historical Map’s record cannot be read', async ({
		page
	}) => {
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

		const problem = page
			.locator(`[data-layer-id="${MAP_LAYER_ID}"]`)
			.getByTestId('reader-layer-problem');
		await expect(problem).toContainText('Blaeu’s plan of 1625');
		await expect(problem).toContainText('did not answer');
		// The **rest of the site still works**: the Annotation Layer is drawn, and the count says one.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');
		await expect(page.getByTestId('reader-layers')).toContainText('Warehouses');
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

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);

		await expect(page.getByTestId('base-map-notice')).toContainText(
			'a-base-map-from-another-deployment'
		);
		await expect(page.getByTestId('base-map-notice')).toContainText('not available here');
		// A working map, not a blank pane: the switcher settled on something the site can serve.
		const chosen = await page.getByTestId('base-map-switcher').inputValue();
		expect(chosen).not.toBe('a-base-map-from-another-deployment');
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		expect(seen.failures).toEqual([]);
	});

	test('draws the work and says so when the site carries no copy of the Base Map', async ({
		page
	}) => {
		// ADR-0020's opt-in, from the Reader's side (SPEC stories 88 and 89): including the Base Map's own
		// 4.9 MB is a choice a scholar makes at publish time, and a great many sites will not have it.
		//
		// **The assertion that matters is that nothing was requested.** A bundled entry's archive, glyphs,
		// and sprites are site-relative paths, so a viewer that built the ordinary style anyway would fire a
		// pmtiles range request and two sprite requests at files that are not there — three 404s, a blank
		// rectangle, and no account of either. This test exists because the *published* site's own e2e
		// caught exactly that the first time the viewer drew a map at all.
		// The record says so as well as the files being absent, which is what publishing writes: `publishSite`
		// records `baseMapBundled` from the same answer that decided whether to write them, so the two cannot
		// disagree on a real site.
		site = await published(oneProject({ baseMap: 'physical' }, { baseMapBundled: false }), {
			withoutBaseMap: true
		});
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		await expect(page.getByTestId('base-map-unavailable')).toContainText('without its own copy');
		// It names the way out, and the entries that would work are marked in the switcher.
		await expect(page.getByTestId('base-map-unavailable')).toContainText('needs network');
		// The scholar's own work is still drawn: this is a missing *reference* map, not a missing Project.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
		// And not one request for a file the site does not hold.
		expect(seen.requests.filter((request) => request.url.includes('/base-map/'))).toEqual([]);
		expect(served.failures).toEqual([]);
		expect(seen.failures).toEqual([]);
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

		await expect(page.getByRole('heading', { level: 1, name: 'Published Projects' })).toBeVisible();
		await expect(page.getByTestId('site-problem')).toContainText('nothing has been published');
		expect(seen.failures).toEqual([]);
	});

	test('warns that a referenced Historical Map leaves a Reader with no network seeing nothing', async ({
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
		await expect(
			page.locator(`[data-layer-id="${MAP_LAYER_ID}"]`).getByTestId('reader-layer-image-mode')
		).toContainText('needs the network');
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
			if (where !== '') await mapReady(page);

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
		await page.getByTestId('reader-layer-visible').first().uncheck();
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		await page.getByTestId('reader-layer-opacity').fill('0.5');
		await expect(page.getByTestId('reader-layer-opacity-value')).toHaveText('50%');
		expect(seen.failures).toEqual([]);
	});

	test('an Annotation popup is readable inside the viewport', async ({ page }) => {
		site = await published(
			await oneProject({
				annotations: [
					annotation({
						title: 'The east warehouse',
						description: 'Rebuilt in **1663** after the fire, and rebuilt again a century later.'
					})
				]
			})
		);
		const seen = watch(page);

		await page.goto(site.sites[0]!.url + '?p=amsterdam-1625');
		await mapReady(page);
		const popup = await openAnnotationPopup(page);

		await expect(popup).toContainText('The east warehouse');
		await expect(popup).toContainText('Rebuilt in 1663');
		await expect(popup.locator('strong')).toHaveText('1663');
		// Inside the viewport horizontally, which is what "readable" means on a 375 px screen: a popup
		// wider than the screen is one whose prose is cut off with no way to scroll to it.
		const box = (await popup.boundingBox())!;
		expect(box.width).toBeLessThanOrEqual(375);
		expect(box.x).toBeGreaterThanOrEqual(-1);
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
		await tabTo(page.getByTestId('reader-layer-visible').first());
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

		// The opacity range, moved by arrow key.
		const opacity = page.getByTestId('reader-layer-opacity');
		await tabTo(opacity);
		const before = await opacity.inputValue();
		await page.keyboard.press('ArrowLeft');
		expect(await opacity.inputValue()).not.toBe(before);
		await expect(page.getByTestId('layer-view-status')).toContainText('%');

		// And the way into reading a Historical Map on its own is a real control the keyboard can activate.
		// Asserted on the *navigation* rather than on the viewer, because this Project is unstamped and
		// therefore takes the refusal branch — which is its own test. What is under test here is that a
		// keyboard reaches the control and Enter acts on it.
		await tabTo(page.getByTestId('reader-layer-unwarped'));
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(new RegExp(`unwarped=${MAP_LAYER_ID}`));
		await expect(page.getByTestId('back-to-project')).toBeVisible();
		expect(seen.failures).toEqual([]);
	});

	test('opens the Annotation at the centre of the map with Enter, and closes it with Escape', async ({
		page
	}) => {
		// The keyboard route to a popup, which is the Reader-facing half of story 67. MapLibre already pans
		// with the arrow keys and zooms with `+`/`-`, so "move the map to it, then press Enter" is a whole
		// path with nothing new to learn — and without it the popups would be pointer-only.
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
		await expect
			.poll(
				async () => {
					await page.keyboard.press('Enter');
					return page.locator('.maplibregl-popup-content').count();
				},
				{ timeout: 30_000, intervals: [250, 500, 1000] }
			)
			.toBeGreaterThan(0);
		await expect(page.locator('.maplibregl-popup-content')).toContainText('Rebuilt in 1663');

		await page.keyboard.press('Escape');
		await expect(page.locator('.maplibregl-popup-content')).toHaveCount(0);
		expect(seen.failures).toEqual([]);
	});
});
