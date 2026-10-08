<script lang="ts">
	import { tick } from 'svelte';

	import { describeRemote, type ReturnLink } from '@ballastella/core';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';
	import { Task } from '$lib/task.svelte.js';
	import { focusMain } from '$lib/text.js';

	import Alert from './Alert.svelte';
	import BusyButton from './BusyButton.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		storage,
		link,
		ondismiss
	}: {
		storage: WorkspaceStorage;
		link: ReturnLink;
		ondismiss: (
			outcome: { reason: 'declined' | 'finished' } | { reason: 'imported'; directory: string }
		) => void;
	} = $props();

	let outcome = $state('');
	const task = new Task();
	let running = $state<'' | 'import' | 'accept'>('');
	const busy = $derived(running !== '');
	let importedInto = $state('');
	let outcomeLine: HTMLElement | null = $state(null);
	const remote = $derived(describeRemote(link));
	const importTarget = $derived(storage.importTarget);

	async function choose(
		which: 'import' | 'accept',
		operation: () => Promise<string>
	): Promise<void> {
		if (busy) return;
		outcome = '';
		running = which;
		await task.run(async () => {
			outcome = await operation();
			await tick();
			outcomeLine?.focus();
		});
		running = '';
	}

	const accept = (): Promise<void> =>
		choose('accept', async () => {
			const from = { owner: link.owner, repository: link.repository };
			if (link.kind === 'review') {
				return (await storage.reviewFrom({ ...from, project: link.project })).notice;
			}
			const { notice } = await storage.connectNewWorkspaceTo(from);
			connectSequence.syncOpen = true;
			return notice;
		});

	const importProject = (): Promise<void> =>
		choose('import', async () => {
			if (link.kind !== 'review' || importTarget === null) return '';
			const done = await storage.importRemoteProject(
				{ owner: link.owner, repository: link.repository, project: link.project },
				importTarget
			);
			importedInto = done.directory;
			return (
				`Imported ${done.name} into ${done.workspace}. It is yours to edit now, ` +
				`with no connection back to where it came from.`
			);
		});

	const close = () => {
		focusMain();
		ondismiss(
			importedInto === '' ? { reason: 'finished' } : { reason: 'imported', directory: importedInto }
		);
	};
</script>

<section
	class="m-4 rounded-box border border-base-300 p-4"
	aria-live="polite"
	data-testid="return-link-offer"
>
	{#if outcome}
		<p bind:this={outcomeLine} tabindex="-1" data-testid="return-link-outcome">{outcome}</p>
		<button class="btn mt-3 btn-sm" data-testid="dismiss-return-link" onclick={close}>Close</button>
	{:else}
		<h2 class="font-semibold">
			{#if link.kind === 'clone'}
				Get a Workspace from {remote}?
			{:else}
				Open “{link.project}” from {remote}?
			{/if}
		</h2>
		<p class="mt-1 max-w-prose text-sm opacity-70">
			{#if link.kind === 'clone'}
				You followed a link from a published site. This makes a
				<strong>new Workspace of your own</strong>, connects it to {remote}, and shows you what is
				there to get — you choose whether to fetch it. Nothing you already have is changed, and you
				do not need a GitHub account. Nothing has been downloaded yet.
			{:else}
				You followed a link from a published site, and there are two things you can do with that
				Project. <strong>Import</strong> copies it into the Workspace you are in as work of your own
				— yours to edit, share and back up, with no connection back to where it came from.
				<strong>A review copy</strong>
				puts it in a separate throwaway Workspace, so you can look at it without adding it to anything.
				Either way you do not need a GitHub account. Nothing has been downloaded yet.
			{/if}
		</p>

		<div class="mt-3 flex flex-wrap gap-2">
			{#if link.kind === 'review' && importTarget !== null}
				<BusyButton
					{busy}
					class="btn btn-primary btn-sm"
					data-testid="import-return-link"
					onclick={importProject}
				>
					{running === 'import' ? 'Downloading…' : `Import into “${importTarget.name}”`}
				</BusyButton>
			{/if}
			<BusyButton
				{busy}
				class={['btn btn-sm', link.kind === 'clone' && 'btn-primary']}
				data-testid="accept-return-link"
				onclick={accept}
			>
				{#if running === 'accept'}
					{link.kind === 'clone' ? 'Connecting…' : 'Downloading…'}
				{:else if link.kind === 'clone'}
					Make a Workspace and connect it
				{:else}
					Open in a review copy
				{/if}
			</BusyButton>
			<BusyButton
				{busy}
				class="btn btn-sm"
				data-testid="dismiss-return-link"
				onclick={() => {
					focusMain();
					ondismiss({ reason: 'declined' });
				}}
			>
				No thanks
			</BusyButton>
		</div>

		{#if storage.transfer && busy}
			<p class="mt-3 text-sm" data-testid="return-link-progress">
				{storage.transfer.files} of {storage.transfer.totalFiles} files downloaded from
				{storage.transfer.subject}.
			</p>
		{/if}
	{/if}

	<Alert text={task.problem} testid="return-link-problem" tone="error" class="mt-3" />
</section>
