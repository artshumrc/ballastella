<script lang="ts">
	// The Reader's Base Map choice (SPEC stories 70, 72, and 98).
	//
	// Driven from **this Published Site's own catalog** rather than from this build's, so a site keeps
	// offering what it was published with when the authoring deployment later changes its catalog
	// (ADR-0020). That is the whole reason `baseMapOptions` takes one.
	//
	// The switcher IS the catalog: no per-entry markup, no icon table, no special case. Adding or
	// removing an entry changes the catalog and nothing here.

	import { baseMapOptions, type BaseMapCatalog } from '@ballastella/core';

	let {
		entryId,
		catalog,
		onSelect
	}: { entryId: string; catalog: BaseMapCatalog; onSelect: (id: string) => void } = $props();

	const options = $derived(baseMapOptions(catalog));
</script>

<!--
	ADR-0016 mandates a native `<select>` for this surface: few options, nothing custom needed, and the
	platform's own keyboard handling — which on a phone is the OS picker, and this is the one surface in
	the epic with a real mobile requirement.

	The needs-network marking is in each option's **visible text** (`baseMapOptions` composes it), not a
	tooltip and not colour: daisyUI renders tooltips via CSS `::before` where no screen reader announces
	them, and a Reader offline needs to know *before* choosing — otherwise they pick satellite imagery and
	get a blank map with no explanation (ADR-0020).

	`w-full sm:w-auto` because at 375 px a fixed-width control is what pushes a page into horizontal
	scroll.
-->
<div class="flex flex-col">
	<label class="label" for="base-map-switcher">
		<span class="label-text">Base Map</span>
	</label>
	<select
		id="base-map-switcher"
		class="select-bordered select w-full sm:w-56"
		data-testid="base-map-switcher"
		value={entryId}
		onchange={(event) => onSelect(event.currentTarget.value)}
	>
		{#each options as option (option.id)}
			<option value={option.id} data-needs-network={option.needsNetwork}>{option.text}</option>
		{/each}
	</select>
</div>
