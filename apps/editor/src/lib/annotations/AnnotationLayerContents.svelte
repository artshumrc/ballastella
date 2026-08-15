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
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────────
	// WHAT IS SHARED WITH A PUBLISHED SITE, AND WHAT IS THIS APP'S ALONE
	//
	// The list, the row and the disclosure it opens are `@ballastella/ui`'s: a Reader meets the same
	// rows in the same order, opening the same way, and the mechanics exist once. What stays here is
	// what only an author can do — the drawing tools, the place search, and the editor that an open
	// row reveals — and it is handed over as the two snippets `AnnotationList` takes.
	//
	// ⚠ **`AnnotationTools` and `PlaceSearch` must not become reachable from a published site.**
	// `PlaceSearch` calls the place lookup service, and a Published Site quietly issuing lookups for a
	// Reader who did not ask is the outcome ADR-0029 is written against; `AnnotationTools` is the
	// drawing surface. Both are rendered from *this* app's `tools` snippet, which the viewer does not
	// pass — there is no `readOnly` prop and no `mode` prop to get wrong.

	import {
		type Annotation,
		type AnnotationCollection,
		type LineStyle,
		type Place
	} from '@ballastella/core';
	import { AnnotationList, AnnotationRow } from '@ballastella/ui';

	import PlaceSearch from '$lib/places/PlaceSearch.svelte';

	import AnnotationEditor from './AnnotationEditor.svelte';
	import AnnotationTools from './AnnotationTools.svelte';
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

	/**
	 * The one Annotation that stays on screen while a tool is armed: the selected one, if there is
	 * one.
	 *
	 * There can only be one, and it can only have just been made. "New Annotation" deselects, so
	 * arriving here with a selection means a shape was drawn on the map or a Place was pinned since
	 * the tools came out — which is exactly the Annotation somebody is about to title.
	 */
	const drawn = $derived(
		choosing ? (annotations.find((annotation) => annotation.id === selectedId) ?? null) : null
	);
</script>

<!--
	The drawing surface and the place search: this app's alone, and the whole of what a published site
	is not handed.
-->
{#snippet tools()}
	<AnnotationTools
		{tool}
		{choosing}
		{status}
		{drawing}
		{canFinish}
		onnew={() => {
			picking = true;
			// **"New Annotation" collapses whatever row was open**, and deselecting is what does it: the
			// open row is the selected Annotation, so there is one thing to say rather than two. It is
			// also what the gesture means — a new Annotation is not an edit to the old one — and it is
			// why the row that was open cannot survive into the moment the next shape is drawn, when the
			// panel under the pointer would be the wrong Annotation's.
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
{/snippet}

<!--
	What an open row reveals here: the Annotation itself, with everything an author can change about
	it. A Reader's row reveals `AnnotationReading` instead, which is the same row saying less.
-->
{#snippet contents(annotation: Annotation)}
	<AnnotationEditor {annotation} {ontext} {oncommit} {onstyle} {onlinestyle} {ondelete} />
{/snippet}

{#if choosing}
	<!--
		**The list stands aside while a shape is armed, but what has just been made does not.** The list
		is not hidden to save space: it is the answer to "what is already in this Layer", and somebody
		who has just pressed "New Annotation" is asking the opposite question. It is back as soon as
		they are done.

		⚠ **The Annotation just drawn is the exception, and leaving it out was a regression.** The
		editor used to sit outside this branch, so it stayed on screen while the list stepped aside;
		moving it into the row moved it behind the same curtain. Drawing does not disarm the tool —
		that is deliberate, so three pins in a row are three clicks on the map — so a scholar who drew a
		shape and wanted to title it had to press "Done" first, and titling a shape straight after
		drawing it is the point of drawing it. So the tools are followed by that one row, open, with
		its editor inside it, and the rest of the list stays away.

		**One row rather than a list of one**, which is why this branch renders `AnnotationRow` itself
		rather than handing `AnnotationList` a collection of one: what is on screen is not "the
		Annotations in this Layer" and must not be captioned or counted as though it were. The row and
		its disclosure are still the shared ones, so nothing about how it opens can differ from the
		list's. Its `index` is its place in the *collection*, so an untitled shape reads as the same
		"Untitled pin 3" here as it does in the list a moment later.
	-->
	<section aria-label="Annotations" class="flex flex-col gap-3">
		{@render tools()}

		{#if drawn}
			<ol
				class="menu w-full gap-0 overflow-hidden menu-sm rounded-lg border border-base-300 p-0"
				aria-label="The new Annotation"
				data-testid="annotation-drawn"
			>
				<AnnotationRow
					annotation={drawn}
					index={annotations.indexOf(drawn)}
					open
					onopen={onselect}
					{contents}
				/>
			</ol>
		{/if}
	</section>
{:else}
	<AnnotationList {annotations} openId={selectedId} onopen={onselect} {contents} {tools} />
{/if}
