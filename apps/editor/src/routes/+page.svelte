<script lang="ts">
	import { page } from '$app/state';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import ProjectView from '$lib/components/ProjectView.svelte';
	import StorageChoice from '$lib/components/StorageChoice.svelte';
	import { EditorSession } from '$lib/editor-session.svelte.js';
	import { WorkspaceStorage } from '$lib/workspace-storage.svelte.js';

	// One prerendered page; the Project is selected client-side from `?p=` (ADR-0008). That is
	// what keeps the static adapter honest: no SPA fallback file, no per-Project artefact to
	// rebuild when a Project is renamed or deleted, and a `?p=` URL that is shareable and citable.
	const openDirectory = $derived(page.url.searchParams.get('p'));

	// Storage exists only in the browser, so this is created after mount rather than at module
	// scope. It owns the session, because moving between OPFS and a folder replaces the session
	// rather than repointing it — see `workspace-storage.svelte.ts`.
	let storage = $state<WorkspaceStorage | null>(null);
	const session = $derived(storage?.session ?? null);

	/**
	 * Why this browser cannot hold a Workspace at all, if it cannot. Set in an effect rather than
	 * at component scope because the answer is `false` during prerendering too, where there is no
	 * `navigator.storage` and nothing has gone wrong.
	 */
	let unsupported = $state('');

	$effect(() => {
		// Read into a local rather than back out of the state it just set: an effect that reads the
		// `$state` it writes takes a dependency on itself.
		const reason = EditorSession.unsupportedReason();
		unsupported = reason;
		if (reason) return;
		const created = new WorkspaceStorage();
		storage = created;
		return created.start();
	});

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

	{#if unsupported}
		<!-- OPFS is missing only in a non-secure context, and the raw DOM failure for that
		     diagnoses nothing. -->
		<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
			<h2 class="font-semibold">No storage for a Workspace</h2>
			<p>{unsupported}</p>
		</div>
	{:else if storage === null || session === null}
		<p class="mt-8">Starting…</p>
	{:else if openDirectory === null}
		<StorageChoice {storage} />
		<ProjectHub {session} />
	{:else}
		<ProjectView {session} />
	{/if}
</main>
