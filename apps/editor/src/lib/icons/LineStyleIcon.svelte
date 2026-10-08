<script lang="ts">
	import type { LineStyle } from '@ballastella/core';

	let { style, ...rest }: { style: LineStyle } & Record<string, unknown> = $props();

	const PATHS: Record<LineStyle, string[]> = {
		solid: ['M5 12h14'],
		dashed: ['M5 12h4', 'M15 12h4'],
		dotted: ['M5 12h.01', 'M9.67 12h.01', 'M14.33 12h.01', 'M19 12h.01']
	};
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width="24"
	height="24"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	{...rest}
>
	{#each PATHS[style] as d (d)}
		<path {d} />
	{/each}
</svg>
