<script lang="ts">
	import { page } from '$app/state';
	import ProjectHub from '$lib/components/ProjectHub.svelte';
	import StorageChoice from '$lib/components/StorageChoice.svelte';
	import ProjectScreen from '$lib/project/ProjectScreen.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	// One prerendered page; the Project is selected client-side from `?p=` (ADR-0008). That is
	// what keeps the static adapter honest: no SPA fallback file, no per-Project artefact to
	// rebuild when a Project is renamed or deleted, and a `?p=` URL that is shareable and citable.
	//
	// **This one route is now both screens** (ticket 04): with no `?p=` it is the hub, and with one
	// it is the Project — a Base Map with the Layer stack beside it. `/layers/` and `/base-map/`
	// were the other two thirds of the Project and are gone; there is nowhere else to be.
	const openDirectory = $derived(page.url.searchParams.get('p'));

	// Read, never created: the root layout owns the Workspace so that no two routes can disagree
	// about which one the user chose. `WorkspaceStorage` owns the session in turn,
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

	/**
	 * The hub, or the Project by name. Falls back to the folder until `project.json` is read.
	 *
	 * **The `session` guard is load-bearing, not defensive.** SvelteKit throws on
	 * `url.searchParams` while prerendering — a query parameter cannot be baked into a static file
	 * (ADR-0008) — and `<svelte:head>` is rendered on the server, so reading `openDirectory` here
	 * unconditionally fails the build with `500 /`. `session` is `null` until the layout's effect has
	 * run, which is exactly the "not in a browser yet" condition, and every other read of
	 * `openDirectory` on this page is already inside that same guard.
	 */
	const pageTitle = $derived.by(() => {
		if (session === null) return 'Ballastella Editor';
		if (openDirectory === null) return 'Ballastella Editor';
		return `${session.openProject?.name || openDirectory} — Ballastella Editor`;
	});
</script>

<!--
	One `<svelte:head>`, because this route is both screens and a document has one title. Named after
	the Project when there is one: a scholar with several tabs open has nothing else to tell them
	apart, and `?p=amsterdam-1625` is not visible on a tab strip.
-->
<svelte:head><title>{pageTitle}</title></svelte:head>

{#if host.unsupported}
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<!-- OPFS is missing only in a non-secure context, and the raw DOM failure for that
		     diagnoses nothing. -->
		<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
			<h2 class="font-semibold">No storage for a Workspace</h2>
			<p>{host.unsupported}</p>
		</div>
	</main>
{:else if storage === null || session === null}
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<p class="mt-8">Starting…</p>
	</main>
{:else if openDirectory === null}
	<!-- The hub: a centred column that scrolls, which is what a list of Projects wants. -->
	<main class="mx-auto max-w-4xl p-8">
		<h1 class="text-3xl font-bold">Ballastella Editor</h1>
		<StorageChoice {storage} />
		<ProjectHub {session} />
	</main>
{:else}
	<!--
		The Project fills the screen instead of sitting in a centred column, because the map is the
		thing being studied and a `max-w-4xl` map is the smaller share of a display. No `<h1>` here:
		the Project's own name is the heading, and it is inside the screen.
	-->
	<main class="h-full">
		<ProjectScreen {session} {storage} {openDirectory} />
	</main>
{/if}
