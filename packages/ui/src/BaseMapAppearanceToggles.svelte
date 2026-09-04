<script lang="ts">
	// How the Base Map is drawn — the four switches, rendered by both apps.
	//
	// **Four toggles rather than a `<select>`, because the four choices are independent.** They
	// were once a list of named variants, which meant every combination somebody wanted had to have
	// been anticipated as a row: contour lines came only without roads, and the high-contrast palette
	// came only without relief. Nothing in the tiles requires that — each switch is a filter or a
	// repaint over the same archive (`appearance.ts`), or, for `imagery`, a ground beneath it — so
	// the control says so, and all sixteen combinations are reachable.
	//
	// This does **not** stand in for `BaseMapSwitcher`, which chooses between sets of tiles. Both sit
	// inside `BaseMapOptions`, which is where either is found.

	import { drawnAppearance, type BaseMapAppearance } from '@ballastella/core';

	let {
		appearance,
		onChange,
		legend = 'Detail',
		legendSrOnly = false
	}: {
		appearance: BaseMapAppearance;
		/** The whole appearance, not a patch: the caller records one value and has it in hand. */
		onChange: (appearance: BaseMapAppearance) => void;
		/** What the group is called. The caller's word, because a surrounding heading may say it. */
		legend?: string;
		/** Keep the legend for screen readers but take it off the screen, as the switchers do. */
		legendSrOnly?: boolean;
	} = $props();

	/**
	 * What each switch says and what it means, in the order a scholar reaches for them: the roads
	 * first, because that is the difference between a modern map and a physical one; the satellite
	 * second, because it is the other answer to the same question — what the ground is; the relief
	 * third; the palette last, because it is about reading rather than about content.
	 *
	 * The `hint` is the accessible name's second half rather than a tooltip, for ADR-0016's reason —
	 * a toggle whose consequence is only in a `title` has no consequence for anyone not using a
	 * mouse.
	 */
	const SWITCHES: readonly {
		key: keyof BaseMapAppearance;
		label: string;
		hint: string;
	}[] = [
		{ key: 'streets', label: 'Streets', hint: 'roads, buildings and places' },
		{
			key: 'imagery',
			label: 'Satellite',
			hint: 'photographs of the ground instead of a drawn map'
		},
		{ key: 'relief', label: 'Topography', hint: 'shaded relief and contour lines' },
		{ key: 'highContrast', label: 'High contrast', hint: 'black and white, for maximum legibility' }
	];

	/**
	 * The switch a satellite map takes away, and the reason it is disabled rather than merely
	 * ineffective: the high-contrast palette repaints land, water and buildings, and a photograph is
	 * none of them. A control that stays live and does nothing is worse for the Reader who most needs
	 * it than one that is plainly unavailable — so the map's own exclusion (`drawnAppearance`) is
	 * shown here rather than applied silently underneath.
	 */
	const unavailable = $derived(
		(key: keyof BaseMapAppearance): boolean => key === 'highContrast' && appearance.imagery
	);
</script>

<!--
	A `<fieldset>` because these are one question with four answers, and a screen reader announcing
	"Streets, checkbox" with no idea what it is a property of has been told nothing. ADR-0016's
	native controls throughout: daisyUI's `toggle` is a class on a checkbox.

	**Stacked, one switch per line**, which is the shape a panel wants: four toggles abreast make a
	row too wide for the pane they float over, and a row that wraps at some widths and not others puts
	the same control somewhere new on every screen.
-->
<fieldset class="flex flex-col gap-1" data-testid="base-map-appearance">
	<legend class={legendSrOnly ? 'sr-only' : 'label-text mb-1 font-medium'}>{legend}</legend>
	{#each SWITCHES as { key, label, hint } (key)}
		<label
			class="flex items-center gap-2 py-1 text-sm {unavailable(key)
				? 'cursor-not-allowed opacity-50'
				: 'cursor-pointer'}"
		>
			<input
				type="checkbox"
				class="toggle shrink-0 toggle-primary toggle-sm"
				checked={appearance[key]}
				disabled={unavailable(key)}
				data-testid="base-map-{key}"
				aria-label="{label} — {hint}"
				onchange={(event) =>
					onChange(drawnAppearance({ ...appearance, [key]: event.currentTarget.checked }))}
			/>
			<span aria-hidden="true">{label}</span>
		</label>
	{/each}
</fieldset>
