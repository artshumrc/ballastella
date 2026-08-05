<script lang="ts">
	import { baseMapFallbackNotice, otherTheme, resolveBaseMap } from '@ballastella/core';
	import { onMount } from 'svelte';

	import BaseMapPane from '$lib/base-map/BaseMapPane.svelte';
	import BaseMapSwitcher from '$lib/base-map/BaseMapSwitcher.svelte';
	import { OpfsProjectDefaultBaseMap } from '$lib/base-map/project-base-map.js';
	import { theme, startTheme } from '$lib/theme.svelte';

	/**
	 * SEAM WITH TICKET 02. A Project is addressed in the URL by query parameter (ADR-0008), and
	 * ticket 02 owns creating and listing them. Until then this page falls back to one well-known
	 * directory so that "the author's default survives reopening the Project" is a real assertion
	 * about a real file rather than about a variable.
	 */
	const DEFAULT_PROJECT_DIRECTORY = 'demo-project';

	let projectDirectory = $state(DEFAULT_PROJECT_DIRECTORY);
	let store = $state<OpfsProjectDefaultBaseMap | undefined>(undefined);

	let entryId = $state<string | undefined>(undefined);
	let notice = $state<string | null>(null);

	onMount(() => {
		startTheme();
		projectDirectory =
			new URL(window.location.href).searchParams.get('p') ?? DEFAULT_PROJECT_DIRECTORY;
		const opened = new OpfsProjectDefaultBaseMap(projectDirectory);
		store = opened;

		void (async () => {
			// An id this deployment does not carry falls back to the deployment default and says so
			// (ADR-0020). It must not throw and must not render a blank map, because a Base Map that
			// fails to resolve otherwise renders a plausible-looking but *wrong* map.
			const resolution = resolveBaseMap(await opened.read());
			notice = baseMapFallbackNotice(resolution);
			entryId = resolution.entry.id;
		})();
	});

	function select(id: string): void {
		entryId = id;
		notice = null;
		// The author sets the default; `project.json` records the id and nothing else (ADR-0020).
		void store?.write(id);
	}
</script>

<svelte:head><title>Base Map — Ballastella Editor</title></svelte:head>

<div class="flex h-screen flex-col">
	<header class="flex flex-wrap items-end gap-4 border-b border-base-300 bg-base-200 p-4">
		<h1 class="text-xl font-bold">Base Map</h1>

		{#if entryId !== undefined}
			<div class="flex flex-col">
				<BaseMapSwitcher {entryId} onSelect={select} />
			</div>
		{/if}

		<!--
			One signal, one control. Clicking this repaints the interface and reselects the Protomaps
			flavor in the same action — see `$lib/theme.svelte.ts` and ADR-0016.
		-->
		<button type="button" class="btn btn-sm" onclick={() => theme.toggle()}>
			Switch to {otherTheme(theme.current)} theme
		</button>

		<p class="grow text-sm text-base-content/70" role="status" aria-live="polite">
			{notice ?? ''}
		</p>
	</header>

	<div class="relative grow">
		{#if entryId === undefined}
			<p class="p-4">Opening Project “{projectDirectory}”…</p>
		{:else}
			<BaseMapPane {entryId} />
		{/if}
	</div>
</div>
