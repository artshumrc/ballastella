import { DEFAULT_WORKSPACE, expect, test, type Page } from './support/test.js';

import { routeBaseMapArchive } from './support/editor-deployment.js';
import { asJson } from './support/published-site.js';
import {
	routeGitHubHosts,
	startOnTheHub,
	OUTSIDE_NAMESPACE,
	OWNER,
	REPOSITORY,
	REMOTE
} from './support/github-hosts.js';
import {
	expectNoRemote,
	expectWorkspaceNamed,
	everyByteOf,
	workspaceNames,
	HUB
} from './support/workspace.js';

const AMSTERDAM = 'amsterdam-1625';
const BOSTON = 'boston-1710';

const projectJson = (name: string, imageId: string, annotation: string): string =>
	asJson({
		formatVersion: 1,
		name,
		updatedAt: '2025-03-04T11:22:33.000Z',
		layers: [
			{
				id: 'l1',
				kind: 'annotation',
				name: `${name} notes`,
				visible: true,
				order: 0,
				geojsonRef: annotation,
				defaultStyle: {}
			},
			{
				id: 'l2',
				kind: 'map',
				name: `${name} sheet`,
				visible: true,
				order: 1,
				opacity: 1,
				imageId
			}
		],
		baseMap: null
	});

const FEATURES = '{"type":"FeatureCollection","features":[]}';

const ON_REMOTE: Record<string, string> = {
	'.nojekyll': '',
	'index.html': '<!doctype html><title>Atlas</title>',
	'ballastella-site.json': '{"formatVersion":2,"projects":[]}',

	[`${AMSTERDAM}/project.json`]: projectJson(
		'Amsterdam 1625',
		'map-1',
		'annotations/warehouses.geojson'
	),
	[`${AMSTERDAM}/annotations/warehouses.geojson`]: FEATURES,
	[`${BOSTON}/project.json`]: projectJson('Boston 1710', 'map-2', 'annotations/wharves.geojson'),
	[`${BOSTON}/annotations/wharves.geojson`]: FEATURES,

	'images/map-1/info.json': '{"width":4096,"height":3072}',
	'images/map-1/0,0,256,256/256,256/0/default.jpg': 'stands in for a tile',
	'images/map-2/info.json': '{"width":2048,"height":1536}',
	'images/map-2/0,0,256,256/256,256/0/default.jpg': 'the other Project’s tile',
	'images/map-3/info.json': '{"width":512,"height":512}',
	'alignments/map-1.json': '{"type":"Annotation","id":"map-1"}',
	'alignments/map-2.json': '{"type":"Annotation","id":"map-2"}',
	'alignments/map-3.json': '{"type":"Annotation","id":"map-3"}',
	...Object.fromEntries(OUTSIDE_NAMESPACE.map((path) => [path, `${path}, the scholar's own\n`]))
};

const GEOREFERENCED_MAP_1 = JSON.stringify({
	type: 'Annotation',
	'@context': [
		'http://iiif.io/api/extension/georef/1/context.json',
		'http://iiif.io/api/presentation/3/context.json'
	],
	motivation: 'georeferencing',
	target: {
		type: 'SpecificResource',
		source: { id: 'https://unset.invalid/map-1', type: 'ImageService3', width: 4096, height: 3072 },
		selector: {
			type: 'SvgSelector',
			value:
				'<svg width="4096" height="3072"><polygon points="0,0 4096,0 4096,3072 0,3072" /></svg>'
		}
	},
	body: {
		type: 'FeatureCollection',
		transformation: { type: 'polynomial', options: { order: 1 } },
		features: [
			[100, 100, 4.88, 52.375],
			[3900, 100, 4.92, 52.375],
			[3900, 2900, 4.92, 52.36],
			[100, 2900, 4.88, 52.36]
		].map(([x, y, lng, lat]) => ({
			type: 'Feature',
			properties: { resourceCoords: [x, y] },
			geometry: { type: 'Point', coordinates: [lng, lat] }
		}))
	}
});

const IMPORTABLE: Record<string, string> = {
	...ON_REMOTE,
	'alignments/map-1.json': GEOREFERENCED_MAP_1
};

const AMSTERDAM_CLOSURE = [
	'alignments/map-1.json',
	`${AMSTERDAM}/annotations/warehouses.geojson`,
	`${AMSTERDAM}/project.json`,
	'images/map-1/0,0,256,256/256,256/0/default.jpg',
	'images/map-1/info.json'
];

const NOT_THIS_PROJECT = [
	...OUTSIDE_NAMESPACE,
	'ballastella-site.json',
	'index.html',
	'.nojekyll',
	`${BOSTON}/project.json`,
	`${BOSTON}/annotations/wharves.geojson`,
	'alignments/map-2.json',
	'alignments/map-3.json',
	'images/map-2/info.json',
	'images/map-2/0,0,256,256/256,256/0/default.jpg',
	'images/map-3/info.json'
];

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const start = (page: Page, options: Parameters<typeof routeGitHubHosts>[1] = {}) =>
	startOnTheHub(page, {
		repositories: [{ owner: OWNER, name: REPOSITORY, files: ON_REMOTE }],
		...options
	});

const banner = (page: Page) => page.getByTestId('review-banner');

test.describe('arriving on a link from a Published Site', () => {
	const LINK = `${HUB}?review=${REMOTE}&p=${AMSTERDAM}`;
	const offer = (page: Page) => page.getByTestId('return-link-offer');
	const accept = (page: Page) => page.getByTestId('accept-return-link');

	test('offers a Review of the one Project beneath it, once, doing nothing until answered, and can be turned down', async ({
		page
	}) => {
		await start(page);

		await page.goto(LINK);

		await expect(offer(page)).toContainText(REMOTE);
		await expect(offer(page)).toContainText(AMSTERDAM);
		await expect(accept(page)).toBeVisible();
		await expect(page.getByTestId('return-link-progress')).toHaveCount(0);
		await expect(banner(page)).toBeHidden();
		await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
		await expect(page.getByTestId('project-problem')).toHaveAttribute('aria-live', 'polite');
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
		expect(new URL(page.url()).searchParams.get('review')).toBeNull();

		await page.reload();
		await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
		await expect(offer(page)).toHaveCount(0);
		await expect(page.getByTestId('project-problem')).toHaveAttribute('role', 'alert');

		await page.goto(LINK);
		await expect(offer(page)).toBeVisible();
		const decline = page.getByTestId('dismiss-return-link');
		await decline.focus();
		await expect(decline).toBeFocused();
		await page.keyboard.press('Enter');

		await expect(offer(page)).toHaveCount(0);
		await expect(page.getByRole('heading', { name: 'Ballastella Editor' })).toBeVisible();
		await expect(page.locator('main')).toBeFocused();
		await expect(page.getByRole('heading', { name: 'Project not found' })).toHaveCount(0);
		await expect.poll(() => new URL(page.url()).searchParams.get('p')).toBeNull();
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});

	test('confirming makes the review copy, holding that one Project, and opens it', async ({
		page
	}) => {
		await start(page);
		await page.goto(LINK);

		await accept(page).focus();
		await expect(accept(page)).toBeFocused();
		await page.keyboard.press('Enter');

		const said = page.getByTestId('return-link-outcome');
		await expect(said).toContainText('Amsterdam 1625');
		await expect(said).toBeFocused();
		await expect(banner(page)).toBeVisible();
		await expectWorkspaceNamed(page, REPOSITORY);
		const stored = await everyByteOf(page, REPOSITORY);
		expect(Object.keys(stored).sort()).toEqual([...AMSTERDAM_CLOSURE, 'review.json'].sort());
		for (const path of NOT_THIS_PROJECT) expect(Object.keys(stored)).not.toContain(path);
		expect(new URL(page.url()).searchParams.get('p')).toBe(AMSTERDAM);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.getByTestId('project-screen')).toBeVisible();
	});

	test('can Import that Project into the Workspace the reader is already in', async ({ page }) => {
		const github = await start(page, {
			repositories: [{ owner: OWNER, name: REPOSITORY, files: IMPORTABLE }],
			rejectCredential: true
		});

		await page.goto(LINK);

		await expect(page.getByTestId('import-return-link')).toContainText(DEFAULT_WORKSPACE);
		await expect(accept(page)).toContainText('review copy');
		await expect(page.getByTestId('dismiss-return-link')).toBeVisible();

		const importing = page.getByTestId('import-return-link');
		await importing.focus();
		await expect(importing).toBeFocused();
		await importing.evaluate((button) => {
			(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = (
				button as HTMLButtonElement
			).disabled;
			new MutationObserver(() => {
				if ((button as HTMLButtonElement).disabled) {
					(window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled = true;
				}
			}).observe(button, { attributes: true, attributeFilter: ['disabled'] });
		});
		await page.keyboard.press('Enter');

		const said = page.getByTestId('return-link-outcome');
		await expect(said).toContainText('Amsterdam 1625');
		await expect(said).toContainText(DEFAULT_WORKSPACE);
		await expect(said).toBeFocused();
		expect(
			await page.evaluate(
				() => (window as unknown as { e2eWentDisabled?: boolean }).e2eWentDisabled ?? false
			)
		).toBe(false);
		await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
		await expect(banner(page)).toBeHidden();
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
		const paths = Object.keys(await everyByteOf(page, DEFAULT_WORKSPACE));
		const minted = [
			...new Set(paths.filter((at) => at.startsWith('images/')).map((at) => at.split('/')[1]))
		];
		expect(minted).toEqual([expect.not.stringMatching(/^map-1$/)]);
		expect(paths.sort()).toEqual(
			[
				`alignments/${minted[0]}.json`,
				`${AMSTERDAM}/annotations/warehouses.geojson`,
				`${AMSTERDAM}/project.json`,
				`images/${minted[0]}/0,0,256,256/256,256/0/default.jpg`,
				`images/${minted[0]}/info.json`
			].sort()
		);
		for (const path of NOT_THIS_PROJECT) expect(paths).not.toContain(path);

		await expectNoRemote(page);

		const done = page.getByTestId('dismiss-return-link');
		await done.focus();
		await page.keyboard.press('Enter');
		await expect.poll(() => new URL(page.url()).searchParams.get('p')).toBe(AMSTERDAM);
		await expect(page.getByTestId('project-name')).toHaveText('Amsterdam 1625');
		await expect(page.locator('main')).toBeFocused();

		expect(github.rawGets(OWNER, REPOSITORY)).toBe(AMSTERDAM_CLOSURE.length + 1);
	});

	test('offers nothing for a link naming no Project, and none for a Project on no repository', async ({
		page
	}) => {
		await start(page);

		for (const query of [`?review=${REMOTE}`, `?review=ada&p=${AMSTERDAM}`]) {
			await page.goto(`${HUB}${query}`);
			await expectWorkspaceNamed(page, DEFAULT_WORKSPACE);
			await expect(offer(page)).toHaveCount(0);
			await expect
				.poll(() => new URL(page.url()).searchParams.get('review'), {
					message: `${query} left in the address bar`
				})
				.toBeNull();
		}
		expect(new URL(page.url()).searchParams.get('p')).toBe(AMSTERDAM);
		expect(await workspaceNames(page)).toEqual([DEFAULT_WORKSPACE]);
	});
});
