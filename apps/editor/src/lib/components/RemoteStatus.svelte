<script lang="ts">
	import {
		count,
		REMOTE_STATUS_LABELS,
		REMOTE_STATUS_UNCHECKED,
		describeRemote,
		type RemoteRepository,
		type RemoteStatusState,
		type SaveState,
		type SourceStatus,
		type SynchronizationBaseline
	} from '@ballastella/core';

	import Toast from '$lib/toasts/Toast.svelte';

	import WhereYourWorkIs from './WhereYourWorkIs.svelte';

	let {
		saveState,
		remote: repository,
		state: remote,
		baseline,
		update,
		notice
	}: {
		saveState: SaveState;
		remote: RemoteRepository;
		state: RemoteStatusState;
		baseline: SynchronizationBaseline | null;
		update: { files: number; totalFiles: number } | null;
		notice: string;
	} = $props();

	const remoteStatusClauses: Record<SourceStatus, string> = $derived({
		'in-sync': `in sync with ${describeRemote(repository)}`,
		'changes-to-send': 'changes to send',
		'changes-to-get': 'changes to get',
		'changes-both-ways': 'changes both ways',
		'cannot-tell': "can't tell what's on GitHub"
	});

	const REMOTE_STATUS_DETAILS: Record<SourceStatus, string> = {
		'in-sync':
			'Everything in this Workspace has reached GitHub, and GitHub holds nothing this Workspace does not.',
		'changes-to-send': 'This Workspace has changes GitHub has not got. Sync sends them.',
		'changes-to-get': 'GitHub has changes this Workspace has not got. Sync brings them in.',
		'changes-both-ways':
			'Something changed here and something changed on GitHub since the two last agreed. Sync moves both directions in one act.',
		'cannot-tell':
			'Nothing here can say how the two sides differ: either there is no trustworthy record of what this Workspace and GitHub last shared, or the repository could not be read at all, which is what a private one looks like to somebody signed out.'
	};

	const github = $derived(
		remote.status === null ? 'not checked yet' : remoteStatusClauses[remote.status]
	);

	const clause = $derived(
		remote.checking
			? `${github} · Checking…`
			: remote.failure === ''
				? github
				: `${github} · Check failed`
	);

	const agreeing = $derived(remote.status === 'in-sync' && remote.failure === '');

	const label = $derived(
		remote.status === null ? REMOTE_STATUS_UNCHECKED : REMOTE_STATUS_LABELS[remote.status]
	);

	const detail = $derived(
		remote.status === null
			? 'Nothing has been read from GitHub in this Workspace yet. Sync reads both sides and says what it found.'
			: REMOTE_STATUS_DETAILS[remote.status]
	);

	let detailShown = $state(false);
	const detailId = $props.id();

	const checkedAt = $derived(
		remote.at === null
			? ''
			: new Date(remote.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);
</script>

<div class="flex flex-col items-end gap-0.5" data-testid="remote-status-slot">
	<div class="flex min-h-8 items-center gap-2">
		<WhereYourWorkIs
			{saveState}
			github={clause}
			determination={remote.status ?? 'unchecked'}
			{agreeing}
			popoverTarget={detailId}
			expanded={detailShown}
			onToggle={() => (detailShown = !detailShown)}
		/>
	</div>

	<div
		id={detailId}
		popover="auto"
		class="remote-status-popover max-w-80 rounded-box border border-base-300 bg-base-200 px-3 py-2 text-right shadow-lg"
		data-testid="remote-status-detail"
		aria-label="Sync status details"
		style="position-anchor: --{detailId}"
		ontoggle={(event) => (detailShown = (event as ToggleEvent).newState === 'open')}
	>
		<p class="text-sm font-medium" data-testid="remote-status-determination">{label}</p>
		<p class="text-xs opacity-70">{detail}</p>
		{#if checkedAt !== ''}
			<p class="mt-1 text-xs opacity-70" data-testid="remote-status-checked">
				Checked at {checkedAt}
			</p>
		{/if}
		{#if baseline !== null}
			<p class="mt-1 text-xs opacity-70" data-testid="remote-status-baseline">
				Last agreed with GitHub at commit <code>{baseline.commit}</code>, over
				{count(baseline.files.size, 'file')}.
			</p>
		{/if}
	</div>

	{#if update !== null}
		<p
			aria-live="polite"
			aria-atomic="true"
			class="text-xs text-base-content opacity-70"
			data-testid="update-progress"
		>
			Getting from GitHub: {update.files} of {count(update.totalFiles, 'file')}.
		</p>
	{/if}
</div>

<Toast text={notice} testid="update-outcome" tone="info" />
<Toast text={remote.failure} testid="remote-status-failure" refusal />
<Toast
	text={remote.publishedSiteStale.length === 0
		? ''
		: `The Published Site was built from different files (${count(remote.publishedSiteStale.length, 'file')} ` +
			`differ). The next Sync rebuilds it.`}
	testid="published-site-stale"
	tone="info"
/>

<style>
	.remote-status-popover {
		position: fixed;
		top: 5rem;
		right: 1rem;
		margin: 0;
	}

	@supports (position-area: bottom span-left) {
		.remote-status-popover {
			inset: auto;
			position-area: bottom span-left;
			margin-top: 0.25rem;
		}
	}
</style>
