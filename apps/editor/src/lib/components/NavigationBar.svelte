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
	// Workspace identity is a **label** in this slice. Ticket 12 makes it a switcher.

	import { otherTheme } from '@ballastella/core';

	import UndoControl from '$lib/undo/UndoControl.svelte';
	import { theme } from '$lib/theme.svelte';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import SaveIndicator from './SaveIndicator.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);

	/**
	 * Which Workspace this is, in words (SPEC story 88).
	 *
	 * Named rather than iconified, because "am I in the folder one or the browser one?" is exactly
	 * the question a scholar asks after their last edit went somewhere they did not expect — and a
	 * disc glyph answers it for nobody using a screen reader (SPEC story 111).
	 */
	const workspaceName = $derived(
		storage === null
			? 'Starting…'
			: storage.backing === 'folder' && storage.folderName
				? storage.folderName
				: 'Browser storage'
	);
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
	<!-- 1. Which Workspace. -->
	<p class="text-sm" data-testid="workspace-identity">
		<span class="opacity-70">Workspace:</span>
		<span class="font-medium">{workspaceName}</span>
	</p>

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
