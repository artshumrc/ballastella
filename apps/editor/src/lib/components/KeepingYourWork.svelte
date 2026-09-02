<script lang="ts">
	import {
		describeBytes,
		deriveStorageDurability,
		type StorageDurability
	} from '@ballastella/core';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	import InstallOffer from '$lib/pwa/InstallOffer.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * What keeps this Workspace safe, in its editing dialog: a Backup, a Restore, what the browser
	 * has promised, the offer that answers it, unsaved changes with nowhere to go, and the way to move
	 * this Workspace into a folder.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THESE ARE IN THE WORKSPACE EDITING DIALOG
	 *
	 * They concern the Workspace the author is editing. Keeping them with the Rename form gives them
	 * one direct entry point from its row in the roster, rather than scattering Workspace actions over
	 * the Workspace Home and the roster.
	 *
	 * **What is not here is what may be done to the Workspaces themselves.** A Workspace is opened,
	 * renamed and deleted from the roster on the bar, which is the list of Workspaces and therefore
	 * where a person looking for one is looking.
	 *
	 * Every explanation is **visible text**, not a tooltip: daisyUI renders tooltips through CSS
	 * `::before`, so they are neither announced nor dismissable (ADR-0016).
	 */
	let { storage }: { storage: WorkspaceStorage } = $props();

	const app = useInstalledApp();

	/**
	 * What this browser has promised about keeping the work, and therefore which lever to name.
	 *
	 * Derived here rather than held on the store because two of its five inputs are not the store's
	 * to know: whether Ballastella is running installed is `InstalledApp`'s, and it changes while this
	 * screen is open — an author who installs from the offer below should see the sentence above it
	 * become true without a reload. `$derived` over an `$effect` for exactly that reason.
	 *
	 * ⚠ **No user-agent string is read, here or in the derivation.** See
	 * `deriveStorageDurability`: every distinction is drawn from a capability the browser has or has
	 * not, so the advice does not break when a browser changes what it calls itself.
	 */
	const durability = $derived<StorageDurability | null>(
		storage.storageAnswers === null
			? null
			: deriveStorageDurability({
					...storage.storageAnswers,
					installed: app.installed,
					// The presence of File System Access, which is also the whole of what
					// `canChooseFolder` reports.
					fileSystemAccess: storage.canChooseFolder
				})
	);

	/**
	 * The one short line, per state. Present without being a lecture; the truth is behind the
	 * disclosure, except on WebKit where it is not (ADR-0042).
	 */
	const DURABILITY_LEAD: Record<StorageDurability['kind'], string> = {
		granted:
			'Kept. This browser has promised not to clear your Workspace to make room for other sites.',
		'can-ask': 'Not kept yet — this browser will ask you first.',
		'install-to-keep': 'Not kept yet. Installing Ballastella is what changes that.',
		'seven-day': 'This browser deletes your Workspace after seven days without a visit.',
		ephemeral: 'This window keeps nothing: your work will not survive closing it.',
		unknown: 'This browser will not say whether it keeps your Workspace.'
	};

	/**
	 * Whether the truth behind the line is on screen.
	 *
	 * A `<button aria-expanded>` disclosure and not `<details>`: ADR-0016 bans the `<details>`
	 * dropdown, and the WAI-ARIA disclosure button is unambiguously outside that ban.
	 */
	let durabilityShown = $state(false);

	/** What the last press for the browser's own grant left true, announced. */
	let keeping = $state('');

	async function askToKeepStorage(): Promise<void> {
		keeping = '';
		await storage.askToKeepStorage();
		// Read back off the derivation rather than from what `persist()` returned, so the sentence and
		// the outcome cannot disagree about the same browser.
		keeping =
			durability?.kind === 'granted'
				? 'Kept. This browser has promised to keep your Workspace, and you may store much more in it.'
				: 'This browser did not grant it. A backup is the answer that does not depend on it.';
	}

	/** What a backup, a restore or a move is doing right now, or `null`. Drives the visible progress. */
	let transfer = $state<string>('');
	/** What the last one did, announced. Visible text, never a tooltip. */
	let outcome = $state('');
	/** Why the last one did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/**
	 * Whether one is running, so a second cannot be started on top of it.
	 *
	 * ⚠ **Every control it makes busy says so with `aria-disabled` and refuses in its own handler,
	 * never with `disabled`.** A `disabled` button leaves the tab order the instant it is pressed, so
	 * the keyboard user who started a transfer that runs for minutes is dropped on `<body>` and cannot
	 * even tab back to the progress line beneath it (WCAG 2.4.3). `aria-disabled` is a statement to
	 * the accessibility tree and stops nothing, which is why the refusal is in the handler as well.
	 */
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
			// turning Share Links back on is the same wherever a restore is reported.
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
	 * ⚠ **A one-way move, not a toggle between two backings.** A restore and a Workspace made for a
	 * repository both always make a
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
	Below the Rename form: the same single section rather than a boxed panel for each concern
	(ADR-0036).
-->
<section class="mt-10 flex flex-col items-start gap-3 border-t border-rule pt-6">
	<h2 class="font-serif text-lg">Keeping your work</h2>

	<!--
		What this browser has promised about keeping the work, and the lever that would change it
		(ADR-0042, and ADR-0001's WebKit amendment).

		One short line, with the truth behind a **Learn more** — because a scholar asks this question
		occasionally and a paragraph standing here permanently is the sediment ADR-0036 rules out.

		⚠ **`seven-day` is the exception, and it is not a style choice.** On WebKit there is no grant a
		page can reach: ITP deletes the OPFS store after seven days of browser use with no interaction,
		so the local-first promise is simply untrue there until the app is on the Home Screen. A truth
		that costs a scholar everything they have may not be behind a press nobody makes.

		⚠ **Not `role="alert"`, which is what the old three-state sentence was inside the settings
		dialog.** An alert is assertive and interrupts, and CONTRIBUTING's mandated-method table
		reserves it for text inserted at the moment it first exists. This is a steady-state fact about
		the Workspace, true before the dialog is drawn — and in the editing dialog there is a second cost:
		an `alert` standing here permanently is a second one beside every real refusal this screen
		raises, which is a screen reader hearing the storage sentence again every time a transfer fails.
	-->
	{#if storage.backing === 'folder'}
		{#if !app.installed}
			<p class="text-sm opacity-70" data-testid="folder-workspace-install-advice">
				Install Ballastella to let your browser keep permission to access this Workspace folder
				between visits.
			</p>
		{/if}
	{:else if durability !== null}
		{#if durability.kind === 'seven-day'}
			<div class="alert items-start alert-soft alert-warning" data-testid="durability">
				<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
				<div class="flex flex-col items-start gap-2">
					<p class="font-semibold" data-testid="durability-lead">
						{DURABILITY_LEAD[durability.kind]}
					</p>
					<div class="flex flex-col items-start gap-2 text-sm" data-testid="durability-detail">
						<p>
							Seven days of using this browser without opening Ballastella is enough to lose
							everything in this Workspace. A tap, a click or a keypress on the page counts as a
							visit; <strong>scrolling does not</strong>.
						</p>
						<p>
							<strong>Add Ballastella to your Home Screen and this stops</strong> — an installed
							Ballastella is the one thing this browser will keep storage for. Do that
							<strong>before you bring in large maps</strong>: the Home Screen copy starts empty, so
							anything already here has to be restored from a backup into it.
						</p>
					</div>
				</div>
			</div>
		{:else}
			<div class="flex flex-col items-start gap-2" data-testid="durability">
				<div class="flex flex-wrap items-center gap-2">
					<p
						class="text-sm {durability.kind === 'ephemeral' ? 'text-warning' : 'opacity-70'}"
						data-testid="durability-lead"
					>
						{DURABILITY_LEAD[durability.kind]}
					</p>
					<button
						type="button"
						class="btn btn-outline btn-xs"
						aria-controls="durability-detail"
						aria-expanded={durabilityShown}
						data-testid="durability-learn-more"
						onclick={() => (durabilityShown = !durabilityShown)}
					>
						{durabilityShown ? 'Hide this' : 'Learn more'}
					</button>
				</div>
				{#if durabilityShown}
					<div
						id="durability-detail"
						class="flex max-w-prose flex-col items-start gap-2 rounded-box bg-base-200 px-3 py-2 text-sm"
						data-testid="durability-detail"
					>
						{#if durability.kind === 'granted'}
							<p>
								This browser will not clear your Workspace to make room for other sites, and there
								is nothing left to ask it for. It is still one computer, so a backup is the copy
								that survives losing it.
							</p>
						{:else if durability.kind === 'can-ask'}
							<p>
								This browser will ask you before it promises anything, and it is the one that really
								asks. Saying yes also raises how much you may keep here — from about 10 GB to around
								half this disk — and takes this Workspace out of the allowance it shares with every
								other site.
							</p>
							<button
								type="button"
								class="btn btn-sm"
								data-testid="keep-storage"
								onclick={() => void askToKeepStorage()}
							>
								Ask this browser to keep my work…
							</button>
							<p aria-live="polite" data-testid="keep-storage-outcome">{keeping}</p>
						{:else if durability.kind === 'install-to-keep'}
							<p>
								<strong>Installing Ballastella makes this browser promise to keep your work</strong> —
								it grants that to an installed application outright, and never asks about it otherwise.
								The offer is just below.
							</p>
							<p>
								Moving this Workspace into a folder on your own computer does the same thing a
								different way: then the files are yours, and no browser decides what happens to
								them.
							</p>
						{:else if durability.kind === 'ephemeral'}
							<p>
								This browser is not letting Ballastella keep anything between visits, which is what
								a private window does. Everything in this Workspace goes when the window closes, and
								there is nothing this browser will promise instead.
							</p>
						{:else}
							<p>
								Nothing this browser answers says whether it will clear your Workspace to make room
								for other sites. Take it as evictable: keep a backup, or move this Workspace into a
								folder on your own computer, where the files are yours.
							</p>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
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
				class:btn-disabled={working}
				aria-disabled={working}
				data-testid="back-up-workspace"
				onclick={() => {
					if (!working) void backUp();
				}}
			>
				Back up “{storage.name}”
			</button>
		{/if}
		<button
			class="btn btn-sm"
			class:btn-disabled={working}
			aria-disabled={working}
			data-testid="restore-workspace"
			onclick={() => {
				if (!working) restoreInput?.click();
			}}
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
			class:btn-disabled={working}
			aria-disabled={working}
			data-testid="move-into-folder"
			onclick={() => {
				if (!working) void moveIntoFolder();
			}}
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
