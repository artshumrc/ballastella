import {
	addAnnotation,
	circleGeometry,
	circleRadiusMeters,
	findAnnotation,
	newAnnotation,
	isLabel as annotationIsLabel,
	messageOf,
	resolveStyle,
	styleForNewAnnotation,
	styleForNewLabel,
	removeAnnotation,
	moveAnnotation,
	setGeometry,
	setLineStyle,
	setStyle,
	setText,
	type Annotation,
	type AnnotationCollection,
	type AnnotationGeometry,
	type AnnotationLayer,
	type GeoPoint,
	type Layer,
	type LineStyle
} from '@ballastella/core';

import type { AnnotationDragPreview } from '@ballastella/ui/LayerStackMap.svelte';
import type { BaseMapOverlayPoint } from '$lib/base-map/BaseMapPane.svelte';

import { AnnotationDrawing } from './drawing.svelte.js';

export interface AnnotationWriter {
	readAnnotations(layer: AnnotationLayer): Promise<AnnotationCollection>;
	writeAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		options?: { debounce?: boolean; label?: string }
	): Promise<void>;
	dragAnnotations(
		layer: AnnotationLayer,
		collection: AnnotationCollection,
		drag: { key: string; label: string }
	): Promise<void>;
	moveAnnotationBetweenLayers(
		to: AnnotationLayer,
		target: AnnotationCollection,
		from: AnnotationLayer,
		source: AnnotationCollection,
		label: string
	): Promise<void>;
	hasPendingAnnotationWrite(layer: AnnotationLayer): boolean;
}

interface AnnotationEdges {
	session: () => AnnotationWriter;
	layers: () => readonly Layer[];
	documents: () => Readonly<Record<string, unknown>>;
	replaceDocument: (layerId: string, collection: AnnotationCollection) => void;
}

const undoLabel = (verb: string, annotation: Annotation): string => {
	const title = annotation.properties.title;
	return `Undo ${verb} ${title ? `“${title}”` : 'this Annotation'}`;
};

interface CommitOptions {
	debounce?: boolean;
	label?: string;
	drag?: { key: string; label: string };
}

function withVertex(
	geometry: Exclude<AnnotationGeometry, { type: 'foreign' } | null>,
	index: number,
	moved: [number, number]
): AnnotationGeometry {
	const replace = (positions: readonly (readonly [number, number])[]) =>
		positions.map((position, at) => (at === index ? moved : position));
	switch (geometry.type) {
		case 'Point':
			return { type: 'Point', coordinates: moved };
		case 'LineString':
			return { type: 'LineString', coordinates: replace(geometry.coordinates) };
		case 'Circle':
			return index === 0
				? circleGeometry(moved, geometry.radiusMeters)
				: circleGeometry(geometry.center, circleRadiusMeters(geometry.center, moved));
		case 'Polygon': {
			const positions = replace((geometry.coordinates[0] ?? []).slice(0, -1));
			return {
				type: 'Polygon',
				coordinates: [[...positions, positions[0] ?? moved], ...geometry.coordinates.slice(1)]
			};
		}
	}
}

interface Found {
	collection: AnnotationCollection;
	annotation: Annotation;
}

export class AnnotationEditing {
	readonly #edges!: AnnotationEdges;
	readonly drawing = new AnnotationDrawing();

	constructor(edges: AnnotationEdges) {
		this.#edges = edges;
	}

	readonly #annotationLayers = $derived(
		this.#edges.layers().filter((layer): layer is AnnotationLayer => layer.kind === 'annotation')
	);

	readonly annotationLayerCount = $derived(this.#annotationLayers.length);
	openLayerId = $state<string | null>(null);
	selectedAnnotationId = $state<string | null>(null);
	dragPreview = $state<AnnotationDragPreview | null>(null);
	titlingId = $state<string | null>(null);
	moveRefusal = $state('');
	moveNotice = $state('');

	readonly activeLayer = $derived<AnnotationLayer | null>(
		this.#annotationLayers.find((layer) => layer.id === this.openLayerId) ?? null
	);

	readonly activeCollection = $derived<AnnotationCollection | null>(
		this.activeLayer === null
			? null
			: ((this.#edges.documents()[this.activeLayer.id] as AnnotationCollection | undefined) ?? null)
	);

	readonly selectedAnnotation = $derived(
		this.activeCollection && this.selectedAnnotationId
			? (findAnnotation(this.activeCollection, this.selectedAnnotationId) ?? null)
			: null
	);

	readonly selectedIndex = $derived(
		this.activeCollection && this.selectedAnnotationId
			? this.activeCollection.annotations.findIndex((one) => one.id === this.selectedAnnotationId)
			: -1
	);

	readonly selectedIsDrawable = $derived.by(() => {
		const type = this.selectedAnnotation?.geometry?.type;
		return type === 'Point' || type === 'LineString' || type === 'Polygon' || type === 'Circle';
	});

	readonly moveTargets = $derived<readonly { id: string; name: string }[]>(
		this.#annotationLayers
			.filter((layer) => layer.id !== this.openLayerId)
			.map((layer) => ({ id: layer.id, name: layer.name }))
	);

	#find(id = this.selectedAnnotationId): Found | null {
		const collection = this.activeCollection;
		const annotation = collection && id ? findAnnotation(collection, id) : undefined;
		return collection && annotation ? { collection, annotation } : null;
	}

	openLayer(id: string | null): void {
		this.openLayerId = id;
		this.dragPreview = null;
		this.selectAnnotation(null);
		this.drawing.returnToRest();
	}

	selectAnnotation(id: string | null): void {
		this.selectedAnnotationId = id;
		this.dragPreview = null;
		this.titlingId = null;
		this.drawing.added = null;
	}

	releaseMissingSelection(): void {
		if (this.selectedAnnotationId !== null && this.activeCollection && !this.#find()) {
			this.selectAnnotation(null);
		}
	}

	openFromMap(layerId: string, annotationId: string): void {
		this.openLayerId = layerId;
		this.selectAnnotation(annotationId);
	}

	async #commit(next: AnnotationCollection, options: CommitOptions = {}): Promise<void> {
		const layer = this.activeLayer;
		if (!layer || next === this.#edges.documents()[layer.id]) return;
		this.#edges.replaceDocument(layer.id, next);
		if (options.drag) await this.#edges.session().dragAnnotations(layer, next, options.drag);
		else await this.#edges.session().writeAnnotations(layer, next, options);
	}

	async placePoint(point: GeoPoint): Promise<void> {
		if (this.drawing.tool === 'select') return;
		const label = this.drawing.tool === 'text';
		const finished = this.drawing.place(point);
		if (finished !== null) await this.#addDrawn(finished, { label });
	}

	async finishShape(): Promise<void> {
		const finished = this.drawing.finish();
		if (finished !== null) await this.#addDrawn(finished);
	}

	async placePin(point: GeoPoint, title: string): Promise<void> {
		this.drawing.added = null;
		await this.#addDrawn({ type: 'Point', coordinates: [point.lng, point.lat] }, { title });
	}

	async #addDrawn(
		geometry: AnnotationGeometry,
		options: { title?: string; label?: boolean } = {}
	): Promise<void> {
		const { title, label = false } = options;
		const collection = this.activeCollection ?? { annotations: [] };
		const annotation = newAnnotation({
			id: crypto.randomUUID(),
			geometry,
			title,
			style: label ? styleForNewLabel(collection) : styleForNewAnnotation(collection)
		});
		const added = this.drawing.added;
		this.selectAnnotation(annotation.id);
		this.drawing.added = added;
		if (title === undefined) this.titlingId = annotation.id;
		await this.#commit(addAnnotation(collection, annotation), {
			label: undoLabel('drawing', annotation)
		});
	}

	readonly annotationPoints = $derived.by((): BaseMapOverlayPoint[] => {
		const points: BaseMapOverlayPoint[] = this.drawing.vertices.map((vertex, index) => ({
			key: `annotation-draft-${index}`,
			point: vertex,
			kind: 'annotation-draft',
			ordinal: index + 1,
			label: `Point ${index + 1} of the shape being drawn`
		}));

		const annotation = this.selectedAnnotation;
		const geometry = annotation?.geometry;
		if (!annotation || !geometry || geometry.type === 'foreign') return points;
		const name = annotation.properties.title || 'this Annotation';
		const circle = geometry.type === 'Circle';
		const positions: readonly (readonly [number, number])[] =
			geometry.type === 'Point'
				? [geometry.coordinates]
				: geometry.type === 'Circle'
					? [geometry.center, geometry.coordinates[0]?.[16] ?? geometry.center]
					: geometry.type === 'Polygon'
						? (geometry.coordinates[0] ?? []).slice(0, -1)
						: geometry.coordinates;

		positions.forEach((position, index) => {
			points.push({
				key: `annotation-vertex-${annotation.id}-${index}`,
				point: { lng: position[0] ?? 0, lat: position[1] ?? 0 },
				kind: 'annotation-vertex',
				...(circle ? { glyph: index === 0 ? 'C' : 'R' } : { ordinal: index + 1 }),
				label: circle
					? `${index === 0 ? 'Center' : 'Radius'} of ${name}. Arrow keys move it.`
					: `Point ${index + 1} of ${positions.length} of ${name}. Arrow keys move it.`,
				onmove: (to) => this.previewReshape(index, to),
				onmoveend: (to) => void this.reshape(index, to)
			});
		});

		return points;
	});

	#reshaped(index: number, to: GeoPoint): (Found & { geometry: AnnotationGeometry }) | null {
		const found = this.#find();
		const geometry = found?.annotation.geometry;
		if (!found || !geometry || geometry.type === 'foreign') return null;
		return { ...found, geometry: withVertex(geometry, index, [to.lng, to.lat]) };
	}

	async reshape(index: number, to: GeoPoint): Promise<void> {
		const reshaped = this.#reshaped(index, to);
		const write =
			reshaped &&
			this.#commit(setGeometry(reshaped.collection, reshaped.annotation.id, reshaped.geometry), {
				label: undoLabel('moving', reshaped.annotation)
			});
		this.dragPreview = null;
		await write;
	}

	previewReshape(index: number, to: GeoPoint): void {
		const reshaped = this.#reshaped(index, to);
		if (!reshaped || !this.activeLayer) return;
		this.dragPreview = {
			layerId: this.activeLayer.id,
			annotationId: reshaped.annotation.id,
			geometry: reshaped.geometry
		};
	}

	async moveAnnotationTo(id: string, toIndex: number): Promise<void> {
		const found = this.#find(id);
		if (!found) return;
		await this.#commit(moveAnnotation(found.collection, id, toIndex), {
			label: undoLabel('reordering', found.annotation)
		});
	}

	async moveAnnotationToLayer(id: string, toLayerId: string): Promise<void> {
		this.moveRefusal = '';
		this.moveNotice = '';
		const from = this.activeLayer;
		const to = this.#annotationLayers.find((layer) => layer.id === toLayerId);
		const found = this.#find(id);
		if (!from || !to || to.id === from.id || !found) return;
		const { collection, annotation } = found;

		let target = this.#edges.documents()[to.id] as AnnotationCollection | undefined;
		if (target === undefined) {
			try {
				target = await this.#edges.session().readAnnotations(to);
			} catch (cause) {
				this.moveRefusal =
					`The Annotation was not moved: ${to.name || 'the Annotation Layer'} could not be read. ` +
					messageOf(cause);
				return;
			}
		}

		const moved = addAnnotation(target, annotation);
		const left = removeAnnotation(collection, id);
		this.#edges.replaceDocument(to.id, moved);
		this.#edges.replaceDocument(from.id, left);
		await this.#edges
			.session()
			.moveAnnotationBetweenLayers(
				to,
				moved,
				from,
				left,
				`${undoLabel('moving', annotation)} to ${to.name ? `“${to.name}”` : 'another Layer'}`
			);
		this.openLayerId = to.id;
		this.selectAnnotation(id);
		this.moveNotice =
			`${annotation.properties.title || 'The Annotation'} moved to ` +
			`${to.name || 'an untitled Annotation Layer'}.`;
	}

	async deleteSelected(): Promise<void> {
		const found = this.#find();
		if (!found) return;
		this.selectAnnotation(null);
		await this.#commit(removeAnnotation(found.collection, found.annotation.id), {
			label: undoLabel('delete of', found.annotation)
		});
	}

	async typeText(text: { title?: string; description?: string }): Promise<void> {
		const found = this.#find();
		if (!found) return;
		await this.#commit(setText(found.collection, found.annotation.id, text), { debounce: true });
	}

	async commitAnnotationEdit(): Promise<void> {
		const layer = this.activeLayer;
		const collection = this.activeCollection;
		if (!layer || !collection) return;
		if (!this.#edges.session().hasPendingAnnotationWrite(layer)) return;
		await this.#edges.session().writeAnnotations(layer, collection);
	}

	async styleSelected(
		style: Record<string, unknown>,
		options: { debounce?: boolean } = {}
	): Promise<void> {
		const found = this.#find();
		if (!found) return;
		const { id } = found.annotation;
		const label = undoLabel('restyling', found.annotation);
		const next = setStyle(found.collection, id, style);
		const key = `${id}:${Object.keys(style).sort().join(',')}`;
		await this.#commit(next, options.debounce ? { drag: { key, label } } : { label });
	}

	async lineStyleSelected(line: LineStyle): Promise<void> {
		const found = this.#find();
		if (!found) return;
		await this.#commit(setLineStyle(found.collection, found.annotation.id, line), {
			label: undoLabel('restyling', found.annotation)
		});
	}

	async applySelectedStyleToLayer(): Promise<void> {
		const found = this.#find();
		if (!found) return;
		const { collection, annotation: source } = found;

		const resolved = resolveStyle(source.properties);
		const fill = { fill: resolved.fill, 'fill-opacity': resolved['fill-opacity'] };
		const line = {
			stroke: resolved.stroke,
			'stroke-opacity': resolved['stroke-opacity'],
			'stroke-width': resolved['stroke-width'],
			'stroke-dasharray': resolved['stroke-dasharray']
		};
		const styleFor = (annotation: Annotation): Record<string, unknown> => {
			const geometry = annotation.geometry?.type;
			const label = annotationIsLabel(annotation);
			if (label || geometry === 'Point') {
				return {
					'marker-color': resolved['marker-color'],
					'marker-size': resolved['marker-size'] ?? 'medium',
					...(label ? fill : {})
				};
			}
			if (geometry === 'Polygon') return { ...fill, ...line };
			if (geometry === 'LineString') return line;
			return {};
		};

		let next = collection;
		for (const annotation of collection.annotations) {
			next = setStyle(next, annotation.id, styleFor(annotation));
		}
		await this.#commit(next, {
			label: undoLabel('applying the style of', source) + ' to the Layer'
		});
	}
}
