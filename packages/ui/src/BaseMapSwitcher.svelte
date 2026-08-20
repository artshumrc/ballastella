<script lang="ts">
	// Choosing a Base Map — the one control, rendered by both apps.
	//
	// It is driven by **the catalog it is handed** rather than by this build's, which is the whole of
	// ADR-0020: a Published Site goes on offering what it was published with when the authoring
	// deployment later changes its own catalog, and the editor is simply the caller that passes
	// `BASE_MAP_CATALOG`.
	//
	// The switcher IS the catalog: no per-entry markup, no icon table, no special case. Adding or
	// removing an entry changes the catalog and nothing here (SPEC story 100).

	import { baseMapOptions, type BaseMapCatalog } from '@ballastella/core';

	let {
		entryId,
		catalog,
		onSelect,
		labelSrOnly = false,
		fullWidth = true,
		class: width
	}: {
		entryId: string;
		catalog: BaseMapCatalog;
		onSelect: (id: string) => void;
		/**
		 * Keep the label for screen readers but take it off the screen.
		 *
		 * For a caller whose own heading already says "Base Map" beside the select — the alignment
		 * route, where the two sat a few pixels apart and the second one was the word repeated rather
		 * than anything added. The label itself never goes: the `<select>` needs an accessible name,
		 * and ADR-0016 keeps that out of a `title`.
		 */
		labelSrOnly?: boolean;
		/** Whether the select fills its caller's available width. */
		fullWidth?: boolean;
		/**
		 * How wide the select is, in the caller's own terms.
		 *
		 * The two apps put this control in columns of different widths, and neither width is a fact
		 * about the switcher. What the component owns is what makes it a daisyUI select and fill its
		 * container; where that container ends is the page's business.
		 */
		class?: string;
	} = $props();

	const options = $derived(baseMapOptions(catalog));
</script>

<!--
	ADR-0016 mandates a native `<select>` for this surface: few options, nothing custom needed, and
	the platform's own keyboard handling — which on a phone is the OS picker, and this is the one
	control in the interface with a real mobile requirement.

	The published reader keeps the needs-network marking in visible option text, rather than in a tooltip
	or colour. The editor can suppress that repeated caveat because its Project settings contain the
	offline-management action and its map surface reports an unavailable Base Map.
-->
<label class={labelSrOnly ? 'sr-only' : 'label'} for="base-map-switcher">
	<span class="label-text">Base Map</span>
</label>
<select
	id="base-map-switcher"
	class={['select-bordered select', fullWidth ? 'w-full' : 'w-fit', width]}
	data-testid="base-map-switcher"
	value={entryId}
	onchange={(event) => onSelect(event.currentTarget.value)}
>
	{#each options as option (option.id)}
		<option value={option.id} data-needs-network={option.needsNetwork}>{option.label}</option>
	{/each}
</select>
