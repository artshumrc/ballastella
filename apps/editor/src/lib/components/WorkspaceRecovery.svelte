<script lang="ts">
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * A Workspace that cannot be reached, and the gesture out of it.
	 *
	 * A **normal state with a recovery**, not an exception (ADR-0008), and reachable on every screen —
	 * the hub, the Project, and the align route. *Choosing* where a Workspace lives is a choice made
	 * in the roster; recovering the Workspace you are already inside is not a choice at all, it is the
	 * way back to the work you asked for, and burying it behind a dialog would leave a scholar looking
	 * at an empty hub with nothing to explain it.
	 *
	 * The folder was moved, renamed, unplugged or deleted **while the author was in it**. Only a
	 * folder Workspace normally reaches this — an OPFS directory cannot vanish under the app unless a
	 * second tab removes it — and the Project page rendered "Opening…" for ever before, because
	 * `status` went to `unreachable` while `openProject` and `projectProblem` both stayed null and
	 * nothing looked at `status`.
	 *
	 * ⚠ **A folder from a previous visit is not one of these** (ADR-0042). It used to be, and the
	 * notice it drew was on the hub for ever with no control anywhere that could clear it. A folder
	 * that is not open is a row in the roster, which is what every other Workspace not open is.
	 *
	 * Renders nothing when there is nothing wrong, so a caller can hand this the state and let it
	 * decide.
	 */
	let { storage }: { storage: WorkspaceStorage } = $props();

	const unreachable = $derived(storage.session.status === 'unreachable');
</script>

<!--
	⚠ **First, and on its own**. An Import or an Update that did not finish leaves its provisional
	files at ordinary Workspace paths under one durable marker, so a Workspace whose marker cannot be
	resolved does not open at all — no Project list, no Map Image list, no size, no Backup, no Publish
	and no Project. That is not one state among the two below but the absence of a Workspace to have
	them about, so nothing else on this component renders beside it, and neither does the hub's list.

	No button. The recovery *is* a reload: the marker is untouched, so the next startup tries again
	from the same inventory, and a control offering to do it now would be offering the thing that has
	just been tried. Staging internals are not the user's to see either — the sentence names what
	happened to their transfer and what to do about it (ADR-0008: a normal state with a way back).
-->
{#if storage.unavailable}
	<div
		role="alert"
		class="mt-8 alert flex-col items-start alert-warning"
		data-testid="unrecovered-import"
	>
		<h2 class="font-semibold">This Workspace is not open yet</h2>
		<p>{storage.unavailable}</p>
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
{/if}

{#if storage.problem && !storage.unavailable}
	<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
		<h2 class="font-semibold">Your Workspace folder was not opened</h2>
		<p>{storage.problem}</p>
		<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>Choose a folder again</button>
	</div>
{/if}
