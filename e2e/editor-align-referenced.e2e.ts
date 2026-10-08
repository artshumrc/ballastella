import { expect, test, type Page } from './support/test.js';
import { generateAnnotation, parseAnnotation, validateAnnotation } from '@allmaps/annotation';

import {
	mapImage,
	makePairs,
	rows,
	showPaneDetails,
	storedAlignment,
	waitForStored,
	warpedTiles
} from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { ensureAddMapImageOpen } from './support/map-images.js';
import { generateId, installIiifHosts, service } from './support/iiif-hosts.js';
import { alignFromLayer, layerRows, openLayerRow } from './support/layers.js';
import { seedFile } from './support/stored-file.js';
import { emptyWorkspace } from './support/workspace.js';
import { baseMap, clickAt, openNewProject } from './support/annotations.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

const FLORIDA = service('images.test', 'florida');

async function start(page: Page): Promise<void> {
	await installIiifHosts(page);
	await page.goto('/');
	await emptyWorkspace(page);
	await page.reload();
	await openNewProject(page, 'A Library’s Florida');
}

const projectsDrawing = (page: Page, imageId: string): Promise<number> =>
	page.evaluate(async (id) => {
		const root = await workspaceRoot();
		let count = 0;
		for await (const [, handle] of root.entries()) {
			if (handle.kind !== 'directory') continue;
			try {
				const file = await (handle as FileSystemDirectoryHandle).getFileHandle('project.json');
				if ((await (await file.getFile()).text()).includes(id)) count += 1;
			} catch {}
		}
		return count;
	}, imageId);

async function lookUp(page: Page, host: string, name: string): Promise<void> {
	await ensureAddMapImageOpen(page);
	await page.getByTestId('remote-url').fill(`${service(host, name)}/info.json`);
	await page.getByTestId('remote-read').click();
}

/** @returns the image id, which is `generateId(uri)` and therefore the Alignment's file name */
async function addReferenced(
	page: Page,
	host: string,
	name = 'florida',
	layers = 1
): Promise<string> {
	await lookUp(page, host, name);
	await expect(page.getByTestId('remote-add')).toBeVisible({ timeout: 30_000 });
	await page.getByTestId('remote-add').click();
	await expect(layerRows(page)).toHaveCount(layers, { timeout: 30_000 });
	return generateId(service(host, name));
}

async function alignReferenced(page: Page, host = 'images.test'): Promise<string> {
	await start(page);
	const imageId = await addReferenced(page, host);
	await alignFromLayer(page);
	await waitForPane(page);
	return imageId;
}

const layerFor = (page: Page, imageId: string) =>
	page.locator(`[data-testid="layer-row"][data-image-id="${imageId}"]`);

const imageFiles = (page: Page, imageId: string): Promise<string[]> =>
	page.evaluate(async (id) => {
		const walk = async (
			directory: FileSystemDirectoryHandle,
			prefix: string
		): Promise<string[]> => {
			const found: string[] = [];
			for await (const [name, handle] of directory.entries()) {
				if (handle.kind === 'directory') {
					found.push(...(await walk(handle as FileSystemDirectoryHandle, `${prefix}${name}/`)));
				} else {
					found.push(`${prefix}${name}`);
				}
			}
			return found;
		};
		try {
			const images = await (await workspaceRoot()).getDirectoryHandle('images');
			return (await walk(await images.getDirectoryHandle(id), '')).sort();
		} catch {
			return [];
		}
	}, imageId);

const atFullResolution = (url: string): boolean => {
	const parts = /\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/default\.(jpg|png)$/.exec(url);
	return parts !== null && parts[3] === parts[5] && parts[4] === parts[6];
};

async function waitForPane(page: Page): Promise<void> {
	await expect(page.getByTestId('image-pane')).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: 60_000
	});
	await expect(page.getByTestId('pairing-status')).toContainText('first Control Point');
}

async function backToProject(page: Page): Promise<void> {
	await page.getByTestId('back-to-project').click();
	await expect(page.getByTestId('layer-sidebar')).toBeVisible();
}

const resourceCoords = (alignment: { body: { features: unknown[] } }) =>
	alignment.body.features.map(
		(feature) => (feature as { properties: { resourceCoords: number[] } }).properties.resourceCoords
	);

for (const [what, host] of [
	['a level 2 service', 'images.test'],
	['a level 0 service that publishes tiles', 'static.test']
] as const) {
	test(`aligns ${what} in place, drawing it warped from the library`, async ({ page }) => {
		test.slow();
		const tileRequests: string[] = [];
		const placeholderRequests: string[] = [];
		page.on('request', (request) => {
			const url = request.url();
			if (url.includes(host) && /default\.(jpg|png)$/.test(url)) tileRequests.push(url);
			if (url.includes('unset.invalid')) placeholderRequests.push(url);
		});

		const imageId = await alignReferenced(page, host);

		await showPaneDetails(page);
		const pyramid = page.getByTestId('map-image-pyramid');
		await expect(pyramid).toHaveAttribute('data-image-id', imageId);
		await expect(pyramid).toHaveAttribute('data-width', '700');
		await expect(pyramid).toHaveAttribute('data-height', '500');

		await page.getByTestId('image-pane').hover();
		await page.mouse.wheel(0, -1_000);
		await expect
			.poll(() => tileRequests.filter(atFullResolution).length, { timeout: 30_000 })
			.toBeGreaterThan(0);
		expect(placeholderRequests).toEqual([]);

		await makePairs(page, 3);
		await expect(rows(page)).toHaveCount(3);
		await waitForStored(page, imageId, 3);

		await expect(page.getByTestId('warped-status')).toHaveAttribute('data-warped-status', 'drawn', {
			timeout: 60_000
		});
		await expect
			.poll(() => warpedTiles(page), { timeout: 120_000, intervals: [2000] })
			.toBeGreaterThan(0);
		expect(await imageFiles(page, imageId)).toEqual(['remote.json']);
	});
}

test('writes an Alignment addressed at the library that round-trips unchanged, and an offline copy keeps every Control Point', async ({
	page
}) => {
	test.slow();
	const imageId = await alignReferenced(page);
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);

	const written = await storedAlignment(page, imageId);
	expect(written).not.toBeNull();
	const before = JSON.parse(written as string);
	expect(before.target.source.id).toBe(FLORIDA);
	expect(written).not.toContain('unset.invalid');
	expect(() => validateAnnotation(before), 'upstream refused the file the app wrote').not.toThrow();
	const parsed = parseAnnotation(before);
	expect(parsed).toHaveLength(1);
	expect(parsed[0]?.resource.id).toBe(FLORIDA);
	expect(parsed[0]?.gcps).toHaveLength(3);
	expect(parsed[0]?.resource.width).toBe(700);
	const regenerated = generateAnnotation(parsed) as {
		items?: { target?: { source?: { id?: string } } }[];
	};
	expect(regenerated.items?.[0]?.target?.source?.id).toBe(FLORIDA);
	expect(JSON.stringify(regenerated)).not.toContain('unset.invalid');

	const points = resourceCoords(before);
	expect(points).toHaveLength(3);

	await backToProject(page);
	await (await openLayerRow(page)).getByTestId('offline-copy-open').click();
	await expect(page.getByRole('dialog', { name: 'Make an offline copy' })).toBeVisible();
	await expect(page.getByTestId('offline-copy-status')).toHaveAttribute('data-step', 'deciding');
	await page.getByTestId('offline-copy-start').click();
	await expect(page.getByTestId('offline-copy-done')).toBeVisible({ timeout: 120_000 });

	await expect
		.poll(
			async () => {
				const stored = await storedAlignment(page, imageId);
				return stored === null ? '' : JSON.parse(stored).target.source.id;
			},
			{ timeout: 60_000 }
		)
		.toContain('unset.invalid');
	expect(resourceCoords(JSON.parse((await storedAlignment(page, imageId)) as string))).toEqual(
		points
	);

	const files = await imageFiles(page, imageId);
	expect(files).toContain('remote.json');
	expect(files).toContain('info.json');
	expect(files.filter((name) => name.endsWith('default.jpg')).length).toBeGreaterThan(0);
});

test('refuses a service that publishes no tiles, and a host whose tiles are unreadable, naming the host', async ({
	page
}) => {
	await start(page);

	await lookUp(page, 'sizes-only.test', 'plain');
	const error = page.getByTestId('remote-error');
	await expect(error).toBeVisible({ timeout: 30_000 });
	await expect(error).toContainText('sizes-only.test');
	await expect(error).toContainText('publishes no tiles');
	await expect(error).toContainText('does not support tiles or custom regions and sizes');
	await expect(error).toContainText('add it from a file');
	await expect(error).not.toContainText('not a IIIF Manifest');
	await expect(page.getByTestId('remote-add')).toHaveCount(0);
	await expect(layerRows(page)).toHaveCount(0);
	expect(await imageFiles(page, generateId(service('sizes-only.test', 'plain')))).toEqual([]);

	await page.getByTestId('remote-reset').click();
	await lookUp(page, 'tiles-only.test', 'locked');
	await expect(error).toContainText('tiles-only.test', { timeout: 30_000 });
	await expect(layerRows(page)).toHaveCount(0);
});

test('keeps an alignment in progress through a connection that goes and comes back, but will not open the view offline', async ({
	page,
	context
}) => {
	test.slow();
	const imageId = await alignReferenced(page);
	await makePairs(page, 1);
	await waitForStored(page, imageId, 1);
	const pairing = page.getByTestId('pairing-status');
	const notice = page.getByTestId('map-image-offline');

	await clickAt(mapImage(page), 0.35, 0.4);
	await expect(pairing).toHaveAttribute('data-pending', 'resource');
	await context.setOffline(true);
	await expect(notice).toBeVisible({ timeout: 30_000 });
	await expect(notice).toHaveAttribute('data-offline-host', 'images.test');
	await expect(notice).toContainText('images.test');
	await expect(mapImage(page)).toBeVisible();
	await expect(pairing).toHaveAttribute('data-pending', 'resource');
	await clickAt(baseMap(page), 0.35, 0.4);
	await expect(rows(page)).toHaveCount(2);
	await waitForStored(page, imageId, 2);

	await clickAt(mapImage(page), 0.3, 0.35);
	await expect(pairing).toHaveAttribute('data-pending', 'resource');
	await context.setOffline(false);
	await expect(notice).toHaveCount(0, { timeout: 30_000 });
	await expect(pairing).toHaveAttribute('data-pending', 'resource');
	await expect(mapImage(page)).toBeVisible();
	await clickAt(baseMap(page), 0.3, 0.35);
	await expect(rows(page)).toHaveCount(3);
	await waitForStored(page, imageId, 3);

	await backToProject(page);
	await context.setOffline(true);
	await alignFromLayer(page);
	const failure = page.getByTestId('map-image-failure');
	await expect(failure).toBeVisible({ timeout: 30_000 });
	await expect(failure).toContainText('images.test');
	await expect(failure).toContainText('no connection');
	await expect(mapImage(page)).toHaveCount(0);

	await context.setOffline(false);
	await expect(page.getByTestId('map-image-tiles')).toHaveAttribute('data-tiles-loaded', 'true', {
		timeout: 60_000
	});
	await expect(rows(page)).toHaveCount(3);
});

/**
 * A colleague's Alignment, arriving through a synced Workspace while this session has it open.
 *
 * **Their document is this session's own with one Control Point taken out**, which makes it parse,
 * differ in bytes, and be distinguishable on screen by a count rather than by a coordinate readout.
 *
 * Written straight into the Workspace, because that is what the situation *is*: another process's
 * write. A gesture in this application cannot produce one, which is the whole reason this needs a
 * fixture.
 *
 * **Through `support/stored-file.ts`'s `seedFile`, and the spelling matters twice.** The fence knows
 * that name, so this write is *seen* by `check-alignment-writers.mjs` and has to say why it is a
 * fixture — the first cut assembled the same path out of `getDirectoryHandle('alignments')` and a
 * bare `` `${id}.json` ``, which no pattern matches, so it was a new unfenced writer of
 * `alignments/<id>.json` added in the very change that recounts the fence's honesty statement. And
 * `seedFile` writes atomically, so the next read cannot catch this half-written.
 *
 * @returns their document, byte for byte, so a restore can be compared against it
 */
async function aColleagueChanges(page: Page, imageId: string): Promise<string> {
	const mine = JSON.parse((await storedAlignment(page, imageId)) as string);
	const theirs = JSON.stringify({
		...mine,
		body: { ...mine.body, features: mine.body.features.slice(0, 2) }
	});
	await seedFile(page, `alignments/${imageId}.json`, theirs);
	return theirs;
}

async function reachTheCollision(page: Page, imageId: string): Promise<string> {
	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	const theirs = await aColleagueChanges(page, imageId);

	await makePairs(page, 4);
	await expect(rows(page)).toHaveCount(4);
	await waitForStored(page, imageId, 4);
	await expect(changedElsewhere(page)).toBeVisible({ timeout: 30_000 });
	return theirs;
}

const changedElsewhere = (page: Page) => page.getByTestId('alignment-changed-elsewhere');
const changedOutcome = (page: Page) => page.getByTestId('changed-elsewhere-outcome');

test('says when somebody else changed this Alignment, and puts their version back', async ({
	page
}) => {
	test.slow();
	const imageId = await alignReferenced(page);
	const theirs = await reachTheCollision(page, imageId);

	await expect(changedElsewhere(page)).toHaveAttribute('role', 'alert');
	await expect(changedElsewhere(page)).toContainText('Somebody else changed');
	await expect(changedElsewhere(page)).toContainText('one Alignment');

	await page.getByTestId('restore-changed-elsewhere').click();

	await expect.poll(() => storedAlignment(page, imageId), { timeout: 30_000 }).toBe(theirs);
	await expect(rows(page)).toHaveCount(2);
	await expect(changedElsewhere(page)).toHaveCount(0);
	await expect(changedOutcome(page)).toBeFocused();
	await expect(changedOutcome(page)).toContainText('Their version');

	await makePairs(page, 3);
	await waitForStored(page, imageId, 3);
	await expect(changedElsewhere(page)).toHaveCount(0);
});

test('keeps this session’s version when that is what the user chooses', async ({ page }) => {
	test.slow();
	const imageId = await alignReferenced(page);
	await reachTheCollision(page, imageId);

	await page.getByTestId('dismiss-changed-elsewhere').click();

	await expect(changedElsewhere(page)).toHaveCount(0);
	await expect(rows(page)).toHaveCount(4);
	expect(JSON.parse((await storedAlignment(page, imageId)) as string).body.features).toHaveLength(
		4
	);
	await expect(changedOutcome(page)).toBeFocused();
	await expect(changedOutcome(page)).toContainText('Your version has been kept');
});

test('warns only on the Map Image the warning is about', async ({ page }) => {
	test.slow();
	const florida = await alignReferenced(page);
	await reachTheCollision(page, florida);

	await backToProject(page);
	const georgia = await addReferenced(page, 'images.test', 'georgia', 2);
	await alignFromLayer(page, layerFor(page, georgia));
	await waitForPane(page);
	await expect(changedElsewhere(page)).toHaveCount(0);

	await backToProject(page);
	await alignFromLayer(page, layerFor(page, florida));
	await expect(changedElsewhere(page)).toBeVisible({ timeout: 30_000 });
});

test('reads the library’s info.json once, and says what it is doing in regions a screen reader is told about', async ({
	page
}) => {
	await start(page);
	const imageId = await addReferenced(page, 'images.test');
	const infoReads: string[] = [];
	page.on('request', (request) => {
		if (/images\.test\/.*\/info\.json$/.test(request.url())) infoReads.push(request.url());
	});
	await alignFromLayer(page);
	await waitForPane(page);
	await expect
		.poll(() => infoReads.length, { timeout: 10_000, intervals: [1000, 1000, 1000] })
		.toBe(1);

	for (const testid of [
		'pairing-status',
		'warped-status',
		'alignment-opening-view',
		'changed-elsewhere-outcome',
		'map-image-offline-region'
	]) {
		await expect(page.getByTestId(testid)).toHaveAttribute('aria-live', 'polite');
	}
	await expect(page.getByTestId('alignment-used-by')).toHaveCount(0);
	await expect(page.getByTestId('map-image-offline-region')).toBeEmpty();
	await expect(page.getByTestId('map-image-offline')).toHaveCount(0);

	await expect.poll(() => projectsDrawing(page, imageId), { timeout: 30_000 }).toBe(1);
	await page.goto('/');
	const onTheRow = page
		.getByTestId('map-image')
		.filter({ hasText: imageId })
		.getByTestId('used-by');
	await expect(onTheRow).toBeVisible({ timeout: 30_000 });
	await expect(onTheRow).not.toHaveAttribute('aria-live', /.+/);
});
