<script lang="ts">
	import { annotationOrdinal, type Annotation } from '@ballastella/core';
	import X from '@lucide/svelte/icons/x';
	import type { Snippet } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { prefersReducedMotion } from 'svelte/motion';
	import { fly } from 'svelte/transition';

	import { ANNOTATION_INSPECTOR_ID, HEADER_ICON_BUTTON_CLASS } from './constants.js';
	import { annotationName, shapeWord } from './annotation-name.js';
	import { KIND_STYLE } from './layer-kind-style.js';
	import { iconForAnnotation } from './shape-icons.js';

	let {
		annotation,
		index,
		onclose,
		text,
		style
	}: {
		annotation: Annotation;
		/** Read for the ordinal the header draws and for the untitled fallback's number, and for nothing else: the header is the one place this panel names its Annotation, so a face has no use for a number it… */
		index: number;
		onclose: () => void;
		text: Snippet<[Annotation]>;
		style?: Snippet<[Annotation]> | undefined;
	} = $props();

	const ID = ANNOTATION_INSPECTOR_ID;
	const FACE_ID = `${ID}-face`;

	/** "Text" and "Style" are the labels' own text, so a label is something the face's `aria-labelledby` can name outright. */
	const TEXT_TAB_ID = `${ID}-tab-text`;
	const STYLE_TAB_ID = `${ID}-tab-style`;
	const annotationId = $derived(annotation.id);
	let face = $derived.by((): 'text' | 'style' => {
		void annotationId;
		return 'text';
	});

	const arrival = $derived({
		duration: prefersReducedMotion.current ? 0 : 220,
		y: 8,
		easing: cubicOut
	});

	const name = $derived(annotationName(annotation, index));
	const Icon = $derived(iconForAnnotation(annotation));
</script>

<section
	id={ID}
	class="flex w-full flex-col gap-3 overflow-hidden rounded-box border border-base-300 bg-base-100 shadow-lg"
	aria-label="Annotation Inspector: {name}"
	data-testid="annotation-inspector"
	data-reveal-ms={arrival.duration}
	transition:fly|global={arrival}
>
	<!-- The identity header: the ordinal, the glyph, the shape word and the name, all four from the rules the row draws from. -->
	<header
		class="flex shrink-0 items-start gap-2 border-b border-base-300 {KIND_STYLE.annotation
			.tint} {KIND_STYLE.annotation.ink} px-3 py-2"
		data-testid="annotation-inspector-header"
	>
		<span
			class={['shrink-0 text-xs font-semibold tabular-nums', KIND_STYLE.annotation.ink]}
			data-testid="annotation-inspector-ordinal"
		>
			{annotationOrdinal(index)}
		</span>

		<Icon class="size-4 shrink-0 opacity-60" aria-hidden="true" />
		<span class="shrink-0 text-xs opacity-60" data-testid="annotation-inspector-shape">
			{shapeWord(annotation)}
		</span>

		<h3 class="min-w-0 grow text-sm font-semibold" data-testid="annotation-inspector-name">
			{name}
		</h3>

		<button
			type="button"
			class="shrink-0 {HEADER_ICON_BUTTON_CLASS}"
			data-testid="annotation-inspector-close"
			onclick={() => onclose()}
		>
			<X size={14} aria-hidden="true" />
			<span class="sr-only">Dismiss the Annotation Inspector</span>
		</button>
	</header>

	{#if style}
		<!-- `role="tab"` overrides the checkbox mapping a radio would otherwise carry, so the chosen state is *said* as `aria-selected`. -->
		<div role="tablist" class="tabs tabs-box shrink-0 px-3" data-testid="annotation-inspector-tabs">
			<label id={TEXT_TAB_ID} class="tab" data-testid="annotation-inspector-tab-text">
				<input
					type="radio"
					role="tab"
					name="annotation-inspector-face"
					aria-selected={face === 'text'}
					aria-controls={FACE_ID}
					checked={face === 'text'}
					onchange={() => (face = 'text')}
				/>
				Text
			</label>
			<label id={STYLE_TAB_ID} class="tab" data-testid="annotation-inspector-tab-style">
				<input
					type="radio"
					role="tab"
					name="annotation-inspector-face"
					aria-selected={face === 'style'}
					aria-controls={FACE_ID}
					checked={face === 'style'}
					onchange={() => (face = 'style')}
				/>
				Style
			</label>
		</div>
	{/if}

	<!-- `aria-labelledby` names the showing tab's `<label>` — the element the words are in — so the panel is announced as "Text" or "Style" without anything having to look through a radio for its name. -->
	<div
		id={FACE_ID}
		class="overflow-y-auto px-3 pt-2 pb-3"
		role={style ? 'tabpanel' : undefined}
		aria-labelledby={style ? (face === 'style' ? STYLE_TAB_ID : TEXT_TAB_ID) : undefined}
		data-testid="annotation-inspector-face"
		data-face={style && face === 'style' ? 'style' : 'text'}
	>
		{#if style && face === 'style'}
			{@render style(annotation)}
		{:else}
			{@render text(annotation)}
		{/if}
	</div>
</section>
