<script lang="ts">
	// Aligning one Map Image: the sheet on one side and the world on the other (ticket 03).
	//
	// A route of its own rather than a section of the Project page. Aligning is a whole screen's worth
	// of work — two live map contexts, a Control Point list, a Resource Mask, and a transformation
	// choice — and it is entered deliberately and left deliberately, which is what a route is. The
	// workspace itself is unchanged: it moved here, it was not rewritten.
	//
	// **Keyed by Layer id, not by image id.** The Layer is what the user clicked, what carries the name
	// they gave it, and what exists before a single Control Point does — so `?layer=` is honest for a
	// Map Image nobody has placed yet, where `?image=` would be addressing a pyramid and hoping
	// the Project has something to draw it with. The image id is recovered from the Layer here, which
	// is the one direction that always works (ADR-0023).
	//
	// **Prerendered, selecting its subject client-side** (ADR-0008): one `align/index.html` in the
	// build, no SPA fallback, and no per-Project artefact. The Workspace comes from the root layout's
	// `useWorkspaceHost()` and never from `EditorSession.opfs()` — `/base-map/` called that directly
	// and wrote a folder-Workspace author's Base Map choice into the OPFS Project of the same name.

	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { resolveBaseMap, type MapLayer } from '@ballastella/core';

	import AlignmentWorkspace from '$lib/alignment/AlignmentWorkspace.svelte';
	import { pageChrome } from '@ballastella/ui';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	const openDirectory = $derived(page.url.searchParams.get('p'));
	const layerId = $derived(page.url.searchParams.get('layer'));

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	/**
	 * ⚠ **Gated on `storage.recovered`, and this is the route where it matters most** (ticket 20).
	 *
	 * The write-ahead journal is replayed into the store as the Workspace is adopted, and this
	 * effect runs at the same moment. `/align?p=…&layer=…` is bookmarkable, and it is the screen
	 * that reads *and writes* Alignments — the file replay puts back through `alignment-file.ts`.
	 * Ungated, a reload landing here inside the debounce window shows the Control Points as they
	 * were **before** the replay, and the next drag writes those back over the rescue: the exact
	 * defect this gate exists for, on the route where it costs a colleague's afternoon rather than
	 * a Project name.
	 *
	 * The hub route carries the same gate. The promise never rejects, so a recovery that went wrong
	 * cannot stop an alignment being opened.
	 */
	$effect(() => {
		const current = session;
		const directory = openDirectory;
		const ready = storage?.recovered;
		if (!current || !ready) return;
		void ready.then(() => current.open(directory));
	});

	/**
	 * The Layer named by `?layer=`, if it is a Map Image Layer of this Project.
	 *
	 * `null` covers three different mistakes that all render the same way and must all render
	 * *something*: no such Layer, a Layer of another kind, and a Layer belonging to a different
	 * Project. A route that quietly showed an empty split screen for any of them would be a scholar
	 * staring at two blank panes with nothing on the page saying which map they were supposed to be
	 * looking at.
	 */
	const layer = $derived<MapLayer | null>(
		session?.openProject?.layers.find(
			(one): one is MapLayer => one.kind === 'map' && one.id === layerId
		) ?? null
	);

	/**
	 * The author's Base Map for this Project, resolved against this deployment's catalog (ADR-0020).
	 *
	 * `null` until the Project is open, which is also this page's "still opening" signal — the same
	 * shape `/base-map/` and `/layers/` both use.
	 */
	const resolution = $derived(
		session?.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);

	/**
	 * The ADR-0011 shim. One for the whole Workspace since ADR-0023, so it is not rebuilt per Project
	 * and cannot go stale against the open one.
	 */
	const fetchTile = $derived(session?.imageServiceFetch());

	/**
	 * The Project this route came from, for the way back.
	 *
	 * Spelled out at each link as `{resolve('/')}?p={…}` rather than held in a variable, which is the
	 * same shape `/layers/` uses: `svelte/no-navigation-without-resolve` reads the first part of an
	 * `href`, so a resolved path followed by a query string is what it recognises, and a `$derived`
	 * string is not.
	 */
	const projectQuery = $derived(encodeURIComponent(openDirectory ?? ''));

	/**
	 * This screen's name and its way out, on the app's navigation bar.
	 *
	 * ⚠ **Both were a header strip of this route's own, and this screen is the reason there is a slot
	 * on the bar instead** — a second header above two live map panes is 60 pixels of chrome charged to
	 * the one thing on the page that needs the height.
	 *
	 * The way back is behind the same session guard the link was: ADR-0008 has this route pick its
	 * subject client-side and SvelteKit throws on `url.searchParams` during a prerender, so `?p=` is
	 * read only once there is a browser. With no Project named it lands on the hub, which is still
	 * somewhere — a dead control on an error page is worse than an imprecise one.
	 */
	$effect(() => {
		pageChrome.show(
			'Align',
			session === null
				? null
				: {
						label: 'Back to this Project',
						project: openDirectory ?? '',
						testid: 'back-to-project'
					}
		);
		return () => pageChrome.clear('Align');
	});
</script>

<svelte:head><title>Align — Ballastella Editor</title></svelte:head>

<!--
	⚠ **`h-full`, not `min-h-full`, and that is what makes the panes full height.** The root layout
	hands every route one screen minus the bar (`+layout.svelte`), and this screen is that height and
	nothing more, so `AlignmentWorkspace` has a *bounded* height to grow into. With `min-h-full` it had only a floor, so a `grow` pane resolved to
	its content and the two canvases stayed at whatever number they had been given — which is why this
	route was a tall scrolling page with two small windows on it.
-->
<div class="flex h-full min-h-0 flex-col">
	<!--
		The region the workspace fills, and the one that scrolls when it cannot.

		`overflow-y-auto` here rather than nowhere: at `lg` nothing overflows, because the panes size
		themselves to this box and the sidebar scrolls on its own. Below `lg`, and on any display too
		short for the panes' minimum heights, this is the scroll that keeps the whole screen reachable —
		so making the maps full height never costs anybody access to what is underneath them.
	-->
	<div class="flex min-h-0 grow flex-col overflow-y-auto p-4">
		{#if host.unsupported}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<h2 class="font-semibold">No storage for a Workspace</h2>
				<p>{host.unsupported}</p>
				<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
			</div>
		{:else if storage === null || session === null}
			<div>
				<p>Starting…</p>
				<p class="mt-6"><a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a></p>
			</div>
		{:else if openDirectory === null}
			<div role="alert" class="alert flex-col items-start alert-info">
				<h2 class="font-semibold">No Project chosen</h2>
				<p>
					Aligning happens inside one Project, so this screen needs a Project to open. Opening it
					cannot create one.
				</p>
				<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
			</div>
		{:else if session.status === 'unreachable' || storage.awaitingFolder}
			<!-- ADR-0008: both are normal states with recoveries, never error boundaries — and "the folder
			     is remembered but not open yet" is one this route reaches by being bookmarked. -->
			<div>
				<WorkspaceRecovery {storage} />
				<p class="mt-6"><a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a></p>
			</div>
		{:else if session.projectProblem}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<h2 class="font-semibold">
					{session.projectProblem.kind === 'missing'
						? 'Project not found'
						: 'This Project cannot be opened'}
				</h2>
				<p>{session.projectProblem.message}</p>
				<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
			</div>
		{:else if layerId === null}
			<div role="alert" class="alert flex-col items-start alert-info" data-testid="no-layer">
				<h2 class="font-semibold">No Map Image chosen</h2>
				<p>
					This screen aligns one Map Image, so it needs to be told which. Choose one on the Project
					and press Align.
				</p>
				<a class="btn btn-sm" href="{resolve('/')}?p={projectQuery}">Back to this Project</a>
			</div>
		{:else if resolution === null}
			<p>Opening Project “{openDirectory}”…</p>
		{:else if layer === null}
			<!--
				A `layer` id this Project has no Map Image Layer for. Reachable by a stale bookmark, by
				a link shared between two Workspaces, and by deleting the Layer in another tab — none of
				which is an error in the application, and all of which used to be an empty split screen.
			-->
			<div
				role="alert"
				class="alert flex-col items-start alert-warning"
				data-testid="layer-missing"
			>
				<h2 class="font-semibold">That Map Image is not in this Project</h2>
				<p>
					“{openDirectory}” has no Map Image Layer with the id <code>{layerId}</code>. It may have
					been removed from the Project, or this link may have come from a different Workspace.
				</p>
				<a class="btn btn-sm" href="{resolve('/')}?p={projectQuery}">Back to this Project</a>
			</div>
		{:else if fetchTile}
			<AlignmentWorkspace
				{session}
				imageId={layer.imageId}
				mapName={layer.name}
				{fetchTile}
				baseMapId={resolution.entry.id}
			/>
		{/if}
	</div>
</div>
