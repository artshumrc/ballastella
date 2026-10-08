import { expect, test } from './support/test.js';
import { networkFenceMessage, reachesTheNetwork } from './support/network-fence.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';

const OUTSIDE = 'https://ballastella-network-fence-control.invalid/probe';

const probe = (url: string) =>
	fetch(url).then(
		() => 'the request was answered',
		(error: Error) => String(error)
	);

test.describe('the network fence', () => {
	test('blocks a request the page makes to an external origin', async ({ page }) => {
		test.fail();
		await page.goto('./');

		expect(await page.evaluate(probe, OUTSIDE)).toContain('Failed to fetch');
	});

	test('blocks a request the service worker makes to an external origin', async ({
		page,
		context
	}) => {
		test.fail();

		const registered = context.waitForEvent('serviceworker');
		await page.goto('./');
		const worker = await registered;

		expect(await worker.evaluate(probe, OUTSIDE)).toContain('Failed to fetch');
	});

	test('leaves this suite’s own servers alone', async ({ page }) => {
		await page.goto('./');
		await expect(page.getByRole('heading', { level: 1, name: 'Ballastella Editor' })).toBeVisible();

		for (const host of ['localhost', '127.0.0.1', '[::1]']) {
			expect(reachesTheNetwork(`http://${host}:20001/base-map/sprites/light.json`)).toBe(false);
		}
	});

	test('lets a routed archive through, with its real bytes', async ({ page }) => {
		await routeBaseMapArchive(page);
		await page.goto('./');

		const served = await page.evaluate(async () => {
			const response = await fetch('https://demo-bucket.protomaps.com/v4.pmtiles', {
				headers: { range: 'bytes=0-6' }
			});
			const body = await response.arrayBuffer();
			return {
				status: response.status,
				length: body.byteLength,
				magic: new TextDecoder().decode(body)
			};
		});

		expect(served.status).toBe(206);
		expect(served.length).toBe(7);
		expect(served.magic).toBe('PMTiles');
	});

	test('reads a URL as local, external, allowed, or not a request at all, and names the remedy', () => {
		expect(reachesTheNetwork('http://localhost:20000/index.html')).toBe(false);
		expect(reachesTheNetwork('http://127.0.0.1:41235/service-worker.js')).toBe(false);
		expect(reachesTheNetwork('http://[::1]:20000/')).toBe(false);
		expect(reachesTheNetwork('https://demo-bucket.protomaps.com/v4.pmtiles')).toBe(true);
		expect(reachesTheNetwork('https://library.test/iiif/atlas/manifest.json')).toBe(true);
		expect(reachesTheNetwork('https://unset.invalid/abc/0/0/0.jpg')).toBe(true);
		expect(reachesTheNetwork('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
		expect(reachesTheNetwork('blob:http://localhost:20000/8f2a')).toBe(false);
		expect(reachesTheNetwork('about:blank')).toBe(false);
		expect(reachesTheNetwork('not a url at all')).toBe(false);
		expect(reachesTheNetwork('https://localhost.evil.example/')).toBe(true);
		expect(reachesTheNetwork('https://not-localhost/')).toBe(true);

		const allowed = [{ host: 'tiles.example.edu', why: 'a specimen, not a real allowance' }];
		expect(reachesTheNetwork('https://tiles.example.edu/planet.pmtiles', allowed)).toBe(false);
		expect(reachesTheNetwork('https://other.example.edu/planet.pmtiles', allowed)).toBe(true);
		expect(reachesTheNetwork('https://sub.tiles.example.edu/planet.pmtiles', allowed)).toBe(true);

		const message = networkFenceMessage(['https://demo-bucket.protomaps.com/v4.pmtiles']);
		expect(message).toContain('https://demo-bucket.protomaps.com/v4.pmtiles');
		expect(message).toContain('routeBaseMapArchive');
		expect(message).toContain('allowedExternalHosts');
	});
});
