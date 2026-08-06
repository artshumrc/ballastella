<script lang="ts">
	// Everything about one Annotation Layer's contents: the toolbar, the Annotations in it, and the
	// selected one's editor (SPEC stories 57–67).
	//
	// The Layer stack above decides *which* Layer is being drawn into; this decides what is in it. They
	// are separate because they answer different questions — the stack is about the Project, and this is
	// about one Layer's content — and because a stack row that expanded into a style editor would make
	// the list unreadable at four Layers.

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
		layers,
		layer,
		collection,
		selectedId,
		tool,
		status,
		drawing,
		canFinish,
		onchooselayer,
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
		/** Every Annotation Layer in the Project, so one can be chosen to draw into. */
		layers: readonly AnnotationLayer[];
		/** The Layer being drawn into, or `null` when the Project has none. */
		layer: AnnotationLayer | null;
		collection: AnnotationCollection | null;
		selectedId: string | null;
		tool: AnnotationTool;
		status: string;
		drawing: boolean;
		canFinish: boolean;
		onchooselayer: (id: string) => void;
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
	<h2 id="annotations-heading" class="text-lg font-semibold">Annotations</h2>

	{#if layers.length === 0}
		<p class="max-w-prose text-sm">
			No Annotation Layers yet. Add one above, and its pins, lines, and shapes will be kept in one
			GeoJSON file that opens in other mapping tools.
		</p>
	{:else}
		<label class="flex items-center gap-2 text-sm">
			<span class="whitespace-nowrap">Drawing into</span>
			<!-- ADR-0016 mandates a native `<select>` for a short list of alternatives. -->
			<select
				class="select w-full select-sm"
				value={layer?.id ?? ''}
				data-testid="annotation-layer-choice"
				onchange={(event) => onchooselayer(event.currentTarget.value)}
			>
				{#each layers as one (one.id)}
					<option value={one.id}>{one.name || 'Untitled Layer'}</option>
				{/each}
			</select>
		</label>
	{/if}

	<AnnotationTools
		{tool}
		{status}
		{drawing}
		{canFinish}
		disabled={layer === null}
		onchoose={onchoosetool}
		{onfinish}
		{oncancel}
		{onundovertex}
	/>

	{#if layer !== null}
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
				<label class="flex items-center justify-between gap-2 text-sm">
					<span>Line and pin colour</span>
					<input
						type="color"
						class="h-8 w-16"
						value={layer.defaultStyle.stroke ?? SIMPLESTYLE_DEFAULTS.stroke}
						data-testid="layer-default-stroke"
						oninput={(event) =>
							onlayerstyle(
								{ ...layer.defaultStyle, stroke: event.currentTarget.value },
								{ debounce: true }
							)}
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
			<p class="text-sm opacity-70" data-testid="annotation-list-empty">
				Nothing in this Layer yet.
			</p>
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
	{/if}
</section>
