<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		describeBytes,
		toDirectoryName,
		unusedHistoricalMaps,
		type ProjectSummary,
		type WorkspaceHistoricalMap
	} from '@ballastella/core';

	import type { EditorSession } from '../editor-session.svelte.js';
	import PublishDialog from '../publish/PublishDialog.svelte';
	import ModalDialog from './ModalDialog.svelte';

	/**
	 * The hub: every Project in the Workspace, and the whole of its lifecycle.
	 *
	 * This is the same page a Reader gets from a Published Site (ADR-0008) — a scholar's
	 * portfolio at one address rather than a scatter of unrelated URLs — so it is a feature and
	 * not scaffolding.
	 */
	let { session }: { session: EditorSession } = $props();

	let creating = $state(false);
	let newName = $state('');

	let renaming = $state<ProjectSummary | null>(null);
	let renamedTo = $state('');

	let deleting = $state<ProjectSummary | null>(null);

	/**
	 * The Publish dialog is open (ticket 16).
	 *
	 * On the hub rather than inside a Project, because ADR-0008 makes the **Workspace** the Published
	 * Site: one `index.html`, one shared viewer, one hub page listing every Project. Publishing from
	 * inside one Project would imply a per-Project site, which is the deferred second output mode.
	 */
	let publishing = $state(false);

	/**
	 * The import dialog is open. Tracked separately from `session.pendingImport`, which only exists
	 * once a zip has been read: choosing the file, the refusal of a bad one, and the collision
	 * question are three states of one dialog, because they are one task.
	 */
	let importing = $state(false);
	let chosen = $state<FileList | null>(null);
	/** The directory name the import will use, editable once a collision has been reported. */
	let importDirectory = $state('');

	const dateFormat = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
	const lastTouched = (updatedAt: string) => {
		const when = new Date(updatedAt);
		return Number.isNaN(when.valueOf()) ? 'never' : dateFormat.format(when);
	};

	const startCreating = () => {
		newName = '';
		session.dismissProjectProblem();
		creating = true;
	};

	const create = async () => {
		creating = false;
		await session.createProject(newName);
	};

	const startRenaming = (project: ProjectSummary) => {
		renamedTo = project.name;
		renaming = project;
	};

	const rename = async () => {
		const project = renaming;
		renaming = null;
		if (project) await session.renameProject(project.directory, renamedTo);
	};

	const remove = async () => {
		const project = deleting;
		deleting = null;
		if (project) await session.deleteProject(project.directory);
	};

	const startImporting = () => {
		chosen = null;
		importDirectory = '';
		session.cancelImport();
		importing = true;
	};

	const cancelImporting = () => {
		importing = false;
		session.cancelImport();
	};

	/**
	 * The folder the typed name would actually become.
	 *
	 * Through `toDirectoryName` rather than straight off the input, because a folder name is the
	 * Project's identity (ADR-0008) and the field must not be able to produce one the Workspace
	 * cannot hold. Bound raw, it handed `Workspace.importProject` whatever was typed: `..`, a
	 * backslash, or — the one that mattered — a different case of the name the collision had just
	 * reported, which on macOS and Windows is the *same folder*, so the user's own Project was
	 * overwritten by the affordance offered to protect it (SPEC story 14).
	 *
	 * `''` when there is nothing usable in the field, which is what disables the button rather than
	 * letting it throw.
	 */
	const importAs = $derived(
		/[a-z0-9]/i.test(importDirectory) ? toDirectoryName(importDirectory) : ''
	);

	/**
	 * Read the chosen zip, then write it — unless reading refused it, or the directory name it wants
	 * is taken, in which case the dialog stays open holding the answer it needs.
	 */
	const runImport = async () => {
		let pending = session.pendingImport;
		if (!pending) {
			const file = chosen?.item(0);
			if (!file) return;
			// Reads and validates; still nothing written, so a refusal here costs the user nothing.
			await session.prepareImport(file);
			pending = session.pendingImport;
			if (!pending) return;
			importDirectory = pending.directory;
		}
		if (!importAs) return;
		const imported = await session.confirmImport(importAs);
		if (imported) importing = false;
		// A collision came back with a free name; offer it rather than making the user invent one.
		else if (session.pendingImport) importDirectory = session.pendingImport.directory;
	};

	// ── The Workspace's Historical Maps (SPEC stories 63–65, 98) ────────────────────────────────
	//
	// On the hub rather than inside a Project for the same reason Publish is: a pyramid belongs to the
	// **Workspace** and is drawn by any number of Projects (ADR-0023), so "what does this Workspace
	// hold, and what can I reclaim" is a question about the Workspace and has nowhere else to be asked.
	//
	// Deliberately no Align button and no way to add a map from here. Alignment is reachable only from a
	// Layer card, so there is exactly one answer to "how do I align this?" and an Alignment is always
	// made against the Base Map of the Project whose argument it serves; and a map is added from inside
	// the Project that will draw it.

	/** The map whose deletion is being confirmed, or `null`. */
	let deletingMap = $state<WorkspaceHistoricalMap | null>(null);

	/** What just happened to a Historical Map, for the live region. `''` when nothing has. */
	let historicalMapMessage = $state('');

	// Walked when the hub appears and again whenever the Project list changes, because the Project
	// documents are where used-by is read from — a Project deleted here can be the last one that drew a
	// map, and a stale list would offer to delete a map it still says is in use. Not on every render:
	// this weighs every file under `images/`.
	$effect(() => {
		void session.projects;
		void session.refreshHistoricalMaps();
	});

	const historicalMapsBytes = $derived(
		session.historicalMaps.reduce((sum, map) => sum + map.bytes, 0)
	);
	// Core's figure, not a second one derived here. This is the sentence the ticket exists for — "of
	// which 340 MB is used by no Project" — and publishing's hosting warning states the same number
	// from `unusedHistoricalMapBytes`; two reductions spelling it out separately is how one screen ends
	// up quoting two totals for one Workspace.
	const unused = $derived(unusedHistoricalMaps(session.historicalMaps));

	/** Where a map's tiles are, in the words the list uses. Visible text, never a colour or a title. */
	const whereTilesAre = (map: WorkspaceHistoricalMap): string =>
		map.tiles === 'in-workspace'
			? 'Tiles in this Workspace'
			: `Tiles on ${map.library || 'a Library’s server'}`;

	/** How many files a map is, beside what it weighs: 3 files and 31 000 files are different news. */
	const fileCount = (map: WorkspaceHistoricalMap): string =>
		`${map.files} ${map.files === 1 ? 'file' : 'files'}`;

	/**
	 * Which Projects draw a map, and plainly when none do (SPEC story 63).
	 *
	 * A Project this build cannot read is named separately and in its own words. It is not folded into
	 * "used by", which would claim something unknown, and it is emphatically not left out — a map whose
	 * only user is a Project from next year's build must not be described as one nothing uses.
	 */
	const usedBy = (map: WorkspaceHistoricalMap): string => {
		const unreadable = map.mightBeUsedBy.map((project) => project.name).join(', ');
		const caveat = unreadable
			? ` ${map.mightBeUsedBy.length === 1 ? 'It' : 'They'} may also be drawn by ${unreadable}, made with a newer version of Ballastella, which this one cannot read.`
			: '';
		if (map.usedBy.length > 0) {
			return `Used by ${map.usedBy.map((project) => project.name).join(', ')}.${caveat}`;
		}
		return unreadable
			? `No Project this version can read uses this map. It may be drawn by ${unreadable}, made with a newer version of Ballastella.`
			: 'No Project uses this map.';
	};

	/**
	 * Ask to delete a map.
	 *
	 * **Always through the confirmation, whatever the list says**, because deletion is destructive and
	 * irreversible and the list is a moment old. Sending an apparently-used map straight to core on the
	 * assumption it would be refused meant that a list which had gone stale — the last Project drawing
	 * that map deleted in another tab — deleted a pyramid on a single click, with no dialog at all: the
	 * confirmation was skipped in exactly the case where it was doing the work.
	 *
	 * Whether it is in use is still core's decision, taken from the Projects' own documents at the
	 * moment of the deletion, so what the dialog says about the Projects is the list's account and what
	 * happens next is the Workspace's.
	 */
	const askToDelete = (map: WorkspaceHistoricalMap) => {
		historicalMapMessage = '';
		session.dismissHistoricalMapError();
		deletingMap = map;
	};

	/** The Projects the list believes draw the map being confirmed, in one sentence, or `''`. */
	const drawnByNow = $derived.by(() => {
		if (!deletingMap) return '';
		const names = [...deletingMap.usedBy, ...deletingMap.mightBeUsedBy].map(
			(project) => project.name
		);
		return names.join(', ');
	});

	const removeMap = async () => {
		const map = deletingMap;
		deletingMap = null;
		if (!map) return;
		// Through core either way: the list on screen may be a moment old, and whether a map is in use is
		// decided from the Projects' own documents at the moment of the deletion rather than from it.
		const deleted = await session.deleteHistoricalMap(map.imageId);
		historicalMapMessage = deleted
			? `Deleted ${map.label || map.imageId}, reclaiming ${describeBytes(map.bytes)}.`
			: '';
	};

	// ── The offline Base Map cache (ADR-0025) ───────────────────────────────────────────────────
	//
	// Beside the Historical Maps and for the same reason: it is Workspace-level, it is the other thing
	// in here that can be several hundred megabytes, and "what does this Workspace hold, and what can
	// I reclaim" is a question about the Workspace. Clearing it makes every Project report itself not
	// available offline — which needs no code here, because that claim is computed from these files.

	let baseMapCache = $state<{ tiles: number; bytes: number } | null>(null);
	/** What just happened to the cache, for the live region. `''` when nothing has. */
	let baseMapCacheMessage = $state('');
	let clearingCache = $state(false);

	// Re-read whenever the Project list changes, alongside the Historical Maps walk: this is one
	// `list` of `base-map/tiles/` and a `size` per tile, never a `read`.
	$effect(() => {
		void session.projects;
		void cacheGeneration;
		void (async () => {
			baseMapCache = await session.baseMapCacheSize();
		})();
	});

	/** Bumped after a clear, so the line follows the disk rather than a tally kept here. */
	let cacheGeneration = $state(0);

	const clearCache = async () => {
		clearingCache = false;
		const cleared = await session.clearBaseMapCache();
		cacheGeneration += 1;
		baseMapCacheMessage =
			cleared === 0
				? 'There were no cached Base Map tiles to remove.'
				: `Removed ${cleared} cached Base Map ${cleared === 1 ? 'tile' : 'tiles'}. Every Project now needs a network connection for its Base Map until you make it available offline again.`;
	};

	/** A transfer in flight, which the Export buttons must not lose focus to (SPEC story 95). */
	const transferring = $derived(session.transfer !== null && !session.transfer.finished);

	/** The announced progress line. Empty when nothing is moving, so the region says nothing. */
	const transferMessage = $derived.by(() => {
		const transfer = session.transfer;
		if (!transfer) return '';
		const verb = transfer.kind === 'export' ? 'Exporting' : 'Importing';
		if (transfer.finished) {
			return transfer.kind === 'export'
				? `Exported ${transfer.subject}: ${transfer.totalFiles} files.`
				: `Imported ${transfer.subject}: ${transfer.totalFiles} files.`;
		}
		return `${verb} ${transfer.subject}: ${transfer.files} of ${transfer.totalFiles} files.`;
	});
</script>

<section class="mt-8">
	<div class="flex flex-wrap items-baseline justify-between gap-4">
		<h2 class="text-2xl font-semibold">Projects</h2>
		<div class="flex flex-wrap gap-2">
			<!-- The only way in for a Firefox, Safari, or iPad user, whose Workspace lives in storage
			     they cannot see (ADR-0001), so it sits beside New Project rather than in a menu. -->
			<button class="btn" onclick={startImporting}>Import Project…</button>
			<!-- The Workspace is the site (ADR-0008), so Publish belongs to the hub and not to a
			     Project. -->
			<button class="btn" onclick={() => (publishing = true)}>Publish…</button>
			<button class="btn btn-primary" onclick={startCreating}>New Project</button>
		</div>
	</div>

	<PublishDialog {session} bind:open={publishing} />

	<!--
		Always rendered, empty when idle: an `aria-live` region inserted at the same moment as its
		first text is not reliably announced.

		`aria-live="polite"` and **not** `role="status"`, which is this app's settled convention
		wherever the save indicator is also on screen — and since ticket 04 the save indicator is on
		the navigation bar, so it is on screen *here too*. Two `status` roles make `getByRole('status')`
		a strict-mode violation, which is a hint that a screen-reader user would have to disambiguate
		as well.
	-->
	<p
		aria-live="polite"
		aria-atomic="true"
		class="mt-2 text-sm opacity-80"
		data-transfer={session.transfer?.kind ?? ''}
	>
		{transferMessage}
	</p>

	{#if session.transferError && !importing}
		<!-- An export that failed — another tab deleted the Project, a folder grant lapsed, a Project
		     too large for one zip. This used to be rendered *only* inside the import dialog, so a
		     failed export blanked the status line and said nothing at all: on the path ADR-0001 makes
		     the only way out, indistinguishable from a click that did not register. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-error">
			<p>{session.transferError}</p>
		</div>
	{/if}

	{#if session.projectProblem?.kind === 'reserved-name'}
		<!-- ADR-0023: `images/`, `alignments/`, and `base-map/` belong to the Workspace, so a Project
		     cannot have one of those folder names. Here rather than in the dialog, which has already
		     closed by the time `createProject` answers, and beside the list rather than over it: the
		     Workspace is fine and every other Project stays visible. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
			<p data-testid="reserved-name">{session.projectProblem.message}</p>
		</div>
	{/if}

	{#if session.status === 'unreachable'}
		<!-- ADR-0008: a normal state with a recovery, never an error boundary. -->
		<div role="alert" class="mt-6 alert flex-col items-start alert-warning">
			<h3 class="font-semibold">Workspace not reachable</h3>
			<p>
				Your Workspace could not be opened, so the Projects in it cannot be listed. Nothing has been
				lost — it is still wherever it was.
			</p>
			{#if session.unreachableDetail}
				<p class="text-sm opacity-80">The browser reported: {session.unreachableDetail}</p>
			{/if}
			<button class="btn btn-sm" onclick={() => session.refresh()}>Locate Workspace again</button>
		</div>
	{:else if session.status === 'loading'}
		<p class="mt-6">Looking for your Projects…</p>
	{:else if session.projects.length === 0}
		<p class="mt-6">
			No Projects yet. A Project holds the Historical Maps you are working with, the Alignments you
			make, and the Annotations you write.
		</p>
	{:else}
		<ul class="mt-6 flex flex-col gap-3">
			{#each session.projects as project (project.directory)}
				<li class="card bg-base-100 card-border">
					<div class="card-body flex-row flex-wrap items-center justify-between gap-4">
						<div>
							<h3 class="text-lg font-medium">
								<a class="link" href={resolve(`/?p=${encodeURIComponent(project.directory)}`)}>
									{project.name}
								</a>
							</h3>
							<p class="text-sm opacity-70">
								Last saved <time datetime={project.updatedAt}>{lastTouched(project.updatedAt)}</time
								>
								· folder <code>{project.directory}</code>
							</p>
							{#if project.problem === 'format-too-new'}
								<p class="text-sm text-warning">Made with a newer version of Ballastella.</p>
							{:else if project.problem === 'unreadable'}
								<p class="text-sm text-warning">Its project.json could not be read.</p>
							{/if}
						</div>
						<div class="flex flex-wrap gap-2">
							<button
								class="btn btn-sm"
								onclick={() => startRenaming(project)}
								disabled={project.problem !== null}
							>
								Rename<span class="sr-only"> {project.name}</span>
							</button>
							<button
								class="btn btn-sm"
								onclick={() => session.duplicateProject(project.directory)}
								disabled={project.problem !== null}
							>
								Duplicate<span class="sr-only"> {project.name}</span>
							</button>
							<!-- Available even for a Project this build cannot open: a Project from a newer
							     version is the one a user most needs to get out of a browser they cannot see
							     into, and export never parses `project.json` (ADR-0010). -->
							<!-- `aria-disabled`, not `disabled`. A `disabled` button is removed from the tab
							     order the moment it is pressed, so a keyboard user's focus fell to `<body>`
							     for the length of the export and was not restored when it came back —
							     leaving them to tab in from the top of the page after every export
							     (SPEC story 95, WCAG 2.4.3). -->
							<button
								class="btn btn-sm"
								class:btn-disabled={transferring}
								aria-disabled={transferring}
								onclick={() => !transferring && session.exportProject(project)}
							>
								Export<span class="sr-only"> {project.name}</span>
							</button>
							<button class="btn btn-outline btn-error btn-sm" onclick={() => (deleting = project)}>
								Delete<span class="sr-only"> {project.name}</span>
							</button>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<!-- The Workspace's shared pool (ADR-0023). Hidden while the Workspace itself cannot be reached,
     because a list of nothing under a "not reachable" banner reads as "your maps are gone". -->
{#if session.status !== 'unreachable'}
	<section class="mt-10">
		<h2 class="text-2xl font-semibold">Historical Maps</h2>
		<p class="mt-1 text-sm opacity-70">
			Every Historical Map in this Workspace. A map is prepared once and any number of Projects can
			draw it, so these are shared: deleting one takes it out of the Workspace entirely.
		</p>

		<!-- Always rendered, empty when there is nothing to say: an `aria-live` region inserted at the
		     same moment as its first text is not reliably announced.

		     `aria-live="polite"` and not `role="status"`, which is this app's settled convention wherever
		     a page already has one status region — the transfer line above owns it here, exactly as the
		     save indicator owns it inside a Project (`LayerList`, `AlignmentWorkspace`, `PublishDialog`,
		     and `UndoControl` all say so). A second `role="status"` makes `getByRole('status')` a strict
		     mode violation, which is what pushed two existing tests off the role and onto attribute
		     locators that stay green with the live region deleted. -->
		<p aria-live="polite" class="mt-2 text-sm opacity-80" data-testid="historical-map-status">
			{historicalMapMessage}
		</p>

		{#if session.historicalMapError}
			<!-- SPEC story 64: the refusal, naming the Projects that would break. A warning beside the
			     list rather than a dialog over it — nothing has happened, and every other map stays
			     reachable. -->
			<div role="alert" class="mt-2 alert flex-col items-start alert-warning">
				<p data-testid="historical-map-refused">{session.historicalMapError}</p>
			</div>
		{/if}

		{#if session.historicalMapsLoading && session.historicalMaps.length === 0}
			<p class="mt-4">Looking at what this Workspace holds…</p>
		{:else if session.historicalMaps.length === 0}
			<p class="mt-4" data-testid="no-historical-maps">
				No Historical Maps yet. Open a Project and add one from there — a map is added inside the
				Project that will draw it first, and every other Project can then use the same map.
			</p>
		{:else}
			<ul class="mt-4 flex flex-col gap-3">
				{#each session.historicalMaps as map (map.imageId)}
					<li class="card bg-base-100 card-border" data-testid="historical-map">
						<div class="card-body flex-row flex-wrap items-center justify-between gap-4">
							<div>
								<h3 class="text-lg font-medium">{map.label || map.imageId}</h3>
								<!-- Visible text rather than a tooltip or a badge colour (SPEC story 111): where
								     the tiles are is the fact that decides whether this map works on a train. -->
								<p class="text-sm opacity-70">
									{describeBytes(map.bytes)} in {fileCount(map)} · {whereTilesAre(map)} · folder
									<code>{map.imageId}</code>
								</p>
								<p class="text-sm opacity-70" data-testid="used-by">{usedBy(map)}</p>
							</div>
							<div class="flex flex-wrap gap-2">
								<button class="btn btn-outline btn-error btn-sm" onclick={() => askToDelete(map)}>
									Delete<span class="sr-only"> {map.label || map.imageId}</span>
								</button>
							</div>
						</div>
					</li>
				{/each}
			</ul>
			<p class="mt-3 text-sm opacity-70" data-testid="historical-maps-total">
				{session.historicalMaps.length}
				{session.historicalMaps.length === 1 ? 'Historical Map' : 'Historical Maps'}, {describeBytes(
					historicalMapsBytes
				)} in all{unused.maps.length > 0
					? `, of which ${describeBytes(unused.bytes)} is used by no Project`
					: ''}.
			</p>
		{/if}

		<!--
			The offline Base Map, listed beside the Historical Maps and reclaimable from here (ADR-0025).
			Visible text and a real button, never a badge or an icon (SPEC story 111).
		-->
		<h3 class="mt-8 text-xl font-semibold">Offline Base Map</h3>
		<p class="mt-1 text-sm opacity-70" data-testid="base-map-cache">
			{#if baseMapCache === null}
				Looking at what this Workspace holds…
			{:else if baseMapCache.tiles === 0}
				No Base Map tiles are kept in this Workspace, so every Project needs a network connection to
				draw its Base Map. Open a Project and choose “Make this Project available offline” to keep
				the tiles its own work covers.
			{:else}
				{describeBytes(baseMapCache.bytes)} in
				{baseMapCache.tiles}
				{baseMapCache.tiles === 1 ? 'tile' : 'tiles'}, shared by every Project in this Workspace. A
				Project draws its Base Map with no network connection when the tiles its work covers are all
				here.
			{/if}
		</p>
		<p aria-live="polite" class="mt-2 text-sm opacity-80" data-testid="base-map-cache-status">
			{baseMapCacheMessage}
		</p>
		{#if baseMapCache !== null && baseMapCache.tiles > 0}
			<button
				class="btn mt-2 btn-outline btn-error btn-sm"
				data-testid="clear-base-map-cache"
				onclick={() => (clearingCache = true)}
			>
				Remove the offline Base Map
			</button>
		{/if}
	</section>
{/if}

<ModalDialog
	bind:open={() => clearingCache, (open) => (clearingCache = open)}
	title="Remove the offline Base Map"
>
	<p>
		Remove all {baseMapCache?.tiles ?? 0} cached Base Map
		{(baseMapCache?.tiles ?? 0) === 1 ? 'tile' : 'tiles'} and reclaim
		{describeBytes(baseMapCache?.bytes ?? 0)}?
	</p>
	<p class="mt-3 text-sm opacity-70" data-testid="clear-cache-consequence">
		Every Project in this Workspace will stop being available offline and will need a network
		connection to draw its Base Map. Nothing else is touched: your Historical Maps, Alignments, and
		Annotations are not part of this, and any Project can be made available offline again.
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (clearingCache = false)}>Cancel</button>
		<button class="btn btn-error" onclick={clearCache}>Remove the offline Base Map</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => deletingMap !== null, (open) => !open && (deletingMap = null)}
	title="Delete Historical Map"
>
	<p>
		Delete <strong>{deletingMap?.label || deletingMap?.imageId}</strong> and reclaim
		{describeBytes(deletingMap?.bytes ?? 0)}? Its tiles, the record of where it came from, and the
		Alignment placing it on the earth all go with it. This cannot be undone.
	</p>
	<!-- What the list believes, said as a belief. The decision is taken again from the Projects' own
	     documents when this is confirmed, so a map still in use is refused here rather than deleted —
	     and a map the list thinks is in use, whose last Project has since gone, is deleted having been
	     confirmed rather than on one unguarded click. -->
	<p class="mt-3 text-sm opacity-70" data-testid="delete-map-consequence">
		{#if drawnByNow}
			{drawnByNow} still {deletingMap &&
			deletingMap.usedBy.length + deletingMap.mightBeUsedBy.length === 1
				? 'draws'
				: 'draw'} this map, so deleting it will be refused rather than leaving a Layer that draws nothing.
		{:else}
			No Project draws this map, so nothing on screen will change.
		{/if}
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (deletingMap = null)}>Cancel</button>
		<button class="btn btn-error" onclick={removeMap}>Delete Historical Map</button>
	{/snippet}
</ModalDialog>

<ModalDialog bind:open={creating} title="New Project">
	<label class="floating-label">
		<span>Project name</span>
		<input
			class="input w-full"
			bind:value={newName}
			placeholder="Amsterdam 1625"
			onkeydown={(event) => event.key === 'Enter' && create()}
		/>
	</label>
	{#snippet actions()}
		<button class="btn" onclick={() => (creating = false)}>Cancel</button>
		<button class="btn btn-primary" onclick={create}>Create Project</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => renaming !== null, (open) => !open && (renaming = null)}
	title="Rename Project"
>
	<label class="floating-label">
		<span>New name</span>
		<input
			class="input w-full"
			bind:value={renamedTo}
			onkeydown={(event) => event.key === 'Enter' && rename()}
		/>
	</label>
	<p class="mt-3 text-sm opacity-70">
		Two Projects may share a name; the folder this one lives in does not change, so a link you have
		already shared keeps working.
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (renaming = null)}>Cancel</button>
		<button class="btn btn-primary" onclick={rename}>Rename</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => importing, (open) => (open ? (importing = true) : cancelImporting())}
	title="Import Project"
>
	{#if session.pendingImport?.collision}
		<!-- SPEC story 14. The collision is reported and a choice required; nothing has been written,
		     and the existing Project is untouched whichever way this goes (ADR-0008). -->
		<div role="alert" class="alert flex-col items-start alert-warning">
			<p>{session.pendingImport.collision}</p>
		</div>
		<label class="floating-label mt-4">
			<span>Import as folder</span>
			<input
				class="input w-full"
				bind:value={importDirectory}
				onkeydown={(event) => event.key === 'Enter' && runImport()}
			/>
		</label>
		<p class="mt-3 text-sm opacity-70">
			“{session.pendingImport.name}” will be a separate Project
			{#if importAs && importAs !== importDirectory.trim()}
				in the folder <code>{importAs}</code>, which is what that name becomes
			{:else}
				in this folder
			{/if}. Two Projects may share a name; the folder is what tells them apart.
		</p>
	{:else}
		<label class="floating-label">
			<span>Project zip</span>
			<input
				class="file-input w-full"
				type="file"
				accept=".zip,application/zip"
				bind:files={chosen}
			/>
		</label>
		<p class="mt-3 text-sm opacity-70">
			A Project zip holds one Project. It is added to this Workspace; nothing already here is
			replaced.
		</p>
	{/if}
	{#if session.transferError}
		<!-- The refusals: no project.json, a damaged archive, an entry whose bytes do not match its
		     checksum, one that would be written outside the Project, an archive that declares more than
		     will fit, a missing referenced file, or ADR-0010's Project from a newer version. Each one has
		     already left the Workspace untouched.

		     Outside the collision branch, not inside the non-collision one. Once a collision was
		     reported this block was not rendered at all, so emptying the folder field and pressing
		     "Import under this name" threw and the dialog showed nothing — a dead button. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-error">
			<p>{session.transferError}</p>
		</div>
	{/if}
	{#snippet actions()}
		<button class="btn" onclick={cancelImporting}>Cancel</button>
		<button
			class="btn btn-primary"
			onclick={runImport}
			disabled={session.pendingImport?.collision
				? !importAs
				: !session.pendingImport && !chosen?.length}
		>
			{session.pendingImport?.collision ? 'Import under this name' : 'Import Project'}
		</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => deleting !== null, (open) => !open && (deleting = null)}
	title="Delete Project"
>
	<!-- ADR-0023: a Historical Map's pyramid and its Alignment belong to the **Workspace** and are
	     shared, so deleting a Project never deletes them. This said the opposite, a few lines above a
	     list that says so plainly. Wording only — what `deleteProject` removes is unchanged. -->
	<p>
		Delete <strong>{deleting?.name}</strong> and everything in it? Its Layers and Annotations go with
		it. This cannot be undone.
	</p>
	<p class="mt-3 text-sm opacity-70">
		The Historical Maps it drew stay in the Workspace, with their Alignments, because other Projects
		may use them. Delete those from the Historical Maps list if you no longer want them.
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (deleting = null)}>Cancel</button>
		<button class="btn btn-error" onclick={remove}>Delete Project</button>
	{/snippet}
</ModalDialog>
