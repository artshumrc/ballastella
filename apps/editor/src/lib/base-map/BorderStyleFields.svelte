<script lang="ts">
	import {
		MAX_BORDER_WIDTH,
		MIN_BORDER_WIDTH,
		subnationalWidth,
		type BaseMapBorderStyle,
		type BaseMapBorders
	} from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';

	import ColorPicker from '$lib/annotations/ColorPicker.svelte';
	import LineStylePicker from '$lib/annotations/LineStylePicker.svelte';
	import RangeField from '$lib/annotations/RangeField.svelte';

	let {
		borders,
		style,
		automatic,
		illegibleIn = [],
		onchange,
		oncommit
	}: {
		borders: BaseMapBorders;
		style: BaseMapBorderStyle;
		automatic: BaseMapBorderStyle;
		illegibleIn?: readonly ('light' | 'dark')[];
		onchange: (patch: Partial<BaseMapBorderStyle>, options?: { debounce?: boolean }) => void;
		oncommit: () => void;
	} = $props();

	const custom = $derived(style.color !== null || style.lineStyle !== null || style.width !== null);

	const shown = $derived({
		color: style.color ?? automatic.color ?? '#808080',
		lineStyle: style.lineStyle ?? automatic.lineStyle ?? 'dashed',
		width: style.width ?? automatic.width ?? MIN_BORDER_WIDTH
	});

	const commit = (patch: Partial<BaseMapBorderStyle>): void => {
		onchange(patch);
		oncommit();
	};

	const THEME_NAME = { light: 'the light theme', dark: 'the dark theme' } as const;
</script>

{#snippet appearance(
	value: 'automatic' | 'custom',
	label: string,
	checked: boolean,
	patch: BaseMapBorderStyle
)}
	<label
		class="btn join-item btn-sm {KIND_STYLE.map.btnWhenChecked}"
		data-testid="border-appearance-{value}"
	>
		<input
			type="radio"
			class="sr-only"
			name="border-appearance"
			{value}
			{checked}
			onchange={() => commit(patch)}
		/>
		{label}
	</label>
{/snippet}

<fieldset class="flex w-full flex-col gap-3" data-testid="border-style-fields">
	<legend class="sr-only">Border appearance</legend>

	<div class="flex items-center justify-between gap-2 text-sm">
		<span aria-hidden="true">Appearance</span>
		<div class="join">
			{@render appearance('automatic', 'Automatic', !custom, {
				color: null,
				lineStyle: null,
				width: null
			})}
			{@render appearance('custom', 'Custom', custom, automatic)}
		</div>
	</div>

	{#if custom}
		<div class="flex flex-col gap-2 border-t border-base-300 pt-3">
			<ColorPicker
				label="Border colour"
				caption="Colour"
				value={shown.color}
				name="border-color"
				testid="border-color"
				onchoose={(color) => commit({ color })}
			/>

			{#if illegibleIn.length > 0}
				<p class="text-xs text-warning" data-testid="border-color-contrast-warning">
					This colour is hard to see against {illegibleIn
						.map((scheme) => THEME_NAME[scheme])
						.join(' and ')}. Readers choose their own theme on a published site.
				</p>
			{/if}

			<LineStylePicker
				label="Border line style"
				caption="Line"
				value={shown.lineStyle}
				name="border-line-style"
				testid="border-line-style"
				kind="map"
				onchoose={(lineStyle) => commit({ lineStyle })}
			/>

			<RangeField
				label="Width"
				testid="border-width"
				value={shown.width}
				min={MIN_BORDER_WIDTH}
				max={MAX_BORDER_WIDTH}
				step={0.5}
				kind="map"
				oninput={(width) => onchange({ width }, { debounce: true })}
				{oncommit}
			/>

			{#if borders === 'all'}
				<p class="text-xs opacity-60" data-testid="border-width-note">
					National borders are drawn at this width; the divisions inside them at {subnationalWidth(
						shown.width
					)}.
				</p>
			{/if}
		</div>
	{/if}

	{#if borders === 'none'}
		<p class="text-xs opacity-60" data-testid="border-style-not-drawn">
			This Project is not drawing borders, so none of this is on the map yet.
		</p>
	{/if}
</fieldset>
