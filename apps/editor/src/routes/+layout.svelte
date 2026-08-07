<script lang="ts">
	import './layout.css';
	import { refuseUnroutedImageServiceRequests } from '@ballastella/core';
	import { asset } from '$app/paths';
	import favicon from '$lib/assets/favicon.svg';
	import NavigationBar from '$lib/components/NavigationBar.svelte';
	import UpdatePrompt from '$lib/pwa/UpdatePrompt.svelte';
	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import { startTheme } from '$lib/theme.svelte';
	import { provideWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	let { children } = $props();

	/**
	 * The one Workspace, for every route.
	 *
	 * Here rather than per page because the layout mounts once for the whole app: a client-side
	 * navigation between `/` and `/align/` then carries the live session — a resumed folder
	 * included — instead of each route resolving the backing store for itself. The deleted
	 * `/base-map/` used to call `EditorSession.opfs()` directly, so a folder-Workspace user's Base
	 * Map choice was written into the wrong Workspace (ticket 12).
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

	/**
	 * The theme, applied once for the whole app (ticket 04, SPEC stories 109 and 110).
	 *
	 * Here rather than in each route, which is where it was: three routes called `startTheme()` and
	 * the hub did not, so a stored preference was applied only after navigating to one of the three.
	 * It also has to be *one* call, because the unset state subscribes to `prefers-color-scheme` and
	 * a per-route subscription would be one listener per visited route.
	 *
	 * In an effect for the reason every other browser-facing thing here is: a module body runs during
	 * prerendering, where there is no `document` to paint and no `matchMedia` to follow.
	 */
	$effect(() => startTheme());
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<!--
		ADR-0006: `asset()` prefixes with the base path, which `paths.relative` makes relative to the
		page being rendered — so the prerendered `/align` carries `../manifest.webmanifest` and the
		prerendered `/` carries `./manifest.webmanifest`, and the same build is installable from a
		domain root and from a project subdirectory. The manifest's own `start_url` and `scope` are
		`"."`, resolved by the browser against the manifest's URL, so they land on the deployment's root
		wherever that is.
	-->
	<link rel="manifest" href={asset('/manifest.webmanifest')} />
	<meta name="theme-color" content="#134e4a" />
</svelte:head>
<!--
	The app is one screen tall and the routes divide it, rather than each route setting its own
	`min-h-screen` and hoping the bar above it is the height it guessed. The scrolling region is the
	one below the bar, so the bar stays put on the hub — which is the only long page — and the Project
	screen can be exactly as tall as what is left, which is what makes its map full height without
	arithmetic on the bar's own size.
-->
<div class="flex h-screen flex-col">
	<!--
		Outside `children()` so it is on every route, and *before* it so it is first in the tab order
		and first for a screen reader: a bar announced after the page it belongs to is a footer.
	-->
	<NavigationBar />
	<div class="min-h-0 grow overflow-y-auto">{@render children()}</div>
</div>
<!--
	Outside `children()` so that it is present on every route, including the two panes a scholar is
	mid-alignment in. It renders a fixed-position region and inserts nothing into the page's flow.
-->
<UpdatePrompt />
