export interface Box {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

export interface LeaderBoxes {
	readonly layer: Box;
	readonly mark: Box | null;
	readonly canvas: Box;
	readonly row: Box | null;
	readonly sidebar: Box;
}

/** A leader that struck out of the column at an angle from the row's edge reads as pointing at the row above or below it, which is precisely the ambiguity this line exists to remove. */
const STUB = 12;
const CLEARANCE = 2;

const centre = (box: Box): { x: number; y: number } => ({
	x: (box.left + box.right) / 2,
	y: (box.top + box.bottom) / 2
});

const contains = (box: Box, at: { x: number; y: number }): boolean =>
	at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;

const stacked = (sidebar: Box, canvas: Box): boolean =>
	sidebar.left < canvas.right && canvas.left < sidebar.right;

export function leaderPath(boxes: LeaderBoxes): string | null {
	const { layer, mark, canvas, row, sidebar } = boxes;
	if (mark === null || row === null) return null;
	if (stacked(sidebar, canvas)) return null;
	const markAt = centre(mark);
	if (!contains(canvas, markAt)) return null;
	const onTheRight = markAt.x >= row.right;
	const rowAt = { x: onTheRight ? row.right : row.left, y: (row.top + row.bottom) / 2 };
	if (!contains(sidebar, rowAt)) return null;
	const stub = { x: rowAt.x + (onTheRight ? STUB : -STUB), y: rowAt.y };
	const run = Math.hypot(markAt.x - stub.x, markAt.y - stub.y);
	const short =
		run === 0
			? 0
			: Math.min(
					1,
					(Math.max(mark.right - mark.left, mark.bottom - mark.top) / 2 + CLEARANCE) / run
				);
	const end = {
		x: markAt.x - (markAt.x - stub.x) * short,
		y: markAt.y - (markAt.y - stub.y) * short
	};

	const point = (at: { x: number; y: number }): string =>
		`${round(at.x - layer.left)},${round(at.y - layer.top)}`;
	return `${point(rowAt)} ${point(stub)} ${point(end)}`;
}

/** Sub-pixel precision, so the attribute does not change on every frame of a slow pan. */
const round = (value: number): number => Math.round(value * 100) / 100;
