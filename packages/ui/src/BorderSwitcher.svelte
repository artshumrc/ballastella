<script lang="ts">
	// Choosing which administrative boundaries the Base Map draws — the one control, rendered by
	// whichever app needs it.
	//
	// It sits beside `BaseMapSwitcher` and is deliberately *not* part of it: the boundary set is
	// orthogonal to the Base Map, since every catalog entry reads the same `boundaries` source-layer,
	// and folding it in would make the catalog three times as long and say the same thing three times.
	// It is the same control in the same shape for the same reason ADR-0016 gives the Base Map a
	// native `<select>` — few options, nothing custom needed, and the OS picker on a phone — and the
	// two stand side by side, so a difference in shape would read as a difference in kind.
	//
	// The options are `BASE_MAP_BORDERS` rather than markup per value, so a fourth level — counties,
	// districts — is a change to core's list and nothing here.

	import { BASE_MAP_BORDERS, type BaseMapBorders } from '@ballastella/core';

	let {
		borders,
		onSelect,
		labelSrOnly = false,
		fullWidth = true,
		class: width
	}: {
		borders: BaseMapBorders;
		onSelect: (borders: BaseMapBorders) => void;
		/** Keep the label for screen readers but take it off the screen, as `BaseMapSwitcher` does. */
		labelSrOnly?: boolean;
		/** Whether the select fills its caller's available width. */
		fullWidth?: boolean;
		/** How wide the select is, in the caller's own terms. The row it sits in owns its scale. */
		class?: string;
	} = $props();

	/** What each choice reads as. Whole phrases: a `<select>` has the room a button group does not. */
	const LABEL: Record<BaseMapBorders, string> = {
		none: 'No borders',
		national: 'National only',
		all: 'National and internal'
	};
</script>

<label class={labelSrOnly ? 'sr-only' : 'label'} for="border-switcher">
	<span class="label-text">Borders</span>
</label>
<select
	id="border-switcher"
	class={['select-bordered select', fullWidth ? 'w-full' : 'w-fit', width]}
	data-testid="border-switcher"
	value={borders}
	onchange={(event) => onSelect(event.currentTarget.value as BaseMapBorders)}
>
	{#each BASE_MAP_BORDERS as choice (choice)}
		<option value={choice}>{LABEL[choice]}</option>
	{/each}
</select>
