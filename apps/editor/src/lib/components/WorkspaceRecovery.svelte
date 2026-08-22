<script lang="ts">
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * The two ways a Workspace can be not-here, and the gesture out of each.
	 *
	 * Both are **normal states with recoveries**, not exceptions (ADR-0008), and both are reachable on
	 * every screen — the hub, the Project, and the align route. *Choosing* where a Workspace lives is
	 * a setting now (ticket 12), reached from the bar; recovering a Workspace you are already using is
	 * not a choice at all, it is the way back to the work you asked for, and burying it behind a
	 * dialog would leave a scholar looking at an empty hub with nothing to explain it.
	 *
	 * - **Not reachable.** The folder was moved, renamed, or deleted. Only a folder Workspace can reach
	 *   this state: an OPFS directory cannot vanish under the app. The Project page rendered
	 *   "Opening…" for ever, because `status` went to `unreachable` while `openProject` and
	 *   `projectProblem` both stayed null and nothing looked at `status`.
	 * - **Remembered but not open.** Returning to a bookmarked `?p=` needs `requestPermission()`,
	 *   which needs a user gesture, so the folder is not open yet. Without this the page said "There
	 *   is no Project called amsterdam-1625 in this Workspace" — true of browser storage, and exactly
	 *   the wrong thing to tell someone whose Project is sitting in a folder on their desk.
	 *
	 * `null` renders nothing, so a caller can hand this the state and let it decide.
	 */
	let { storage }: { storage: WorkspaceStorage } = $props();

	const unreachable = $derived(storage.session.status === 'unreachable');
</script>

<!--
	⚠ **First, and on its own** (ticket 05). An Import that did not finish leaves its provisional files
	at ordinary Workspace paths under one durable marker, so a Workspace whose marker cannot be
	resolved does not open at all — no Project list, no Map Image list, no size, no Backup, no Publish
	and no Project. That is not one state among the two below but the absence of a Workspace to have
	them about, so nothing else on this component renders beside it, and neither does the hub's list.

	No button. The recovery *is* a reload: the marker is untouched, so the next startup tries again
	from the same inventory, and a control offering to do it now would be offering the thing that has
	just been tried. Staging internals are not the user's to see either — the sentence names what
	happened to their Import and what to do about it (ADR-0008: a normal state with a way back).
-->
{#if storage.unrecoveredImport}
	<div
		role="alert"
		class="mt-8 alert flex-col items-start alert-warning"
		data-testid="unrecovered-import"
	>
		<h2 class="font-semibold">This Workspace is not open yet</h2>
		<p>{storage.unrecoveredImport}</p>
	</div>
{:else if unreachable}
	<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
		<h2 class="font-semibold">Workspace not reachable</h2>
		<p>
			Your Workspace could not be opened, so this Project cannot be shown. Nothing has been lost —
			it is still wherever it was.
		</p>
		{#if storage.session.unreachableDetail}
			<p class="text-sm opacity-80">The browser reported: {storage.session.unreachableDetail}</p>
		{/if}
		{#if storage.backing === 'folder'}
			<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>
				Locate Workspace folder again
			</button>
		{:else}
			<!-- A **new store**, not a re-listing: a named OPFS Workspace can be deleted by a second
			     tab, and `DirectoryHandleStore` caches its root handle, so re-listing goes through the
			     dead one for ever. See `WorkspaceStorage.locateWorkspaceAgain`. -->
			<button class="btn btn-sm" onclick={() => storage.locateWorkspaceAgain()}>
				Locate Workspace again
			</button>
		{/if}
	</div>
{:else if storage.awaitingFolder && !storage.problem}
	<!--
		⚠ **Not while there is a `problem`.** The two states overlap exactly once and it is the common
		case: a reopen whose permission was declined leaves the folder remembered *and* leaves an
		explanation of why it did not open. Both blocks then render, and a screen reader is handed two
		alerts — "your folder is not open yet" and "your folder was not opened" — which say the same
		thing twice and answer nothing between them. The explanation wins, because it is the one that
		says what happened, and it carries its own way back.
	-->
	<div role="alert" class="mt-8 alert flex-col items-start alert-info">
		<h2 class="font-semibold">Your Workspace folder is not open yet</h2>
		<p>
			Your work is in the folder <code>{storage.reopenable}</code>, and your browser asks permission
			for it each time you return. Open it to see this Project.
		</p>
		<!-- Must be a real click or keypress: `requestPermission()` needs transient user activation,
		     and called automatically on load it fails silently (ADR-0012). -->
		<button class="btn btn-primary btn-sm" onclick={() => storage.reopenFolder()}>
			Reopen “{storage.reopenable}”
		</button>
	</div>
{/if}

{#if storage.problem && !storage.unrecoveredImport}
	<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
		<h2 class="font-semibold">Your Workspace folder was not opened</h2>
		<p>{storage.problem}</p>
		<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>Choose a folder again</button>
	</div>
{/if}
