<script lang="ts">
	import { annotationOrdinal, type Annotation } from '@ballastella/core';
	import GripVertical from '@lucide/svelte/icons/grip-vertical';

	import { ANNOTATION_DRAG_TYPE, ANNOTATION_INSPECTOR_ID } from './constants.js';
	import { annotationName, shapeWord } from './annotation-name.js';
	import { KIND_STYLE } from './layer-kind-style.js';
	import { iconForAnnotation } from './shape-icons.js';

	let {
		annotation,
		index,
		open,
		onopen,
		onmove,
		dragging = $bindable(''),
		over = $bindable('')
	}: {
		annotation: Annotation;
		/** Read for the ordinal this row draws, for the untitled fallback's number, and for the position a drop onto this row asks for. */
		index: number;
		open: boolean;
		onopen: (id: string | null) => void;
		onmove?: (id: string, toIndex: number) => void;
		/** The Annotation being dragged and the row a drop would land on, both `''` for neither. */
		dragging?: string;
		over?: string;
	} = $props();

	const name = $derived(annotationName(annotation, index));
	const Icon = $derived(iconForAnnotation(annotation));
</script>

<!-- Colour is not the only channel: the name goes semibold, which survives a monochrome screen, and `aria-expanded` is what carries the state to a screen reader. -->
<li
	class={[
		'group/annotation-row border-b border-base-200 last:border-b-0',
		open &&
			`${KIND_STYLE.annotation.tint} text-info-content shadow-[inset_2px_0_0_var(--color-info-content)]`,
		dragging === annotation.id && 'opacity-50',
		over === annotation.id &&
			dragging !== annotation.id &&
			'outline-2 -outline-offset-2 outline-[var(--color-info-content)]'
	]}
	data-testid="annotation-row-item"
	data-drop-target={over === annotation.id && dragging !== annotation.id ? 'true' : 'false'}
	ondragover={onmove &&
		((event) => {
			// A Layer being dragged across the stack passes over these rows on its way to a card, and a row that highlighted for it would be promising a drop it has no way to perform.
			if (!event.dataTransfer?.types.includes(ANNOTATION_DRAG_TYPE)) return;
			event.preventDefault();
			over = annotation.id;
		})}
	ondragleave={onmove &&
		((event) => {
			// **Only when the pointer has really left this row.** `dragleave` fires on every descendant and bubbles, so crossing from the row's padding onto the name, the ordinal or the shape word inside it delivers a leave *for the…
			const entered = event.relatedTarget;
			if (entered instanceof Node && event.currentTarget.contains(entered)) return;
			if (over === annotation.id) over = '';
		})}
	ondrop={onmove &&
		((event) => {
			const id = event.dataTransfer?.getData(ANNOTATION_DRAG_TYPE);
			event.preventDefault();
			over = '';
			dragging = '';
			if (!id || id === annotation.id) return;
			onmove(id, index);
		})}
>
	<div class="flex items-center gap-1 rounded-none">
		{#if onmove}
			<!-- `aria-hidden` because it is pointer-only and redundant: the Inspector's Move buttons are the contract and the drag is the convenience (ADR-0016). -->
			<span
				class="shrink-0 cursor-grab leading-none opacity-30 transition-opacity select-none group-focus-within/annotation-row:opacity-70 group-hover/annotation-row:opacity-70"
				draggable="true"
				aria-hidden="true"
				data-testid="annotation-drag-handle"
				ondragstart={(event) => {
					dragging = annotation.id;
					event.dataTransfer?.setData(ANNOTATION_DRAG_TYPE, annotation.id);
					event.dataTransfer?.setData('text/plain', annotation.id);
				}}
				ondragend={() => {
					dragging = '';
					over = '';
				}}
			>
				<GripVertical size={14} />
			</span>
		{/if}

		<!-- **That button's expanded state is the selection.** There is deliberately no `aria-pressed` beside it: a row that was pressed but not open, or open but not pressed, would be two answers to "which… -->
		<button
			type="button"
			class={['flex grow items-center gap-2 bg-transparent p-0 text-left', open && 'font-semibold']}
			aria-expanded={open}
			aria-controls={open ? ANNOTATION_INSPECTOR_ID : undefined}
			data-testid="annotation-row"
			data-annotation-id={annotation.id}
			onclick={() => onopen(open ? null : annotation.id)}
		>
			<!-- **The number, so that "look at 3" identifies one Annotation across a desk.** It is the same number the mark on the map draws, from `annotationOrdinal` in `core` — one rule, so the canvas and the… -->
			<span
				class={['shrink-0 text-xs font-semibold tabular-nums', KIND_STYLE.annotation.ink]}
				data-testid="annotation-row-ordinal"
			>
				{annotationOrdinal(index)}
			</span>

			<!-- The same glyph the tool that drew it carries, and **beside the word rather than instead of it** — the word is what a screen reader reads and what a glyph alone would have taken away. -->
			<Icon class="size-4 shrink-0 opacity-60" aria-hidden="true" />
			<span class="shrink-0 text-xs opacity-60">{shapeWord(annotation)}</span>
			<span class="truncate" data-testid="annotation-row-name">
				{name}
			</span>
		</button>
	</div>
</li>
