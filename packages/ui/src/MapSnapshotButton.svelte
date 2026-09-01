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

	import ImageDown from '@lucide/svelte/icons/image-down';

	let {
		ready,
		onclick
	}: {
		/**
		 * Whether the frame on screen is complete and nothing else is being captured.
		 *
		 * The caller's judgement, because only the caller knows what the map is still waiting for.
		 */
		ready: boolean;
		onclick: () => void;
	} = $props();
</script>

<button
	type="button"
	class="btn btn-sm"
	data-testid="download-map-snapshot"
	disabled={!ready}
	{onclick}
>
	<ImageDown size={16} aria-hidden="true" />
	{ready ? 'Download map snapshot' : 'Preparing map snapshot…'}
</button>
