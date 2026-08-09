import { expect, test } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unavailableNotice } from './support/base-map-notice.js';
import {
	baseMapArchiveFixture,
	byteRange,
	cachedBaseMapTiles,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	routePartialBaseMapArchive
} from './support/editor-deployment';

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
		queryRenderedFeatures(): { layer: { id: string } }[];
		project(lngLat: [number, number]): { x: number; y: number };
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
 * The archive every entry in this deployment's catalog points at (ADR-0020).
 *
 * Named here because a site's cached tiles sit in a directory keyed on it (ticket 12), and because
 * the site record has to say which archive its tiles are for — a Reader's HTTP store cannot list a
 * directory to find out, and drawing one archive's tiles under another entry is the wrong-map
 * failure the key exists to end. `scripts/check-base-map-catalog.mjs` exempts `*.e2e.ts`; this file
 * already names entry ids for the same reason.
 */
const ARCHIVE = 'https://demo-bucket.protomaps.com/v4.pmtiles';

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
		// — a defect recorded against the editor's Layer stack, which ticket 04 moved into
		// `apps/editor/src/lib/project/ProjectScreen.svelte`, and the reason this count is built from the
		// Layers that are currently shown and nothing else.
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
		await mapReady(page);
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
		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: true }));
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		await expect(page.getByTestId('base-map-not-published')).toHaveCount(0);
		// And no outage claimed either: the archive answered, so `base-map-unavailable` — the notice for
		// an archive that did not — must stay off the screen. A warning that is always on is unreadable.
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
		// ADR-0020's opt-in, from the Reader's side (SPEC stories 88 and 89): including the Base Map's
		// own glyphs and sprites is a choice a scholar makes at publish time, and a great many sites
		// will not have it.
		//
		// Since ticket 10 this state looks different from the way it used to. Every catalog entry now
		// reads a remote archive, so the geography still draws — and what a site without those files
		// loses is **every place name on the map**. `ReaderMapPane` drops `glyphs`, `sprite`, and the
		// symbol layers rather than 404ing at files that are not there, and the question this test
		// exists to answer is whether the Reader is told. A geography-only map with no account of
		// itself is precisely the silent failure this ticket forbids.
		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: false }), {
			withoutBaseMap: true
		});
		const served = site.sites[0]!;
		const seen = watch(page);

		await page.goto(`${served.url}?p=amsterdam-1625`);
		await mapReady(page);

		// The whole sentence, in the row where the archive answers. Two more tests below assert the
		// **same** string with the archive refusing, and with the connection gone as well: it is one
		// sentence about the site's own files, and the point of pinning it in three rows is that it
		// stays one. A conditional version of it was where this notice went wrong.
		const notice = page.getByTestId('base-map-not-published');
		await expect(notice).toHaveText(
			'This site was published without the Base Map’s labels and symbols, so the modern ' +
				'reference map here carries no place names at all. The Historical Maps and the ' +
				'Annotations are not affected.'
		);
		// **And no outage claimed.** The archive answers here (the global `beforeEach` serves the
		// fixture), so this site is short of its labels and of nothing else.
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		// The scholar's own work is still drawn, and so is the geography: this is a reference map
		// missing its lettering, not a missing Project.
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '2');
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
	// deployment's catalog reads — has refused the archive since 2026-08-07, so a blank map with no
	// explanation is the current behaviour of every published site. ADR-0025 predicted exactly that.
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
	const UNAVAILABLE_NOTICE = unavailableNotice('Physical geography', 'demo-bucket.protomaps.com');

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
		await expect(page.getByTestId('base-map-not-published')).toHaveCount(0);

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
		// **And the Historical Map, which the assertion above cannot see.** A `kind: 'map'` Layer is a
		// `WarpedMapLayer` — a custom WebGL layer — and `queryRenderedFeatures()` returns nothing for
		// one, so the filter above is satisfied by the Annotation Layer alone. `data-drawn="2"` is the
		// page's own count of itself, which is exactly the kind of evidence this ticket refuses. Tiles
		// in the renderer's cache are the Historical Map's equivalent of a rendered feature, and the
		// idiom is this suite's own — see "draws the stack in the author's order". Mutation-checked by
		// 404ing the Historical Map's tiles: `data-drawn` stayed at `2` and this went to `0`.
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
		// archive — and the Historical Map's tiles are site files, fetched as the renderer needs them.
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

		// ── One named exception, and every other page error still fails this ────────────────────────
		// Cutting the connection while a warped Layer is on screen makes `@allmaps/render`'s
		// `loadImage` ask this site for the Historical Map's `info.json`, and the store's rejection —
		// `SiteFileUnreachableError` — escapes it uncaught, arriving as a `pageerror`. Measured at
		// three runs in eight, here and at the previous commit alike, so it is neither this change nor
		// contention.
		//
		// **Out of scope, and deliberately not hidden.** Nothing a Reader sees changes: the tiles
		// already drawn stay drawn, the count stays at two, and the notice behaviour this test is about
		// is unaffected. What to *do* about tiles that can no longer be fetched mid-session is a
		// question about the render seam and about ADR-0023's referenced images, not about a Base Map
		// notice — and the answer is either another patch to `@allmaps/render` or a decision that the
		// Layer should say something, neither of which belongs in this ticket.
		//
		// So it is named rather than filtered by shape: any other `pageerror`, including a second kind
		// from the same path, still turns this red. The idiom is this file's own — see the
		// `/default.jpg` exception in the cached-tiles test above.
		expect(
			seen.failures.filter((failure) => !failure.includes('images/aaa/info.json could not be read'))
		).toEqual([]);
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
		// names on it — the geography, the Historical Maps, and the Annotations are all here", directly
		// above "The Base Map could not be loaded from demo-bucket.protomaps.com". The first sentence is
		// a flat falsehood in that state, and it was the live behaviour of every site this deployment
		// published. The claim about the geography is gone rather than made conditional — see the next
		// test for the row a conditional one would still have got wrong.
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);

		site = await published(oneProject({ baseMap: 'physical' }, { baseMapAssetsBundled: false }), {
			withoutBaseMap: true
		});
		const seen = watch(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await expect(page.getByTestId('base-map-unavailable')).toBeVisible({ timeout: 45_000 });
		await mapReady(page);

		// Both are up, because both are true and they have different remedies: the outage is the
		// Reader's to work around by switching Base Map, the missing labels are the publisher's to fix.
		const notPublished = page.getByTestId('base-map-not-published');
		await expect(notPublished).toBeVisible();
		await expect(notPublished).toHaveText(
			'This site was published without the Base Map’s labels and symbols, so the modern ' +
				'reference map here carries no place names at all. The Historical Maps and the ' +
				'Annotations are not affected.'
		);
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
		// than on *the failure* would print "the geography, the Historical Maps, and the Annotations are
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

		await expect(page.getByTestId('base-map-not-published')).toHaveText(
			'This site was published without the Base Map’s labels and symbols, so the modern ' +
				'reference map here carries no place names at all. The Historical Maps and the ' +
				'Annotations are not affected.'
		);
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
		// not dead code. `pmtiles` caches the archive *header* promise per URL and never evicts a
		// rejected one, so a header that refuses is sticky for the life of the page — but tile ranges
		// are not cached at all, and every `getBytes` for tile data goes to the network afresh. A
		// bucket that rate-limits mid-session therefore comes back: the limit lifts, the Reader pans,
		// tiles arrive, and geography draws. Without `'drawing'` the alert would sit over a working
		// Base Map for as long as the Reader stayed on the page, which is a worse lie than the silence
		// this ticket was written to end.
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
		await expect(notice).toHaveCount(0, { timeout: 30_000 });
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
		// The stack replaced outright, so the Amsterdam Historical Map the fixture also carries cannot
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
	});

	test('frames on a sheet whose Alignment reads, even when its image record does not', async ({
		page
	}) => {
		// The divergence this criterion exists to catch. The editor's `readProjectContent` reads the
		// Alignment and nothing else, so a Layer whose Alignment parses places its sheet there whatever
		// happened to its tiles. The viewer used to contribute a Layer only at `status: 'ready'`, which
		// is a claim about *drawing* — so a Historical Map whose library server was down was on the earth
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
		await expect(
			page.locator(`[data-layer-id="${MAP_LAYER_ID}"]`).getByTestId('reader-layer-problem')
		).toContainText('did not answer');
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
		await page.getByTestId('reader-layer-visible').first().uncheck();
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '0');
		await page.getByTestId('reader-layer-visible').first().check();
		await mapReady(page);
		await expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', '1');

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(parked.lng, 6);
		expect(at.lat).toBeCloseTo(parked.lat, 6);
		expect(at.zoom).toBeCloseTo(parked.zoom, 6);

		// The explicit control, with words on it, is what covers everything the once-only fit does not.
		await page.getByRole('button', { name: 'Fit to this Project' }).click();
		await expect
			.poll(async () => (await readerViewport(page)).lat)
			.toBeCloseTo(BOSTON_CENTRE.lat, 3);
		expect((await readerViewport(page)).lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
	});
});
