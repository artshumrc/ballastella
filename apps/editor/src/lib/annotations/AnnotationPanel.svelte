<script lang="ts">
	// Everything about one Annotation Layer's contents: the toolbar, the Annotations in it, and the
	// selected one's editor (SPEC stories 57–67).
	//
	// The Layer stack above decides *which* Layer is being drawn into; this decides what is in it. They
	// are separate because they answer different questions — the stack is about the Project, and this is
	// about one Layer's content — and because a stack row that expanded into a style editor would make
	// the list unreadable at four Layers.

	import type {
		Annotation,
		AnnotationCollection,
		AnnotationLayer,
		LineStyle
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
		ondelete
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
