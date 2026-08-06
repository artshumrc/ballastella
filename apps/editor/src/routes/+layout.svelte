<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { provideWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	let { children } = $props();

	/**
	 * The one Workspace, for every route.
	 *
	 * Here rather than per page because the layout mounts once for the whole app: a client-side
	 * navigation between `/` and `/base-map/` then carries the live session — a resumed folder
	 * included — instead of each route resolving the backing store for itself. `/base-map/` used to
	 * call `EditorSession.opfs()` directly, so a folder-Workspace user's Base Map choice was written
	 * into the wrong Workspace (ticket 12).
	 *
	 * `setContext` has to run during initialisation; the storage inside it is created in the effect,
	 * because it reaches for browser storage that does not exist while prerendering.
	 */
	const host = provideWorkspaceHost();

	$effect(() => host.begin());
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
