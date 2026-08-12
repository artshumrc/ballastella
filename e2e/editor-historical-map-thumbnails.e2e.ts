import { expect, test } from './support/test.js';
import { type Page } from '@playwright/test';

import { emptyWorkspace, gradientPng } from './support/alignment-workspace.js';
import { routeBaseMapArchive } from './support/editor-deployment.js';
import { addHistoricalMapFromFile } from './support/historical-maps.js';
import { installIiifHosts, service } from './support/iiif-hosts.js';
import { seedFile } from './support/stored-file.js';

/**
 * ADR-0030: every Historical Map on the Workspace hub shows a picture of the sheet beside its name,
 * and that picture is the single tile at the coarsest level of the pyramid the map already has.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * WHAT ONLY THIS FILE CAN ASSERT
 *
 * Which URL each listing record carries is a pure function over stored documents, and is asserted as
 * such in `packages/core/src/project/historical-maps.test.ts`. What is left needs a browser, and it is
 * the only thing that can distinguish this feature working from it failing:
 *
 * ⚠ **that the picture DECODED.** Every failure mode here is silent and plausible. A wrong scale factor
 * names a tile the tiler never wrote, and a mis-rooted path names *somebody else's map* at a believable
 * size — and `expect(img).toBeVisible()` passes for both, because an `<img>` that 404s is visible and
 * laid out at exactly its `width` and `height` attributes with no pixels in it. `naturalWidth` is the
 * only assertion that goes red, and there was no precedent for it in this suite: it is written
 * deliberately rather than copied from a neighbour.
 *
 * ⚠ **Nor is the `src` attribute compared with a string computed here.** That compares the computation
 * with itself and passes however wrong the arithmetic is.
 */

// The catalog's archive is somebody else's bucket and the network fence refuses it. On the `context`
// rather than the page: a request that has passed through a service worker is not the page's own as far
// as Playwright is concerned.
test.beforeEach(async ({ context }) => routeBaseMapArchive(context));

/** The one card on the hub, whichever map it is for. */
const card = (page: Page, label: string) =>
	page.getByTestId('historical-map').filter({ hasText: label });

/**
 * What the browser actually decoded, in pixels, or `{ width: 0, height: 0 }` for an image with
 * nothing in it.
 *
 * `naturalWidth`/`naturalHeight` and not `boundingBox`: the element is laid out at its attribute
 * dimensions whether or not any bytes arrived, so its box says nothing at all about whether the
 * picture is there.
 */
const decoded = (page: Page, label: string): Promise<{ width: number; height: number }> =>
	card(page, label)
		.getByTestId('map-thumbnail-image')
		.evaluate((element) => ({
			width: (element as HTMLImageElement).naturalWidth,
			height: (element as HTMLImageElement).naturalHeight
		}))
		.catch(() => ({ width: 0, height: 0 }));

test('a Historical Map added from a file shows a picture that has actually decoded', async ({
	page
}) => {
	await page.goto('./');
	await emptyWorkspace(page);
	await page.reload();

	await page.getByRole('button', { name: 'New Project' }).click();
	const dialog = page.getByRole('dialog', { name: 'New Project' });
	await dialog.getByLabel('Project name').fill('La Floride');
	await dialog.getByRole('button', { name: 'Create' }).click();
	await page.getByRole('link', { name: 'La Floride' }).click();

	// Waited out in full, `info.json` included: `addHistoricalMapFromFile` returns when the preparing
	// card has gone, which is the end of the whole add. A thumbnail assertion made before the pyramid is
	// described has nothing to resolve and would flake.
	await addHistoricalMapFromFile(page, {
		name: 'la-floride.png',
		mimeType: 'image/png',
		buffer: gradientPng(700, 500)
	});

	await page.getByRole('link', { name: 'Back to all Projects' }).click();
	await expect(page.getByTestId('historical-map')).toHaveCount(1);

	// **700 × 500 reduces to 175 × 125**, worked out from ADR-0030's rule rather than from the code: the
	// scale factors double until the sheet fits in one 256-pixel tile, so 1, 2, 4 — and the coarsest
	// level is the whole sheet at a quarter size. A URL at any other scale factor names a tile the
	// tiler never wrote, and this poll would sit on `{ width: 0, height: 0 }` until it timed out.
	await expect
		.poll(() => decoded(page, 'la-floride.png'), { timeout: 20_000 })
		.toEqual({ width: 175, height: 125 });

	// The presentation ADR-0030 fixes, asserted once on the picture that actually arrived. The
	// **computed** `object-fit` and not the class name: `object-cover` would crop a sheet whose
	// proportions are information, and a class-name assertion would go on passing over a stylesheet
	// that had stopped applying it. `alt=""` because the map's name is immediately adjacent, and no
	// tab stop because the picture leads nowhere — a plain `<img>` reports `tabIndex` as -1, and
	// anything that made it focusable would report 0.
	const picture = card(page, 'la-floride.png').getByTestId('map-thumbnail-image');
	await expect(picture).toHaveAttribute('alt', '');
	// ⚠ **And no `loading="lazy"` here**, which is the asymmetry ADR-0030 chose rather than an omission:
	// this map's bytes have already been read out of the Workspace by the time the object URL in `src`
	// exists, so deferring the element saves nothing and would imply a saving that does not exist. The
	// referenced case below asserts the other half.
	expect(await picture.getAttribute('loading')).toBeNull();
	expect(
		await picture.evaluate((element) => ({
			objectFit: getComputedStyle(element).objectFit,
			tabIndex: (element as HTMLImageElement).tabIndex
		}))
	).toEqual({ objectFit: 'contain', tabIndex: -1 });
});

test('a Workspace-held map whose coarsest tile was never written keeps the glyph', async ({
	page
}) => {
	await page.goto('./');
	await emptyWorkspace(page);
	// A pyramid that *describes* itself completely and holds none of its tiles: the geometry resolves,
	// so a URL is built and fetched, and the shim answers 404. That is the population the `response.ok`
	// check exists for — without it the refusal's own body becomes an object URL, and an `<img>` over
	// text decodes to nothing: an empty box, laid out and visible, that no assertion about the element
	// being present could tell from a picture.
	await seedFile(
		page,
		'images/no-tiles/info.json',
		JSON.stringify({
			'@context': 'http://iiif.io/api/image/3/context.json',
			id: 'https://unset.invalid/no-tiles',
			type: 'ImageService3',
			protocol: 'http://iiif.io/api/image',
			profile: 'level0',
			width: 700,
			height: 500,
			tiles: [{ width: 256, height: 256, scaleFactors: [1, 2, 4] }]
		})
	);
	// So the card can be found by a name rather than by a random image id (ADR-0015).
	await seedFile(
		page,
		'images/no-tiles/manifest.json',
		JSON.stringify({ label: { none: ['Carte sans tuiles'] } })
	);
	await page.reload();

	const entry = card(page, 'Carte sans tuiles');
	await expect(entry).toHaveCount(1);

	// ⚠ **A negative claim, so it is made after the fetch it is about has certainly finished.** The
	// resolution is one store read of a file that is not there and completes in milliseconds; asked
	// immediately, "there is no image element" would be true of the frame before the picture would
	// have appeared, and would pass whether or not the body was ever guarded.
	await page.waitForTimeout(1_500);
	await expect(entry.getByTestId('map-thumbnail-glyph')).toBeVisible();
	await expect(entry.getByTestId('map-thumbnail-image')).toHaveCount(0);
});

test('a Historical Map referenced from a Library shows a picture drawn from that Library', async ({
	page
}) => {
	await installIiifHosts(page);
	await page.goto('./');
	await emptyWorkspace(page);
	// A `remote.json` and no `info.json`: the tiles are on a Library's server, and so is the picture. The
	// record carries the service's declared tile side because that is the one input this app cannot
	// recover once the resource is out of reach, and without it there is no saying which scale factor is
	// the coarsest.
	await seedFile(
		page,
		'images/remote-one/remote.json',
		JSON.stringify({
			service: service('images.test', 'florida'),
			label: 'Chart of the Florida coast',
			width: 700,
			height: 500,
			tileSize: 256
		})
	);
	await page.reload();

	const entry = card(page, 'Chart of the Florida coast');
	await expect(entry).toHaveCount(1);

	// ⚠ **Scrolled into view on purpose.** The picture is `loading="lazy"`, so a card below the fold
	// never fires its request and the poll below would sit on `{ width: 0, height: 0 }` until it timed
	// out — a hang rather than a failure. This list is short today; a card being in the viewport must not
	// depend on that staying true.
	await entry.scrollIntoViewIfNeeded();

	// **700 × 500 reduces to 175 × 125** on the 256-pixel tiles this service declares, worked out from
	// ADR-0030's rule rather than from the code. The fixture host serves *whatever* size is asked for, so
	// a wrong scale factor still yields a decodable picture — just one of the wrong size. That is why this
	// compares `naturalWidth`/`naturalHeight` against exact numbers, and why it must **not** be relaxed to
	// `naturalWidth > 0`: that form would pass over every scale factor there is. It looks over-specified
	// and it is the whole test. One small request is all this is: nothing downloads the sheet.
	await expect
		.poll(() => decoded(page, 'Chart of the Florida coast'), { timeout: 20_000 })
		.toEqual({ width: 175, height: 125 });

	// The other half of ADR-0030's deliberate asymmetry: laziness is worth having for a URL on somebody
	// else's server, so that opening a Workspace of referenced maps asks the Libraries only for the cards
	// a scholar can see (SPEC story 19).
	await expect(entry.getByTestId('map-thumbnail-image')).toHaveAttribute('loading', 'lazy');
});

test('a referenced Historical Map whose record has no tile side keeps the glyph', async ({
	page
}) => {
	await page.goto('./');
	await emptyWorkspace(page);
	// A record written before `remote.json` carried the tile side, which is the population ADR-0030
	// declines to backfill: re-adding the map is the whole remedy. Defaulting to 256 would be right often
	// enough to be dangerous, and here it would be wrong — so the honest glyph, and no request at all.
	await seedFile(
		page,
		'images/remote-one/remote.json',
		JSON.stringify({
			service: 'https://iiif.bnf.example/iiif/3/btv1b',
			label: 'Plan de Paris',
			width: 4000,
			height: 3000
		})
	);
	await page.reload();

	const entry = card(page, 'Plan de Paris');
	await expect(entry).toHaveCount(1);

	// No wait, and nothing to scroll into view: this record resolves to a `null` thumbnail, so no `<img>`
	// is ever rendered and there is no request to outrun. Were one somehow built, the network fence would
	// catch it at route time and fail the test at teardown however long the body slept.
	await expect(entry.getByTestId('map-thumbnail-glyph')).toBeVisible();
	// **No `<img>` at all**, which is what "no broken image" has to mean here: an element pointing at a
	// Library this test never routed would be an empty box the glyph assertion could not tell from a
	// picture. The network fence is the other half of the claim — a request to that host would fail the
	// test rather than quietly 404.
	await expect(entry.getByTestId('map-thumbnail-image')).toHaveCount(0);
});
