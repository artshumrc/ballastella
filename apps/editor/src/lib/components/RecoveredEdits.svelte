<script lang="ts">
	import { tick } from 'svelte';

	import { focusMain } from '$lib/text';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const report = $derived(storage?.session.replayReport ?? null);
	const restoredInto = $derived(
		report === null ? '' : (storage?.workspaceLabel(report.workspace) ?? '')
	);
	const deletions = $derived(storage?.session.deletionReport ?? null);
	let dismissed = $state<string | null>(null);
	const showing = $derived((report !== null || deletions !== null) && dismissed !== reportKey());

	function reportKey(): string {
		return JSON.stringify([
			report?.workspace ?? '',
			report?.restored ?? [],
			report?.skipped.map((entry) => entry.path) ?? [],
			report?.failed.map((entry) => entry.path) ?? [],
			report?.problems.map((entry) => entry.key) ?? [],
			deletions?.finished ?? [],
			deletions?.refused.map((entry) => entry.directory) ?? [],
			deletions?.unfinished ?? []
		]);
	}

	const headingId = $props.id();
	let dismissButton = $state<HTMLButtonElement | null>(null);

	function dismiss(): void {
		dismissed = reportKey();
		focusMain();
	}

	function forget(act: () => void): void {
		act();
		void tick().then(() => {
			if (showing && dismissButton) dismissButton.focus();
			else focusMain();
		});
	}
</script>

<div aria-live="polite" aria-atomic="true" data-testid="recovered-region">
	{#if showing}
		<section
			class="max-h-[40vh] overflow-y-auto border-b border-base-300 bg-base-200"
			aria-labelledby={headingId}
			data-testid="recovered-edits"
		>
			<div class="flex flex-col gap-2 p-4">
				<h2 id={headingId} class="text-base font-semibold">
					{report !== null
						? report.restored.length > 0
							? 'An unsaved change was put back'
							: 'An unsaved change was found'
						: (deletions?.finished.length ?? 0) > 0
							? 'A deletion was finished'
							: 'A deletion was not finished'}
				</h2>
				{#if deletions !== null && deletions.finished.length > 0}
					<p class="text-sm" data-testid="deletion-finished">
						Ballastella closed before {deletions.finished.length === 1
							? 'a Project you deleted was'
							: 'some Projects you deleted were'} finished being removed, so {deletions.finished
							.length === 1
							? 'it has'
							: 'they have'} been removed now: {deletions.finished.join(', ')}.
					</p>
				{/if}
				{#each deletions?.refused ?? [] as entry (entry.directory)}
					<p class="text-sm text-warning" data-testid="deletion-refused">
						{entry.detail}
						<button
							type="button"
							class="btn ml-1 align-baseline btn-xs"
							data-testid="forget-deletion"
							aria-label="Forget the unfinished deletion of “{entry.directory}”"
							onclick={() => forget(() => storage?.session.forgetDeletion(entry.directory))}
						>
							Forget this note
						</button>
					</p>
				{/each}
				{#if deletions !== null && deletions.unfinished.length > 0}
					<p class="text-sm text-warning" data-testid="deletion-unfinished">
						{deletions.unfinished.length === 1 ? 'A Project you deleted' : 'Projects you deleted'} could
						not be removed and {deletions.unfinished.length === 1 ? 'is' : 'are'} still here: {deletions.unfinished.join(
							', '
						)}. Ballastella will try again the next time this Workspace is opened. Deleting {deletions
							.unfinished.length === 1
							? 'it'
							: 'them'} again from the list is the way to be sure.
					</p>
				{/if}
				{#if report !== null && report.restored.length > 0}
					<p class="text-sm">
						Ballastella closed before {report.restored.length === 1
							? 'this file was'
							: 'these files were'}
						finished saving in “{restoredInto}”, so the change has been written now:
					</p>
					<ul class="list-inside list-disc text-sm" data-testid="recovered-restored">
						{#each report.restored as path (path)}
							<li>{path}</li>
						{/each}
					</ul>
				{/if}
				{#each report?.skipped ?? [] as entry (`${entry.path}:${entry.copy ?? ''}`)}
					{@const copy = entry.copy}
					<p class="text-sm text-warning" data-testid="recovered-skipped">
						{entry.detail}
						{#if copy !== null}
							<button
								type="button"
								class="btn ml-1 align-baseline btn-xs"
								data-testid="forget-replay-skip"
								aria-label="Throw away the kept copy of “{entry.path}”"
								onclick={() => forget(() => storage?.session.forgetReplaySkip(entry.path, copy))}
							>
								Throw this copy away
							</button>
						{/if}
					</p>
				{/each}
				{#each report?.failed ?? [] as entry (entry.path)}
					<p class="text-sm text-warning" data-testid="recovered-failed">{entry.detail}</p>
				{/each}
				{#each report?.problems ?? [] as problem (problem.key)}
					<p class="text-sm text-warning" data-testid="recovered-problem">{problem.detail}</p>
				{/each}
				<div class="flex justify-end">
					<button
						type="button"
						class="btn btn-sm"
						data-testid="recovered-dismiss"
						bind:this={dismissButton}
						onclick={dismiss}
					>
						Got it
					</button>
				</div>
			</div>
		</section>
	{/if}
</div>
