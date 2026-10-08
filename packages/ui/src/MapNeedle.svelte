<script lang="ts">
	// The glyph for a Pin: a needle, a round head on a slender shaft.

	let { class: className = '', ...rest }: { class?: string } & Record<string, unknown> = $props();
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
	class={className}
	{...rest}
>
	<circle cx="12" cy="8.5" r="5" />
	<path d="M12 14.5V22" />
</svg>
