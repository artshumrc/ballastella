<script lang="ts">
	// The Annotation Inspector's Style face: how one Annotation is drawn.
	//
	// **Beside the map rather than under the row**, so the control and the change it makes are in the
	// same glance — and behind a deliberate press, so selecting an Annotation to read it never produces
	// an authoring form.
	//
	// Every control is a native element, which is ADR-0016's mandate and not a preference: radios for
	// the line style, the pin size and the colours, `<input type="range">` for the opacities. There is
	// nothing custom here and therefore nothing to make keyboard-accessible afterwards.
	//
	// **There are no colour wells**, and that is the mandate being followed rather than bent: an
	// Annotation may be one of nine named colours (`ANNOTATION_COLORS`), and a fixed set of alternatives
	// is a radio group. `ColorPicker` owns the whole argument, including why a row of coloured squares
	// is not meaning carried by appearance alone.
	//
	// **A geometry this build cannot draw never reaches here.** The consumer passes no `style` snippet
	// for one, so there is no Style tab rather than a tab explaining its own emptiness — which is why
	// nothing in this file says "this shape cannot be drawn".

	import {
		isLabel as annotationIsLabel,
		MARKER_SIZES,
		lineStyleOf,
		resolveStyle,
		type Annotation,
		type LineStyle
	} from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';

	import ColorPicker from './ColorPicker.svelte';
	import LineStylePicker from './LineStylePicker.svelte';

	let {
		annotation,
		onstyle,
		onlinestyle,
		oncommit,
		onapplytoall
	}: {
		annotation: Annotation;
		/** A style property set, by its exact simplestyle name, or `undefined` to clear it. */
		onstyle: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		onlinestyle: (line: LineStyle) => void;
		/** Apply this Annotation's effective style to every compatible Annotation in its Layer. */
		onapplytoall: () => void;
		/**
		 * The change is over — a swatch chosen, or a slider released (ADR-0017 rule 1).
		 *
		 * A no-op unless something is pending, which is why the pin size and the line style do not call
		 * it: neither debounces, so there is never a pending write of theirs to flush.
		 */
		oncommit: () => void;
	} = $props();

	const properties = $derived(annotation.properties);

	/**
	 * What this Annotation currently draws with.
	 *
	 * Resolved against simplestyle's own defaults and nothing else, since ADR-0009's amendment: a
	 * newly drawn Annotation is given the last one's style outright, so what a control shows is what
	 * the file says rather than what it inherits.
	 */
	const resolved = $derived(resolveStyle(properties));

	const geometryKind = $derived(annotation.geometry?.type ?? null);
	const isLabel = $derived(annotationIsLabel(annotation));
	const isPoint = $derived(geometryKind === 'Point' && !isLabel);
	const hasArea = $derived(geometryKind === 'Polygon' || geometryKind === 'Circle');
	const hasLine = $derived(
		geometryKind === 'LineString' || geometryKind === 'Polygon' || geometryKind === 'Circle'
	);

	const lineStyle = $derived<LineStyle>(lineStyleOf(resolved['stroke-dasharray']));

	/** Whether this Annotation sets a property itself, rather than taking simplestyle's own. */
	const own = (key: string): boolean => key in properties;

	/**
	 * The hairline that separates one style group from the one above it.
	 *
	 * A group is a `<fieldset>` with a name of its own, and what makes the names legible is that the
	 * groups are visibly separate — but the *first* group in the face has the tab strip above it, and a
	 * second line a few pixels below that reads as a mistake. So the divider belongs to the boundary
	 * rather than to the group, and every group asks whether it is the first.
	 */
	const DIVIDER = 'border-t border-base-300 pt-3';
</script>

<!--
	Style, all of it visible, grouped by the part of the drawing each property is about.
	─────────────────────────────────────────────────────────────────────────────────────────────────
	**"More styles" is gone.** The width and the two opacities used to sit behind a `<details>` on
	the grounds that they are measured rather than chosen. It saved three rows and cost the ordering:
	the properties of a line were split across a disclosure, so a scholar setting a line's width had
	its colour off screen, and the thing hidden from a *polygon* was half of its fill. A pin never had
	one at all — its size was the only thing that would have been behind it — so the surface's shape
	depended on which shape was selected.
	─────────────────────────────────────────────────────────────────────────────────────────────────
	**The grouping is what does that work now, and it does it better than the disclosure did.** One
	`<fieldset>` per part — Pin, or Label, or Fill and Line — each named once, so the labels inside
	lose the prefix they were all carrying ("Line colour", "Line width", "Line opacity" → Colour,
	Width, Opacity). Fill comes before Line on a shape, which is the order every drawing tool uses: the
	area first, then the edge around it.
	─────────────────────────────────────────────────────────────────────────────────────────────────
	The group names reach assistive technology as `<legend>`s, which is what makes two controls both
	labelled "Opacity" unambiguous — the legend is announced with the control (WCAG technique H71), so
	this is the native grouping doing the disambiguating rather than the visible text repeating it.
	They are drawn as a separate `aria-hidden` line rather than by styling the `<legend>` itself,
	which is the pattern this surface already used for "Pin size": a `<legend>` in a flex `<fieldset>`
	is still laid out specially by the browser, and a heading that has to fight that is a heading that
	moves when a font does.
	─────────────────────────────────────────────────────────────────────────────────────────────────
	**Room is left for one more group below these.** *Apply to all in this Layer* is the action
	ADR-0009's amendment says should return, and it belongs at the end of this column — so the groups
	are a flat stack rather than a layout that would have to be rearranged to take another.
-->
<fieldset class="flex flex-col gap-3" data-testid="annotation-style-face">
	<legend class="sr-only">Style</legend>

	{#if isPoint || isLabel}
		<fieldset class="flex flex-col gap-2">
			<legend class="sr-only">{isLabel ? 'Label' : 'Pin'}</legend>
			<p class="text-[0.65rem] font-semibold uppercase opacity-70" aria-hidden="true">
				{isLabel ? 'Label' : 'Pin'}
			</p>

			<!--
				**Not debounced, unlike the well it replaced.** An `<input type="color">` fires `input`
				continuously while a user drags around a colour wheel, which is what the debounce was for;
				a swatch is one `change` and one deliberate choice, so the write is committed immediately.
				The same reason the line style and the pin size have never debounced.
			-->
			<div data-own={own('marker-color')}>
				<ColorPicker
					label={isLabel ? 'Label text colour' : 'Pin colour'}
					caption="Colour"
					value={resolved['marker-color']}
					name="annotation-marker-color"
					testid="annotation-marker-color"
					onchoose={(colour) => {
						onstyle({ 'marker-color': colour });
						oncommit();
					}}
				/>
			</div>

			{#if isLabel}
				<div data-own={own('fill')}>
					<ColorPicker
						label="Label background colour"
						caption="Background"
						value={resolved.fill}
						name="annotation-fill"
						testid="annotation-fill"
						onchoose={(colour) => {
							onstyle({ fill: colour });
							oncommit();
						}}
					/>
				</div>

				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Background opacity</span>
					<span class="flex items-center gap-2">
						<input
							type="range"
							class="range w-32 shrink-0 range-sm {KIND_STYLE.annotation.range}"
							min="0"
							max="1"
							step="0.05"
							value={resolved['fill-opacity']}
							data-testid="annotation-fill-opacity"
							oninput={(event) =>
								onstyle({ 'fill-opacity': Number(event.currentTarget.value) }, { debounce: true })}
							onchange={() => oncommit()}
						/>
						<span
							class="w-10 shrink-0 text-right tabular-nums"
							data-testid="annotation-fill-opacity-value"
						>
							{resolved['fill-opacity']}
						</span>
					</span>
				</label>
			{/if}

			<!--
				The shared size control for a Pin or a Label.

				The three sizes are simplestyle's own, offered as a radio group rather than a `<select>`
				for the same reason the line style is: three alternatives, all worth seeing at once. It
				used to carry a fourth option, "Layer's default" — the Layer no longer has one (ADR-0009,
				as amended), and an option naming a thing that is nowhere on the screen is a question a
				scholar cannot answer.

				An unset `marker-size` shows as medium, which is what it draws as: the renderer coalesces
				to medium, so the control reports what is on the map rather than a blank.
			-->
			<fieldset class="flex items-center justify-between gap-2 text-sm">
				<legend class="sr-only">{isLabel ? 'Label size' : 'Pin size'}</legend>
				<span aria-hidden="true">Size</span>
				<div class="join">
					{#each MARKER_SIZES as size (size)}
						<label
							class="btn join-item btn-xs {KIND_STYLE.annotation.btnWhenChecked}"
							data-testid="annotation-marker-size-{size}"
						>
							<input
								type="radio"
								class="sr-only"
								name="annotation-marker-size"
								value={size}
								checked={(resolved['marker-size'] ?? 'medium') === size}
								onchange={() => onstyle({ 'marker-size': size })}
							/>
							{size}
						</label>
					{/each}
				</div>
			</fieldset>
		</fieldset>
	{/if}

	{#if hasArea}
		<!--
			The area first, then the edge around it — and everything a shape's fill has in one place,
			which is the half of a polygon that "More styles" used to hide.
		-->
		<fieldset class="flex flex-col gap-2">
			<legend class="sr-only">Fill</legend>
			<p class="text-[0.65rem] font-semibold uppercase opacity-70" aria-hidden="true">Fill</p>

			<div data-own={own('fill')}>
				<ColorPicker
					label="Fill colour"
					caption="Colour"
					value={resolved.fill}
					name="annotation-fill"
					testid="annotation-fill"
					onchoose={(colour) => {
						onstyle({ fill: colour });
						oncommit();
					}}
				/>
			</div>

			<label class="flex items-center justify-between gap-2 text-sm">
				<span>Opacity</span>
				<span class="flex items-center gap-2">
					<input
						type="range"
						class="range w-32 shrink-0 range-sm {KIND_STYLE.annotation.range}"
						min="0"
						max="1"
						step="0.05"
						value={resolved['fill-opacity']}
						data-testid="annotation-fill-opacity"
						oninput={(event) =>
							onstyle({ 'fill-opacity': Number(event.currentTarget.value) }, { debounce: true })}
						onchange={() => oncommit()}
					/>
					<span
						class="w-10 shrink-0 text-right tabular-nums"
						data-testid="annotation-fill-opacity-value"
					>
						{resolved['fill-opacity']}
					</span>
				</span>
			</label>
		</fieldset>
	{/if}

	{#if hasLine}
		<fieldset class="flex flex-col gap-2 {hasArea ? DIVIDER : ''}">
			<legend class="sr-only">Line</legend>
			<p class="text-[0.65rem] font-semibold uppercase opacity-70" aria-hidden="true">Line</p>

			<div data-own={own('stroke')}>
				<ColorPicker
					label="Line colour"
					caption="Colour"
					value={resolved.stroke}
					name="annotation-stroke"
					testid="annotation-stroke"
					onchoose={(colour) => {
						onstyle({ stroke: colour });
						oncommit();
					}}
				/>
			</div>

			<!--
				Three choices, mapping to absent, [8, 4], and [1, 3]. The three-way choice is
				presentation; the stored value is the tuple, and solid is the property being absent
				(ADR-0009) — which is why the handler goes through `onlinestyle` rather than writing a
				value of its own.
			-->
			<LineStylePicker
				value={lineStyle}
				caption="Style"
				name="annotation-line-style"
				testid="annotation-line-style"
				onchoose={(style) => onlinestyle(style)}
			/>

			<!--
				**The three sliders here keep their width and so do their readouts.** The row moved as the
				number grew a digit — `1` to `0.5` to `0.05` — and because the value sat in the same flex
				line as the track, the track was squeezed by exactly the amount the number gained: the
				slider shifted under the pointer that was dragging it, which is the one moment a control
				must not move. `w-32` fixes the track, `w-10 text-right` reserves the widest reading
				(`0.05`, four characters), and `tabular-nums` stops the digits themselves changing width.
				`AlignmentWorkspace` fixed the same defect on the overlay slider first and records the same
				reasoning.
			-->
			<label class="flex items-center justify-between gap-2 text-sm">
				<span>Width</span>
				<span class="flex items-center gap-2">
					<input
						type="range"
						class="range w-32 shrink-0 range-sm {KIND_STYLE.annotation.range}"
						min="0"
						max="10"
						step="0.5"
						value={resolved['stroke-width']}
						data-testid="annotation-stroke-width"
						oninput={(event) =>
							onstyle({ 'stroke-width': Number(event.currentTarget.value) }, { debounce: true })}
						onchange={() => oncommit()}
					/>
					<span
						class="w-10 shrink-0 text-right tabular-nums"
						data-testid="annotation-stroke-width-value"
					>
						{resolved['stroke-width']}
					</span>
				</span>
			</label>

			<label class="flex items-center justify-between gap-2 text-sm">
				<span>Opacity</span>
				<span class="flex items-center gap-2">
					<input
						type="range"
						class="range w-32 shrink-0 range-sm {KIND_STYLE.annotation.range}"
						min="0"
						max="1"
						step="0.05"
						value={resolved['stroke-opacity']}
						data-testid="annotation-stroke-opacity"
						oninput={(event) =>
							onstyle({ 'stroke-opacity': Number(event.currentTarget.value) }, { debounce: true })}
						onchange={() => oncommit()}
					/>
					<span
						class="w-10 shrink-0 text-right tabular-nums"
						data-testid="annotation-stroke-opacity-value"
					>
						{resolved['stroke-opacity']}
					</span>
				</span>
			</label>
		</fieldset>
	{/if}

	<div class="border-t border-base-300 pt-3">
		<button
			type="button"
			class="btn btn-block btn-sm"
			data-testid="annotation-apply-style-to-layer"
			onclick={() => onapplytoall()}
		>
			Apply to all Annotations in this Layer
		</button>
	</div>
</fieldset>
