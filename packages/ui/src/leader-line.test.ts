import { describe, expect, test } from 'vitest';

import { leaderPath, type LeaderBoxes } from './leader-line.js';

const boxes = (over: Partial<LeaderBoxes> = {}): LeaderBoxes => ({
	layer: { left: 0, top: 0, right: 1000, bottom: 600 },
	sidebar: { left: 0, top: 0, right: 300, bottom: 600 },
	canvas: { left: 300, top: 0, right: 1000, bottom: 600 },
	row: { left: 10, top: 100, right: 290, bottom: 130 },
	mark: { left: 590, top: 290, right: 610, bottom: 310 },
	...over
});

const parse = (path: string): { x: number; y: number }[] =>
	path.split(' ').map((pair) => {
		const [x, y] = pair.split(',').map(Number);
		return { x: x as number, y: y as number };
	});

describe('leaderPath', () => {
	test('runs from the vertical centre of the row’s near edge to just short of the mark', () => {
		const path = leaderPath(boxes());
		expect(path).not.toBeNull();
		const points = parse(path as string);
		expect(points).toHaveLength(3);
		expect(points[0]).toEqual({ x: 290, y: 115 });
		expect(points[1]?.y).toBe(115);
		expect(points[1]?.x).toBeGreaterThan(290);
		expect(points[1]?.x).toBeLessThan(310);

		// And it stops at the edge of the mark rather than under it: the leader is drawn above the canvas, so a line to the centre would be drawn across the number it is pointing at.
		const end = points[2] as { x: number; y: number };
		const toCentre = Math.hypot(600 - end.x, 300 - end.y);
		expect(toCentre).toBeGreaterThan(9);
		expect(toCentre).toBeLessThan(16);
		const stub = points[1] as { x: number; y: number };
		const full = Math.hypot(600 - stub.x, 300 - stub.y);
		expect((end.x - stub.x) / (600 - stub.x)).toBeCloseTo((full - toCentre) / full, 4);
	});

	test('the points are relative to the layer’s own box, not the viewport’s', () => {
		const offset = leaderPath(
			boxes({
				layer: { left: 40, top: 25, right: 1040, bottom: 625 }
			})
		);
		const points = parse(offset as string);
		expect(points[0]).toEqual({ x: 250, y: 90 });
	});

	test('nothing is drawn when there is no mark on the canvas', () => {
		expect(leaderPath({ ...boxes(), mark: null })).toBeNull();
	});

	test('nothing is drawn when the row is not on the screen', () => {
		expect(leaderPath({ ...boxes(), row: null })).toBeNull();
	});

	test('nothing is drawn when the mark has been panned off the canvas', () => {
		expect(
			leaderPath(boxes({ mark: { left: 1200, top: 290, right: 1220, bottom: 310 } }))
		).toBeNull();
	});

	test('nothing is drawn when the row has been scrolled out of the sidebar', () => {
		expect(leaderPath(boxes({ row: { left: 10, top: -40, right: 290, bottom: -10 } }))).toBeNull();
	});

	test('nothing is drawn when the layout has stacked the sidebar under the canvas', () => {
		expect(
			leaderPath(
				boxes({
					sidebar: { left: 0, top: 0, right: 1000, bottom: 300 },
					canvas: { left: 0, top: 300, right: 1000, bottom: 600 },
					row: { left: 10, top: 100, right: 990, bottom: 130 },
					mark: { left: 590, top: 440, right: 610, bottom: 460 }
				})
			)
		).toBeNull();
	});

	test('a sidebar on the right leaves from the row’s left edge', () => {
		const path = leaderPath(
			boxes({
				sidebar: { left: 700, top: 0, right: 1000, bottom: 600 },
				canvas: { left: 0, top: 0, right: 700, bottom: 600 },
				row: { left: 710, top: 100, right: 990, bottom: 130 },
				mark: { left: 340, top: 290, right: 360, bottom: 310 }
			})
		);
		const points = parse(path as string);
		expect(points[0]).toEqual({ x: 710, y: 115 });
		expect(points[1]?.x).toBeLessThan(710);
	});

	test('a mark under the row’s own edge still yields a line rather than a division by zero', () => {
		const path = leaderPath(
			boxes({
				canvas: { left: 300, top: 0, right: 1000, bottom: 600 },
				mark: { left: 292, top: 105, right: 312, bottom: 125 }
			})
		);
		const points = parse(path as string);
		expect(points).toHaveLength(3);
		expect(points.every((at) => Number.isFinite(at.x) && Number.isFinite(at.y))).toBe(true);
	});
});
