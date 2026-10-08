<script lang="ts">
	// Unwarped sheet via triiiceratops/svelte component, never the web component.

	import { TriiiceratopsViewer } from 'triiiceratops/svelte';
	import 'triiiceratops/style.css';

	import { themeScheme } from '@ballastella/core';
	import { theme } from '$lib/theme.svelte';

	let {
		label,
		manifestId,
		manifest,
		onclose
	}: {
		label: string;
		/** Cache key: viewer only loads when manifestId and manifestJson are both set. */
		manifestId: string;
		manifest: unknown;
		onclose?: () => void;
	} = $props();

	/** triiiceratops failure, surfaced: its blank rectangle has no console on a Published Site. */
	let viewerError = $state('');
</script>

<section class="mt-4" data-testid="unwarped-view" aria-labelledby="unwarped-heading">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 id="unwarped-heading" class="text-lg font-semibold">{label}</h2>
		{#if onclose}
			<button class="btn btn-sm" type="button" data-testid="unwarped-close" onclick={onclose}>
				Back to the map
			</button>
		{/if}
	</div>
	<p class="mt-1 max-w-prose text-sm opacity-70">
		Read as a document: the sheet unwarped, so its cartouche and inscriptions are legible.
	</p>

	<!-- Definite height: triiiceratops root is height:100%, min-h lays out at 0px. -->
	<div class="mt-3 h-[24rem] overflow-hidden rounded-box border border-base-300 sm:h-[32rem]">
		<!-- Single theme signal drives the embedded viewer. -->
		<TriiiceratopsViewer
			{manifestId}
			manifestJson={manifest}
			theme={themeScheme(theme.current)}
			onviewererror={(error) => (viewerError = error.message || 'This image could not be shown.')}
		/>
	</div>

	{#if viewerError}
		<div role="alert" class="mt-3 alert max-w-prose alert-warning">
			<p data-testid="unwarped-error">
				This Map Image could not be shown: {viewerError}
			</p>
		</div>
	{/if}
</section>
