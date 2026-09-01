<script lang="ts">
	// Choosing which administrative boundaries the Base Map draws — the one control, rendered by
	// whichever app needs it.
	//
	// It sits beside the appearance switches inside `BaseMapOptions` and is deliberately *not* part of
	// them: the boundary set is what a Project **asserts** rather than how it looks, so a Reader may
	// change the second and never the first. Every catalog entry reads the same `boundaries`
	// source-layer, so it is orthogonal to which Base Map was chosen, and folding it into the catalog
	// would make that three times as long and say the same thing three times.
	//
	// **A radio group rather than the `<select>` it used to be.** ADR-0016 mandates a native control
	// and both are one; what decides between them is where it now lives. Inside a popover a `<select>`
	// opens the OS picker *over* the panel that opened it, which on a phone is two overlapping layers
	// for one choice — and three mutually exclusive options are what a radio group is for. Stacked,
	// because the labels are whole phrases and a row of three would wrap.
	//
	// The options are `BASE_MAP_BORDERS` rather than markup per value, so a fourth level — counties,
	// districts — is a change to core's list and nothing here.

	import { BASE_MAP_BORDERS, type BaseMapBorders } from '@ballastella/core';

	let {
		borders,
		onSelect,
		legend = 'Borders',
		legendSrOnly = false
	}: {
		borders: BaseMapBorders;
		onSelect: (borders: BaseMapBorders) => void;
		/** What the group is called. The caller's word, as it is for the appearance switches. */
		legend?: string;
		/** Keep the legend for screen readers but take it off the screen. */
		legendSrOnly?: boolean;
	} = $props();

	/**
	 * The `name` every radio in this group shares, and what makes them one choice rather than three.
	 *
	 * `$props.id()` rather than a literal, for the reason `MenuPopover` gives about `popovertarget`:
	 * it is stable across hydration and unique if two of these are ever on one screen, and a hardcoded
	 * name is a collision waiting for the second instance — which here would mean two controls
	 * silently unsetting each other.
	 */
	const group = $props.id();

	/** What each choice reads as. Whole phrases: a stacked group has the room a button row does not. */
	const LABEL: Record<BaseMapBorders, string> = {
		none: 'No borders',
		national: 'National only',
		all: 'National and internal'
	};
</script>

<fieldset class="flex flex-col gap-1" data-testid="border-switcher">
	<legend class={legendSrOnly ? 'sr-only' : 'label-text mb-1 font-medium'}>{legend}</legend>
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
