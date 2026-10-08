import {
	count,
	circleGeometry,
	circleRadiusMeters,
	type AnnotationGeometry,
	type GeoPoint
} from '@ballastella/core';

export type AnnotationTool = 'select' | 'point' | 'line' | 'polygon' | 'circle' | 'text';

const MINIMUM_VERTICES: Record<AnnotationTool, number> = {
	select: 0,
	point: 1,
	line: 2,
	polygon: 3,
	circle: 2,
	text: 1
};

const TOOL_NAMES: Record<AnnotationTool, string> = {
	select: 'Select',
	point: 'Pin',
	line: 'Line',
	polygon: 'Shape',
	circle: 'Circle',
	text: 'Label'
};

export const toolName = (tool: AnnotationTool): string => TOOL_NAMES[tool];

export class AnnotationDrawing {
	tool = $state<AnnotationTool>('select');
	picking = $state(false);
	added = $state<AnnotationTool | null>(null);
	vertices = $state.raw<readonly GeoPoint[]>([]);

	get drawing(): boolean {
		return this.vertices.length > 0;
	}

	get canFinish(): boolean {
		return this.vertices.length >= MINIMUM_VERTICES[this.tool] && this.tool !== 'select';
	}

	offerShapes(): void {
		this.picking = true;
		this.added = null;
	}

	choose(tool: AnnotationTool): void {
		this.tool = tool;
		this.vertices = [];
		this.picking = tool !== 'select';
	}

	place(point: GeoPoint): AnnotationGeometry | null {
		if (this.tool === 'select') return null;
		this.vertices = [...this.vertices, point];
		if (this.tool === 'circle' && this.vertices.length === 2) {
			const geometry = this.#geometry();
			if (geometry?.type === 'Circle' && geometry.radiusMeters <= 0) {
				this.vertices = this.vertices.slice(0, 1);
				return null;
			}
			return this.#complete();
		}
		return MINIMUM_VERTICES[this.tool] > 1 ? null : this.#complete();
	}

	finish(): AnnotationGeometry | null {
		return this.canFinish ? this.#complete() : null;
	}

	cancel(): boolean {
		if (!this.drawing && this.tool === 'select') return false;
		this.returnToRest();
		return true;
	}

	returnToRest(): void {
		this.added = null;
		this.#rest();
	}

	#complete(): AnnotationGeometry {
		const geometry = this.#geometry();
		this.added = this.tool;
		this.#rest();
		return geometry;
	}

	#rest(): void {
		this.vertices = [];
		this.tool = 'select';
		this.picking = false;
	}

	undoVertex(): boolean {
		if (!this.drawing) return false;
		this.vertices = this.vertices.slice(0, -1);
		return true;
	}

	#geometry(): AnnotationGeometry {
		const positions = this.vertices.map((vertex): [number, number] => [vertex.lng, vertex.lat]);
		const first = positions[0] ?? [0, 0];
		switch (this.tool) {
			case 'point':
			case 'text':
				return { type: 'Point', coordinates: first };
			case 'line':
				return { type: 'LineString', coordinates: positions };
			case 'polygon':
				return { type: 'Polygon', coordinates: [[...positions, first]] };
			case 'circle':
				return circleGeometry(first, circleRadiusMeters(first, positions[1] ?? first));
			case 'select':
				return null;
		}
	}

	get status(): string {
		const placed = this.vertices.length;
		if (this.tool === 'select') return this.added === null ? '' : `${toolName(this.added)} added.`;
		if (MINIMUM_VERTICES[this.tool] === 1) return 'Click the map to place.';
		if (this.tool === 'circle' && placed === 1) {
			return 'Center placed. Click the map to set the radius.';
		}
		if (placed === 0) return 'Click the map to start.';
		const need = MINIMUM_VERTICES[this.tool] - placed;
		if (need > 0) return `${count(placed, 'point')}. ${need} more needed.`;
		return `${placed} points. Done to finish.`;
	}
}
