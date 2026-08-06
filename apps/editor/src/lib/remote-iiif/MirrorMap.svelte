<script lang="ts">
	// "Make an offline copy" for one referenced Historical Map (SPEC stories 27 and 28, ADR-0007).
	//
	// The dialog exists because of one sentence in ADR-0007: the decision must not be made implicitly by
	// a button labelled only "Download". So the button opens a modal that says three things before
	// anything is fetched — what the library said about rights, what the copy costs the library, and what
	// it costs this Workspace against ADR-0008's ~1 GB budget — and the copy starts only when the user
	// says so a second time.
	//
	// `<dialog>` through {@link ModalDialog}, per ADR-0016: `showModal()` brings Escape, the focus trap,
	// and focus restoration, and that decision is made once in that component rather than per slice.
	//
	// **Everything from the remote document is interpolated as text, never `{@html}`, and the rights URI
	// is not a link.** A `rights` value is a stranger's string, and ticket 14 found that a Manifest
	// declaring `"rights": "javascript:…"` would have become a clickable link — Svelte escapes
	// interpolation but does not sanitise `href`. Shown as text, that whole class of thing is inert.

	import type { ReferencedImage } from '@ballastella/core';

	import ModalDialog from '$lib/components/ModalDialog.svelte';

	import type { MirrorMap } from './mirror-map.svelte.js';

	let { image, job }: { image: ReferencedImage; job: MirrorMap } = $props();

	/** Whether this row's dialog is the open one. One job, and therefore one dialog, for the whole list. */
	const mine = $derived(job.image?.imageId === image.imageId);
	const plan = $derived(mine ? job.plan : null);

	// `void` rather than `await`: the handler returns synchronously so the dialog opens in the frame the
	// button was pressed, and `prepare` fills it in as its one request resolves.
	const open = () => void job.prepare(image);
</script>

<button
	class="btn btn-sm"
	type="button"
	data-testid="mirror-open"
	disabled={job.busy}
	onclick={open}
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
			Served by <code data-testid="mirror-host">{new URL(image.service).hostname}</code>
		</p>

		<!--
			ADR-0007: the library's own rights statement, at the moment the user chooses to copy — long
			after the Manifest was navigated away from, which is why ticket 14 wrote both fields into
			`remote.json` at add time. Absent is said rather than left blank, because "this library
			published nothing about rights" is a different fact from "nobody has looked", and only one of
			them means the scholar has to go and find out.
		-->
		<dl class="mt-4 text-sm" data-testid="mirror-rights">
			<dt class="font-medium">Rights</dt>
			<dd class="break-all">
				{image.rights || 'This library published no rights statement for this image.'}
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
				<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
					<p data-testid="mirror-refusal">{plan.refusal}</p>
				</div>
			{:else}
				<p class="mt-4 text-sm" data-testid="mirror-size">{job.sizeSummary}</p>

				<!--
					The politeness obligation, and anything else that has to be said before the copy starts.
					`alert-info`: neither is a fault, and the ticket is explicit that none of this is a gate.
				-->
				{#each plan.notes as note (note)}
					<div class="mt-4 alert max-w-prose alert-info" data-testid="mirror-note">
						<p>{note}</p>
					</div>
				{/each}

				{#if job.hostingWarning}
					<div class="mt-4 alert max-w-prose alert-warning" data-testid="mirror-hosting-warning">
						<p>{job.hostingWarning}</p>
					</div>
				{/if}
			{/if}
		{/if}

		{#if job.error}
			<div role="alert" class="mt-4 alert max-w-prose flex-col items-start alert-warning">
				<p data-testid="mirror-error">{job.error}</p>
			</div>
		{/if}

		<!--
			`aria-live` rather than `role="status"`, the choice every other progress region in this app
			makes: the save indicator already owns that role on this page, and two of them make
			`getByRole('status')` ambiguous for a test and for a screen reader alike. `aria-atomic` so each
			update is read as a sentence rather than as the digits that changed, and the sentence carries
			the same numbers the bar does.
		-->
		<div aria-live="polite" aria-atomic="true" class="mt-4 min-h-6">
			{#if job.progress}
				<p class="text-sm" data-testid="mirror-progress">{job.progressMessage}</p>
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
					class="btn btn-sm"
					type="button"
					data-testid="mirror-cancel"
					onclick={() => job.cancel()}
				>
					Cancel the copy
				</button>
			{:else}
				<button
					class="btn btn-sm"
					type="button"
					data-testid="mirror-dismiss"
					onclick={() => job.dismiss()}
				>
					Not now
				</button>
				<button
					class="btn btn-primary btn-sm"
					type="button"
					data-testid="mirror-start"
					disabled={!plan || plan.refusal !== '' || job.step === 'preparing'}
					onclick={() => job.start()}
				>
					Copy it into this Project
				</button>
			{/if}
		{/snippet}
	</ModalDialog>
{/if}
