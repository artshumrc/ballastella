<script lang="ts">
	// The editor's navigation bar: the things that are true on every screen.
	//
	// **The container is `AppBar`, in `@ballastella/ui`, and the items below are this app's alone**
	// (ADR-0034). Everything here reaches into the editor — the Workspace switcher into
	// `workspace-storage.svelte.ts`, the door into the GitHub broker, publishing into the
	// planner — and moving the bar itself into the shared package would put all of that in the
	// viewer's reachable graph. So the shell is shared and the filling is not.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHAT BELONGS HERE
	//
	// Which Workspace you are in, which screen you are on and the way off it, what the interface looks
	// like, whether your work is kept, and how to take the last thing back. Every one of them is a
	// question a user has *while* doing something else, which is what makes a persistent bar the right
	// place for them rather than a panel that comes and goes.
	//
	// **Project-specific controls are still excluded**: the Base Map switcher and Project settings
	// belong to the Project screen. The Project name appears only as location in the breadcrumb, not as
	// a control owned by this component.
	//
	// The screen's hierarchy and way back arrive through the shell's page-chrome slot — one generic
	// slot a route fills, not a switch on the route. A per-route header strip beneath this bar is the
	// alternative, and on `/align`, with two live map panes, that is a second header costing height
	// the maps need.
	//
	// Before this, the theme toggle was on `/base-map/`, `/layers/` and `/align/` and not on the hub;
	// the save indicator and the undo control were on three pages each, mounted separately. Three
	// copies of a thing that has one meaning is how they came to look different from each other.
	//
	// Workspace identity is a **switcher** rather than a label, because browser storage holds several
	// named Workspaces (ADR-0024) — and one of them can be a throwaway Review Workspace, which is a
	// thing a user must never be in doubt about.

	import { resolve } from '$app/paths';
	import { describeBytes, describeRemote, type WorkspaceSize } from '@ballastella/core';
	import { AppBar, BallastellaMark, MenuPopover } from '@ballastella/ui';
	// Every one `aria-hidden`: each sits beside its own label, and an icon that names itself as well
	// is the same word twice for a screen reader — and would change the accessible name the tests and
	// a user's own "click the button called…" both go by.
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Folder from '@lucide/svelte/icons/folder';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';
	import PublishDialog from '$lib/publish/PublishDialog.svelte';
	import { publishControlLabel, type PublishProgress } from '$lib/publish/publish-progress.js';
	import EditHistoryControls from '$lib/undo/EditHistoryControls.svelte';
	import { editHistorySlot } from '$lib/undo/edit-history-slot.svelte.js';
	import { theme } from '$lib/theme.svelte';
	import {
		useWorkspaceHost,
		type WorkspaceBacking,
		type WorkspaceEntry
	} from '$lib/workspace-storage.svelte.js';

	import Toast from '$lib/toasts/Toast.svelte';

	import ConnectToGitHub from './ConnectToGitHub.svelte';
	import ModalDialog from './ModalDialog.svelte';
	import RemoteStatus from './RemoteStatus.svelte';
	import WhereYourWorkIs from './WhereYourWorkIs.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	/**
	 * Which Workspace this is, in words.
	 *
	 * Named rather than iconified, because "which Workspace did that last edit go into?" is exactly
	 * the question a scholar asks after their work is not where they left it — and a disc glyph
	 * answers it for nobody using a screen reader.
	 *
	 * The Workspace's own name in both backings, rather than "Browser storage", which named the
	 * *backing*: with several named Workspaces on one backing that sentence no longer identifies
	 * anything, and a Review Workspace is browser-backed too.
	 */
	const workspaceName = $derived(storage === null ? 'Starting…' : storage.name);

	/**
	 * Whether the open Workspace cannot be reached.
	 *
	 * ⚠ **The menu's markings are the only thing here that can send a scholar towards recovery.**
	 * `status` belongs to the open session, so this is a fact about the Workspace currently on screen
	 * and about no other — which is why the marking lands on the open one's row: the folder row when
	 * the backing is a folder, and that Workspace's own `switch-workspace` row when it is browser
	 * storage refusing.
	 */
	const unreachable = $derived(session?.status === 'unreachable');

	/**
	 * Every Workspace this installation has, of either kind — the roster (ADR-0042).
	 *
	 * One list because switching is one list and one press, and because a folder that is not open is
	 * simply not the one that is open, which is what every other row here already means.
	 */
	const entries = $derived<readonly WorkspaceEntry[]>(storage?.workspaceEntries ?? []);

	/**
	 * Whether this browser can put a Workspace in a folder at all.
	 *
	 * ⚠ **Where it cannot, the *kind* is never named anywhere in this menu** (ADR-0042): no icon, no
	 * folder name, no "kept in this browser", and no choice at creation. A Workspace is simply a
	 * Workspace, with no implication that another sort was available and refused. Where it can, the
	 * kind is worth a glance, because the two differ in where the author's bytes are.
	 */
	const kindsAreVisible = $derived(storage?.canChooseFolder ?? false);

	/** Where this Workspace's bytes are, in words — the header's second fact, where there are two. */
	const backingSentence = $derived(
		storage?.backing === 'folder' ? 'A folder on this computer' : 'Kept in this browser'
	);

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();
	let publishOpen = $state(false);
	/**
	 * The door control, so a dialog opened from behind it has somewhere to put focus back.
	 *
	 * The Update's own question is the case: it is raised by the transfer rather than by a press, and
	 * the press that started the transfer was inside the door, which closed on it.
	 */
	let doorButton = $state<HTMLButtonElement | undefined>();
	/**
	 * Whether a publish is running, and how far it has got.
	 *
	 * Bound out of `PublishDialog` rather than kept there, because the control that started it is on
	 * this bar and has to say so: `aria-disabled` with a label that reflects progress, never
	 * `disabled` — a `disabled` button leaves the tab order the instant it is pressed, dropping a
	 * keyboard user's focus to `<body>` for the length of the publish (WCAG 2.4.3).
	 */
	let publishing = $state(false);
	let publishProgress = $state<PublishProgress | null>(null);
	/**
	 * Whether this Workspace may be published at all (ADR-0024).
	 *
	 * Absent inside a review copy rather than present and refused, which is the arrangement the hub
	 * already had: the review copy holds somebody else's work, the hub says so in words where the
	 * button used to be, and `packages/core` refuses the binding by any route regardless.
	 *
	 * Absent for the same reason over a Workspace whose interrupted Import or Update could not be
	 * resolved. A publish plan is a walk of the Workspace, and until the marker is resolved that walk
	 * would include provisional files — which is what the whole gate exists to prevent, and the hub
	 * is already saying why in words.
	 */
	const publishable = $derived(
		storage !== null && storage.review === null && storage.unavailable === ''
	);

	/** The new-Workspace field, or `null` when it is not being asked for. */
	let newName = $state<string | null>(null);
	let newNameField = $state<HTMLInputElement | undefined>();
	/**
	 * Which kind a new Workspace is to be.
	 *
	 * ⚠ **Asked at creation and barred from first contact** (ADR-0042, amending ADR-0001). A folder is
	 * a capability upgrade and never a gate, so the first Workspace appears silently and browser-backed
	 * with nothing asked; **New Workspace…** is a deliberate act by somebody who already has one, so
	 * the question there is not a gate. It is not asked at all where the browser has no picker.
	 */
	let newKind = $state<WorkspaceBacking>('browser');
	/** The row being renamed and the name being typed into it, or `null`. */
	let renaming = $state<{ key: string; label: string } | null>(null);
	let renameField = $state<HTMLInputElement | undefined>();
	let renameReturn: HTMLElement | null = null;
	/** The row a deletion is being confirmed for, or `null` when nothing is being confirmed. */
	let confirming = $state<{
		key: string;
		label: string;
		kind: WorkspaceBacking;
		size: WorkspaceSize | null;
	} | null>(null);
	/** Whether the confirmation is showing. Separate from `confirming` so Escape can close it. */
	let confirmOpen = $state(false);
	/**
	 * A hydration-stable id for the inline field's label.
	 *
	 * Not a literal, for the reason `MenuPopover` documents about its own: a hardcoded id is a
	 * collision waiting for the second instance on a page, and `for`/`id` is the whole of what ties a
	 * label to its field for a screen reader.
	 */
	const newNameId = $props.id();
	/**
	 * The rename field's label id, derived from the one `$props.id()` this component may have.
	 *
	 * ⚠ **`$props.id()` may be called once per component**, and the creation form already has it.
	 * Suffixing keeps both ids hydration-stable and distinct, which is the whole of what a `for`/`id`
	 * pair needs — see `MenuPopover` for why neither may be a literal.
	 */
	const renameId = `${newNameId}-rename`;
	/** The button the inline form was opened from, so focus has somewhere to go back to. */
	let newNameReturn: HTMLElement | null = null;

	/**
	 * What just happened to the Workspace, announced.
	 *
	 * ⚠ **Switching Workspaces changes almost everything on screen and, without this, says nothing.**
	 * The only visible signal is the switcher button's own label mutating, and a screen reader reports
	 * no such thing — a control's accessible name changing is not an announcement. So a scholar using
	 * one would move between Workspaces, hear silence, and be looking at a Project list that is now
	 * somebody else's. Deleting already had a live region; this is the same courtesy for the two
	 * actions that are far more frequent, and it carries the refusals as well.
	 */
	let announcement = $state('');

	/** Open something from the menu, having handed focus back first — see `MenuPopover.dismiss`. */
	function fromMenu(act: () => void): void {
		menu?.dismiss();
		act();
	}

	/**
	 * Close the inline form and put focus back where it came from.
	 *
	 * Without this the form unmounts with the pressed button still focused, and focus falls to
	 * `<body>` — a keyboard user is returned to the top of the document with no idea whether anything
	 * happened (WCAG 2.4.3, the rule the hub's own reclaim line is shaped by).
	 */
	function closeNewWorkspace(): void {
		newName = null;
		newKind = 'browser';
		(newNameReturn ?? menu?.button())?.focus();
		newNameReturn = null;
	}

	/**
	 * Open the Workspace a row is about.
	 *
	 * The announcement is drawn from what the storage *did* rather than from what was pressed: opening
	 * a folder Workspace goes through the browser's own permission gesture, which the author may
	 * decline, and a line saying they had switched when they had not is the one announcement that is
	 * wrong exactly when it matters.
	 */
	async function openEntry(entry: WorkspaceEntry): Promise<void> {
		if (!storage) return;
		await storage.openEntry(entry.key);
		announcement = storage.problem || `Switched to the Workspace “${storage.name}”.`;
	}

	/** Open the inline rename field for a row, remembering where focus has to go back to. */
	function startRename(entry: WorkspaceEntry): void {
		renameReturn = menu?.button() ?? null;
		renaming = { key: entry.key, label: entry.label };
		// After the popover has gone, or focus lands on an element about to be hidden.
		queueMicrotask(() => renameField?.select());
	}

	function closeRename(): void {
		renaming = null;
		(renameReturn ?? menu?.button())?.focus();
		renameReturn = null;
	}

	async function commitRename(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = renaming;
		closeRename();
		if (!storage || asked === null || asked.label.trim() === '') return;
		const wanted = asked.label.trim();
		announcement = (await storage.renameEntry(asked.key, wanted))
			? `Renamed the Workspace to “${wanted}”.`
			: // A browser that will keep no record is the one case where a rename does not stick, and
				// showing the new name over a Workspace that will not have it next visit is worse than
				// saying so.
				`This browser would not keep the new name, so nothing has been renamed.`;
	}

	/**
	 * Ask before deleting, naming the Workspace and what it weighs (ADR-0016).
	 *
	 * The size is read *after* the question is raised rather than before, because reading a Workspace
	 * of tens of thousands of tile files takes real time and the author has already pressed the
	 * control. It is `null` for a folder that is not open, which the dialog says in words.
	 */
	async function askToDelete(entry: WorkspaceEntry): Promise<void> {
		confirming = { key: entry.key, label: entry.label, kind: entry.kind, size: null };
		confirmOpen = true;
		const size = (await storage?.sizeOfEntry(entry.key)) ?? null;
		if (confirming?.key === entry.key) confirming = { ...confirming, size };
	}

	async function confirmDelete(): Promise<void> {
		const going = confirming;
		if (!storage || going === null) return;
		confirmOpen = false;
		confirming = null;
		try {
			await storage.deleteEntry(going.key);
			announcement =
				going.kind === 'folder'
					? `Took the Workspace “${going.label}” off the list. The folder itself is untouched.`
					: `Deleted the Workspace “${going.label}” and everything in it.`;
		} catch (cause) {
			announcement = cause instanceof Error ? cause.message : String(cause);
		}
	}

	async function createWorkspace(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = newName ?? '';
		if (asked.trim() === '') {
			closeNewWorkspace();
			return;
		}
		const kind = newKind;
		closeNewWorkspace();
		try {
			// A folder needs the browser's own picker, and the gesture that reached this submit is what
			// licenses opening it. `''` is a picker closed without choosing — nothing happened, so
			// nothing is said.
			const made =
				kind === 'folder'
					? await storage?.createFolderWorkspace(asked)
					: await storage?.createWorkspace(asked);
			if (!made) {
				announcement = storage?.problem ?? '';
				return;
			}
			// The name it *really* got, which may carry a ` (2)` the user did not type. Saying the typed
			// name back would be the one announcement that is wrong exactly when it matters.
			announcement = `Created the Workspace “${made}” and switched to it.`;
		} catch (cause) {
			announcement = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<!--
	The shell's identity slot, first in the masthead tier — which Workspace you are in, and what is true
	of it. A published site puts its own name in the same place, which is the whole of what makes the
	two bars one bar.
-->
{#snippet start()}
	<!--
		1. Which Workspace, and the way to another one.

		**Always visible, on every screen** — a user can be inside a throwaway Review Workspace, and a
		control that says which one you are in is worth nothing on the screens it is missing from.

		The menu is the Popover API through `MenuPopover`, which is mandated rather than merely
		available (ADR-0016) — a `<details>` or CSS-`:focus` dropdown dismisses on neither Escape nor a
		click elsewhere. The button's text carries the name, so the identity is readable without
		opening anything.
	-->
	<div class="flex items-center gap-2 text-sm" data-testid="workspace-identity">
		<span class="opacity-70">Workspace:</span>
		{#if storage === null}
			<span class="font-medium">{workspaceName}</span>
		{:else}
			<!-- `max-w-*` and truncation, because the name is up to 64 characters of somebody else's
			     text and the bar has three other controls to fit. The full name is in the menu, in
			     and in the button's own `title`-free accessible name, which is the
			     text node rather than the ellipsis CSS paints over it. -->
			<MenuPopover
				bind:this={menu}
				label={workspaceName}
				buttonClass="btn max-w-[14rem] truncate btn-sm font-medium"
				testid="workspace-switcher"
			>
				<!--
					What this Workspace is: its name, and where its bytes are.

					⚠ **The repository, the credential and the Remote Status are not restated here**
					(ADR-0041). All three were said in the eyebrow at the same time, and a scholar asking
					*is my work safe* had five candidates and no way to choose between them. The badge
					answers it, and the door names the repository; a third copy in prose could only
					disagree with them.
				-->
				<!--
					⚠ **Every line states its own ink, and none of them may inherit.** daisyUI paints
					`.menu-title`'s contents at `color-mix(in oklab, base-content 40%, transparent)`, which
					is 2.52:1 in light and 3.25:1 in dark against `base-100` — below AA at any size. Full
					`base-content` is 17.05:1 and 13.03:1, and `opacity-70` over it is 6.45:1 and 7.05:1, so
					a de-emphasised line still clears 4.5:1. `text-warning` is used only at full opacity:
					at 70% it falls to 2.79:1 in light.
				-->
				<li class="menu-title" data-testid="workspace-header">
					<span class="block truncate text-sm font-semibold text-base-content">
						{workspaceName}
					</span>
					{#if kindsAreVisible}
						<span class="block font-normal" data-testid="workspace-backing">
							<span class="text-base-content opacity-70">{backingSentence}</span>
						</span>
					{/if}
				</li>
				<!--
					The roster: every Workspace there is, of either kind, each opened, renamed or deleted
					from its own row (ADR-0042). A Workspace is deleted from the list of Workspaces, which
					is where a person looking for it is looking.
				-->
				<li class="menu-title">Your Workspaces</li>
				{#each entries as entry (entry.key)}
					<!-- `flex-row` because daisyUI stacks a menu item's children in a column: the row is one
					     line with the name taking the space and the two actions beside it, and each of the three
					     is a direct child so it is styled and hit-tested as a menu item rather than as a box
					     inside one. -->
					<li class="flex-row items-start">
						<button
							type="button"
							class="min-w-0 grow"
							data-testid="switch-workspace"
							data-workspace={entry.label}
							data-kind={entry.kind}
							aria-current={entry.isOpen ? 'true' : undefined}
							onclick={() =>
								fromMenu(() => {
									// The one that is open is already open, and for a folder asking again would
									// mean the browser's permission dialog for no change at all.
									if (!entry.isOpen) void openEntry(entry);
								})}
						>
							{#if kindsAreVisible}
								<!-- A browser window or a folder, because where the bytes are is the one thing the
								     two kinds differ in; never named where the browser cannot offer both. -->
								{#if entry.kind === 'folder'}
									<Folder size={16} aria-hidden="true" class="shrink-0" />
								{:else}
									<AppWindow size={16} aria-hidden="true" class="shrink-0" />
								{/if}
							{/if}
							<!--
								The name and what is true of it in **one** truncating span, so they stay next to
								each other: as separate flex children the name's `truncate` takes the free space
								and shunts "(open)" to the far edge of the menu, where it reads as a column
								heading rather than as part of the line it belongs to.

								Which of these is somebody else's work in a throwaway Workspace, in **words**
								rather than as a tint or an icon. Review copies stay in the list rather than being
								filtered out of it: a teacher marking thirty submissions moves between them, and
								two students' conflicting Alignments of the same sheet never meet precisely
								because each is in its own Workspace (ADR-0024).
							-->
							<span class="min-w-0">
								<!-- `&nbsp;` and not a literal space: Svelte strips whitespace at the start of an
								     element, so `<span> (open)</span>` renders as "My Workspace(open)". -->
								<span class="block truncate">
									{entry.label}{#if entry.isReviewCopy}<span class="opacity-70"
											>&nbsp;(review copy)</span
										>{/if}{#if entry.isOpen}<span class="opacity-70">&nbsp;(open)</span>{/if}
								</span>
								{#if kindsAreVisible && entry.folderName}
									<!-- The directory's own name, beneath the label the author gave it. Shown
									     because it says which *place* this is; never identity (ADR-0042). -->
									<span
										class="block truncate text-xs opacity-70"
										data-testid="workspace-folder-name">{entry.folderName}</span
									>
								{/if}
								{#if unreachable && entry.isOpen}
									<!--
										⚠ **The only thing here that can send a scholar towards recovery**, and it is
										on the open row because `status` is a fact about the Workspace on screen and
										about no other. A folder that has moved, been renamed or been unplugged is a
										normal state (ADR-0008), and a scholar who cannot see that it has happened has
										no reason to go looking for the control that fixes it.
									-->
									<span class="block text-warning" data-testid="workspace-unreachable">
										Unreachable. The notice on this screen can locate it again.
									</span>
								{/if}
							</span>
						</button>
						<button
							type="button"
							class="shrink-0"
							data-testid="rename-workspace"
							onclick={() => fromMenu(() => startRename(entry))}
						>
							<Pencil size={16} aria-hidden="true" class="shrink-0" />
							<span class="sr-only">Rename {entry.label}</span>
						</button>
						{#if !entry.isOpen}
							<!-- The Workspace you are in is never offered: deleting it out from under a live
							     `EditorSession` leaves an `Autosave` whose next flush recreates the directory, and
							     a folder cannot be taken off the list while it is the list's open row. The
							     refusal lives on the operation as well (`WorkspaceStorage.deleteEntry`). -->
							<button
								type="button"
								class="shrink-0"
								data-testid="delete-workspace"
								onclick={() => fromMenu(() => void askToDelete(entry))}
							>
								<Trash2 size={16} aria-hidden="true" class="shrink-0" />
								<!-- Named in full, because the two kinds do different things: a browser Workspace's
								     bytes go, and a folder's row goes while the folder stays exactly where it is. -->
								<span class="sr-only">
									{#if entry.kind === 'folder'}
										Take {entry.label} off the list
									{:else}
										Delete {entry.label}
									{/if}
								</span>
							</button>
						{/if}
					</li>
				{/each}
				<li>
					<button
						type="button"
						data-testid="new-workspace"
						onclick={() =>
							fromMenu(() => {
								// The switcher button, which is where focus is by now and where it goes back to.
								newNameReturn = menu?.button() ?? null;
								newName = '';
								// After the popover has gone, or focus lands on an element about to be hidden.
								queueMicrotask(() => newNameField?.focus());
							})}
					>
						<Plus size={16} aria-hidden="true" class="shrink-0" />
						New Workspace…
					</button>
				</li>
			</MenuPopover>
		{/if}
	</div>

	{#if newName !== null && storage !== null}
		<!-- Inline on the bar rather than in a dialog: it is one field and one button, and a modal for
		     that is a modal a user has to dismiss to see the Workspace they just left. -->
		<form class="flex items-center gap-2" onsubmit={(event) => void createWorkspace(event)}>
			<label class="text-sm" for={newNameId}>Name</label>
			<input
				id={newNameId}
				class="input input-sm"
				bind:this={newNameField}
				bind:value={newName}
				data-testid="new-workspace-name"
				onkeydown={(event) => {
					if (event.key === 'Escape') closeNewWorkspace();
				}}
			/>
			{#if kindsAreVisible}
				<!--
					⚠ **Radio inputs, not a `role="tablist"` and not a select** (ADR-0016): two mutually
					exclusive answers to one question, each with a visible label, is exactly what a radio
					group is — and it is the only spelling a keyboard and a screen reader both get for free.

					Absent altogether where the browser has no picker, which is what keeps the *kind* from
					being named to somebody who could never choose it (ADR-0042).
				-->
				<fieldset class="flex items-center gap-3" data-testid="new-workspace-kind">
					<legend class="sr-only">Where the new Workspace lives</legend>
					<label class="flex items-center gap-1 text-sm">
						<input
							type="radio"
							class="radio radio-sm"
							value="browser"
							bind:group={newKind}
							data-testid="new-workspace-browser"
						/>
						In this browser
					</label>
					<label class="flex items-center gap-1 text-sm">
						<input
							type="radio"
							class="radio radio-sm"
							value="folder"
							bind:group={newKind}
							data-testid="new-workspace-folder"
						/>
						In a folder
					</label>
				</fieldset>
			{/if}
			<button class="btn btn-primary btn-sm" type="submit" data-testid="create-workspace">
				Create and switch
			</button>
			<button class="btn btn-sm" type="button" onclick={() => closeNewWorkspace()}>Cancel</button>
		</form>
	{/if}

	{#if renaming !== null && storage !== null}
		<!-- The same inline form the creation uses, for the same reason: one field and one button, and
		     a modal for that is a modal a user has to dismiss to see the list they pressed it in. -->
		<form class="flex items-center gap-2" onsubmit={(event) => void commitRename(event)}>
			<label class="text-sm" for={renameId}>New name</label>
			<input
				id={renameId}
				class="input input-sm"
				bind:this={renameField}
				bind:value={renaming.label}
				data-testid="rename-workspace-name"
				onkeydown={(event) => {
					if (event.key === 'Escape') closeRename();
				}}
			/>
			<button class="btn btn-primary btn-sm" type="submit" data-testid="save-workspace-name">
				Rename
			</button>
			<button class="btn btn-sm" type="button" onclick={() => closeRename()}>Cancel</button>
		</form>
	{/if}

	<!--
		What just happened to the Workspace. `aria-live` rather than `role="status"`: the save indicator
		already owns `status` on this bar, and a second one makes `getByRole('status')` ambiguous — which
		is a hint that a screen-reader user would have to disambiguate too. Visually hidden because the
		screen already shows the answer; the announcement is for the reader who cannot see it change.
	-->
	<p class="sr-only" aria-live="polite" data-testid="workspace-announcement">{announcement}</p>
{/snippet}

<!--
	What can be done on this screen, at the far end of the main row — opposite the page-chrome slot
	that says which screen it is, so that where you are and what you can do here are one row.

	The theme control is not among them: it is the shell's, it is the one thing both apps offer
	outright, and it now sits beside these in the main row's right cluster.
-->
{#snippet end()}
	{#if session !== null}
		<!--
			4. The way back from the last edits made on this screen (ADR-0039). A slot rather than a
			button, because either control renders nothing when its end of the history is empty — absent
			is the honest state, and it still has to be one identifiable place on the bar.

			**The Edit History is the screen's, and the bar never switches on route.** A screen declares
			one from an effect whose teardown clears it, exactly as it declares its page chrome; a screen
			that declares nothing draws nothing here, which is how Workspace Home is undo-free without
			being named and how a screen added later is undo-free until it says otherwise.
		-->
		<div class="flex items-center gap-2" data-testid="undo-slot">
			{#if editHistorySlot.history !== null}
				<EditHistoryControls history={editHistorySlot.history} />
			{/if}
		</div>

		<!--
			5. The one door to GitHub — the whole relationship, in one control (ADR-0041).

			**One control where there were two, and behind it one surface where there were five.** A save
			badge, a Remote Status badge, *Check Remote Status*, *Update from GitHub*, *Connect to
			GitHub* and *Publish…* all answered one question — *is my work safe* — and a scholar had no
			way to choose between them. The badge in the eyebrow answers it; this opens the place where
			everything that can be *done* about it lives, and **Publish** and **Update from GitHub**
			stay two separate presses in there, because their consequences differ in kind.

			**On the bar rather than filed away in a settings dialog, and that is what this control is
			for.** A dialog two menus deep is where a person goes when something already works and they
			want it different, and not where anybody looks for *how do I put this on the web*.
			The bar is on every screen including Workspace Home, so a student meets it before they have
			opened a Project, and the surface it opens is the same one wherever it was pressed.

			**It reflects the Workspace rather than offering the same thing twice.** With no Remote it
			offers connecting; with one it says which repository, which is a standing fact and not
			unfinished work. Both presses open the same surface, which lands on whichever of its steps is
			true — there is no second path and no remembered position (see `ConnectToGitHub`).

			**A publish under way is said here**, because this is the one GitHub control on the bar and a
			publish is the one GitHub act that runs for minutes — including after the modal that started
			it was dismissed with Escape. `aria-disabled` and never `disabled`: a `disabled` button leaves
			the tab order the instant it is pressed, dropping a keyboard user's focus to `<body>` for the
			length of the publish (WCAG 2.4.3).
		-->
		{#if publishable && storage !== null}
			<button
				type="button"
				bind:this={doorButton}
				class="btn btn-sm"
				class:btn-primary={storage.remote === null}
				class:btn-disabled={publishing}
				aria-disabled={publishing}
				data-testid="connect-to-github"
				onclick={() => {
					if (!publishing) connectSequence.start();
				}}
			>
				{publishing
					? publishControlLabel(publishProgress)
					: storage.remote === null
						? 'Connect to GitHub'
						: `Connected to ${describeRemote(storage.remote)}`}
			</button>
		{/if}
	{/if}
{/snippet}

<!--
	What is true of the Workspace whatever screen is on: whether the work is kept, and every reason it
	might not be. The eyebrow, beside the Workspace's own identity — a scholar asking whether their
	work is safe is asking about their Workspace and not about this screen.
-->
{#snippet status()}
	{#if session !== null}
		<!--
			7. Where the work is: one badge, two clauses, and everything else one press away (ADR-0041).

			**Whether the work is kept here, and whether GitHub has it, in one line.** ADR-0017 rule 5:
			there is no Save button, so the first clause is the only signal that anything reached storage,
			which is why it is on every screen and not only on the ones that happen to write. The second
			is the question the first does not answer — "Saved locally" is about this machine and says
			nothing about the Remote, and a scholar who reads the one as the other publishes over a
			colleague's afternoon.

			**Two clauses rather than two badges** (ADR-0041). They are the two halves of one question, so
			they share one region and one line; what keeps them apart is that both are always said.

			The GitHub clause only for an ordinary bound Workspace. A Review Workspace is never bound
			(ADR-0024) and an unbound one has nothing to compare against, so the badge is the local clause
			alone and `RemoteStatus`'s disclosure is not mounted at all.
		-->
		<div class="flex min-h-8 items-start" data-testid="save-slot">
			{#if storage !== null && storage.remote !== null && storage.review === null}
				<RemoteStatus
					saveState={session.saveState}
					state={storage.remoteStatusState}
					baseline={storage.baseline}
					update={storage.updateProgress}
					notice={storage.updateNotice}
					failure={storage.updateFailure}
					deletionPreview={storage.deletionPreview}
					onAnswerDeletions={(confirmed) => storage.answerDeletionPreview(confirmed)}
					restoreFocusTo={() => doorButton}
				/>
			{:else}
				<WhereYourWorkIs saveState={session.saveState} />
			{/if}
		</div>

		<!--
			Why the work is not kept, and every neighbouring refusal, as messages the reader can put
			away rather than sentences under the bar for the rest of the session.

			**The badge still says *whether* the work is kept and this says *why not*.** The badge
			is a standing fact and belongs in the bar; each of these is news about something that just
			happened, and the eyebrow is not a log. `Toast` renders nothing here — the words are drawn
			in the layout's one stack — so a save error does not move the badge beside it.

			`refusal` on the three that are inserted at the moment their text first exists, which a polite
			region does not reliably announce (ADR-0016's amendment). `unprotected-browser` is not one of
			them: it is a steady-state fact about the browser, true from the first frame, and an assertive
			announcement would interrupt a scholar mid-alignment to tell them something that was already
			true when they opened the page.
		-->
		<Toast text={session.saveError} testid="save-error" refusal />
		<Toast text={session.protectionWarning} testid="protection-warning" refusal />
		<Toast text={session.deletionWarning} testid="deletion-warning" refusal />
		<Toast text={storage?.unprotected ?? ''} testid="unprotected-browser" />
	{/if}
{/snippet}

<!--
	`status` and no `menu`. The status puts the bar in two rows: the eyebrow holds `start` and the save
	state, and the taller main row holds the screen, the centered wordmark, and `end` + theme. No menu
	because authoring is desktop-only (ADR-0014), so this bar does not fold at any width.
-->
<!--
	The app's own name, in the display face, at the centre of the main row.

	ADR-0036 gives Bluu Next three jobs — it heads a section, names the app, and titles a dialog — and
	this is the one that names the app.

	**A link to the root route, which is what the viewer's own name has always been** (`SiteBar.svelte`
	renders `site-name` as an anchor to `resolve('/')`). The main row is the taller row that a scholar
	scans for where they are, so centering the mark there puts the app's name at the bar's visual
	centre (`AppBar`'s `1fr auto 1fr` grid). A wordmark that is not clickable reads as broken, because
	every other site a scholar uses has trained them otherwise.

	**Not a heading, and not a control label.** Every screen carries exactly one `<h1>` and three specs
	count it, so a second would break them — this is an `<a>`, not a heading. And ADR-0036's rule that
	this face never reaches a *control label* is about the text on a button or an input that names an
	action: naming the app is one of the face's three sanctioned jobs, and a name that is also the way
	home is still a name. The rule would be broken by setting `Publish` in Bluu Next, not by this.

	**Hidden below `lg` on the old masthead; now always flex.** The eyebrow is compact, so the main
	row has room to keep the wordmark centred at every desktop width the editor is used at. It hides
	below `md` only, where the breadcrumbs already need the width.
-->
{#snippet wordmark()}
	<a
		class="hidden link items-center gap-2 font-serif text-xl leading-none link-hover md:flex"
		data-testid="app-wordmark"
		href={resolve('/')}
	>
		<BallastellaMark />
		Ballastella
	</a>
{/snippet}

<AppBar
	{start}
	{end}
	{status}
	{wordmark}
	theme={theme.current}
	onToggleTheme={() => theme.toggle()}
	homeHref={resolve('/')}
/>

<!--
	ADR-0024: a Review Workspace is never published. Not mounted at all inside one, so there is no
	dialog to reach by any route — `WorkspaceStorage.assertNotReviewing` is the second layer, on the
	backup path where the button is in another component entirely.

	Its own live regions — the outcome, the staleness notice and a refusal that outlives the modal —
	render here, immediately under the bar, so that they are on whichever screen the user was on when
	they pressed the button.
-->
{#if publishable && storage !== null}
	<PublishDialog
		{storage}
		bind:open={publishOpen}
		bind:publishing
		bind:progress={publishProgress}
		restoreFocusTo={() => doorButton}
	/>
	<!--
		The guided sequence, mounted **once** and here. Anything else that wants it — a refusal
		offering the way forward, a link that landed on the page — opens this same dialog through
		`connectSequence` rather than mounting a second copy, which is what keeps connecting one
		implementation however it was reached.

		`onpublish` hands off to the button beside it: the sequence ends where publishing begins, and
		there is no second publish path.
	-->
	<ConnectToGitHub
		{storage}
		bind:open={connectSequence.open}
		onpublish={() => (publishOpen = true)}
	/>
{/if}

<!--
	The confirmation, naming the Workspace and what it weighs (ADR-0016).

	⚠ **The two kinds differ in what deleting can honestly mean, and this says which one it is.** A
	browser Workspace lives in storage this application owns, and deleting it takes every Project, Map
	Image and Alignment with it. A folder is the author's own directory, in a place they chose, holding
	files they may be syncing or committing — so what goes is this installation's record of it, and not
	one byte of the work.
-->
<ModalDialog
	bind:open={confirmOpen}
	title={confirming?.kind === 'folder'
		? 'Take this Workspace off the list?'
		: 'Delete this Workspace?'}
>
	<p class="max-w-prose">
		{#if confirming?.kind === 'folder'}
			“{confirming?.label}” will be taken off this list, and this browser will let go of its hold on
			the folder. The folder itself and every file in it stay exactly where they are. Choosing it
			again brings it back.
		{:else}
			“{confirming?.label}” and everything in it — every Project, every Map Image, every Alignment —
			will be deleted from this browser. This cannot be undone.
		{/if}
	</p>
	<p class="mt-3 text-sm" data-testid="delete-workspace-size">
		{#if confirming?.size}
			It holds {confirming.size.files}
			{confirming.size.files === 1 ? 'file' : 'files'}, {describeBytes(confirming.size.bytes)}.
		{:else if confirming?.kind === 'folder'}
			<!-- Reading it would need the browser's permission, and asking for a grant to answer a
			     question the author has not yet agreed to act on is a prompt for nothing. -->
			Ballastella cannot say what the folder holds without opening it, and it is not opening it.
		{:else}
			Working out what it holds…
		{/if}
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (confirmOpen = false)}>Keep it</button>
		<button
			class="btn btn-warning"
			data-testid="confirm-delete-workspace"
			onclick={() => void confirmDelete()}
		>
			{#if confirming?.kind === 'folder'}
				Take “{confirming?.label}” off the list
			{:else}
				Delete “{confirming?.label}”
			{/if}
		</button>
	{/snippet}
</ModalDialog>
