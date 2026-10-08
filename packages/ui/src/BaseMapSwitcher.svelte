<script lang="ts">
	import { baseMapOptions, type BaseMapCatalog } from '@ballastella/core';

	let {
		entryId,
		catalog,
		onSelect,
		class: width
	}: {
		entryId: string;
		catalog: BaseMapCatalog;
		onSelect: (id: string) => void;
		class?: string;
	} = $props();

	const options = $derived(baseMapOptions(catalog));
</script>

{#if options.length > 1}
	<label class="label" for="base-map-switcher">
		<span class="label-text">Base Map</span>
	</label>
	<select
		id="base-map-switcher"
		class={['select-bordered select w-full', width]}
		data-testid="base-map-switcher"
		value={entryId}
		onchange={(event) => onSelect(event.currentTarget.value)}
	>
		{#each options as option (option.id)}
			<option value={option.id} data-needs-network={option.needsNetwork}>{option.label}</option>
		{/each}
	</select>
{/if}
