<script lang="ts">
	// The app's navigation bar: the four things that are true on every screen (ticket 04).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY EXACTLY FOUR, AND WHY THESE FOUR
	//
	// Which Workspace you are in, what the interface looks like, whether your work is kept, and how
	// to take the last thing back. Every one of them is answerable without knowing what is on screen,
	// and every one of them is a question a user has *while* doing something else — which is what
	// makes a persistent bar the right place for them rather than a panel that comes and goes.
	//
	// **Project-specific controls are deliberately excluded**: the Project name, the Base Map
	// switcher, and Project settings all belong to the Project screen, because on the hub they would
	// have to either disappear or lie. A bar whose contents depend on the route is not a bar, it is
	// three headers wearing one.
	//
	// Before this, the theme toggle was on `/base-map/`, `/layers/` and `/align/` and not on the hub;
	// the save indicator and the undo control were on three pages each, mounted separately. Three
	// copies of a thing that has one meaning is how they came to look different from each other.
	//
	// Workspace identity was a **label** in ticket 04. Ticket 12 makes it a switcher, because browser
	// storage now holds several named Workspaces (ADR-0024) — and from ticket 14 onward one of them can
	// be a throwaway Review Workspace, which is a thing a user must never be in doubt about.

	import { otherTheme } from '@ballastella/core';

	import UndoControl from '$lib/undo/UndoControl.svelte';
	import { theme } from '$lib/theme.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import MenuPopover from './MenuPopover.svelte';
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

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();
	let settingsOpen = $state(false);
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
							class="block truncate"
							data-testid="switch-workspace"
							data-workspace={name}
							aria-current={storage.isOpen(name) ? 'true' : undefined}
							onclick={() => fromMenu(() => void switchWorkspace(name))}
						>
							{name}
							{#if storage.isOpen(name)}
								<span class="opacity-70">(open)</span>
							{/if}
						</button>
					</li>
				{/each}
				{#if storage.backing === 'folder'}
					<!-- The folder Workspace is not one of the named ones and never appears in the list: it
					     is a different backing, and showing it as a sibling would suggest it can be deleted
					     from settings alongside them, which it cannot. -->
					<li>
						<span class="opacity-70"
							>{storage.folderName || 'A folder on this computer'} (open)</span
						>
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
						New Workspace…
					</button>
				</li>
				<li>
					<button
						type="button"
						data-testid="open-workspace-settings"
						onclick={() => fromMenu(() => (settingsOpen = true))}
					>
						Workspace settings…
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

	<div class="grow"></div>

	<!-- 2. The theme, for the interface and the Base Map together (SPEC stories 109, 110). One
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
			3. The way back from the last destructive action (SPEC story 12, ADR-0014). A slot rather
			than a button, because `UndoControl` renders nothing when there is nothing to undo — absent
			is the honest state, and it still has to be one identifiable place on the bar.
		-->
		<div data-testid="undo-slot">
			<UndoControl {session} />
		</div>

		<!-- 4. Whether the work is kept. ADR-0017 rule 5: there is no Save button, so this is the
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
		</div>
	{/if}
</header>

<!--
	Outside the `<header>` so the bar's own layout does not have to make room for a modal, and mounted
	unconditionally so the `<dialog>` element exists before `showModal()` is asked for.
-->
{#if storage !== null}
	<WorkspaceSettings bind:open={settingsOpen} {storage} />
{/if}
