// Where the dashed leader goes: a pure function of five boxes (SPEC stories 39, 41, 46).
//
// **All of the "not drawn at all" rules live here rather than in the component**, because every one
// of them is a comparison of two rectangles and none of them needs a browser to decide. That is the
// whole reason this file exists separately from `LeaderLine.svelte`: the component is the wiring —
// which elements, which events — and this is the decision.
//
// ⚠ **It knows nothing about coordinates on the earth, and must not.** The mark's box is handed in
// already projected, by whichever pane drew the mark. What this cannot check, and what therefore has
// to be checked in a real browser against `map.project()` of the coordinate on disk, is that the box
// it was handed is really where that coordinate is — see `e2e/editor-annotations.e2e.ts`, and the
// incident it records about a handle drawn 334 px from the place it named.

/** A rectangle in the viewport's own coordinates, which is what `getBoundingClientRect` returns. */
export interface Box {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

/** The five boxes a leader is decided from. `null` for either end means there is no end to draw. */
export interface LeaderBoxes {
	/** The layer the line is drawn in. Every returned point is relative to its top left corner. */
	readonly layer: Box;
	/** The selected mark on the canvas, or `null` when nothing is selected or nothing is drawn for it. */
	readonly mark: Box | null;
	/** The canvas the mark is drawn on: the box the mark has to be inside to be pointed at. */
	readonly canvas: Box;
	/** The selected row in the sidebar, or `null` when it is not rendered. */
	readonly row: Box | null;
	/** The scrolling column the row is listed in. */
	readonly sidebar: Box;
}

/**
 * How far the line runs horizontally out of the row before it turns towards the mark.
 *
 * A leader that struck out of the column at an angle from the row's edge reads as pointing at the
 * row above or below it, which is precisely the ambiguity this line exists to remove.
 */
const STUB = 12;

/** How far short of the mark's centre the line stops: its own half-diagonal, and a hair. */
const CLEARANCE = 2;

const centre = (box: Box): { x: number; y: number } => ({
	x: (box.left + box.right) / 2,
	y: (box.top + box.bottom) / 2
});

const contains = (box: Box, at: { x: number; y: number }): boolean =>
	at.x >= box.left && at.x <= box.right && at.y >= box.top && at.y <= box.bottom;

/**
 * Whether the layout has put the sidebar under the canvas rather than beside it.
 *
 * **Measured from the boxes rather than read off a breakpoint**, because the breakpoint is three
 * different numbers in this repository — the viewer's Front Page grid, the alignment route's panes
 * and the editor's fixed column each decide for themselves — and a line drawn across a stacked
 * layout is a lie whichever stylesheet stacked it. Two columns side by side have horizontal ranges
 * that do not overlap; anything else is a stack.
 */
const stacked = (sidebar: Box, canvas: Box): boolean =>
	sidebar.left < canvas.right && canvas.left < sidebar.right;

/**
 * The leader's `points`, relative to {@link LeaderBoxes.layer}, or `null` when none is drawn.
 *
 * Three points: the vertical centre of the row's near edge, a short stub straight out of the column,
 * and the mark. The near edge is the row's *right* on the Project screen and in the viewer, where
 * the sidebar is on the left, and its *left* on the alignment route, where the docked Control Point
 * column is on the right of the panes — one rule, stated as the edge facing the mark, rather than a
 * side named per screen.
 */
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
	// A mark sitting on the stub's own end has no direction to shorten along. Drawing to it is then
	// the honest answer — the two ends are a dozen pixels apart and there is nothing to hide.
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
