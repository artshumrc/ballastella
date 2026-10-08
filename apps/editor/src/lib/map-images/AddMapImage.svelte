<script lang="ts">
	import { count, describeBytes, type WorkspaceMapImage } from '@ballastella/core';

	import Alert from '$lib/components/Alert.svelte';
	import ModalDialog from '$lib/components/ModalDialog.svelte';
	import AddRemoteMap from '$lib/remote-iiif/AddRemoteMap.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';

	import MapThumbnail from './MapThumbnail.svelte';

	let {
		session,
		onnotice
	}: {
		session: EditorSession;
		onnotice: (notice: string) => void;
	} = $props();

	let open = $state(false);

	export function show(): void {
		open = true;
		onnotice('');
		void session.refreshAddableMapImages();
	}

	const available = $derived(
		session.mapImages.filter((map) => session.mapLayerFor(map.imageId) === undefined)
	);

	const fetchTile = $derived(session.imageServiceFetch());
	const nameOf = (map: WorkspaceMapImage): string => map.label || map.imageId;

	const weightOf = (map: WorkspaceMapImage): string =>
		`${describeBytes(map.bytes)} in ${count(map.files, 'file')}`;

	let adding = $state('');

	async function addFromWorkspace(imageId: string): Promise<void> {
		if (adding !== '') return;
		adding = imageId;
		const listed = session.mapImages.find((map) => map.imageId === imageId);
		const name = listed ? nameOf(listed) : imageId;
		onnotice('');
		try {
			const layer = await session.addWorkspaceMap(imageId);
			if (!layer) return;
			open = false;
			onnotice(
				`“${layer.name || name}” is now a Layer in this Project. Nothing was copied: it is the ` +
					`Map Image this Workspace already holds, with the Alignment it already has.`
			);
		} finally {
			adding = '';
		}
	}

	function chooseFile(input: HTMLInputElement): void {
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		onnotice('');
		open = false;
		void session.ingestImage(file);
	}

	function remoteAdded(notice: string): void {
		onnotice(notice);
		open = false;
	}
</script>

<ModalDialog bind:open title="Add a Map Image" wide>
	<p class="max-w-prose text-sm">
		Map images can be added from a file on your computer or from the web. The same image can be
		reused across project: align once, use multiple times.
	</p>

	<section class="mt-6" aria-labelledby="add-from-file-heading">
		<h3 id="add-from-file-heading" class="text-lg font-semibold">From a file on this computer</h3>
		<label class="mt-3 block">
			<span class="mb-1 block text-sm">Add a Map Image from a file</span>
			<input
				class="file-input w-full"
				type="file"
				accept="image/*"
				data-testid="add-from-file"
				disabled={session.ingest !== null}
				onchange={(event) => chooseFile(event.currentTarget)}
			/>
		</label>
		{#if session.ingest !== null}
			<p class="mt-2 max-w-prose text-sm" data-testid="ingest-busy">
				“{session.ingestLabel}” is still being prepared. Its Layer in this Project shows how far it
				has got, and one map is prepared at a time.
			</p>
		{/if}
	</section>

	<div class="mt-8 border-t border-base-300 pt-2">
		<AddRemoteMap {session} onadded={remoteAdded} />
	</div>

	<section class="mt-8 border-t border-base-300 pt-6" aria-labelledby="add-from-workspace-heading">
		<h3 id="add-from-workspace-heading" class="text-lg font-semibold">
			Select an existing Map Image from your Workspace
		</h3>

		<Alert class="mt-3 max-w-prose" testid="add-from-workspace-error" text={session.addMapError} />

		{#if session.mapImagesLoading && session.mapImages.length === 0}
			<p class="mt-3 text-sm" data-testid="workspace-maps-loading">
				Looking through this Workspace…
			</p>
		{:else if available.length === 0}
			<p class="mt-3 max-w-prose text-sm" data-testid="no-workspace-maps">
				{session.mapImages.length === 0
					? 'This Workspace holds no Map Images yet. Add one from a file or from a library, and it is here for every Project afterwards.'
					: 'Every Map Image in this Workspace is already in this Project.'}
			</p>
		{:else}
			<ul
				class="mt-3 flex max-h-64 flex-col gap-1 overflow-y-auto"
				aria-label="Map Images in this Workspace"
			>
				{#each available as map (map.imageId)}
					<li class="flex items-center gap-3" data-testid="workspace-map-row">
						<MapThumbnail {map} {fetchTile} size={48} />
						<button
							class="btn h-auto grow flex-col items-start gap-0 btn-outline py-2"
							type="button"
							data-testid="workspace-map"
							data-image-id={map.imageId}
							disabled={adding !== ''}
							onclick={() => void addFromWorkspace(map.imageId)}
						>
							<span class="font-medium">{nameOf(map)}</span>
							<span class="text-xs font-normal opacity-70">{weightOf(map)}</span>
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#snippet actions()}
		<button
			type="button"
			class="btn btn-sm"
			data-testid="close-add-map-image"
			onclick={() => (open = false)}
		>
			Close
		</button>
	{/snippet}
</ModalDialog>
