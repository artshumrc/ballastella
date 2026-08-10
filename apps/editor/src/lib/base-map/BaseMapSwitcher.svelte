<script lang="ts">
	import { baseMapOptions } from '@ballastella/core';

	let {
		entryId,
		onSelect,
		labelSrOnly = false
	}: {
		entryId: string;
		onSelect: (id: string) => void;
		/**
		 * Keep the label for screen readers but take it off the screen.
		 *
		 * For a caller whose own heading already says "Base Map" beside the select — the alignment
		 * screen, where the two sat a few pixels apart and the second one was the word repeated rather
		 * than anything added. The label itself never goes: the `<select>` needs an accessible name, and
		 * ADR-0016 keeps that out of a `title`.
		 */
		labelSrOnly?: boolean;
	} = $props();

	// The switcher IS the catalog. There is no per-entry markup, no icon table, and no special
	// case, so adding or removing an entry changes this list and nothing else (ADR-0020).
	const options = baseMapOptions();
</script>

<!--
	ADR-0016 mandates a native `<select>` for this surface: few options, nothing custom needed, and
	the platform's own keyboard handling. The needs-network marking is in the option's visible text
	rather than a tooltip or a colour, because daisyUI renders tooltips via CSS `::before` where no
	screen reader announces them, and because a Reader offline needs to know *before* choosing.
-->
<label class={labelSrOnly ? 'sr-only' : 'label'} for="base-map-switcher">
	<span class="label-text">Base Map</span>
</label>
<select
	id="base-map-switcher"
	class="select-bordered select w-full max-w-xs"
	value={entryId}
	onchange={(event) => onSelect(event.currentTarget.value)}
>
	{#each options as option (option.id)}
		<option value={option.id}>{option.text}</option>
	{/each}
</select>
