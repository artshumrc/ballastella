<script lang="ts">
	import {
		count,
		describeRemote,
		pagesSettingsUrl,
		publishedSiteUrl,
		shareLinksWithdrawalMessage,
		type RemotePagesOutcome,
		type RemoteRights
	} from '@ballastella/core';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';
	import { Task } from '$lib/task.svelte.js';

	import Alert from './Alert.svelte';
	import BusyButton from './BusyButton.svelte';
	import ExternalLink from './ExternalLink.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		storage,
		onclose
	}: {
		storage: WorkspaceStorage;
		onclose: () => void;
	} = $props();

	let rights = $state<RemoteRights | null>(null);
	let rightsAsked = $state(false);
	let pages = $state<RemotePagesOutcome | null>(null);
	let shareLinks = $state<boolean | null>(null);
	const task = new Task();
	let withdrawing = $state(false);
	let withdrawalNotice = $state('');
	let notice = $state('');
	let copied = $state(false);
	const bound = $derived(storage.remote.bound);
	const boundName = $derived(bound === null ? '' : describeRemote(bound));
	const readOnly = $derived(storage.github.signedIn && rights?.canPush === false);
	const siteAddress = $derived(bound === null ? '' : publishedSiteUrl(bound));
	const pagesSettings = $derived(bound === null ? '' : pagesSettingsUrl(bound));
	const withdrawalWarning = $derived(bound === null ? '' : shareLinksWithdrawalMessage(bound));

	const baselineSentence = $derived.by(() => {
		const record = storage.remote.baseline;
		if (bound === null) return '';
		return record === null
			? `Cannot tell what has changed since this Workspace and ${boundName} last agreed: there is ` +
					`no record of it on this computer.`
			: `Ballastella last agreed with ${boundName} at commit ${record.commit}, over ` +
					`${count(record.files.size, 'file')}.`;
	});

	$effect(() => {
		if (bound === null || !storage.github.signedIn || rightsAsked) return;
		rightsAsked = true;
		void storage.remote.readRights().then(
			(answer) => {
				rights = answer;
			},
			() => {}
		);
	});

	$effect(() => {
		void storage.remote.status.shareLinks;
		if (bound === null) return;
		void storage.remote.hasShareLinks().then(
			(answer) => {
				shareLinks = answer;
			},
			() => {}
		);
	});

	const enablePages = () =>
		task.run(async () => {
			pages = await storage.remote.enableShareLinks();
			shareLinks = true;
		});

	const checkPages = () =>
		task.run(async () => {
			pages = await storage.remote.checkShareLinks();
		});

	const withdrawPages = () =>
		task.run(async () => {
			const withdrawal = await storage.remote.withdrawShareLinks();
			withdrawing = false;
			withdrawalNotice = withdrawal.notice;
			pages = null;
			shareLinks = await storage.remote.hasShareLinks();
		});

	function disconnect(): Promise<void> {
		notice = '';
		const was = boundName;
		rights = null;
		rightsAsked = false;
		return task.run(async () => {
			await storage.remote.unbind();
			notice =
				`This Workspace no longer syncs with ${was}. Nothing there has been changed — ` +
				`everything in it is exactly as it was, and connecting again puts things back.`;
		});
	}

	function check(): void {
		onclose();
		void storage.remote.check();
	}

	function chooseAnother(): void {
		onclose();
		connectSequence.open = true;
	}

	async function copyAddress(): Promise<void> {
		copied = false;
		try {
			await navigator.clipboard.writeText(siteAddress);
			copied = true;
		} catch {
			task.problem =
				`This browser would not let the page put anything on the clipboard, so copy the address ` +
				`above by hand. It is usually a setting this browser holds for this site.`;
		}
	}
</script>

{#if bound !== null}
	<section class="mt-4 border-t border-base-300 pt-3" data-testid="workspace-remote">
		<h3 class="font-semibold">On GitHub</h3>
		<p class="mt-1 max-w-prose" data-testid="workspace-remote-repository">
			This Workspace syncs with <code>{boundName}</code>.
		</p>
		<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="remote-baseline">
			{baselineSentence}
		</p>
		{#if !storage.github.signedIn}
			<p class="mt-3 max-w-prose text-sm" data-testid="send-needs-sign-in">
				Sending to <code>{boundName}</code> needs you to be signed in to GitHub. Getting from it does
				not.
			</p>
		{:else if readOnly}
			<Alert role="status" class="mt-3">
				<p data-testid="read-only-remote">
					You can get changes from <code>{boundName}</code> into this Workspace, but you cannot send
					to it: GitHub does not give this sign-in write access there. Nothing is wrong with your
					work or your sign-in. If <code>{boundName}</code> is somebody else's, ask them for write access
					to it — or sync with a repository of your own instead.
				</p>
			</Alert>
		{/if}
		<p class="mt-3 max-w-prose text-sm opacity-70" data-testid="shared-remote-limit">
			If somebody else works in <code>{boundName}</code> too, the two of you can work on different Projects
			at the same time. What you cannot both do is align the same Map Image: whoever syncs second is asked
			which of the two Alignments to keep.
		</p>
		<p class="mt-3 max-w-prose">
			With Share Links on, your map answers at
			<code data-testid="published-site-address">{siteAddress}</code>.
		</p>
		{#if storage.github.signedIn && shareLinks !== null}
			{#if pages?.enabled}
				<p class="mt-3 max-w-prose" data-testid="pages-enabled">
					Anybody you give that address to can now open your map there. It appears the first time
					you Sync.
				</p>
			{:else if shareLinks !== true}
				<p class="mt-3 max-w-prose">
					That address answers nothing yet. Your work is on GitHub either way — Share Links is what
					also lets other people open it.
				</p>
				{#if storage.github.pagesSetupByHand}
					<p class="mt-2 max-w-prose" data-testid="pages-setup-by-hand">
						GitHub Pages is one setting you turn on yourself. Then turn Share Links on here.
					</p>
					<ExternalLink
						class="btn mt-2 btn-sm"
						href={pagesSettings}
						data-testid="pages-settings-button"
					>
						Open GitHub Pages settings
					</ExternalLink>
				{/if}
				<BusyButton
					busy={task.working}
					class="btn mt-2 btn-sm"
					data-testid="enable-pages"
					onclick={enablePages}
				>
					{task.working ? 'Asking GitHub…' : 'Turn Share Links on'}
				</BusyButton>
			{/if}
		{/if}
		{#if pages && !pages.enabled}
			<Alert role="status" text={pages.instruction} testid="pages-notice" class="mt-3">
				{#if pages.next === 'guided'}
					<p>
						<ExternalLink class="link" href={pages.settingsUrl} data-testid="pages-settings-link">
							Open Settings → Pages for {boundName}
						</ExternalLink>
						— set Source to “Deploy from a branch”, choose
						<code data-testid="pages-branch">{pages.branch}</code> and
						<code>/ (root)</code>, and press Save.
					</p>
					<BusyButton
						busy={task.working}
						class="btn btn-sm"
						data-testid="check-pages"
						onclick={checkPages}
					>
						{task.working ? 'Asking GitHub…' : 'Check again'}
					</BusyButton>
				{/if}
			</Alert>
		{/if}
		{#if shareLinks === true && storage.github.signedIn}
			{#if withdrawing}
				<Alert text={withdrawalWarning} testid="withdraw-warning" class="mt-3">
					<div class="flex flex-wrap gap-2">
						<BusyButton
							busy={task.working}
							class="btn btn-sm btn-warning"
							data-testid="withdraw-share-links-confirm"
							onclick={withdrawPages}
						>
							{task.working ? 'Asking GitHub…' : 'Withdraw Share Links'}
						</BusyButton>
						<button
							class="btn btn-ghost btn-sm"
							data-testid="withdraw-share-links-cancel"
							onclick={() => (withdrawing = false)}
						>
							Keep them
						</button>
					</div>
				</Alert>
			{:else}
				<button
					class="btn mt-3 btn-ghost btn-sm"
					data-testid="withdraw-share-links"
					onclick={() => (withdrawing = true)}
				>
					Withdraw Share Links…
				</button>
			{/if}
		{/if}
		<Alert role="status" text={withdrawalNotice} testid="withdrawal-notice" class="mt-3" />
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<BusyButton
				busy={storage.remote.status.checking}
				class="btn btn-sm"
				data-testid="check-remote-status"
				onclick={check}
			>
				Check Remote Status
			</BusyButton>
			<button class="btn btn-sm" data-testid="change-repository" onclick={chooseAnother}>
				Choose a different repository
			</button>
			<button
				class="btn btn-sm"
				data-testid="copy-published-site-address"
				onclick={() => void copyAddress()}
			>
				Copy the address
			</button>
			<BusyButton
				busy={task.working}
				class="btn btn-outline btn-sm btn-warning"
				data-testid="unbind-remote"
				onclick={disconnect}
			>
				Disconnect from {boundName}
			</BusyButton>
			<p aria-live="polite" class="text-sm opacity-70" data-testid="copied-address">
				{copied ? 'The address is on your clipboard.' : ''}
			</p>
		</div>
	</section>
{/if}

<Alert role="status" text={notice} testid="workspace-remote-notice" class="mt-3" />
<Alert text={task.problem} testid="workspace-remote-problem" class="mt-3" />
