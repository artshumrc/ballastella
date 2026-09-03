// The drawing state machine, asserted directly.
//
// **Node, no DOM, no application**: `AnnotationDrawing` is a class holding a tool, the vertices placed
// so far, and whether the shapes are on offer. Every claim below is about what one of its own
// methods leaves behind, which is the cheapest seam that can fail for the reason each title gives —
// the browser suite can only reach these through a Project, a built app and a real MapLibre, and what
// it would then be asserting is `data-tool`.
//
// ⚠ **`.svelte.test.ts`, not `.test.ts`.** The class's fields are `$state`, and runes are only
// compiled in a file whose name carries the `.svelte.` infix. See `vitest.config.ts` for which Svelte
// runtime this project compiles to and why the default one made reactivity assertions vacuous.

import { describe, expect, it } from 'vitest';

import { AnnotationDrawing, toolName } from './drawing.svelte.js';

/** The shapes on offer with `tool` in hand, which is what "New Annotation" then a shape leaves. */
const armed = (tool: 'point' | 'line' | 'polygon' | 'circle' | 'text'): AnnotationDrawing => {
	const drawing = new AnnotationDrawing();
	drawing.offerShapes();
	drawing.choose(tool);
	return drawing;
};

describe('one press of New Annotation makes one Annotation', () => {
	it('offers the shapes without arming anything', () => {
		const drawing = new AnnotationDrawing();

		drawing.offerShapes();

		// The shapes are showing and nothing is drawn by a click yet: `select` is still the tool in hand,
		// which is what keeps "I am not drawing" a state rather than a double negative.
		expect(drawing.picking).toBe(true);
		expect(drawing.tool).toBe('select');
		expect(drawing.drawing).toBe(false);
	});

	it('puts the tool down when a pin lands, because that click was the whole gesture', () => {
		const drawing = armed('point');

		const geometry = drawing.place({ lng: 4.9, lat: 52.37 });

		expect(geometry).toEqual({ type: 'Point', coordinates: [4.9, 52.37] });
		// **The next click on the map selects rather than draws.** Nothing on the page decides this: one
		// press of the button made one Annotation and the surface is back where it started.
		expect(drawing.tool).toBe('select');
		expect(drawing.picking).toBe(false);
		expect(drawing.vertices).toEqual([]);
	});

	it('puts the tool down when a Label lands, whose gesture is the pin’s exactly', () => {
		// One click costs what placing a Pin costs, and the tool is down afterwards, so one press of "New
		// Annotation" made one Label. `'text'` is the tool's name in code only — every word a scholar
		// reads for it is "Label".
		const drawing = armed('text');

		const geometry = drawing.place({ lng: 4.9, lat: 52.37 });

		expect(geometry).toEqual({ type: 'Point', coordinates: [4.9, 52.37] });
		expect(drawing.tool).toBe('select');
		expect(drawing.picking).toBe(false);
		expect(drawing.vertices).toEqual([]);
	});

	// Escape and the Cancel button both come here: `ProjectScreen.svelte`'s window handler spends
	// `cancel()`'s boolean to decide whether to consume the key, and `AnnotationTools.svelte`'s Cancel
	// calls it before choosing `select`. So this *is* the Escape path, minus the keypress.
	it.each(['point', 'line', 'polygon', 'circle', 'text'] as const)(
		'is put down by Escape with the %s tool armed and nothing drawn',
		(tool) => {
			// "Mid-gesture" for a one-click tool means exactly "armed and not yet placed": there is no
			// part-drawn Label, so an Escape that only abandoned part-drawn shapes left the tool armed and
			// the next map click placed the Label the scholar had just abandoned. The armed-nothing-drawn
			// state belongs to every drawing tool, so the rule is one rule for all of them.
			const drawing = armed(tool);

			expect(drawing.cancel()).toBe(true);

			expect(drawing.tool).toBe('select');
			expect(drawing.picking).toBe(false);
			expect(drawing.drawing).toBe(false);
			// And nothing was added, so the region has nothing to announce about a gesture that made no
			// Annotation.
			expect(drawing.status).toBe('');
		}
	);

	it('puts the tool down when a shape is finished', () => {
		const drawing = armed('polygon');
		drawing.place({ lng: 4.8, lat: 52.3 });
		drawing.place({ lng: 5, lat: 52.3 });
		drawing.place({ lng: 4.9, lat: 52.4 });

		const geometry = drawing.finish();

		expect(geometry?.type).toBe('Polygon');
		expect(drawing.tool).toBe('select');
		expect(drawing.picking).toBe(false);
	});

	it('makes a semantic circle from a center and a radius point', () => {
		const drawing = armed('circle');

		expect(drawing.place({ lng: 4, lat: 7 })).toBeNull();
		expect(drawing.status).toBe('Center placed. Click the map to set the radius.');
		const geometry = drawing.place({ lng: 6, lat: 7 });

		expect(geometry?.type).toBe('Circle');
		if (geometry?.type !== 'Circle') throw new Error('expected a circle');
		const ring = geometry.coordinates[0]!;
		expect(geometry.center).toEqual([4, 7]);
		expect(geometry.radiusMeters).toBeGreaterThan(200_000);
		expect(ring).toHaveLength(65);
		expect(ring.at(-1)).toEqual(ring[0]);
		expect(drawing.tool).toBe('select');
	});

	it('stays armed when the second click lands on the center, which is no radius', () => {
		const drawing = armed('circle');
		drawing.place({ lng: 4, lat: 7 });

		expect(drawing.place({ lng: 4, lat: 7 })).toBeNull();

		expect(drawing.tool).toBe('circle');
		expect(drawing.drawing).toBe(true);
	});

	it('puts the tool down when a gesture is abandoned, which is over too', () => {
		const drawing = armed('line');
		drawing.place({ lng: 4.8, lat: 52.3 });

		expect(drawing.cancel()).toBe(true);

		expect(drawing.tool).toBe('select');
		expect(drawing.picking).toBe(false);
		expect(drawing.drawing).toBe(false);
	});

	it('reports nothing to abandon when no tool is in hand', () => {
		// The return value is the Escape key's ordering on the Project screen: a gesture in hand is what
		// Escape almost always means, and the open row is what is left when there is no gesture. A
		// `cancel()` that claimed to have abandoned something would swallow that second Escape — so with
		// nothing armed and nothing drawn it must say so.
		const drawing = new AnnotationDrawing();
		expect(drawing.cancel()).toBe(false);

		// The shapes merely on offer are not a tool in hand either: nothing is armed, so a click on the
		// map draws nothing and there is nothing for Escape to put down.
		drawing.offerShapes();
		expect(drawing.cancel()).toBe(false);
		expect(drawing.picking).toBe(true);
	});

	it('refuses to finish a shape that is not one, and stays armed while it is not', () => {
		const drawing = armed('polygon');
		drawing.place({ lng: 4.8, lat: 52.3 });

		expect(drawing.finish()).toBeNull();

		// Still mid-gesture: a Finish that fell through to rest would throw away the clicks so far.
		expect(drawing.tool).toBe('polygon');
		expect(drawing.picking).toBe(true);
		expect(drawing.vertices).toHaveLength(1);
	});

	it('rests on demand, which is the only way out of the shapes with nothing drawn yet', () => {
		// The state `cancel()` cannot end: the shapes are on offer and there is nothing part-drawn, so
		// cancelling correctly reports that it abandoned nothing and correctly leaves everything alone.
		// A change of Layer has to say "rest" outright, or it carries the shapes into a Layer where
		// "New Annotation" was never pressed.
		const drawing = new AnnotationDrawing();
		drawing.offerShapes();
		expect(drawing.cancel()).toBe(false);
		expect(drawing.picking).toBe(true);

		drawing.returnToRest();

		expect(drawing.picking).toBe(false);
		expect(drawing.tool).toBe('select');
	});

	it('leaves the shapes on offer while one is chosen, and puts them away on the way out', () => {
		const drawing = armed('line');
		expect(drawing.picking).toBe(true);

		drawing.choose('select');

		expect(drawing.picking).toBe(false);
		expect(drawing.tool).toBe('select');
	});
});

describe('the tool and the gesture are said in words', () => {
	it('says what was added rather than falling silent when the tool disarms itself', () => {
		const drawing = armed('point');

		drawing.place({ lng: 4.9, lat: 52.37 });

		// **The change is the scholar's to be told about.** The tool put itself down without being asked,
		// so a region that simply went empty would leave a screen-reader user holding a Pin tool that is
		// no longer in their hand.
		expect(drawing.status).toContain('Pin added');
	});

	it('calls the Label a Label, in the tool’s own words and in what was added', () => {
		// The reason `TOOL_NAMES` exists: the union spells the tool `'text'` and no announcement ever
		// does. The toolbar puts `toolName(tool)` in front of the gesture, so the region reads "Label
		// tool. Click the map to place."
		const drawing = armed('text');
		expect(toolName(drawing.tool)).toBe('Label');
		expect(drawing.status).toBe('Click the map to place.');

		drawing.place({ lng: 4.9, lat: 52.37 });

		expect(drawing.status).toContain('Label added');
	});

	it('calls the rounded-shape tool a Circle', () => {
		const drawing = armed('circle');
		expect(toolName(drawing.tool)).toBe('Circle');
		expect(drawing.status).toBe('Click the map to start.');
	});

	it('names the shape that was finished, not the one before it', () => {
		const drawing = armed('polygon');
		drawing.place({ lng: 4.8, lat: 52.3 });
		drawing.place({ lng: 5, lat: 52.3 });
		drawing.place({ lng: 4.9, lat: 52.4 });

		drawing.finish();

		expect(drawing.status).toContain('Shape added');
	});

	it('says nothing about an abandoned gesture, and nothing at rest', () => {
		const drawing = armed('line');
		drawing.place({ lng: 4.8, lat: 52.3 });

		drawing.cancel();

		// Nothing was added, so there is nothing to announce — and the region stays in the DOM and empty,
		// which is what lets `aria-live` announce the next real status as a *change*.
		expect(drawing.status).toBe('');
		expect(new AnnotationDrawing().status).toBe('');
	});

	it('stops saying it the moment the next gesture is offered', () => {
		const drawing = armed('point');
		drawing.place({ lng: 4.9, lat: 52.37 });
		expect(drawing.status).toContain('Pin added');

		drawing.offerShapes();

		expect(drawing.status).toBe('');
	});

	it('stops saying it when the surface is put down whole', () => {
		// The sentence says the shape is selected so it can be titled, and a change of Layer takes both
		// the shape and the selection off the screen. `AnnotationEditing` clears it on the other paths
		// that make it false — a deselection and a deletion — because only it can see them.
		const drawing = armed('line');
		drawing.place({ lng: 4.8, lat: 52.3 });
		drawing.place({ lng: 5, lat: 52.3 });
		drawing.finish();
		expect(drawing.status).toContain('Line added');

		drawing.returnToRest();

		expect(drawing.status).toBe('');
	});
});
