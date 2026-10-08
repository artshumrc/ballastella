<script lang="ts">
	import {
		count,
		describeBytes,
		deriveStorageDurability,
		type StorageDurability
	} from '@ballastella/core';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	import InstallOffer from '$lib/pwa/InstallOffer.svelte';
	import { useInstalledApp } from '$lib/pwa/installed-app.svelte.js';
	import { Task } from '$lib/task.svelte.js';

	import BusyButton from './BusyButton.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let { storage }: { storage: WorkspaceStorage } = $props();

	const app = useInstalledApp();

	const durability = $derived<StorageDurability | null>(
		storage.storageAnswers === null
			? null
			: deriveStorageDurability({
					...storage.storageAnswers,
					installed: app.installed,
					fileSystemAccess: storage.canChooseFolder
				})
	);

	const DURABILITY_LEAD: Record<StorageDurability['kind'], string> = {
		granted:
			'Kept. This browser has promised not to clear your Workspace to make room for other sites.',
		'can-ask': 'Not kept yet — this browser will ask you first.',
		'install-to-keep': 'Not kept yet. Installing Ballastella is what changes that.',
		'seven-day': 'This browser deletes your Workspace after seven days without a visit.',
		ephemeral: 'This window keeps nothing: your work will not survive closing it.',
		unknown: 'This browser will not say whether it keeps your Workspace.'
	};

	let durabilityShown = $state(false);
	let keeping = $state('');

	async function askToKeepStorage(): Promise<void> {
		keeping = '';
		await storage.askToKeepStorage();
		keeping =
			durability?.kind === 'granted'
				? 'Kept. This browser has promised to keep your Workspace, and you may store much more in it.'
				: 'This browser did not grant it. A backup is the answer that does not depend on it.';
	}

	const task = new Task();
	let transfer = $state('');
	let outcome = $state('');
	let restoreInput = $state<HTMLInputElement | null>(null);
	let discarded = $state('');

	function transferring(label: string, act: () => Promise<string>): Promise<void> {
		outcome = '';
		transfer = label;
		return task.run(async () => {
			try {
				outcome = await act();
			} finally {
				transfer = '';
			}
		});
	}

	const backUp = () =>
		transferring(`Backing up “${storage.name}”…`, async () => {
			const backup = await storage.backUp((progress) => {
				transfer = `Backing up “${storage.name}”… ${progress.files} of ${progress.totalFiles} files.`;
			});
			return (
				`Backed up ${count(backup.totalFiles, 'file')}, ` +
				`${describeBytes(backup.totalBytes)}, to “${backup.fileName}”.` +
				(backup.displayName === backup.workspaceName
					? ''
					: ` Restoring it will make a Workspace called “${backup.workspaceName}”, because a ` +
						`Workspace name can only hold letters, numbers, spaces and “-_()”.`)
			);
		});

	function restore(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		void transferring(`Restoring from “${file.name}”…`, async () => {
			const restored = await storage.restoreFrom(file, (progress) => {
				transfer = `Restoring from “${file.name}”… ${progress.files} files so far.`;
			});
			return restored.notice;
		});
	}

	const moveIntoFolder = () =>
		transferring(`Moving “${storage.name}” into the folder you choose…`, () =>
			storage.moveIntoFolder((progress) => {
				transfer = `Copying “${storage.name}” into the folder… ${progress.files} of ${progress.totalFiles} files.`;
			})
		);

	function discardOrphanedJournal(key: string): void {
		const dropped = storage.discardOrphanedJournal(key);
		const parts = [
			...(dropped.edits > 0 ? [count(dropped.edits, 'unsaved change')] : []),
			...(dropped.deletions > 0 ? [count(dropped.deletions, 'unfinished deletion')] : [])
		];
		discarded =
			parts.length > 0
				? `Threw away ${parts.join(' and ')} held for “${storage.workspaceLabel(key)}”. Nothing in any Workspace was touched.`
				: `There was nothing left to throw away for “${storage.workspaceLabel(key)}” — something else had already cleared it. Nothing in any Workspace was touched.`;
	}
</script>

<section class="mt-10 flex flex-col items-start gap-3 border-t border-rule pt-6">
	<h2 class="font-serif text-lg">Keeping your work</h2>

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

	<InstallOffer />

	<h3 class="mt-3 text-sm font-semibold">Backing up and restoring</h3>
	<p class="text-sm opacity-70">
		One <code>.tar</code> file holding this whole Workspace. Restoring always makes a
		<em>new</em>
		Workspace and switches to it — it never overwrites and never merges.
	</p>

	{#if storage.review !== null}
		<p class="text-sm text-warning" data-testid="no-backup-in-review">
			This is a review copy of somebody else's Project, so it is not backed up. Restoring still
			works, and lands in a new Workspace of your own.
		</p>
	{/if}

	{#if storage.unavailable}
		<p class="text-sm text-warning" data-testid="no-backup-unrecovered">
			This Workspace has not opened yet, so it is not backed up. Reload the page to finish clearing
			up the transfer that did not finish.
		</p>
	{/if}

	<div class="flex flex-wrap gap-2">
		{#if storage.review === null && !storage.unavailable}
			<BusyButton
				busy={task.working}
				class="btn btn-sm"
				data-testid="back-up-workspace"
				onclick={backUp}
			>
				Back up “{storage.name}”
			</BusyButton>
		{/if}
		<BusyButton
			busy={task.working}
			class="btn btn-sm"
			data-testid="restore-workspace"
			onclick={() => restoreInput?.click()}
		>
			Restore from a backup…
		</BusyButton>
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
		<BusyButton
			busy={task.working}
			class="btn btn-sm"
			data-testid="move-into-folder"
			onclick={moveIntoFolder}
		>
			Move this Workspace into a folder…
		</BusyButton>
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
	{#if task.problem}
		<div role="alert" class="alert items-start alert-soft alert-warning">
			<TriangleAlert class="size-5 shrink-0" aria-hidden="true" />
			<p data-testid="transfer-problem">{task.problem}</p>
		</div>
	{/if}

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
