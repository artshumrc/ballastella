<script lang="ts">
	// The drawing toolbar (SPEC stories 57, 58, 59).
	//
	// **Ours to build, and ADR-0005 treats that as desirable** rather than as a cost: a teaching tool
	// wants a small curated set of tools, not a generic GIS toolbar.
	//
	// **Selecting is not a tool a user picks; it is what the Layer does when nobody is drawing.** Four
	// equal buttons — Select, Pin, Line, Shape — said the opposite, and read as one set of four
	// alternatives with no hint that the first was about Annotations that exist and the other three
	// about making one that does not. So the resting state is a single "New Annotation" button and
	// selecting behaviour; pressing it reveals the three shapes and a way back out. `select` is still
	// a tool underneath, because the drawing state machine has to have a resting value, but it is no
	// longer something a scholar is asked to choose.
	//
	// Every control is a native `<button>` with `aria-pressed`, which is ADR-0016's shape for a toggle,
	// so the whole toolbar is keyboard operable with nothing added. `role="toolbar"` groups them and
	// gives a screen reader the fact that they are one set of alternatives; the active tool is
	// announced through the status region below rather than only drawn, because "which tool am I
	// holding" is otherwise invisible to anyone not looking at the highlight.

	import { KIND_STYLE } from '@ballastella/ui';
	import Plus from '@lucide/svelte/icons/plus';

	import { toolName, type AnnotationTool } from './drawing.svelte';
	import { TOOL_ICONS } from './shape-icons';

	let {
		tool,
		choosing,
		status,
		drawing,
		canFinish,
		onnew,
		onchoose,
		onfinish,
		oncancel,
		onundovertex
	}: {
		tool: AnnotationTool;
		/**
		 * Whether the shapes are on offer.
		 *
		 * Owned by the pane rather than here, because it decides more than this toolbar: the list of
		 * Annotations is out of the way while somebody is drawing a new one.
		 */
		choosing: boolean;
		/** The gesture in words, for the announced region. */
		status: string;
		drawing: boolean;
		canFinish: boolean;
		/** "New Annotation" was pressed. */
		onnew: () => void;
		onchoose: (tool: AnnotationTool) => void;
		onfinish: () => void;
		oncancel: () => void;
		onundovertex: () => void;
	} = $props();

	/** The shapes that can be drawn. `select` is not among them — it is what happens when none is. */
	const SHAPES: AnnotationTool[] = ['point', 'line', 'polygon'];

	/** Put the tools away and go back to selecting, abandoning a gesture if one is in progress. */
	const stopDrawing = (): void => {
		if (drawing) oncancel();
		onchoose('select');
	};

	/**
	 * What the region below says: **the tool by name**, then the gesture.
	 *
	 * The name is here rather than only in the pressed button because the criterion is that the active
	 * tool is *announced*, and a highlight is not an announcement — nor is `data-tool`, which is a test
	 * attribute and reaches nobody. Each tool's own status line then says what to do with it, which is
	 * where the four per-button `title` tooltips went: CONTRIBUTING is explicit that a tooltip is not an
	 * information channel, and this is text that is both visible and read out.
	 *
	 * **The "no Layer to draw into" announcement is gone because the state is now unreachable, not
	 * because it stopped mattering.** It read "Add an Annotation Layer to start drawing." and rode a
	 * `disabled` prop that `AnnotationPanel` passed as `layer === null`. Since ticket 05 the only
	 * render path to this component is `AnnotationLayerContents`, which `LayerList` renders only from
	 * its `annotationContents` snippet, which it invokes only for a Layer that is both `kind ===
	 * 'annotation'` and open — so `layer` is always a real Annotation Layer and there is no state
	 * left for the sentence to describe. Removing an announcement is otherwise an accessibility
	 * regression (SPEC story 112), so if a second render path is ever added, the `disabled` state and
	 * its sentence have to come back with it.
	 *
	 * What that sentence *also* did — tell a scholar with no Annotation Layer yet what to do about it
	 * — did not go away with it. It is beside the "Add an Annotation Layer" button in
	 * `ProjectScreen.svelte`, which is the affordance it is about.
	 */
	const announcement = $derived(status === '' ? '' : `${toolName(tool)} tool. ${status}`);
</script>

<div class="flex flex-col gap-2">
	<!--
		Resting: one button, which is the whole of what this surface asks of a scholar who is reading
		rather than drawing. Selecting needs no button because it is what clicking a shape on the map
		already does.

		The Annotation Layer's own colour, read from `layer-kind-style.ts` rather than written here —
		the same entry the card's header tint, its toggle and its opacity slider take. The theme
		generator owns what that colour *is* (ADR-0016, ADR-0020) and that one table owns which token it
		is, so a retheme *or* a change of pair moves this button with the card above it instead of
		leaving it a stray hue. The shapes and Finish match it, because they stand in the same place the
		moment it is pressed.
	-->
	{#if !choosing}
		<div>
			<button
				type="button"
				class="btn gap-1 btn-xs {KIND_STYLE.annotation.btn}"
				data-testid="annotation-new"
				onclick={() => onnew()}
			>
				<Plus class="size-4" aria-hidden="true" />
				New Annotation
			</button>
		</div>
	{:else}
		<!--
			`role="toolbar"` with an accessible name, so the buttons announce as one set of alternatives
			rather than as unrelated controls. Not `radiogroup`: these are buttons that change a mode, and
			a radio group would promise arrow-key navigation between them that a `<button>` set does not
			have.

			The glyph goes **beside** each shape's name, never instead of it (SPEC story 111): the words
			stay on the button, so the icon is a second channel rather than the only one. It is the same
			glyph the list of Annotations marks each drawn shape with — one mapping, in `shape-icons.ts`,
			so a scholar learns the pin once and then recognises it in the list.

			Cancel sits outside the group, because it is not a fourth shape.
		-->
		<div class="flex flex-wrap items-center gap-2">
			<div role="toolbar" aria-label="Annotation tools" class="join" data-testid="annotation-tools">
				{#each SHAPES as entry (entry)}
					{@const Icon = TOOL_ICONS[entry]}
					<button
						type="button"
						class={['btn join-item gap-1 btn-xs', tool === entry && KIND_STYLE.annotation.btn]}
						aria-pressed={tool === entry}
						data-testid="annotation-tool-{entry}"
						onclick={() => onchoose(entry)}
					>
						<Icon class="size-4" aria-hidden="true" />
						{toolName(entry)}
					</button>
				{/each}
			</div>

			<button
				type="button"
				class="btn btn-ghost btn-xs"
				data-testid="annotation-tool-cancel"
				onclick={() => stopDrawing()}
			>
				Done
			</button>
		</div>
	{/if}

	<!--
		The active tool and the gesture in progress, announced. `aria-live` rather than `role="status"`,
		because the save indicator already owns that role on this page — the same reason the Layer
		list's move announcement and the pairing prompt are `aria-live` too.

		`data-tool` and `data-drawing` are how the Playwright suite drives the gesture, which is a
		question about the app rather than about the canvas. They are not what carries the tool to a
		user: the sentence does, and the suite asserts that sentence.

		**`sr-only` rather than removed while there is nothing to say.** Selecting announces nothing and
		shows nothing, and it used to hold a `min-h-6` line's worth of empty space open under the
		button — the reserve that stopped the row jumping when a status arrived, paid for on every
		screen that was not mid-gesture. `sr-only` takes it out of the layout (it is absolutely
		positioned, so it does not draw the flex gap either) while keeping the element in the
		accessibility tree, which is what `aria-live` needs: it announces a change of text in a region
		that is *already there*, so an element that came and went would announce nothing at all.
	-->
	<p
		class={announcement === '' ? 'sr-only' : 'text-sm opacity-80'}
		aria-live="polite"
		aria-atomic="true"
		data-testid="annotation-status"
		data-tool={tool}
		data-drawing={drawing ? 'true' : 'false'}
	>
		{announcement}
	</p>

	{#if drawing}
		<!--
			The gesture's own controls, present only while there is a gesture — so "Finish" is never a
			button that does nothing. Escape does the same as Cancel from anywhere on the page; this is
			the visible, pointer-reachable half of that, which ADR-0016 asks for whenever a keystroke is
			the only route.
		-->
		<div class="flex flex-wrap gap-2">
			<button
				type="button"
				class="btn btn-sm {KIND_STYLE.annotation.btn}"
				disabled={!canFinish}
				data-testid="annotation-finish"
				onclick={() => onfinish()}
			>
				Finish
			</button>
			<button
				type="button"
				class="btn btn-sm"
				data-testid="annotation-undo-vertex"
				onclick={() => onundovertex()}
			>
				Undo last point
			</button>
			<button
				type="button"
				class="btn btn-ghost btn-sm"
				data-testid="annotation-cancel"
				onclick={() => oncancel()}
			>
				Cancel
			</button>
		</div>
	{/if}
</div>
