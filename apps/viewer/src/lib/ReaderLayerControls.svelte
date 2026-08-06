<script lang="ts">
	// The Reader's view controls: which Layers are shown, and how strongly (SPEC story 83).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THIS IS NOT THE EDITOR'S `LayerList`
	//
	// **These are *view* controls, and reusing the editor's would be the specific mistake ticket 17 names.**
	// That list emits `ontypename`, `oncommit`, `onmove`, and `ondelete`, and every one of them ends in a
	// write to `project.json` — which is read-only over HTTP. A Reader dragging opacity would have produced
	// a failed write and a confusing error about somebody else's file. So there is no rename, no reorder,
	// no delete, and nothing here takes a store: what a Reader changes lives in the page's memory for the
	// length of a visit and is written nowhere.
	//
	// The stack's **order** is still honoured and is not editable, which is exactly right: `order` is the
	// author's argument (ADR-0002), and the list reads top-first so that "above in the list" and "above on
	// the map" are the same word. An `<ol>` carries that to assistive technology from the markup.
	//
	// Every control is a native element — `<input type="checkbox">` and `<input type="range">` are
	// ADR-0016's mandated methods. Nothing to trap focus in, nothing to reimplement, and the platform's own
	// touch behaviour on the phone most Readers arrive on.

	import type { Layer } from '@ballastella/core';
	import type { DrawnOutcome } from '@ballastella/core/render';

	let {
		layers,
		outcomes,
		referencedImageIds,
		onshow,
		onopacity,
		onunwarped
	}: {
		/** The stack, top first, exactly as the author ordered it. */
		layers: readonly Layer[];
		/** What became of each Layer on the map, keyed by Layer id. */
		outcomes: Readonly<Record<string, DrawnOutcome>>;
		/**
		 * The Historical Maps this site does not hold its own tiles for, by image id.
		 *
		 * **Passed in rather than read off the Layer, because ADR-0023 deleted the field that claimed it.**
		 * Whether the tiles are on this site is a fact about the site's files — an `info.json` of ours, or
		 * only a `remote.json` — and only the page that reads them can say. A Layer whose documents have
		 * not arrived is in neither state and is absent from this set, so the badge never says "needs the
		 * network" about a map nothing has looked for yet.
		 */
		referencedImageIds: ReadonlySet<string>;
		onshow: (id: string, visible: boolean) => void;
		onopacity: (id: string, opacity: number) => void;
		/** Read this Historical Map on its own, unwarped (SPEC story 85). */
		onunwarped: (id: string) => void;
	} = $props();

	/**
	 * What the last view change did, announced.
	 *
	 * Hiding a Layer changes the map and nothing near the control that changed it, so without this a
	 * screen-reader user toggles a Layer and is told only that a checkbox is unchecked — not that a
	 * Historical Map has left the map. SPEC story 96, and ticket 17's criterion that "layer state changes
	 * are announced".
	 */
	let announced = $state('');

	const name = (layer: Layer): string => layer.name || 'Untitled Layer';

	const show = (layer: Layer, visible: boolean): void => {
		onshow(layer.id, visible);
		announced = `${name(layer)} ${visible ? 'shown' : 'hidden'}`;
	};

	const opacity = (layer: Layer, value: number): void => {
		onopacity(layer.id, value);
		announced = `${name(layer)} at ${Math.round(value * 100)}%`;
	};

	/** How a Layer's kind reads, in CONTEXT.md's words. A kind this build cannot draw says so. */
	const kindLabel = (layer: Layer): string => {
		switch (layer.kind) {
			case 'map':
				return 'Historical Map';
			case 'annotation':
				return 'Annotations';
			case 'foreign':
				return `Not shown by this version of the viewer (${layer.declaredKind || 'unknown kind'})`;
		}
	};
</script>

<section aria-labelledby="reader-layers-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-x-4">
		<h2 id="reader-layers-heading" class="text-lg font-semibold">Layers</h2>
		<p class="text-sm opacity-70">The top of this list draws over everything below it.</p>
	</div>

	<div
		aria-live="polite"
		aria-atomic="true"
		class="min-h-6 text-sm"
		data-testid="layer-view-status"
	>
		{announced}
	</div>

	{#if layers.length === 0}
		<p class="max-w-prose">This Project has no Layers on it.</p>
	{:else}
		<!-- An `<ol>`, so the stack's order reaches assistive technology from the markup (ADR-0002). -->
		<ol class="flex flex-col gap-2" aria-label="Layers, top first" data-testid="reader-layers">
			{#each layers as layer, index (layer.id)}
				{@const outcome = outcomes[layer.id]}
				<li
					class="rounded border border-base-300 p-3"
					data-testid="reader-layer-row"
					data-layer-id={layer.id}
					data-layer-kind={layer.kind}
					data-layer-order={layer.order}
					data-layer-visible={layer.visible}
				>
					<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
						<span class="text-sm tabular-nums opacity-60" aria-hidden="true">
							{index + 1}/{layers.length}
						</span>

						<label class="flex grow items-center gap-2">
							<input
								type="checkbox"
								class="toggle toggle-sm"
								checked={layer.visible}
								data-testid="reader-layer-visible"
								aria-label="Show {name(layer)}"
								onchange={(event) => show(layer, event.currentTarget.checked)}
							/>
							<!--
								`name(layer)`, the same helper the `aria-label` above and the announcement use. An
								untitled Layer must read as "Untitled Layer" on the page as well as to a screen
								reader; interpolating `layer.name` left a sighted Reader a bare toggle with nothing
								beside it, on the one row where the announcement said a name aloud.
							-->
							<span class="font-medium">{name(layer)}</span>
						</label>
					</div>

					<div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
						<span class="opacity-70" data-testid="reader-layer-kind">{kindLabel(layer)}</span>

						{#if layer.kind === 'map'}
							<!--
								Whether this Historical Map's tiles are bytes in this site or on somebody else's server
								(SPEC story 29). The Reader is the person who meets the consequence — on a train, or
								after the library reorganises — so it is said here and not only warned about at publish
								time. In words, never a colour alone.

								Read from `referencedImageIds`, which is what this site's files say, rather than from the
								Layer, which no longer claims anything about it (ADR-0023).
							-->
							{@const referenced = referencedImageIds.has(layer.imageId)}
							<span
								class="badge badge-sm"
								class:badge-success={!referenced}
								class:badge-warning={referenced}
								data-testid="reader-layer-image-mode"
								data-image-mode={referenced ? 'referenced' : 'mirrored'}
							>
								{referenced
									? 'Held on another server — needs the network'
									: 'In this site — no network needed'}
							</span>

							<!-- ADR-0016 mandates the native range for opacity; there is nothing custom here. -->
							<label class="flex items-center gap-2">
								<span>Opacity</span>
								<input
									type="range"
									class="range max-w-40 range-sm"
									min="0"
									max="1"
									step="0.05"
									value={layer.opacity}
									aria-label="Opacity of {name(layer)}"
									data-testid="reader-layer-opacity"
									oninput={(event) => opacity(layer, Number(event.currentTarget.value))}
								/>
								<span data-testid="reader-layer-opacity-value">
									{Math.round(layer.opacity * 100)}%
								</span>
							</label>

							<button
								class="btn btn-sm"
								type="button"
								data-testid="reader-layer-unwarped"
								onclick={() => onunwarped(layer.id)}
							>
								Read as a document<span class="sr-only"> — {name(layer)}</span>
							</button>
						{/if}

						{#if outcome?.status === 'refused'}
							<span class="text-warning" data-testid="reader-layer-problem">{outcome.reason}</span>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>
