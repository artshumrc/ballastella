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
	// markup rather than from a label somebody has to remember to update. The position is drawn beside
	// each row as well, and `aria-hidden` there, because the `<ol>` already says it — announcing
	// "1 of 2" twice per row is worse than not drawing it.

	import type { Layer } from '@ballastella/core';
	import { tick } from 'svelte';

	import type { DrawnOutcome } from '@ballastella/core/render';

	let {
		layers,
		outcomes,
		ontypename,
		oncommit,
		onshow,
		ondragopacity,
		onmove,
		ondelete
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
		/**
		 * Delete the Layer **and the file it draws** (SPEC story 49, ticket 11).
		 *
		 * No confirmation dialog, and that is a decision rather than an omission: ticket 09 deliberately
		 * shipped `removeLayer` with no button at all, on the reasoning that the affordance belongs with
		 * the single-level undo that makes it safe (ADR-0014). The undo is that safety, and it works after
		 * autosave has written the deletion — which a dialog does not give you, since a user who means to
		 * delete confirms without reading and one who does not needs the way back either way.
		 */
		ondelete: (id: string) => void;
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

	const move = (id: string, name: string, toIndex: number): boolean => {
		if (toIndex < 0 || toIndex >= layers.length) return false;
		onmove(id, toIndex);
		moved = describeMove(name, toIndex);
		return true;
	};

	/**
	 * The two reorder buttons of each Layer, so a move can hand the keyboard back to one of them.
	 *
	 * Plain objects rather than `$state`: nothing renders from these, they are only read in the
	 * microtask after a move, and making them reactive would make writing a `bind:this` a state change.
	 */
	const upButton: Record<string, HTMLButtonElement | undefined> = {};
	const downButton: Record<string, HTMLButtonElement | undefined> = {};
	const deleteButton: Record<string, HTMLButtonElement | undefined> = {};

	/**
	 * Delete a Layer, and leave the keyboard somewhere in the list.
	 *
	 * The same problem `moveByButton` solves, in its sharpest form: the focused button is *removed*, so
	 * focus falls to `document.body` and a keyboard user has to Tab back in from the top of the document,
	 * past MapLibre's own controls, to do anything else — including reaching the undo they may want.
	 * CONTRIBUTING makes focus management a criterion of every change that adds UI, and a delete is where
	 * it is most obviously owed.
	 *
	 * The row that takes this one's place, or the last row when the bottom Layer went — the same place a
	 * user's eye is. Focus is only *taken* here because the element that had it no longer exists.
	 */
	const deleteByButton = async (id: string, index: number): Promise<void> => {
		ondelete(id);
		await tick();
		if (document.activeElement !== document.body) return;
		const remaining = layers.filter((layer) => layer.id !== id);
		const next = remaining[Math.min(index, remaining.length - 1)];
		if (next) deleteButton[next.id]?.focus();
	};

	/**
	 * Move a Layer by button, and leave the keyboard on the Layer that moved.
	 *
	 * **Without this, story 53 gets exactly one keypress.** The `{#each}` is keyed by Layer id, so
	 * Svelte *moves* the row's DOM node — and a focused element that is removed and reinserted is
	 * blurred to `document.body`, whether or not the move reached the end of the stack. So a keyboard
	 * user pressed "Move down" once and then had to Tab back in from the top of the document, past
	 * MapLibre's own controls, for every further move. ADR-0016 makes the keyboard path the contract
	 * and the drag the convenience, which is the reverse of that.
	 *
	 * The button that was pressed is preferred, and at the end of the stack it is `disabled` — "the top
	 * Layer cannot go higher" is a disabled button, which is information a screen reader gets for free
	 * from the markup — so the keyboard is handed the other half of the same control instead. That is
	 * also the useful place to be: the next press undoes the move.
	 *
	 * Focus is only *restored*, never taken: if something else has been focused in the meantime, this
	 * leaves it alone. The drop handler deliberately does not call this — a drag has no keyboard
	 * position to keep, and moving focus to a button under the pointer would be a surprise.
	 */
	const moveByButton = async (
		id: string,
		name: string,
		toIndex: number,
		direction: 'up' | 'down'
	): Promise<void> => {
		const pressed = direction === 'up' ? upButton[id] : downButton[id];
		if (!move(id, name, toIndex)) return;
		await tick();
		const active = document.activeElement;
		if (active !== null && active !== document.body && active !== pressed) return;
		const wanted = direction === 'up' ? upButton[id] : downButton[id];
		const other = direction === 'up' ? downButton[id] : upButton[id];
		(wanted && !wanted.disabled ? wanted : other)?.focus();
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
		<h2 id="layer-stack-heading" class="text-lg font-semibold">Layers in this Project</h2>
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
		<!--
			An `<ol>`, so the list's structure and each Layer's position in the stack reach assistive
			technology from the markup rather than from a label somebody has to remember to update. The
			position is drawn as well, because "which Layer is third" is information a sighted user needs
			too — as text, not as a list marker, since a marker does not render on a flex item.
		-->
		<ol class="mt-2 flex flex-col gap-2" aria-label="Layers, top first">
			{#each layers as layer, index (layer.id)}
				{@const outcome = outcomes[layer.id]}
				<!--
					**The whole row is the drop target; only the handle is the drag source.** It used to be
					`draggable="true"` on the `<li>` itself, and a pointer drag beginning anywhere inside a
					draggable element is claimed by the drag machinery rather than by the control under the
					cursor — so the opacity slider's thumb would not move and the name field could not be
					selected across, both by mouse, on the platform ADR-0014 says authoring targets. No test
					could see it: `fill()` sets `value` and dispatches `input` without ever pressing a button.
					`draggable="false"` on the descendants does not help; Chromium still starts the row's drag.

					The handle is `aria-hidden` because it is pointer-only and redundant: the move-up and
					move-down buttons beside it are the contract, and the drag is the convenience (ADR-0016).
				-->
				<li
					class="rounded border border-base-300 p-3"
					class:opacity-50={dragging === layer.id}
					class:border-primary={over === layer.id && dragging !== layer.id}
					data-testid="layer-row"
					data-layer-id={layer.id}
					data-layer-kind={layer.kind}
					data-layer-order={layer.order}
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
						<span
							class="cursor-grab leading-none opacity-60 select-none"
							draggable="true"
							aria-hidden="true"
							data-testid="layer-drag-handle"
							ondragstart={(event) => {
								dragging = layer.id;
								event.dataTransfer?.setData('text/plain', layer.id);
							}}
							ondragend={() => {
								dragging = '';
								over = '';
							}}
						>
							⠿
						</span>

						<span class="text-sm tabular-nums opacity-60" aria-hidden="true">
							{index + 1}/{layers.length}
						</span>

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
								bind:this={upButton[layer.id]}
								class="btn btn-sm"
								disabled={index === 0}
								data-testid="layer-move-up"
								onclick={() => void moveByButton(layer.id, layer.name, index - 1, 'up')}
							>
								Move up<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
							</button>
							<button
								bind:this={downButton[layer.id]}
								class="btn btn-sm"
								disabled={index === layers.length - 1}
								data-testid="layer-move-down"
								onclick={() => void moveByButton(layer.id, layer.name, index + 1, 'down')}
							>
								Move down<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
							</button>
							<!--
								The Layer's name is in the accessible name for the same reason it is on the two
								buttons beside it: "Delete" four times over is four identical controls to a screen
								reader, and this is the one of them that cannot be shrugged off.
							-->
							<button
								bind:this={deleteButton[layer.id]}
								class="btn btn-ghost btn-sm"
								data-testid="layer-delete"
								onclick={() => void deleteByButton(layer.id, index)}
							>
								Delete<span class="sr-only"> — {layer.name || 'Untitled Layer'}</span>
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
								<!--
									A `<span>`, not an `<output>`: `<output>` carries an implicit `role="status"`, and the
									save indicator already owns that role on this page — a second one makes
									`getByRole('status')` ambiguous, which is a hint that a screen-reader user would have
									to disambiguate too. The value is already announced by the range's own label.
								-->
								<span data-testid="layer-opacity-value">{Math.round(layer.opacity * 100)}%</span>
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
