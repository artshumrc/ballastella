<script lang="ts">
	import { describeBytes } from '@ballastella/core';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	import InstallOffer from '$lib/pwa/InstallOffer.svelte';

	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * What keeps this Workspace safe, on Workspace Home: a Backup, a Restore, what the browser has
	 * promised, the offer that answers it, unsaved changes with nowhere to go, and the way to move
	 * this Workspace into a folder.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THESE ARE HERE AND NOT IN A DIALOG
	 *
	 * All six were in Workspace settings, which ADR-0042 deletes: they are about *the Workspace the
	 * author is in*, so they belong on the screen that is that Workspace, and every one of them had
	 * no second entry point anywhere in the application — two menus deep, behind a control nobody
	 * opens until something has already gone wrong.
	 *
	 * **What is not here is what may be done to the Workspaces themselves.** A Workspace is opened,
	 * renamed and deleted from the roster on the bar, which is the list of Workspaces and therefore
	 * where a person looking for one is looking.
	 *
	 * Every explanation is **visible text**, not a tooltip: daisyUI renders tooltips through CSS
	 * `::before`, so they are neither announced nor dismissable (ADR-0016).
	 */
	let { storage }: { storage: WorkspaceStorage } = $props();

	/** What a backup, a restore or a move is doing right now, or `null`. Drives the visible progress. */
	let transfer = $state<string>('');
	/** What the last one did, announced. Visible text, never a tooltip. */
	let outcome = $state('');
	/** Why the last one did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/** Whether one is running, so a second cannot be started on top of it. */
	let working = $state(false);
	/** The file input, so the button can open it without a label wrapping a hidden control. */
	let restoreInput = $state<HTMLInputElement | null>(null);

	/** What went when a journal with nowhere to go was last thrown away, announced. */
	let discarded = $state('');

	function begin(label: string): void {
		outcome = '';
		problem = '';
		transfer = label;
		working = true;
	}

	function end(): void {
		transfer = '';
		working = false;
	}

	async function backUp(): Promise<void> {
		begin(`Backing up “${storage.name}”…`);
		try {
			const backup = await storage.backUp((progress) => {
				transfer = `Backing up “${storage.name}”… ${progress.files} of ${progress.totalFiles} files.`;
			});
			outcome =
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
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			end();
		}
	}

	async function restore(event: Event): Promise<void> {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		// Cleared immediately, so picking the same file twice in a row is two restores rather than
		// one — a `change` event does not fire for an unchanged value.
		input.value = '';
		if (!file) return;

		begin(`Restoring from “${file.name}”…`);
		try {
			const restored = await storage.restoreFrom(file, (progress) => {
				// A tar declares no totals — it has no index — so this counts rather than inventing a
				// denominator it cannot know.
				transfer = `Restoring from “${file.name}”… ${progress.files} files so far.`;
			});
			// The notice comes from core rather than being phrased here, so the sentence about
			// re-publishing is the same wherever a restore is reported (ADR-0006).
			outcome = restored.notice;
		} catch (cause) {
			// ADR-0010's refusal of a newer `formatVersion` arrives here as its own message, naming
			// where to get that version, and is shown unaltered.
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			end();
		}
	}

	/**
	 * Move this Workspace's files into a folder on the author's own computer.
	 *
	 * ⚠ **A one-way move, not a toggle between two backings.** Restore and hydrate both always make a
	 * browser Workspace and a folder Workspace can otherwise only be made new and empty, so this is
	 * the only route existing work has onto disk (ADR-0042). What was beside it — *Use browser storage
	 * instead* — is the roster's job now: a browser Workspace is a row in the list, and switching to
	 * one is pressing it.
	 */
	async function moveIntoFolder(): Promise<void> {
		begin(`Moving “${storage.name}” into the folder you choose…`);
		try {
			const moved = await storage.moveIntoFolder((progress) => {
				transfer = `Copying “${storage.name}” into the folder… ${progress.files} of ${progress.totalFiles} files.`;
			});
			// `''` is a picker closed without choosing, which is a cancelled gesture and says nothing.
			outcome = moved;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			end();
		}
	}

	/**
	 * Throw away the unsaved changes held for a Workspace this browser no longer lists, and say what
	 * went.
	 *
	 * Edits and deletions are **named separately, because they are separate things**: an unsaved edit
	 * waiting to be put back, and a standing instruction to *delete* a Project. Summed, a Workspace
	 * holding only the second was reported as "1 unsaved change", which is false in both nouns — and
	 * hid the one of the two a user would most want to know had gone.
	 *
	 * ⚠ **The empty arm is not decoration and is not dead.** The button renders only for a key in
	 * `orphanedJournals`, which is built as the union of the Workspaces holding journal entries and
	 * those holding deletion notes — so a count of zero takes a second tab having cleared them between
	 * that list being built and this call. Rare, reachable, and the one wording that must not come out
	 * of it is "Threw away 0 unsaved changes", which reads as a failure of the button rather than as
	 * somebody else having got there first.
	 */
	function discardOrphanedJournal(key: string): void {
		const dropped = storage.discardOrphanedJournal(key);
		const parts = [
			...(dropped.edits > 0
				? [`${dropped.edits} unsaved ${dropped.edits === 1 ? 'change' : 'changes'}`]
				: []),
			...(dropped.deletions > 0
				? [`${dropped.deletions} unfinished ${dropped.deletions === 1 ? 'deletion' : 'deletions'}`]
				: [])
		];
		discarded =
			parts.length > 0
				? `Threw away ${parts.join(' and ')} held for “${storage.workspaceLabel(key)}”. Nothing in any Workspace was touched.`
				: `There was nothing left to throw away for “${storage.workspaceLabel(key)}” — something else had already cleared it. Nothing in any Workspace was touched.`;
	}
</script>

<!--
	Quiet, below the two lists: a scholar comes to Workspace Home to work on a Project, and this is
	the answer to a question they ask occasionally. One section with a heading rather than a boxed
	panel each (ADR-0036).
-->
<section class="mt-10 flex flex-col items-start gap-3 border-t border-rule pt-6">
	<h2 class="font-serif text-lg">Keeping your work</h2>

	<!--
		What the browser said about keeping this storage (ADR-0024).

		A refusal is **said**, not swallowed: without the grant everything in browser storage is
		evictable under disk pressure, and on Firefox, Safari, and iPadOS browser storage is the only
		Workspace there is.

		⚠ **Not `role="alert"`, which is what it was inside the settings dialog.** An alert is
		assertive and interrupts, and CONTRIBUTING's mandated-method table reserves it for text
		inserted at the moment it first exists. This is a steady-state fact about the Workspace, true
		before the screen is drawn — and on Workspace Home there is a second cost: an `alert` standing
		here permanently is a second one beside every real refusal this screen raises, which is a
		screen reader hearing the storage sentence again every time a transfer fails. Drawn as a
		warning and read in place.
	-->
	{#if storage.persistence === 'granted'}
		<p class="text-sm opacity-70" data-testid="persistence-granted">
			Kept. This browser will not clear your Workspace to make room for other sites.
		</p>
	{:else if storage.persistence === 'refused'}
		<div class="alert items-start alert-soft alert-warning">
			<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
			<p data-testid="persistence-refused">
				Not kept: this browser may clear your Workspace if the disk runs low. Installing Ballastella
				usually changes that, and a folder Workspace is unaffected.
			</p>
		</div>
	{:else if storage.persistence === 'unsupported'}
		<p class="text-sm opacity-70" data-testid="persistence-unsupported">
			This browser will not say. Keep a backup, or use a folder Workspace.
		</p>
	{/if}

	<!--
		The offer that persistence sentence makes (ADR-0012), beside it rather than in a dialog of its
		own: installing is the answer to the sentence above, and the reason and the remedy belong
		together.
	-->
	<InstallOffer />

	<h3 class="mt-3 text-sm font-semibold">Backing up and restoring</h3>
	<p class="text-sm opacity-70">
		One <code>.tar</code> file holding this whole Workspace. Restoring always makes a
		<em>new</em>
		Workspace and switches to it — it never overwrites and never merges.
	</p>

	{#if storage.review !== null}
		<!--
			ADR-0024: a review copy is never backed up. Said in visible text rather than left as a
			disabled button with no explanation — an archive of somebody else's work sitting in the
			user's Downloads folder is indistinguishable from a backup of their own, which is how a
			review copy comes to be restored months later as though it were theirs.
			`WorkspaceStorage.backUp` refuses it as well, because a guard that lives only in markup is
			one route away from being absent.
		-->
		<p class="text-sm text-warning" data-testid="no-backup-in-review">
			This is a review copy of somebody else's Project, so it is not backed up. Restoring still
			works, and lands in a new Workspace of your own.
		</p>
	{/if}

	{#if storage.unavailable}
		<!--
			A Backup is one of the readers a transfer marker's gate keeps out, so it is absent rather
			than present and refused — the same arrangement as the review copy above, and for a sharper
			reason: an archive holding half an Import or half an Update is one the author restores
			months later believing it whole. Restoring still works, because it always makes a *new*
			Workspace and never touches this one.
		-->
		<p class="text-sm text-warning" data-testid="no-backup-unrecovered">
			This Workspace has not opened yet, so it is not backed up. Reload the page to finish clearing
			up the transfer that did not finish.
		</p>
	{/if}

	<div class="flex flex-wrap gap-2">
		{#if storage.review === null && !storage.unavailable}
			<button
				class="btn btn-sm"
				data-testid="back-up-workspace"
				disabled={working}
				onclick={() => void backUp()}
			>
				Back up “{storage.name}”
			</button>
		{/if}
		<button
			class="btn btn-sm"
			data-testid="restore-workspace"
			disabled={working}
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

	<!--
		Where this Workspace's files are, and the one way existing work reaches a folder (ADR-0042).

		Offered only for a browser Workspace on a browser that can open folders: a folder Workspace is
		already where it is going, and where the File System Access API is absent no kind is ever named
		— a Workspace is simply a Workspace.
	-->
	{#if storage.backing === 'folder'}
		<h3 class="mt-3 text-sm font-semibold">Where this Workspace's files are</h3>
		<p class="text-sm opacity-70">
			A folder on this computer: <code data-testid="workspace-folder-place"
				>{storage.folderName}</code
			>. Real files you can back up, sync, or commit yourself.
		</p>
	{:else if storage.canChooseFolder}
		<h3 class="mt-3 text-sm font-semibold">Where this Workspace's files are</h3>
		<p class="text-sm opacity-70">
			This browser's own storage: <code data-testid="workspace-storage-place"
				>{storage.workspaceName}</code
			>. Kept between visits, but not visible as files and not shared with another browser.
		</p>
		<button
			class="btn btn-sm"
			data-testid="move-into-folder"
			disabled={working}
			onclick={() => void moveIntoFolder()}
		>
			Move this Workspace into a folder…
		</button>
		<p class="text-sm opacity-70">
			Choose an empty folder and this Workspace's files are copied into it, where you can see them.
			What is in browser storage now is left exactly as it is, so you can look in the folder first
			and delete it from the Workspace list afterwards.
		</p>
	{/if}

	{#if transfer}
		<p class="text-sm" data-testid="transfer-progress">{transfer}</p>
	{/if}
	<p aria-live="polite" class="text-sm" data-testid="transfer-outcome">{outcome}</p>
	{#if problem}
		<div role="alert" class="alert items-start alert-soft alert-warning">
			<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
			<p data-testid="transfer-problem">{problem}</p>
		</div>
	{/if}

	<!--
		Unsaved changes belonging to a Workspace this browser no longer lists.

		⚠ **Reported and never swept up.** A replay only ever looks at the Workspace being opened, so
		an entry naming one that has gone would otherwise sit in storage for ever with nobody to meet
		it. But "not in the list" is not "gone": a folder Workspace is never in that list at all, and
		neither is a browser Workspace on a listing that failed — so the discard is the user's to
		make, with the name in front of them, and nothing here throws away an unsaved edit on a
		guess.

		⚠ **`aria-live="polite"` and not `role="alert"`.** This is a steady-state fact about the
		Workspace, true from the moment the screen is drawn, not an event that has just happened —
		CONTRIBUTING's mandated-method table puts Status in a polite region, and `role="alert"` is
		assertive and interrupts. `save-error`'s precedent does not reach here: that one is inserted
		at the instant its text first exists.

		The Workspace is named the way the user knows it (`storage.workspaceLabel`), never by the
		internal journal key — a scholar has never seen `opfs:`, and a folder Workspace's key is a
		minted reference nobody could recognise at all.
	-->
	{#if storage.orphanedJournals.length > 0}
		<div class="flex flex-col items-start gap-3" aria-live="polite">
			<h3 class="mt-3 text-sm font-semibold">Unsaved changes with nowhere to go</h3>
			<div class="alert items-start alert-soft alert-warning">
				<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
				<div class="flex flex-col items-start gap-2">
					<p data-testid="orphaned-journals">
						Held for {storage.orphanedJournals.length === 1 ? 'a Workspace' : 'Workspaces'} not listed
						here: {storage.orphanedJournals.map((key) => storage.workspaceLabel(key)).join(', ')}.
						Open that Workspace and the changes go back into it; if it is gone for good, throw them
						away.
					</p>
					{#each storage.orphanedJournals as key (key)}
						<button
							class="btn btn-sm"
							data-testid="discard-orphaned-journal"
							onclick={() => discardOrphanedJournal(key)}
						>
							Throw away the changes for {storage.workspaceLabel(key)}
						</button>
					{/each}
				</div>
			</div>
		</div>
	{/if}
	<p aria-live="polite" class="text-sm" data-testid="discard-outcome">{discarded}</p>
</section>
