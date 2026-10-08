<script lang="ts">
	import { resolve } from '$app/paths';
	import { count, describeBytes, messageOf, type WorkspaceSize } from '@ballastella/core';
	import { AppBar, BallastellaMark, MenuPopover, pageChrome } from '@ballastella/ui';
	import AppWindow from '@lucide/svelte/icons/app-window';
	import Folder from '@lucide/svelte/icons/folder';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { tick } from 'svelte';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';
	import SyncDialog from '$lib/sync/SyncDialog.svelte';
	import { syncControlLabel, type SyncProgress } from '$lib/sync/sync-progress.js';
	import EditHistoryControls from '$lib/undo/EditHistoryControls.svelte';
	import { editHistorySlot } from '$lib/undo/edit-history-slot.svelte.js';
	import { theme } from '$lib/theme.svelte';
	import {
		useWorkspaceHost,
		type WorkspaceBacking,
		type WorkspaceEntry
	} from '$lib/workspace-storage.svelte.js';

	import Toast from '$lib/toasts/Toast.svelte';

	import ConfirmDialog from './ConfirmDialog.svelte';
	import ConnectToGitHub from './ConnectToGitHub.svelte';
	import WorkspaceRemote from './WorkspaceRemote.svelte';
	import KeepingYourWork from './KeepingYourWork.svelte';
	import ModalDialog from './ModalDialog.svelte';
	import RemoteStatus from './RemoteStatus.svelte';
	import WhereYourWorkIs from './WhereYourWorkIs.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const session = $derived(storage?.session ?? null);
	const workspaceName = $derived(storage === null ? 'Starting…' : storage.name);
	const unreachable = $derived(session?.status === 'unreachable');
	const entries = $derived<readonly WorkspaceEntry[]>(storage?.workspaceEntries ?? []);
	const kindsAreVisible = $derived(storage?.canChooseFolder ?? false);

	const backingSentence = $derived(
		storage?.backing === 'folder' ? 'A folder on this computer' : 'Kept in this browser'
	);

	let menu = $state<ReturnType<typeof MenuPopover> | undefined>();
	let doorButton = $state<HTMLButtonElement | undefined>();
	let syncing = $state(false);
	let syncProgress = $state<SyncProgress | null>(null);
	const syncable = $derived(
		storage !== null && storage.review === null && storage.unavailable === ''
	);

	let newName = $state<string | null>(null);
	let newWorkspaceOpen = $state(false);
	let newKind = $state<WorkspaceBacking>('browser');
	let renaming = $state<{ key: string; label: string; isOpen: boolean } | null>(null);
	let renameOpen = $state(false);
	let confirming = $state<{
		key: string;
		label: string;
		kind: WorkspaceBacking;
		size: WorkspaceSize | null;
	} | null>(null);
	let confirmOpen = $state(false);
	const formId = $props.id();
	const newWorkspaceFormId = `${formId}-new`;
	const renameFormId = `${formId}-rename`;

	$effect(() => {
		if (!newWorkspaceOpen) {
			setTimeout(() => {
				if (!newWorkspaceOpen) newName = null;
			});
		}
	});

	$effect(() => {
		if (!renameOpen) {
			setTimeout(() => {
				if (!renameOpen) renaming = null;
			});
		}
	});

	let announcement = $state('');

	function fromMenu(act: () => void): void {
		menu?.dismiss();
		act();
	}

	function closeNewWorkspace(): void {
		newWorkspaceOpen = false;
	}

	async function openEntry(entry: WorkspaceEntry): Promise<void> {
		if (!storage) return;
		await storage.openEntry(entry.key);
		announcement = storage.problem || `Switched to the Workspace “${storage.name}”.`;
	}

	function startRename(entry: WorkspaceEntry): void {
		renaming = { key: entry.key, label: entry.label, isOpen: entry.isOpen };
		renameOpen = true;
	}

	function closeRename(): void {
		renameOpen = false;
	}

	async function commitRename(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = renaming;
		closeRename();
		if (!storage || asked === null || asked.label.trim() === '') return;
		const wanted = asked.label.trim();
		announcement = (await storage.renameEntry(asked.key, wanted))
			? `Renamed the Workspace to “${wanted}”.`
			: `This browser would not keep the new name, so nothing has been renamed.`;
	}

	async function askToDelete(entry: WorkspaceEntry): Promise<void> {
		confirming = { key: entry.key, label: entry.label, kind: entry.kind, size: null };
		confirmOpen = true;
		const size = (await storage?.sizeOfEntry(entry.key)) ?? null;
		if (confirming?.key === entry.key) confirming = { ...confirming, size };
	}

	async function confirmDelete(): Promise<void> {
		const going = confirming;
		if (!storage || going === null) return;
		confirmOpen = false;
		confirming = null;
		try {
			await storage.deleteEntry(going.key);
			announcement =
				going.kind === 'folder'
					? `Took the Workspace “${going.label}” off the list. The folder itself is untouched.`
					: `Deleted the Workspace “${going.label}” and everything in it.`;
		} catch (cause) {
			announcement = messageOf(cause);
		}
	}

	async function createWorkspace(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const asked = newName ?? '';
		if (asked.trim() === '') {
			closeNewWorkspace();
			return;
		}
		const kind = newKind;
		closeNewWorkspace();
		try {
			const made =
				kind === 'folder'
					? await storage?.createFolderWorkspace(asked)
					: await storage?.createWorkspace(asked);
			if (!made) {
				announcement = storage?.problem ?? '';
				return;
			}
			announcement = `Created the Workspace “${made}” and switched to it.`;
		} catch (cause) {
			announcement = messageOf(cause);
		}
	}
</script>

{#snippet start()}
	<div class="flex items-center gap-4" data-testid="workspace-identity">
		{#if storage === null}
			<span class="font-medium">{workspaceName}</span>
		{:else}
			<MenuPopover
				bind:this={menu}
				label={workspaceName}
				ariaLabel={`Workspace: ${workspaceName}`}
				buttonClass="btn max-w-[14rem] truncate btn-sm font-medium"
				testid="workspace-switcher"
			>
				<li class="menu-title" data-testid="workspace-header">
					<span class="block truncate text-sm font-semibold text-base-content">
						{workspaceName}
					</span>
					{#if kindsAreVisible}
						<span class="block font-normal" data-testid="workspace-backing">
							<span class="text-base-content opacity-70">{backingSentence}</span>
						</span>
					{/if}
				</li>
				<li class="menu-title">Your Workspaces</li>
				{#each entries as entry (entry.key)}
					<li class="flex-row items-center">
						<button
							type="button"
							class="min-w-0 grow"
							data-testid="switch-workspace"
							data-workspace={entry.label}
							data-kind={entry.kind}
							aria-current={entry.isOpen ? 'true' : undefined}
							onclick={() =>
								fromMenu(() => {
									if (!entry.isOpen) void openEntry(entry);
								})}
						>
							{#if kindsAreVisible}
								{#if entry.kind === 'folder'}
									<Folder size={16} aria-hidden="true" class="shrink-0" />
								{:else}
									<AppWindow size={16} aria-hidden="true" class="shrink-0" />
								{/if}
							{/if}
							<span class="min-w-0">
								<span class="block truncate">
									{entry.label}{#if entry.isReviewCopy}<span class="opacity-70"
											>&nbsp;(review copy)</span
										>{/if}{#if entry.isOpen}<span class="opacity-70">&nbsp;(open)</span>{/if}
								</span>
								{#if kindsAreVisible && entry.folderName}
									<span
										class="block truncate text-xs opacity-70"
										data-testid="workspace-folder-name">{entry.folderName}</span
									>
								{/if}
								{#if unreachable && entry.isOpen}
									<span class="block text-warning" data-testid="workspace-unreachable">
										Unreachable. The notice on this screen can locate it again.
									</span>
								{/if}
							</span>
						</button>
						<button
							type="button"
							class="shrink-0"
							data-testid="rename-workspace"
							onclick={() => fromMenu(() => startRename(entry))}
						>
							<Pencil size={16} aria-hidden="true" class="shrink-0" />
							<span class="sr-only">Rename {entry.label}</span>
						</button>
						{#if !entry.isOpen}
							<button
								type="button"
								class="shrink-0"
								data-testid="delete-workspace"
								onclick={() => fromMenu(() => void askToDelete(entry))}
							>
								<Trash2 size={16} aria-hidden="true" class="shrink-0" />
								<span class="sr-only">
									{#if entry.kind === 'folder'}
										Take {entry.label} off the list
									{:else}
										Delete {entry.label}
									{/if}
								</span>
							</button>
						{/if}
					</li>
				{/each}
				<li>
					<button
						type="button"
						data-testid="new-workspace"
						onclick={() =>
							fromMenu(() => {
								newName = '';
								newKind = 'browser';
								newWorkspaceOpen = true;
							})}
					>
						<Plus size={16} aria-hidden="true" class="shrink-0" />
						New Workspace…
					</button>
				</li>
			</MenuPopover>
		{/if}
		{#if pageChrome.breadcrumbs.length > 0}
			<span class="h-8 border-l border-base-300" aria-hidden="true"></span>
		{/if}
	</div>

	<p class="sr-only" aria-live="polite" data-testid="workspace-announcement">{announcement}</p>
{/snippet}

{#snippet end()}
	{#if session !== null}
		<div class="flex items-center gap-2" data-testid="undo-slot">
			{#if editHistorySlot.history !== null}
				<EditHistoryControls history={editHistorySlot.history} />
			{/if}
		</div>

		<div class="flex items-start" data-testid="save-slot">
			{#if storage !== null && storage.remote.bound !== null && storage.review === null}
				<RemoteStatus
					saveState={session.saveState}
					remote={storage.remote.bound}
					state={storage.remote.status}
					baseline={storage.remote.baseline}
					update={storage.remote.updateProgress}
					notice={storage.remote.updateNotice}
				/>
			{:else}
				<WhereYourWorkIs saveState={session.saveState} />
			{/if}
		</div>

		<Toast text={session.saveError} testid="save-error" refusal />
		<Toast text={session.protectionWarning} testid="protection-warning" refusal />
		<Toast text={session.deletionWarning} testid="deletion-warning" refusal />
		<Toast text={storage?.unprotected ?? ''} testid="unprotected-browser" />

		{#if syncable && storage !== null}
			<button
				type="button"
				bind:this={doorButton}
				class="btn btn-sm"
				class:btn-primary={storage.remote.bound === null}
				class:btn-disabled={syncing}
				aria-disabled={syncing}
				data-testid="connect-to-github"
				onclick={() => {
					if (syncing) return;
					if (storage?.remote.bound === null) connectSequence.open = true;
					else connectSequence.syncOpen = true;
				}}
			>
				{syncing
					? syncControlLabel(syncProgress)
					: storage.remote.bound === null
						? 'Sync with GitHub'
						: 'Sync'}
			</button>
		{/if}
	{/if}
{/snippet}

{#snippet wordmark()}
	<a
		class="hidden link items-center gap-2 font-serif text-xl leading-none link-hover md:flex"
		data-testid="app-wordmark"
		href={resolve('/')}
	>
		<BallastellaMark />
		Ballastella
	</a>
{/snippet}

<AppBar
	{start}
	{end}
	{wordmark}
	theme={theme.current}
	themeLast
	onSelectTheme={(next) => (theme.current = next)}
	homeHref={resolve('/')}
/>

{#if syncable && storage !== null}
	<SyncDialog
		{storage}
		bind:open={connectSequence.syncOpen}
		bind:syncing
		bind:progress={syncProgress}
		restoreFocusTo={() => doorButton}
		onrepositorysettings={async () => {
			await tick();
			const open = entries.find((entry) => entry.isOpen);
			if (open !== undefined) startRename(open);
		}}
	/>
	<ConnectToGitHub
		{storage}
		bind:open={connectSequence.open}
		onsync={() => (connectSequence.syncOpen = true)}
	/>
{/if}

{#if storage !== null && newName !== null}
	<ModalDialog bind:open={newWorkspaceOpen} title="Create a Workspace">
		<form id={newWorkspaceFormId} onsubmit={(event) => void createWorkspace(event)}>
			<label class="form-control">
				<span class="label-text">Name</span>
				<input class="input w-full" bind:value={newName} data-testid="new-workspace-name" />
			</label>
			{#if kindsAreVisible}
				<fieldset class="mt-4" data-testid="new-workspace-kind">
					<legend class="label-text mb-2">Where the new Workspace lives</legend>
					{#each [['browser', 'In this browser'], ['folder', 'In a folder']] as const as [kind, label], at (kind)}
						<label class={['flex items-center gap-2', at > 0 && 'mt-2']}>
							<input
								type="radio"
								class="radio radio-sm"
								value={kind}
								bind:group={newKind}
								data-testid="new-workspace-{kind}"
							/>
							{label}
						</label>
					{/each}
				</fieldset>
			{/if}
		</form>
		{#snippet actions()}
			<button class="btn" type="button" onclick={closeNewWorkspace}>Cancel</button>
			<button
				class="btn btn-primary"
				type="submit"
				form={newWorkspaceFormId}
				data-testid="create-workspace"
			>
				Create and switch
			</button>
		{/snippet}
	</ModalDialog>
{/if}

{#if storage !== null && renaming !== null}
	<ModalDialog bind:open={renameOpen} title="Rename this Workspace">
		<form id={renameFormId} onsubmit={(event) => void commitRename(event)}>
			<label class="form-control">
				<span class="label-text">New name</span>
				<input
					class="input w-full"
					bind:value={renaming.label}
					data-testid="rename-workspace-name"
					onfocus={(event) => event.currentTarget.select()}
				/>
			</label>
		</form>
		<KeepingYourWork {storage} />
		{#if renaming.isOpen}
			<WorkspaceRemote {storage} onclose={closeRename} />
		{/if}
		{#snippet actions()}
			<button class="btn" type="button" onclick={closeRename}>Cancel</button>
			<button
				class="btn btn-primary"
				type="submit"
				form={renameFormId}
				data-testid="save-workspace-name"
			>
				Rename
			</button>
		{/snippet}
	</ModalDialog>
{/if}

<ConfirmDialog
	bind:open={confirmOpen}
	title={confirming?.kind === 'folder'
		? 'Take this Workspace off the list?'
		: 'Delete this Workspace?'}
	confirm={confirming?.kind === 'folder'
		? `Take “${confirming.label}” off the list`
		: `Delete “${confirming?.label}”`}
	confirmClass="btn-warning"
	cancel="Keep it"
	testid="confirm-delete-workspace"
	onconfirm={confirmDelete}
>
	<p class="max-w-prose">
		{#if confirming?.kind === 'folder'}
			“{confirming?.label}” will be taken off this list, and this browser will let go of its hold on
			the folder. The folder itself and every file in it stay exactly where they are. Choosing it
			again brings it back.
		{:else}
			“{confirming?.label}” and everything in it — every Project, every Map Image, every Alignment —
			will be deleted from this browser. This cannot be undone.
		{/if}
	</p>
	<p class="mt-3 text-sm" data-testid="delete-workspace-size">
		{#if confirming?.size}
			It holds {count(confirming.size.files, 'file')}, {describeBytes(confirming.size.bytes)}.
		{:else if confirming?.kind === 'folder'}
			Ballastella cannot say what the folder holds without opening it, and it is not currently open.
		{:else}
			Working out what it holds…
		{/if}
	</p>
</ConfirmDialog>
