<script lang="ts">
	import {
		isLabel as annotationIsLabel,
		MARKER_SIZES,
		lineStyleOf,
		resolveStyle,
		type Annotation,
		type LineStyle
	} from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';

	import ColorPicker from './ColorPicker.svelte';
	import LineStylePicker from './LineStylePicker.svelte';
	import RangeField from './RangeField.svelte';

	let {
		annotation,
		onstyle,
		onlinestyle,
		oncommit,
		onapplytoall
	}: {
		annotation: Annotation;
		onstyle: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		onlinestyle: (line: LineStyle) => void;
		onapplytoall: () => void;
		oncommit: () => void;
	} = $props();

	const properties = $derived(annotation.properties);
	const resolved = $derived(resolveStyle(properties));
	const geometryKind = $derived(annotation.geometry?.type ?? null);
	const isLabel = $derived(annotationIsLabel(annotation));
	const isPoint = $derived(geometryKind === 'Point' && !isLabel);
	const hasArea = $derived(geometryKind === 'Polygon' || geometryKind === 'Circle');
	const hasLine = $derived(hasArea || geometryKind === 'LineString');
</script>

{#snippet heading(title: string)}
	<legend class="sr-only">{title}</legend>
	<p class="text-[0.65rem] font-semibold uppercase opacity-70" aria-hidden="true">{title}</p>
{/snippet}

{#snippet colour(key: 'marker-color' | 'fill' | 'stroke', label: string, caption = 'Colour')}
	<div data-own={key in properties}>
		<ColorPicker
			{label}
			{caption}
			value={resolved[key]}
			name="annotation-{key}"
			testid="annotation-{key}"
			onchoose={(chosen) => {
				onstyle({ [key]: chosen });
				oncommit();
			}}
		/>
	</div>
{/snippet}

{#snippet slider(
	key: 'fill-opacity' | 'stroke-width' | 'stroke-opacity',
	label: string,
	max = 1,
	step = 0.05
)}
	<RangeField
		{label}
		testid="annotation-{key}"
		value={resolved[key]}
		min={0}
		{max}
		{step}
		oninput={(value) => onstyle({ [key]: value }, { debounce: true })}
		{oncommit}
	/>
{/snippet}

<fieldset class="flex flex-col gap-3" data-testid="annotation-style-face">
	<legend class="sr-only">Style</legend>

	{#if isPoint || isLabel}
		<fieldset class="flex flex-col gap-2">
			{@render heading(isLabel ? 'Label' : 'Pin')}

			{@render colour('marker-color', isLabel ? 'Label text colour' : 'Pin colour')}

			{#if isLabel}
				{@render colour('fill', 'Label background colour', 'Background')}
				{@render slider('fill-opacity', 'Background opacity')}
			{/if}

			<fieldset class="flex items-center justify-between gap-2 text-sm">
				<legend class="sr-only">{isLabel ? 'Label size' : 'Pin size'}</legend>
				<span aria-hidden="true">Size</span>
				<div class="join">
					{#each MARKER_SIZES as size (size)}
						<label
							class="btn join-item btn-xs {KIND_STYLE.annotation.btnWhenChecked}"
							data-testid="annotation-marker-size-{size}"
						>
							<input
								type="radio"
								class="sr-only"
								name="annotation-marker-size"
								value={size}
								checked={(resolved['marker-size'] ?? 'medium') === size}
								onchange={() => onstyle({ 'marker-size': size })}
							/>
							{size}
						</label>
					{/each}
				</div>
			</fieldset>
		</fieldset>
	{/if}

	{#if hasArea}
		<fieldset class="flex flex-col gap-2">
			{@render heading('Fill')}
			{@render colour('fill', 'Fill colour')}
			{@render slider('fill-opacity', 'Opacity')}
		</fieldset>
	{/if}

	{#if hasLine}
		<fieldset class={['flex flex-col gap-2', hasArea && 'border-t border-base-300 pt-3']}>
			{@render heading('Line')}
			{@render colour('stroke', 'Line colour')}

			<LineStylePicker
				value={lineStyleOf(resolved['stroke-dasharray'])}
				caption="Style"
				name="annotation-line-style"
				testid="annotation-line-style"
				onchoose={onlinestyle}
			/>

			{@render slider('stroke-width', 'Width', 10, 0.5)}
			{@render slider('stroke-opacity', 'Opacity')}
		</fieldset>
	{/if}

	<div class="border-t border-base-300 pt-3">
		<button
			type="button"
			class="btn btn-block btn-sm"
			data-testid="annotation-apply-style-to-layer"
			onclick={() => onapplytoall()}
		>
			Apply to all Annotations in this Layer
		</button>
	</div>
</fieldset>
