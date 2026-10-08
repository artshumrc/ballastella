import {
	DEFAULT_TRANSFORMATION_TYPE,
	MINIMUM_MASK_VERTICES,
	collectControlPoints,
	fullImageResourceMask,
	insertMaskVertexAfter,
	maskEdgeMidpoints,
	moveMaskVertex,
	newAlignment,
	removeMaskVertex,
	resetMaskToFullImage,
	toDraftControlPoints,
	type Alignment,
	type ControlPoint,
	type DraftControlPoint,
	type GeoPoint,
	type ResourcePoint,
	type TransformationType
} from '@ballastella/core';

export type PendingHalf = 'resource' | 'geo';

export class AlignmentPairing {
	drafts = $state<DraftControlPoint[]>([]);
	selectedId = $state<string | null>(null);
	transformationType = $state<TransformationType>(DEFAULT_TRANSFORMATION_TYPE);
	resourceMask = $state<readonly ResourcePoint[]>([]);
	readonly #imageId: string;
	readonly #image: { readonly width: number; readonly height: number };
	#nextId = 0;

	constructor(imageId: string, image: { width: number; height: number }, stored?: Alignment) {
		this.#imageId = imageId;
		this.#image = { width: image.width, height: image.height };
		this.resourceMask = stored?.resourceMask ?? fullImageResourceMask(this.#image);
		if (stored) {
			this.drafts = [...toDraftControlPoints(stored)];
			this.#nextId = this.drafts.length;
			this.transformationType = stored.transformationType;
		}
	}

	readonly controlPoints: readonly ControlPoint[] = $derived(collectControlPoints(this.drafts));

	readonly pending:
		| (DraftControlPoint & {
				readonly half: PendingHalf;
				readonly message: string;
		  })
		| null = $derived.by(() => {
		const draft = this.drafts.find((one) => one.resource === null || one.geo === null);
		if (!draft) return null;
		const half: PendingHalf = draft.resource === null ? 'geo' : 'resource';
		return {
			...draft,
			half,
			message:
				half === 'resource'
					? 'Waiting for the matching place on the Base Map. Press Escape to cancel this Control Point.'
					: 'Waiting for the matching feature on the Map Image. Press Escape to cancel this Control Point.'
		};
	});

	get alignment(): Alignment {
		return {
			...newAlignment(this.#imageId, this.#image),
			controlPoints: this.controlPoints,
			resourceMask: this.resourceMask,
			transformationType: this.transformationType
		};
	}

	readonly maskEdgeMidpoints: readonly ResourcePoint[] = $derived(
		maskEdgeMidpoints(this.resourceMask)
	);

	readonly canRemoveMaskVertex: boolean = $derived(
		this.resourceMask.length > MINIMUM_MASK_VERTICES
	);

	moveMaskVertex(index: number, to: ResourcePoint): void {
		this.resourceMask = moveMaskVertex(this.alignment, index, to).resourceMask;
	}

	insertMaskVertexAfter(index: number): void {
		this.resourceMask = insertMaskVertexAfter(this.alignment, index).resourceMask;
	}

	removeMaskVertex(index: number): void {
		this.resourceMask = removeMaskVertex(this.alignment, index).resourceMask;
	}

	resetMask(): void {
		this.resourceMask = resetMaskToFullImage(this.alignment).resourceMask;
	}

	cancelPending(): boolean {
		const id = this.pending?.id;
		if (id === undefined) return false;
		this.remove(id);
		return true;
	}

	toggleSelected(id: string): void {
		this.selectedId = this.selectedId === id ? null : id;
	}

	move(id: string, half: PendingHalf, to: ResourcePoint | GeoPoint): void {
		this.drafts = this.drafts.map((draft) => (draft.id === id ? { ...draft, [half]: to } : draft));
	}

	remove(id: string): void {
		this.drafts = this.drafts.filter((draft) => draft.id !== id);
		if (this.selectedId === id) this.selectedId = null;
	}

	place(half: PendingHalf, at: ResourcePoint | GeoPoint): void {
		const waiting = this.pending;
		if (waiting) {
			this.move(waiting.id, half, at);
			if (waiting.half !== half) this.selectedId = waiting.id;
			return;
		}
		const id = `p${this.#nextId++}`;
		this.drafts = [
			...this.drafts,
			{ id, resource: null, geo: null, [half]: at } as DraftControlPoint
		];
		this.selectedId = id;
	}
}
