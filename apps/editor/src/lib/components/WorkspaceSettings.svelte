<script lang="ts">
	import { describeBytes, describeRemote, type WorkspaceSize } from '@ballastella/core';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	import InstallOffer from '$lib/pwa/InstallOffer.svelte';
	import { workspaceKeyLabel } from '$lib/editor-session.svelte.js';

	import ModalDialog from './ModalDialog.svelte';
	import RemoteSettings from './RemoteSettings.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * Workspace settings: where the work is kept, and what may be done to the Workspaces themselves.
	 *
	 * Three groups in one scroll — where the work lives, keeping it safe, this browser and the
	 * Workspaces — because the six flat sections this replaced argued about one risk in four voices
	 * and a scholar opening the dialog had to read all of them to find the one they came for.
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
	 *
	 * ⚠ **The dialog's accessible name is "Workspace settings" and nothing else.** `e2e/support/
	 * workspace.ts` reaches it by that name and every spec that touches it arrives through there.
	 */
	let { open = $bindable(false), storage }: { open?: boolean; storage: WorkspaceStorage } =
		$props();

	const unreachable = $derived(storage.session.status === 'unreachable');

	/**
	 * Whether the folder controls may offer to pick a folder right now.
	 *
	 * ⚠ **False while a folder problem stands, because the warning below carries that action.** Every
	 * `chooseFolder()` control in this dialog is the same act under a different label — "Locate
	 * Workspace folder again", "Choose Workspace folder…", "Choose a folder again" — and the warning
	 * that says *which* folder was not opened is the one place a scholar is looking when they want it.
	 * So a problem moves the offer into the warning rather than adding a third spelling beside it.
	 */
	const pickableHere = $derived(storage.problem === '');

	/** The Workspaces that may be deleted: every named one except the one being looked out of. */
	const deletable = $derived(storage.workspaces.filter((name) => !storage.isOpen(name)));

	/** The Workspace the confirmation is about, or `null` when nothing is being confirmed. */
	let confirming = $state<{ name: string; size: WorkspaceSize | null } | null>(null);
	/** Whether the confirmation is showing. Separate from {@link confirming} so Escape can close it. */
	let confirmOpen = $state(false);
	/** What happened to the last delete — or the last discarded journal, announced. */
	let outcome = $state('');

	/** Whether the Remote dialog is showing. */
	let remoteOpen = $state(false);
	/**
	 * Whether the Remote dialog has been asked for at all.
	 *
	 * ⚠ **`NavigationBar` still mounts a `RemoteSettings` of its own for the workspace menu's item,
	 * and two of them in one document means two of every `remote-*` control.** So this one is created
	 * the first time somebody asks for it here and then left mounted, which keeps a document that
	 * never asks down to the single copy the menu already provides — and keeps `ModalDialog`'s close
	 * and focus restoration, which an unmount would skip, in charge of getting out of it again. It
	 * becomes an unconditional mount when the menu's copy goes (ticket 03).
	 */
	let remoteAsked = $state(false);

	// ─────────────────────────────────────────────────────────────────────────────────────────
	// BACKING UP AND RESTORING (ticket 13, ADR-0024, SPEC stories 82–87)
	//
	// Here rather than on the hub, in the same group as "whether this browser will keep your work"
	// sends a scholar: that sentence tells them their work is in a place they cannot see and may be
	// evicted, and this is the answer to it.

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
		outcome =
			parts.length > 0
				? `Threw away ${parts.join(' and ')} held for “${workspaceKeyLabel(key)}”. Nothing in any Workspace was touched.`
				: `There was nothing left to throw away for “${workspaceKeyLabel(key)}” — something else had already cleared it. Nothing in any Workspace was touched.`;
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

<!--
	Three groups, separated by a hairline and space rather than by a box each (ADR-0036): the questions
	a scholar comes here with are "where is my work", "how do I not lose it", and "what may I do to
	these Workspaces", and each group answers exactly one of them.

	⚠ **No tabs.** ADR-0016 would mandate radio inputs with `role="tablist"`, and whether this browser
	will keep the work is the one sentence in the dialog that must not be behind anything.
-->
<ModalDialog bind:open title="Workspace settings" wide>
	<div class="flex flex-col divide-y divide-rule">
		<section class="flex flex-col items-start gap-3 pb-6">
			<h3 class="font-serif text-lg">Where your work lives</h3>

			{#if storage.backing === 'folder'}
				<p class="text-sm opacity-70">
					A folder on this computer: <code data-testid="settings-folder-name"
						>{storage.folderName}</code
					>. Real files you can back up, sync, or commit yourself.
				</p>
			{:else}
				<p class="text-sm opacity-70">
					This browser's own storage: <code data-testid="settings-workspace-name"
						>{storage.workspaceName}</code
					>. Kept between visits, but not visible as files and not shared with another browser.
				</p>
			{/if}

			<!--
				At most two controls: the recovery for a backing that cannot be reached, and the switch to
				the other backing. See {@link pickableHere} for where the third one went.
			-->
			<div class="flex flex-wrap gap-2">
				{#if storage.backing === 'folder'}
					{#if unreachable && pickableHere}
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
					{#if pickableHere}
						<button
							class="btn btn-sm"
							data-testid="settings-choose-folder"
							onclick={() => storage.chooseFolder()}
						>
							Choose Workspace folder…
						</button>
					{/if}
				{/if}
			</div>

			{#if storage.backing === 'browser' && storage.reopenable}
				<p class="text-sm opacity-70">
					This browser asks permission for <code>{storage.reopenable}</code> on every visit. Installing
					Ballastella is what stops it asking.
				</p>
			{/if}

			{#if storage.problem}
				<!-- Never a silent fall back: a Workspace that quietly became browser storage again looks,
			     from the user's side, exactly like the tool having lost their folder. The way back is
			     *in* this warning, which is where a scholar reading it is looking. -->
				<div role="alert" class="alert items-start alert-soft alert-warning">
					<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
					<div class="flex flex-col items-start gap-2">
						<h4 class="font-semibold">Your Workspace folder was not opened</h4>
						<p>{storage.problem}</p>
						<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>
							Choose a folder again
						</button>
					</div>
				</div>
			{/if}

			<!--
				Where this Workspace publishes, and as whom (ADR-0032, story 45).

				The binding lives here rather than in the workspace menu, so the same decision is not
				offered in two places that could disagree. Nothing about GitHub is shown until the scholar
				opens the dialog behind this button, which is what keeps a first visit clear of a sign-in
				prompt they never asked for (SPEC story 38).
			-->
			<h4 class="mt-3 text-sm font-semibold">Where this Workspace publishes</h4>
			{#if storage.remote}
				<p class="text-sm opacity-70">
					<code>{describeRemote(storage.remote)}</code>.
					{storage.signedIn
						? storage.identity
							? `Signed in to GitHub as ${storage.identity}.`
							: 'Signed in to GitHub.'
						: 'Not signed in to GitHub, so publishing will ask for a credential.'}
				</p>
			{:else}
				<p class="text-sm opacity-70">
					No repository yet. Publishing puts this Workspace's Projects on the web, and it needs one.
				</p>
			{/if}
			<button
				class="btn btn-sm"
				data-testid="settings-open-remote"
				onclick={() => {
					remoteAsked = true;
					remoteOpen = true;
				}}
			>
				Remote repository…
			</button>

			<!--
				What the browser said about keeping this storage (ADR-0024).

				A refusal is **said**, not swallowed: without the grant everything in browser storage is
				evictable under disk pressure, and on Firefox, Safari, and iPadOS browser storage is the
				only Workspace there is. Only the refusal gets an alert — reporting a grant that loudly
				would be three lines of reassurance nobody asked for.
			-->
			<h4 class="mt-3 text-sm font-semibold">Whether this browser will keep your work</h4>
			{#if storage.persistence === 'granted'}
				<p class="text-sm opacity-70" data-testid="persistence-granted">
					Kept. This browser will not clear your Workspace to make room for other sites.
				</p>
			{:else if storage.persistence === 'refused'}
				<div role="alert" class="alert items-start alert-soft alert-warning">
					<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
					<p data-testid="persistence-refused">
						Not kept: this browser may clear your Workspace if the disk runs low. Installing
						Ballastella usually changes that, and a folder Workspace is unaffected.
					</p>
				</div>
			{:else if storage.persistence === 'unsupported'}
				<p class="text-sm opacity-70" data-testid="persistence-unsupported">
					This browser will not say. Keep a backup, or use a folder Workspace.
				</p>
			{:else}
				<p class="text-sm opacity-70">Asking this browser…</p>
			{/if}
		</section>

		<!--
			Backing up and restoring (ADR-0024), and the edits that belong to a Workspace this browser no
			longer lists. Both outcomes are in an `aria-live` region so a screen-reader user is told what a
			sighted one can see (story 112).
		-->
		<section class="flex flex-col items-start gap-3 py-6">
			<h3 class="font-serif text-lg">Keeping it safe</h3>

			<h4 class="text-sm font-semibold">Backing up and restoring</h4>
			<p class="text-sm opacity-70">
				One <code>.tar</code> file holding this whole Workspace. Restoring always makes a
				<em>new</em>
				Workspace and switches to it — it never overwrites and never merges.
			</p>

			{#if storage.review !== null}
				<!--
					ADR-0024: a review copy is never backed up. Said in visible text rather than left as a
					disabled button with no explanation (workspace-and-layers SPEC story 111) — an archive of
					somebody else's work sitting in the user's Downloads folder is indistinguishable from a
					backup of their own, which is how a review copy comes to be restored months later as
					though it were theirs. `WorkspaceStorage.backUp` refuses it as well, because a guard that
					lives only in markup is one route away from being absent.
				-->
				<p class="text-sm text-warning" data-testid="no-backup-in-review">
					This is a review copy of somebody else's Project, so it is not backed up. Restoring still
					works, and lands in a new Workspace of your own.
				</p>
			{/if}

			<div class="flex flex-wrap gap-2">
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
				<p class="text-sm" data-testid="transfer-progress">{transfer.label}</p>
			{/if}
			<p aria-live="polite" class="text-sm" data-testid="transfer-outcome">
				{transferOutcome}
			</p>
			{#if transferProblem}
				<div role="alert" class="alert items-start alert-soft alert-warning">
					<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
					<p data-testid="transfer-problem">{transferProblem}</p>
				</div>
			{/if}

			<!--
				Unsaved changes belonging to a Workspace this browser no longer lists (ticket 20).

				⚠ **Reported and never swept up.** A replay only ever looks at the Workspace being opened, so
				an entry naming one that has gone would otherwise sit in storage for ever with nobody to meet
				it. But "not in the list" is not "gone": a folder Workspace is never in that list at all, and
				neither is a browser Workspace on a listing that failed — so the discard is the user's to
				make, with the name in front of them, and nothing here throws away an unsaved edit on a
				guess.

				⚠ **`aria-live="polite"` and not `role="alert"`.** This is a steady-state fact about the
				Workspace, true from the moment the dialog opens, not an event that has just happened —
				CONTRIBUTING's mandated-method table puts Status in a polite region, and `role="alert"` is
				assertive and interrupts. `save-error`'s precedent does not reach here: that one is inserted
				at the instant its text first exists.

				The Workspace is named the way the user knows it (`workspaceKeyLabel`), never by the internal
				journal key — a scholar has never seen `opfs:`.
			-->
			{#if storage.orphanedJournals.length > 0}
				<div class="flex flex-col items-start gap-3" aria-live="polite">
					<h4 class="text-sm font-semibold">Unsaved changes with nowhere to go</h4>
					<div class="alert items-start alert-soft alert-warning">
						<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
						<div class="flex flex-col items-start gap-2">
							<p data-testid="orphaned-journals">
								Held for {storage.orphanedJournals.length === 1 ? 'a Workspace' : 'Workspaces'} not listed
								here: {storage.orphanedJournals.map((key) => workspaceKeyLabel(key)).join(', ')}.
								Open that Workspace and the changes go back into it; if it is gone for good, throw
								them away.
							</p>
							{#each storage.orphanedJournals as key (key)}
								<button
									class="btn btn-sm"
									data-testid="discard-orphaned-journal"
									onclick={() => discardOrphanedJournal(key)}
								>
									Throw away the changes for {workspaceKeyLabel(key)}
								</button>
							{/each}
						</div>
					</div>
				</div>
			{/if}
		</section>

		<section class="flex flex-col items-start gap-3 pt-6">
			<h3 class="font-serif text-lg">This browser and your Workspaces</h3>

			<!--
				The offer the persistence sentence has been making since ticket 12, reachable from here
				(SPEC story 6, ADR-0012): the permission and persistence questions are asked in the group
				above, and installing is the answer to both.
			-->
			<h4 class="text-sm font-semibold">Ballastella as an installed application</h4>
			<InstallOffer />

			<h4 class="mt-3 text-sm font-semibold">Your Workspaces</h4>
			<p class="text-sm opacity-70">
				Switch between them from the Workspace button on the bar. Deleting one takes its Projects,
				Map Images, and Alignments with it.
			</p>
			{#if deletable.length === 0}
				<p class="text-sm opacity-70" data-testid="no-other-workspaces">
					There are no other Workspaces to delete. The one you are in cannot be deleted from inside
					itself.
				</p>
			{:else}
				<ul class="flex w-full flex-col gap-2">
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
			<p aria-live="polite" class="text-sm" data-testid="workspace-delete-outcome">
				{outcome}
			</p>
		</section>
	</div>

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
		“{confirming?.name}” and everything in it — every Project, every Map Image, every Alignment —
		will be deleted from this browser. This cannot be undone.
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

<!-- Outside the dialog above, for the same top-layer reason the confirmation is. -->
{#if remoteAsked}
	<RemoteSettings bind:open={remoteOpen} {storage} />
{/if}
