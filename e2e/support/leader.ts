// Reading the leader line out of the running application.
//
// ⚠ **What this file deliberately does not offer is a way to check the line against itself.** It
// hands back the line's own points and nothing else; where each end *ought* to be is the caller's,
// and on the canvas side that has to be `map.project()` of the coordinate as stored on disk. This
// repository has a recorded incident — see `apps/editor/src/routes/layout.css` on the Annotation
// vertex handles — where a mark was drawn 334 px from the geography it named and an entire browser
// suite missed it, because every assertion took the element's own box and worked from that.

import { expect, type Page } from '@playwright/test';

/** The leader's layer. Exactly one is rendered per screen that has one. */
export const leaderLayer = (page: Page) => page.getByTestId('leader-line');

/** A point in the same page pixels Playwright's `boundingBox()` speaks. */
export interface PagePoint {
	x: number;
	y: number;
}

/**
 * The leader's points, in page pixels, or `null` when no line is drawn.
 *
 * The `points` attribute is relative to the layer's own box, which is the container spanning the
 * sidebar and the canvas — so the layer's box is what converts it to the coordinates everything else
 * in a Playwright test is in.
 */
export async function leaderPoints(page: Page): Promise<PagePoint[] | null> {
	const layer = leaderLayer(page);
	await expect(layer).toHaveCount(1);
	if ((await layer.getAttribute('data-drawn')) !== 'yes') return null;
	const box = await layer.boundingBox();
	const attribute = await layer.locator('polyline').getAttribute('points');
	if (box === null || attribute === null) return null;
	return attribute.split(' ').map((pair) => {
		const [x, y] = pair.split(',').map(Number);
		return { x: box.x + (x as number), y: box.y + (y as number) };
	});
}

/** Whether a leader is drawn at all, polled so a redraw a frame away is not read as an absence. */
export const leaderIsDrawn = (page: Page): Promise<string | null> =>
	leaderLayer(page).getAttribute('data-drawn');
