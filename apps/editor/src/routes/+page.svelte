<script lang="ts">
	import { page } from '$app/state';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import ProjectView from '$lib/components/ProjectView.svelte';
	import { EditorSession } from '$lib/editor-session.svelte.js';

	// One prerendered page; the Project is selected client-side from `?p=` (ADR-0008). That is
	// what keeps the static adapter honest: no SPA fallback file, no per-Project artefact to
	// rebuild when a Project is renamed or deleted, and a `?p=` URL that is shareable and citable.
	const openDirectory = $derived(page.url.searchParams.get('p'));

	// The store is OPFS, which exists only in the browser, so the session is created after mount
	// rather than at module scope.
	let session = $state<EditorSession | null>(null);

	$effect(() => {
		const created = EditorSession.opfs();
		session = created;
		void created.refresh();
		return created.installFlushOnHide();
	});

	$effect(() => {
		void session?.open(openDirectory);
	});
</script>

<svelte:head><title>Ballastella Editor</title></svelte:head>

<main class="mx-auto max-w-4xl p-8">
	<h1 class="text-3xl font-bold">Ballastella Editor</h1>

	{#if session === null}
		<p class="mt-8">Starting…</p>
	{:else if openDirectory === null}
		<ProjectHub {session} />
	{:else}
		<ProjectView {session} />
	{/if}
</main>
