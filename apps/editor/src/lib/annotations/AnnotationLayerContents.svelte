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
	// The collection, the selection and every write function passed in are about the open Layer, and
	// there is no second answer available. **The Layer itself is no longer among them**: it was here
	// for its `defaultStyle`, and a Layer no longer has one (ADR-0009, as amended) — style lives on
	// each Annotation, put there when it is drawn.

	import {
		type Annotation,
		type AnnotationCollection,
		type LineStyle,
		type Place
	} from '@ballastella/core';

	import { KIND_STYLE } from '$lib/layers/layer-kind-style';
	import PlaceSearch from '$lib/places/PlaceSearch.svelte';

	import AnnotationEditor from './AnnotationEditor.svelte';
	import AnnotationTools from './AnnotationTools.svelte';
	import { iconForGeometry } from './shape-icons';
	import type { AnnotationTool } from './drawing.svelte';

	let {
		collection,
		selectedId,
		tool,
		status,
		drawing,
		canFinish,
		onchoosetool,
		onplace,
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
		collection: AnnotationCollection | null;
		selectedId: string | null;
		tool: AnnotationTool;
		status: string;
		drawing: boolean;
		canFinish: boolean;
		onchoosetool: (tool: AnnotationTool) => void;
		/**
		 * A Place was chosen: frame the map on it and drop a Pin there, titled `query`.
		 *
		 * Both halves are the page's, because framing is the map pane's business and the Pin is a write.
		 */
		onplace: (place: Place, query: string) => void;
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

	/**
	 * Whether the shapes are on offer — "New Annotation" has been pressed, or a tool is armed.
	 *
	 * Held here rather than in the toolbar because it decides more than the toolbar: **the list of
	 * Annotations is out of the way while a new one is being drawn.** Somebody who has just said "new"
	 * is looking at the map, and a list of what is already in the Layer is the thing they are not
	 * doing. It comes back the moment they are done.
	 *
	 * `picking` is only the gap the tool cannot describe: pressed, but no shape chosen yet. Once one
	 * is, the armed tool holds the state on its own, so drawing three pins in a row is three clicks on
	 * the map rather than three trips through the button.
	 */
	let picking = $state(false);
	const choosing = $derived(picking || tool !== 'select');
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

<!--
	Named by `aria-label` rather than by a heading of its own. The card this renders inside already
	says "Annotations" in its header — the one line that stays visible when the card is collapsed —
	so a `<h3>` here put the same word on the screen twice, a few pixels apart, saying nothing the
	first one had not. The name still reaches assistive technology, which is what the heading was
	carrying; only the duplicated pixels went.
-->
<section aria-label="Annotations" class="flex flex-col gap-3">
	<AnnotationTools
		{tool}
		{choosing}
		{status}
		{drawing}
		{canFinish}
		onnew={() => {
			picking = true;
			// **"New Annotation" closes whatever was open.** The editor is not part of the list, so it
			// stayed on screen while the list stepped aside — a panel titled "The west quay" sitting
			// directly under the shape buttons, which reads as the thing about to be drawn and is not. It
			// is the same panel the shape that gets drawn will appear in, a few pixels from where the
			// pointer is, so the two were as close to indistinguishable as the interface can make them.
			// Deselecting is also what the gesture means: a new Annotation is not an edit to the old one.
			onselect(null);
		}}
		onchoose={(chosen) => {
			if (chosen === 'select') picking = false;
			onchoosetool(chosen);
		}}
		{onfinish}
		{oncancel}
		{onundovertex}
	/>

	<!--
		Looking a place up and dropping a Pin on it, **beside the drawing tools** (ADR-0029). That is
		structural rather than aesthetic: `LayerList` invokes its `annotationContents` snippet only for
		a Layer that is both an Annotation Layer and open, so a control here inherits "there is always a
		Layer to draw into" for free. Anywhere else it would have to answer "which Layer does this Pin
		go into?", which has no good answer when a Project has zero Annotation Layers, or three.

		**The same component the Base Map pane draws over the map**, which is what makes the candidate
		list, the attribution, the four outcomes and the keyboard reach of all of them one implementation
		rather than two. The whole of this surface's difference is `onchoose` — and its name, because
		both are on screen at once and only this one writes to the scholar's file.
	-->
	<PlaceSearch
		testid="annotation-place-search"
		label="Find a place and pin it"
		onchoose={onplace}
	/>

	{#if choosing}
		<!--
			Nothing here while a new Annotation is being drawn. The list is not hidden to save space: it
			is the answer to "what is already in this Layer", and somebody who has just pressed "New
			Annotation" is asking the opposite question. What they draw appears in its own editor below,
			and the list is back as soon as they are done.
		-->
	{:else if annotations.length === 0}
		<p class="text-sm opacity-70" data-testid="annotation-list-empty">Nothing in this Layer yet.</p>
	{:else}
		<!--
			**Outlined, headed and divided, because it did not read as a list.** Ghost buttons in a gap-1
			column are the shape a toolbar has: nothing said where the Annotations began, where they
			ended, or that the rows were siblings rather than four unrelated controls stacked in a
			sidebar. The box draws the edge, the caption says what is inside it and how many, and the
			hairlines between rows are what make them read as items of one thing.

			daisyUI's own `menu`, which is the component for a list of choices — ADR-0016 mandates no
			method for a list, and reaching for `menu` rather than restyling `btn` keeps the hover, focus
			and active states the theme already defines. Still an `<ol>`, so the structure reaches
			assistive technology from the markup rather than from the class; still a `<button>` per row
			with `aria-pressed`, which is ADR-0016's shape for a selection toggle and what makes the list
			operable by keyboard with nothing added.
		-->
		<div class="overflow-hidden rounded-lg border border-base-300">
			<p
				class="border-b border-base-300 bg-base-200 px-3 py-1 text-[0.65rem] font-semibold uppercase opacity-70"
				id="annotation-list-caption"
			>
				{annotations.length}
				{annotations.length === 1 ? 'Annotation' : 'Annotations'}
			</p>

			<ol
				class="menu w-full gap-0 menu-sm p-0"
				aria-labelledby="annotation-list-caption"
				data-testid="annotation-list"
			>
				{#each annotations as annotation, index (annotation.id)}
					{@const Icon = iconForGeometry(annotation.geometry?.type)}
					{@const chosen = annotation.id === selectedId}
					<li class="border-b border-base-200 last:border-b-0">
						<!--
							**The chosen row is marked by the Annotation Layer's own wash, and nothing else.**
							`KIND_STYLE.annotation.tint` is the same 10% the card's header wears, from the one table
							every colour in this card comes from (`layer-kind-style.ts`).

							It was `border-primary` with daisyUI's `menu-active`, which is two colours making two
							claims: `primary` is the *app's* action colour, reserved for the controls outside the
							Layer cards, and `menu-active` paints `base-content` — near-black in the light theme —
							so a blue rule sat against a black slab in a card whose every other control is `info`.
							Reported as clashing, and it was: nothing about either colour said "this belongs to the
							Annotations".

							**The rule down the left edge went with them.** It was the third mark on a row that
							needed one, in a column that already draws a hairline between every row and a border
							around the whole list — a fourth vertical line, two pixels from the box's own. The wash
							alone says which row it is, and it is a wash rather than a fill for a reason: at 10%
							over `base-100` the row's text stays on the colour it was already legible on, where a
							`base-content` slab has to re-solve its own contrast and then repaint the text to win.

							Colour is not the only channel (SPEC story 111): the name goes semibold, which survives
							a monochrome screen, and `aria-pressed` is what carries the state to a screen reader.
						-->
						<button
							type="button"
							class={[
								'flex w-full items-center gap-2 rounded-none py-2',
								chosen && `font-semibold ${KIND_STYLE.annotation.tint}`
							]}
							aria-pressed={chosen}
							data-testid="annotation-row"
							data-annotation-id={annotation.id}
							onclick={() => onselect(chosen ? null : annotation.id)}
						>
							<!--
								The same glyph the tool that drew it carries, and **beside the word rather than
								instead of it** (SPEC story 111) — the word is what a screen reader reads and what a
								glyph alone would have taken away.
							-->
							<Icon class="size-4 shrink-0 opacity-60" aria-hidden="true" />
							<span class="shrink-0 text-xs opacity-60">{shapeWord(annotation)}</span>
							<span class="truncate" data-testid="annotation-row-name">
								{describe(annotation, index)}
							</span>
						</button>
					</li>
				{/each}
			</ol>
		</div>
	{/if}

	{#if selected !== null}
		<AnnotationEditor
			annotation={selected}
			{ontext}
			{oncommit}
			{onstyle}
			{onlinestyle}
			{ondelete}
		/>
	{/if}
</section>
