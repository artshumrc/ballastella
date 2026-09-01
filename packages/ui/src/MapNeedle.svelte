<script lang="ts">
	// The glyph for a Pin: a needle, a round head on a slender shaft.
	//
	// Ours rather than Lucide's `map-pin` because the mark on the map is a needle
	// (`core/src/render/needle.ts` is the drawing, and carries the reasoning), and the button that
	// draws a Pin, the row that lists one and the mark itself have to be one glyph — a teardrop in the
	// sidebar and a needle on the map is a shape a scholar has to learn twice.
	//
	// ⚠ **Written out here rather than generated from `needle.ts`, and it is the one place that is
	// so.** Two reasons. It is *line art at 16 px*: a stroked circle and a line cannot be the filled
	// silhouette that module defines, and holding the mark's shaft-to-head ratio here would draw a bar
	// rather than a glyph. And a value import from `@ballastella/core/render` would pull that barrel —
	// maplibre, pmtiles — into every page that lists an Annotation, including the Front Page, which is
	// why `LayerList.svelte` takes only types from it. So: if the needle's proportions change there,
	// this is the file that has to be looked at by hand.
	//
	// Stroked on the same 24×24 grid Lucide uses, at the same stroke width and caps, because it sits
	// in a row beside `Spline` and `Pentagon` and a filled glyph in that row reads as a heavier
	// control rather than as a different shape. The head's radius is 5 so that the stroke's outer edge
	// lands near the 6.5 `NEEDLE_HEAD` uses, and the shaft keeps Lucide's stroke weight.

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
