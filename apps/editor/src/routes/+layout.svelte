<script lang="ts">
	import './layout.css';
	import { refuseUnroutedImageServiceRequests } from '@ballastella/core';
	import { asset } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import UpdatePrompt from '$lib/pwa/UpdatePrompt.svelte';
	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte.js';
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

	/**
	 * The app shell as an installed application, and its version (ADR-0012).
	 *
	 * Here for the same reason the Workspace is: the layout mounts once for the whole app, so the
	 * registration happens once rather than per route — and `resolveDeploymentAsset`, which is what
	 * finds `service-worker.js` without writing a leading slash, is only correct while `base` and
	 * `document.baseURI` still describe the same page, which is on mount and not after a client-side
	 * navigation.
	 *
	 * `setContext` has to run during initialisation; the registration inside it is in the effect,
	 * because a module body also runs while prerendering, where there is no navigator to register with.
	 */
	const installedApp = provideInstalledApp();

	$effect(() => installedApp.start());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!--
		ADR-0006: `asset()` prefixes with the base path, which `paths.relative` makes relative to the
		page being rendered — so the prerendered `/base-map` carries `../manifest.webmanifest` and the
		prerendered `/` carries `./manifest.webmanifest`, and the same build is installable from a
		domain root and from a project subdirectory. The manifest's own `start_url` and `scope` are
		`"."`, resolved by the browser against the manifest's URL, so they land on the deployment's root
		wherever that is.
	-->
	<link rel="manifest" href={asset('/manifest.webmanifest')} />
	<meta name="theme-color" content="#134e4a" />
</svelte:head>
{@render children()}
<!--
	Outside `children()` so that it is present on every route, including the two panes a scholar is
	mid-alignment in. It renders a fixed-position region and inserts nothing into the page's flow.
-->
<UpdatePrompt />
