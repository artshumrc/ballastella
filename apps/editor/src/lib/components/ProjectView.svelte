<script lang="ts">
	import { tick } from 'svelte';

	import { resolve } from '$app/paths';
	import { resolveBaseMap } from '@ballastella/core';

	import AlignmentWorkspace from '$lib/alignment/AlignmentWorkspace.svelte';
	import AddRemoteMap from '$lib/remote-iiif/AddRemoteMap.svelte';
	import MirrorMap from '$lib/remote-iiif/MirrorMap.svelte';
	import { MirrorMap as MirrorMapJob } from '$lib/remote-iiif/mirror-map.svelte.js';
	import UnwarpedView from '$lib/remote-iiif/UnwarpedView.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import UndoControl from '$lib/undo/UndoControl.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
	import SaveIndicator from './SaveIndicator.svelte';
	import WorkspaceRecovery from './WorkspaceRecovery.svelte';

	/**
	 * One Project, selected client-side from `?p=<folder>` (ADR-0008).
	 *
	 * The Layer stack still arrives in a later slice. What is here is the frame it hangs in, the
	 * autosave rules it will follow — the name field below is the app's first editable value, so it
	 * is where "typing coalesces into one write" and "the edit is committed when it ends" are
	 * established rather than improvised per slice (ADR-0017) — the user's own Historical Maps
	 * rendered from their own Project since ticket 06, and since ticket 07 the Control Point pairing
	 * that is the reason the tool exists.
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

	/**
	 * Which referenced Historical Map is being read unwarped, by image id. `''` for none.
	 *
	 * Only one at a time: each `TriiiceratopsViewer` is an OpenSeadragon instance with its own WebGL
	 * or canvas drawer, and the page already carries two MapLibre contexts.
	 */
	let unwarpedImageId = $state('');
	const unwarped = $derived(
		session.referencedImages.find((image) => image.imageId === unwarpedImageId) ?? null
	);

	/**
	 * Which of this Project's remote-origin records still fetch from a library, and which have been
	 * copied (ticket 15).
	 *
	 * Split on whether the pyramid is in the Project, not on what a Layer claims — see
	 * `EditorSession.remoteOrigins`. The two are listed apart because the difference is the whole point
	 * of ADR-0007: one of them makes a Published Site need the network and stops working when the
	 * library reorganises, and the other does not.
	 */
	const origins = $derived(session.remoteOrigins);

	/**
	 * One mirroring job for the whole list, not one per row.
	 *
	 * Mirroring is deliberately one image at a time (ticket 15's Out of scope: no bulk copying, partly
	 * to keep the host-load decision explicit), so a second job would be a second way to start a copy
	 * that the first one's `busy` guard cannot see.
	 */
	const mirror = new MirrorMapJob(() => session);

	/** What finishing an interrupted copy did, or `''` when there is nothing to say. */
	let finishReport = $state('');
	let finishStatus = $state<HTMLElement | undefined>();

	/**
	 * Finish an offline copy whose tiles landed but whose files never caught up (ticket 15).
	 *
	 * Nothing is fetched: the pyramid is already in the folder, and what is missing is the Alignment
	 * rewrite and the Layer's `imageMode`. See `EditorSession.finishInterruptedCopy`.
	 *
	 * **The button is destroyed by its own success**, which is the `LayerList` delete problem again — a
	 * keyboard user is dropped to `document.body` and has to Tab back in past two MapLibre panes. So the
	 * outcome is announced *and* focused, and focus is only taken when the thing that had it has gone.
	 */
	const finishCopy = async (imageId: string): Promise<void> => {
		finishReport = '';
		const label = origins.mirrored.find((image) => image.imageId === imageId)?.label || imageId;
		const finished = await session.finishInterruptedCopy(imageId);
		finishReport = finished
			? `${label} is recorded as an offline copy. Nothing in this Project reads it from the ` +
				`library any more.`
			: session.saveError ||
				`${label} could not be recorded as an offline copy, so this Project's files still say it ` +
					`is read from the library.`;
		await tick();
		if (document.activeElement === document.body) finishStatus?.focus();
	};

	/**
	 * The app's one online signal, so a referenced Historical Map can say why it is not there.
	 *
	 * ADR-0012's offline claim has one honest exception, and this is where it has to be said: a
	 * referenced Historical Map's tiles are on somebody else's server, so with no connection there is
	 * nothing to draw and no amount of caching would change that (fence 2 — a partially cached remote
	 * pyramid renders *with holes*, which reads as corruption). Ticket 17's degradation contract is the
	 * shape of the answer: say so, name the host, and leave the rest of the Project working.
	 *
	 * Read from `InstalledApp` rather than by adding a second `online`/`offline` listener here, because
	 * two sources of truth for "is there a network" would eventually disagree — and this is the same
	 * signal the update prompt uses to know whether taking an update is possible.
	 */
	const installedApp = useInstalledApp();

	/** The hosts a Reader — or the author, right now — cannot reach. Named, never counted. */
	const unreachableHosts = $derived([
		...new Set(origins.referenced.map((image) => new URL(image.service).hostname))
	]);
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
		<!--
			The way back from a mis-aimed drag or a wrongly deleted Control Point (SPEC story 38), beside
			the save indicator: one says the tool has the change and the other says it can be taken back,
			which is the pair a scholar needs on the page where the destructive gestures are.
		-->
		<UndoControl {session} />
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

	<!--
		The Project's Layer stack over its Base Map (ticket 09). A pane of its own, because the stack is
		the whole Project composed rather than one Historical Map being aligned — and the Layer count
		here is what tells a user there is something to go and see.
	-->
	<p class="mt-6">
		<a
			class="btn btn-sm"
			data-testid="open-layers"
			href="{resolve('/layers')}?p={session.openDirectory}"
		>
			Layers ({session.openProject.layers.length})
		</a>
	</p>

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
				<!--
					A real button, beside the bar and reachable by tab (stories 95 and 96). A gigapixel
					scan is thousands of tiles and several minutes; picking the wrong file and having no
					way out of it is the thing `ingest.ts` claimed to support and the app never wired up.
					The job cleans up after itself, so cancelling leaves the Project as it was.
				-->
				<button
					type="button"
					class="btn mt-2 btn-sm"
					aria-label="Cancel preparing {session.ingestLabel}"
					onclick={() => session.cancelIngest()}
					disabled={ingest.phase === 'done'}>Cancel</button
				>
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
				The Historical Map beside the Base Map, and the pairing between them — the core act of
				the application (SPEC stories 30 and 32–37).

				Every byte the left pane draws comes out of the ProjectStore through the ADR-0011 shim —
				no static-asset fallback, no URL anywhere — which is what makes deep zoom into the user's
				own map work with no network at all (stories 31 and 8).
			-->
			{#if imageServiceFetch && shown}
				<div class="mt-6">
					<AlignmentWorkspace
						{session}
						imageId={shown}
						fetchTile={imageServiceFetch}
						baseMapId={resolveBaseMap(session.openProject.baseMap).entry.id}
					/>
				</div>
			{/if}
		{:else if !session.ingest}
			<p class="mt-4 max-w-prose">
				This Project has no Historical Maps yet. What works now is bringing one in — the image is
				converted to a IIIF pyramid, written into the Project as you watch, and shown here beside a
				Base Map to align onto the world.
			</p>
		{/if}
	</section>

	<!--
		Adding a Historical Map from a library's IIIF endpoint (ticket 14). A section of its own next to
		the file input, because the two are the same act — bringing a map in — reached from two
		different kinds of source, and what differs afterwards is only whether the tiles are ours.
	-->
	<AddRemoteMap {session} />

	<!--
		The Historical Maps this Project references rather than holds (SPEC story 29). Listed apart from
		the local ones and labelled, because it is what decides whether a Published Site needs the
		network and whether the work survives the library reorganising — which is a thing a scholar has
		to be able to see, not a field in a file.
	-->
	{#if origins.referenced.length > 0}
		<section class="mt-10" aria-labelledby="referenced-maps-heading">
			<h3 id="referenced-maps-heading" class="text-lg font-semibold">Referenced Historical Maps</h3>
			<p class="mt-1 max-w-prose text-sm opacity-70">
				These stay on the library's server. A reader of a Published Site of this Project needs a
				network connection to see them, and they stop working if the library reorganises. An offline
				copy fixes both, at the cost of the bytes.
			</p>

			<!--
				SPEC story 8's one honest exception, said rather than left as a blank pane. Naming the host
				is the whole point: "this Historical Map is not here" is unactionable, and "nothing can be
				fetched from gallica.bnf.fr while you are offline" tells an author both why and what to do
				about it before their next trip to the archive. ADR-0012 fence 2 is why the answer is a
				message and not a cache: a partially cached remote pyramid renders *with holes*, which reads
				as corruption rather than as absence.
			-->
			{#if !installedApp.online}
				<div
					role="alert"
					class="mt-4 alert max-w-prose flex-col items-start alert-warning"
					data-testid="referenced-offline"
				>
					<p>
						There is no connection, so nothing can be fetched from {unreachableHosts.join(', ')}.
						These Historical Maps stay blank until there is one. Everything else in this Project —
						its own Historical Maps, its Alignments, and its Annotations — is unaffected and still
						saves.
					</p>
				</div>
			{/if}

			<ul class="mt-4 flex flex-col gap-2" aria-label="Historical Maps referenced by this Project">
				{#each origins.referenced as image (image.imageId)}
					<li class="flex flex-wrap items-center gap-3">
						<span data-testid="referenced-image-label">{image.label || image.imageId}</span>
						<code class="text-xs opacity-70" data-testid="referenced-image-host"
							>{new URL(image.service).hostname}</code
						>
						<button
							class="btn btn-sm"
							type="button"
							data-testid="view-unwarped"
							aria-pressed={unwarpedImageId === image.imageId}
							onclick={() =>
								(unwarpedImageId = unwarpedImageId === image.imageId ? '' : image.imageId)}
						>
							View unwarped
						</button>
						<!-- SPEC stories 27 and 28. Per image, on a referenced Layer, and never in bulk. -->
						<MirrorMap {image} job={mirror} />
					</li>
				{/each}
			</ul>

			{#if session.referencedImageErrors.length > 0}
				<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
					{#each session.referencedImageErrors as failure (failure.imageId)}
						<p>{failure.reason}</p>
					{/each}
				</div>
			{/if}

			{#if unwarped}
				<UnwarpedView image={unwarped} onclose={() => (unwarpedImageId = '')} />
			{/if}
		</section>
	{/if}

	<!--
		The Historical Maps this Project has copied offline (SPEC stories 27, 28). A section of its own
		because the source URI has to stay visible: mirroring keeps `remote.json` precisely so a copy can
		still be cited and traced back to the library it came from (ADR-0007), and a copy nobody can cite
		is a copy that has been orphaned.

		No "View unwarped" here. That viewer reads tiles from the remote service, and the whole claim of an
		offline copy is that nothing goes back to the library — the copied map is in the Historical Maps
		section above, read from this folder through the ADR-0011 shim.
	-->
	{#if origins.mirrored.length > 0}
		<section class="mt-10" aria-labelledby="mirrored-maps-heading">
			<h3 id="mirrored-maps-heading" class="text-lg font-semibold">Offline copies</h3>
			<p class="mt-1 max-w-prose text-sm opacity-70">
				Ballastella holds its own tiles for these, so they work with no network and survive the
				library reorganising. The address each came from is kept so the work can still be cited.
			</p>
			<ul class="mt-4 flex flex-col gap-2" aria-label="Historical Maps copied into this Project">
				{#each origins.mirrored as image (image.imageId)}
					<li class="flex flex-wrap items-center gap-3">
						<span data-testid="mirrored-image-label">{image.label || image.imageId}</span>
						<code class="text-xs break-all opacity-70" data-testid="mirrored-image-source"
							>{image.service}</code
						>
						<!--
							A copy whose tiles landed and whose document writes did not (ticket 15). Said and
							offered rather than left to be discovered: the pyramid is in the folder, so this list
							is where the map now appears, but the Layer still says it is fetched from the library
							— which is what a Published Site of it would do. `EditorSession` has already corrected
							the Layer on screen; this is the button that corrects the files, and it fetches
							nothing.
						-->
						{#if session.unfinishedCopies.includes(image.imageId)}
							<span class="text-sm text-warning" data-testid="unfinished-copy"
								>The tiles are here, but this Project's files still say it is read from the library.</span
							>
							<button
								class="btn btn-sm"
								type="button"
								data-testid="finish-copy"
								onclick={() => finishCopy(image.imageId)}
							>
								Finish the offline copy
							</button>
						{/if}
					</li>
				{/each}
			</ul>

			<!--
				What finishing an interrupted copy did. Announced rather than only drawn (SPEC story 96), and
				focusable so that the keyboard has somewhere to land when the button that was pressed
				disappears with the problem it fixed.
			-->
			<p
				bind:this={finishStatus}
				tabindex="-1"
				class="mt-2 min-h-6 text-sm"
				aria-live="polite"
				aria-atomic="true"
				data-testid="finish-copy-report"
			>
				{finishReport}
			</p>
		</section>
	{/if}

	<!--
		The outcome of a copy, announced from out here rather than from inside the dialog: the dialog closes
		on success, and an announcement added to a subtree that is removed in the same frame is
		indistinguishable from one that never happened.
	-->
	<p class="mt-4 min-h-6 text-sm" aria-live="polite" aria-atomic="true" data-testid="mirror-done">
		{mirror.completed}
	</p>

	<p class="mt-6"><a class="link" href={resolve('/')}>Back to all Projects</a></p>
{:else}
	<p class="mt-8">Opening…</p>
{/if}
