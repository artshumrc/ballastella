import { describe, expect, it } from 'vitest';

import { AnnotationDrawing, toolName } from './drawing.svelte.js';

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

		expect(drawing.picking).toBe(true);
		expect(drawing.tool).toBe('select');
		expect(drawing.drawing).toBe(false);
	});

	it.each([
		['point', 'Pin added'],
		['text', 'Label added']
	] as const)(
		'puts the %s tool down when it lands, because that click was the whole gesture, and says what was added',
		(tool, added) => {
			const drawing = armed(tool);
			const geometry = drawing.place({ lng: 4.9, lat: 52.37 });
			expect(geometry).toEqual({ type: 'Point', coordinates: [4.9, 52.37] });
			expect(drawing.tool).toBe('select');
			expect(drawing.picking).toBe(false);
			expect(drawing.vertices).toEqual([]);
			expect(drawing.status).toContain(added);
		}
	);

	it.each(['point', 'line', 'polygon', 'circle', 'text'] as const)(
		'is put down by Escape with the %s tool armed and nothing drawn',
		(tool) => {
			const drawing = armed(tool);
			expect(drawing.cancel()).toBe(true);
			expect(drawing.tool).toBe('select');
			expect(drawing.picking).toBe(false);
			expect(drawing.drawing).toBe(false);
			expect(drawing.status).toBe('');
		}
	);

	it('puts the tool down when a shape is finished, naming that shape', () => {
		const drawing = armed('polygon');
		drawing.place({ lng: 4.8, lat: 52.3 });
		drawing.place({ lng: 5, lat: 52.3 });
		drawing.place({ lng: 4.9, lat: 52.4 });

		const geometry = drawing.finish();
		expect(geometry?.type).toBe('Polygon');
		expect(drawing.tool).toBe('select');
		expect(drawing.picking).toBe(false);
		expect(drawing.status).toContain('Shape added');
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

	it('puts the tool down when a gesture is abandoned, which is over too, and says nothing about it', () => {
		const drawing = armed('line');
		drawing.place({ lng: 4.8, lat: 52.3 });

		expect(drawing.cancel()).toBe(true);
		expect(drawing.tool).toBe('select');
		expect(drawing.picking).toBe(false);
		expect(drawing.drawing).toBe(false);
		expect(drawing.status).toBe('');
	});

	it('refuses to finish a shape that is not one, and stays armed while it is not', () => {
		const drawing = armed('polygon');
		drawing.place({ lng: 4.8, lat: 52.3 });

		expect(drawing.finish()).toBeNull();
		expect(drawing.tool).toBe('polygon');
		expect(drawing.picking).toBe(true);
		expect(drawing.vertices).toHaveLength(1);
	});

	it('reports nothing to abandon with no tool in hand, and rests on demand, the only way out of the shapes with nothing drawn yet', () => {
		const drawing = new AnnotationDrawing();
		expect(drawing.cancel()).toBe(false);
		expect(drawing.status).toBe('');
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
	it.each([
		['text', 'Label', 'Click the map to place.'],
		['circle', 'Circle', 'Click the map to start.']
	] as const)('calls the %s tool a %s, in its own words', (tool, name, status) => {
		const drawing = armed(tool);
		expect(toolName(drawing.tool)).toBe(name);
		expect(drawing.status).toBe(status);
	});

	it('stops saying it the moment the next gesture is offered', () => {
		const drawing = armed('point');
		drawing.place({ lng: 4.9, lat: 52.37 });
		expect(drawing.status).toContain('Pin added');

		drawing.offerShapes();

		expect(drawing.status).toBe('');
	});

	it('stops saying it when the surface is put down whole', () => {
		const drawing = armed('line');
		drawing.place({ lng: 4.8, lat: 52.3 });
		drawing.place({ lng: 5, lat: 52.3 });
		drawing.finish();
		expect(drawing.status).toContain('Line added');

		drawing.returnToRest();

		expect(drawing.status).toBe('');
	});
});
