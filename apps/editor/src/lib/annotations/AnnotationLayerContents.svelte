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
	import { AnnotationList } from '@ballastella/ui';

	import PlaceSearch from '$lib/places/PlaceSearch.svelte';

	import AnnotationEditor from './AnnotationEditor.svelte';
	import AnnotationTools from './AnnotationTools.svelte';
	import type { AnnotationTool } from './drawing.svelte';

	let {
		collection,
		selectedId,
		titlingId,
		tool,
		picking,
		status,
		drawing,
		canFinish,
		onnew,
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
		/** The Annotation just drawn, whose title is what the keyboard should be in. */
		titlingId: string | null;
		tool: AnnotationTool;
		/** Whether the three shapes are on offer. The drawing state's, because it ends the gesture. */
		picking: boolean;
		status: string;
		drawing: boolean;
		canFinish: boolean;
		/** "New Annotation" was pressed: offer the shapes. */
		onnew: () => void;
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
</script>

<!--
	The drawing surface and the place search: this app's alone, and the whole of what a published site
	is not handed.
-->
{#snippet tools()}
	<AnnotationTools
		{tool}
		{picking}
		{status}
		{drawing}
		{canFinish}
		onnew={() => {
			onnew();
			// **"New Annotation" collapses whatever row was open**, and deselecting is what does it: the
			// open row is the selected Annotation, so there is one thing to say rather than two. It is
			// also what the gesture means — a new Annotation is not an edit to the old one — and it is
			// why the row that was open cannot survive into the moment the next shape is drawn, when the
			// panel under the pointer would be the wrong Annotation's.
			onselect(null);
		}}
		onchoose={onchoosetool}
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
	<AnnotationEditor
		{annotation}
		titling={annotation.id === titlingId}
		{ontext}
		{oncommit}
		{onstyle}
		{onlinestyle}
		{ondelete}
	/>
{/snippet}

{#snippet noAnnotationsGuidance()}
	<!--
		What an empty Annotation Layer tells a scholar, and **it names the button that is actually
		there** — "New Annotation" is the word on the control above this sentence, not a description of
		it.

		**Here rather than in `AnnotationList`, for the reason `noLayersGuidance` is in this app**: a
		published site renders the same list and has no drawing tools, so "yet" there promised a Reader
		something that can never happen in a Layer nobody can add to. `AnnotationList` keeps the half
		that is true in both apps — that the Layer is empty — and this is the half that is only true
		where there is something to draw with.
	-->
	Nothing in this Layer yet. Press <strong>New Annotation</strong> and draw one on the map.
{/snippet}

<!--
	**One list, on screen throughout** (the-annotation-inspector stories 11, 36) — while the shapes are
	on offer, while a shape is being drawn, and at rest. Hiding the answer to "what is already in this
	Layer" is no service to somebody who is adding to it, and there is no drawing mode for the list to
	step aside for: a gesture ends by itself, so nothing can hold the screen.

	This is also why the freshly drawn Annotation needs nothing of its own here. It is a row in this
	list, selected, with `titlingId` naming it as the one whose title is a field — captioned and counted
	alongside the rest, because that is where it is.
-->
<AnnotationList
	{annotations}
	openId={selectedId}
	onopen={onselect}
	{contents}
	{tools}
	{noAnnotationsGuidance}
/>
