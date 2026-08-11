<script lang="ts">
	// A solid stroke, for the "solid" line style.
	//
	// **Ours, because the icon set has none.** Lucide has no solid/dashed/dotted trio: the nearest
	// pieces are `minus` (a solid rule), nothing dashed that is not the outline of a box, and
	// `ellipsis`, which means "more". Three glyphs from three different families would not have read
	// as one scale, so the three are drawn here on Lucide's own grid — 24×24, a 2px `currentColor`
	// stroke, round caps — and sit beside Lucide icons without looking borrowed.
	//
	// ───────────────────────────────────────────────────────────────────────────────────────────────
	// ⚠ A ROUND CAP IS 1 UNIT LONGER AT EACH END THAN THE PATH IT IS ON
	//
	// This is the whole reason the three of them are drawn the way they are, and the reason the dashed
	// one was **indistinguishable from this one** when it was first written. `stroke-linecap="round"`
	// with `stroke-width="2"` paints a semicircle of radius 1 past each endpoint, so a path from 4 to 8
	// puts ink from 3 to 9. Dashes of length 4 with 2-unit gaps therefore have *no gaps at all*: each
	// gap loses 1 unit to the cap on either side of it, and the dashes abut. It rendered as a solid
	// rule and the two glyphs were the same picture.
	//
	// So the geometry of all three is written in terms of the **ink**, not the path:
	//
	//   • every one of them paints from 4 to 20, so the three weigh the same and sit on one baseline —
	//     which is why this path is `5 → 19` rather than the `4 → 16` it used to be
	//   • every gap is stated as the gap that survives the caps, and none is under 2.5 units, which is
	//     about 1.7px at the 16px these are actually rendered at (`size-4`)
	//
	// `line-icons.test.ts` computes those extents from these files and fails on a gap the caps would
	// close, so the trap cannot be walked into again by eye.

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
	<path d="M5 12h14" />
</svg>
