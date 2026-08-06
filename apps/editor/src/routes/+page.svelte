<script lang="ts">
	import { page } from '$app/state';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import ProjectView from '$lib/components/ProjectView.svelte';
	import StorageChoice from '$lib/components/StorageChoice.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	// One prerendered page; the Project is selected client-side from `?p=` (ADR-0008). That is
	// what keeps the static adapter honest: no SPA fallback file, no per-Project artefact to
	// rebuild when a Project is renamed or deleted, and a `?p=` URL that is shareable and citable.
	const openDirectory = $derived(page.url.searchParams.get('p'));

	// Read, never created: the root layout owns the Workspace so that this route and `/base-map/`
	// cannot disagree about which one the user chose. `WorkspaceStorage` owns the session in turn,
	// because moving between OPFS and a folder replaces the session rather than repointing it.
	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	// `open(null)` lists the Projects, so the hub is current whenever it is what is on screen.
	// Listing here rather than after every mutation is what keeps typing a Project name from
	// walking the whole Workspace once per keystroke — a Project with a 2 GB pyramid is tens of
	// thousands of files, and the debounce would otherwise coalesce writes only to be defeated by
	// a read storm. Re-runs when the Workspace moves to another backend, which is a new session.
	$effect(() => {
		void session?.open(openDirectory);
	});
</script>

<svelte:head><title>Ballastella Editor</title></svelte:head>

<main class="mx-auto max-w-4xl p-8">
	<h1 class="text-3xl font-bold">Ballastella Editor</h1>

	{#if host.unsupported}
		<!-- OPFS is missing only in a non-secure context, and the raw DOM failure for that
		     diagnoses nothing. -->
		<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
			<h2 class="font-semibold">No storage for a Workspace</h2>
			<p>{host.unsupported}</p>
		</div>
	{:else if storage === null || session === null}
		<p class="mt-8">Starting…</p>
	{:else if openDirectory === null}
		<StorageChoice {storage} />
		<ProjectHub {session} />
	{:else}
		<ProjectView {session} {storage} />
	{/if}
</main>
