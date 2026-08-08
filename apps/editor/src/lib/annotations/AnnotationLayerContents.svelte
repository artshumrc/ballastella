<script lang="ts">
	// Everything inside one Annotation Layer: the toolbar, the Annotations in it, and the selected
	// one's editor (SPEC stories 57–67).
	//
	// **Rendered inside that Layer's own open row** (ticket 05), which is what removed the thing this
	// file used to begin with: a `<select>` labelled "Drawing into". Which Layer is open and which
	// Layer is drawn into were two values that could disagree — a user could open one Layer's row and
	// then draw into another — and they are now one. The open Layer *is* the chosen Layer, so there is
	// nothing left to pick, and this component is handed the Layer rather than a list to choose from.
	//
	// Only one row is open at a time, so exactly one of these exists on the screen. That is what lets
	// the heading and the list carry fixed ids and fixed accessible names.
	//
	// The {@link layer} this is handed is the screen's `activeLayer` — both are `openLayerId` — so the
	// collection, the selection and every write function passed in are about the Layer named in the
	// prop and there is no second answer available. That is why `layer` is not nullable here and was
	// before: a `null` Layer used to mean "the Project has no Annotation Layer", which this component
	// can no longer be rendered in.

	import {
		LINE_STYLES,
		SIMPLESTYLE_DEFAULTS,
		dashArrayFor,
		lineStyleOf,
		type Annotation,
		type AnnotationCollection,
		type AnnotationLayer,
		type LineStyle,
		type SimpleStyle
	} from '@ballastella/core';

	import AnnotationEditor from './AnnotationEditor.svelte';
	import AnnotationTools from './AnnotationTools.svelte';
	import type { AnnotationTool } from './drawing.svelte';

	let {
		layer,
		collection,
		selectedId,
		tool,
		status,
		drawing,
		canFinish,
		onchoosetool,
		onfinish,
		oncancel,
		onundovertex,
		onselect,
		ontext,
		oncommit,
		onstyle,
		onlinestyle,
		ondelete,
		onlayerstyle
	}: {
		/** The open Layer, which is by definition the one being drawn into (ticket 05). */
		layer: AnnotationLayer;
		collection: AnnotationCollection | null;
		selectedId: string | null;
		tool: AnnotationTool;
		status: string;
		drawing: boolean;
		canFinish: boolean;
		onchoosetool: (tool: AnnotationTool) => void;
		onfinish: () => void;
		oncancel: () => void;
		onundovertex: () => void;
		onselect: (id: string | null) => void;
		ontext: (text: { title?: string; description?: string }) => void;
		oncommit: () => void;
		onstyle: (style: Record<string, unknown>, options?: { debounce?: boolean }) => void;
		onlinestyle: (line: LineStyle) => void;
		ondelete: () => void;
		/**
		 * Change the **Layer's** default style, which every Annotation in it that says nothing of its own
		 * takes (ADR-0002, ADR-0009).
		 *
		 * This is what makes precedence worth having rather than merely correct: it is how a whole Layer
		 * is restyled in one action, which is the reason ADR-0009 forbids stamping defaults onto each
		 * feature at creation time. It lives on the Layer in `project.json`, never in the GeoJSON.
		 */
		onlayerstyle: (style: SimpleStyle, options?: { debounce?: boolean }) => void;
	} = $props();

	const annotations = $derived<readonly Annotation[]>(collection?.annotations ?? []);
	const selected = $derived(annotations.find((one) => one.id === selectedId) ?? null);

	/**
	 * How one Annotation reads in the list.
	 *
	 * Its title, which is **the user's own words and therefore untrusted text** — this is one of the
	 * three places a stranger's `title` or `description` reaches the screen, alongside the map popup
	 * and the description preview. It is safe here for a different reason from the other two: Svelte
	 * interpolates it as text, so the DOM never parses it as markup. Nothing may turn this into
	 * `{@html}`; a title that needs rendering is one that needs `renderAnnotationPopup`.
	 */
	const describe = (annotation: Annotation, index: number): string => {
		const title = annotation.properties.title;
		if (title !== undefined && title !== '') return title;
		return `Untitled ${shapeWord(annotation)} ${index + 1}`;
	};

	const shapeWord = (annotation: Annotation): string => {
		switch (annotation.geometry?.type) {
			case 'Point':
				return 'pin';
			case 'LineString':
				return 'line';
			case 'Polygon':
				return 'shape';
			default:
				return 'Annotation';
		}
	};
</script>

<section aria-labelledby="annotations-heading" class="flex flex-col gap-3">
	<!--
		`<h3>`, because this sits inside a Layer row, inside the `<ol>`, under the stack's own `<h2>`.
		The Layer's name is not repeated in it: the row's name field is a few pixels above and says it.
	-->
	<h3 id="annotations-heading" class="font-semibold">Annotations</h3>

	<AnnotationTools
		{tool}
		{status}
		{drawing}
		{canFinish}
		onchoose={onchoosetool}
		{onfinish}
		{oncancel}
		{onundovertex}
	/>

	<!--
		The Layer's own default style. Two controls only — a colour and a line style — because this is
		the bulk-restyle affordance rather than a second full style editor: it exists so that "make every
		conjectural route in this Layer dashed" is one action, which is the whole reason ADR-0009 keeps
		defaults off the features. Anything an Annotation sets for itself still wins (precedence is
		resolved in `core`, once, for both apps).
	-->
	<fieldset class="rounded border border-base-300 p-3">
		<legend class="px-1 text-sm font-semibold">This Layer's default style</legend>
		<div class="flex flex-col gap-2">
			<!--
				One control writing **two** simplestyle properties, because a pin's colour is not a line's.
				`marker-color` is what paints a pin and `stroke` is what paints a line, an outline, and a
				pin's own thin ring — so a control labelled "Line and pin colour" that wrote `stroke` alone
				left every pin at simplestyle's grey `#7e7e7e` and contradicted its own label. Two separate
				controls are the alternative and are what the per-Annotation editor has; here they would
				make the bulk affordance two actions where "make this Layer's Annotations blue" is one.
				Anything an Annotation sets for itself still wins, per property (ADR-0009) — so the pin
				whose own colour differs from the Layer's still shows its 1px `stroke` ring, and a pin
				taking the Layer's default draws that ring in its own colour and so has none to see.

				The swatch shows `stroke`, because this control writes the two together and is the only
				thing in the app that sets either on a Layer. A `defaultStyle` that arrived from somewhere
				else with only `marker-color` therefore shows the line colour until this is used, which
				then makes them agree.
			-->
			<label class="flex items-center justify-between gap-2 text-sm">
				<span>Line and pin colour</span>
				<input
					type="color"
					class="h-8 w-16"
					value={layer.defaultStyle.stroke ?? SIMPLESTYLE_DEFAULTS.stroke}
					data-testid="layer-default-stroke"
					oninput={(event) => {
						const colour = event.currentTarget.value;
						onlayerstyle(
							{ ...layer.defaultStyle, stroke: colour, 'marker-color': colour },
							{ debounce: true }
						);
					}}
					onchange={() => oncommit()}
				/>
			</label>

			<label class="flex items-center justify-between gap-2 text-sm">
				<span>Line style</span>
				<select
					class="select select-sm"
					value={lineStyleOf(layer.defaultStyle['stroke-dasharray'])}
					data-testid="layer-default-line-style"
					onchange={(event) => {
						const dash = dashArrayFor(event.currentTarget.value as LineStyle);
						// Solid is the property being **absent**, so it is deleted rather than set to
						// something that looks continuous (ADR-0009) — the same rule the per-Annotation
						// control follows.
						const rest = Object.fromEntries(
							Object.entries(layer.defaultStyle).filter(([key]) => key !== 'stroke-dasharray')
						) as SimpleStyle;
						onlayerstyle(dash === undefined ? rest : { ...rest, 'stroke-dasharray': dash });
					}}
				>
					{#each LINE_STYLES as style (style)}
						<option value={style}>{style}</option>
					{/each}
				</select>
			</label>
		</div>
	</fieldset>

	{#if annotations.length === 0}
		<p class="text-sm opacity-70" data-testid="annotation-list-empty">Nothing in this Layer yet.</p>
	{:else}
		<!--
			An `<ol>`, so the list's structure reaches assistive technology from the markup. Each row is
			a `<button>` with `aria-pressed`, which is ADR-0016's shape for a selection toggle and what
			makes the list operable by keyboard with nothing added.
		-->
		<ol
			class="flex flex-col gap-1"
			aria-label="Annotations in this Layer"
			data-testid="annotation-list"
		>
			{#each annotations as annotation, index (annotation.id)}
				<li>
					<button
						type="button"
						class="btn w-full justify-start btn-ghost btn-sm"
						class:btn-active={annotation.id === selectedId}
						aria-pressed={annotation.id === selectedId}
						data-testid="annotation-row"
						data-annotation-id={annotation.id}
						onclick={() => onselect(annotation.id === selectedId ? null : annotation.id)}
					>
						<span class="opacity-60">{shapeWord(annotation)}</span>
						<span class="truncate" data-testid="annotation-row-name">
							{describe(annotation, index)}
						</span>
					</button>
				</li>
			{/each}
		</ol>
	{/if}

	{#if selected !== null}
		<AnnotationEditor
			annotation={selected}
			layerDefault={layer.defaultStyle}
			{ontext}
			{oncommit}
			{onstyle}
			{onlinestyle}
			{ondelete}
		/>
	{/if}
</section>
