<script lang="ts">
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * The two ways a Workspace can be not-here, and the gesture out of each.
	 *
	 * Both are **normal states with recoveries**, not exceptions (ADR-0008), and both are reachable on
	 * a page that is not the hub — which is where they were previously unhandled. `StorageChoice` is
	 * hub-only by design, because *choosing* where a Workspace lives is a Workspace-level act; but
	 * recovering a Workspace you are already using is not a choice, it is the way back to the Project
	 * you asked for. So it belongs beside the Project.
	 *
	 * - **Not reachable.** The folder was moved, renamed, or deleted. Ticket 12 is what made this
	 *   possible for a Project page at all: in OPFS the root cannot vanish. The Project page rendered
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

{#if unreachable}
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
			<button class="btn btn-sm" onclick={() => storage.session.refresh()}>
				Locate Workspace again
			</button>
		{/if}
	</div>
{:else if storage.awaitingFolder}
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

{#if storage.problem}
	<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
		<h2 class="font-semibold">Your Workspace folder was not opened</h2>
		<p>{storage.problem}</p>
		<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>Choose a folder again</button>
	</div>
{/if}
