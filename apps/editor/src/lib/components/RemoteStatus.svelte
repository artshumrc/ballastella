<script lang="ts">
	// Whether GitHub agrees with this Workspace, in words, on every screen (ticket 12, ADR-0038).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// NOT THE SAVE INDICATOR, AND THAT SEPARATION IS THE WHOLE POINT
	//
	// `SaveIndicator` answers *is my edit kept on this machine* and owns this bar's one `role="status"`.
	// This answers *does GitHub hold it too*, which is a different question with a different remedy —
	// and SPEC story 111 is that conflating them is how a scholar comes to believe a saved edit is a
	// published one. So this is its own region, with its own words, beside rather than inside that one:
	// a live region without `role="status"`, for the reason the bar's other announcements are
	// (`getByRole('status')` must stay unambiguous, which is a hint that a screen-reader user would
	// otherwise have to disambiguate too).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE MEANING IS IN THE TEXT
	//
	// SPEC story 147: never a colour, never an icon, never a disabled button. Every one of the six
	// determinations is a sentence from `REMOTE_STATUS_LABELS`, the failure is a sentence, and the
	// staleness notice is a sentence. `data-remote-status` exists for a spec to read and carries
	// nothing a user needs.

	import {
		REMOTE_STATUS_LABELS,
		REMOTE_STATUS_UNCHECKED,
		type RemoteStatusState,
		type UpdateDeletionPreview
	} from '@ballastella/core';

	import ModalDialog from './ModalDialog.svelte';

	let {
		state,
		onCheck,
		update,
		notice,
		failure,
		onUpdate,
		deletionPreview,
		onAnswerDeletions
	}: {
		state: RemoteStatusState;
		/** Check now, because the author asked. Never throttled — see `RemoteStatusChecker`. */
		onCheck: () => void;
		/** An Update in flight, as files done out of files planned, or `null` for none. */
		update: { files: number; totalFiles: number } | null;
		/** What the last Update did, or `''`. */
		notice: string;
		/** Why the last Update did not happen, or `''`. */
		failure: string;
		/** Bring the Remote's changes in, because the author asked (SPEC story 121). */
		onUpdate: () => void;
		/** What the Update in flight would remove, while it waits to be told (SPEC story 126). */
		deletionPreview: UpdateDeletionPreview | null;
		/** Answer that question. `false` for every way of not saying yes (SPEC story 127). */
		onAnswerDeletions: (confirmed: boolean) => void;
	} = $props();

	/**
	 * The determination, in words.
	 *
	 * ⚠ **`Not checked yet` is a seventh sentence and it is not one of the six.** A signed-out author
	 * has taken no reading yet, and there is no honest way to project that onto the six: `Up to date`
	 * would be a claim nothing here has made, and `Cannot tell` is a *determination* about missing
	 * evidence rather than the absence of a determination. Naming the gap is what makes the button
	 * beside it mean something.
	 */
	const label = $derived(
		state.status === null ? REMOTE_STATUS_UNCHECKED : REMOTE_STATUS_LABELS[state.status]
	);

	/**
	 * When the determination on screen was reached, in the reader's own clock.
	 *
	 * Shown because a retained status has to be *dateable*: with the failure beside it, "Up to date"
	 * and "as of nine minutes ago" are the two halves of one honest sentence (SPEC story 118).
	 */
	const checkedAt = $derived(
		state.at === null
			? ''
			: new Date(state.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);

	/** Whether an Update is running, which is the one state that makes the control inert. */
	const running = $derived(update !== null);

	/**
	 * The Update button, so the dialog's focus goes back to the control that opened it (WCAG 2.4.3).
	 *
	 * A plain binding rather than `$state`: nothing renders from it, and `restoreFocusTo` reads it at
	 * the moment the dialog closes. (`$state` is also unavailable here — the `state` prop above shadows
	 * the rune's name.)
	 */
	let updateButton: HTMLButtonElement | undefined;
</script>

<div class="flex flex-col items-end gap-0.5" data-testid="remote-status-slot">
	<div class="flex items-center gap-2">
		<!--
			The determination and the progress, in one polite region.

			Together rather than in two, because they are one sentence about one thing: a screen reader
			hearing "Checking…" from one region and "Up to date" from another has to work out which of
			them is now true. `aria-atomic` so the whole line is re-read rather than only the words that
			changed — "Checking…" on its own says nothing about what is being checked.
		-->
		<p
			aria-live="polite"
			aria-atomic="true"
			class="badge gap-1.5 badge-sm font-medium whitespace-nowrap shadow-sm"
			class:badge-success={state.status === 'up-to-date' && state.failure === ''}
			class:badge-warning={state.status !== 'up-to-date' || state.failure !== ''}
			data-remote-status={state.status ?? 'unchecked'}
			data-testid="remote-status-state"
		>
			<span class="opacity-70">GitHub:</span>
			{label}{#if state.checking}&nbsp;· Checking…{:else if state.failure}&nbsp;· Check failed{/if}
		</p>
		<!--
			The explicit check (SPEC story 115).

			**Always offered, not only while signed out.** Signed out it is the *only* way to a status —
			automatic anonymous polling is ruled out by GitHub's sixty-an-hour anonymous budget, which a
			shared campus address spends between everybody on it. Signed in it is still the answer to "has
			anything changed *now*", and keeping it mounted in both states is also what keeps focus
			predictable: a button that vanished on sign-in would drop a keyboard user to `<body>` (WCAG
			2.4.3).

			`aria-disabled` and never `disabled`, for the reason Publish uses the same: a `disabled`
			button leaves the tab order the instant it is pressed.
		-->
		<button
			type="button"
			class="btn btn-xs"
			class:btn-disabled={state.checking}
			aria-disabled={state.checking}
			data-testid="check-remote-status"
			onclick={() => {
				if (!state.checking) onCheck();
			}}
		>
			Check Remote Status
		</button>
		<!--
			The inbound half, and the *only* way Remote work reaches a Workspace (SPEC story 121).

			**Always offered, and never armed by a status.** An Update is refused with a sentence when
			there is nothing to take and when a path changed on both sides, and it stops to ask when the
			Remote has deleted something — so hiding or disabling it against the last determination would
			replace legible refusals and one real question with a control that does nothing and says
			nothing about why. It is also the reason a status check never applies anything: the two
			gestures are separate because their consequences are.

			`aria-disabled` and never `disabled`, for the reason the check beside it uses the same: a
			`disabled` button leaves the tab order the instant it is pressed.
		-->
		<button
			bind:this={updateButton}
			type="button"
			class="btn btn-xs"
			class:btn-disabled={running}
			aria-disabled={running}
			data-testid="update-from-github"
			onclick={() => {
				if (!running) onUpdate();
			}}
		>
			Update from GitHub
		</button>
	</div>

	{#if checkedAt !== ''}
		<p class="text-xs text-base-content opacity-70" data-testid="remote-status-checked">
			Checked at {checkedAt}
		</p>
	{/if}

	<!--
		What an Update is doing, and what it did (SPEC stories 121–124).

		Polite and `aria-atomic`, for the reason the determination above is: "412 of 900 files" on its
		own says nothing about what is being counted, and a screen reader hearing the count change
		without the sentence around it has to work out which transfer it belongs to.
	-->
	{#if update !== null}
		<p
			aria-live="polite"
			aria-atomic="true"
			class="text-xs text-base-content opacity-70"
			data-testid="update-progress"
		>
			Updating from GitHub: {update.files} of {update.totalFiles}
			{update.totalFiles === 1 ? 'file' : 'files'}.
		</p>
	{/if}

	{#if notice}
		<p aria-live="polite" class="max-w-md text-sm text-base-content" data-testid="update-outcome">
			{notice}
		</p>
	{/if}

	<!--
		Why the Update did not happen.

		`role="alert"`, and for the reason the check's failure above it is: it is inserted at the
		moment its text first exists, which a polite region does not reliably announce — and a refusal
		nobody hears is an author who believes the Remote's changes are now in their Workspace.
	-->
	{#if failure}
		<p role="alert" class="max-w-md text-sm text-warning" data-testid="update-failure">
			{failure}
		</p>
	{/if}

	<!--
		Why the current status is not current (SPEC story 118).

		⚠ **`role="alert"`, and the status above it is left exactly as it was.** A network failure, an
		expired credential or a spent hourly budget is not agreement — reported as `Up to date` it is
		the one reading that licenses publishing over somebody else's work. So the last determination
		stays, dated, and this says out loud that it is no longer being confirmed. `alert` rather than
		a polite region because it is inserted at the moment its text first exists, which a polite
		region does not reliably announce — the same rule `save-error` follows.
	-->
	{#if state.failure}
		<p role="alert" class="max-w-md text-sm text-warning" data-testid="remote-status-failure">
			{state.failure}
		</p>
	{/if}

	<!--
		Published Site staleness, and **never** one of the six (SPEC story 120, ADR-0033).

		A site built by another editor version has different chunk names, so this is routinely true of
		a Workspace whose scholarship agrees with its Remote exactly. Folded into the source status it
		would read as "somebody changed your work" and would never stop reading that way: two editor
		versions synchronizing would trade obsolete bundles for ever. What it actually means is
		"republish when you like", so it is its own sentence with its own remedy.
	-->
	{#if state.publishedSiteStale.length > 0}
		<p
			aria-live="polite"
			class="max-w-md text-xs text-base-content opacity-70"
			data-testid="published-site-stale"
		>
			The Published Site was built from different files ({state.publishedSiteStale.length}
			{state.publishedSiteStale.length === 1 ? 'file' : 'files'} differ). Publish again to rebuild it.
		</p>
	{/if}
</div>

<!--
	What the Update would remove, before it removes any of it (SPEC stories 126, 127).

	⚠ **A modal, and it has to be.** This is the last point at which the answer is still no, and the
	rest of the application — the Project links behind it, the Publish button, the Workspace switcher —
	is all things whose consequences the author has not yet been asked about. `ModalDialog` brings the
	focus trap, Escape and focus restoration with it (ADR-0016), and restoration lands on the Update
	button that opened it, which is where a keyboard user expects to be put back.

	⚠ **Every way out that is not the confirm button answers `false`.** Escape, the backdrop and
	Cancel all mean the same thing, and the transfer is waiting on an answer — so a route out that
	settled nothing would leave the Update running for ever behind a dialog that has gone.

	⚠ **Mounted whatever the answer is, and never inside an `{#if}`.** `ModalDialog` closes the native
	`<dialog>` and restores focus from an effect on `open`; unmounted at the moment of the answer it
	never runs either, the element leaves the document while it is still the top layer, and a keyboard
	user is dropped on `<body>` — which is exactly the restoration this dialog was given
	`restoreFocusTo` for. `editor-remote-conflict.e2e.ts` asserts where the answer leaves focus, so
	wrapping this in an `{#if}` fails there rather than only in a screen reader.

	The Projects and Map Images are named, not counted: "3 files will be removed" is not a question
	anybody can answer, and the whole reason `UpdateDeletionPreview` exists is that "the Project
	*Amsterdam 1625*" is.
-->
<ModalDialog
	bind:open={() => deletionPreview !== null, (open) => !open && onAnswerDeletions(false)}
	title="Update will remove work from this Workspace"
	restoreFocusTo={() => updateButton}
>
	{#if deletionPreview !== null}
		<p data-testid="deletion-preview-message">{deletionPreview.message}</p>

		{#if deletionPreview.projects.length > 0}
			<h3 class="mt-4 font-semibold">
				{deletionPreview.projects.length === 1 ? 'Project' : 'Projects'} that will be removed
			</h3>
			<ul class="list-disc pl-6" data-testid="deletion-preview-projects">
				{#each deletionPreview.projects as project (project.directory)}
					<li>{project.name} <span class="opacity-70">({project.directory})</span></li>
				{/each}
			</ul>
		{/if}

		{#if deletionPreview.mapImages.length > 0}
			<h3 class="mt-4 font-semibold">
				{deletionPreview.mapImages.length === 1 ? 'Map Image' : 'Map Images'} that will be removed
			</h3>
			<ul class="list-disc pl-6" data-testid="deletion-preview-map-images">
				{#each deletionPreview.mapImages as imageId (imageId)}
					<li>{imageId}</li>
				{/each}
			</ul>
		{/if}

		{#if deletionPreview.remaining.length > 0}
			<h3 class="mt-4 font-semibold">
				And {deletionPreview.remaining.length}
				other {deletionPreview.remaining.length === 1 ? 'file' : 'files'}
			</h3>
			<ul class="list-disc pl-6 text-sm" data-testid="deletion-preview-remaining">
				{#each deletionPreview.remaining as path (path)}
					<li>{path}</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#snippet actions()}
		<button
			type="button"
			class="btn btn-sm"
			data-testid="cancel-deletions"
			onclick={() => onAnswerDeletions(false)}
		>
			Cancel
		</button>
		<button
			type="button"
			class="btn btn-error btn-sm"
			data-testid="confirm-deletions"
			onclick={() => onAnswerDeletions(true)}
		>
			Remove them and update
		</button>
	{/snippet}
</ModalDialog>
