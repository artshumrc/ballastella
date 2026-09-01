<script lang="ts">
	// How this Project draws the administrative boundaries it draws: the Borders section of Project
	// settings.
	//
	// **The same three controls the Annotation Style face offers, and the same components** —
	// `ColorPicker`, `LineStylePicker`, and a `<input type="range">` for the width. A border and an
	// Annotation line are both lines a scholar is styling, and two vocabularies for one act is how
	// "the dotted route" stops naming one thing. Everything ADR-0016 asks for comes with them.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────────
	// ONE SWITCH, NOT THREE
	//
	// The stored style has three independently automatic properties (`BaseMapBorderStyle`), and this
	// offers *one* Automatic/Custom switch over all three. The tolerance in the file is for documents
	// this app did not write; the surface does not need to be as wide, and three "automatic" toggles
	// beside three pickers is a section a scholar has to decode rather than read.
	//
	// **Switching to Custom seeds every picker from what is currently drawn**, which is the property
	// that makes the switch safe: flipping it changes what the file says and not what the map shows,
	// so a scholar can look at the controls to find out what automatic *was* before changing anything.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────────
	// A CHOSEN COLOUR IS USED VERBATIM, AND THAT IS WHY THERE IS A WARNING
	//
	// Automatic derives the line's colour from the Base Map's own flavor and keeps it legible in both
	// themes. A colour the author chose is drawn exactly as chosen instead — it is their argument and
	// it travels to the Published Site, so correcting it would make this swatch a lie about the map.
	// The palette contains White and Black, and each is invisible on one of the two grounds, so the
	// section says so rather than leaving it to be discovered on somebody else's screen. A Reader
	// picks their own theme on a Published Site, so both grounds are named, not just the one here.

	import {
		MAX_BORDER_WIDTH,
		MIN_BORDER_WIDTH,
		subnationalWidth,
		type BaseMapBorderStyle,
		type BaseMapBorders
	} from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';

	import ColorPicker from '$lib/annotations/ColorPicker.svelte';
	import LineStylePicker from '$lib/annotations/LineStylePicker.svelte';

	let {
		borders,
		style,
		automatic,
		illegibleIn = [],
		onchange,
		oncommit
	}: {
		/** The boundary level, so the section can say when it is styling a line nothing draws. */
		borders: BaseMapBorders;
		/** What the Project records now. A `null` property means the author chose nothing. */
		style: BaseMapBorderStyle;
		/**
		 * What automatic currently draws, for the Base Map and theme on screen.
		 *
		 * Seeds the pickers when Custom is chosen, so the switch itself changes no drawing.
		 */
		automatic: BaseMapBorderStyle;
		/** Themes the chosen colour cannot be seen in. Empty when it can, or when none is chosen. */
		illegibleIn?: readonly ('light' | 'dark')[];
		/**
		 * A style property set, or `null` to hand it back to the derivation.
		 *
		 * `debounce` for the width alone, which is a dragged slider (ADR-0017 rule 1); a swatch and a
		 * dash pattern are each one deliberate choice and are written at once.
		 */
		onchange: (patch: Partial<BaseMapBorderStyle>, options?: { debounce?: boolean }) => void;
		/** The drag is over. A no-op unless something is pending, so it is safe on every release. */
		oncommit: () => void;
	} = $props();

	/** Custom exactly when the file records any choice at all. There is no third state. */
	const custom = $derived(style.color !== null || style.lineStyle !== null || style.width !== null);

	/**
	 * What each control shows: the author's value, or what automatic draws.
	 *
	 * The fallback is not cosmetic. A `ColorPicker` needs a colour to mark as current, and showing it
	 * the derived one is what makes the Custom switch seed rather than reset — it is also why the
	 * derived colour appears as the picker's dashed "not one of the nine" swatch, which is that
	 * component reporting what is on the map rather than rounding it to the nearest offer.
	 */
	const shown = $derived({
		color: style.color ?? automatic.color ?? '#808080',
		lineStyle: style.lineStyle ?? automatic.lineStyle ?? 'dashed',
		width: style.width ?? automatic.width ?? MIN_BORDER_WIDTH
	});

	const THEME_NAME = { light: 'the light theme', dark: 'the dark theme' } as const;
</script>

<fieldset class="flex w-full flex-col gap-3" data-testid="border-style-fields">
	<legend class="sr-only">Border appearance</legend>

	<!--
		Two positions in a `join`, the idiom the pin size and the line style already use for a small
		fixed choice. Real radios under the labels, so the arrow-key navigation and the group semantics
		are the browser's (ADR-0016).
	-->
	<div class="flex items-center justify-between gap-2 text-sm">
		<span aria-hidden="true">Appearance</span>
		<div class="join">
			<label
				class="btn join-item btn-sm {KIND_STYLE.map.btnWhenChecked}"
				data-testid="border-appearance-automatic"
			>
				<input
					type="radio"
					class="sr-only"
					name="border-appearance"
					value="automatic"
					checked={!custom}
					onchange={() => {
						onchange({ color: null, lineStyle: null, width: null });
						oncommit();
					}}
				/>
				Automatic
			</label>
			<label
				class="btn join-item btn-sm {KIND_STYLE.map.btnWhenChecked}"
				data-testid="border-appearance-custom"
			>
				<input
					type="radio"
					class="sr-only"
					name="border-appearance"
					value="custom"
					checked={custom}
					onchange={() => {
						// Every property at once, from what is drawn now: a partial seed would leave two
						// controls showing a value the file does not hold.
						onchange(automatic);
						oncommit();
					}}
				/>
				Custom
			</label>
		</div>
	</div>

	{#if custom}
		<div class="flex flex-col gap-2 border-t border-base-300 pt-3">
			<ColorPicker
				label="Border colour"
				caption="Colour"
				value={shown.color}
				name="border-color"
				testid="border-color"
				onchoose={(colour) => {
					onchange({ color: colour });
					oncommit();
				}}
			/>

			{#if illegibleIn.length > 0}
				<!--
					Named rather than corrected, and both grounds checked rather than the one on screen —
					see the head of this file. A `<p>` in the flow rather than a live region: it appears
					beside a control the user has just operated and is read on the next pass.
				-->
				<p class="text-xs text-warning" data-testid="border-color-contrast-warning">
					This colour is hard to see against {illegibleIn
						.map((scheme) => THEME_NAME[scheme])
						.join(' and ')}. Readers choose their own theme on a published site.
				</p>
			{/if}

			<LineStylePicker
				label="Border line style"
				caption="Line"
				value={shown.lineStyle}
				name="border-line-style"
				testid="border-line-style"
				kind="map"
				onchoose={(chosen) => {
					onchange({ lineStyle: chosen });
					oncommit();
				}}
			/>

			<!--
				`w-32` on the track and `w-10 text-right tabular-nums` on the readout, for the reason
				`AnnotationStyleFace` records: the value gaining a digit used to squeeze the track by
				exactly that much, so the slider moved under the pointer dragging it.
			-->
			<label class="flex items-center justify-between gap-2 text-sm">
				<span>Width</span>
				<span class="flex items-center gap-2">
					<input
						type="range"
						class="range w-32 shrink-0 range-sm {KIND_STYLE.map.range}"
						min={MIN_BORDER_WIDTH}
						max={MAX_BORDER_WIDTH}
						step="0.5"
						value={shown.width}
						data-testid="border-width"
						oninput={(event) =>
							onchange({ width: Number(event.currentTarget.value) }, { debounce: true })}
						onchange={() => oncommit()}
					/>
					<span class="w-10 shrink-0 text-right tabular-nums" data-testid="border-width-value">
						{shown.width}
					</span>
				</span>
			</label>

			<!--
				The width names the national line, and the divisions inside it are drawn proportionally
				narrower so `national` and `all` stay legible as different claims. Said here because a
				single slider labelled "Width" over a map showing two weights of line is otherwise a
				discrepancy a scholar has to measure to understand.
			-->
			{#if borders === 'all'}
				<p class="text-xs opacity-60" data-testid="border-width-note">
					National borders are drawn at this width; the divisions inside them at {subnationalWidth(
						shown.width
					)}.
				</p>
			{/if}
		</div>
	{/if}

	{#if borders === 'none'}
		<!--
			Kept rather than hidden when the level is `none`. The two fields are independent in the file
			on purpose, so an author comparing "with" and "without" does not lose their styling — and a
			section that vanished would look like it had.
		-->
		<p class="text-xs opacity-60" data-testid="border-style-not-drawn">
			This Project is not drawing borders, so none of this is on the map yet.
		</p>
	{/if}
</fieldset>
