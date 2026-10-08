import { expect, test as base } from './support/test.js';
import { type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { unavailableNotice } from './support/base-map-notice.js';
import {
	baseMapOptionsButton,
	drawSwitch,
	openBaseMapOptions
} from './support/base-map-options.js';
import { openLayerRow } from './support/layers.js';
import { leaderIsDrawn, leaderLayer, leaderPoints } from './support/leader.js';
import {
	baseMapArchiveFixture,
	byteRange,
	refuseBaseMapArchive,
	routeBaseMapArchive,
	routePartialBaseMapArchive
} from './support/editor-deployment';

import {
	servePublishedSite,
	siteRecord,
	assemblePublishedSite,
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
import { serveDirectory } from './support/static-site.js';
import { tilesServerErrorNotice, tilesUnavailableNotice } from './support/tile-failure-notice.js';

type ReaderMapHandle = {
	map: {
		getLayersOrder(): string[];
		getStyle(): { layers: Record<string, unknown>[] };
		queryRenderedFeatures(at?: [number, number]): {
			layer: { id: string };
			properties: Record<string, unknown>;
		}[];
		project(lngLat: [number, number]): { x: number; y: number };
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
		__xss?: unknown;
		ballastellaReaderMap?: ReaderMapHandle;
		ballastellaServedBaseMapTiles?: { z: number; x: number; y: number; bytes: number }[];
		__noticeArrivals?: { kind: 'insert' | 'change'; text: string }[];
	}
}

type PageWatch = {
	readonly failures: string[];
	readonly requests: { method: string; url: string }[];
};

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

type NoticeArrival = { kind: 'insert' | 'change'; text: string };

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
				if (inserted) continue;
				const host = asElement(record.target)?.closest(selector) ?? null;
				if (host !== null) say('change', host);
			}
		}).observe(document, { childList: true, subtree: true, characterData: true });
	}, testid);
}

const noticeArrivals = (page: Page): Promise<NoticeArrival[]> =>
	page.evaluate(() => window.__noticeArrivals ?? []);

async function dangerousIn(host: Locator): Promise<Record<string, unknown>> {
	return host.evaluate((element) => {
		const handlers: string[] = [];
		const urls: string[] = [];
		for (const node of [element, ...element.querySelectorAll('*')]) {
			for (const attribute of node.attributes) {
				const name = attribute.name.toLowerCase();
				if (name.startsWith('on')) handlers.push(name);
				if (name === 'href' || name === 'src' || name === 'xlink:href') {
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

const INERT = {
	scripts: 0,
	handlers: [],
	dangerousUrls: [],
	images: 0,
	embeds: 0
} as const;

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

const toClose: { close(): Promise<void> }[] = [];

const test = base.extend<{ seen: PageWatch }>({
	seen: [
		async ({ page }, use) => {
			const seen = watch(page);
			await use(seen);
			try {
				expect(seen.failures).toEqual([]);
			} finally {
				await Promise.all(toClose.splice(0).map((open) => open.close()));
			}
		},
		{ auto: true }
	]
});

test.beforeEach(async ({ page }) => {
	await routeBaseMapArchive(page);
});

async function servedSite(files: SiteFiles, options: { withoutBaseMap?: boolean } = {}) {
	const site = await servePublishedSite(files, options);
	toClose.push(site);
	return site;
}

const PROJECT_QUERY = '?p=amsterdam-1625';

async function openSite(
	page: Page,
	files: SiteFiles,
	options: { withoutBaseMap?: boolean; at?: string; ready?: boolean } = {}
) {
	const { at = PROJECT_QUERY, ready = at === PROJECT_QUERY } = options;
	const site = await servedSite(files, options);
	const served = site.sites[0]!;
	await page.goto(served.url + at);
	if (ready) await mapReady(page);
	return { site, served };
}

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

const EDITOR_INSTANCE = 'https://maps.example.edu/ballastella/';

function writtenByEditor(): SiteFiles {
	return oneProject({}, writtenFrom());
}

function writtenFrom(): Record<string, unknown> {
	return {
		editorUrl: EDITOR_INSTANCE,
		repository: { owner: 'ada', repository: 'atlas', branch: 'main' }
	};
}

const RETURN_LINK = /^Open this (Project|Workspace) in Ballastella$/;

async function frontPageContent(page: Page): Promise<string> {
	const main = page.locator('main');
	await expect(main).not.toContainText('Looking for the Projects on this site');
	await expect(main).toHaveText('');
	return main.innerHTML();
}

async function mapReady(page: Page): Promise<void> {
	await expect(page.getByTestId('reader-map-pane')).toBeVisible();
	await expect
		.poll(() => page.evaluate(() => window.ballastellaReaderMap !== undefined), { timeout: 30_000 })
		.toBe(true);
}

const layerStack = (page: Page): Locator => page.getByRole('list', { name: 'Layers, top first' });

const layerRow = (page: Page, id: string): Locator =>
	page.locator(`[data-testid="layer-row"][data-layer-id="${id}"]`);

const layerVisible = (page: Page, id: string): Locator =>
	layerRow(page, id).getByTestId('layer-visible');

const expectDrawn = (page: Page, count: number, timeout?: number) =>
	expect(page.getByTestId('stack-status')).toHaveAttribute('data-drawn', String(count), {
		timeout
	});

const layersOrder = (page: Page): Promise<string[]> =>
	page.evaluate(() => window.ballastellaReaderMap!.map.getLayersOrder());

const baseMapDrawn = (page: Page): Promise<boolean> =>
	page.evaluate(() =>
		(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).some(
			(feature) => feature.layer.id.startsWith('roads_') || feature.layer.id.startsWith('water')
		)
	);

const workDrawn = (page: Page): Promise<number> =>
	page.evaluate(
		() =>
			(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? []).filter((feature) =>
				feature.layer.id.startsWith('ballastella-layer-')
			).length
	);

const tilesOnceFitted = (page: Page): Promise<number> =>
	page.evaluate(async (id) => {
		const handle = window.ballastellaReaderMap!;
		const layer = handle.warped[id]!;
		handle.map.fitBounds(layer.getBounds(), { animate: false });
		await new Promise((resolve) => setTimeout(resolve, 500));
		return (layer.renderer?.tileCache?.getCachedTiles?.() ?? []).length;
	}, MAP_LAYER_ID);

const storedBaseMaps = (page: Page) =>
	page.evaluate(() =>
		Object.fromEntries(
			Object.entries({ ...window.localStorage }).filter(([key]) =>
				key.startsWith('ballastella.baseMap')
			)
		)
	);

const EDITING_CONTROLS = [
	'layer-rename',
	'layer-name',
	'layer-move-up',
	'layer-move-down',
	'layer-delete',
	'layer-drag-handle',
	'layer-image-mode'
] as const;

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

async function expectNothingEditable(page: Page): Promise<void> {
	for (const control of EDITING_CONTROLS) {
		await expect(page.getByTestId(control), `${control} in the viewer`).toHaveCount(0);
	}
	await expect(page.getByRole('button', { name: /^Add a/ })).toHaveCount(0);
	await expect(page.getByRole('button', { name: /^Add an/ })).toHaveCount(0);
	await expectNoEditorProse(page);
}

async function expectNoEditorProse(page: Page): Promise<void> {
	for (const phrase of EDITOR_ONLY_PROSE) {
		await expect(page.locator('body'), `“${phrase}” in the viewer`).not.toContainText(phrase);
	}
}

const REFERENCED = {
	imageMode: 'referenced',
	remoteService: 'https://maps.library.example/iiif/x'
} as const;

const libraryIsDown = (page: Page) =>
	page.route('**/images/aaa/remote.json', (route) =>
		route.fulfill({ status: 503, body: 'the library is down' })
	);

const ANNOTATION_AT: [number, number] = [4.9, 52.3676];
const TAPPED_ANNOTATION_ID = '11111111-1111-4111-8111-111111111111';
const bucket = (part: string): string => `ballastella-layer-${ANNOTATION_LAYER_ID}-${part}`;
const ARCHIVE = 'https://data.source.coop/protomaps/openstreetmap/v4.pmtiles';
const STACKS_BELOW = 1024;
const ARCHIVE_HOST = new URL(ARCHIVE).host;

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
	await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
	await expect(page.getByTestId('annotation-inspector')).toHaveCount(1);
	return page.getByTestId('annotation-inspector-face');
}

async function openAnnotationRow(page: Page): Promise<Locator> {
	const card = await openLayerRow(page, layerRow(page, ANNOTATION_LAYER_ID));
	const row = card.getByTestId('annotation-row').first();
	await expect(row).toBeVisible();
	if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
	await expect(row).toHaveAttribute('aria-expanded', 'true');
	await expect(page.getByTestId('annotation-inspector')).toHaveCount(1);
	return page.getByTestId('annotation-inspector-face');
}

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
	'annotation-inspector-tabs',
	'annotation-inspector-tab-text',
	'annotation-inspector-tab-style'
] as const;

async function expectNoAnnotationEditing(page: Page): Promise<void> {
	for (const control of ANNOTATION_EDITING_CONTROLS) {
		await expect(page.getByTestId(control), `${control} in the viewer`).toHaveCount(0);
	}
	await expectNoEditorProse(page);
}

test.describe('untrusted text on a Published Site', () => {
	for (const payload of PAYLOADS) {
		test(`an Annotation renders ${payload.what} inert in the Inspector, and its prose visibly`, async ({
			page,
			seen
		}) => {
			await openSite(
				page,
				oneProject({
					annotations: [
						annotation({
							title: `Warehouse ${payload.markdown}`,
							description: payload.markdown
						})
					]
				})
			);

			await openAnnotationFromMap(page);

			const reading = await openAnnotationRow(page);

			await expect(reading).toContainText(payload.prose);
			expect(await dangerousIn(reading)).toEqual(INERT);
			const named = page.getByTestId('annotation-inspector-name');
			await expect(named).toContainText('Warehouse');
			expect(await dangerousIn(named)).toEqual(INERT);
			expect(await page.evaluate(() => '__xss' in window)).toBe(false);

			await expectNoAnnotationEditing(page);

			expect(seen.requests.filter((made) => /search|geocod|nominatim/i.test(made.url))).toEqual([]);
		});
	}

	test('a Project’s name and a Layer’s name are text, never markup — a different mechanism', async ({
		page
	}) => {
		const payload =
			'Amsterdam <img src=x onerror="window.__xss=1"> 1625<script>window.__xss=1</script>';
		await openSite(
			page,
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
			}),
			{ at: '' }
		);

		const list = page.getByTestId('front-page-projects');
		await expect(list).toContainText(payload);
		expect(await dangerousIn(list)).toEqual(INERT);

		await page.getByRole('link', { name: /Amsterdam/ }).click();
		const layerName = layerRow(page, MAP_LAYER_ID).getByTestId('layer-name-text');
		await expect(layerName).toHaveText(payload);
		expect(await dangerousIn(layerName)).toEqual(INERT);
		expect(await page.evaluate(() => '__xss' in window)).toBe(false);
	});

	test('parses before sanitising, so the anchor the parser builds is seen by the sanitiser', async ({
		page
	}) => {
		await openSite(
			page,
			oneProject({
				annotations: [
					annotation({
						description:
							'Compare [the modern survey](https://example.org/survey) with ' +
							'[the 1625 plan](javascript:window.__xss=1).'
					})
				]
			})
		);

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
	});
});

test.describe('a Published Site a Reader arrives at', () => {
	test('serves the hub and its Projects over plain HTTP, at a domain root and in a subdirectory, listing only those on the Front Page', async ({
		page
	}) => {
		const site = await servedSite({
			'ballastella-site.json': siteRecord([
				{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: false },
				{ directory: 'boston-1775', name: 'Boston 1775', onFrontPage: true }
			]),
			...projectFiles(),
			...projectFiles({ directory: 'boston-1775', name: 'Boston 1775' })
		});

		for (const served of site.sites) {
			await page.goto(served.url);

			await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
			await expect(page.getByTestId('front-page-projects')).toContainText('Boston 1775');
			await expect(page.getByTestId('front-page-projects')).not.toContainText('Amsterdam 1625');
			await expect(page.getByTestId('no-account-needed')).toHaveCount(0);

			await page.getByRole('link', { name: 'Boston 1775' }).click();
			await expect(page.getByTestId('page-heading')).toHaveText('Boston 1775');
			await expect(page).toHaveURL(`${served.url}?p=boston-1775`);
			await expect(layerStack(page)).toContainText('Blaeu’s plan of 1625');
			await expect(layerStack(page)).toContainText('Warehouses');
			await mapReady(page);

			await page.goto(`${served.url}?p=amsterdam-1625`);
			await expect(page.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
			await expect(layerStack(page)).toContainText('Blaeu’s plan of 1625');
			await expect(layerStack(page)).toContainText('Warehouses');
			await mapReady(page);

			expect(
				served.requests.filter((asked) => !asked.startsWith(`${served.prefix}/`)),
				`requests outside ${served.prefix}/`
			).toEqual([]);
			expect(served.requests.some((asked) => asked !== `${served.prefix}/`)).toBe(true);
			expect(served.failures.filter((failure) => !failure.path.includes('/default.jpg'))).toEqual(
				[]
			);
		}
	});

	test('renders the same blank Front Page for both kinds of empty site', async ({ page }) => {
		const { site } = await openSite(
			page,
			{
				'ballastella-site.json': siteRecord(
					[{ directory: 'amsterdam-1625', name: 'Amsterdam 1625', onFrontPage: false }],
					writtenFrom()
				),
				...projectFiles()
			},
			{ at: '' }
		);

		await expect(page.getByTestId('front-page-projects')).toHaveCount(0);
		await expect(page.getByRole('link', { name: RETURN_LINK })).toHaveCount(0);
		await expect(page.getByTestId('site-problem')).toHaveCount(0);
		const allUnlisted = await frontPageContent(page);

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await expect(page.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
		await expect(layerStack(page)).toContainText('Blaeu’s plan of 1625');
		await expect(
			page.getByRole('link', { name: 'Open this Project in Ballastella' })
		).toHaveAttribute('href', `${EDITOR_INSTANCE}?review=ada/atlas&p=amsterdam-1625`);

		const empty = await servedSite({ 'ballastella-site.json': siteRecord([], writtenFrom()) });
		await page.goto(empty.sites[0]!.url);

		await expect(page.getByRole('link', { name: RETURN_LINK })).toHaveCount(0);
		await expect(page.getByTestId('site-problem')).toHaveCount(0);
		const nothingOnTheFrontPage = await frontPageContent(page);
		expect(nothingOnTheFrontPage).toBe(allUnlisted);
	});

	test('leads back to the editor that wrote it, from the Front Page and from a Project', async ({
		page
	}) => {
		const site = await servedSite(writtenByEditor());

		for (const served of site.sites) {
			await page.goto(served.url);

			const bar = page.getByTestId('navigation-bar');
			const clone = bar.getByRole('link', { name: 'Open this Workspace in Ballastella' });
			await expect(clone).toHaveAttribute('href', `${EDITOR_INSTANCE}?clone=ada/atlas`);

			await expect(page.getByTestId('no-account-needed')).toContainText(
				'You do not need an account, and nothing on this site is changed'
			);

			await expect(bar.getByTestId('site-name')).toBeVisible();
			await expect(bar.getByTestId('all-projects')).toBeVisible();
			await expect(bar.getByTestId('theme-toggle')).toBeVisible();
			await expect(bar.getByTestId('page-heading')).toHaveText('Front Page');

			await page.goto(`${served.url}?p=amsterdam-1625`);

			await expect(bar.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
			await expect(bar.getByTestId('all-projects')).toBeVisible();

			const review = bar.getByRole('link', { name: 'Open this Project in Ballastella' });
			await expect(review).toHaveAttribute(
				'href',
				`${EDITOR_INSTANCE}?review=ada/atlas&p=amsterdam-1625`
			);
			await expect(clone).toHaveCount(0);
			await expect(page.getByTestId('no-account-needed')).toHaveCount(0);

			await bar.getByTestId('site-name').click();
			await expect(bar.getByTestId('page-heading')).toHaveText('Front Page');
		}
	});

	for (const [why, record] of [
		['does not record one', {}],
		['is bound to no repository', { editorUrl: EDITOR_INSTANCE }]
	] as const) {
		test(`says nothing about an editor when the site ${why}`, async ({ page }) => {
			const { served } = await openSite(page, oneProject({}, record), { at: '' });

			await expect(page.getByTestId('front-page-projects')).toContainText('Amsterdam 1625');
			await expect(page.getByRole('link', { name: RETURN_LINK })).toHaveCount(0);
			await expect(page.getByTestId('site-problem')).toHaveCount(0);
			expect(served.requests.filter((asked) => asked.endsWith('.json'))).toEqual([
				`${new URL(served.url).pathname.replace(/\/$/, '')}/ballastella-site.json`
			]);
		});
	}

	test('reads everything through the HTTP store, applies opacity and visibility in place, and changes no byte', async ({
		page,
		seen
	}) => {
		const { site } = await openSite(page, oneProject());
		await expectDrawn(page, 2);
		const builds = await page.evaluate(() => window.ballastellaReaderMap!.builds);

		const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await expectNothingEditable(page);

		await card.getByTestId('layer-opacity').fill('0.35');
		await expect(card.getByTestId('layer-opacity-value')).toHaveText('35%');
		await expect(page.getByTestId('layer-view-status')).toContainText('35%');
		expect(
			await page.evaluate(
				(id) => window.ballastellaReaderMap!.warped[id]!.getOpacity?.() ?? -1,
				MAP_LAYER_ID
			)
		).toBeCloseTo(0.35, 5);
		expect(await page.evaluate(() => window.ballastellaReaderMap!.builds)).toBe(builds);

		await layerVisible(page, MAP_LAYER_ID).uncheck();
		await expectDrawn(page, 1);
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		await expect(layerRow(page, MAP_LAYER_ID).getByTestId('layer-hidden')).toHaveText('Hidden');
		expect(await layersOrder(page)).not.toContain(`ballastella-layer-${MAP_LAYER_ID}`);

		await layerVisible(page, MAP_LAYER_ID).check();
		await expectDrawn(page, 2);
		await expect(page.getByTestId('layer-view-status')).toContainText('shown');
		await expect(layerRow(page, MAP_LAYER_ID).getByTestId('layer-hidden')).toHaveCount(0);
		expect(await layersOrder(page)).toContain(`ballastella-layer-${MAP_LAYER_ID}`);

		await openBaseMapOptions(page);
		await drawSwitch(page, 'High contrast').click();
		await page.getByRole('button', { name: 'Theme', exact: true }).click();
		await page.getByTestId('theme-option-synthwave').click();

		expect(seen.requests.filter((request) => request.method !== 'GET')).toEqual([]);

		expect(await page.evaluate(() => ({ ...window.localStorage }))).toEqual({
			[`ballastella.baseMap:${site.sites[0]!.url}`]: JSON.stringify({
				appearance: { streets: true, relief: false, highContrast: true, imagery: false }
			})
		});

		const before = await readFile(path.join(site.directory, 'amsterdam-1625/project.json'), 'utf8');
		expect(before).toContain('"opacity": 0.8');
		expect(before).not.toContain('0.35');
	});
});

test.describe('exploring a Project', () => {
	test('draws the stack in the author’s order with zoom at the bottom-left, the Annotation Layer above the map Layer, and the Inspector docked over the pane’s top-right', async ({
		page
	}) => {
		const numbered = ['a', 'b', 'c'].map((letter, at) =>
			annotation({
				id: `1111111${at}-1111-4111-8111-11111111111${at}`,
				title: `Warehouse ${letter}`,
				coordinates: [4.9 + at * 0.01, 52.3676]
			})
		);
		const { site } = await openSite(page, oneProject({ annotations: numbered }));

		const readerPane = page.getByTestId('reader-map-pane');
		const bottomLeft = readerPane.locator('.maplibregl-ctrl-bottom-left');
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-in')).toBeVisible();
		await expect(bottomLeft.locator('button.maplibregl-ctrl-zoom-out')).toBeVisible();
		await expect(readerPane.locator('.maplibregl-ctrl-top-right .maplibregl-ctrl')).toHaveCount(0);

		const sidebarBox = (await page.getByTestId('layer-sidebar').boundingBox())!;
		const mapBox = (await readerPane.boundingBox())!;
		expect(mapBox.x).toBeGreaterThanOrEqual(sidebarBox.x + sidebarBox.width - 1);
		expect(mapBox.width).toBeGreaterThan(sidebarBox.width);
		expect(mapBox.height).toBeGreaterThan(sidebarBox.width);
		const order = await layersOrder(page);
		const mapLayerAt = order.findIndex((id) => id === `ballastella-layer-${MAP_LAYER_ID}`);
		const annotationAt = order.findIndex((id) =>
			id.startsWith(`ballastella-layer-${ANNOTATION_LAYER_ID}-`)
		);
		expect(mapLayerAt, 'the warped Map Image is on the map').toBeGreaterThan(-1);
		expect(annotationAt, 'the Annotation Layer is on the map').toBeGreaterThan(-1);
		expect(annotationAt).toBeGreaterThan(mapLayerAt);

		await expect.poll(() => tilesOnceFitted(page), { timeout: 30_000 }).toBeGreaterThan(0);

		await expectDrawn(page, 2);

		const card = await openLayerRow(page, layerRow(page, ANNOTATION_LAYER_ID));
		expect(await card.getByTestId('annotation-row-ordinal').allTextContents()).toEqual([
			'1',
			'2',
			'3'
		]);
		expect(await card.getByTestId('annotation-row-name').allTextContents()).toEqual([
			'Warehouse a',
			'Warehouse b',
			'Warehouse c'
		]);

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

		await page.evaluate(
			(centre) =>
				window.ballastellaReaderMap!.map.jumpTo({ center: centre as [number, number], zoom: 14 }),
			at
		);
		const firstRow = card.getByTestId('annotation-row').first();
		await firstRow.click();
		await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');

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

		const drawn = (await leaderPoints(page)) as { x: number; y: number }[];
		expect(drawn, 'more than one line was drawn for one open row').toHaveLength(3);
		const pane = (await page.getByTestId('reader-map-pane').boundingBox())!;
		const projected = await page.evaluate(
			(centre) => window.ballastellaReaderMap!.map.project(centre as [number, number]),
			at
		);
		const pinScale: Record<string, number> = { small: 0.5, medium: 0.7, large: 0.95 };
		const markerSize = (collection.features[0].properties['marker-size'] ?? 'medium') as string;
		const pinHeight = Math.round(48 * (pinScale[markerSize] ?? 0.7));
		const leaderMiss = (points: { x: number; y: number }[], at: { x: number; y: number }) => {
			const target = { x: pane.x + at.x, y: pane.y + at.y - pinHeight / 2 };
			const shorten = pinHeight / 2 + 2;
			const stub = points[1]!;
			const run = Math.hypot(target.x - stub.x, target.y - stub.y);
			return Math.hypot(
				points[2]!.x - (target.x - ((target.x - stub.x) * shorten) / run),
				points[2]!.y - (target.y - ((target.y - stub.y) * shorten) / run)
			);
		};
		expect(
			leaderMiss(drawn, projected),
			'the leader’s canvas end is not where map.project() puts the coordinate on disk'
		).toBeLessThan(2);

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
		const movedPoints = followed.points!.split(' ').map((pair) => {
			const [x, y] = pair.split(',').map(Number);
			return { x: followed.origin.x + (x as number), y: followed.origin.y + (y as number) };
		});
		expect(
			leaderMiss(movedPoints, followed.projected),
			'the leader stayed where the camera left it, so it is not following the map'
		).toBeLessThan(2);

		await expect(leaderLayer(page)).toHaveAttribute('aria-hidden', 'true');

		const viewport = page.viewportSize()!;
		await page.setViewportSize({ width: 800, height: viewport.height });
		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
		await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
		await page.setViewportSize(viewport);
		await expect.poll(() => leaderIsDrawn(page)).toBe('yes');
	});

	test('a Layer whose kind this build cannot draw is listed and says so (ADR-0014)', async ({
		page
	}) => {
		await openSite(
			page,
			oneProject({
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

		const row = layerRow(page, 'l-future');
		await expect(row).toContainText('Notes on the sheet itself');
		await expect(row.getByTestId('layer-kind')).toContainText('image-space-annotation');
		await expectDrawn(page, 1);

		const opened = await openLayerRow(page, row);
		await expect(opened.getByTestId('layer-foreign-note')).toContainText(
			'nothing of it is drawn on the map'
		);
		await expectNothingEditable(page);
	});
});

test.describe('a Published Site draws the author’s Labels', () => {
	const WORDS = 'Zuiderzee';
	const TEXT_COLOUR = '#ffffff';
	const CHIP_COLOUR = '#1976d2';

	const LABEL_AT = {
		small: [4.9, 52.42] as [number, number],
		medium: [4.9, 52.4] as [number, number],
		large: [4.9, 52.38] as [number, number]
	};

	const labelId = (size: keyof typeof LABEL_AT) => `a-label-${size}`;

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

	const labelledProject = (): SiteFiles =>
		oneProject({
			baseMap: null,
			annotations: [
				labelFeature('small'),
				labelFeature('medium'),
				labelFeature('large', { description: 'Silted by 1600, and drained in 1932.' }),
				annotation({ id: 'a-pin', title: 'Haarlemmerpoort', coordinates: [4.885, 52.37] })
			]
		});

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

	test('draws every Label from the Label bucket as its file states, and reads a clicked one with nothing to edit', async ({
		page
	}) => {
		const { served } = await openSite(page, labelledProject());

		await expect
			.poll(() => paintedAt(page, LABEL_AT.medium), { timeout: 30_000 })
			.toContainEqual(expect.objectContaining({ id: labelId('medium'), layer: bucket('label') }));

		for (const size of ['small', 'medium', 'large'] as const) {
			const painted = await paintedAt(page, LABEL_AT[size]);
			expect(painted).toContainEqual({
				id: labelId(size),
				layer: bucket('label'),
				title: WORDS,
				'marker-size': size,
				'marker-color': TEXT_COLOUR,
				fill: CHIP_COLOUR
			});
			expect(new Set(painted.map((hit) => hit.layer))).toEqual(new Set([bucket('label')]));
			expect(await paintedAt(page, LABEL_AT[size], 200)).toEqual([]);
		}

		const chips = {
			small: await labelChip(page, LABEL_AT.small, labelId('small')),
			medium: await labelChip(page, LABEL_AT.medium, labelId('medium')),
			large: await labelChip(page, LABEL_AT.large, labelId('large'))
		};
		expect(chips.small.width).toBeGreaterThan(0);
		expect(chips.small.width).toBeLessThan(chips.medium.width);
		expect(chips.medium.width).toBeLessThan(chips.large.width);
		expect(chips.large.colours).toContain(CHIP_COLOUR);
		expect(chips.large.colours).toContain(TEXT_COLOUR);

		const face = await openAnnotationFromMap(page, LABEL_AT.large, labelId('large'));

		await expect(
			layerRow(page, ANNOTATION_LAYER_ID).getByTestId('layer-disclosure')
		).toHaveAttribute('aria-expanded', 'true');
		const selected = page.locator('[data-testid="annotation-row"][aria-expanded="true"]');
		await expect(selected).toHaveCount(1);
		await expect(selected).toHaveAttribute('data-annotation-id', labelId('large'));

		await expect(page.getByTestId('annotation-inspector-name')).toHaveText(WORDS);
		await expect(page.getByTestId('annotation-inspector-shape')).toHaveText('label');
		await expect(face).toContainText('Silted by 1600');

		await expectNoAnnotationEditing(page);

		await page
			.locator(`[data-testid="annotation-row"][data-annotation-id="${labelId('small')}"]`)
			.click();
		await expect(selected).toHaveAttribute('data-annotation-id', labelId('small'));
		await expect(page.getByTestId('annotation-description-text')).toHaveText('No description.');

		expect(served.failures).toEqual([]);
	});
});

test.describe('the Base Map a Reader sees', () => {
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

	const roadsInStyle = (page: Page) =>
		page.evaluate(() =>
			window
				.ballastellaReaderMap!.map.getStyle()
				.layers.some((layer) => String(layer.id).startsWith('roads_'))
		);

	const paint = (page: Page) =>
		page.evaluate(() =>
			JSON.stringify(
				window
					.ballastellaReaderMap!.map.getStyle()
					.layers.map((layer) => ('paint' in layer ? layer.paint : null))
			)
		);

	test('starts on the author’s Base Map, not on the deployment’s default', async ({ page }) => {
		await openSite(
			page,
			oneProject({
				projectOverrides: {
					baseMapAppearance: { streets: false, relief: false, highContrast: true }
				}
			})
		);
		await openBaseMapOptions(page);

		await expect(drawSwitch(page, 'Streets')).not.toBeChecked();
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		expect(await roadsInStyle(page)).toBe(false);
	});

	test('offers the catalog that travelled with the site, not this build’s (ADR-0020)', async ({
		page
	}) => {
		const travelled = {
			entries: [
				{
					id: 'a-deployment-of-its-own',
					label: 'Somebody else’s Base Map',
					needsNetwork: false,
					archive: 'base-map/amsterdam-centre.pmtiles'
				},
				{
					id: 'and-a-second-of-its-own',
					label: 'Somebody else’s other Base Map',
					needsNetwork: true,
					archive: 'https://tiles.example.invalid/somebody-elses.pmtiles'
				}
			],
			defaultId: 'a-deployment-of-its-own',
			initialView: { center: [4.9041, 52.3676], zoom: 13 },
			glyphs: 'base-map/fonts/{fontstack}/{range}.pbf',
			sprite: 'base-map/sprites/{flavor}',
			attribution: '© OpenStreetMap'
		};
		await openSite(page, oneProject({}, { baseMap: travelled }));

		await openBaseMapOptions(page);
		expect(await options(page)).toEqual([
			{ value: 'a-deployment-of-its-own', text: 'Somebody else’s Base Map', needsNetwork: false },
			{
				value: 'and-a-second-of-its-own',
				text: 'Somebody else’s other Base Map',
				needsNetwork: true
			}
		]);
		await expect(page.getByTestId('base-map-switcher')).toHaveValue('a-deployment-of-its-own');
		await expectDrawn(page, 2);
	});

	test('two Published Sites on different paths of one origin do not share a preference', async ({
		page
	}) => {
		const directory = await assemblePublishedSite(oneProject());
		const origin = await mkdtemp(path.join(tmpdir(), 'ballastella-origin-'));
		await symlink(directory, path.join(origin, 'tracy'), 'dir');
		await symlink(directory, path.join(origin, 'sam'), 'dir');
		const server = await serveDirectory(origin);
		toClose.push({
			close: async () => {
				await server.close();
				await rm(origin, { recursive: true, force: true });
				await rm(directory, { recursive: true, force: true });
			}
		});

		const tracy = `${server.url}tracy/?p=amsterdam-1625`;
		const sam = `${server.url}sam/?p=amsterdam-1625`;

		await page.goto(tracy);
		await mapReady(page);
		await openBaseMapOptions(page);
		await drawSwitch(page, 'High contrast').click();
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();

		await page.goto(sam);
		await mapReady(page);
		await openBaseMapOptions(page);
		await expect(drawSwitch(page, 'High contrast')).not.toBeChecked();
		await drawSwitch(page, 'Streets').click();
		await expect(drawSwitch(page, 'Streets')).not.toBeChecked();

		await page.goto(tracy);
		await mapReady(page);
		await openBaseMapOptions(page);
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		await expect(drawSwitch(page, 'Streets')).toBeChecked();
		await page.goto(sam);
		await mapReady(page);
		await openBaseMapOptions(page);
		await expect(drawSwitch(page, 'Streets')).not.toBeChecked();
		await expect(drawSwitch(page, 'High contrast')).not.toBeChecked();

		expect(await storedBaseMaps(page)).toEqual({
			[`ballastella.baseMap:${server.url}tracy/`]: JSON.stringify({
				appearance: { streets: true, relief: false, highContrast: true, imagery: false }
			}),
			[`ballastella.baseMap:${server.url}sam/`]: JSON.stringify({
				appearance: { streets: false, relief: false, highContrast: false, imagery: false }
			})
		});
	});

	test('a low-contrast-sensitive Reader can mute the Base Map, and keep the author’s map', async ({
		page
	}) => {
		await openSite(
			page,
			oneProject({
				projectOverrides: {
					baseMapAppearance: { streets: false, relief: false, highContrast: false }
				}
			})
		);

		await openBaseMapOptions(page);
		await expect(drawSwitch(page, 'High contrast')).not.toBeChecked();
		const before = await paint(page);

		await drawSwitch(page, 'High contrast').click();

		await expect.poll(() => paint(page)).not.toBe(before);
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		await expect(drawSwitch(page, 'Streets')).not.toBeChecked();
		expect(await roadsInStyle(page)).toBe(false);
	});

	test('choosing a theme changes the Base Map flavor in the same action (ADR-0016)', async ({
		page
	}) => {
		await openSite(page, oneProject());

		const before = await paint(page);
		const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);

		await page.getByRole('button', { name: 'Theme', exact: true }).click();
		await page.getByTestId('theme-option-carto-dark').click();

		await expect
			.poll(() => page.evaluate(() => document.documentElement.dataset.theme))
			.not.toBe(themeBefore);
		await mapReady(page);
		await expect.poll(() => paint(page)).not.toBe(before);
	});
});

test.describe('a Map Image read unwarped', () => {
	for (const entry of ['by link', 'by loading the URL'] as const) {
		test(`opens over HTTP ${entry}, and the navigation throws nothing`, async ({ page, seen }) => {
			const site = await servedSite(oneProject());
			const served = site.sites[0]!;
			await writeSiteFile(
				site.directory,
				`images/${IMAGE_ID}/info.json`,
				infoJson(`${served.url}images/${IMAGE_ID}`)
			);
			const url = `${served.url}?p=amsterdam-1625`;
			let from = 0;
			if (entry === 'by link') {
				await page.goto(url);
				await mapReady(page);
				from = seen.requests.length;
				const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
				await card.getByTestId('read-as-document').click();
			} else {
				await page.goto(`${url}&unwarped=${MAP_LAYER_ID}`);
			}

			const view = page.getByTestId('unwarped-view');
			await expect(view).toBeVisible();
			await expect(view.getByRole('heading', { name: 'Blaeu’s plan of 1625' })).toBeVisible();
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
			expect(seen.requests.filter((request) => request.url.includes('unset.invalid'))).toEqual([]);
			expect(seen.failures, 'the navigation into the unwarped view').toEqual([]);

			await page.getByTestId('back-to-project').click();
			await mapReady(page);
			await expect(page.getByTestId('reader-map-pane')).toBeVisible();
			expect(seen.failures, 'the navigation back to the map').toEqual([]);
		});
	}

	test('refuses plainly, and requests nothing, when the pyramid carries no web address', async ({
		page,
		seen
	}) => {
		await openSite(page, oneProject(), {
			at: `?p=amsterdam-1625&unwarped=${MAP_LAYER_ID}`
		});

		const problem = page.getByTestId('unwarped-problem');
		await expect(problem).toContainText('cannot be opened on its own');
		await expect(problem).toContainText('giving Ballastella the address');
		await expect(page.getByTestId('unwarped-view')).toBeHidden();
		expect(seen.requests.filter((request) => request.url.includes('unset.invalid'))).toEqual([]);
		await page.getByTestId('back-to-project').click();
		await mapReady(page);
	});

	test('says so when the image behind a Map Image is not on the site', async ({ page }) => {
		await openSite(page, oneProject({ withoutPyramid: true }), {
			at: `?p=amsterdam-1625&unwarped=${MAP_LAYER_ID}`
		});

		await expect(page.getByTestId('unwarped-problem')).toContainText('not on this site');
		const bar = page.getByTestId('navigation-bar');
		await expect(bar.getByTestId('back-to-project')).toBeVisible();
		await expect(bar.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
	});
});

test.describe('a Published Site that is not entirely well', () => {
	const NOT_IN_SITE_NOTICE =
		'This site does not carry the Base Map’s labels and symbols, so the modern reference ' +
		'map here carries no place names at all, and the author’s Labels are not drawn. The Map ' +
		'Images and the other Annotations — Pins, Lines and Shapes — are not affected.';

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

	const drawnBuckets = (page: Page): Promise<string[]> =>
		page.evaluate(() => [
			...new Set(
				(window.ballastellaReaderMap?.map.queryRenderedFeatures() ?? [])
					.filter((feature) => feature.layer.id.startsWith('ballastella-layer-'))
					.map((feature) => feature.layer.id)
			)
		]);

	test('falls back with a quiet notice when the Base Map id is absent from the catalog', async ({
		page
	}) => {
		await watchNoticeArrivals(page, 'base-map-notice');
		await openSite(page, oneProject({ baseMap: 'a-base-map-from-another-deployment' }));

		await expect(page.getByTestId('base-map-notice')).toContainText(
			'a-base-map-from-another-deployment'
		);
		await expect(page.getByTestId('base-map-notice')).toContainText('not available here');
		expect(
			await noticeArrivals(page),
			'the fallback sentence arrived with the element rather than as a change'
		).toEqual([
			{ kind: 'insert', text: '' },
			{ kind: 'change', text: expect.stringContaining('not available here') }
		]);
		await expectDrawn(page, 2);
	});

	test('draws the work over a network Base Map without shipping a tile archive', async ({
		page,
		seen
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
		const { served } = await openSite(
			page,
			oneProject({ annotations: everyKind() }, { baseMapAssetsBundled: true })
		);

		await expect(page.getByTestId('base-map-not-in-site')).toHaveText('');
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		await openBaseMapOptions(page);
		await expect(page.getByTestId('base-map-switcher')).toHaveCount(0);
		await expect(page.getByTestId('base-map-appearance')).toBeVisible();
		await expectDrawn(page, 2);
		expect(networkArchiveRequests).toBeGreaterThan(0);
		expect(
			seen.requests.filter(
				(request) => request.url.startsWith(served.url) && request.url.endsWith('.pmtiles')
			)
		).toEqual([]);

		await expect
			.poll(() => drawnBuckets(page), { timeout: 30_000 })
			.toEqual(expect.arrayContaining([bucket('label'), bucket('point')]));

		expect(served.failures).toEqual([]);
	});

	test('says so when the site carries no copy of the Base Map’s labels and symbols', async ({
		page,
		seen
	}) => {
		const { served } = await openSite(
			page,
			oneProject({ annotations: everyKind() }, { baseMapAssetsBundled: false }),
			{ withoutBaseMap: true }
		);

		const notice = page.getByTestId('base-map-not-in-site');
		await expect(notice).toHaveText(NOT_IN_SITE_NOTICE);
		await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
		await expectDrawn(page, 2);

		await expect
			.poll(() => drawnBuckets(page), { timeout: 30_000 })
			.toEqual(expect.arrayContaining([bucket('point'), bucket('line-solid'), bucket('fill')]));
		expect(await drawnBuckets(page)).not.toContain(bucket('label'));
		expect(await layersOrder(page)).not.toContain(bucket('label'));
		expect(seen.requests.filter((request) => request.url.includes('/base-map/'))).toEqual([]);
		expect(served.failures).toEqual([]);
	});

	const UNAVAILABLE_NOTICE = unavailableNotice('Worldwide', ARCHIVE_HOST);

	const refuseArchive = async (page: Page): Promise<void> => {
		await page.unroute(/\.pmtiles$/);
		await refuseBaseMapArchive(page);
	};

	const startOffline = (page: Page) =>
		page.addInitScript(() =>
			Object.defineProperty(window.navigator, 'onLine', { get: () => false })
		);

	const openToOutage = async (page: Page): Promise<Locator> => {
		await openSite(page, oneProject({}, { baseMapAssetsBundled: true }), { ready: false });
		const notice = page.getByTestId('base-map-unavailable');
		await expect(notice).toBeVisible({ timeout: 45_000 });
		return notice;
	};

	test('says so when the Base Map’s archive answers nothing, keeps drawing the work, and withdraws it offline', async ({
		page,
		context
	}) => {
		await refuseArchive(page);
		const notice = await openToOutage(page);

		await expect(notice.locator('p')).toHaveText(UNAVAILABLE_NOTICE);
		await expect(notice).toHaveAttribute('role', 'alert');
		await expect(notice).not.toHaveAttribute('aria-live', /.*/);
		await expect(page.getByTestId('base-map-not-in-site')).toHaveText('');

		await mapReady(page);
		await expectDrawn(page, 2);
		await expect.poll(() => workDrawn(page), { timeout: 60_000 }).toBeGreaterThan(0);
		await expect.poll(() => tilesOnceFitted(page), { timeout: 60_000 }).toBeGreaterThan(0);
		expect(await baseMapDrawn(page)).toBe(false);
		await expect(baseMapOptionsButton(page)).toBeVisible();

		await context.setOffline(true);
		await expect(notice).toHaveCount(0);
		await expectDrawn(page, 2);

		await context.setOffline(false);
		await expect(notice).toBeVisible();
	});

	for (const [title, bundled] of [
		['makes no claim about the Base Map when the page is opened with no connection', true],
		['says the same thing about its missing labels with no connection at all', false]
	] as const) {
		test(title, async ({ page }) => {
			await startOffline(page);
			await refuseArchive(page);

			await openSite(page, oneProject({}, { baseMapAssetsBundled: bundled }), {
				withoutBaseMap: !bundled
			});

			await expect(page.getByTestId('base-map-not-in-site')).toHaveText(
				bundled ? '' : NOT_IN_SITE_NOTICE
			);
			expect(await baseMapDrawn(page)).toBe(false);
			await page.waitForTimeout(3_000);
			await expect(page.getByTestId('base-map-unavailable')).toHaveCount(0);
			await expectDrawn(page, 2);
		});
	}

	test('does not blame the Base Map for a failure that is not the Base Map’s', async ({
		page,
		seen
	}) => {
		await page.addInitScript(() => {
			const seenNotice = { at: false };
			(window as unknown as { ballastellaNoticeSeen: { at: boolean } }).ballastellaNoticeSeen =
				seenNotice;
			new MutationObserver(() => {
				if (document.querySelector('[data-testid="base-map-unavailable"]')) seenNotice.at = true;
			}).observe(document, { childList: true, subtree: true });
		});
		await page.route(/\/base-map\/sprites\//, (route) =>
			route.fulfill({ status: 404, body: 'not here' })
		);

		await openSite(page, oneProject({}, { baseMapAssetsBundled: true }));

		await expect.poll(() => baseMapDrawn(page), { timeout: 60_000 }).toBe(true);
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
	});

	test('says both things when a site with none of those files also meets an outage', async ({
		page
	}) => {
		await refuseArchive(page);

		const site = await servedSite(oneProject({}, { baseMapAssetsBundled: false }), {
			withoutBaseMap: true
		});
		await watchNoticeArrivals(page, 'base-map-not-in-site');

		await page.goto(`${site.sites[0]!.url}?p=amsterdam-1625`);
		await expect(page.getByTestId('base-map-unavailable')).toBeVisible({ timeout: 45_000 });
		await mapReady(page);

		const notInSite = page.getByTestId('base-map-not-in-site');
		await expect(notInSite).toBeVisible();
		await expect(notInSite).toHaveAttribute('aria-live', 'polite');
		await expect(notInSite).toHaveAttribute('aria-atomic', 'true');
		await expect(notInSite).not.toHaveAttribute('role', /.*/);
		expect(
			await noticeArrivals(page),
			'the missing-labels sentence arrived with the element rather than as a change'
		).toEqual([
			{ kind: 'insert', text: '' },
			{ kind: 'change', text: expect.stringContaining('no place names at all') }
		]);
		await expect(notInSite).toHaveText(NOT_IN_SITE_NOTICE);
		await expect(page.getByTestId('base-map-unavailable').locator('p')).toHaveText(
			UNAVAILABLE_NOTICE
		);

		await expectDrawn(page, 2);
	});

	test('keeps the outage notice up when the archive answers its header and then stops, and takes it down when it answers again', async ({
		page
	}) => {
		const archive = await routePartialBaseMapArchive(page);
		const notice = await openToOutage(page);
		await mapReady(page);

		await page.waitForTimeout(5_000);
		await expect(notice).toBeVisible();
		await expect(notice.locator('p')).toHaveText(UNAVAILABLE_NOTICE);

		expect(await baseMapDrawn(page)).toBe(false);
		expect(archive.tileRangesAsked()).toBeGreaterThan(0);
		await expectDrawn(page, 2);

		archive.serve();

		let step = 0;
		const nudge = () =>
			page.evaluate(
				async (zoom: number) => {
					window.ballastellaReaderMap!.map.jumpTo({ center: [4.9041, 52.3676], zoom });
					await new Promise((resolve) => setTimeout(resolve, 500));
				},
				12 + (step++ % 2)
			);
		await expect
			.poll(
				async () => {
					await nudge();
					return baseMapDrawn(page);
				},
				{ timeout: 60_000 }
			)
			.toBe(true);
		await expect
			.poll(
				async () => {
					await nudge();
					return notice.count();
				},
				{ timeout: 60_000 }
			)
			.toBe(0);
		await expectDrawn(page, 2);
	});

	test('withdraws the claim when the Reader switches to a Base Map it has not asked yet', async ({
		page
	}) => {
		const archive = await routePartialBaseMapArchive(page);
		const notice = await openToOutage(page);
		await expect(notice.locator('p')).toContainText('Worldwide');

		archive.hang();
		await openBaseMapOptions(page);
		await drawSwitch(page, 'High contrast').click();

		await expect(notice).toHaveCount(0);
		await page.waitForTimeout(3_000);
		await expect(notice).toHaveCount(0);
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		await page.unrouteAll({ behavior: 'ignoreErrors' });
	});

	test('refuses a Project from a newer version plainly (ADR-0010), and names a ?p= that is not here', async ({
		page
	}) => {
		const { served } = await openSite(
			page,
			oneProject({ projectOverrides: { formatVersion: 99 } }),
			{ ready: false }
		);

		const problem = page.getByTestId('project-problem');
		await expect(problem).toContainText('newer version of Ballastella');
		await expect(problem).toContainText('format 99');
		await expect(page.getByTestId('reader-map-pane')).toBeHidden();
		await expect(page.getByTestId('all-projects')).toBeVisible();

		await page.goto(`${served.url}?p=not-a-project`);
		await expect(problem).toContainText('not-a-project');
		await expect(page.getByTestId('all-projects')).toBeVisible();
	});

	test('tells a Reader the site has no list of Projects yet, rather than throwing', async ({
		page
	}) => {
		await openSite(page, {}, { at: '' });

		await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
		await expect(page.getByTestId('site-problem')).toContainText('has no list of Projects yet');
	});

	test('warns that a referenced Map Image leaves a Reader with no network seeing nothing', async ({
		page
	}) => {
		await openSite(page, oneProject(REFERENCED), { ready: false });

		await expect(page.getByTestId('project-needs-network')).toContainText('Blaeu’s plan of 1625');
		await expect(page.getByTestId('project-needs-network')).toContainText('network');

		const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await expect(card.getByTestId('layer-image-mode')).toHaveCount(0);
		await expect(page.locator('[data-image-mode]')).toHaveCount(0);
	});

	const cachedTiles = (page: Page): Promise<number> =>
		page.evaluate(
			(id) =>
				(window.ballastellaReaderMap?.warped[id]?.renderer?.tileCache?.getCachedTiles?.() ?? [])
					.length,
			MAP_LAYER_ID
		);

	const redrawMapLayer = async (page: Page): Promise<void> => {
		await layerVisible(page, MAP_LAYER_ID).uncheck();
		await expectDrawn(page, 1);
		await layerVisible(page, MAP_LAYER_ID).check();
		await expectDrawn(page, 2, 60_000);
	};

	const openDrawnWithoutNotice = async (page: Page) => {
		const { served } = await openSite(page, oneProject());
		await expectDrawn(page, 2, 60_000);
		const notice = page.getByTestId('map-image-tiles-unavailable');
		await expect(notice).toHaveCount(0);
		return { host: new URL(served.url).host, notice };
	};

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

	const stillThereAfter = async (locator: Locator): Promise<boolean> =>
		locator
			.waitFor({ state: 'detached', timeout: 8_000 })
			.then(() => false)
			.catch(() => true);

	const TILE_ROUTE = `**/images/${IMAGE_ID}/**`;
	const INFO_ROUTE = `**/images/${IMAGE_ID}/info.json`;

	test('tells a Reader when a Map Image’s tiles stop arriving, and keeps what arrived', async ({
		page
	}) => {
		const { host, notice } = await openDrawnWithoutNotice(page);
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);

		await refuseEveryOtherTile(page);
		await redrawMapLayer(page);

		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice).toHaveAttribute('role', 'alert');
		await expect(notice.locator('p')).toHaveText(
			tilesUnavailableNotice('Blaeu’s plan of 1625', host)
		);

		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);
		await expect(notice).toBeVisible();
		await expectDrawn(page, 2);
		await expect(page.getByTestId('fit-to-project')).toBeVisible();
		await expect.poll(() => workDrawn(page), { timeout: 60_000 }).toBeGreaterThan(0);

		await page.unroute(TILE_ROUTE);
		await askForMoreTiles(page, 1);
		expect(
			await stillThereAfter(notice),
			'a refused tile cell is not re-requested, so its notice stays'
		).toBe(true);

		await redrawMapLayer(page);
		await expect(notice).toHaveCount(0, { timeout: 45_000 });
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);
	});

	test('tells a server that is failing apart from a connection that is gone, and takes the notice down when the record answers', async ({
		page
	}) => {
		const { host, notice } = await openDrawnWithoutNotice(page);

		await page.route(INFO_ROUTE, (route) =>
			route.fulfill({ status: 503, body: 'the site is having a bad afternoon' })
		);
		await redrawMapLayer(page);

		await expect(notice).toBeVisible({ timeout: 45_000 });
		await expect(notice.locator('p')).toHaveText(
			tilesServerErrorNotice('Blaeu’s plan of 1625', host, 503)
		);
		await expect(layerStack(page)).toContainText('Warehouses');
		await expect.poll(() => workDrawn(page), { timeout: 60_000 }).toBeGreaterThan(0);

		await page.unroute(INFO_ROUTE);
		await page.route(INFO_ROUTE, (route) => route.abort());
		await redrawMapLayer(page);
		await expect(notice.locator('p')).toHaveText(
			tilesUnavailableNotice('Blaeu’s plan of 1625', host),
			{ timeout: 45_000 }
		);

		await page.unroute(INFO_ROUTE);
		await expect(notice).toHaveCount(0, { timeout: 45_000 });
		await expect.poll(() => cachedTiles(page), { timeout: 60_000 }).toBeGreaterThan(0);
	});
});

test.describe('a Reader on a phone', () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test('never scrolls sideways, keeps the links back to the editor readable, and every Reader control is usable', async ({
		page
	}) => {
		const site = await servedSite(writtenByEditor());

		for (const where of ['', '?p=amsterdam-1625'] as const) {
			await page.goto(site.sites[0]!.url + where);

			const bar = page.getByTestId('navigation-bar');
			await expect(bar.getByTestId('site-name')).toBeVisible();
			if (where === '') {
				await expect(page.getByRole('heading', { level: 1, name: 'Front Page' })).toBeVisible();
				await expect(page.getByTestId('front-page-projects')).toContainText('Amsterdam 1625');
			} else {
				await expect(bar.getByTestId('page-heading')).toHaveText('Amsterdam 1625');
				await mapReady(page);
			}

			const menu = bar.getByTestId('bar-menu');
			await expect(menu).toBeVisible();
			await expect(bar.getByRole('link', { name: RETURN_LINK })).toBeHidden();

			await menu.focus();
			await page.keyboard.press('Enter');
			await expect(menu).toHaveAttribute('aria-expanded', 'true');
			await expect(bar.getByTestId('theme-toggle')).toBeVisible();
			await expect(bar.getByTestId('all-projects')).toBeVisible();
			if (where === '') {
				await bar.getByTestId('theme-toggle').click();
				const option = page.getByTestId('theme-option-nord');
				await expect(option).toBeVisible();
				const optionBox = (await option.boundingBox())!;
				expect(optionBox.x).toBeGreaterThanOrEqual(-1);
				expect(optionBox.x + optionBox.width).toBeLessThanOrEqual(376);
				await option.click();
				await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
			}

			const link = bar.getByRole('link', { name: RETURN_LINK });
			await expect(link).toBeVisible();
			const box = (await link.boundingBox())!;
			expect(box.width, `link width at ${where || 'the Front Page'}`).toBeLessThanOrEqual(375);
			expect(box.x, `link off screen at ${where || 'the Front Page'}`).toBeGreaterThanOrEqual(-1);

			expect(
				await page.evaluate(() => document.documentElement.scrollWidth),
				`horizontal scroll at ${where || 'the Front Page'}`
			).toBe(await page.evaluate(() => document.documentElement.clientWidth));
		}

		await page.keyboard.press('Escape');
		await openBaseMapOptions(page);
		await drawSwitch(page, 'High contrast').click();
		await expect(drawSwitch(page, 'High contrast')).toBeChecked();
		await baseMapOptionsButton(page).click();
		await layerVisible(page, MAP_LAYER_ID).uncheck();
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
		const card = await openLayerRow(page, layerRow(page, MAP_LAYER_ID));
		await card.getByTestId('layer-opacity').fill('0.5');
		await expect(card.getByTestId('layer-opacity-value')).toHaveText('50%');

		await expectNothingEditable(page);
	});

	test('tapping an Annotation reads it in a sheet at the bottom of the map, with the same subtraction and no leader', async ({
		page
	}) => {
		await openSite(
			page,
			oneProject({
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
						description: `Rebuilt in **1663** after the fire, and rebuilt again a century later.\n\n${Array.from(
							{ length: 20 },
							(_, at) => `Paragraph ${at + 1}: the quay, the warehouses, and the survey of 1625.`
						).join('\n\n')}`
					})
				]
			})
		);
		const reading = await openAnnotationFromMap(page);

		await expect(page.getByTestId('annotation-inspector-name')).toHaveText('The east warehouse');
		await expect(reading).toContainText('Rebuilt in 1663');
		await expect(reading.locator('strong')).toHaveText('1663');

		const tapped = page.locator('[data-testid="annotation-row"][aria-expanded="true"]');
		await expect(tapped).toHaveAttribute('data-annotation-id', TAPPED_ANNOTATION_ID);
		await expect(tapped).toHaveCount(1);

		expect(
			await tapped.evaluate((row) => row.closest('li')!.children.length),
			'the selected row opened something inside itself'
		).toBe(1);

		const sheet = (await page.getByTestId('annotation-inspector').boundingBox())!;
		expect(sheet.width).toBeLessThanOrEqual(375);
		expect(sheet.x).toBeGreaterThanOrEqual(-1);
		const pane = page.getByTestId('reader-map-pane');
		const paneBox = (await pane.boundingBox())!;
		expect(sheet.x, 'the sheet does not reach the pane’s left edge').toBeLessThan(paneBox.x + 16);
		expect(sheet.x + sheet.width, 'the sheet does not reach the pane’s right edge').toBeGreaterThan(
			paneBox.x + paneBox.width - 16
		);
		expect(
			sheet.y + sheet.height,
			'the sheet is not anchored to the bottom of the pane'
		).toBeGreaterThan(paneBox.y + paneBox.height - 128);
		expect(sheet.y, 'the sheet took the whole pane').toBeGreaterThan(paneBox.y + 24);
		const attribution = page.locator('.maplibregl-ctrl-attrib');
		await expect(attribution).toBeVisible();
		const licence = (await attribution.boundingBox())!;
		expect(sheet.y + sheet.height, 'the sheet covered the Base Map’s attribution').toBeLessThan(
			licence.y
		);

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

		expect(
			await reading.evaluate((element) => ({
				scrolls: element.scrollHeight > element.clientHeight,
				overflow: getComputedStyle(element).overflowY
			})),
			'the description is not scrolling inside the sheet'
		).toEqual({ scrolls: true, overflow: 'auto' });
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
		await reading.hover();
		const restingHeader = await headerOffset();
		await page.mouse.wheel(0, 120);
		await expect.poll(() => reading.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		expect(await headerOffset(), 'the sheet scrolled its own header away').toBe(restingHeader);

		await expect(page.getByTestId('annotation-inspector-tabs')).toHaveCount(0);
		await expect(page.getByTestId('annotation-inspector-tab-style')).toHaveCount(0);
		await expect(page.getByTestId('annotation-edit-text')).toHaveCount(0);
		await expect(page.getByTestId('annotation-delete')).toHaveCount(0);
		await expectNothingEditable(page);

		await expect.poll(() => leaderIsDrawn(page)).toBe('no');
		expect(await leaderPoints(page)).toBeNull();
		expect(
			await leaderLayer(page).evaluate((element) => ({
				points: element.querySelector('polyline')!.getAttribute('points'),
				display: getComputedStyle(element).display
			})),
			'the leader was hidden by CSS rather than refused by leaderPath'
		).toEqual({ points: null, display: 'block' });

		const columnsOverlap = async (): Promise<boolean> => {
			const column = (await page.getByTestId('layer-view-status').boundingBox())!;
			const map = (await pane.boundingBox())!;
			return column.x < map.x + map.width && map.x < column.x + column.width;
		};
		await page.setViewportSize({ width: STACKS_BELOW, height: 900 });
		await expect.poll(columnsOverlap, 'two columns at the breakpoint').toBe(false);
		await page.setViewportSize({ width: STACKS_BELOW - 1, height: 900 });
		await expect.poll(columnsOverlap, 'still two columns one pixel below it').toBe(true);
	});
});

test.describe('a Reader using a keyboard', () => {
	test('reaches and operates every control by tabbing, and hears what changed', async ({
		page
	}) => {
		await openSite(page, oneProject());

		const tabTo = async (locator: Locator, from?: Locator): Promise<void> => {
			await (from ?? page.getByTestId('all-projects')).focus();
			for (let stop = 0; stop < 40; stop += 1) {
				await page.keyboard.press('Tab');
				if (await locator.evaluate((element) => element === document.activeElement)) return;
			}
			throw new Error(`could not reach ${await locator.evaluate((element) => element.outerHTML)}`);
		};

		await tabTo(baseMapOptionsButton(page));
		await tabTo(layerVisible(page, ANNOTATION_LAYER_ID));
		await page.keyboard.press('Space');
		await expect(page.getByTestId('layer-view-status')).toContainText('hidden');
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

		const disclosure = layerRow(page, MAP_LAYER_ID).getByTestId('layer-disclosure');
		await tabTo(disclosure);
		await page.keyboard.press('Enter');
		await expect(disclosure).toHaveAttribute('aria-expanded', 'true');

		const opacity = page.getByTestId('layer-opacity');
		await tabTo(opacity, disclosure);
		const before = await opacity.inputValue();
		await page.keyboard.press('ArrowLeft');
		expect(await opacity.inputValue()).not.toBe(before);
		await expect(page.getByTestId('layer-view-status')).toContainText('%');

		await tabTo(page.getByTestId('read-as-document'), opacity);
		await page.keyboard.press('Enter');
		await expect(page).toHaveURL(new RegExp(`unwarped=${MAP_LAYER_ID}`));
		await expect(page.getByTestId('back-to-project')).toBeVisible();
	});

	test('opens the Annotation at the centre of the map with Enter, and closes it with Escape', async ({
		page
	}) => {
		await openSite(
			page,
			oneProject({
				annotations: [annotation({ title: 'The east warehouse', description: 'Rebuilt in 1663.' })]
			})
		);

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

		await page.getByTestId('annotation-inspector-close').click();
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect
			.poll(() => row.evaluate((element) => element === document.activeElement))
			.toBe(true);

		await page.keyboard.press('Enter');
		await expect(row).toHaveAttribute('aria-expanded', 'true');
		await page.keyboard.press('Escape');
		await expect(row).toHaveAttribute('aria-expanded', 'false');
		await expect(page.getByTestId('annotation-inspector')).toHaveCount(0);
	});
});

const BOSTON_PINS: readonly [number, number][] = [
	[-71.0912, 42.3601],
	[-71.0656, 42.3554],
	[-71.0402, 42.3522]
];
const BOSTON_CENTRE = { lng: -71.0657, lat: 42.35615 };
const DEPLOYMENT_VIEW = { lng: 0, lat: 20, zoom: 1 };
const BOSTON_SHEET = { west: -71.1, east: -71.04, south: 42.34, north: 42.37 };
const BOSTON_SHEET_CENTRE = { lng: -71.07, lat: 42.355 };

function pinnedProject(pins: readonly [number, number][]): SiteFiles {
	return oneProject({
		annotations: pins.map((coordinates, index) =>
			annotation({ id: `1111111${index}-1111-4111-8111-111111111111`, coordinates })
		),
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
	test('frames on the work at both base paths as the editor does, holds still when a Layer is hidden, and re-frames when asked', async ({
		page
	}) => {
		const site = await servedSite(pinnedProject(BOSTON_PINS));

		for (const served of site.sites) {
			await page.goto(served.url + '?p=amsterdam-1625');
			await mapReady(page);
			await openingSettled(page);

			const at = await readerViewport(page);
			expect(at.lng, `at ${served.prefix || '/'}`).toBeCloseTo(BOSTON_CENTRE.lng, 3);
			expect(at.lat, `at ${served.prefix || '/'}`).toBeCloseTo(BOSTON_CENTRE.lat, 3);
			expect(Math.abs(at.lng - DEPLOYMENT_VIEW.lng)).toBeGreaterThan(50);
			expect(await readerShowing(page, BOSTON_PINS)).toBe(true);
		}

		await expect(page.getByTestId('opening-view')).toContainText('this Project’s own content');

		const parked = { lng: 2.3522, lat: 48.8566, zoom: 11 };
		await page.evaluate(
			(at) => window.ballastellaReaderMap!.map.jumpTo({ center: [at.lng, at.lat], zoom: at.zoom }),
			parked
		);

		await page.getByTestId('layer-visible').first().uncheck();
		await expectDrawn(page, 0);
		await page.getByTestId('layer-visible').first().check();
		await mapReady(page);
		await expectDrawn(page, 1);

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(parked.lng, 6);
		expect(at.lat).toBeCloseTo(parked.lat, 6);
		expect(at.zoom).toBeCloseTo(parked.zoom, 6);

		await page.getByRole('button', { name: 'Frame project' }).click();
		await expect
			.poll(async () => (await readerViewport(page)).lat)
			.toBeCloseTo(BOSTON_CENTRE.lat, 3);
		expect((await readerViewport(page)).lng).toBeCloseTo(BOSTON_CENTRE.lng, 3);
	});

	test('caps the zoom on a Project whose only content is one pin', async ({ page }) => {
		await openSite(page, pinnedProject([BOSTON_PINS[1]!]));
		await openingSettled(page);

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_PINS[1]![0], 4);
		expect(at.zoom).toBeLessThanOrEqual(16);
		expect(at.zoom).toBeCloseTo(16, 4);
	});

	test('frames on a referenced sheet whose Alignment reads, naming the host whose image record does not', async ({
		page
	}) => {
		await libraryIsDown(page);
		await openSite(
			page,
			oneProject({
				...REFERENCED,
				sheetAt: BOSTON_SHEET,
				annotations: []
			})
		);
		await openingSettled(page);

		const problem = layerRow(page, MAP_LAYER_ID).getByTestId('layer-problem');
		await expect(problem).toContainText('Blaeu’s plan of 1625');
		await expect(problem).toContainText('did not answer');
		await expectDrawn(page, 1);
		await expect(layerStack(page)).toContainText('Warehouses');
		expect(await layersOrder(page)).not.toContain(`ballastella-layer-${MAP_LAYER_ID}`);

		const at = await readerViewport(page);
		expect(at.lng).toBeCloseTo(BOSTON_SHEET_CENTRE.lng, 3);
		expect(at.lat).toBeCloseTo(BOSTON_SHEET_CENTRE.lat, 3);
		expect(Math.abs(at.lng - DEPLOYMENT_VIEW.lng)).toBeGreaterThan(50);
		await expect(page.getByTestId('opening-view')).toContainText('this Project’s own content');
	});
});
