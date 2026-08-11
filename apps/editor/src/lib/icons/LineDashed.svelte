<script lang="ts">
	// A dashed stroke, for the "dashed" line style. Drawn to match {@link LineSolid.svelte}, which
	// carries the note about why these three are ours — and the cap arithmetic that this glyph got
	// wrong.
	//
	// **Two dashes, not three.** It was three dashes of length 4 with 2-unit gaps, and with round caps
	// eating 1 unit at each end of every gap it painted an unbroken line: identical to the solid glyph.
	// Three dashes *can* be made to work — 2.5-long dashes with 4.25 gaps fits the same 4→20 run — but
	// the gap that survives is 2.25 units, which is 1.5px at the 16px these render at, and a 1.5px gap
	// on a 1.33px stroke is a glyph that argues with the eye rather than telling it something.
	//
	// So: dashes of 4 with a 6-unit gap, which paints ink from 4 to 10 and from 14 to 20 — two 6-unit
	// dashes with a 4-unit gap between them, about 2.7px at 16px. Unmistakable at the size it is used,
	// which beats being faithful to the 2:1 dash-to-gap ratio `DASHED_DASHARRAY` uses on the map. The
	// glyph's job is to be told apart from two others in a 24px button, not to be a preview.

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
	<path d="M5 12h4" />
	<path d="M15 12h4" />
</svg>
