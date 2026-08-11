<script lang="ts">
	// A dotted stroke, for the "dotted" line style. Drawn to match {@link LineSolid.svelte}, which
	// carries the note about why these three are ours and about the cap arithmetic they are written in
	// terms of.
	//
	// Each dot is a zero-length segment with a round cap — Lucide's own `h.01` idiom — so a dot is
	// exactly as wide as the stroke: 2 units of ink, centred on the path's own point.
	//
	// Four dots, evenly spaced from 5 to 19, so the ink runs 4 to 20 like the other two. That leaves
	// 2.67 units between dots, which is wider than the dots themselves — the property that makes this
	// read as *dotted* rather than as a thin dashed line, and the reason the spacing is not simply the
	// dashed glyph's divided up.

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
	<path d="M5 12h.01" />
	<path d="M9.67 12h.01" />
	<path d="M14.33 12h.01" />
	<path d="M19 12h.01" />
</svg>
