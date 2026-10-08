<script lang="ts">
	import { tick } from 'svelte';

	import type { ReferencedImage } from '@ballastella/core';

	import Alert from '$lib/components/Alert.svelte';
	import ModalDialog from '$lib/components/ModalDialog.svelte';

	import type { OfflineCopyJob } from './offline-copy-job.svelte.js';

	let { image, job }: { image: ReferencedImage; job: OfflineCopyJob } = $props();

	const mine = $derived(job.image?.imageId === image.imageId);
	const plan = $derived(mine ? job.plan : null);
	let cancelButton: HTMLButtonElement | undefined = $state();
	let startButton: HTMLButtonElement | undefined = $state();

	const start = async (): Promise<void> => {
		const running = job.start();
		await tick();
		cancelButton?.focus();
		await running;
		await tick();
		startButton?.focus();
	};
</script>

<button
	class="btn btn-sm"
	type="button"
	data-testid="offline-copy-open"
	disabled={job.busy}
	onclick={() => job.prepare(image)}
>
	Make an offline copy
</button>

{#if mine}
	<ModalDialog
		bind:open={() => job.open, (open) => !open && job.dismiss()}
		title="Make an offline copy"
	>
		<p class="font-medium">{image.label || image.imageId}</p>
		<p class="text-sm opacity-70">
			Served by <code data-testid="offline-copy-host">{new URL(image.service).hostname}</code>
		</p>

		<dl class="mt-4 text-sm" data-testid="offline-copy-rights">
			<dt class="font-medium">Rights</dt>
			<dd class="break-all">
				{image.rights || 'This library states no rights for this image.'}
			</dd>
			<dt class="mt-2 font-medium">Required statement</dt>
			<dd>{image.attribution || 'This library asked for no particular attribution.'}</dd>
		</dl>
		<p class="mt-2 max-w-prose text-sm opacity-70">
			Ballastella does not decide whether you may keep a copy of this image. Check the statement
			above against what you mean to do with it.
		</p>

		{#if job.step === 'preparing'}
			<p class="mt-4 text-sm">Reading what this copy would involve…</p>
		{/if}

		{#if plan}
			{#if plan.refusal}
				<Alert class="mt-4 max-w-prose" testid="offline-copy-refusal" text={plan.refusal} />
			{:else}
				<p class="mt-4 text-sm" data-testid="offline-copy-size">{job.sizeSummary}</p>

				{#each plan.notes as note (note)}
					<div class="mt-4 alert max-w-prose alert-info" data-testid="offline-copy-note">
						<p>{note}</p>
					</div>
				{/each}

				{#if job.hostingWarning}
					<div
						class="mt-4 alert max-w-prose alert-warning"
						data-testid="offline-copy-hosting-warning"
					>
						<p>{job.hostingWarning}</p>
					</div>
				{/if}
			{/if}
		{/if}

		<Alert class="mt-4 max-w-prose" testid="offline-copy-error" text={job.error} />

		<div
			aria-live="polite"
			aria-atomic="true"
			class="mt-4 min-h-6"
			data-testid="offline-copy-status"
			data-step={job.step}
		>
			{#if job.progress}
				<p class="text-sm" data-testid="offline-copy-progress">{job.progressMessage}</p>
				<progress
					class="progress mt-1 w-full"
					value={job.progress.fraction}
					max="1"
					aria-label="Making an offline copy of {image.label || image.imageId}"
				></progress>
			{/if}
		</div>

		{#snippet actions()}
			{#if job.busy}
				<button
					bind:this={cancelButton}
					class="btn btn-sm"
					type="button"
					data-testid="offline-copy-cancel"
					onclick={() => job.cancel()}
				>
					Cancel the copy
				</button>
			{:else}
				<button
					class="btn btn-sm"
					type="button"
					data-testid="offline-copy-dismiss"
					onclick={() => job.dismiss()}
				>
					Not now
				</button>
				<button
					bind:this={startButton}
					class="btn btn-primary btn-sm"
					type="button"
					data-testid="offline-copy-start"
					disabled={!plan || plan.refusal !== '' || job.step === 'preparing'}
					onclick={start}
				>
					Copy it into this Project
				</button>
			{/if}
		{/snippet}
	</ModalDialog>
{/if}
