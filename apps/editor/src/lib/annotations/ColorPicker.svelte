<script lang="ts">
	// The nine colours an Annotation can be drawn in (`ANNOTATION_COLORS`).
	//
	// **One component for all three places a colour is chosen** — a pin's, a line's, a fill's — for the
	// same reason `LineStylePicker` is one component: the vocabulary has to be identical everywhere, or
	// "the blue route" stops naming one colour.
	//
	// This replaced `<input type="color">`. The well was ADR-0016's mandated native element and it was
	// still the wrong control: it offers sixteen million colours, which asks a historian to be a designer
	// and produces Projects where nine routes are nine indistinguishable near-reds. ADR-0016 mandates
	// native elements so that keyboard and screen-reader support are not reimplemented, and that is
	// satisfied here by what replaced it — a real `<input type="radio">` group, which is the *same*
	// mandate's shape for a fixed set of alternatives, and is what `LineStylePicker` and the pin sizes
	// already are.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────────
	// ONE ROW, IN THREE TRIPLES
	//
	// This was a 3×3 grid, and the grid was the wrong trade: three rows of swatches beside three of these
	// pickers is the tallest thing in the Layer sidebar, and a card that is mostly swatches reads as
	// busier than it is. A single row is a quarter of the height and still fits — nine 24px swatches, the
	// gaps between them and the two wider gaps below come to 256px inside a 384px column.
	//
	// **The palette's own grouping survives the flattening**, which is the part worth being careful
	// about: `ANNOTATION_COLORS`' order is neutrals, then warm, then cool, and the grid was what made
	// that legible (see the note in `annotation.ts`). So the row is drawn as three groups of three with a
	// wider gap between them — the same reading, along instead of down, and taken from the palette's
	// length rather than from a hard-coded nine.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────────
	// COLOUR IS NEVER THE ONLY CHANNEL
	//
	// A row of nine coloured squares is, on the face of it, exactly the control SPEC story 111 forbids:
	// meaning carried by appearance alone. Three things carry it instead, and none of them is the colour:
	//
	//   • **every swatch is named** — the name is in `sr-only` text inside the label, so the accessible
	//     name of each radio is "Red" rather than "option 4"
	//   • **the chosen one carries a tick**, a glyph rather than a border colour, because a ring drawn in
	//     the theme's own accent is invisible on the swatch that happens to be that colour
	//   • **the caption says what is chosen, in words** — the only channel that survives a monochrome
	//     screen. It sits on the label's own line, at the end of it, rather than under the swatches: the
	//     row it used to have was the last of the height this control was spending on nothing.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────────
	// THE TICK IS WHITE, EXCEPT ON THE TWO LIGHT SWATCHES
	//
	// This was `mix-blend-difference` first — one rule, no exceptions, and **invisible**: the difference
	// of white and a mid hue is another mid hue. Measured against each swatch it gave 1.03:1 on Orange,
	// 1.29:1 on Green and 1.75:1 on Blue, where a graphical object needs 3:1 (WCAG 2.1 AA, 1.4.11). A
	// blend mode looked principled and was doing nothing.
	//
	// So the tick is white unless the swatch is *light*, and then it is black. White is the right default
	// rather than a coin-toss: seven of the nine colours are dark, so it is the answer that keeps the grid
	// looking like one control instead of a mosaic of black and white ticks. `tickInk` reads the swatch's
	// own relative luminance rather than naming White and Yellow, so a colour added later gets a legible
	// tick without anyone remembering this comment. The threshold is 0.5, which today means exactly those
	// two. Measured, both themes irrelevant because a swatch is its own background:
	//
	//     swatch   luminance   white tick   black tick        chosen
	//     Black        0.00        21.0         1.0            white
	//     Grey         0.09         7.5         2.8            white
	//     White        1.00         1.0        21.0            black
	//     Red          0.16         5.0         4.2            white
	//     Orange       0.29         3.1         6.8            white   ← the weakest, and still ≥ 3:1
	//     Yellow       0.58         1.7        12.7            black
	//     Green        0.21         4.1         5.1            white
	//     Blue         0.18         4.6         4.6            white
	//     Purple       0.08         8.2         2.6            white
	//
	// Orange is the one place consistency is paid for: a black tick would carry 6.8:1 there rather than
	// 3.1:1. It clears the bar that applies, and buying the extra margin would cost the rule — a grid
	// where the tick changes colour twice going along a row reads as a bug.
	//
	// Every swatch also carries a hairline border: white on a `base-100` card is otherwise a square that
	// is not there at all.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────────
	// A COLOUR THAT IS NOT ONE OF THE NINE
	//
	// simplestyle allows any `#RRGGBB` and ADR-0009 validates the format rather than the value, so a
	// file from QGIS — or from a later version of this app with a wider palette — can carry a colour this
	// row does not contain. It is drawn as a tenth swatch, after the nine, marked as the current
	// colour and **not selectable**: the control reports what is on the map rather than rounding it to
	// the nearest thing it can offer, which is the same rule the pin size follows when it shows an unset
	// `marker-size` as medium. Choosing any of the nine replaces it and it disappears.
	//
	// It should be rare rather than routine: `styleForNewAnnotation` starts a new Annotation on the
	// palette's grey precisely so that a freshly drawn shape is never in this state.

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
		/** The colour this Annotation draws with now, as `#RRGGBB`. */
		value: string;
		/** The radio group's `name`. Three pickers are on screen at once and must not share it. */
		name: string;
		/** Prefix for each swatch's test id, as `{testid}-{colour name, lowercased}`. */
		testid: string;
		/**
		 * What this control is, in full — "Line colour", never "Colour".
		 *
		 * This is the group's accessible name and it is read on its own, with nothing around it to
		 * disambiguate it: a screen reader that announced "Colour" three times in one card would be
		 * describing three indistinguishable controls.
		 */
		label: string;
		/**
		 * The shorter thing to *draw*, where the enclosing group already says which part it is about.
		 *
		 * Defaults to `label`, so a picker with no group around it still names itself on screen. This is
		 * the only reason the two are separate props: the visible text may lose the prefix that the group
		 * heading beside it is already carrying, and the accessible name may not.
		 */
		caption?: string;
		onchoose: (colour: string) => void;
	} = $props();

	/** Lowercased once, because a file may spell a colour `#FFFFFF` and a swatch never does. */
	const chosen = $derived(value.toLowerCase());

	/**
	 * The colour of the tick drawn on a swatch: black on a light one, white on the rest.
	 *
	 * WCAG's own relative luminance, which is the quantity the contrast ratio is defined in terms of —
	 * so this is the same measurement the table above records rather than an eyeball for "looks light".
	 * The 0.5 threshold puts White and Yellow on one side and the other seven on the other.
	 */
	const tickInk = (hex: string): string => {
		const channel = (at: number): number => {
			const part = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
			return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
		};
		const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
		return luminance > 0.5 ? '#000000' : '#ffffff';
	};

	/** What the current colour is called, or `null` when it is not one of the nine. */
	const chosenName = $derived(annotationColorName(value));

	/**
	 * The palette in threes — neutrals, warm, cool — which is the grouping the row draws.
	 *
	 * Sliced from the palette's own length rather than written out, so a palette of six or twelve draws
	 * as two or four groups instead of silently losing its last colours.
	 */
	const GROUPS = Array.from({ length: Math.ceil(ANNOTATION_COLORS.length / 3) }, (_, at) =>
		ANNOTATION_COLORS.slice(at * 3, at * 3 + 3)
	);
</script>

<fieldset class="flex flex-col gap-1">
	<div class="flex items-baseline justify-between gap-2 text-sm">
		<legend class="sr-only">{label}</legend>
		<span aria-hidden="true">{caption ?? label}</span>

		<!--
			What is chosen, in words — the channel that survives a monochrome screen, and the one that
			makes this row legal under SPEC story 111. `aria-live`, because choosing a swatch changes text
			that a screen-reader user has just moved focus *past*: the radio announces its own name on
			arrival, and this is what tells them the file now says so.
		-->
		<span class="text-xs opacity-60" aria-live="polite" data-testid="{testid}-chosen">
			{#if chosenName === null}
				{chosen} — not one of the nine
			{:else}
				{chosenName}
			{/if}
		</span>
	</div>

	<!--
		One row, in three groups of three: neutrals, then warm, then cool. The order is
		`ANNOTATION_COLORS`' order and the wider gap between groups is what keeps it legible now that
		there are no rows to carry it — see the note in `annotation.ts` about why adding a tenth colour
		would cost that.
	-->
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
							<!-- White, or black on a light swatch — see `tickInk` and the measured table above. -->
							<Check
								class="absolute inset-0 m-auto size-4"
								style="color: {tickInk(colour.value)}"
								data-ink={tickInk(colour.value)}
								aria-hidden="true"
							/>
						{/if}
					</label>
				{/each}
			</div>
		{/each}

		{#if chosenName === null}
			<!--
				A colour from outside the palette, reported rather than rounded. A `<span>`, not a tenth
				radio: it is not a choice, and a disabled radio inside the group would be a tab stop that
				leads nowhere and an option a screen reader would list.
			-->
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
