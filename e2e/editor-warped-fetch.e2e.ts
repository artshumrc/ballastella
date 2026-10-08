import {
	expectWarpedDrawn,
	makePair,
	start,
	warpedStatus,
	warpedTiles
} from './support/alignment-workspace.js';
import { expect, test } from './support/test.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';

test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

declare global {
	interface Window {
		ballastellaWarped?: { layer: { getBounds(): unknown } };
	}
}

test('warped rendering waits for three Control Points, then reads info.json and tiles through the ProjectStore shim', async ({
	page
}) => {
	const requested: string[] = [];
	page.on('request', (request) => requested.push(request.url()));
	const consoleErrors: string[] = [];
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	page.on('pageerror', (error) => consoleErrors.push(`${error.name}: ${error.message}`));

	await start(page);
	await makePair(page, [0.3, 0.3]);
	await makePair(page, [0.6, 0.35]);

	await expect(warpedStatus(page)).toHaveAttribute('data-warped-status', '');
	await expect(warpedStatus(page)).toContainText(
		'1 more Control Point and the Map Image will be drawn'
	);
	await expect(page.evaluate(() => Boolean(window.ballastellaWarped))).resolves.toBe(false);

	await makePair(page, [0.45, 0.7]);
	await expectWarpedDrawn(page);
	await expect(warpedStatus(page)).toContainText('from 3 Control Points');
	const bounds = await page.evaluate(() => window.ballastellaWarped?.layer.getBounds() ?? null);
	expect(bounds, 'the warped layer reported no bounds').not.toBeNull();

	expect(
		await warpedTiles(page),
		'no tile reached the renderer through the ProjectStore shim — if `scripts/check-allmaps-patch.mjs` ' +
			'is passing, look for an upstream change to how fetchFn crosses into the tile worker'
	).toBeGreaterThan(0);

	const dataClone = consoleErrors.filter((text) => /DataClone|could not be cloned/i.test(text));
	expect(dataClone, 'fetchFn failed to cross into the tile worker').toEqual([]);
	expect(consoleErrors.filter((text) => text.includes('unset.invalid'))).toEqual([]);
	expect(requested.filter((url) => url.includes('unset.invalid'))).toEqual([]);
});
