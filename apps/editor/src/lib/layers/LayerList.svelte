<script lang="ts">
	// The Project's ordered stack, as a user reads and edits it (SPEC stories 49–54).
	//
	// **Custom, and necessarily so.** No library provides drag-to-reorder, so this list is hand-built
	// either way — and because Layer order is load-bearing in this application (ADR-0002), a drag-only
	// implementation would make core functionality keyboard-inaccessible. So the move-up and move-down
	// buttons are the contract and the drag is the convenience, not the reverse (ADR-0016).
	//
	// Every control here is a native element: `<input type="range">` for opacity and `<input
	// type="checkbox">` for visibility are ADR-0016's mandated methods, and a `<button>` is a button.
	// There is nothing to trap focus in and nothing to reimplement.
	//
	// The list is an `<ol>`, so its structure *and* its order reach assistive technology from the
	// markup rather than from a label somebody has to remember to update — and the numbers are visible,
	// because "which Layer is third" is information a sighted user needs too.

	import type { Layer } from '@ballastella/core';

	import type { DrawnOutcome } from './stack-layers';

	let {
		layers,
		outcomes,
		ontypename,
		oncommit,
		onshow,
		ondragopacity,
		onmove
	}: {
		/** The stack, top first. Index 0 draws over everything else. */
		layers: readonly Layer[];
		/** What became of each Layer on the map, keyed by Layer id. */
		outcomes: Readonly<Record<string, DrawnOutcome>>;
		ontypename: (id: string, name: string) => void;
		/** The edit that was in flight is over — a field blurred, a slider released (ADR-0017 rule 1). */
		oncommit: () => void;
		onshow: (id: string, visible: boolean) => void;
		ondragopacity: (id: string, opacity: number) => void;
		/** Move the Layer to a position in the stack, 0 being the top. */
		onmove: (id: string, toIndex: number) => void;
	} = $props();

	/**
	 * What the last reorder did, announced.
	 *
	 * A move changes nothing that has focus and nothing that is visible near the pointer, so without
	 * this a screen-reader user presses "Move up" and is told nothing at all. `aria-live` rather than
	 * `role="status"`, because the save indicator already owns that role on this page.
	 */
	let moved = $state('');

	/** The Layer being dragged, or `''`. Also what makes the drop target visible. */
	let dragging = $state('');
	let over = $state('');

	const describeMove = (name: string, toIndex: number): string =>
		`${name || 'Untitled Layer'} moved to ${toIndex + 1} of ${layers.length}`;

	const move = (id: string, name: string, toIndex: number): void => {
		if (toIndex < 0 || toIndex >= layers.length) return;
		onmove(id, toIndex);
		moved = describeMove(name, toIndex);
	};

	/**
	 * How a Layer's kind reads. A kind this build has never heard of says so rather than pretending:
	 * ADR-0014 expects a third one, and a Project carrying it is a Project this build can still
	 * reorder and rename.
	 */
	const kindLabel = (layer: Layer): string => {
		switch (layer.kind) {
			case 'map':
				return 'Historical Map';
			case 'annotation':
				return 'Annotations';
			case 'foreign':
				return `Not shown by this version (${layer.declaredKind || 'unknown kind'})`;
		}
	};
</script>

<section aria-labelledby="layer-stack-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-4">
		<h3 id="layer-stack-heading" class="text-lg font-semibold">Layers</h3>
		<p class="text-sm opacity-70">The top of this list draws over everything below it.</p>
	</div>

	<div
		aria-live="polite"
		aria-atomic="true"
		class="min-h-6 text-sm"
		data-testid="layer-move-status"
	>
		{moved}
	</div>

	{#if layers.length === 0}
		<p class="max-w-prose">
			No Layers yet. Aligning a Historical Map puts it here, and an Annotation Layer can be added
			whenever you have something to say over it.
		</p>
	{:else}
		<ol class="mt-2 flex list-inside list-decimal flex-col gap-2" aria-label="Layers, top first">
			{#each layers as layer, index (layer.id)}
				{@const outcome = outcomes[layer.id]}
				<!--
					`draggable` on the row, with the two buttons beside it as the keyboard path. Playwright
					drives the drag through the same HTML5 events a mouse produces, so the two routes to a
					reorder are asserted against the same implementation.
				-->
				<li
					class="rounded border border-base-300 p-3"
					class:opacity-50={dragging === layer.id}
					class:border-primary={over === layer.id && dragging !== layer.id}
					draggable="true"
					data-testid="layer-row"
					data-layer-id={layer.id}
					data-layer-kind={layer.kind}
					data-layer-order={layer.order}
					ondragstart={(event) => {
						dragging = layer.id;
						event.dataTransfer?.setData('text/plain', layer.id);
					}}
					ondragend={() => {
						dragging = '';
						over = '';
					}}
					ondragover={(event) => {
						// Without this the drop never fires: the default action of `dragover` is to refuse.
						event.preventDefault();
						over = layer.id;
					}}
					ondragleave={() => {
						if (over === layer.id) over = '';
					}}
					ondrop={(event) => {
						event.preventDefault();
						const id = event.dataTransfer?.getData('text/plain') || dragging;
						over = '';
						dragging = '';
						if (!id || id === layer.id) return;
						const from = layers.findIndex((other) => other.id === id);
						move(id, layers[from]?.name ?? '', index);
					}}
				>
					<div class="flex flex-wrap items-center gap-3">
						<label class="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								class="toggle toggle-sm"
								checked={layer.visible}
								data-testid="layer-visible"
								onchange={(event) => onshow(layer.id, event.currentTarget.checked)}
							/>
							<span>Show <span class="sr-only">{layer.name || 'Untitled Layer'}</span></span>
						</label>

						<label class="floating-label grow">
							<span>Layer name</span>
							<!--
								Typing coalesces into one write and the edit is committed when it *ends* — and
								`oncommit` is a no-op unless something is pending, because tabbing through this
								field must not rewrite `project.json` with a fresh `updatedAt` (ADR-0010, ADR-0017).
							-->
							<input
								class="input w-full input-sm"
								value={layer.name}
								aria-label="Name of Layer {index + 1} of {layers.length}"
								data-testid="layer-name"
								oninput={(event) => ontypename(layer.id, event.currentTarget.value)}
								onchange={() => oncommit()}
								onblur={() => oncommit()}
							/>
						</label>

						<div class="flex items-center gap-1">
							<button
								class="btn btn-sm"
								disabled={index === 0}
								data-testid="layer-move-up"
								onclick={() => move(layer.id, layer.name, index - 1)}
							>
								Move up<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
							</button>
							<button
								class="btn btn-sm"
								disabled={index === layers.length - 1}
								data-testid="layer-move-down"
								onclick={() => move(layer.id, layer.name, index + 1)}
							>
								Move down<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
							</button>
						</div>
					</div>

					<div class="mt-2 flex flex-wrap items-center gap-4 text-sm">
						<span class="opacity-70" data-testid="layer-kind">{kindLabel(layer)}</span>

						{#if layer.kind === 'map'}
							<!--
								Whether this Layer's tiles are bytes in this Project or a URL somewhere else. Shown
								here rather than only warned about at publish time (ticket 16), because it is what
								decides whether a reader needs the network and whether the work survives the host
								disappearing — and by then it is too late to be the first mention of it.
							-->
							<span
								class="badge badge-sm"
								class:badge-success={layer.imageMode !== 'referenced'}
								class:badge-warning={layer.imageMode === 'referenced'}
								data-testid="layer-image-mode"
								data-image-mode={layer.imageMode}
							>
								{layer.imageMode === 'referenced'
									? 'Remote reference — needs the network'
									: 'Local copy — no network needed'}
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
									aria-label="Opacity of {layer.name || 'Untitled Layer'}"
									data-testid="layer-opacity"
									oninput={(event) => ondragopacity(layer.id, Number(event.currentTarget.value))}
									onchange={() => oncommit()}
								/>
								<output data-testid="layer-opacity-value">
									{Math.round(layer.opacity * 100)}%
								</output>
							</label>
						{/if}

						{#if outcome?.status === 'refused'}
							<span class="text-warning" data-testid="layer-problem">{outcome.reason}</span>
						{/if}
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>
