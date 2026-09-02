<script lang="ts">
	// Downloading the map on screen as a Map Snapshot — the one control, rendered by whichever app
	// needs it.
	//
	// Here rather than in either application because both offer it, from the same floating map-control
	// row, with the same two labels. Two copies would be two places for the wording to drift, and the
	// wording is the whole of what a screen-reader user has: the label *is* the state.
	//
	// **A native `<button>` that is genuinely `disabled` while the frame is unfinished**, rather than
	// `aria-disabled` on something still pressable. There is nothing useful a press could do before
	// the frame is complete — the answer would be an image missing the content it was asked for — so
	// leaving the tab order is the honest thing, and it is what ADR-0016 asks for.
	//
	// **No `title`.** The label carries the state in text, in the row, at every width; a tooltip is
	// invisible to a keyboard user and unreachable on a touch screen, and a control whose only
	// account of itself is a tooltip has no account of itself.
	//
	// ⚠ **This is the one place a Map Snapshot's prose lives**, the failure sentence included. The
	// readiness machine in `@ballastella/core` owns the *state*; nothing there composes a sentence, so
	// the two applications cannot describe one outcome two ways.

	import ImageDown from '@lucide/svelte/icons/image-down';

	import MapNotice from './MapNotice.svelte';

	let {
		ready,
		capturing = false,
		captureFailed = false,
		onclick
	}: {
		/**
		 * Whether the frame on screen is complete — `snapshotAvailability(…).state === 'ready'`.
		 *
		 * The caller's judgement, because only the caller knows what the map is still waiting for.
		 */
		ready: boolean;
		/**
		 * Whether a Map Snapshot is being read, encoded or handed to the browser.
		 *
		 * Separate from {@link ready} rather than folded into it by the caller, because they are
		 * different facts about the same control: the frame is complete, and this press is still
		 * running. Collapsing them would make "a second press is refused" untestable — and it is the
		 * rule that stops one gesture producing two downloads.
		 */
		capturing?: boolean;
		/** Whether the last attempt failed and has not been superseded, which is what is announced. */
		captureFailed?: boolean;
		onclick: () => void;
	} = $props();

	/** Nothing to capture yet, or a capture already running. Either way there is nothing to press. */
	const busy = $derived(!ready || capturing);
</script>

<!--
	**The block is the button's own size, and the announcement hangs below it.** Both applications put
	this control in a wrapping row of map controls whose other items are centred on the line, so a
	block that grew by a line would shift every button beside it by half of one — measured at 2 px in
	`e2e/editor-base-map.e2e.ts`, which asserts the row's alignment. The region has to stay in the
	document whether or not it has a sentence (see its own note), so it is taken out of the flow
	instead.

	⚠ **`pointer-events-none`, restored on the button.** What hangs below is over the map, and a strip
	of map that cannot be dragged is worse than a sentence that cannot be selected.
-->
<div class="pointer-events-none relative flex flex-col items-start">
	<button
		type="button"
		class="btn pointer-events-auto btn-sm"
		data-testid="download-map-snapshot"
		disabled={busy}
		{onclick}
	>
		<ImageDown size={16} aria-hidden="true" />
		{busy ? 'Preparing map snapshot…' : 'Download map snapshot'}
	</button>

	<!--
		What a scholar is told when the browser would not produce the file.

		**`always-present`, which is why it is rendered with an empty string** rather than inside an
		`{#if}`: an `aria-live` region speaks when its text changes, and one inserted with its sentence
		already in it is one nobody hears (`MapNotice` carries the whole rule, and ADR-0016's amendment
		the measurement). It is here beside the control rather than beside the map's own notices because
		it is about this press, not about the map — and because both applications mount this component,
		so neither has to remember to put the region somewhere.

		A successful retry empties it again, which is a text change and therefore no announcement of its
		own: the browser's own download feedback is the success notice.
	-->
	<MapNotice
		shape="always-present"
		variant="plain"
		class="absolute top-full left-0 mt-1 w-64 text-sm text-warning"
		testid="map-snapshot-failed"
		text={captureFailed ? 'The map snapshot could not be downloaded. Try again.' : ''}
	/>
</div>
