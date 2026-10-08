<script lang="ts">
	import { LINE_STYLES, type LineStyle } from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';

	import LineStyleIcon from '$lib/icons/LineStyleIcon.svelte';

	let {
		value,
		name,
		testid,
		label = 'Line style',
		caption = undefined,
		kind = 'annotation',
		onchoose
	}: {
		value: LineStyle;
		name: string;
		testid: string;
		label?: string;
		caption?: string;
		kind?: 'annotation' | 'map';
		onchoose: (style: LineStyle) => void;
	} = $props();
</script>

<fieldset class="flex flex-col gap-1">
	<div class="flex items-center justify-between gap-2 text-sm">
		<legend class="sr-only">{label}</legend>
		<span aria-hidden="true">{caption ?? label}</span>
		<div class="join">
			{#each LINE_STYLES as style (style)}
				<label
					class="btn join-item gap-1 btn-sm {KIND_STYLE[kind].btnWhenChecked}"
					data-testid="{testid}-{style}"
				>
					<input
						type="radio"
						class="sr-only"
						{name}
						value={style}
						checked={value === style}
						onchange={() => onchoose(style)}
					/>
					<LineStyleIcon {style} class="size-4" aria-hidden="true" />
					{style}
				</label>
			{/each}
		</div>
	</div>
</fieldset>
