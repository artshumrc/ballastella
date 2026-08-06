<script lang="ts">
	import './layout.css';
	import { refuseUnroutedImageServiceRequests } from '@ballastella/core';
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

	/**
	 * Make a forgotten `Image#uri` override say so, everywhere in the app (ADR-0004, ADR-0011).
	 *
	 * SPEC calls "every code path constructing an `Image` sets `uri` before requesting a tile" the
	 * most fragile invariant in the project, because `Image#uri` is a plain public field and a
	 * single assignment is exactly what a new code path forgets. What the browser gives that path
	 * for free is a blank map and `TypeError: Failed to fetch` from a DNS failure against
	 * `.invalid` — loud, as ADR-0004 intended, but naming nothing.
	 *
	 * So the placeholder host is refused at the global `fetch` before a request is made, with a
	 * message that names the missing override and the two injection points that supply it. Every
	 * consumer wired today goes through the shim and never reaches this; it is here for the next
	 * one. In an `$effect` rather than at module scope because a module body also runs during
	 * prerendering, where there is no page to guard and nothing has gone wrong.
	 */
	$effect(() => refuseUnroutedImageServiceRequests());
</script>

<svelte:head><link rel="icon" href={favicon} /></svelte:head>
{@render children()}
