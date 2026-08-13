<script lang="ts">
	// The app's navigation bar: the things that are true on every screen (ticket 04).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHAT BELONGS HERE
	//
	// Which Workspace you are in, which screen you are on and the way off it, what the interface looks
	// like, whether your work is kept, and how to take the last thing back. Every one of them is a
	// question a user has *while* doing something else, which is what makes a persistent bar the right
	// place for them rather than a panel that comes and goes.
	//
	// **Project-specific controls are still excluded**: the Project name, the Base Map switcher, and
	// Project settings all belong to the Project screen, because on the hub they would have to either
	// disappear or lie.
	//
	// The screen's own name and way back arrive through `page-chrome.svelte.ts` — one generic slot a
	// route fills, not a switch on the route. Ticket 04 read the rule more strictly and had each such
	// route carry its own header strip beneath this bar; on `/align`, with two live map panes, that was
	// a second header costing height the maps needed.
	//
	// Before this, the theme toggle was on `/base-map/`, `/layers/` and `/align/` and not on the hub;
	// the save indicator and the undo control were on three pages each, mounted separately. Three
	// copies of a thing that has one meaning is how they came to look different from each other.
	//
	// Workspace identity was a **label** in ticket 04. Ticket 12 makes it a switcher, because browser
	// storage now holds several named Workspaces (ADR-0024) — and from ticket 14 onward one of them can
	// be a throwaway Review Workspace, which is a thing a user must never be in doubt about.

	import { resolve } from '$app/paths';
	import { describeRemote, otherTheme } from '@ballastella/core';
	// Every one `aria-hidden`: each sits beside its own label, and an icon that names itself as well
	// is the same word twice for a screen reader — and would change the accessible name the tests and
	// a user's own "click the button called…" both go by (SPEC story 111).
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Cloud from '@lucide/svelte/icons/cloud';
	import Folder from '@lucide/svelte/icons/folder';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderSearch from '@lucide/svelte/icons/folder-search';
	import Plus from '@lucide/svelte/icons/plus';
	import Settings from '@lucide/svelte/icons/settings';

	import PublishDialog from '$lib/publish/PublishDialog.svelte';
	import { publishControlLabel, type PublishProgress } from '$lib/publish/publish-progress.js';
	import UndoControl from '$lib/undo/UndoControl.svelte';
	import { theme } from '$lib/theme.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import MenuPopover from './MenuPopover.svelte';
	import { pageChrome } from './page-chrome.svelte.js';
	import RemoteSettings from './RemoteSettings.svelte';
	import SaveIndicator from './SaveIndicator.svelte';
	import WorkspaceSettings from './WorkspaceSettings.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	/**
	 * Which Workspace this is, in words (SPEC story 88).
	 *
	 * Named rather than iconified, because "which Workspace did that last edit go into?" is exactly
	 * the question a scholar asks after their work is not where they left it — and a disc glyph
	 * answers it for nobody using a screen reader (SPEC story 111).
	 *
	 * The Workspace's own name in both backings, rather than "Browser storage", which named the
	 * *backing*: with several named Workspaces on one backing that sentence no longer identifies
	 * anything, and from ticket 14 a Review Workspace is browser-backed too.
	 */
	const workspaceName = $derived(storage === null ? 'Starting…' : storage.name);

	/** Whether the folder Workspace cannot be reached, which is what turns "choose" into "locate again". */
	const unreachable = $derived(session?.status === 'unreachable');

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();
	let settingsOpen = $state(false);
	let remoteOpen = $state(false);
	let publishOpen = $state(false);
	/**
	 * Whether a publish is running, and how far it has got.
	 *
	 * Bound out of `PublishDialog` rather than kept there, because the control that started it is on
	 * this bar and has to say so: `aria-disabled` with a label that reflects progress, never
	 * `disabled` — a `disabled` button leaves the tab order the instant it is pressed, dropping a
	 * keyboard user's focus to `<body>` for the length of the publish (SPEC story 60, WCAG 2.4.3).
	 */
	let publishing = $state(false);
	let publishProgress = $state<PublishProgress | null>(null);
	/**
	 * Whether this Workspace may be published at all (ADR-0024, SPEC story 39).
	 *
	 * Absent inside a review copy rather than present and refused, which is the arrangement the hub
	 * already had: the review copy holds somebody else's work, the hub says so in words where the
	 * button used to be, and `packages/core` refuses the binding by any route regardless.
	 */
	const publishable = $derived(storage !== null && storage.review === null);
	/** The new-Workspace field, or `null` when it is not being asked for. */
	let newName = $state<string | null>(null);
	let newNameField = $state<HTMLInputElement | undefined>();
	/**
	 * A hydration-stable id for the inline field's label.
	 *
	 * Not a literal, for the reason `MenuPopover` documents about its own: a hardcoded id is a
	 * collision waiting for the second instance on a page, and `for`/`id` is the whole of what ties a
	 * label to its field for a screen reader.
	 */
	const newNameId = $props.id();
	/** The button the inline form was opened from, so focus has somewhere to go back to. */
	let newNameReturn: HTMLElement | null = null;

	/**
	 * What just happened to the Workspace, announced (SPEC stories 111 and 112).
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
		(newNameReturn ?? menu?.button())?.focus();
		newNameReturn = null;
	}

	async function switchWorkspace(name: string): Promise<void> {
		if (!storage) return;
		await storage.openWorkspace(name);
		announcement = `Switched to the Workspace “${name}”.`;
	}

	/**
	 * Say what a folder action did.
	 *
	 * The three folder actions report nothing of their own: `chooseFolder` returns silently when the
	 * picker is dismissed, and puts a refusal on `storage.problem` rather than throwing. So the
	 * announcement is made from what the Workspace *is* afterwards, which is the only thing that is
	 * true in every one of those cases.
	 */
	async function changeBacking(act: () => Promise<void>): Promise<void> {
		if (!storage) return;
		const was = storage.backing;
		const wasFolder = storage.folderName;
		await act();
		// A refusal is not announced from here. `storage.problem` already renders as a `role="alert"`
		// through `WorkspaceRecovery`, which is on every screen this bar is; saying it again in the
		// live region is the same sentence twice for a screen-reader user, and a second `alert` on the
		// page for anyone querying by role.
		if (!storage.problem && (storage.backing !== was || storage.folderName !== wasFolder)) {
			announcement =
				storage.backing === 'folder'
					? `Your Workspace is now the folder “${storage.folderName}”.`
					: `Your Workspace is now “${storage.workspaceName}”, in this browser's storage.`;
		}
		// Otherwise nothing changed — a dismissed picker, a permission prompt declined — and saying
		// "your Workspace is now…" would announce something the user did not do.
	}

	const chooseFolder = () =>
		changeBacking(async () => {
			await storage?.chooseFolder();
		});
	const reopenFolder = () =>
		changeBacking(async () => {
			await storage?.reopenFolder();
		});
	const useBrowserStorage = () =>
		changeBacking(async () => {
			await storage?.useBrowserStorage();
		});

	async function createWorkspace(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = newName ?? '';
		if (asked.trim() === '') {
			closeNewWorkspace();
			return;
		}
		closeNewWorkspace();
		try {
			const made = await storage?.createWorkspace(asked);
			// The name it *really* got, which may carry a ` (2)` the user did not type. Saying the typed
			// name back would be the one announcement that is wrong exactly when it matters.
			announcement = `Created the Workspace “${made}” and switched to it.`;
		} catch (cause) {
			announcement = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<!--
	`<header>` with a `banner` role by placement, holding the four. Not `<nav>`: nothing here
	navigates in this slice, and announcing a navigation landmark with no links in it is a promise
	the bar does not keep.
-->
<header
	data-testid="navigation-bar"
	class="flex flex-wrap items-center gap-4 border-b border-base-300 bg-base-200 px-4 py-2"
>
	<!--
		1. Which Workspace, and the way to another one.

		**Always visible, on every screen** — the label was, and the switcher has to be for a stronger
		reason: from ticket 14 a user can be inside a throwaway Review Workspace, and a control that
		says which one you are in is worth nothing on the screens it is missing from.

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
			     Workspace settings, and in the button's own `title`-free accessible name, which is the
			     text node rather than the ellipsis CSS paints over it. -->
			<MenuPopover
				bind:this={menu}
				label={workspaceName}
				buttonClass="btn max-w-[14rem] truncate btn-sm font-medium"
				testid="workspace-switcher"
			>
				<li class="menu-title">Switch to</li>
				{#each storage.workspaces as name (name)}
					<li>
						<button
							type="button"
							data-testid="switch-workspace"
							data-workspace={name}
							aria-current={storage.isOpen(name) ? 'true' : undefined}
							onclick={() => fromMenu(() => void switchWorkspace(name))}
						>
							<!-- A browser window, because that is where these are: the user needs to know their
							     work is in the browser rather than among their own files, and never that the
							     mechanism underneath is called OPFS. -->
							<AppWindow size={16} aria-hidden="true" class="shrink-0" />
							<!--
								The name and what is true of it in **one** truncating span, so they stay next to
								each other: as separate flex children the name's `truncate` takes the free space
								and shunts "(open)" to the far edge of the menu, where it reads as a column
								heading rather than as part of the line it belongs to.

								Which of these is somebody else's work in a throwaway Workspace, in **words**
								rather than as a tint or an icon (workspace-and-layers SPEC story 111). Review copies stay in the
								list rather than being filtered out of it: a teacher marking thirty submissions
								moves between them, and two students' conflicting Alignments of the same sheet
								never meet precisely because each is in its own Workspace (ADR-0024).
							-->
							<!-- `&nbsp;` and not a literal space: Svelte strips whitespace at the start of an
							     element, so `<span> (open)</span>` renders as "My Workspace(open)". -->
							<span class="truncate">
								{name}{#if storage.reviewWorkspaces.includes(name)}<span class="opacity-70"
										>&nbsp;(review copy)</span
									>{/if}{#if storage.isOpen(name)}<span class="opacity-70">&nbsp;(open)</span>{/if}
							</span>
						</button>
					</li>
				{/each}
				{#if storage.backing === 'folder'}
					<!-- The folder Workspace is not one of the named ones and never appears in the list: it
					     is a different backing, and showing it as a sibling would suggest it can be deleted
					     from settings alongside them, which it cannot. -->
					<li>
						<span class="opacity-70">
							<Folder size={16} aria-hidden="true" class="shrink-0" />
							<span class="truncate">
								{storage.folderName || 'A folder on this computer'} (open)
							</span>
						</span>
					</li>
				{/if}
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
				<!--
					A Workspace folder on the user's own disk, offered here rather than only in settings.

					⚠ **Only where the browser has the picker at all.** `canChooseFolder` is the File System
					Access API's presence, which Firefox and iOS Safari do not have — and ADR-0001 makes a
					folder Workspace a capability upgrade and never a gate, so a browser without it must not
					be shown a route it cannot take.

					These are real clicks, which is what `showDirectoryPicker()` and `requestPermission()`
					need: called without transient user activation they fail silently (ADR-0012).
				-->
				{#if storage.canChooseFolder || storage.backing === 'folder'}
					<li class="menu-title">Folder on this computer</li>
					{#if storage.backing === 'folder'}
						{#if unreachable}
							<!-- ADR-0008: a folder that has moved, been renamed, or been unplugged is a normal
							     state, and locating it again is the recovery. -->
							<li>
								<button
									type="button"
									data-testid="locate-workspace-folder"
									onclick={() => fromMenu(() => void chooseFolder())}
								>
									<FolderSearch size={16} aria-hidden="true" class="shrink-0" />
									Locate Workspace folder again…
								</button>
							</li>
						{/if}
						<li>
							<button
								type="button"
								data-testid="use-browser-storage"
								onclick={() => fromMenu(() => void useBrowserStorage())}
							>
								<AppWindow size={16} aria-hidden="true" class="shrink-0" />
								Use browser storage instead
							</button>
						</li>
					{:else}
						{#if storage.reopenable}
							<li>
								<button
									type="button"
									data-testid="reopen-workspace-folder"
									onclick={() => fromMenu(() => void reopenFolder())}
								>
									<FolderOpen size={16} aria-hidden="true" class="shrink-0" />
									<span class="truncate">Reopen “{storage.reopenable}”</span>
								</button>
							</li>
						{/if}
						<li>
							<button
								type="button"
								data-testid="choose-workspace-folder"
								onclick={() => fromMenu(() => void chooseFolder())}
							>
								<Folder size={16} aria-hidden="true" class="shrink-0" />
								Choose Workspace folder…
							</button>
						</li>
					{/if}
				{/if}
				<!--
					Where this Workspace publishes (ticket 03, ADR-0032).

					⚠ **In the menu and nowhere else until it is bound.** A scholar who never publishes must
					never meet a sign-in prompt (SPEC story 38), so nothing about GitHub is on the bar, on
					the hub, or on any screen until they have opened this and named a repository. A menu
					item behind a button they chose to press is not a prompt.

					**Offered inside a review copy too, rather than hidden.** The refusal lives in
					`packages/core` — a Review Workspace cannot be bound by any route — and the dialog says
					why in words. An absent control explains nothing and teaches nobody the rule.
				-->
				<li>
					<button
						type="button"
						data-testid="open-remote-settings"
						onclick={() => fromMenu(() => (remoteOpen = true))}
					>
						<Cloud size={16} aria-hidden="true" class="shrink-0" />
						Remote repository…
					</button>
				</li>
				<li>
					<button
						type="button"
						data-testid="open-workspace-settings"
						onclick={() => fromMenu(() => (settingsOpen = true))}
					>
						<Settings size={16} aria-hidden="true" class="shrink-0" />
						Workspace settings…
					</button>
				</li>
			</MenuPopover>
		{/if}
	</div>

	<!--
		1a. Where this Workspace publishes, and whether anything may push there (SPEC story 36).

		⚠ **Absent entirely until the Workspace is bound**, which is the whole of story 38: a scholar
		who never publishes is never shown a sign-in prompt, so a first visit has no GitHub affordance
		anywhere on the bar. Once bound, both facts are here because they answer one question —
		*where will the button send my work, and as whom* — and separating them is how a scholar comes
		to be sure of one and wrong about the other.

		"Signed in" is read from the credential store rather than from anything remembered here, so it
		says what is **true**: the store is sealed while a Review Workspace is open (ADR-0033, story
		40), and a token that cannot be read is a token this bar must not claim to hold.
	-->
	{#if storage?.remote}
		<div class="flex items-center gap-2 text-sm" data-testid="remote-identity">
			<span class="opacity-70">Remote:</span>
			<span class="max-w-[14rem] truncate font-medium" data-testid="remote-name">
				{describeRemote(storage.remote)}
			</span>
			<span class="opacity-70" data-testid="remote-credential">
				{storage.signedIn ? 'Signed in to GitHub' : 'Not signed in'}
			</span>
		</div>
	{/if}

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
			<button class="btn btn-primary btn-sm" type="submit" data-testid="create-workspace">
				Create and switch
			</button>
			<button class="btn btn-sm" type="button" onclick={() => closeNewWorkspace()}>Cancel</button>
		</form>
	{/if}

	<!--
		What just happened to the Workspace. `aria-live` rather than `role="status"`: the save indicator
		already owns `status` on this bar, and a second one makes `getByRole('status')` ambiguous — which
		is a hint that a screen-reader user would have to disambiguate too. Visually hidden because the
		screen already shows the answer; the announcement is for the reader who cannot see it change.
	-->
	<p class="sr-only" aria-live="polite" data-testid="workspace-announcement">{announcement}</p>

	<!--
		2. Which screen this is, and the way off it — whatever the screen said it was, and nothing when a
		screen (the hub) says nothing.

		A real `<h1>`: the bar is before `children()`, so this is the first heading a screen reader
		reaches. The link is spelled out here rather than handed over finished because
		`svelte/no-navigation-without-resolve` checks the literal start of an `href` — hence
		{@link WayBack} carrying a Project directory.
	-->
	{#if pageChrome.heading !== ''}
		<div class="flex min-w-0 items-center gap-3" data-testid="page-chrome">
			<h1 class="truncate text-base font-bold" data-testid="page-heading">
				{pageChrome.heading}
			</h1>
			{#if pageChrome.back}
				<a
					class="btn btn-sm"
					data-testid={pageChrome.back.testid}
					href="{resolve('/')}?p={encodeURIComponent(pageChrome.back.project)}"
				>
					{pageChrome.back.label}
				</a>
			{/if}
		</div>
	{/if}

	<div class="grow"></div>

	<!-- 3. The theme, for the interface and the Base Map together (SPEC stories 109, 110). One
	     control in the whole app, and it says what it will do rather than what it is. -->
	<button
		type="button"
		class="btn btn-sm"
		data-testid="theme-toggle"
		onclick={() => theme.toggle()}
	>
		Switch to {otherTheme(theme.current)} theme
	</button>

	{#if session !== null}
		<!--
			4. The way back from the last destructive action (SPEC story 12, ADR-0014). A slot rather
			than a button, because `UndoControl` renders nothing when there is nothing to undo — absent
			is the honest state, and it still has to be one identifiable place on the bar.
		-->
		<div data-testid="undo-slot">
			<UndoControl {session} />
		</div>

		<!--
			5. Putting the work on the web (SPEC story 1, ADR-0032).

			**Beside the save indicator, and that is the whole point of both.** "Saved locally" and
			"Publish" answer the two questions a scholar has about where their work is, and separating
			them across two screens is how somebody comes to believe a saved edit is a published one.
			The Workspace is the site (ADR-0008), so this belongs to the bar rather than to a Project —
			it was on the hub, which meant it was absent from every screen where a person is actually
			working.

			**Enabled in every state except while it is running**, and each of them leads somewhere: it
			offers the binding when there is none, asks for the credential when there is no credential,
			and says so when nothing needs changing. A disabled Publish button with no explanation is
			the failure this epic exists to remove.
		-->
		{#if publishable}
			<button
				type="button"
				class="btn btn-sm"
				class:btn-disabled={publishing}
				aria-disabled={publishing}
				data-testid="publish"
				onclick={() => {
					if (!publishing) publishOpen = true;
				}}
			>
				{publishing ? publishControlLabel(publishProgress) : 'Publish…'}
			</button>
		{/if}

		<!-- 6. Whether the work is kept. ADR-0017 rule 5: there is no Save button, so this is the
		     only signal that anything reached storage — which is why it is on every screen and not
		     only on the ones that happen to write. -->
		<div class="flex flex-col items-end" data-testid="save-slot">
			<SaveIndicator saveState={session.saveState} />
			{#if session.saveError}
				<!--
					**Why the work is not kept, and it has to be announced.** `SaveIndicator`'s own live
					region says "Unsaved changes"; the reason — a full disk, a folder grant that lapsed, a
					Project another tab deleted — is this sentence, and it sits outside that region. Without
					a role of its own it is inserted silently, so a screen-reader user is told that something
					went wrong and never what. `role="alert"` because it is inserted at the moment its text
					first exists, which a `polite` region does not reliably announce, and because it is what
					every other error in this app uses.

					This bug is inherited: the same markup sat in the align route's header and on
					`ProjectView`, where it was wrong on two screens. It is on **every** screen now, which is
					what makes fixing it part of this ticket rather than a note for a later one.
				-->
				<p role="alert" class="text-sm text-warning" data-testid="save-error">
					{session.saveError}
				</p>
			{/if}
			<!--
				**A different sentence from the one above, with a different remedy** (ticket 20).
				`save-error` says the edit did not reach storage. This says the edit is on its way and
				the copy that would survive closing the tab before it lands could not be kept — a full
				`localStorage`, usually an Annotation collection larger than the origin's whole quota.
				The user can act on it only while this page still exists, which is exactly why the
				journal is written at the edit rather than at `pagehide`, where there would be no screen
				left to put this on.

				`role="alert"` for the same reason `save-error` uses it: it is inserted at the moment its
				text first exists, and a polite region does not reliably announce that (SPEC story 112).
			-->
			{#if session.protectionWarning}
				<p role="alert" class="max-w-md text-sm text-warning" data-testid="protection-warning">
					{session.protectionWarning}
				</p>
			{/if}
			<!--
				**Two refusals, not one** (ADR-0017; ticket 21, review 2). The sentence above is about an
				edit on its way to storage and its remedy is "wait for the indicator to read 'Saved'" —
				a deletion has no indicator and no such wait, so that sentence is not this one and does
				not stand in for it. It is also not shown at all in the case where `record` actually
				fails most often: a `localStorage` that answers reads and rejects every write, which is
				Safari with cookies blocked and is a browser the read-only probe accepts.

				`role="alert"` for the same reason the two above use it: inserted at the instant its text
				first exists, which a polite region does not reliably announce (SPEC story 112).
			-->
			{#if session.deletionWarning}
				<p role="alert" class="max-w-md text-sm text-warning" data-testid="deletion-warning">
					{session.deletionWarning}
				</p>
			{/if}
			<!--
				And the browser that cannot offer the protection at all — a private window with site data
				blocked. Said once, on every screen, rather than letting the app imply a guarantee it does
				not have on that browser.

				⚠ **`aria-live="polite"` and not `role="alert"`**, unlike the two above. This is a
				steady-state fact about the browser, true from the first frame and unchanged for the whole
				session — CONTRIBUTING's mandated-method table puts Status in a polite region, and an
				assertive one would interrupt a scholar mid-alignment to tell them something that was
				already true when they opened the page.
			-->
			{#if storage?.unprotected}
				<p
					aria-live="polite"
					class="max-w-md text-sm text-warning"
					data-testid="unprotected-browser"
				>
					{storage.unprotected}
				</p>
			{/if}
		</div>
	{/if}
</header>

<!--
	Outside the `<header>` so the bar's own layout does not have to make room for a modal, and mounted
	unconditionally so the `<dialog>` element exists before `showModal()` is asked for.
-->
{#if storage !== null}
	<WorkspaceSettings bind:open={settingsOpen} {storage} />
	<RemoteSettings bind:open={remoteOpen} {storage} />
{/if}

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
	/>
{/if}
