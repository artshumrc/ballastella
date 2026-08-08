<script lang="ts">
	import { describeBytes, type WorkspaceSize } from '@ballastella/core';

	import InstallOffer from '$lib/pwa/InstallOffer.svelte';

	import ModalDialog from './ModalDialog.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * Workspace settings: where the work is kept, and what may be done to the Workspaces themselves.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THIS IS A SETTING AND NOT FIRST CONTACT
	 *
	 * `StorageChoice` was a permanently visible hub section headed "Where your work is stored", and
	 * it was the first thing a scholar met. ADR-0001's own principle is that a folder Workspace is a
	 * capability upgrade and **never a gate** — and the hub asked the question anyway, of everyone,
	 * including the majority of browsers where the answer is "there is no picker here". Browser
	 * storage is the silent default now, and this is where the question is answered by whoever wants
	 * to ask it.
	 *
	 * **What did not move is the recovery.** `WorkspaceRecovery` still renders on the hub and on the
	 * Project screen the moment a folder Workspace cannot be reached (ADR-0008): a moved, renamed, or
	 * unplugged folder is a normal state with a way back, and burying it behind a settings dialog
	 * would leave a scholar looking at an empty hub with nothing to explain it.
	 *
	 * Every explanation here is **visible text**, not a tooltip: daisyUI renders tooltips through CSS
	 * `::before`, so they are neither announced nor dismissable (ADR-0016, SPEC story 111).
	 */
	let { open = $bindable(false), storage }: { open?: boolean; storage: WorkspaceStorage } =
		$props();

	const unreachable = $derived(storage.session.status === 'unreachable');

	/** The Workspaces that may be deleted: every named one except the one being looked out of. */
	const deletable = $derived(storage.workspaces.filter((name) => !storage.isOpen(name)));

	/** The Workspace the confirmation is about, or `null` when nothing is being confirmed. */
	let confirming = $state<{ name: string; size: WorkspaceSize | null } | null>(null);
	/** Whether the confirmation is showing. Separate from {@link confirming} so Escape can close it. */
	let confirmOpen = $state(false);
	/** What happened to the last delete, announced. */
	let outcome = $state('');

	async function askToDelete(name: string): Promise<void> {
		// The size is read *before* the confirmation is answered rather than quoted from a tally,
		// because what the user is agreeing to is the bytes that are there now (ADR-0016 wants the
		// Workspace and its size named). `list` + `size`, never `read` — a Workspace with a mirrored
		// pyramid in it is tens of thousands of files.
		confirming = { name, size: null };
		confirmOpen = true;
		const size = await storage.sizeOfWorkspace(name).catch(() => null);
		if (confirming?.name === name) confirming = { name, size };
	}

	async function confirmDelete(): Promise<void> {
		const going = confirming;
		if (!going) return;
		confirmOpen = false;
		confirming = null;
		try {
			await storage.deleteWorkspace(going.name);
			outcome = `Deleted the Workspace “${going.name}” and everything in it.`;
		} catch (cause) {
			outcome = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<ModalDialog bind:open title="Workspace settings">
	<section>
		<h3 class="font-semibold">Where your work is stored</h3>
		{#if storage.backing === 'folder'}
			<p class="mt-2 max-w-prose text-sm">
				Your Workspace is the folder <code data-testid="settings-folder-name"
					>{storage.folderName}</code
				>. Every Project in it is a real directory of real files, so you can back it up, sync it, or
				commit it to git without this tool's help.
			</p>
		{:else}
			<p class="mt-2 max-w-prose text-sm">
				Your Workspace is <code data-testid="settings-workspace-name">{storage.workspaceName}</code
				>, kept in this browser's own private storage. Your work is kept between visits, but you
				cannot see the files, and another browser cannot.
			</p>
		{/if}

		<div class="mt-3 flex flex-wrap gap-2">
			{#if storage.backing === 'folder'}
				{#if unreachable}
					<!-- ADR-0008: a folder that has been moved, renamed, or deleted is a normal state, and
					     locating it again is the recovery. -->
					<button class="btn btn-primary btn-sm" onclick={() => storage.chooseFolder()}>
						Locate Workspace folder again
					</button>
				{/if}
				<button class="btn btn-sm" onclick={() => storage.useBrowserStorage()}>
					Use browser storage instead
				</button>
			{:else if storage.canChooseFolder}
				{#if storage.reopenable}
					<!-- Must be a real click or keypress: `requestPermission()` needs transient user
					     activation, and called automatically on load it fails silently (ADR-0012). -->
					<button
						class="btn btn-primary btn-sm"
						data-testid="settings-reopen-folder"
						onclick={() => storage.reopenFolder()}
					>
						Reopen “{storage.reopenable}”
					</button>
				{/if}
				<button
					class="btn btn-sm"
					data-testid="settings-choose-folder"
					onclick={() => storage.chooseFolder()}
				>
					Choose Workspace folder…
				</button>
			{/if}
		</div>

		{#if storage.backing === 'browser' && storage.reopenable}
			<p class="mt-3 max-w-prose text-sm opacity-70">
				Your browser asks permission for <code>{storage.reopenable}</code> each time you return, because
				granting a folder is a decision it will not make for you. Installing Ballastella as an application
				is what stops it asking.
			</p>
		{/if}

		{#if storage.problem}
			<!-- Never a silent fall back: a Workspace that quietly became browser storage again looks,
			     from the user's side, exactly like the tool having lost their folder. -->
			<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
				<h4 class="font-semibold">Your Workspace folder was not opened</h4>
				<p>{storage.problem}</p>
				<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>
					Choose a folder again
				</button>
			</div>
		{/if}
	</section>

	<!--
		What the browser said about keeping this storage (ADR-0024).

		A refusal is **said**, not swallowed: without the grant everything in browser storage is
		evictable under disk pressure, and on Firefox, Safari, and iPadOS browser storage is the only
		Workspace there is. Only the refusal gets an alert — reporting a grant that loudly would be
		three lines of reassurance nobody asked for.
	-->
	<section class="mt-6">
		<h3 class="font-semibold">Whether this browser will keep your work</h3>
		{#if storage.persistence === 'granted'}
			<p class="mt-2 max-w-prose text-sm" data-testid="persistence-granted">
				This browser has agreed to keep Ballastella's storage, so your work will not be cleared to
				make room for other sites.
			</p>
		{:else if storage.persistence === 'refused'}
			<div role="alert" class="mt-2 alert flex-col items-start alert-warning">
				<p data-testid="persistence-refused">
					This browser has not agreed to keep Ballastella's storage, so it may clear your Workspace
					if the disk runs low. Installing Ballastella as an application usually changes that; a
					Workspace folder on your own disk is not affected at all.
				</p>
			</div>
		{:else if storage.persistence === 'unsupported'}
			<p class="mt-2 max-w-prose text-sm opacity-70" data-testid="persistence-unsupported">
				This browser does not say whether it will keep Ballastella's storage. Keeping a backup, or a
				Workspace folder on your own disk, is the answer to that.
			</p>
		{:else}
			<p class="mt-2 max-w-prose text-sm opacity-70">Asking this browser…</p>
		{/if}
	</section>

	<!--
		The offer the sentence above has been making since ticket 12, reachable from here (SPEC story 6,
		ADR-0012). Here rather than in a banner: the permission and persistence questions are asked on
		this screen, and installing is the answer to both.
	-->
	<section class="mt-6">
		<h3 class="font-semibold">Ballastella as an installed application</h3>
		<InstallOffer />
	</section>

	<section class="mt-6">
		<h3 class="font-semibold">Your Workspaces</h3>
		<p class="mt-2 max-w-prose text-sm opacity-70">
			Browser storage holds as many Workspaces as you like, each with its own Projects, Historical
			Maps, and Alignments. Switch between them from the Workspace button on the bar.
		</p>
		{#if deletable.length === 0}
			<p class="mt-3 text-sm opacity-70" data-testid="no-other-workspaces">
				There are no other Workspaces to delete. The one you are in cannot be deleted from inside
				itself.
			</p>
		{:else}
			<ul class="mt-3 flex flex-col gap-2">
				{#each deletable as name (name)}
					<li class="flex items-center justify-between gap-3">
						<span class="text-sm">{name}</span>
						<button
							class="btn btn-outline btn-sm btn-warning"
							data-testid="delete-workspace"
							onclick={() => askToDelete(name)}
						>
							Delete “{name}”…
						</button>
					</li>
				{/each}
			</ul>
		{/if}
		<p aria-live="polite" class="mt-3 text-sm" data-testid="workspace-delete-outcome">{outcome}</p>
	</section>

	{#snippet actions()}
		<button class="btn" data-testid="close-workspace-settings" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>

<!--
	The confirmation, naming the Workspace and what it weighs (ADR-0016). A second `<dialog>` rather
	than a branch inside the first: `showModal()` stacks in the top layer, so the settings dialog stays
	where it was and Escape dismisses only the question that was asked last.
-->
<ModalDialog bind:open={confirmOpen} title="Delete this Workspace?">
	<p class="max-w-prose">
		“{confirming?.name}” and everything in it — every Project, every Historical Map, every Alignment
		— will be deleted from this browser. This cannot be undone.
	</p>
	<p class="mt-3 text-sm" data-testid="delete-workspace-size">
		{#if confirming?.size}
			It holds {confirming.size.files}
			{confirming.size.files === 1 ? 'file' : 'files'}, {describeBytes(confirming.size.bytes)}.
		{:else}
			Working out what it holds…
		{/if}
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (confirmOpen = false)}>Keep it</button>
		<button
			class="btn btn-warning"
			data-testid="confirm-delete-workspace"
			onclick={() => confirmDelete()}
		>
			Delete “{confirming?.name}”
		</button>
	{/snippet}
</ModalDialog>
