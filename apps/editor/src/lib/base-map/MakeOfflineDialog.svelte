<script lang="ts">
	import { tick } from 'svelte';

	import type { BaseMapEntry, Layer } from '@ballastella/core';
	import { count } from '@ballastella/core';

	import Alert from '$lib/components/Alert.svelte';
	import ModalDialog from '$lib/components/ModalDialog.svelte';

	import type { MakeProjectOffline } from './make-offline.svelte.js';

	let {
		job,
		entry,
		layers
	}: { job: MakeProjectOffline; entry: BaseMapEntry; layers: readonly Layer[] } = $props();

	let cancelButton: HTMLButtonElement | undefined = $state();
	let startButton: HTMLButtonElement | undefined = $state();

	const start = async (): Promise<void> => {
		const running = job.start(entry);
		await tick();
		cancelButton?.focus();
		await running;
		await tick();
		startButton?.focus();
	};
</script>

<ModalDialog
	bind:open={() => job.open, (open) => !open && job.dismiss()}
	title="Make this Project available offline"
>
	<p class="max-w-prose text-sm">
		Ballastella can keep the modern reference map for the area your work covers in this Workspace,
		so this Project draws with no network connection at all. Your Map Images, Alignments, and
		Annotations already work offline; the Base Map is the part that does not.
	</p>

	{#if job.step === 'inspecting'}
		<p class="mt-4 text-sm" data-testid="offline-inspecting">
			Working out how much of this area is already here…
		</p>
	{/if}

	{#if job.budgetSummary}
		<dl class="mt-4 text-sm" data-testid="offline-budget">
			<dt class="font-medium">What this will fetch</dt>
			<dd data-testid="offline-budget-size">{job.budgetSummary}</dd>
			<dt class="mt-2 font-medium">What is here already</dt>
			<dd data-testid="offline-budget-present">{job.progressSummary}</dd>
		</dl>
	{:else if job.step === 'deciding'}
		<p class="mt-4 text-sm" data-testid="offline-nothing-placed">{job.progressSummary}</p>
	{/if}

	{#if job.refusal}
		<Alert text={job.refusal} testid="offline-refusal" class="mt-4 max-w-prose" />
	{:else if job.coverage}
		<p class="mt-4 max-w-prose text-sm opacity-70">
			These tiles come from the server this deployment's Base Map is served from. Ballastella will
			ask it for {count(job.coverage.missing.length, 'tile')} — the ones not already in this Workspace
			— and for nothing else. The data is OpenStreetMap under the Open Database Licence, and the map keeps
			saying so once it is drawn from here.
		</p>
	{/if}

	<Alert text={job.error} testid="offline-error" class="mt-4 max-w-prose" />

	<div
		aria-live="polite"
		aria-atomic="true"
		class="mt-4 min-h-6"
		data-testid="offline-status"
		data-step={job.step}
		data-available={job.available ? 'yes' : 'no'}
	>
		{#if job.progress}
			<p class="text-sm" data-testid="offline-progress">{job.progressSummary}</p>
			<progress
				class="progress mt-1 w-full"
				value={job.progress.done}
				max={job.progress.total}
				aria-label="Fetching Base Map tiles for this Project"
			></progress>
		{:else if job.completed}
			<p class="text-sm" data-testid="offline-completed">{job.completed}</p>
		{/if}
	</div>

	{#snippet actions()}
		{#if job.busy}
			<button
				bind:this={cancelButton}
				class="btn btn-sm"
				type="button"
				data-testid="offline-cancel"
				onclick={() => job.cancel()}
			>
				Stop fetching
			</button>
		{:else}
			<button
				class="btn btn-sm"
				type="button"
				data-testid="offline-dismiss"
				onclick={() => job.dismiss()}
			>
				Not now
			</button>
			<button
				class="btn btn-sm"
				type="button"
				data-testid="offline-recount"
				onclick={() => void job.inspect(entry, layers)}
			>
				Count again
			</button>
			<button
				bind:this={startButton}
				class="btn btn-primary btn-sm"
				type="button"
				data-testid="offline-start"
				disabled={job.coverage === null ||
					job.refused ||
					job.step === 'inspecting' ||
					job.coverage.missing.length === 0}
				onclick={start}
			>
				Fetch {count(job.coverage?.missing.length ?? 0, 'tile')}
			</button>
		{/if}
	{/snippet}
</ModalDialog>
