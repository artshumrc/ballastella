<script lang="ts">
	import { describeBytes, type WorkspaceSize } from '@ballastella/core';

	import InstallOffer from '$lib/pwa/InstallOffer.svelte';
	import { workspaceKeyLabel } from '$lib/editor-session.svelte.js';

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

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// BACKING UP AND RESTORING (ticket 13, ADR-0024, SPEC stories 82–87)
	//
	// Here rather than on the hub, beside "where your work is stored" and "whether this browser will
	// keep your work": those two sections tell a scholar their work is in a place they cannot see and
	// may be evicted, and this is the answer to both. The persistence section already sends them here
	// in as many words — "Keeping a backup, or a Workspace folder on your own disk, is the answer to
	// that" — and until now there was nothing for that sentence to point at.

	/** What a backup or restore is doing right now, or `null`. Drives the visible progress. */
	let transfer = $state<{ kind: 'backup' | 'restore'; files: number; label: string } | null>(null);
	/** What the last backup or restore did, announced. Visible text, never a tooltip (story 111). */
	let transferOutcome = $state('');
	/** Why the last backup or restore did not happen. Its own state so it can be an alert. */
	let transferProblem = $state('');
	/** The file input, so the button can open it without a label wrapping a hidden control. */
	let restoreInput = $state<HTMLInputElement | null>(null);

	async function backUp(): Promise<void> {
		transferOutcome = '';
		transferProblem = '';
		transfer = { kind: 'backup', files: 0, label: `Backing up “${storage.name}”…` };
		try {
			const backup = await storage.backUp((progress) => {
				transfer = {
					kind: 'backup',
					files: progress.files,
					label: `Backing up “${storage.name}”… ${progress.files} of ${progress.totalFiles} files.`
				};
			});
			transferOutcome =
				`Backed up ${backup.totalFiles} ${backup.totalFiles === 1 ? 'file' : 'files'}, ` +
				`${describeBytes(backup.totalBytes)}, to “${backup.fileName}”.` +
				// A folder Workspace's name is the operating system's folder name, and a Workspace name
				// cannot hold everything a folder name can — so the file is named after what this will
				// restore as, and that is said rather than left as a surprise in the Downloads folder.
				(backup.displayName === backup.workspaceName
					? ''
					: ` Restoring it will make a Workspace called “${backup.workspaceName}”, because a ` +
						`Workspace name can only hold letters, numbers, spaces and “-_()”.`);
		} catch (cause) {
			transferProblem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			transfer = null;
		}
	}

	async function restore(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared immediately, so picking the same file twice in a row is two restores rather than
		// one — a `change` event does not fire for an unchanged value.
		input.value = '';
		if (!file) return;

		transferOutcome = '';
		transferProblem = '';
		transfer = { kind: 'restore', files: 0, label: `Restoring from “${file.name}”…` };
		try {
			const restored = await storage.restoreFrom(file, (progress) => {
				transfer = {
					kind: 'restore',
					files: progress.files,
					// A tar declares no totals — it has no index — so this counts rather than inventing a
					// denominator it cannot know.
					label: `Restoring from “${file.name}”… ${progress.files} files so far.`
				};
			});
			// The notice comes from core rather than being phrased here, so the sentence about
			// re-publishing is the same wherever a restore is reported (ADR-0006, story 86).
			transferOutcome = restored.notice;
		} catch (cause) {
			// ADR-0010's refusal of a newer `formatVersion` arrives here as its own message, naming
			// where to get that version, and is shown unaltered (story 114).
			transferProblem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			transfer = null;
		}
	}

	async function askToDelete(name: string): Promise<void> {
		// The size is read *before* the confirmation is answered rather than quoted from a tally,
		// because what the user is agreeing to is the bytes that are there now (ADR-0016 wants the
		// Workspace and its size named). `list` + `size`, never `read` — a Workspace with a copied
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
		Unsaved changes belonging to a Workspace this browser no longer lists (ticket 20).

		⚠ **Reported and never swept up.** A replay only ever looks at the Workspace being opened, so
		an entry naming one that has gone would otherwise sit in storage for ever with nobody to meet
		it. But "not in the list" is not "gone": a folder Workspace is never in that list at all, and
		neither is a browser Workspace on a listing that failed — so the discard is the user's to make,
		with the name in front of them, and nothing here throws away an unsaved edit on a guess.

		Visible text with a real button rather than a tooltip (story 111), and the outcome goes into
		the `aria-live` region below so it is not sighted-only (story 112).

		⚠ **`aria-live="polite"` and not `role="alert"`.** This is a steady-state fact about the
		Workspace, true from the moment the dialog opens, not an event that has just happened —
		CONTRIBUTING's mandated-method table puts Status in a polite region, and `role="alert"` is
		assertive and interrupts. `save-error`'s precedent does not reach here: that one is inserted
		at the instant its text first exists.

		The Workspace is named the way the user knows it (`workspaceKeyLabel`), never by the internal
		journal key — a scholar has never seen `opfs:`.
	-->
	{#if storage.orphanedJournals.length > 0}
		<section class="mt-6" aria-live="polite">
			<h3 class="font-semibold">Unsaved changes with nowhere to go</h3>
			<div class="mt-2 alert flex-col items-start alert-warning">
				<p data-testid="orphaned-journals">
					Ballastella is still holding unsaved changes for {storage.orphanedJournals.length === 1
						? 'a Workspace'
						: 'Workspaces'} it cannot find here: {storage.orphanedJournals
						.map((key) => workspaceKeyLabel(key))
						.join(', ')}. If that is a Workspace folder you have not opened yet, open it and the
					changes are put back. If it is gone for good, you can throw the changes away.
				</p>
				{#each storage.orphanedJournals as key (key)}
					<button
						class="btn btn-sm"
						data-testid="discard-orphaned-journal"
						onclick={() => {
							const dropped = storage.discardOrphanedJournal(key);
							// Named separately because they are separate things: an unsaved edit waiting to be
							// put back, and a standing instruction to *delete* a Project. Summed, a Workspace
							// holding only the second was reported as "1 unsaved change", which is false in
							// both nouns — and hid the one of the two a user would most want to know had gone.
							const parts = [
								...(dropped.edits > 0
									? [`${dropped.edits} unsaved ${dropped.edits === 1 ? 'change' : 'changes'}`]
									: []),
								...(dropped.deletions > 0
									? [
											`${dropped.deletions} unfinished ${dropped.deletions === 1 ? 'deletion' : 'deletions'}`
										]
									: [])
							];
							outcome = `Threw away ${parts.length > 0 ? parts.join(' and ') : 'nothing'} held for “${workspaceKeyLabel(key)}”. Nothing in any Workspace was touched.`;
						}}
					>
						Throw away the changes for {workspaceKeyLabel(key)}
					</button>
				{/each}
			</div>
		</section>
	{/if}

	<!--
		The offer the sentence above has been making since ticket 12, reachable from here (SPEC story 6,
		ADR-0012). Here rather than in a banner: the permission and persistence questions are asked on
		this screen, and installing is the answer to both.
	-->
	<section class="mt-6">
		<h3 class="font-semibold">Ballastella as an installed application</h3>
		<InstallOffer />
	</section>

	<!--
		Backing up and restoring (ADR-0024). Every explanation is visible text rather than a tooltip
		(story 111), and both outcomes are in an `aria-live` region so a screen-reader user is told what
		a sighted one can see (story 112).
	-->
	<section class="mt-6">
		<h3 class="font-semibold">Backing up and restoring</h3>
		<p class="mt-2 max-w-prose text-sm">
			A backup is one <code>.tar</code> file holding this whole Workspace — every Project, every Historical
			Map, every Alignment. It is how you move your work to another computer, and on browsers with no
			folder access it is the only way your work leaves this one.
		</p>
		<p class="mt-2 max-w-prose text-sm opacity-70">
			Restoring always makes a <em>new</em> Workspace and switches to it. It never overwrites and never
			merges, so recovering from damage cannot destroy what you are recovering from — you can look at
			both and decide. A backup holds your work rather than a website, so a restored Workspace needs publishing
			again before it is one.
		</p>

		{#if storage.review !== null}
			<!--
				ADR-0024: a review copy is never backed up. Said in visible text rather than left as a
				disabled button with no explanation (workspace-and-layers SPEC story 111) — an archive of somebody else's work
				sitting in the user's Downloads folder is indistinguishable from a backup of their own,
				which is how a review copy comes to be restored months later as though it were theirs.
				`WorkspaceStorage.backUp` refuses it as well, because a guard that lives only in markup is
				one route away from being absent.
			-->
			<p class="mt-3 max-w-prose text-sm text-warning" data-testid="no-backup-in-review">
				This is a review copy of somebody else's Project, so it is not backed up. Go back to your
				own Workspace to back that one up. Restoring a backup still works from here, and lands in a
				new Workspace of your own.
			</p>
		{/if}

		<div class="mt-3 flex flex-wrap gap-2">
			{#if storage.review === null}
				<button
					class="btn btn-primary btn-sm"
					data-testid="back-up-workspace"
					disabled={transfer !== null}
					onclick={() => backUp()}
				>
					Back up “{storage.name}”
				</button>
			{/if}
			<button
				class="btn btn-sm"
				data-testid="restore-workspace"
				disabled={transfer !== null}
				onclick={() => restoreInput?.click()}
			>
				Restore from a backup…
			</button>
			<!--
				Off-screen rather than `hidden`: a `display: none` input is not focusable and some
				assistive technology skips it entirely, and Playwright's `setInputFiles` needs it in the
				accessibility tree to be found by role at all.
			-->
			<input
				bind:this={restoreInput}
				accept=".tar,application/x-tar"
				aria-label="Choose a backup file to restore"
				class="sr-only"
				data-testid="restore-file"
				onchange={restore}
				type="file"
			/>
		</div>

		{#if transfer}
			<p class="mt-3 text-sm" data-testid="transfer-progress">{transfer.label}</p>
		{/if}
		<p aria-live="polite" class="mt-3 max-w-prose text-sm" data-testid="transfer-outcome">
			{transferOutcome}
		</p>
		{#if transferProblem}
			<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
				<p data-testid="transfer-problem">{transferProblem}</p>
			</div>
		{/if}
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
