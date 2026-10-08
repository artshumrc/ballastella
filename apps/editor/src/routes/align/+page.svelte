<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { DEFAULT_BASE_MAP_APPEARANCE, resolveBaseMap, type MapLayer } from '@ballastella/core';

	import AlignmentWorkspace from '$lib/alignment/AlignmentWorkspace.svelte';
	import { pageChrome } from '@ballastella/ui';
	import { editHistorySlot } from '$lib/undo/edit-history-slot.svelte.js';
	import Alert from '$lib/components/Alert.svelte';
	import WorkspaceRecovery from '$lib/components/WorkspaceRecovery.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	const openDirectory = $derived(page.url.searchParams.get('p'));
	const layerId = $derived(page.url.searchParams.get('layer'));
	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);
	$effect(() => storage?.openWhenRecovered(openDirectory));

	const layer = $derived<MapLayer | null>(
		session?.openProject?.layers.find(
			(one): one is MapLayer => one.kind === 'map' && one.id === layerId
		) ?? null
	);

	const resolution = $derived(
		session?.openProject ? resolveBaseMap(session.openProject.baseMap) : null
	);

	const fetchTile = $derived(session?.imageServiceFetch());
	const projectQuery = $derived(encodeURIComponent(openDirectory ?? ''));

	$effect(() => {
		const project = session?.openProject;
		const directory = openDirectory;
		const currentLayer = layer;
		const breadcrumbs = [
			{ label: 'Projects', destination: {}, testid: 'all-projects' },
			...(directory === null
				? []
				: [
						{
							label: project?.name || directory,
							destination: { project: directory },
							testid: 'back-to-project'
						}
					]),
			{ label: currentLayer === null ? 'Align' : `Align: ${currentLayer.name}` }
		];
		pageChrome.showBreadcrumbs('editor-align', breadcrumbs);
		return () => pageChrome.clear('editor-align');
	});

	$effect(() => {
		const current = session;
		const mapImage = layer?.imageId;
		if (!current || mapImage === undefined) return;
		editHistorySlot.show('editor-align', current.historyFor(mapImage));
		return () => editHistorySlot.clear('editor-align');
	});
</script>

<svelte:head><title>Align — Ballastella Editor</title></svelte:head>

{#snippet backToAll()}
	<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
{/snippet}

{#snippet backToProject()}
	<a class="btn btn-sm" href="{resolve('/')}?p={projectQuery}">Back to this Project</a>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
	<div class="flex min-h-0 grow flex-col overflow-y-auto p-4">
		{#if host.unsupported}
			<Alert heading="No storage for a Workspace" text={host.unsupported}>
				{@render backToAll()}
			</Alert>
		{:else if storage === null || session === null}
			<div>
				<p>Starting…</p>
				<p class="mt-6">{@render backToAll()}</p>
			</div>
		{:else if !storage.resumeFolder}
			{#if openDirectory === null}
				<Alert heading="No Project chosen" tone="info">
					<p>
						Aligning happens inside one Project, so this screen needs a Project to open. Opening it
						cannot create one.
					</p>
					{@render backToAll()}
				</Alert>
			{:else if session.status === 'unreachable'}
				<div>
					<WorkspaceRecovery {storage} />
					<p class="mt-6">{@render backToAll()}</p>
				</div>
			{:else if session.projectProblem}
				<Alert
					heading={session.projectProblem.kind === 'missing'
						? 'Project not found'
						: 'This Project cannot be opened'}
					text={session.projectProblem.message}
				>
					{@render backToAll()}
				</Alert>
			{:else if layerId === null}
				<Alert heading="No Map Image chosen" tone="info" testid="no-layer">
					<p>
						This screen aligns one Map Image, so it needs to be told which. Choose one on the
						Project and press Align.
					</p>
					{@render backToProject()}
				</Alert>
			{:else if resolution === null}
				<p>Opening Project “{openDirectory}”…</p>
			{:else if layer === null}
				<Alert heading="That Map Image is not in this Project" testid="layer-missing">
					<p>
						“{openDirectory}” has no Map Image Layer with the id <code>{layerId}</code>. It may have
						been removed from the Project, or this link may have come from a different Workspace.
					</p>
					{@render backToProject()}
				</Alert>
			{:else if fetchTile}
				{#key layer.imageId}
					<AlignmentWorkspace
						{session}
						imageId={layer.imageId}
						mapName={layer.name}
						{fetchTile}
						baseMapId={resolution.entry.id}
						baseMapAppearance={session.openProject?.baseMapAppearance ??
							DEFAULT_BASE_MAP_APPEARANCE}
						projectDirectory={openDirectory}
					/>
				{/key}
			{/if}
		{/if}
	</div>
</div>
