<script lang="ts">
	import { DISTORTION_MEASURES, type DistortionView } from '@ballastella/core';

	let {
		view,
		enabled,
		onchange
	}: {
		view: DistortionView;
		enabled: boolean;
		onchange: (next: DistortionView) => void;
	} = $props();

	let lastMeasure = $state(DISTORTION_MEASURES[0]?.measure ?? 'log2sigma');
	const current = $derived(DISTORTION_MEASURES.find((one) => one.measure === view.measure));

	const chooseMeasure = (name: string): void => {
		const match = DISTORTION_MEASURES.find((one) => one.measure === name);
		if (!match) return;
		lastMeasure = match.measure;
		onchange({ ...view, measure: match.measure });
	};
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
				checked={view.measure !== null}
				disabled={!enabled}
				data-testid="distortion-toggle"
				onchange={(event) =>
					onchange({ ...view, measure: event.currentTarget.checked ? lastMeasure : null })}
			/>
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

	{#if view.measure !== null}
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
