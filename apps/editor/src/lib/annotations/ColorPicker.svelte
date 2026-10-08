<script lang="ts">
	import { ANNOTATION_COLORS, annotationColorName } from '@ballastella/core';
	import Check from '@lucide/svelte/icons/check';

	let {
		value,
		name,
		testid,
		label,
		caption = undefined,
		onchoose
	}: {
		value: string;
		name: string;
		testid: string;
		label: string;
		caption?: string;
		onchoose: (colour: string) => void;
	} = $props();

	const chosen = $derived(value.toLowerCase());

	const tickInk = (hex: string): string => {
		const channel = (at: number): number => {
			const part = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
			return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
		};
		const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
		return luminance > 0.5 ? '#000000' : '#ffffff';
	};

	const chosenName = $derived(annotationColorName(value));

	const GROUPS = Array.from({ length: Math.ceil(ANNOTATION_COLORS.length / 3) }, (_, at) =>
		ANNOTATION_COLORS.slice(at * 3, at * 3 + 3)
	);
</script>

<fieldset class="flex flex-col gap-1">
	<div class="flex items-baseline justify-between gap-2 text-sm">
		<legend class="sr-only">{label}</legend>
		<span aria-hidden="true">{caption ?? label}</span>

		<span class="text-xs opacity-60" aria-live="polite" data-testid="{testid}-chosen">
			{#if chosenName === null}
				{chosen} — not one of the nine
			{:else}
				{chosenName}
			{/if}
		</span>
	</div>

	<div class="flex items-center gap-2" data-testid={testid}>
		{#each GROUPS as group, at (at)}
			<div class="flex gap-1">
				{#each group as colour (colour.value)}
					{@const isChosen = chosen === colour.value}
					<label
						class="relative size-6 cursor-pointer rounded-box border border-base-content/30 transition-transform hover:scale-110 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-base-content"
						style="background-color: {colour.value}"
						data-testid="{testid}-{colour.name.toLowerCase()}"
						data-chosen={isChosen ? 'true' : 'false'}
					>
						<input
							type="radio"
							class="sr-only"
							{name}
							value={colour.value}
							checked={isChosen}
							onchange={() => onchoose(colour.value)}
						/>
						<span class="sr-only">{colour.name}</span>
						{#if isChosen}
							{@const ink = tickInk(colour.value)}
							<Check
								class="absolute inset-0 m-auto size-4"
								style="color: {ink}"
								data-ink={ink}
								aria-hidden="true"
							/>
						{/if}
					</label>
				{/each}
			</div>
		{/each}

		{#if chosenName === null}
			<span
				class="size-6 shrink-0 rounded-box border-2 border-dashed border-base-content/50"
				style="background-color: {chosen}"
				data-testid="{testid}-current"
				data-colour={chosen}
				aria-hidden="true"
			></span>
		{/if}
	</div>
</fieldset>
