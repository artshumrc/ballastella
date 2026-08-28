<script lang="ts">
	// "Make this Project available offline" (ADR-0025).
	//
	// The Base Map's counterpart to `OfflineCopyJob`, and deliberately the same two-step shape: ADR-0007's
	// rule is that fetching from somebody else's server is a decision the user takes knowingly, and it
	// governs a planet of vector tiles exactly as it governs a library's pyramid. So the dialog states
	// the tile count and the byte estimate, and the button that starts the fetch appears only after
	// they are on screen.
	//
	// `<dialog>` through {@link ModalDialog}, per ADR-0016: `showModal()` brings Escape, the focus trap,
	// and focus restoration, decided once in that component.
	//
	// **Everything here is visible text.** The count, the estimate, the refusal, and the progress are
	// all sentences in the flow of the dialog — no tooltip, no badge colour, and nothing conveyed by
	// an icon alone.

	import { tick } from 'svelte';

	import type { BaseMapEntry, Layer } from '@ballastella/core';

	import ModalDialog from '$lib/components/ModalDialog.svelte';

	import type { MakeProjectOffline } from './make-offline.svelte.js';

	let {
		job,
		entry,
		layers
	}: { job: MakeProjectOffline; entry: BaseMapEntry; layers: readonly Layer[] } = $props();

	let cancelButton: HTMLButtonElement | undefined = $state();
	let startButton: HTMLButtonElement | undefined = $state();

	/**
	 * Start the fetch, and keep the keyboard with it.
	 *
	 * The button that was pressed is destroyed by pressing it — the actions snippet swaps to Cancel —
	 * so a keyboard user would otherwise be dropped to `document.body` behind a modal focus trap for
	 * the length of a job that runs for as long as several hundred tiles take. The same reasoning, and
	 * the same shape, as `OfflineCopyJob.start`.
	 */
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

	<!--
		The count and the estimate, before a single tile is fetched. This is the sentence the whole
		two-step shape exists for: the user agrees to a known cost.
	-->
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
		<!-- A refusal carries the numbers and an explanation, and nothing is written. -->
		<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
			<p data-testid="offline-refusal">{job.refusal}</p>
		</div>
	{:else if job.coverage}
		<p class="mt-4 max-w-prose text-sm opacity-70">
			These tiles come from the server this deployment's Base Map is published on. Ballastella will
			ask it for {job.coverage.missing.length}
			{job.coverage.missing.length === 1 ? 'tile' : 'tiles'} — the ones not already in this Workspace
			— and for nothing else. The data is OpenStreetMap under the Open Database Licence, and the map keeps
			saying so once it is drawn from here.
		</p>
	{/if}

	{#if job.error}
		<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
			<p data-testid="offline-error">{job.error}</p>
		</div>
	{/if}

	<!--
		`aria-live` rather than `role="status"`: the save indicator already owns that role on the Project
		screen, and two of them make `getByRole('status')` ambiguous for a test and a screen reader
		alike. `aria-atomic` so each update is read as a sentence rather than as the digits that changed.

		`data-step` is the dialog saying which step it is on, the same handle `offline-copy-status` carries:
		without it a browser test has only "the dialog is visible" to wait for and samples one that is
		still counting.
	-->
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
				Fetch {job.coverage?.missing.length ?? 0}
				{job.coverage?.missing.length === 1 ? 'tile' : 'tiles'}
			</button>
		{/if}
	{/snippet}
</ModalDialog>
