<script lang="ts">
	// The three-way line style choice: solid, dashed, dotted (ADR-0009).
	//
	// **One component for both places that offer it** — the Layer's default and the selected
	// Annotation's own — because two copies of a three-way choice drift, and this one carries a
	// meaning that has to be identical in both: what a scholar is saying about how sure they are.
	//
	// A radio group drawn as a button group, not a `<select>`: three alternatives, all three worth
	// seeing at once, and each showing the stroke it means rather than naming it. Real
	// `<input type="radio">`s under the labels, which is where the arrow-key navigation and the group
	// semantics come from for free (ADR-0016); `has-[:checked]` is what tints the chosen one, in the
	// Annotation Layer's own colour from `layer-kind-style.ts` — this only ever draws inside an
	// Annotation card, and a card's controls are the card's colour.
	//
	// The three stroke glyphs are ours (`../icons/Line*.svelte`) because the icon set has no
	// solid/dashed/dotted trio; they are drawn on its grid so they sit beside its icons without
	// looking borrowed. The word stays beside the glyph (SPEC story 111), so each button says what it is
	// in text as well as in a picture.
	//
	// **What a stroke means is no longer written under it.** There was a caption reading "dashed —
	// conjectural", inherited from the `<option>` labels this replaced, and it was the app telling
	// scholars what their own notation stands for. Solid for certain and dotted for doubtful is one
	// convention among several, and a historian mapping something else — a paved road against an unpaved
	// one, a summer route against a winter one — was being contradicted by their own tool. The three
	// strokes are offered; what they assert is the scholar's to decide (human decision, 2026-08-11).

	import { LINE_STYLES, type LineStyle } from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';

	import LineDashed from '../icons/LineDashed.svelte';
	import LineDotted from '../icons/LineDotted.svelte';
	import LineSolid from '../icons/LineSolid.svelte';

	let {
		value,
		name,
		testid,
		label = 'Line style',
		caption = undefined,
		onchoose
	}: {
		value: LineStyle;
		/** The radio group's `name`. Two pickers on one screen must not share it. */
		name: string;
		/** Prefix for each button's test id, as `{testid}-{style}`. */
		testid: string;
		/** What this control is, in full — the group's accessible name, read with nothing around it. */
		label?: string;
		/**
		 * The shorter thing to *draw*, where the group around it already says it is about the line.
		 * Defaults to `label`. Same split, and same reason, as `ColorPicker`'s.
		 */
		caption?: string;
		onchoose: (style: LineStyle) => void;
	} = $props();

	const ICONS: Record<LineStyle, typeof LineSolid> = {
		solid: LineSolid,
		dashed: LineDashed,
		dotted: LineDotted
	};
</script>

<fieldset class="flex flex-col gap-1">
	<div class="flex items-center justify-between gap-2 text-sm">
		<legend class="sr-only">{label}</legend>
		<span aria-hidden="true">{caption ?? label}</span>
		<div class="join">
			{#each LINE_STYLES as style (style)}
				{@const Icon = ICONS[style]}
				<label
					class="btn join-item gap-1 btn-sm {KIND_STYLE.annotation.btnWhenChecked}"
					data-testid="{testid}-{style}"
				>
					<input
						type="radio"
						class="sr-only"
						{name}
						value={style}
						checked={value === style}
						onchange={() => onchoose(style)}
					/>
					<Icon class="size-4" aria-hidden="true" />
					{style}
				</label>
			{/each}
		</div>
	</div>
</fieldset>
