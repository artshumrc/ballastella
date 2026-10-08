<script lang="ts">
	import { tick } from 'svelte';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { describeReviewSubject, messageOf } from '@ballastella/core';

	import { Task } from '$lib/task.svelte.js';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import Alert from './Alert.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const review = $derived(storage?.review ?? null);
	let confirmingDiscard = $state(false);
	let confirmingImport = $state(false);
	const importing = new Task();
	let announcement = $state('');
	let announcementLine: HTMLElement | null = $state(null);
	let importButton: HTMLElement | null = $state(null);
	const importProgress = $derived.by(() => {
		const transfer = storage?.transfer;
		if (!importing.working || !transfer || transfer.kind !== 'import' || transfer.finished)
			return '';
		return `Copying ${transfer.subject}: ${transfer.files} of ${transfer.totalFiles} files.`;
	});

	const destination = $derived(review?.origin ?? null);
	const subject = $derived(review === null ? '' : describeReviewSubject(review));

	const withProblem = (said: string): string =>
		storage?.problem ? `${said} ${storage.problem}` : said;

	async function leave(): Promise<void> {
		if (!storage) return;
		await storage.leaveReview();
		announcement = withProblem(
			`Left the review copy. You are back in your own Workspace, “${storage.name}”.`
		);
	}

	async function importReviewed(): Promise<void> {
		if (importing.working) return;
		confirmingImport = false;
		if (!storage) return;
		await importing.run(async () => {
			const imported = await storage.importReview();
			announcement = imported.incomplete
				? imported.incomplete
				: `Imported “${imported.name}” into “${imported.workspace}”, and discarded the review copy.`;
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(`${resolve('/')}?p=${encodeURIComponent(imported.directory)}`, {
				replaceState: true,
				noScroll: true,
				keepFocus: true
			}).catch(() => undefined);
			await tick();
			announcementLine?.focus();
		});
		if (importing.problem === '') return;
		await tick();
		importButton?.focus();
	}

	async function discard(): Promise<void> {
		confirmingDiscard = false;
		if (!storage) return;
		const discarded = storage.name;
		try {
			await storage.discardReview();
			announcement = withProblem(`Discarded the review copy “${discarded}” and everything in it.`);
		} catch (cause) {
			announcement = messageOf(cause);
		}
	}
</script>

{#if review !== null && storage !== null}
	<section
		aria-label="Review copy"
		class="flex flex-wrap items-center gap-3 border-b border-warning bg-warning/15 px-4 py-2 text-sm"
		data-testid="review-banner"
	>
		<p class="grow">
			<strong>Review copy.</strong>
			This Workspace holds {subject} and nothing else. It is a throwaway copy: your own Workspaces are
			untouched, nothing here reaches one unless you Import it, and discarding it removes everything in
			it.
			{#if destination === null}
				<span data-testid="review-import-unavailable">
					This copy does not record which of your Workspaces it was opened from, so it cannot be
					Imported. Go back to your own Workspace and Import the file or the link there instead.
				</span>
			{/if}
		</p>
		{#if destination !== null}
			<button
				bind:this={importButton}
				class="btn btn-primary btn-sm"
				class:btn-disabled={importing.working}
				aria-disabled={importing.working}
				data-testid="import-review"
				onclick={() => !importing.working && (confirmingImport = true)}
			>
				Import into “{destination.name}”
			</button>
		{/if}
		<button class="btn btn-sm" data-testid="leave-review" onclick={() => void leave()}>
			Back to my Workspace
		</button>
		<button
			class="btn btn-outline btn-error btn-sm"
			data-testid="discard-review"
			onclick={() => (confirmingDiscard = true)}
		>
			Discard this review copy
		</button>
	</section>
{/if}

<p
	bind:this={announcementLine}
	tabindex="-1"
	aria-live="polite"
	class="px-4 text-sm"
	class:sr-only={announcement === ''}
	class:py-2={announcement !== ''}
	data-testid="review-announcement"
>
	{announcement}
</p>

<p
	aria-live="polite"
	class="px-4 text-sm"
	class:sr-only={importProgress === ''}
	data-testid="review-import-progress"
>
	{importProgress}
</p>

<Alert text={importing.problem} testid="review-import-problem" tone="error" class="m-4" />

{#if review !== null && storage !== null && destination !== null}
	<ConfirmDialog
		bind:open={confirmingImport}
		title={`Import into “${destination.name}”`}
		confirm="Import and discard the review copy"
		confirmClass="btn-primary"
		testid="confirm-import-review"
		onconfirm={importReviewed}
	>
		<p data-testid="import-review-state">
			Copy {subject} <strong>as it is now</strong>, including any edits you have made in this review
			copy, into your Workspace <strong>{destination.name}</strong>? The copy is yours to edit: its
			Map Images arrive as new ones of your own, so nothing you have already aligned is changed.
		</p>
		<p class="mt-3 text-sm opacity-70" data-testid="import-review-consequence">
			This review copy <strong>“{storage.name}”</strong> is discarded once the copy has succeeded
			and you are back in {destination.name} — and only then. If anything goes wrong, it stays exactly
			as it is and you can try again.
		</p>
	</ConfirmDialog>
{/if}

{#if review !== null && storage !== null}
	<ConfirmDialog
		bind:open={confirmingDiscard}
		title="Discard this review copy"
		confirm="Discard this review copy"
		testid="confirm-discard-review"
		onconfirm={discard}
	>
		<p>
			Discard <strong>{storage.name}</strong>, the review copy holding {subject}? Everything in it
			goes: the Project, its Annotations, and the Map Images and Alignments the bundle carried. This
			cannot be undone.
		</p>
		<p class="mt-3 text-sm opacity-70" data-testid="discard-review-consequence">
			Nothing of your own is touched. The file you were sent is not changed either, so you can open
			it again; and if you want to keep this Project, Import it instead — that copies it into your
			own Workspace and discards this one afterwards.
		</p>
	</ConfirmDialog>
{/if}
