<script lang="ts">
	import { resolve } from '$app/paths';
	import { tick } from 'svelte';
	import {
		describeBytes,
		parseRemoteReference,
		unusedMapImages,
		type ProjectSummary,
		type WorkspaceMapImage
	} from '@ballastella/core';
	import { ProjectCardList } from '@ballastella/ui';

	import { describeAlignmentUsers } from '../alignment/used-by.js';
	import type { EditorSession } from '../editor-session.svelte.js';
	import MapThumbnail from '../map-images/MapThumbnail.svelte';
	import { useWorkspaceHost, type ImportTarget } from '../workspace-storage.svelte.js';
	import ModalDialog from './ModalDialog.svelte';

	/**
	 * The hub: every Project in the Workspace, and the whole of its lifecycle.
	 *
	 * This is the same page a Reader gets from a Published Site (ADR-0008) — a scholar's
	 * portfolio at one address rather than a scatter of unrelated URLs — so it is a feature and
	 * not scaffolding.
	 */
	let { session }: { session: EditorSession } = $props();

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	/**
	 * The mark on the Workspace this hub is showing, or `null` for one of the user's own.
	 *
	 * The hub reads it for two things and neither is cosmetic: what a review copy may *not* do, and
	 * where the button that opens one lives. Both belong here because the hub is where a Workspace's
	 * Workspace-level actions are (Publish is here for the same reason ADR-0008 gives).
	 */
	const review = $derived(storage?.review ?? null);

	let creating = $state(false);
	let newName = $state('');

	let renaming = $state<ProjectSummary | null>(null);
	let renamedTo = $state('');

	let deleting = $state<ProjectSummary | null>(null);

	/**
	 * The "review a Project somebody sent you" dialog (workspace-and-layers SPEC story 90).
	 *
	 * ⚠ **This is not the Import beside it, and it must never become it.** A bundle read here opens
	 * into a *new Review Workspace* and nothing merges it into the Workspace this hub is showing:
	 * under ADR-0023 there is one Alignment per Map Image, so laying a colleague's bundle over the
	 * author's shared pool would overwrite an Alignment several of their Projects are drawn by. Import
	 * (ADR-0037) answers the same file by copying it in with *fresh* Map Image identities, so there is
	 * still no collision to ask about here and no folder name to choose — the two questions this
	 * dialog does not have, and the reason the two offers are two.
	 */
	let openingBundle = $state(false);
	let chosen = $state<FileList | null>(null);
	/** Why the last bundle was not opened, or `''`. Every refusal has left nothing behind. */
	let bundleError = $state('');
	/** Whether a bundle is being read right now, so the dialog's button cannot be pressed twice. */
	let bundleBusy = $state(false);
	/**
	 * What opening the last bundle did, in the reader's own words. `''` when nothing has been opened.
	 *
	 * Kept on the hub rather than in the dialog, because the dialog closes on success and the sentence
	 * is about what the user is now looking at — the review copy's name, and anything the bundle
	 * carried that was deliberately not written.
	 */
	let bundleNotice = $state('');
	/**
	 * The line that says what opening a bundle did, focused when the dialog closes on success.
	 *
	 * The button that opened the dialog has been unmounted by then — `{#if review === null}`, and the
	 * user is now inside a review copy — so `ModalDialog`'s ordinary restore has nothing to put focus
	 * back on.
	 */
	let bundleNoticeLine: HTMLElement | null = $state(null);

	/**
	 * The "review a Project from a Remote" dialog (SPEC story 50, ADR-0031).
	 *
	 * ⚠ **Beside the bundle's button and not beside Clone's, because it is the bundle's operation.**
	 * A Clone makes a Workspace of the user's own that they may go on working in, which is why it
	 * lives in the Remote dialog with the binding. This makes a *review copy*, from a link somebody
	 * sent — the same throwaway, unbound, unpublishable Workspace `open-bundle` makes, differing only
	 * in where the bytes come from — so it is offered where the reader already looks for "somebody
	 * sent me a Project", and it is absent inside a review copy for the identical reason.
	 *
	 * The two fields are the two halves of what a colleague sends: the repository, and **which
	 * Project in it**, because a Remote holds a whole Workspace and the unit here is one Project.
	 */
	let reviewingRemote = $state(false);
	let reviewRepository = $state('');
	let reviewProject = $state('');
	/** Why the last Review did not happen, or `''`. Every refusal has left nothing behind. */
	let reviewError = $state('');
	/** Whether a Review is running, so the button cannot be pressed twice. */
	let reviewBusy = $state(false);
	/** How far this Review's download has got, or `''` when none is running. */
	const reviewProgress = $derived.by(() => {
		const moving = storage?.transfer;
		if (!reviewBusy || !moving) return '';
		return `${moving.files} of ${moving.totalFiles} files downloaded from ${moving.subject}.`;
	});

	const startReviewingRemote = () => {
		reviewRepository = '';
		reviewProject = '';
		reviewError = '';
		bundleNotice = '';
		importNotice = '';
		reviewingRemote = true;
	};

	/**
	 * Put the Review dialog away, unless a download is running.
	 *
	 * A Review cannot be stopped part way: there is no resume, and `reviewFromRemote` discards the
	 * whole review copy on its way out of a failure, so there is nothing a cancel could keep. Rather
	 * than answer nothing to a control that looks pressable, the dialog says it: the buttons are shown
	 * as unavailable and Escape is refused while `reviewBusy` — see `dismissable` below.
	 */
	const cancelReviewingRemote = () => {
		if (reviewBusy) return;
		reviewingRemote = false;
		reviewError = '';
	};

	/**
	 * Download the named Project into a new review copy and switch to it.
	 *
	 * Nothing here decides where it goes or what it may do: `reviewFrom` makes the Workspace, marks
	 * it, and discards the whole thing if anything goes wrong — so a Review that is turned away leaves
	 * the user exactly where they were with everything they had. The notice is shared with the
	 * bundle's, because both sentences describe the same thing: which review copy you are now in.
	 */
	const runReviewRemote = async () => {
		if (reviewBusy || !storage) return;
		const reference = parseRemoteReference(reviewRepository);
		if (reference === null) {
			reviewError =
				`“${reviewRepository.trim()}” is not a repository address. It looks like ` +
				`“owner/repository” — the two parts after github.com in your browser's address bar — and ` +
				`the whole of that address works too.`;
			return;
		}
		reviewError = '';
		reviewBusy = true;
		try {
			bundleNotice = (await storage.reviewFrom({ ...reference, project: reviewProject.trim() }))
				.notice;
			reviewingRemote = false;
		} catch (cause) {
			reviewError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			reviewBusy = false;
		}
	};

	/** A Project as the shared card list takes it: the summary, and where its name links. */
	type ListedProject = ProjectSummary & { readonly href: string };

	/**
	 * The Project list, each entry carrying the link its name wears.
	 *
	 * `resolve` stays in the app: `packages/ui` has no SvelteKit to resolve a path against, which is
	 * why the card is handed a finished `href` rather than a directory to compose one from. The query
	 * parameter is built from the **folder** and encoded (ADR-0008), never from the display name.
	 */
	const listed = $derived<readonly ListedProject[]>(
		session.projects.map((project) => ({
			...project,
			href: resolve(`/?p=${encodeURIComponent(project.directory)}`)
		}))
	);

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

	const startOpeningBundle = () => {
		chosen = null;
		bundleError = '';
		bundleNotice = '';
		importNotice = '';
		openingBundle = true;
	};

	const cancelOpeningBundle = () => {
		if (bundleBusy) return;
		openingBundle = false;
		bundleError = '';
	};

	/**
	 * Read the chosen bundle into a new Review Workspace and switch to it.
	 *
	 * Nothing here decides where it goes: `openBundle` creates the Workspace, and a refusal at any
	 * point discards it whole, so a bundle that is turned away leaves the user exactly where they were
	 * with everything they had.
	 */
	const runOpenBundle = async () => {
		const file = chosen?.item(0);
		if (!file || bundleBusy || !storage) return;
		bundleError = '';
		bundleBusy = true;
		try {
			// ⚠ **The reader's own sentence, shown rather than dropped.** It says how the review copy was
			// named — which is not always the name on the file, because ticket 12 suffixes a taken one —
			// and, when the bundle named the same Alignment twice, which entries were **not** written.
			// The first cut of this handler threw the whole thing away, and a transfer that quietly
			// delivers less than it was handed is the failure this format change exists to escape.
			bundleNotice = (await storage.openBundle(file)).notice;
			openingBundle = false;
		} catch (cause) {
			bundleError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			bundleBusy = false;
		}
	};

	// ── Import: the inverse of Export (SPEC stories 1–3, 7–14, ADR-0037) ───────────────────
	//
	// ⚠ **A different operation from the two dialogs above, and the labels are the difference.** All
	// three take the same kind of file, so the only thing standing between "keep this colleague's
	// Project" and "look at it and throw it away" is what the offer says before a file is chosen —
	// which is why each dialog names its own destination in words rather than sharing a generic
	// "open a bundle" wizard.

	/** The Import offer, and the Workspace it named when it opened. */
	let importing = $state(false);
	let importTarget = $state<ImportTarget | null>(null);
	let importChosen = $state<FileList | null>(null);
	/** Why the last Import did not happen, or `''`. Every refusal has left the Workspace as it was. */
	let importError = $state('');
	/** Whether an Import is running, so the button cannot be pressed twice. */
	let importBusy = $state(false);
	/**
	 * What the last Import did, in the reader's own words. `''` when nothing has been Imported.
	 *
	 * Its own state rather than {@link bundleNotice}'s, because the two are about different
	 * Workspaces: a bundle's names the review copy the user has just been moved into, and this one
	 * names the Workspace they never left. Sharing one string would have the finished Import
	 * overwritten by the next Review, which is the sentence a user needs least.
	 */
	let importNotice = $state('');
	/**
	 * The line naming what was Imported, focused when the Import finishes.
	 *
	 * This is how the allocated result is *reached* rather than merely rendered (SPEC story 9): the
	 * name a Project arrived under is not always the name on the file, so a keyboard user put back on
	 * the trigger would have to go looking through the list for a Project they cannot predict.
	 */
	let importNoticeLine: HTMLElement | null = $state(null);
	/** How far this Import's copy has got, or `''` when none is running. */
	const importProgress = $derived.by(() => {
		const moving = storage?.transfer;
		if (!importBusy || moving?.kind !== 'import') return '';
		return `${moving.files} of ${moving.totalFiles} files copied from ${moving.subject}.`;
	});

	const startImporting = () => {
		importChosen = null;
		importError = '';
		importNotice = '';
		bundleNotice = '';
		// ⚠ **Resolved now rather than when the button is pressed.** The sentence below says which
		// Workspace the Project is going into, and the switcher is two clicks away while it is on
		// screen; `importBundle` compares this against the Workspace that is open and refuses.
		importTarget = storage?.importTarget ?? null;
		importing = true;
	};

	const cancelImporting = () => {
		if (importBusy) return;
		importing = false;
		importError = '';
	};

	/**
	 * Copy the chosen bundle's Project into the Workspace that is open.
	 *
	 * Nothing here decides where it goes or what it is called: the destination is the target resolved
	 * when the offer opened, and the display name is the one core allocated against the Projects
	 * already on this screen — which is not always the name in the bundle, because a taken name takes
	 * an `(imported)` suffix. Both are said out loud afterwards, because a Project that arrived under
	 * a different name than the file promised is one the author would otherwise go looking for.
	 */
	const runImport = async () => {
		const file = importChosen?.item(0);
		if (!file || importBusy || !storage || !importTarget) return;
		importError = '';
		importBusy = true;
		try {
			const imported = await storage.importBundle(file, importTarget);
			importNotice =
				`Imported ${imported.name} into ${imported.workspace}. It is yours to edit now, ` +
				`with no connection back to where it came from.`;
			importing = false;
			// ⚠ **After the dialog's own restoration, not instead of it.** The trigger is still mounted
			// — an Import leaves the author on this hub — so `ModalDialog` puts focus back on “Import a
			// Project…”, which tells a keyboard user nothing about what the press did. Its restore is
			// idempotent, so moving focus on from it here is the last word rather than a race.
			await tick();
			importNoticeLine?.focus();
		} catch (cause) {
			importError = cause instanceof Error ? cause.message : String(cause);
		} finally {
			importBusy = false;
		}
	};

	// ── The Workspace's Map Images (SPEC stories 63–65, 98) ────────────────────────────────
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
	let deletingMap = $state<WorkspaceMapImage | null>(null);

	/** What just happened to a Map Image, for the live region. `''` when nothing has. */
	let mapImageMessage = $state('');

	// Walked when the hub appears and again whenever the Project list changes, because the Project
	// documents are where used-by is read from — a Project deleted here can be the last one that drew a
	// map, and a stale list would offer to delete a map it still says is in use. Not on every render:
	// this weighs every file under `images/`.
	$effect(() => {
		void session.projects;
		void session.refreshMapImages();
	});

	const mapImagesBytes = $derived(session.mapImages.reduce((sum, map) => sum + map.bytes, 0));
	// Core's figure, not a second one derived here. This is the sentence the ticket exists for — "of
	// which 340 MB is used by no Project" — and publishing's hosting warning states the same number
	// from `unusedMapImageBytes`; two reductions spelling it out separately is how one screen ends
	// up quoting two totals for one Workspace.
	const unused = $derived(unusedMapImages(session.mapImages));

	/**
	 * The ADR-0011 shim each card's picture reads its tile through (ADR-0030).
	 *
	 * One for the whole list rather than one per card: it is Workspace-rooted and takes no Project, so
	 * every map's bytes come out of the same instance.
	 */
	const fetchTile = $derived(session.imageServiceFetch());

	/** Where a map's tiles are, in the words the list uses. Visible text, never a colour or a title. */
	const whereTilesAre = (map: WorkspaceMapImage): string =>
		map.tiles === 'in-workspace'
			? 'Tiles in this Workspace'
			: `Tiles on ${map.library || 'a Library’s server'}`;

	/** How many files a map is, beside what it weighs: 3 files and 31 000 files are different news. */
	const fileCount = (map: WorkspaceMapImage): string =>
		`${map.files} ${map.files === 1 ? 'file' : 'files'}`;

	/**
	 * Which Projects draw a map, what refining it moves, and plainly when none do (SPEC story 63).
	 *
	 * ⚠ **The sentence itself is `alignment/used-by.ts`, and this is its only render site.**
	 * One Alignment belongs to a Map Image and is shared by every Project drawing it (ADR-0023), so
	 * "refining it moves all of them" is a fact about *this map* that a scholar needs before they
	 * open the align screen rather than while they are clicking in it. `describeAlignmentUsers` has a
	 * test naming every branch, which is why the composition here is only the two branches it is
	 * silent about.
	 *
	 * **It is silent when no readable Project draws the map, and this list is not.** A Map Image can
	 * sit in the Workspace's pool with nothing drawing it — that is exactly what the reclaim figure
	 * below is for — so the empty answer is said here in words. A Project this build cannot read is
	 * named separately and in its own words: it is not folded into the users, which would claim
	 * something unknown, and it is emphatically not left out, because a map whose only user is a
	 * Project from next year's build must not be described as one nothing uses.
	 */
	const usedBy = (map: WorkspaceMapImage): string => {
		const shared = describeAlignmentUsers(map);
		if (shared) return shared;
		const unreadable = map.mightBeUsedBy.map((project) => project.name).join(', ');
		return unreadable
			? `No Project this version can read uses this map. It may be drawn by ${unreadable}, made with a newer version of Ballastella.`
			: 'No Project uses this map.';
	};

	/** A Map Image as the shared row takes it: the record, its name, and the folder it is kept in. */
	type ListedMapImage = {
		readonly name: string;
		readonly directory: string;
		readonly map: WorkspaceMapImage;
	};

	/**
	 * The Map Image list, each entry named for the row that draws it.
	 *
	 * **No `href`.** A Map Image is not a destination: `/align` refuses to open without a Project, so
	 * a linked name would promise a screen that does not exist. The shared row renders a name without
	 * one as text, which is the same rule its actions follow.
	 */
	const mapEntries = $derived<readonly ListedMapImage[]>(
		session.mapImages.map((map) => ({
			name: map.label || map.imageId,
			directory: map.imageId,
			map
		}))
	);

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
	const askToDelete = (map: WorkspaceMapImage) => {
		mapImageMessage = '';
		session.dismissMapImageError();
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
		const deleted = await session.deleteMapImage(map.imageId);
		mapImageMessage = deleted
			? `Deleted ${map.label || map.imageId}, reclaiming ${describeBytes(map.bytes)}.`
			: '';
	};

	/**
	 * The transfer this page is announcing: a bundle being read, or a Project being exported.
	 *
	 * ⚠ **The bundle's lives on the `WorkspaceStorage` and the export's on the `EditorSession`, and
	 * that is not an inconsistency.** An export never leaves the Workspace it is reading, so the
	 * session is the right owner; opening a bundle *replaces* the session, so a state kept there would
	 * be discarded along with the session that was holding it — and the closing "Opened …" would be
	 * announced onto a component that had already been handed a different one. The storage's takes
	 * precedence because it is the one that can be in flight across a swap.
	 */
	const transfer = $derived(storage?.transfer ?? session.transfer);

	/** A transfer in flight, which the Export buttons must not lose focus to (SPEC story 95). */
	const transferring = $derived(transfer !== null && !transfer.finished);

	/**
	 * Export a Project, having put down whatever the last bundle said.
	 *
	 * Without the first line the finished "Opened …" would shadow the export's own progress for as
	 * long as the user stayed on this hub, because the storage's account outranks the session's.
	 */
	const exportProject = (project: ProjectSummary) => {
		if (transferring) return;
		if (storage) storage.transfer = null;
		void session.exportProject(project);
	};

	/** The announced progress line. Empty when nothing is moving, so the region says nothing. */
	const transferMessage = $derived.by(() => {
		if (!transfer) return '';
		// A tar declares no totals — it has no index — so an open counts rather than inventing a
		// denominator, which is why its two numbers are the same one until it has finished.
		if (transfer.kind === 'open') {
			return transfer.finished
				? `Opened ${transfer.subject}: ${transfer.totalFiles} files.`
				: `Opening ${transfer.subject}: ${transfer.files} files so far.`;
		}
		// An Import does have a denominator: its closure was planned before a byte moved, so both
		// numbers are real rather than the same one twice.
		if (transfer.kind === 'import') {
			return transfer.finished
				? `Imported ${transfer.subject}: ${transfer.totalFiles} files.`
				: `Importing ${transfer.subject}: ${transfer.files} of ${transfer.totalFiles} files.`;
		}
		return transfer.finished
			? `Exported ${transfer.subject}: ${transfer.totalFiles} files.`
			: `Exporting ${transfer.subject}: ${transfer.files} of ${transfer.totalFiles} files.`;
	});
</script>

<!-- When a Project was last written, beside the folder on the card's own line of facts. -->
{#snippet facts(project: ListedProject)}
	Last saved <time datetime={project.updatedAt}>{lastTouched(project.updatedAt)}</time>
{/snippet}

<!--
What else the Hub says about a Project: whether this build can read it.
-->
{#snippet details(project: ListedProject)}
	{#if project.problem === 'format-too-new'}
		<p class="text-sm text-warning">Made with a newer version of Ballastella.</p>
	{:else if project.problem === 'unreadable'}
		<p class="text-sm text-warning">Its project.json could not be read.</p>
	{/if}
{/snippet}

<!--
	What can be done to one Project. **Nowhere in the viewer**: a Reader is handed the same card
	without these, rather than a menu of controls that are there and refused (SPEC story 54).
-->
{#snippet actions(project: ListedProject)}
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
		onclick={() => exportProject(project)}
	>
		Export<span class="sr-only"> {project.name}</span>
	</button>
	<button class="btn btn-outline btn-error btn-sm" onclick={() => (deleting = project)}>
		Delete<span class="sr-only"> {project.name}</span>
	</button>
{/snippet}

<!--
	A picture of the sheet, before the name and inside the same row (ADR-0030). It is what lets a
	scholar tell eleven scans of the same city apart without opening a Project, and it adds no bytes to
	the Workspace: it is the map's own coarsest tile. A referenced map's comes off its Library over the
	network, which ADR-0030 accepts and deliberately does not warn about.
-->
{#snippet mapMedia(entry: ListedMapImage)}
	<MapThumbnail map={entry.map} {fetchTile} />
{/snippet}

<!--
	What a Map Image weighs, how many files that is, and where its tiles are — visible text rather
	than a tooltip or a badge colour (SPEC story 111), because where the tiles are is the fact that
	decides whether this map draws anything on a train. The folder is the row's own, said after these.
-->
{#snippet mapFacts(entry: ListedMapImage)}
	{describeBytes(entry.map.bytes)} in {fileCount(entry.map)} · {whereTilesAre(entry.map)}
{/snippet}

<!--
	Who draws this Map Image, and so what refining its Alignment moves (SPEC story 34, ADR-0023).

	**Not a live region.** `usedBy` is a field of the same `WorkspaceMapImage` record as the bytes and
	the file count, filled by the one `refreshMapImages` walk, and the list renders nothing until that
	walk has an answer — so a row reaches the screen with this sentence already on it, which is
	precisely what a live region does not announce. What this screen announces about a Map Image is
	the one `map-image-status` region above the list.
-->
{#snippet mapDetails(entry: ListedMapImage)}
	<p class="text-sm opacity-70" data-testid="used-by" data-used-by-count={entry.map.usedBy.length}>
		{usedBy(entry.map)}
	</p>
{/snippet}

<!-- Delete is the last control in the row and the only one in `error` (SPEC story 33). -->
{#snippet mapActions(entry: ListedMapImage)}
	<button class="btn btn-outline btn-error btn-sm" onclick={() => askToDelete(entry.map)}>
		Delete<span class="sr-only"> {entry.name}</span>
	</button>
{/snippet}

<!--
	The Workspace Home's two columns: what the author has on the left, what it is made of on the
	right, divided by one vertical rule (SPEC stories 30, 34).

	**`xl` rather than the Project page's `lg`, and it was measured.** At exactly 1024 the Projects
	column takes its pinned measure and leaves the Map Images column 224px, where a Map Image row
	wraps to three lines — and it does so at *every* measure from 44rem down to 32rem, because the
	row's text block sizes to its max-content, so no choice of measure buys it out. At 1280 that
	column gets roughly 480px and the row fits. The two surfaces disagreeing about "wide" is the
	lesser evil: below `xl` this screen stacks, **Projects first**, which is source order here and a
	state story 38 already requires to work.

	**The Projects column is pinned to `--workspace-home-measure`** rather than taking half of
	whatever the page is, so that it measures the same above `xl`, below `xl`, and on a Published
	Site — one width from one declaration in `packages/ui/src/layout.css` (SPEC story 35).

	The rule is a boundary between two regions, which is the one thing ADR-0036's no-left-border rule
	explicitly does not forbid: it separates the columns and marks nothing.
-->
<div
	class="mt-8 xl:grid xl:grid-cols-[minmax(0,var(--workspace-home-measure))_minmax(0,1fr)] xl:gap-8"
>
	<section>
		<div class="flex flex-wrap items-baseline justify-between gap-4">
			<div class="flex flex-wrap items-baseline gap-3">
				<h2 class="text-2xl font-semibold">Projects</h2>
				<!--
					The count is beside the heading rather than inside it (SPEC story 31). Every spec that
					arrives at this screen does so through `heading, { name: 'Projects' }`, and a number in
					the accessible name would break all of them for a fact that is not part of the name —
					so the figure is a sibling, with the noun in `sr-only` text so it is still a sentence
					when it is read aloud.

					The separator is `&nbsp;` because Svelte trims the whitespace at the start of an
					element's content, and without it the count is announced as “3Projects”.
				-->
				{#if session.status === 'ready'}
					<span class="text-sm opacity-70" data-testid="projects-count">
						{session.projects.length}<span class="sr-only"
							>&nbsp;{session.projects.length === 1 ? 'Project' : 'Projects'}</span
						>
					</span>
				{/if}
			</div>
			<div class="flex flex-wrap gap-2">
				<!--
				Opening a Project somebody sent you (workspace-and-layers SPEC story 90). Beside New Project rather than in a
				menu, because for a Firefox, Safari, or iPad user whose Workspace lives in storage they
				cannot see (ADR-0001), a file is the only way anything gets in or out at all.

				**Absent inside a review copy**, rather than present and refused. A review copy is a
				throwaway Workspace holding one Project, and opening a second bundle from inside it would
				land in a *third* Workspace — which is not wrong, but it invites a user to treat the review
				copy as a place things accumulate, which is the mental model ADR-0024 is built to prevent.
				The button is on the hub of their own Workspace, which is one exit away.
			-->
				{#if review === null}
					<!--
					Import: the inverse of Export, and the **first** of the three because it is what an
					author reaching for a file someone sent them usually means (SPEC stories 1, 2, 12,
					ADR-0037). It copies into the Workspace already open, which is what makes it a
					different action from the two beside it rather than a setting on one of them.

					**Absent inside a review copy.** Copying the reviewed Project out is its own
					operation with its own destination — the ordinary Workspace review began in — and
					offering this one here would aim it at the throwaway Workspace instead.
				-->
					<button class="btn" data-testid="import-project" onclick={startImporting}>
						Import a Project…
					</button>
					<button class="btn" data-testid="open-bundle" onclick={startOpeningBundle}>
						Review a Project…
					</button>
					<!--
					The same operation from a Remote rather than from a file (SPEC story 50). Absent inside
					a review copy for the reason above and one more: a reviewer who follows a second link
					from inside the first would accumulate review copies, which is the mental model
					ADR-0024 exists to prevent.

					⚠ **Shorter than its dialog's title, and the four labels have to share one line.**
					The Projects column is pinned to `--workspace-home-measure` (42rem), and with
					“Review a Project from GitHub…” spelled out here the row wrapped — dropping New
					Project to a line of its own, pushing the first Project card down, and putting its
					Delete button underneath the bottom-anchored recovery toast, where a click cannot
					reach it. The dialog has room for the whole sentence; a button in a pinned column
					does not.
				-->
					<button class="btn" data-testid="review-remote" onclick={startReviewingRemote}>
						Review from GitHub…
					</button>
				{/if}
				<button class="btn btn-primary" onclick={startCreating}>New Project</button>
			</div>
		</div>

		<!-- ADR-0024: a Review Workspace is never published. Since ticket 04 the control and its dialog
	     are on the navigation bar, where they are on every screen — so what is left here is the
	     sentence explaining the absence, which the bar has nowhere to put. -->
		{#if review !== null}
			<p class="mt-4 text-sm opacity-70" data-testid="review-workspace-note">
				A review copy is not published and not backed up: it holds somebody else's work and is meant
				to be discarded. Go back to your own Workspace to publish yours.
			</p>
		{/if}

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
			data-transfer={transfer?.kind ?? ''}
		>
			{transferMessage}
		</p>

		{#if importNotice}
			<!--
			What the Import did: the display name it was allocated, and the Workspace it went into.
			Both are said because neither is certain in advance — a taken name takes an `(imported)`
			suffix — and an author who cannot see which Project arrived cannot find it in the list.

			Focused when the dialog closes, which is how the allocated result is *reached* rather than
			merely rendered. The Import leaves the author on this hub, so the trigger above is still
			mounted and `ModalDialog` would restore focus to it — putting a keyboard user back on
			“Import a Project…” with no word about what the last press did.

			`aria-live="polite"` rather than `role="status"`, this page's settled convention: the
			transfer line above and the save indicator on the bar already account for that role here.
		-->
			<p
				bind:this={importNoticeLine}
				tabindex="-1"
				aria-live="polite"
				class="mt-4 text-sm opacity-80"
				data-testid="import-notice"
			>
				{importNotice}
			</p>
		{/if}

		{#if bundleNotice}
			<!--
			What opening a bundle did, in the reader's own words: which review copy it made, and — when
			the bundle named the same Alignment twice — what was deliberately not written. Beside the
			list rather than over it, because nothing went wrong; the review copy is on screen and this
			describes it.

			`aria-live="polite"` and not `role="status"`, this page's settled convention: the transfer
			line above and the save indicator on the bar already account for the status role here.
		-->
			<p
				bind:this={bundleNoticeLine}
				tabindex="-1"
				aria-live="polite"
				class="mt-4 text-sm opacity-80"
				data-testid="bundle-notice"
			>
				{bundleNotice}
			</p>
		{/if}

		{#if session.transferError}
			<!-- An export that failed — another tab deleted the Project, a folder grant lapsed. This used to
		     be rendered *only* inside the import dialog, so a failed export blanked the status line and
		     said nothing at all: on the path ADR-0001 makes the only way out, indistinguishable from a
		     click that did not register. Now that the dialog on this page is about a *different*
		     Workspace, there is no branch left for it to hide behind. -->
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
			<!--
			ADR-0008: a normal state with a recovery, never an error boundary — and **the alert and the
			recovery are `WorkspaceRecovery`'s**, one level up, not this component's (ticket 12).

			This used to be a second `role="alert"` saying the same thing, with a "Locate Workspace again"
			button that is only the right recovery for browser storage: for a folder Workspace the way back
			is the picker, and offering a refresh instead is the affordance that cannot work. Two alerts
			with one meaning is also exactly what a screen reader reads out twice. So the recovery moved to
			the one component that knows both backings, and what is left here is the consequence for the
			*list*, which is this component's own subject.
		-->
			<p class="mt-6">
				The Projects in this Workspace cannot be listed until it can be reached. Nothing has been
				lost — they are still wherever they were.
			</p>
		{:else if session.status === 'loading'}
			<p class="mt-6">Looking for your Projects…</p>
		{:else if session.projects.length === 0}
			<p class="mt-6">No Projects yet.</p>
		{:else}
			<!--
			The same list a Reader is offered on a Published Site's Front Page, from the one component
			(SPEC stories 8, 52–54). What is the Hub's rather than the card's arrives as the three
			snippets below, and what a Reader must not be offered is what the viewer does not pass.
		-->
			<ProjectCardList
				class="mt-6 workspace-home-column"
				heading="h3"
				projects={listed}
				{facts}
				{details}
				{actions}
			/>
		{/if}
	</section>

	<!-- The Workspace's shared pool (ADR-0023). Hidden while the Workspace itself cannot be reached,
     because a list of nothing under a "not reachable" banner reads as "your maps are gone". -->
	{#if session.status !== 'unreachable'}
		<section class="mt-10 xl:mt-0 xl:border-l xl:border-rule xl:pl-8">
			<div class="flex flex-wrap items-baseline gap-3">
				<h2 class="text-2xl font-semibold">Map Images</h2>
				<!-- Beside the heading rather than in it, for the reason the Projects count gives above. -->
				{#if !(session.mapImagesLoading && session.mapImages.length === 0)}
					<span class="text-sm opacity-70" data-testid="map-images-count">
						{session.mapImages.length}<span class="sr-only"
							>&nbsp;{session.mapImages.length === 1 ? 'Map Image' : 'Map Images'}</span
						>
					</span>
				{/if}
			</div>
			<p class="mt-1 text-sm opacity-70">
				Every Map Image in this Workspace across all its projects.
			</p>

			<!-- Always rendered, empty when there is nothing to say: an `aria-live` region inserted at the
		     same moment as its first text is not reliably announced.

		     `aria-live="polite"` and not `role="status"`, which is this app's settled convention wherever
		     a page already has one status region — the transfer line above owns it here, exactly as the
		     save indicator owns it inside a Project (`LayerList`, `AlignmentWorkspace`, `PublishDialog`,
		     and `UndoControl` all say so). A second `role="status"` makes `getByRole('status')` a strict
		     mode violation, which is what pushed two existing tests off the role and onto attribute
		     locators that stay green with the live region deleted. -->
			<p aria-live="polite" class="mt-2 text-sm opacity-80" data-testid="map-image-status">
				{mapImageMessage}
			</p>

			{#if session.mapImageError}
				<!-- SPEC story 64: the refusal, naming the Projects that would break. A warning beside the
			     list rather than a dialog over it — nothing has happened, and every other map stays
			     reachable. -->
				<div role="alert" class="mt-2 alert flex-col items-start alert-warning">
					<p data-testid="map-image-refused">{session.mapImageError}</p>
				</div>
			{/if}

			{#if session.mapImagesLoading && session.mapImages.length === 0}
				<p class="mt-4">Looking at what this Workspace holds…</p>
			{:else if session.mapImages.length === 0}
				<p class="mt-4" data-testid="no-map-images">No Map Images yet.</p>
			{:else}
				<!--
				The same row the Projects list is drawn with, from the one component (SPEC story 37). It
				used to be this markup written a second time, so a change to a row could land in one list
				and miss the other; what is a Map Image's rather than a row's arrives as the four snippets
				above.
			-->
				<ProjectCardList
					class="mt-4 workspace-home-column"
					heading="h3"
					projects={mapEntries}
					media={mapMedia}
					facts={mapFacts}
					details={mapDetails}
					actions={mapActions}
					itemTestid="map-image"
				/>
				<p class="mt-3 text-sm opacity-70" data-testid="map-images-total">
					{session.mapImages.length}
					{session.mapImages.length === 1 ? 'Map Image' : 'Map Images'}, {describeBytes(
						mapImagesBytes
					)} in all{unused.maps.length > 0
						? `, of which ${describeBytes(unused.bytes)} is used by no Project`
						: ''}.
				</p>
			{/if}
		</section>
	{/if}
</div>

<ModalDialog
	bind:open={() => deletingMap !== null, (open) => !open && (deletingMap = null)}
	title="Delete Map Image"
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
		<button class="btn btn-error" onclick={removeMap}>Delete Map Image</button>
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
	title="Import a Project"
	dismissable={!importBusy}
>
	<!--
		⚠ **The destination, before the file is chosen** (SPEC story 7). This is the one sentence that
		tells an author they are about to copy work into their own Workspace rather than look at it in a
		throwaway one, and both offers take the same kind of file — so it is above the input, not below
		it, and it names the Workspace rather than saying "this Workspace".
	-->
	<p data-testid="import-destination">
		Import into <strong>{importTarget?.name ?? storage?.name ?? ''}</strong>
	</p>
	<label class="floating-label mt-4">
		<span>Project bundle</span>
		<!-- The first source, and the only one in this slice: a Published GitHub Project is its own
		     offer. `.project.tar` is what Export writes; `.tar` is accepted too, because a mail client
		     that rewrote the name is not the author's fault. -->
		<input
			class="file-input w-full"
			type="file"
			accept=".tar,application/x-tar"
			data-testid="import-file"
			bind:files={importChosen}
		/>
	</label>
	<p class="mt-3 text-sm opacity-70" data-testid="import-consequence">
		The Project is <strong>copied into this Workspace</strong> as work of your own: yours to edit, to
		publish, and to back up. Its maps arrive as new Map Images of this Workspace, so nothing you already
		have is changed or overwritten. There is no connection back afterwards — later changes to the original
		never travel here, and yours never travel there.
	</p>
	<!-- Per-file progress, announced: a Map Image's pyramid is thousands of files over real minutes,
	     and an Import is one of the places a scholar waits on something they cannot see
	     (workspace-and-layers SPEC story 96). No percentage: the two numbers are files, which is what
	     the closure knows.

	     `aria-live="polite"` and **not** `role="status"`, which is CONTRIBUTING's mandated pattern and
	     this app's settled convention: the save indicator on the navigation bar owns that role on
	     every screen, and a second one makes `getByRole('status')` ambiguous — which is a hint that a
	     screen-reader user would have to disambiguate as well.

	     Persistent and empty when idle, for the reason every other live region here is: one inserted
	     at the same moment as its first text is not reliably announced. An empty `<p>` has no line
	     box, so it costs no space either. -->
	<p
		aria-live="polite"
		class="text-sm"
		class:mt-3={importProgress !== ''}
		data-testid="import-progress"
	>
		{importProgress}
	</p>
	{#if importError}
		<!-- The refusals: not a tar, no project.json, a missing referenced file, ADR-0010's Project
		     from a newer version, no room for the closure, a path this Workspace already holds, or a
		     Workspace that is not the one this offer named any more. Each one has left every path in
		     this Workspace exactly as it was. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-error">
			<p data-testid="import-error">{importError}</p>
		</div>
	{/if}
	{#snippet actions()}
		<!-- ⚠ **Shown as unavailable while the copy runs, because it is.** An Import cannot be stopped
		     part way: the transaction is atomic as far as any reader can tell, and abandoning it
		     halfway is the state its marker exists to make impossible. Escape is refused for the same
		     reason (`dismissable` above), which is what keeps the dialog on screen to carry the
		     progress line and any refusal. -->
		<button
			class="btn"
			class:btn-disabled={importBusy}
			aria-disabled={importBusy}
			data-testid="cancel-import"
			onclick={cancelImporting}
		>
			Cancel
		</button>
		<!-- `aria-disabled` for the *busy* half rather than `disabled`, which leaves the tab order the
		     moment it is pressed and drops a keyboard user's focus to `<body>` for the length of the
		     copy (WCAG 2.4.3). `disabled` is still right for "no file chosen yet", because that button
		     has never been pressed and cannot lose a focus it never had — but only while nothing is
		     running, or a file input cleared mid-copy would take the focus with it. -->
		<button
			class="btn btn-primary"
			class:btn-disabled={importBusy}
			aria-disabled={importBusy}
			data-testid="confirm-import"
			onclick={() => !importBusy && runImport()}
			disabled={!importBusy && !importChosen?.length}
		>
			{importBusy ? 'Importing…' : 'Import into this Workspace'}
		</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => openingBundle, (open) => (open ? (openingBundle = true) : cancelOpeningBundle())}
	title="Review a Project"
	restoreFocusTo={() => bundleNoticeLine}
>
	<label class="floating-label">
		<span>Project bundle</span>
		<!-- `.project.tar` is what Export writes; `.tar` is accepted too, because a mail client or a
		     file-sharing service that rewrote the name is not the user's fault and the reader tells them
		     plainly if what they picked turns out to be a Workspace backup instead. -->
		<input
			class="file-input w-full"
			type="file"
			accept=".tar,application/x-tar"
			data-testid="bundle-file"
			bind:files={chosen}
		/>
	</label>
	<p class="mt-3 text-sm opacity-70" data-testid="open-bundle-consequence">
		This opens into a separate <strong>review copy</strong> — a throwaway Workspace holding only that
		Project. Nothing in this Workspace is changed, and nothing from the review copy can be brought back
		into it. You can look at it, pan the map, read the Annotations, and discard it when you are done.
	</p>
	{#if bundleError}
		<!-- The refusals: not a tar, no project.json, an entry that would be written outside the
		     Project, a missing referenced file, a bundle with no room to hold it, or ADR-0010's Project
		     from a newer version. Each one has left no Review Workspace behind. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-error">
			<p data-testid="bundle-error">{bundleError}</p>
		</div>
	{/if}
	{#snippet actions()}
		<button class="btn" onclick={cancelOpeningBundle}>Cancel</button>
		<!-- `aria-disabled` for the *busy* half, never `disabled`. A `disabled` button leaves the tab
		     order the moment it is pressed, so a keyboard user's focus fell to `<body>` for the length
		     of the read — the identical defect the Export buttons above are shaped by, and the one
		     `keeps the Export button focusable while an export runs` already guards
		     (workspace-and-layers SPEC story 95, WCAG 2.4.3). `disabled` is still right for "no file
		     chosen yet", because that button has never been pressed and cannot lose a focus it never
		     had. -->
		<button
			class="btn btn-primary"
			class:btn-disabled={bundleBusy}
			aria-disabled={bundleBusy}
			data-testid="confirm-open-bundle"
			onclick={() => !bundleBusy && runOpenBundle()}
			disabled={!chosen?.length}
		>
			{bundleBusy ? 'Opening…' : 'Open in a review copy'}
		</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={
		() => reviewingRemote, (open) => (open ? (reviewingRemote = true) : cancelReviewingRemote())
	}
	title="Review a Project from GitHub"
	restoreFocusTo={() => bundleNoticeLine}
	dismissable={!reviewBusy}
>
	<label class="floating-label">
		<span>Repository</span>
		<input
			class="input w-full"
			data-testid="review-repository-field"
			placeholder="owner/repository"
			autocomplete="off"
			spellcheck="false"
			bind:value={reviewRepository}
		/>
	</label>
	<label class="floating-label mt-4">
		<span>Project folder</span>
		<!-- A Project's identity is its folder rather than its display name (ADR-0008), and the folder
		     is the part after the address in the link a colleague sends. Said plainly below, because a
		     scholar who was told "look at my Amsterdam one" has been given the other name. -->
		<input
			class="input w-full"
			data-testid="review-project-field"
			placeholder="amsterdam-1625"
			autocomplete="off"
			spellcheck="false"
			bind:value={reviewProject}
		/>
	</label>
	<p class="mt-3 text-sm opacity-70" data-testid="review-remote-consequence">
		This opens into a separate <strong>review copy</strong> — a throwaway Workspace holding only that
		Project and the Map Images and Alignments it uses. It has to be a public repository, and you do not
		need a GitHub account or a token. Nothing in this Workspace is changed, nothing from the review copy
		can be brought back into it, and a review copy is never published.
	</p>
	<!-- Per-file progress, announced: a Map Image's pyramid is thousands of files over real minutes,
	     and this is one of the places a scholar waits on something they cannot see
	     (workspace-and-layers SPEC story 96). `aria-live="polite"` rather than `role="status"`, and
	     persistent rather than inserted with its first text: see the Import dialog's own progress line
	     above for both arguments. -->
	<p
		aria-live="polite"
		class="text-sm"
		class:mt-3={reviewProgress !== ''}
		data-testid="review-progress"
	>
		{reviewProgress}
	</p>
	{#if reviewError}
		<!-- The refusals: no such public repository, no Project by that name, a truncated file list,
		     no room to hold it, bytes that are not the ones the file list named, or ADR-0010's Project
		     from a newer version. Each one has left no review copy behind. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-error">
			<p data-testid="review-error">{reviewError}</p>
		</div>
	{/if}
	{#snippet actions()}
		<!-- ⚠ **Shown as unavailable while the download runs, because it is.** A Review cannot be
		     stopped part way — there is no resume and nothing to keep — so `cancelReviewingRemote`
		     declines, and a Cancel button that looks pressable and answers nothing is the worst of the
		     three states. Escape is refused for the same reason (`dismissable` above), which is what
		     keeps the dialog on screen to carry the progress line and any refusal. -->
		<button
			class="btn"
			class:btn-disabled={reviewBusy}
			aria-disabled={reviewBusy}
			data-testid="cancel-review-remote"
			onclick={cancelReviewingRemote}
		>
			Cancel
		</button>
		<!-- `aria-disabled` for the *busy* half rather than `disabled`, which leaves the tab order the
		     moment it is pressed and drops a keyboard user's focus to `<body>` for the length of the
		     download (WCAG 2.4.3). `disabled` is still right for the empty fields, which have never
		     been pressed — but only while nothing is running: a field cleared mid-download would
		     otherwise turn the button the user just pressed into a `disabled` one and take their focus
		     with it, which is the identical defect the busy half is written around. -->
		<button
			class="btn btn-primary"
			class:btn-disabled={reviewBusy}
			aria-disabled={reviewBusy}
			data-testid="confirm-review-remote"
			onclick={() => !reviewBusy && runReviewRemote()}
			disabled={!reviewBusy && (reviewRepository.trim() === '' || reviewProject.trim() === '')}
		>
			{reviewBusy ? 'Downloading…' : 'Open in a review copy'}
		</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => deleting !== null, (open) => !open && (deleting = null)}
	title="Delete Project"
>
	<!-- ADR-0023: a Map Image's pyramid and its Alignment belong to the **Workspace** and are
	     shared, so deleting a Project never deletes them. This said the opposite, a few lines above a
	     list that says so plainly. Wording only — what `deleteProject` removes is unchanged. -->
	<p>
		Delete <strong>{deleting?.name}</strong> and everything in it? Its Layers and Annotations go with
		it. This cannot be undone.
	</p>
	<p class="mt-3 text-sm opacity-70">
		The Map Images it drew stay in the Workspace, with their Alignments, because other Projects may
		use them. Delete those from the Map Images list if you no longer want them.
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (deleting = null)}>Cancel</button>
		<button class="btn btn-error" onclick={remove}>Delete Project</button>
	{/snippet}
</ModalDialog>
