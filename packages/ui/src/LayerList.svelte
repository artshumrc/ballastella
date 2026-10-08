<script lang="ts">
	import type { Layer, MapLayer } from '@ballastella/core';
	import { tick, type Snippet } from 'svelte';
	import { flip } from 'svelte/animate';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';

	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';
	import MapIcon from '@lucide/svelte/icons/map';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	import type { DrawnOutcome } from '@ballastella/core/render';

	import { ANNOTATION_DRAG_TYPE, HEADER_ICON_BUTTON_CLASS } from './constants.js';

	import { KIND_STYLE } from './layer-kind-style';

	let {
		layers,
		outcomes,
		openLayerId,
		onopen,
		ontypename,
		oncommit,
		onshow,
		ondragopacity,
		onmove,
		ondropannotation,
		ondelete,
		noLayersGuidance,
		foreignLayerNote,
		preparing,
		mapContents,
		problemAction,
		annotationContents
	}: {
		/** Index 0 draws over everything else. */
		layers: readonly Layer[];
		outcomes: Readonly<Record<string, DrawnOutcome>>;
		openLayerId: string | null;
		onopen: (id: string | null) => void;
		ontypename?: (id: string, name: string) => void;
		oncommit?: () => void;
		onshow?: (id: string, visible: boolean) => void;
		ondragopacity?: (id: string, opacity: number) => void;
		onmove?: (id: string, toIndex: number) => void;
		ondropannotation?: (annotationId: string, layerId: string) => void;
		ondelete?: (id: string) => void;
		noLayersGuidance?: Snippet;
		foreignLayerNote?: Snippet;
		preparing?: Snippet;
		mapContents?: Snippet<[MapLayer]>;
		/** The way to act on what a **closed** card is warning about, drawn beside {@link outcomes}' sentence for that Layer. */
		problemAction?: Snippet<[Layer]>;
		annotationContents?: Snippet<[]>;
	} = $props();

	/** `aria-live` rather than `role="status"`, because the save indicator already owns that role on this page. */
	let moved = $state('');

	/** The Layer being dragged, or `''`. */
	let dragging = $state('');
	let over = $state('');
	let renaming = $state('');
	let nameField = $state<HTMLInputElement | undefined>(undefined);

	const describeMove = (name: string, toIndex: number): string =>
		`${name || 'Untitled Layer'} moved to ${toIndex + 1} of ${layers.length}`;

	const move = (id: string, name: string, toIndex: number): boolean => {
		if (!onmove || toIndex < 0 || toIndex >= layers.length) return false;
		onmove(id, toIndex);
		moved = describeMove(name, toIndex);
		return true;
	};

	const upButton: Record<string, HTMLButtonElement | undefined> = {};
	const downButton: Record<string, HTMLButtonElement | undefined> = {};
	const disclosureButton: Record<string, HTMLButtonElement | undefined> = {};
	const card: Record<string, HTMLLIElement | undefined> = {};

	/** Whether what is being dragged is an Annotation rather than a Layer. */
	const isAnnotationDrag = (event: DragEvent): boolean =>
		Boolean(event.dataTransfer?.types.includes(ANNOTATION_DRAG_TYPE));

	/** Only an open Annotation Layer renders its contents, so the row being dragged can only have come from that card — which means this component can refuse a move to the Layer an Annotation is already in… */
	const takesAnnotation = (layer: Layer): boolean =>
		Boolean(ondropannotation) && layer.kind === 'annotation' && layer.id !== openLayerId;

	/** The snapshot is taken **during this event**, before the `opacity-50` that marks the card as being dragged reaches the DOM, so the ghost is the card at full strength and the faded original stays… */
	const dragTheWholeCard = (event: DragEvent, id: string): void => {
		const dragged = card[id];
		if (!event.dataTransfer || !dragged) return;
		const box = dragged.getBoundingClientRect();
		event.dataTransfer.setDragImage(dragged, event.clientX - box.left, event.clientY - box.top);
	};

	const deleteByButton = async (id: string, index: number): Promise<void> => {
		ondelete?.(id);
		await tick();
		if (document.activeElement !== document.body) return;
		const remaining = layers.filter((layer) => layer.id !== id);
		const next = remaining[Math.min(index, remaining.length - 1)];
		if (next) disclosureButton[next.id]?.focus();
	};

	/** Move a Layer by button, and leave the keyboard on the Layer that moved. */
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

	const renameByButton = async (id: string): Promise<void> => {
		renaming = id;
		await tick();
		nameField?.focus();
		nameField?.select();
	};

	const finishRename = (): void => {
		oncommit?.();
		renaming = '';
	};

	const canRename = $derived(Boolean(ontypename && oncommit));

	/** The slide is what carries "this one, from there to here" — the same information the `aria-live` region above carries in words, which is why both exist. */
	const moveAnimation = $derived({
		duration: prefersReducedMotion.current ? 0 : 220,
		easing: cubicOut
	});

	const kindLabel = (layer: Layer): string => {
		switch (layer.kind) {
			case 'map':
				return 'Map Image';
			case 'annotation':
				return 'Annotation Layer';
			case 'foreign':
				return `Not shown by this version (${layer.declaredKind || 'unknown kind'})`;
		}
	};

	const kindIcon = (layer: Layer) => {
		switch (layer.kind) {
			case 'map':
				return MapIcon;
			case 'annotation':
				return MapPin;
			case 'foreign':
				return CircleHelp;
		}
	};

	const headerTint = (layer: Layer): string =>
		layer.visible ? KIND_STYLE[layer.kind].tint : 'bg-base-content/5';

	const kindInk = (layer: Layer): string =>
		layer.visible ? KIND_STYLE[layer.kind].ink : 'text-base-content/70';

	/** daisyUI's `toggle-*` and `range-*` modifiers, which is the whole point of using them: they take their fill and their contrasting knob from the token pair the theme defines, so a retheme moves these… */
	const kindToggle = (layer: Layer): string => KIND_STYLE[layer.kind].toggle;
	const kindRange = (layer: Layer): string => KIND_STYLE[layer.kind].range;
</script>

<section aria-labelledby="layer-stack-heading">
	<div class="flex flex-wrap items-baseline justify-between gap-4">
		<h2 id="layer-stack-heading" class="w-full text-center text-lg font-semibold">
			Layers in this Project
		</h2>
	</div>

	<div
		aria-live="polite"
		aria-atomic="true"
		class="min-h-6 text-sm"
		data-testid="layer-move-status"
	>
		{moved}
	</div>

	{#if layers.length === 0 && !preparing}
		<p class="max-w-prose" data-testid="no-layers">
			{#if noLayersGuidance}
				{@render noLayersGuidance()}
			{:else}
				This Project has no Layers on it.
			{/if}
		</p>
	{:else}
		<!-- **The position is no longer drawn as "2/3".** It was `aria-hidden` because the `<ol>` already says it, and what it gave a sighted user — a number beside a number — the order of the cards gives them… -->
		<ol class="mt-2 flex flex-col gap-2" aria-label="Layers, top first">
			{#if preparing}
				<li
					class="rounded-box border border-dashed border-base-300 bg-base-100 p-3"
					data-testid="preparing-layer"
				>
					{@render preparing()}
				</li>
			{/if}
			{#each layers as layer, index (layer.id)}
				{@const outcome = outcomes[layer.id]}
				{@const open = openLayerId === layer.id}
				{@const Icon = kindIcon(layer)}
				{@const name = layer.name || 'Untitled Layer'}
				<!-- **What is dragged is nevertheless the card**, which is not the same question as what starts the drag: a browser's drag image is a picture of the source element, so grabbing the handle used to lift a… -->
				<li
					bind:this={card[layer.id]}
					class="group overflow-hidden rounded-box border border-base-content/10 bg-base-100"
					class:opacity-50={dragging === layer.id}
					class:border-primary={over === layer.id && dragging !== layer.id}
					data-testid="layer-row"
					data-layer-id={layer.id}
					data-layer-kind={layer.kind}
					data-layer-order={layer.order}
					data-image-id={layer.kind === 'map' ? layer.imageId : undefined}
					data-drop-target={over === layer.id && dragging !== layer.id ? 'true' : 'false'}
					animate:flip={moveAnimation}
					ondragover={(onmove || ondropannotation) &&
						((event) => {
							if (isAnnotationDrag(event) ? !takesAnnotation(layer) : !onmove) return;
							event.preventDefault();
							over = layer.id;
						})}
					ondragleave={(onmove || ondropannotation) &&
						((event) => {
							const entered = event.relatedTarget;
							if (entered instanceof Node && event.currentTarget.contains(entered)) return;
							if (over === layer.id) over = '';
						})}
					ondrop={(onmove || ondropannotation) &&
						((event) => {
							event.preventDefault();
							// **The Annotation format first**, because an Annotation being dragged carries its id in `text/plain` as well — that is what a drag deposits in any text field it is dropped on — and reading that first would hand an…
							const annotationId = event.dataTransfer?.getData(ANNOTATION_DRAG_TYPE);
							const id = annotationId || event.dataTransfer?.getData('text/plain') || dragging;
							over = '';
							dragging = '';
							if (!id) return;
							if (annotationId) {
								if (takesAnnotation(layer)) ondropannotation?.(annotationId, layer.id);
								return;
							}
							if (!onmove || id === layer.id) return;
							const from = layers.findIndex((other) => other.id === id);
							move(id, layers[from]?.name ?? '', index);
						})}
				>
					<div
						class="flex items-center gap-1.5 py-2 pr-2 pl-1 {headerTint(layer)} {kindInk(layer)}"
						data-testid="layer-header"
					>
						{#if onmove}
							<span
								class="cursor-grab leading-none select-none"
								draggable="true"
								aria-hidden="true"
								data-testid="layer-drag-handle"
								ondragstart={(event) => {
									dragging = layer.id;
									event.dataTransfer?.setData('text/plain', layer.id);
									dragTheWholeCard(event, layer.id);
								}}
								ondragend={() => {
									dragging = '';
									over = '';
								}}
							>
								<GripVertical size={14} />
							</span>
						{/if}

						<span class={kindInk(layer)} aria-hidden="true">
							<Icon size={18} strokeWidth={2} />
						</span>

						<div class="min-w-0 grow">
							<div class="flex items-center gap-1.5 text-[0.65rem] leading-tight font-semibold">
								<span class="truncate uppercase {kindInk(layer)}" data-testid="layer-kind"
									>{kindLabel(layer)}</span
								>
								{#if !layer.visible}
									<!-- The drained header says "not on the map" to a sighted user and nothing at all to a screen reader, which is what the toggle's own state is for — and nothing at all to somebody scanning a stack for the… -->
									<span class="text-base-content/70 uppercase" data-testid="layer-hidden"
										>Hidden</span
									>
								{/if}
							</div>

							{#if renaming === layer.id && open}
								<input
									bind:this={nameField}
									class="input mt-0.5 w-full bg-base-100 text-base-content input-xs"
									value={layer.name}
									aria-label="Name of Layer {index + 1} of {layers.length}"
									data-testid="layer-name"
									oninput={(event) => ontypename?.(layer.id, event.currentTarget.value)}
									onkeydown={(event) => {
										if (event.key === 'Enter' || event.key === 'Escape') event.currentTarget.blur();
									}}
									onchange={() => oncommit?.()}
									onblur={() => finishRename()}
								/>
							{:else}
								<div
									class="truncate text-sm leading-tight font-semibold"
									class:opacity-60={!layer.visible}
									data-testid="layer-name-text"
								>
									{name}
								</div>
							{/if}
						</div>

						{#if canRename && open && renaming !== layer.id}
							<!-- Its accessible name carries the Layer's own name for the same reason every other control here does: four buttons called "Rename" are four identical controls to a screen reader. -->
							<button
								type="button"
								class="shrink-0 {HEADER_ICON_BUTTON_CLASS}"
								data-testid="layer-rename"
								onclick={() => void renameByButton(layer.id)}
							>
								<Pencil size={14} aria-hidden="true" />
								<span class="sr-only">Rename — {name}</span>
							</button>
						{/if}

						{#if onshow}
							<input
								type="checkbox"
								class="toggle shrink-0 toggle-sm {kindToggle(layer)}"
								checked={layer.visible}
								aria-label="Show {name} on the map"
								data-testid="layer-visible"
								onchange={(event) => onshow(layer.id, event.currentTarget.checked)}
							/>
						{/if}

						<!-- The disclosure, and it is a plain `<button>` with `aria-expanded` — ADR-0016's shape for exactly this, so a screen reader is told the card can be opened and whether it is, with nothing reimplemented. -->
						<button
							bind:this={disclosureButton[layer.id]}
							type="button"
							class="flex size-8 shrink-0 cursor-pointer items-center justify-center focus-visible:outline-2 focus-visible:outline-current {kindInk(
								layer
							)}"
							aria-expanded={open}
							aria-controls={open ? `layer-contents-${layer.id}` : undefined}
							data-testid="layer-disclosure"
							onclick={() => onopen(open ? null : layer.id)}
						>
							{#if open}
								<ChevronUp size={18} aria-hidden="true" />
							{:else}
								<ChevronDown size={18} aria-hidden="true" />
							{/if}
							<span class="sr-only">{open ? 'Close' : 'Open'} — {name}</span>
						</button>
					</div>

					{#if outcome?.status === 'refused'}
						<!-- **The sentence is `base-content` on a `warning` wash, not `warning`-coloured text.** The warning token is an 82%-lightness amber in the stock light theme, so the amber sentence this replaces was… -->
						<div
							class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warning/40 bg-warning/15 px-2.5 py-1.5 text-xs"
						>
							<TriangleAlert
								size={14}
								class="shrink-0 text-[var(--layer-problem-ink)]"
								aria-hidden="true"
							/>
							<span data-testid="layer-problem">{outcome.reason}</span>
							{@render problemAction?.(layer)}
						</div>
					{/if}

					{#if open}
						<div
							id="layer-contents-{layer.id}"
							class="flex flex-col gap-3 border-t border-base-300 px-3 py-3"
							data-testid="layer-contents"
							data-layer-id={layer.id}
						>
							{#if layer.kind === 'map'}
								{#if ondragopacity}
									<label class="flex items-center gap-2 text-xs">
										<span class="shrink-0">Opacity</span>
										<input
											type="range"
											class="range grow range-xs {kindRange(layer)}"
											min="0"
											max="1"
											step="0.05"
											value={layer.opacity}
											aria-label="Opacity of {name}"
											data-testid="layer-opacity"
											oninput={(event) =>
												ondragopacity(layer.id, Number(event.currentTarget.value))}
											onchange={() => oncommit?.()}
										/>
										<span
											class="w-9 shrink-0 text-right tabular-nums"
											data-testid="layer-opacity-value">{Math.round(layer.opacity * 100)}%</span
										>
									</label>
								{/if}

								{@render mapContents?.(layer)}
							{:else if layer.kind === 'annotation'}
								{@render annotationContents?.()}
							{:else}
								<p class="max-w-prose text-sm" data-testid="layer-foreign-note">
									This is a Layer of a kind this version of Ballastella does not understand, so
									there is nothing inside it to show and nothing of it is drawn on the map.
									{#if foreignLayerNote}{@render foreignLayerNote()}{/if}
								</p>
							{/if}

							{#if onmove || ondelete}
								<div class="flex items-center gap-1 border-t border-base-300 pt-3">
									{#if onmove}
										<button
											bind:this={upButton[layer.id]}
											class="btn gap-1 btn-xs"
											disabled={index === 0}
											data-testid="layer-move-up"
											onclick={() => void moveByButton(layer.id, layer.name, index - 1, 'up')}
										>
											<ArrowUp size={13} aria-hidden="true" />
											Move up<span class="sr-only"> — {name}</span>
										</button>
										<button
											bind:this={downButton[layer.id]}
											class="btn gap-1 btn-xs"
											disabled={index === layers.length - 1}
											data-testid="layer-move-down"
											onclick={() => void moveByButton(layer.id, layer.name, index + 1, 'down')}
										>
											<ArrowDown size={13} aria-hidden="true" />
											Move down<span class="sr-only"> — {name}</span>
										</button>
									{/if}
									<span class="grow"></span>
									{#if ondelete}
										<!-- The word carries the meaning at full contrast, so the glyph repeats it rather than being the only way to know what this button does — which is the one arrangement in which 2.9:1 is honestly… -->
										<button
											class="btn gap-1 btn-outline btn-xs"
											data-testid="layer-delete"
											onclick={() => void deleteByButton(layer.id, index)}
										>
											<Trash2 size={13} class="text-error" aria-hidden="true" />
											Delete Layer<span class="sr-only"> — {name}</span>
										</button>
									{/if}
								</div>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>
