<script lang="ts">
	import { BASE_MAP_BORDERS, type BaseMapBorders } from '@ballastella/core';

	let {
		borders,
		onSelect,
		legend = 'Borders'
	}: {
		borders: BaseMapBorders;
		onSelect: (borders: BaseMapBorders) => void;
		legend?: string;
	} = $props();

	const group = $props.id();

	const LABEL: Record<BaseMapBorders, string> = {
		none: 'No borders',
		national: 'National only',
		all: 'National and internal'
	};
</script>

<fieldset class="flex flex-col gap-1" data-testid="border-switcher">
	<legend class="label-text mb-1 font-medium">{legend}</legend>
	{#each BASE_MAP_BORDERS as choice (choice)}
		<label class="flex cursor-pointer items-center gap-2 py-1 text-sm">
			<input
				type="radio"
				class="radio shrink-0 radio-sm radio-primary"
				name={group}
				value={choice}
				checked={borders === choice}
				data-testid="border-option-{choice}"
				onchange={() => onSelect(choice)}
			/>
			<span>{LABEL[choice]}</span>
		</label>
	{/each}
</fieldset>
