import { expect, type Page } from '@playwright/test';

export const leaderLayer = (page: Page) => page.getByTestId('leader-line');

interface PagePoint {
	x: number;
	y: number;
}

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

export const leaderIsDrawn = (page: Page): Promise<string | null> =>
	leaderLayer(page).getAttribute('data-drawn');
