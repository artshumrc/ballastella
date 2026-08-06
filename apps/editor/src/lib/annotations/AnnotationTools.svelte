<script lang="ts">
	// The drawing toolbar (SPEC stories 57, 58, 59).
	//
	// **Ours to build, and ADR-0005 treats that as desirable** rather than as a cost: a teaching tool
	// wants a small curated set of tools, not a generic GIS toolbar. Four buttons, and no more.
	//
	// Every control is a native `<button>` with `aria-pressed`, which is ADR-0016's shape for a toggle,
	// so the whole toolbar is keyboard operable with nothing added. `role="toolbar"` groups them and
	// gives a screen reader the fact that they are one set of alternatives; the active tool is
	// announced through the status region below rather than only drawn, because "which tool am I
	// holding" is otherwise invisible to anyone not looking at the highlight.

	import { toolName, type AnnotationTool } from './drawing.svelte';

	let {
		tool,
		status,
		drawing,
		canFinish,
		disabled = false,
		onchoose,
		onfinish,
		oncancel,
		onundovertex
	}: {
		tool: AnnotationTool;
		/** The gesture in words, for the announced region. */
		status: string;
		drawing: boolean;
		canFinish: boolean;
		/** True when there is no Annotation Layer to draw into, which is a normal first state. */
		disabled?: boolean;
		onchoose: (tool: AnnotationTool) => void;
		onfinish: () => void;
		oncancel: () => void;
		onundovertex: () => void;
	} = $props();

	/** The tools, in the order they are offered. `select` first, because it is the resting state. */
	const TOOLS: { tool: AnnotationTool; hint: string }[] = [
		{ tool: 'select', hint: 'Choose a pin, line, or shape already on the map' },
		{ tool: 'point', hint: 'Place a pin at one place' },
		{ tool: 'line', hint: 'Draw a route or a boundary as a line' },
		{ tool: 'polygon', hint: 'Draw an area as a shape' }
	];
</script>

<div class="flex flex-col gap-2">
	<!--
		`role="toolbar"` with an accessible name, so the four buttons announce as one set of
		alternatives rather than as four unrelated controls. Not `radiogroup`: these are buttons that
		change a mode, and a radio group would promise arrow-key navigation between them that a
		`<button>` set does not have.
	-->
	<div role="toolbar" aria-label="Annotation tools" class="join" data-testid="annotation-tools">
		{#each TOOLS as entry (entry.tool)}
			<button
				type="button"
				class="btn join-item btn-sm"
				class:btn-primary={tool === entry.tool}
				aria-pressed={tool === entry.tool}
				{disabled}
				data-testid="annotation-tool-{entry.tool}"
				title={entry.hint}
				onclick={() => onchoose(entry.tool)}
			>
				{toolName(entry.tool)}
			</button>
		{/each}
	</div>

	<!--
		The active tool and the gesture in progress, announced. `aria-live` rather than `role="status"`,
		because the save indicator already owns that role on this page — the same reason the Layer
		list's move announcement and the pairing prompt are `aria-live` too.

		`data-tool` and `data-vertices` are how the Playwright suite reads the state of the gesture,
		which is a question about the app rather than about the canvas.
	-->
	<p
		class="min-h-6 text-sm opacity-80"
		aria-live="polite"
		aria-atomic="true"
		data-testid="annotation-status"
		data-tool={tool}
		data-drawing={drawing ? 'true' : 'false'}
	>
		{disabled ? 'Add an Annotation Layer to start drawing.' : status}
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
				class="btn btn-primary btn-sm"
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
