<script lang="ts">
	import ImageDown from '@lucide/svelte/icons/image-down';

	import MapNotice from './MapNotice.svelte';

	let {
		ready,
		capturing = false,
		captureFailed = false,
		onclick
	}: {
		ready: boolean;
		capturing?: boolean;
		/** Whether the last attempt failed and has not been superseded, which is what is announced. */
		captureFailed?: boolean;
		onclick: () => void;
	} = $props();

	const busy = $derived(!ready || capturing);
</script>

<!-- ⚠ **`pointer-events-none`, restored on the button.** What hangs below is over the map, and a strip of map that cannot be dragged is worse than a sentence that cannot be selected. -->
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

	<!-- **`always-present`, which is why it is rendered with an empty string** rather than inside an `{#if}`: an `aria-live` region speaks when its text changes, and one inserted with its sentence already in… -->
	<MapNotice
		shape="always-present"
		variant="plain"
		class="absolute top-full left-0 mt-1 w-64 text-sm text-warning"
		testid="map-snapshot-failed"
		text={captureFailed ? 'The map snapshot could not be downloaded. Try again.' : ''}
	/>
</div>
