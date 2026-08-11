// The drawing gesture in progress: which tool is active, and the vertices placed so far.
//
// ============================================================================================
// Why there is no `terra-draw` here
// ============================================================================================
//
// ADR-0005 says all drawing and editing — Control Points, Resource Masks, and Annotations — goes
// through `terra-draw`. It has never been in this repository, and this is the **third** slice to
// decline it: ticket 07 for the Control Point pairing, ticket 08 for the Resource Mask, and this one
// for Annotations. The ADR and the code therefore disagree, which is recorded as an open question for
// a human in the tracker rather than settled here. Ticket 10's own "Where to start" said the package
// had already arrived in ticket 07; it had not, and that line is corrected in the ticket.
//
// Ticket 08 gave four reasons. Free-form lines and polygons over real geography are the case
// `terra-draw` is genuinely *for*, far more than a four-corner mask is, so they were re-weighed here
// rather than inherited. Three of the four still hold, and a fifth has appeared:
//
// 1. **Keyboard reach, which is the decisive one.** `terra-draw` edits inside a WebGL layer, and a
//    WebGL layer is not focusable. Whatever it drew would be the first mouse-only editable object in
//    the application, and "every drawing tool and style control is reachable and operable by
//    keyboard" is an acceptance criterion of *this* ticket, not a later pass. The `overlayPoints`
//    seam gives a named `<button>` per vertex with arrow-key movement and Delete already built and
//    already asserted.
//
// 2. **ADR-0017 rule 1.** This ticket's criterion is that a vertex edit produces *exactly one* store
//    write, on gesture end — a number, asserted by counting. `terra-draw`'s change events fire per
//    coordinate, so meeting the criterion would mean debouncing its stream back into the gesture it
//    came from. The seam's `onmoveend` already fires once per pointer-drag and once per arrow-key
//    hold.
//
// 3. **ADR-0019's cost.** Two runtime dependencies, two catalog pins, two third-party notices, and a
//    standing fence keeping both out of `apps/viewer` for ever.
//
// 4. ~~ADR-0005's projection rule~~ — this one **does not apply here**. Ticket 08's mask is in image
//    pixel space, so `terra-draw`'s store would have held synthetic lng/lat. Annotations are on real
//    geography, and this objection is void for them.
//
// 5. **One drawing mechanism, not two.** This is new, and it is what settles the question now that
//    the seam has been widened twice. Control Points, Resource Mask vertices, and Annotation
//    vertices are the same object to a user and to a keyboard: something you focus, nudge, and
//    delete. Adding `terra-draw` for only the third would mean two keyboard stories, two write-count
//    stories, and two sets of bugs — and the seam already carries the vertex editing that is most of
//    the work, including ticket 08's midpoint handles for inserting one.
//
// What is genuinely lost is a rubber-band preview that follows the pointer between clicks, and
// `terra-draw`'s Pro-style operations, which this ticket puts out of scope anyway. The preview is
// replaced by drawing the vertices placed so far, plus a live count and a status line — which is
// also what makes the gesture legible to a screen reader, where a rubber band is not.
//
// ============================================================================================

import type { AnnotationGeometry, GeoPoint } from '@ballastella/core';

/**
 * Which tool the toolbar has active.
 *
 * `'select'` is a tool rather than the absence of one, so that "I am not drawing" is a state the
 * toolbar can show as pressed and the status line can name. A null tool would make the same
 * information a double negative.
 */
export type AnnotationTool = 'select' | 'point' | 'line' | 'polygon';

/** How many vertices each tool needs before its shape is finishable. */
const MINIMUM_VERTICES: Record<AnnotationTool, number> = {
	select: 0,
	point: 1,
	line: 2,
	polygon: 3
};

/** What each tool is called, for the status line and the announcements. */
const TOOL_NAMES: Record<AnnotationTool, string> = {
	select: 'Select',
	point: 'Pin',
	line: 'Line',
	polygon: 'Shape'
};

export const toolName = (tool: AnnotationTool): string => TOOL_NAMES[tool];

/**
 * The gesture in progress.
 *
 * Holds **no store and no session**: it is the geometry a user is in the middle of describing, and
 * nothing here can write. The page turns a finished shape into an Annotation and commits it, which
 * keeps `EditorSession` the only writer (the rule ticket 04 broke) and keeps this testable as
 * ordinary state.
 */
export class AnnotationDrawing {
	tool = $state<AnnotationTool>('select');

	/**
	 * The vertices placed so far, in the order they were placed. Empty whenever nothing is in flight.
	 *
	 * `$state.raw`, because a placement replaces the whole array rather than pushing into it — the
	 * same reason the Layer stack's documents are raw.
	 */
	vertices = $state.raw<readonly GeoPoint[]>([]);

	/** Whether a shape is part-drawn, so that leaving the page or switching Layer can warn or discard. */
	get drawing(): boolean {
		return this.vertices.length > 0;
	}

	/** Whether what has been placed is enough to finish. */
	get canFinish(): boolean {
		return this.vertices.length >= MINIMUM_VERTICES[this.tool] && this.tool !== 'select';
	}

	/**
	 * Choose a tool. **Abandons anything part-drawn**, which is the honest reading of picking up a
	 * different tool — and it discards rather than committing, because a half-drawn shape the user
	 * walked away from is not something they asked to keep (the same rule as ADR-0022's pending half).
	 */
	choose(tool: AnnotationTool): void {
		this.tool = tool;
		this.vertices = [];
	}

	/**
	 * Place a vertex, and say whether that completed a shape.
	 *
	 * A pin completes on its first vertex, because one click is the whole gesture. A line and a shape
	 * accumulate until {@link finish}, so that "click, click, click" describes one route rather than
	 * three one-vertex ones.
	 *
	 * @returns the finished geometry when this placement completed the shape, otherwise `null`
	 */
	place(point: GeoPoint): AnnotationGeometry | null {
		if (this.tool === 'select') return null;
		this.vertices = [...this.vertices, point];
		if (this.tool !== 'point') return null;
		const geometry = this.geometry();
		this.vertices = [];
		return geometry;
	}

	/**
	 * End the gesture and hand back what was drawn, or `null` when there is not enough of it.
	 *
	 * The one commit point for a line or a shape — ADR-0017 rule 1's "the gesture is over" — so a
	 * shape with nine vertices costs one store write and not nine.
	 */
	finish(): AnnotationGeometry | null {
		if (!this.canFinish) return null;
		const geometry = this.geometry();
		this.vertices = [];
		return geometry;
	}

	/** Abandon what is part-drawn. Escape, or the cancel button beside the status line. */
	cancel(): boolean {
		if (!this.drawing) return false;
		this.vertices = [];
		return true;
	}

	/** Take back the last vertex placed, so a misplaced click is not the end of the shape. */
	undoVertex(): boolean {
		if (!this.drawing) return false;
		this.vertices = this.vertices.slice(0, -1);
		return true;
	}

	/** What has been placed, as a geometry. Only correct when {@link canFinish}. */
	private geometry(): AnnotationGeometry {
		const positions = this.vertices.map((vertex): [number, number] => [vertex.lng, vertex.lat]);
		switch (this.tool) {
			case 'point':
				return { type: 'Point', coordinates: positions[0] ?? [0, 0] };
			case 'line':
				return { type: 'LineString', coordinates: positions };
			case 'polygon':
				// **Closed here, and this is the whole of RFC 7946 §3.1.6**: a Polygon's ring is a
				// LinearRing, whose first and last positions must be identical. A ring left open is the
				// single most common way a hand-built GeoJSON file is rejected by other tools, which would
				// break exactly the portability claim ADR-0009 is for — geojson.io draws it, PostGIS and
				// shapely refuse it. The user never places the closing vertex, so nothing else can.
				return { type: 'Polygon', coordinates: [[...positions, positions[0] ?? [0, 0]]] };
			case 'select':
				return null;
		}
	}

	/**
	 * The gesture in words, for the announced status region.
	 *
	 * Said rather than only drawn, because the whole gesture is otherwise invisible to a screen-reader
	 * user: there is no rubber band to see, and "how many vertices have I placed" is the one thing
	 * they cannot get from the canvas.
	 */
	get status(): string {
		const placed = this.vertices.length;
		// **Nothing at all while selecting.** Clicking a shape to open it is what the map already does;
		// a sentence saying so was boilerplate sitting under the tools on every screen that was not
		// mid-gesture. The region stays in the DOM and empty, which is also what keeps it announceable:
		// `aria-live` announces a *change of text in a region that is already there*, so the next real
		// status is heard. There is nothing to announce about not drawing.
		if (this.tool === 'select') {
			return '';
		}
		if (this.tool === 'point') {
			return 'Click the map, or press Enter on it, to place a pin.';
		}
		const need = MINIMUM_VERTICES[this.tool] - placed;
		const shape = this.tool === 'line' ? 'line' : 'shape';
		if (placed === 0) {
			return `Click the map, or press Enter on it, to start a ${shape}.`;
		}
		if (need > 0) {
			return `${placed} ${placed === 1 ? 'point' : 'points'} placed. ${need} more and this ${shape} can be finished. Escape cancels it.`;
		}
		return `${placed} points placed. Double-click the map, press Shift and Enter, or use Finish, to complete this ${shape}. Escape cancels it.`;
	}
}
