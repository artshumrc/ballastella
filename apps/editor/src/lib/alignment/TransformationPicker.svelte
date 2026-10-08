<script lang="ts">
	import {
		TRANSFORMATION_CHOICES,
		transformationShortfall,
		type TransformationType
	} from '@ballastella/core';

	let {
		value,
		controlPointCount,
		onchoose
	}: {
		value: TransformationType;
		controlPointCount: number;
		onchoose: (type: TransformationType) => void;
	} = $props();

	let advancedRequested = $state(false);

	const offered = $derived(
		TRANSFORMATION_CHOICES.map((choice) => ({
			...choice,
			shortfall: transformationShortfall(choice.type, controlPointCount)
		}))
	);
	type Offered = (typeof offered)[number];

	const primary = $derived(offered.filter((one) => one.tier === 'primary'));
	const advanced = $derived(offered.filter((one) => one.tier === 'advanced'));
	const chosen = $derived(offered.find((one) => one.type === value));
	const currentTier = $derived(chosen?.tier);
	const advancedShown = $derived(advancedRequested || currentTier === 'advanced');

	const shortfalls = $derived(
		offered.filter((one) => one.shortfall !== '' && (advancedShown || one.tier === 'primary'))
	);

	const optionText = (one: Offered): string =>
		one.shortfall === ''
			? `${one.guidance} (${one.label})`
			: `${one.guidance} (${one.label}) — ${one.shortfall}`;

	const choose = (next: string): void => {
		const match = offered.find((one) => one.type === next);
		if (match && match.shortfall === '') onchoose(match.type);
	};
</script>

<div class="flex flex-col gap-1" data-testid="transformation-picker">
	<label class="text-sm font-medium" for="transformation-type">
		How this Map Image is stretched
	</label>

	<div class="flex flex-wrap items-center gap-2">
		<select
			id="transformation-type"
			class="select max-w-lg select-sm"
			aria-describedby="transformation-guidance"
			data-testid="transformation-select"
			{value}
			onchange={(event) => choose(event.currentTarget.value)}
		>
			{#snippet options(tier: readonly Offered[])}
				{#each tier as one (one.type)}
					<option value={one.type} disabled={one.shortfall !== ''}>{optionText(one)}</option>
				{/each}
			{/snippet}

			{@render options(primary)}

			{#if advancedShown}
				<optgroup label="Advanced">
					{@render options(advanced)}
				</optgroup>
			{/if}
		</select>

		{#if currentTier !== 'advanced'}
			<button
				type="button"
				class="btn btn-outline btn-sm"
				aria-expanded={advancedShown}
				aria-controls="transformation-type"
				data-testid="transformation-advanced"
				onclick={() => (advancedRequested = !advancedRequested)}
			>
				{advancedShown ? 'Hide advanced types' : 'Advanced types'}
			</button>
		{/if}
	</div>

	<p id="transformation-guidance" class="max-w-prose text-sm" data-testid="transformation-guidance">
		{chosen?.guidance ?? ''}
	</p>

	{#if shortfalls.length > 0}
		<div class="max-w-prose text-sm opacity-70" data-testid="transformation-shortfalls">
			{#each shortfalls as one (one.type)}
				<p data-transformation-type={one.type}>{one.shortfall}</p>
			{/each}
		</div>
	{/if}
</div>
