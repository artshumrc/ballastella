<script lang="ts">
	// The distortion view: the colour overlay, which measure it shows, and the warped graticule
	// (ADR-0013).
	//
	// **None of this is persisted.** It is a working view, not a property of the work: persisted, it
	// would become layer display state under ADR-0002 and a Published Site could load colourised, with
	// a Reader having no way to interpret it. So the state lives in the page and nothing here reaches
	// `EditorSession`.
	//
	// The overlay is off by default because a colourised map is not what you want while placing
	// Control Points. The fold warning is **not** here: it is continuous, independent of this, and
	// belongs beside the Alignment's other feedback rather than beside a display toggle.

	import { DISTORTION_MEASURES, type DistortionView } from '@ballastella/core';

	let {
		view,
		enabled,
		onchange
	}: {
		view: DistortionView;
		/**
		 * Whether there is a warped Map Image to colourise at all.
		 *
		 * Below the minimum Control Point count there is no drawn map, so a checkbox that turned an
		 * overlay on would do nothing visible and read as broken. Disabled with the reason said, rather
		 * than hidden — a control that appears when enough points exist is a control the user never
		 * learns about.
		 */
		enabled: boolean;
		onchange: (next: DistortionView) => void;
	} = $props();

	/** Which measure the overlay shows when it is switched on, remembered across a switch off. */
	let lastMeasure = $state(DISTORTION_MEASURES[0]?.measure ?? 'log2sigma');

	const showing = $derived(view.measure !== null);

	const toggleOverlay = (on: boolean): void => {
		onchange({ ...view, measure: on ? lastMeasure : null });
	};

	const chooseMeasure = (name: string): void => {
		const match = DISTORTION_MEASURES.find((one) => one.measure === name);
		if (!match) return;
		lastMeasure = match.measure;
		onchange({ ...view, measure: match.measure });
	};

	const current = $derived(DISTORTION_MEASURES.find((one) => one.measure === view.measure));
</script>

<div
	class="flex flex-col gap-1"
	role="group"
	aria-label="How the warped Map Image is drawn"
	data-testid="distortion-controls"
	data-distortion-measure={view.measure ?? ''}
	data-distortion-grid={view.grid}
>
	<div class="flex flex-wrap items-center gap-4">
		<label class="label cursor-pointer gap-2 text-sm">
			<input
				type="checkbox"
				class="toggle toggle-sm"
				checked={showing}
				disabled={!enabled}
				data-testid="distortion-toggle"
				onchange={(event) => toggleOverlay(event.currentTarget.checked)}
			/>
			<!--
				"the Map Image", never a bare "map". CONTEXT.md lists `map` under the words to avoid
				for a Map Image, and this label sits beside a Base Map — so the unqualified word is
				ambiguous exactly where the user is looking at both. The component's other five strings
				were already qualified.
			-->
			Colour the Map Image by how much it is stretched
		</label>

		<label class="label cursor-pointer gap-2 text-sm">
			<input
				type="checkbox"
				class="toggle toggle-sm"
				checked={view.grid}
				disabled={!enabled}
				data-testid="grid-toggle"
				onchange={(event) => onchange({ ...view, grid: event.currentTarget.checked })}
			/>
			Draw a grid, bent by the Alignment
		</label>
	</div>

	{#if showing}
		<!--
			Native `<select>`, the same discipline the transformation picker follows (ADR-0016). Only
			present while something is being coloured: a measure picker beside an overlay that is off is
			a control with no effect.
		-->
		<div class="flex flex-wrap items-center gap-2">
			<label class="text-sm font-medium" for="distortion-measure">What the colours show</label>
			<select
				id="distortion-measure"
				class="select select-sm"
				aria-describedby="distortion-measure-question"
				data-testid="distortion-measure"
				value={view.measure}
				onchange={(event) => chooseMeasure(event.currentTarget.value)}
			>
				{#each DISTORTION_MEASURES as one (one.measure)}
					<option value={one.measure}>{one.question} ({one.label})</option>
				{/each}
			</select>
		</div>
		<p id="distortion-measure-question" class="max-w-prose text-sm opacity-70">
			{current?.question ?? ''}
		</p>
	{/if}

	{#if !enabled}
		<p class="max-w-prose text-sm opacity-70" data-testid="distortion-unavailable">
			There is nothing to colour yet — the Map Image has to be drawn over the Base Map first.
		</p>
	{/if}
</div>
