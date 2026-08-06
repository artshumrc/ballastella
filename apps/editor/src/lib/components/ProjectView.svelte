<script lang="ts">
	import { resolve } from '$app/paths';

	import HistoricalMapPane from '$lib/image-pane/HistoricalMapPane.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
	import SaveIndicator from './SaveIndicator.svelte';
	import WorkspaceRecovery from './WorkspaceRecovery.svelte';

	/**
	 * One Project, selected client-side from `?p=<folder>` (ADR-0008).
	 *
	 * The Control Points and the Layer stack still arrive in later slices. What is here is the
	 * frame they hang in, the autosave rules they will follow — the name field below is the app's
	 * first editable value, so it is where "typing coalesces into one write" and "the edit is
	 * committed when it ends" are established rather than improvised per slice (ADR-0017) — and,
	 * since ticket 06, the user's own Historical Maps rendered from their own Project.
	 *
	 * `storage` is here for the two states in which there is no Project to show because there is no
	 * Workspace to show it from — see {@link WorkspaceRecovery}. Both were reachable and neither was
	 * handled: the page rendered "Opening…" indefinitely.
	 */
	let { session, storage }: { session: EditorSession; storage: WorkspaceStorage } = $props();

	/** Nothing to show, and a reason worth naming, rather than a page that says "Opening…" for ever. */
	const recovering = $derived(session.status === 'unreachable' || storage.awaitingFolder);

	/** Which Historical Map is on screen. The first one, until the user picks another. */
	let selectedImageId = $state('');

	const images = $derived(session.images);
	const shown = $derived(
		images.find((image) => image.imageId === selectedImageId)?.imageId ?? images[0]?.imageId ?? ''
	);

	/**
	 * The ADR-0011 shim for this Project. Recomputed when the open Project changes, because it is
	 * bound to that Project's directory — a stale one would resolve the right image id against the
	 * wrong folder, which is a pane of somebody else's map rather than an error.
	 */
	const imageServiceFetch = $derived(session.imageServiceFetch());
</script>

{#if recovering}
	<WorkspaceRecovery {storage} />
	<p class="mt-6"><a class="link" href={resolve('/')}>Back to all Projects</a></p>
{:else if session.projectProblem}
	<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
		<h2 class="font-semibold">
			{session.projectProblem.kind === 'missing'
				? 'Project not found'
				: 'This Project cannot be opened'}
		</h2>
		<p>{session.projectProblem.message}</p>
		<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
	</div>
{:else if session.openProject}
	<div class="mt-8 flex flex-wrap items-center justify-between gap-4">
		<h2 class="text-2xl font-semibold">{session.openProject.name}</h2>
		<div class="flex flex-col items-end">
			<SaveIndicator saveState={session.saveState} />
			{#if session.saveError}
				<p class="text-sm text-warning">{session.saveError}</p>
			{/if}
		</div>
	</div>

	<!--
		`onchange` and `onblur` both mean "the edit is over" (ADR-0017 rule 1). Neither writes on its
		own: `commitProjectName` is a no-op unless there is a pending write, because tabbing into and
		out of this field must not rewrite `project.json` — the write stamps a fresh `updatedAt`, and
		ADR-0010 is explicit that merely looking at an old Project must not modify files.
	-->
	<label class="floating-label mt-6 block max-w-md">
		<span>Project name</span>
		<input
			class="input w-full"
			value={session.openProject.name}
			oninput={(event) => session.typeProjectName(event.currentTarget.value)}
			onchange={() => session.commitProjectName()}
			onblur={() => session.commitProjectName()}
		/>
	</label>

	<dl class="mt-6 text-sm opacity-70">
		<dt class="font-medium">Folder</dt>
		<dd><code>{session.openDirectory}</code></dd>
		<dt class="mt-2 font-medium">Last saved</dt>
		<dd><time datetime={session.openProject.updatedAt}>{session.openProject.updatedAt}</time></dd>
	</dl>

	<!--
		Adding a Historical Map from a file on this computer (SPEC stories 21, 22, 23).

		Every image becomes a IIIF pyramid, including a small one, because an untiled level-0 image
		cannot be parsed at all (ADR-0003). So this is a job with progress rather than a file input
		that finishes instantly, and the progress region below is what a scholar watching a large
		scan has to go on.
	-->
	<section class="mt-10" aria-labelledby="historical-maps-heading">
		<h3 id="historical-maps-heading" class="text-lg font-semibold">Historical Maps</h3>

		<label class="mt-4 block max-w-md">
			<span class="mb-1 block text-sm">Add a Historical Map from a file</span>
			<input
				class="file-input w-full"
				type="file"
				accept="image/*"
				disabled={session.ingest !== null}
				onchange={(event) => {
					const input = event.currentTarget;
					const file = input.files?.[0];
					// Cleared straight away, so picking the same file twice runs twice: `change` does not
					// fire for an unchanged value, and "nothing happened" is indistinguishable from a
					// silent failure.
					input.value = '';
					if (file) session.ingestImage(file);
				}}
			/>
		</label>

		<!--
			`aria-live="polite"` rather than `role="status"`, which would be the idiomatic choice but for
			the save indicator already being the page's one `status` role — two of them make
			`getByRole('status')` ambiguous, and a test that has to disambiguate is a hint that a
			screen-reader user would have to as well. `aria-atomic` so each update is read as a whole
			sentence rather than as the digits that changed. The announced text carries the same numbers
			as the bar: a screen-reader user is told the tile count, not that something is "loading".
		-->
		<div aria-live="polite" aria-atomic="true" class="mt-4 min-h-6">
			{#if session.ingest}
				{@const ingest = session.ingest}
				<p class="text-sm">
					{#if ingest.phase === 'inspecting'}
						Reading {session.ingestLabel}…
					{:else if ingest.phase === 'opening'}
						Opening {session.ingestLabel}…
					{:else if ingest.phase === 'tiling'}
						Preparing {session.ingestLabel}: tile {ingest.tilesWritten} of {ingest.tileCount}
					{:else if ingest.phase === 'finishing'}
						Finishing {session.ingestLabel}…
					{:else}
						Added {session.ingestLabel}
					{/if}
				</p>
				<progress
					class="progress mt-1 w-full max-w-md"
					value={ingest.fraction}
					max="1"
					aria-label="Preparing {session.ingestLabel}"
				></progress>
			{/if}
		</div>

		{#if session.ingestError}
			<div role="alert" class="mt-4 alert max-w-prose alert-warning">
				<p>{session.ingestError}</p>
			</div>
		{/if}

		{#if images.length > 0}
			<!--
				One button per Historical Map, so a Project with several of them can be moved between
				(SPEC story 31 is about zooming into *my* map, and a scholar comparing two sheets has
				two). `aria-current` rather than a visual cue alone: which map is on screen is
				information, and a border is not announced.
			-->
			<ul class="mt-4 flex flex-wrap gap-2" aria-label="Historical Maps in this Project">
				{#each images as image (image.imageId)}
					<li>
						<button
							class="btn btn-sm"
							class:btn-primary={image.imageId === shown}
							aria-current={image.imageId === shown ? 'true' : undefined}
							onclick={() => (selectedImageId = image.imageId)}
						>
							<code>{image.imageId}</code>
						</button>
					</li>
				{/each}
			</ul>

			<!--
				The pane itself. Every byte it draws comes out of the ProjectStore through the ADR-0011
				shim — no static-asset fallback, no URL anywhere — which is what makes deep zoom into the
				user's own map work with no network at all (stories 31 and 8).
			-->
			{#if imageServiceFetch && shown}
				<div class="mt-4">
					<HistoricalMapPane
						imageId={shown}
						fetchTile={imageServiceFetch}
						label="Historical Map, unwarped, in image pixel coordinates"
					/>
				</div>
			{/if}
		{:else if !session.ingest}
			<p class="mt-4 max-w-prose">
				This Project has no Historical Maps yet. Aligning and annotating them arrive in later
				slices; what works now is bringing one in — the image is converted to a IIIF pyramid,
				written into the Project as you watch, and shown here to zoom into.
			</p>
		{/if}
	</section>

	<p class="mt-6"><a class="link" href={resolve('/')}>Back to all Projects</a></p>
{:else}
	<p class="mt-8">Opening…</p>
{/if}
