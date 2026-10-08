<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteSet } from 'svelte/reactivity';
	import Copy from '@lucide/svelte/icons/copy';
	import MapIcon from '@lucide/svelte/icons/map';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import {
		count,
		describeBytes,
		type ProjectSummary,
		type WorkspaceMapImage
	} from '@ballastella/core';
	import { ProjectCardList } from '@ballastella/ui';

	import type { EditorSession } from '../editor-session.svelte.js';
	import MapThumbnail from '../map-images/MapThumbnail.svelte';
	import { useWorkspaceHost } from '../workspace-storage.svelte.js';
	import { formatWhen } from '../text.js';
	import Alert from './Alert.svelte';
	import BusyButton from './BusyButton.svelte';
	import ExternalLink from './ExternalLink.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import ModalDialog from './ModalDialog.svelte';

	let { session }: { session: EditorSession } = $props();

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const review = $derived(storage?.review ?? null);
	let creating = $state(false);
	let editing = $state<ProjectSummary | null>(null);
	let draft = $state({ name: '', description: '' });
	let deleting = $state<ProjectSummary | null>(null);
	let deletingBreaksLinks = $state(false);

	type ListedProject = ProjectSummary & { readonly href: string };

	const listed = $derived<readonly ListedProject[]>(
		session.projects.map((project) => ({
			...project,
			href: resolve(`/?p=${encodeURIComponent(project.directory)}`)
		}))
	);

	const startCreating = () => {
		draft = { name: '', description: '' };
		session.dismissProjectProblem();
		creating = true;
	};

	const create = async () => {
		creating = false;
		const project = await session.createProject(draft.name, draft.description);
		if (!project) return;
		await goto(resolve(`/?p=${encodeURIComponent(project.directory)}`));
	};

	const unwritable = $derived(editing !== null && editing.problem !== null);

	const startEditing = (project: ProjectSummary) => {
		draft = { name: project.name, description: project.description };
		editing = project;
	};

	const saveEdits = async () => {
		const project = editing;
		editing = null;
		if (project) {
			await session.updateProjectDetails(project.directory, { ...draft });
		}
	};

	const exportFromEditor = () => {
		const project = editing;
		if (!project) return;
		editing = null;
		void storage?.exportProject(project);
	};

	const askToDeleteProject = async (project: ProjectSummary) => {
		editing = null;
		deletingBreaksLinks = false;
		deleting = project;
		const held = storage;
		if (!held) return;
		const [shareLinks, reach] = await Promise.all([
			held.remote.hasShareLinks(),
			held.remote.projectReach(project.directory)
		]);
		if (deleting?.directory === project.directory) {
			deletingBreaksLinks = shareLinks && reach.synced;
		}
	};

	const remove = async () => {
		const project = deleting;
		deleting = null;
		if (project) await session.deleteProject(project.directory);
	};

	let deletingMap = $state<WorkspaceMapImage | null>(null);
	let mapImageMessage = $state('');
	const provenanceShown = new SvelteSet<string>();

	$effect(() => {
		void session.projects;
		void session.refreshMapImages();
	});

	const lookingForMapImages = $derived(session.mapImagesLoading && session.mapImages.length === 0);
	const mapImagesBytes = $derived(session.mapImages.reduce((sum, map) => sum + map.bytes, 0));
	const localMapImages = $derived(
		session.mapImages.filter((map) => map.tiles === 'in-workspace').length
	);
	const externalMapImages = $derived(session.mapImages.length - localMapImages);
	const fetchTile = $derived(session.imageServiceFetch());

	const whereTilesAre = (map: WorkspaceMapImage): string =>
		map.tiles === 'in-workspace'
			? 'Tiles in this Workspace'
			: `Tiles on ${map.library || 'a Library’s server'}`;

	const externalUrl = (value: string): string | null => {
		try {
			const url = new URL(value);
			return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
		} catch {
			return null;
		}
	};

	const usedBy = (map: WorkspaceMapImage): string => {
		const names = map.usedBy.map((project) => project.name).join(', ');
		const unreadable = map.mightBeUsedBy.map((project) => project.name).join(', ');
		if (!unreadable) return `Projects that use this image: ${names || 'None'}.`;
		const label = names
			? `Projects that use this image: ${names}.`
			: 'Projects that use this image: none that this version can confirm.';
		const pronoun = map.mightBeUsedBy.length === 1 ? 'It' : 'They';
		return `${label} ${pronoun} may also be drawn by ${unreadable}, made with a newer version of Ballastella.`;
	};

	type ListedMapImage = {
		readonly name: string;
		readonly directory: string;
		readonly map: WorkspaceMapImage;
	};

	const mapEntries = $derived<readonly ListedMapImage[]>(
		session.mapImages.map((map) => ({
			name: map.label || map.imageId,
			directory: map.imageId,
			map
		}))
	);

	const askToDelete = (map: WorkspaceMapImage) => {
		mapImageMessage = '';
		session.dismissMapImageError();
		deletingMap = map;
	};

	const toggleProvenance = (imageId: string) => {
		if (provenanceShown.has(imageId)) provenanceShown.delete(imageId);
		else provenanceShown.add(imageId);
	};

	const drawnByNow = $derived(
		deletingMap
			? [...deletingMap.usedBy, ...deletingMap.mightBeUsedBy].map((project) => project.name)
			: []
	);

	const removeMap = async () => {
		const map = deletingMap;
		deletingMap = null;
		if (!map) return;
		const deleted = await session.deleteMapImage(map.imageId);
		mapImageMessage = deleted
			? `Deleted ${map.label || map.imageId}, reclaiming ${describeBytes(map.bytes)}.`
			: '';
	};

	const transfer = $derived(storage?.transfer ?? null);
	const transferring = $derived(transfer !== null && !transfer.finished);

	const VERBS = {
		open: ['Opening', 'Opened'],
		import: ['Importing', 'Imported'],
		export: ['Exporting', 'Exported']
	} as const;

	const transferMessage = $derived.by(() => {
		if (!transfer) return '';
		const [doing, done] = VERBS[transfer.kind];
		if (transfer.finished) return `${done} ${transfer.subject}: ${transfer.totalFiles} files.`;
		const sofar = transfer.kind === 'open' ? 'files so far' : `of ${transfer.totalFiles} files`;
		return `${doing} ${transfer.subject}: ${transfer.files} ${sofar}.`;
	});
</script>

{#snippet facts(project: ListedProject)}
	Last saved <time datetime={project.updatedAt}>{formatWhen(project.updatedAt, 'never')}</time>
{/snippet}

{#snippet details(project: ListedProject)}
	{#if project.description}
		<p
			class="mt-2 text-sm break-words whitespace-pre-line opacity-90"
			data-testid="project-description"
		>
			{project.description}
		</p>
	{/if}
	{#if project.problem === 'format-too-new'}
		<p class="text-sm text-warning">Made with a newer version of Ballastella.</p>
	{:else if project.problem === 'unreadable'}
		<p class="text-sm text-warning">Its project.json could not be read.</p>
	{/if}
{/snippet}

{#snippet actions(project: ListedProject)}
	<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
	<button class="btn gap-2 btn-primary btn-sm" onclick={() => goto(project.href)}>
		<MapIcon class="size-4" aria-hidden="true" />
		Open<span class="sr-only"> {project.name}</span>
	</button>
	<button class="btn gap-2 btn-outline btn-sm" onclick={() => startEditing(project)}>
		<Pencil class="size-4" aria-hidden="true" />
		Edit<span class="sr-only"> {project.name}</span>
	</button>
	<button
		class="btn gap-2 btn-outline btn-sm"
		onclick={() => session.duplicateProject(project.directory)}
		disabled={project.problem !== null}
	>
		<Copy class="size-4" aria-hidden="true" />
		Duplicate<span class="sr-only"> {project.name}</span>
	</button>
{/snippet}

{#snippet mapMedia(entry: ListedMapImage)}
	<MapThumbnail map={entry.map} {fetchTile} />
{/snippet}

{#snippet mapFacts(entry: ListedMapImage)}
	{describeBytes(entry.map.bytes)} in {count(entry.map.files, 'file')} · {whereTilesAre(entry.map)}
{/snippet}

{#snippet mapDetails(entry: ListedMapImage)}
	<p class="text-sm opacity-70" data-testid="used-by" data-used-by-count={entry.map.usedBy.length}>
		{usedBy(entry.map)}
	</p>
	{#if entry.map.provenance && provenanceShown.has(entry.map.imageId)}
		{@const href = externalUrl(entry.map.provenance.source)}
		<dl class="mt-2 grid gap-x-4 text-sm" data-testid="map-image-provenance">
			<dt class="font-medium">Source</dt>
			<dd>
				{#if href}
					<ExternalLink class="link break-all" {href}>{entry.map.provenance.source}</ExternalLink>
				{:else}
					<span class="break-all">{entry.map.provenance.source}</span>
				{/if}
			</dd>
			{#if entry.map.provenance.canvasLabel}
				<dt class="font-medium">Canvas</dt>
				<dd>{entry.map.provenance.canvasLabel}</dd>
			{/if}
		</dl>
	{/if}
{/snippet}

{#snippet mapActions(entry: ListedMapImage)}
	{#if entry.map.provenance}
		<button
			class="btn btn-outline btn-sm"
			aria-expanded={provenanceShown.has(entry.map.imageId)}
			onclick={() => toggleProvenance(entry.map.imageId)}
		>
			{provenanceShown.has(entry.map.imageId) ? 'Hide provenance' : 'Provenance'}
		</button>
	{/if}
	<button class="btn btn-outline btn-error btn-sm" onclick={() => askToDelete(entry.map)}>
		Delete<span class="sr-only"> {entry.name}</span>
	</button>
{/snippet}

<div
	class="mt-8 xl:grid xl:grid-cols-[minmax(0,var(--workspace-home-measure))_minmax(0,1fr)] xl:gap-8"
>
	<section>
		<div class="xl:min-h-[5.75rem]">
			<div class="flex flex-wrap items-baseline justify-between gap-4">
				<div class="flex flex-wrap items-baseline gap-3">
					<h2 class="text-2xl font-semibold">Projects</h2>
					{#if session.status === 'ready'}
						<span class="text-sm opacity-70" data-testid="projects-count">
							{session.projects.length}<span class="sr-only"
								>&nbsp;{session.projects.length === 1 ? 'Project' : 'Projects'}</span
							>
						</span>
					{/if}
				</div>
				<div class="flex flex-wrap gap-2">
					<button class="btn gap-2 btn-success" onclick={startCreating}>
						<Plus class="size-4" aria-hidden="true" />
						New Project
					</button>
				</div>
			</div>

			{#if review !== null}
				<p class="mt-4 text-sm opacity-70" data-testid="review-workspace-note">
					A review copy is not sent and not backed up: it holds somebody else's work and is meant to
					be discarded. Go back to your own Workspace to share yours.
				</p>
			{/if}

			<p
				aria-live="polite"
				aria-atomic="true"
				class="mt-2 text-sm opacity-80"
				data-transfer={transfer?.kind ?? ''}
			>
				{transferMessage}
			</p>

			<Alert class="mt-4" tone="error" text={storage?.transferError ?? ''} />
			<Alert
				class="mt-4"
				testid="reserved-name"
				text={session.projectProblem?.kind === 'reserved-name'
					? session.projectProblem.message
					: ''}
			/>
		</div>

		{#if session.status === 'unreachable'}
			<p class="mt-6">
				The Projects in this Workspace cannot be listed until it can be reached. Nothing has been
				lost — they are still wherever they were.
			</p>
		{:else if session.status === 'loading'}
			<p class="mt-6">Looking for your Projects…</p>
		{:else if session.projects.length === 0}
			<p class="mt-6">No Projects yet.</p>
		{:else}
			<ProjectCardList
				class="mt-4 workspace-home-column"
				heading="h3"
				projects={listed}
				{facts}
				{details}
				{actions}
			/>
		{/if}
	</section>

	{#if session.status !== 'unreachable'}
		<section class="mt-10 xl:mt-0 xl:border-l xl:border-rule xl:pl-8">
			<h2 class="text-2xl font-semibold">Map Images</h2>
			{#if !lookingForMapImages}
				<dl
					class="mt-4 grid max-w-max grid-cols-[auto_auto] gap-x-4 gap-y-1 text-sm"
					data-testid="map-images-stats"
				>
					<dt class="font-medium">Total</dt>
					<dd data-testid="map-images-total">
						{session.mapImages.length}
						<span class="opacity-70"
							>({localMapImages} local, {externalMapImages} IIIF external)</span
						>
					</dd>
					<dt class="font-medium">Size on disk</dt>
					<dd data-testid="map-images-size">{describeBytes(mapImagesBytes)}</dd>
				</dl>
			{/if}

			<p aria-live="polite" class="mt-2 text-sm opacity-80" data-testid="map-image-status">
				{mapImageMessage}
			</p>

			<Alert class="mt-2" testid="map-image-refused" text={session.mapImageError} />

			{#if lookingForMapImages}
				<p class="mt-4">Looking at what this Workspace holds…</p>
			{:else if session.mapImages.length === 0}
				<p class="mt-4" data-testid="no-map-images">No Map Images yet.</p>
			{:else}
				<ProjectCardList
					class="mt-4 workspace-home-column"
					heading="h3"
					projects={mapEntries}
					media={mapMedia}
					facts={mapFacts}
					details={mapDetails}
					actions={mapActions}
					showDirectory={false}
					itemTestid="map-image"
				/>
			{/if}
		</section>
	{/if}
</div>

<ConfirmDialog
	bind:open={() => deletingMap !== null, (open) => !open && (deletingMap = null)}
	title="Delete Map Image"
	confirm="Delete Map Image"
	onconfirm={removeMap}
>
	<p>
		Delete <strong>{deletingMap?.label || deletingMap?.imageId}</strong> and reclaim
		{describeBytes(deletingMap?.bytes ?? 0)}? Its tiles, the record of where it came from, and the
		Alignment placing it on the earth all go with it. This cannot be undone.
	</p>
	<p class="mt-3 text-sm opacity-70" data-testid="delete-map-consequence">
		{#if drawnByNow.length > 0}
			{drawnByNow.join(', ')} still {drawnByNow.length === 1 ? 'draws' : 'draw'} this map, so deleting
			it will be refused rather than leaving a Layer that draws nothing.
		{:else}
			No Project draws this map, so nothing on screen will change.
		{/if}
	</p>
</ConfirmDialog>

{#snippet projectFields(onenter: () => unknown, disabled: boolean, placeholder?: string)}
	<label class="floating-label">
		<span>Project name</span>
		<input
			class="input w-full"
			bind:value={draft.name}
			{disabled}
			{placeholder}
			onkeydown={(event) => event.key === 'Enter' && onenter()}
		/>
	</label>
	<label class="floating-label mt-4">
		<span>Description (optional)</span>
		<textarea
			class="textarea w-full"
			rows="3"
			bind:value={draft.description}
			{disabled}
			placeholder="What this Project is, for whoever opens it next."></textarea>
	</label>
{/snippet}

<ModalDialog bind:open={creating} title="New Project">
	{@render projectFields(create, false, 'Amsterdam 1625')}
	{#snippet actions()}
		<button class="btn" onclick={() => (creating = false)}>Cancel</button>
		<button class="btn btn-primary" onclick={create}>Create Project</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => editing !== null, (open) => !open && (editing = null)}
	title="Edit Project"
>
	{@render projectFields(saveEdits, unwritable)}
	<p class="mt-3 text-sm opacity-70">
		{#if unwritable}
			This Project's details cannot be changed here: its project.json is not one this version can
			read, and writing it back would destroy what it holds. Exporting it does not read it.
		{:else}
			Two Projects may share a name; the folder this one lives in does not change, so a link you
			have already shared keeps working.
		{/if}
	</p>

	<div class="mt-6 flex flex-wrap items-center gap-2 border-t border-rule pt-4">
		<BusyButton class="btn btn-sm" busy={transferring} onclick={exportFromEditor}>
			Export Project
		</BusyButton>
		<button
			class="btn ms-auto btn-outline btn-error btn-sm"
			onclick={() => editing && void askToDeleteProject(editing)}
		>
			Delete Project…
		</button>
	</div>

	{#snippet actions()}
		<button class="btn" onclick={() => (editing = null)}>Cancel</button>
		<button class="btn btn-primary" onclick={saveEdits} disabled={unwritable}>Save Changes</button>
	{/snippet}
</ModalDialog>

<ConfirmDialog
	bind:open={() => deleting !== null, (open) => !open && (deleting = null)}
	title="Delete Project"
	confirm="Delete Project"
	onconfirm={remove}
>
	<p>
		Delete <strong>{deleting?.name}</strong> and everything in it? Its Layers and Annotations go with
		it. This cannot be undone.
	</p>
	<p class="mt-3 text-sm opacity-70">
		The Map Images it drew stay in the Workspace, with their Alignments, because other Projects may
		use them. Delete those from the Map Images list if you no longer want them.
	</p>
	{#if deletingBreaksLinks}
		<p class="mt-3 text-sm" data-testid="delete-breaks-share-link">
			Anyone you have given this Project's link to will find it stops working after the next Sync,
			including a link in something already in print.
		</p>
	{/if}
</ConfirmDialog>
