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

	/** Open something from the menu, having handed focus back first — see `MenuPopover.dismiss`. */
	function fromMenu(act: () => void): void {
		menu?.dismiss();
		act();
	}

	async function createWorkspace(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = newName ?? '';
		newName = null;
		if (asked.trim() === '') return;
		await storage?.createWorkspace(asked);
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
			<MenuPopover
				bind:this={menu}
				label={workspaceName}
				buttonClass="btn btn-sm font-medium"
				testid="workspace-switcher"
			>
				<li class="menu-title">Switch to</li>
				{#each storage.workspaces as name (name)}
					<li>
						<button
							type="button"
							data-testid="switch-workspace"
							data-workspace={name}
							aria-current={storage.backing === 'browser' && name === storage.workspaceName
								? 'true'
								: undefined}
							onclick={() => fromMenu(() => void storage.openWorkspace(name))}
						>
							{name}
							{#if storage.backing === 'browser' && name === storage.workspaceName}
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
			<label class="text-sm" for="new-workspace-name">Name</label>
			<input
				id="new-workspace-name"
				class="input input-sm"
				bind:this={newNameField}
				bind:value={newName}
				data-testid="new-workspace-name"
				onkeydown={(event) => {
					if (event.key === 'Escape') newName = null;
				}}
			/>
			<button class="btn btn-primary btn-sm" type="submit" data-testid="create-workspace">
				Create and switch
			</button>
			<button class="btn btn-sm" type="button" onclick={() => (newName = null)}>Cancel</button>
		</form>
	{/if}

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
