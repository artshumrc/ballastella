<script lang="ts">
	// One Annotation's title, description, and style (SPEC stories 62–65 and 67).
	//
	// **Text until somebody asks to change it**, which is the same rule the Layer card's name follows
	// and for the same reason: a column of bordered fields reads as a form to fill in, and this is
	// mostly a thing to *read*. The title is a line of text and the description is its rendered
	// Markdown; the pencil turns both into the fields they used to always be.
	//
	// That is what removed the live preview. It existed because the Markdown was only ever visible as
	// source — the preview was the only place a scholar who has never written Markdown could see what
	// they had typed. Now the resting state *is* the rendered description, so a preview beside the
	// textarea would be the same rendering twice, a few pixels apart. The rendering itself did not
	// move: it is still `renderDescription`, still the only `{@html}` here, still fed nothing but
	// DOMPurify's own output.
	//
	// Every control is a native element, which is ADR-0016's mandate and not a preference: radios for
	// the line style, the pin size and now the colours, `<input type="range">` for the opacities. There is
	// nothing custom here and therefore nothing to make keyboard-accessible afterwards.
	//
	// **The three colour wells are gone**, and that is the mandate being followed rather than bent: an
	// Annotation may be one of nine named colours (`ANNOTATION_COLORS`), and a fixed set of alternatives
	// is a radio group. `ColorPicker` owns the whole argument, including why a row of coloured squares
	// does not fall foul of SPEC story 111.

	import {
		MARKER_SIZES,
		isDescriptionRendererSupported,
		lineStyleOf,
		renderDescription,
		resolveStyle,
		type Annotation,
		type LineStyle
	} from '@ballastella/core';
	import { KIND_STYLE } from '@ballastella/ui';
	import Pencil from '@lucide/svelte/icons/pencil';
	import { onMount, tick } from 'svelte';

	import ColorPicker from './ColorPicker.svelte';
	import LineStylePicker from './LineStylePicker.svelte';

	let {
		annotation,
		ontext,
		oncommit,
		onstyle,
		onlinestyle,
		ondelete
	}: {
		annotation: Annotation;
		/** Typing. Coalesced into one write per file (ADR-0017 rule 2). */
		ontext: (text: { title?: string; description?: string }) => void;
		/** The edit is over — the field blurred, or Enter was pressed (ADR-0017 rule 1). */
		oncommit: () => void;
		/** A style property set, by its exact simplestyle name, or `undefined` to clear it. */
		onstyle: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		onlinestyle: (line: LineStyle) => void;
		ondelete: () => void;
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
	const isPoint = $derived(geometryKind === 'Point');
	const hasArea = $derived(geometryKind === 'Polygon');
	const hasLine = $derived(geometryKind === 'LineString' || geometryKind === 'Polygon');

	/**
	 * Whether this component has mounted in a browser.
	 *
	 * Both apps prerender (ADR-0006) and DOMPurify needs a DOM, so the renderer refuses in Node rather
	 * than degrading to returning its input unsanitised — the safe direction, since a fallback would
	 * write an XSS payload into a static file.
	 *
	 * It also sidesteps a Svelte hydration rule worth knowing: **`{@html}` is not re-rendered during
	 * hydration.** Svelte adopts the nodes the server produced and never compares them against the
	 * client's value, so a `{@html}` that was `''` on the server and complete HTML on the client renders
	 * nothing at all, permanently, with no warning. This component is only ever reached on a
	 * client-rendered branch of the Layers pane, so it is not currently exposed to that — but the same
	 * expression moved anywhere prerendered would be, silently, and **a blank description passes every
	 * "is the payload inert?" assertion.** `e2e/editor-annotations.e2e.ts` therefore asserts the
	 * description's text *is* rendered as well as that its markup is not.
	 */
	let mounted = $state(false);
	onMount(() => {
		mounted = true;
	});

	/** The description as sanitised HTML, or `''` where there is none or it cannot be rendered. */
	const rendered = $derived(
		mounted && properties.description && isDescriptionRendererSupported()
			? renderDescription(properties.description)
			: ''
	);

	const lineStyle = $derived<LineStyle>(lineStyleOf(resolved['stroke-dasharray']));

	/** Whether this Annotation sets a property itself, rather than taking simplestyle's own. */
	const own = (key: string): boolean => key in properties;

	/**
	 * Whether the title and description are fields rather than text.
	 *
	 * Reset by the `$effect` below whenever a different Annotation arrives, because this panel is
	 * reused rather than remounted: without it, selecting one Annotation while editing another's text
	 * would open the second one straight into a form nobody asked to edit.
	 */
	let editingText = $state(false);

	/** The field the pencil has just revealed, so it can be handed the keyboard. */
	let titleField = $state<HTMLInputElement | undefined>(undefined);

	/**
	 * The panel itself, so a selection made **on the map** brings its detail into view.
	 *
	 * Clicking a shape on the canvas selects it, and the thing that says what was selected is down a
	 * scrolling sidebar that may not be showing it. Scrolling is not focusing: focus would take the
	 * keyboard away from the map mid-gesture, so this moves the viewport and nothing else, and the
	 * panel is `tabindex="-1"` so it can still be focused deliberately.
	 */
	let panel = $state<HTMLDivElement | undefined>(undefined);

	/**
	 * The Annotation this panel last reacted to.
	 *
	 * **The guard is the point, not bookkeeping.** `annotation` is a fresh object every time the
	 * collection is re-read — which is after every save, which is while somebody is typing — so an
	 * effect that merely reads `annotation.id` re-runs on each keystroke's write and would slam the
	 * fields shut mid-sentence. The suite caught exactly that: `fill()` landed, the save came back,
	 * and the field the next line tried to blur no longer existed. Comparing the id makes "a different
	 * Annotation arrived" the trigger, which is what this was always about.
	 */
	let shown = $state('');

	$effect(() => {
		const id = annotation.id;
		if (id === shown) return;
		shown = id;
		editingText = false;
		panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	});

	/** Turn the text into fields, and put the keyboard in the first of them. */
	const editText = async (): Promise<void> => {
		editingText = true;
		await tick();
		titleField?.focus();
		titleField?.select();
	};

	/**
	 * Leave the fields, committing whatever was typed.
	 *
	 * `oncommit` is a no-op unless something is pending, because tabbing through a field nobody typed
	 * in must not rewrite the file with a fresh `updatedAt` (ADR-0010, ADR-0017).
	 */
	const finishText = (): void => {
		oncommit();
		editingText = false;
	};

	/**
	 * The hairline that separates one style group from the one above it.
	 *
	 * A group is a `<fieldset>` with a name of its own, and what makes the names legible is that the
	 * groups are visibly separate — but the *first* group on a card already has the section's own rule
	 * above it, and a second line a few pixels below that reads as a mistake. So the divider belongs to
	 * the boundary rather than to the group, and every group asks whether it is the first.
	 */
	const DIVIDER = 'border-t border-base-300 pt-3';
</script>

<div
	bind:this={panel}
	tabindex="-1"
	class="flex flex-col gap-3 rounded border border-base-300 p-3"
	data-testid="annotation-editor"
	data-annotation-id={annotation.id}
>
	{#if editingText}
		<label class="floating-label">
			<span>Title</span>
			<input
				bind:this={titleField}
				class="input w-full input-sm"
				value={properties.title ?? ''}
				data-testid="annotation-title"
				oninput={(event) => ontext({ title: event.currentTarget.value })}
				onkeydown={(event) => {
					if (event.key === 'Escape') event.currentTarget.blur();
				}}
				onchange={() => oncommit()}
				onblur={() => oncommit()}
			/>
		</label>

		<label class="floating-label">
			<span>Description — Markdown</span>
			<!--
				A plain `<textarea>`, per ADR-0009. Typing coalesces into one write and the edit is
				committed when it *ends*; `oncommit` is a no-op unless something is pending, because
				tabbing through this field must not rewrite the file (ADR-0010).
			-->
			<textarea
				class="textarea w-full font-mono textarea-sm"
				rows="4"
				value={properties.description ?? ''}
				placeholder="*emphasis*, **strong**, and [links](https://example.org/)"
				data-testid="annotation-description"
				oninput={(event) => ontext({ description: event.currentTarget.value })}
				onchange={() => oncommit()}
				onblur={() => oncommit()}></textarea>
		</label>

		<div>
			<button
				type="button"
				class="btn btn-sm"
				data-testid="annotation-text-done"
				onclick={() => finishText()}
			>
				Done
			</button>
		</div>
	{:else}
		<div class="flex items-start gap-2">
			<div class="min-w-0 grow">
				<p class="font-semibold" data-testid="annotation-title-text">
					{#if properties.title}
						{properties.title}
					{:else}
						<span class="font-normal opacity-60">Untitled</span>
					{/if}
				</p>

				<!--
					The description, read rather than previewed. `{@html}` is correct here and only here,
					and only because `renderDescription` returns DOMPurify's own output — the string has
					been through the sanitiser, and there is no path into this expression that has not.
				-->
				<div
					class="prose-sm mt-1 prose max-w-none"
					data-testid="annotation-description-text"
					aria-label="Description"
				>
					{#if rendered === ''}
						<p class="text-sm opacity-60">No description yet.</p>
					{:else}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -->
						{@html rendered}
					{/if}
				</div>
			</div>

			<button
				type="button"
				class="btn btn-square btn-ghost btn-xs"
				data-testid="annotation-edit-text"
				onclick={() => void editText()}
			>
				<Pencil size={14} aria-hidden="true" />
				<span class="sr-only">Edit title and description</span>
			</button>
		</div>
	{/if}

	<!--
		Style, all of it visible, grouped by the part of the drawing each property is about.
		─────────────────────────────────────────────────────────────────────────────────────────────────
		**"More styles" is gone.** The width and the two opacities used to sit behind a `<details>` on
		the grounds that they are measured rather than chosen. It saved three rows and cost the ordering:
		the properties of a line were split across a disclosure, so a scholar setting a line's width had
		its colour off screen, and the thing hidden from a *polygon* was half of its fill. A pin never had
		one at all — its size was the only thing that would have been behind it — so the card's shape
		depended on which shape was selected.
		─────────────────────────────────────────────────────────────────────────────────────────────────
		**The grouping is what does that work now, and it does it better than the disclosure did.** One
		`<fieldset>` per part — Pin, or Fill and Line — each named once, so the labels inside lose the
		prefix they were all carrying ("Line colour", "Line width", "Line opacity" → Colour, Width,
		Opacity). Fill comes before Line on a shape, which is the order every drawing tool uses: the area
		first, then the edge around it.
		─────────────────────────────────────────────────────────────────────────────────────────────────
		The group names reach assistive technology as `<legend>`s, which is what makes two controls both
		labelled "Opacity" unambiguous — the legend is announced with the control (WCAG technique H71), so
		this is the native grouping doing the disambiguating rather than the visible text repeating it.
		They are drawn as a separate `aria-hidden` line rather than by styling the `<legend>` itself,
		which is the pattern this card already used for "Pin size": a `<legend>` in a flex `<fieldset>` is
		still laid out specially by the browser, and a heading that has to fight that is a heading that
		moves when a font does.
	-->
	<fieldset class="flex flex-col gap-3 border-t border-base-300 pt-3">
		<legend class="sr-only">Style</legend>

		{#if isPoint}
			<fieldset class="flex flex-col gap-2">
				<legend class="sr-only">Pin</legend>
				<p class="text-[0.65rem] font-semibold uppercase opacity-70" aria-hidden="true">Pin</p>

				<!--
					**Not debounced, unlike the well it replaced.** An `<input type="color">` fires `input`
					continuously while a user drags around a colour wheel, which is what the debounce was for;
					a swatch is one `change` and one deliberate choice, so the write is committed immediately.
					The same reason the line style and the pin size have never debounced.
				-->
				<div data-own={own('marker-color')}>
					<ColorPicker
						label="Pin colour"
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

				<!--
					The pin's size, and the whole of what a pin has left to set.

					The three sizes are simplestyle's own, offered as a radio group rather than a `<select>`
					for the same reason the line style is: three alternatives, all worth seeing at once. It
					used to carry a fourth option, "Layer's default" — the Layer no longer has one (ADR-0009,
					as amended), and an option naming a thing that is nowhere on the screen is a question a
					scholar cannot answer.

					An unset `marker-size` shows as medium, which is what it draws as: the renderer coalesces
					to medium, so the control reports what is on the map rather than a blank.
				-->
				<fieldset class="flex items-center justify-between gap-2 text-sm">
					<legend class="sr-only">Pin size</legend>
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
					**The three sliders on this card keep their width and so do their readouts.** The row moved
					as the number grew a digit — `1` to `0.5` to `0.05` — and because the value sat in the same
					flex line as the track, the track was squeezed by exactly the amount the number gained: the
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
								onstyle(
									{ 'stroke-opacity': Number(event.currentTarget.value) },
									{ debounce: true }
								)}
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

		{#if geometryKind === null || geometryKind === 'foreign'}
			<p class="text-sm text-warning" data-testid="annotation-not-drawable">
				This Annotation's shape is one this version cannot draw, so it has no style controls. Its
				title and description are still yours to edit, and the shape is written back untouched.
			</p>
		{/if}
	</fieldset>

	<div>
		<button
			type="button"
			class="btn btn-outline btn-error btn-sm"
			data-testid="annotation-delete"
			onclick={() => ondelete()}
		>
			Delete this Annotation
		</button>
	</div>
</div>
