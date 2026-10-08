import {
	baseMapArchiveHost,
	baseMapUnavailableNotice,
	mapImageTilesUnavailableNotice,
	type BaseMapEntry,
	type Layer,
	type OpeningViewFit,
	type OpeningViewOutcome,
	type TileFetchOutcome
} from '@ballastella/core';
import {
	canCaptureSnapshot,
	initialSnapshotReadiness,
	mapSnapshotFileName,
	snapshotAvailability,
	snapshotReadinessAfter,
	type FrameInvalidator,
	type SnapshotReadinessEvent
} from '@ballastella/core/render';
import { tick, untrack } from 'svelte';

import { ANNOTATION_INSPECTOR_ID } from './constants.js';
import { saveFile } from './save-file';

export class MapView {
	#layers: () => readonly Layer[];
	#tileFailure = $state.raw<Extract<TileFetchOutcome, { ok: false }> | null>(null);

	snapshot = $state.raw(initialSnapshotReadiness);
	readonly snapshotReady = $derived(snapshotAvailability(this.snapshot).state === 'ready');
	baseMapUnavailable = $state(false);
	openingFit = $state.raw<OpeningViewFit | null>(null);
	openingOutcome = $state<OpeningViewOutcome>('pending');
	refitted = $state(false);

	readonly tilesMissing = $derived(this.#tileFailure !== null);
	readonly tilesUnavailable = $derived.by((): string | null => {
		const failed = this.#tileFailure;
		if (!failed) return null;
		const named = this.#layers().find(
			(layer) => layer.kind === 'map' && layer.imageId === failed.imageId
		);
		return mapImageTilesUnavailableNotice(failed.failure, named?.name ?? null);
	});

	constructor(layers: () => readonly Layer[], baseMapKey: () => unknown) {
		this.#layers = layers;
		$effect(() => {
			baseMapKey();
			this.baseMapUnavailable = false;
			this.send({ kind: 'base-map-assets', failed: false });
		});
	}

	// Sent from inside effects, which must not subscribe to what they write.
	send = (event: SnapshotReadinessEvent): void => {
		this.snapshot = snapshotReadinessAfter(
			untrack(() => this.snapshot),
			event
		);
	};

	onTileOutcome = (outcome: TileFetchOutcome): void => {
		this.#tileFailure = outcome.ok ? null : outcome;
		this.send({ kind: 'map-image-assets', failed: !outcome.ok });
	};

	onBaseMapStatus = (status: 'drawing' | 'unavailable'): void => {
		this.baseMapUnavailable = status === 'unavailable';
		this.send({ kind: 'base-map-assets', failed: this.baseMapUnavailable });
	};

	onInvalidateFrame = (by: FrameInvalidator): void => this.send({ kind: 'frame-invalidated', by });

	onFrameSettled = (generation: number): void => this.send({ kind: 'frame-settled', generation });

	unavailableNotice(entry: BaseMapEntry | undefined, online: boolean): string | null {
		return entry && this.baseMapUnavailable && online
			? baseMapUnavailableNotice(entry, baseMapArchiveHost(entry))
			: null;
	}

	frame(fit: OpeningViewFit | null, refitted?: boolean): void {
		this.openingFit = fit;
		this.openingOutcome = fit === null ? 'default' : 'content';
		if (refitted !== undefined) this.refitted = refitted;
	}

	unframe(): void {
		this.openingFit = null;
		this.openingOutcome = 'pending';
		this.refitted = false;
	}

	async capture(
		pane: { captureSnapshot(): Promise<Blob> } | undefined,
		directory: string | undefined
	): Promise<void> {
		if (!pane || directory === undefined || !canCaptureSnapshot(this.snapshot)) return;
		this.send({ kind: 'capture-started' });
		try {
			await saveFile(mapSnapshotFileName(directory), await pane.captureSnapshot());
			this.send({ kind: 'capture-finished' });
		} catch {
			this.send({ kind: 'capture-failed' });
		}
	}
}

export const annotationRow = (
	container: ParentNode | undefined,
	id: string | null
): HTMLElement | null =>
	id === null || !container
		? null
		: container.querySelector<HTMLElement>(
				`[data-testid="annotation-row"][data-annotation-id="${CSS.escape(id)}"]`
			);

// Focus would otherwise strand on the panel during its 220ms exit.
export async function returnFocusFromInspector(row: Element | null | undefined): Promise<void> {
	await tick();
	const active = document.activeElement;
	const leaving = document.getElementById(ANNOTATION_INSPECTOR_ID);
	const stranded = active === document.body || (active !== null && leaving?.contains(active));
	if (stranded && row instanceof HTMLElement) row.focus();
}
