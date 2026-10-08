<script lang="ts">
	import { drawnAppearance, type BaseMapAppearance } from '@ballastella/core';

	let {
		appearance,
		onChange,
		legend = 'Detail'
	}: {
		appearance: BaseMapAppearance;
		onChange: (appearance: BaseMapAppearance) => void;
		legend?: string;
	} = $props();

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

	/** The switch a satellite map takes away, and the reason it is disabled rather than merely ineffective: the high-contrast palette repaints land, water and buildings, and a photograph is none of them. */
	const unavailable = $derived(
		(key: keyof BaseMapAppearance): boolean => key === 'highContrast' && appearance.imagery
	);
</script>

<!-- A `<fieldset>` because these are one question with four answers, and a screen reader announcing "Streets, checkbox" with no idea what it is a property of has been told nothing. -->
<fieldset class="flex flex-col gap-1" data-testid="base-map-appearance">
	<legend class="label-text mb-1 font-medium">{legend}</legend>
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
