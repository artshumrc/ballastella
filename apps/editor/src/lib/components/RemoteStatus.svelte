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
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// A PLAIN LEAD, AND SIX DETERMINATIONS BEHIND ONE PRESS
	//
	// A newcomer's question is *is my work on GitHub?*, and `Changes on both sides` does not answer
	// it at a glance. So the bar leads with one plain sentence per determination and puts the
	// determination's own name and its consequence behind a disclosure.
	//
	// ⚠ **The lead is a projection of the six and never a replacement for them.** Collapsing the
	// determinations to a two-state indicator is refused: a boolean says "safe" during a Conflict and
	// during `Cannot tell`, which is the class of misreading ADR-0032 designed out when it chose *not
	// on the Front Page* over *unpublished*. The three leads that cannot promise agreement — Conflict,
	// Changes on both sides, Cannot tell — say what is true instead, and none of them reads as work
	// having reached GitHub.
	//
	// ⚠ **`REMOTE_STATUS_LEADS` and `REMOTE_STATUS_DETAILS` live here and `REMOTE_STATUS_LABELS` does
	// not.** The labels are the domain's own words and are shared, so a second surface cannot spell
	// one of them differently; these two are this bar's phrasing of them for one reader in one place,
	// and nothing else renders them.
	//
	// ⚠ **The plain words available are *GitHub* and *publish*, and nothing else.** The glossary's
	// *Publish* and *Remote* entries put the storage metaphors on their *Avoid* lists, and the reason
	// is substantive rather than stylistic: a Publish mirrors an owned namespace and removes Projects
	// the author deleted locally (ADR-0033), so it is not a copy kept somewhere safe and must not be
	// worded as one. `remote-status.dom.test.ts` holds the list and reads this surface for it.

	import {
		REMOTE_STATUS_LABELS,
		REMOTE_STATUS_UNCHECKED,
		type RemoteStatusState,
		type SourceStatus,
		type UpdateDeletionPreview
	} from '@ballastella/core';

	import Toast from '$lib/toasts/Toast.svelte';

	import ModalDialog from './ModalDialog.svelte';

	/**
	 * The Remote Status this bar renders, read under a local name.
	 *
	 * ⚠ **`state` is renamed on the way in because a variable of that name takes `$state` with it.**
	 * Svelte reads `$state` beside a declared `state` as a store subscription and refuses to compile,
	 * so nothing in this component could hold reactive state of its own while the prop kept its name.
	 */
	let {
		state: remote,
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
	 * The plain answer to *is my work on GitHub?*, one per determination.
	 *
	 * Each names GitHub, because that is the question being answered and the bar has no room to say so
	 * twice. None of the three that cannot promise agreement — `conflict`, `changes-on-both-sides`,
	 * `cannot-tell` — says the work is on GitHub, which is the whole reason a boolean was refused.
	 */
	const REMOTE_STATUS_LEADS: Record<SourceStatus, string> = {
		'up-to-date': 'Your work is on GitHub',
		'changes-to-publish': 'Not all your work is on GitHub yet',
		'update-available': 'GitHub has work this Workspace does not',
		'changes-on-both-sides': 'This Workspace and GitHub have both changed',
		conflict: 'This Workspace and GitHub disagree',
		'cannot-tell': 'Ballastella cannot say whether your work reached GitHub'
	};

	/**
	 * What the determination beside it means, and what the author can do about it.
	 *
	 * The two remedies named are the two gestures this bar already offers, Publish and Update from
	 * GitHub. Nothing here names a remedy the reader cannot reach from the screen they are on.
	 */
	const REMOTE_STATUS_DETAILS: Record<SourceStatus, string> = {
		'up-to-date':
			'Everything in this Workspace has reached GitHub, and GitHub holds nothing this Workspace does not.',
		'changes-to-publish':
			'This Workspace has changes GitHub does not have. Publish sends them to GitHub.',
		'update-available':
			'GitHub has changes this Workspace does not have. Update from GitHub brings them in.',
		'changes-on-both-sides':
			'Different files changed here and on GitHub since the two last agreed. Update from GitHub first, then Publish.',
		conflict:
			'The same file changed here and on GitHub since the two last agreed, so neither side can be brought to the other without a choice.',
		'cannot-tell':
			'There is no trustworthy record of what this Workspace and GitHub last shared, so the differences cannot be attributed to either side.'
	};

	/** What the seventh sentence means, for the reader who presses on it. */
	const UNCHECKED_DETAIL =
		'Nothing has been read from GitHub in this Workspace yet. Check Remote Status asks GitHub what it holds.';

	/**
	 * The lead, which is what the bar shows.
	 *
	 * ⚠ **`Not checked yet` is a seventh sentence and it is not one of the six.** A signed-out author
	 * has taken no reading yet, and there is no honest way to project that onto the six: `Up to date`
	 * would be a claim nothing here has made, and `Cannot tell` is a *determination* about missing
	 * evidence rather than the absence of a determination. Naming the gap is what makes the button
	 * beside it mean something — so it leads with itself rather than with a plain answer it does not
	 * have.
	 */
	const lead = $derived(
		remote.status === null ? REMOTE_STATUS_UNCHECKED : REMOTE_STATUS_LEADS[remote.status]
	);

	/** The determination, in the domain's own words, one press behind the lead. */
	const label = $derived(
		remote.status === null ? REMOTE_STATUS_UNCHECKED : REMOTE_STATUS_LABELS[remote.status]
	);

	/** The sentence behind the lead, beside the determination it explains. */
	const detail = $derived(
		remote.status === null ? UNCHECKED_DETAIL : REMOTE_STATUS_DETAILS[remote.status]
	);

	/**
	 * Whether the determination and its detail are on screen.
	 *
	 * A `<button aria-expanded>` disclosure and not `<details>`: ADR-0016 bans the `<details>`
	 * dropdown, and the WAI-ARIA disclosure button is unambiguously outside that ban.
	 */
	let detailShown = $state(false);

	/**
	 * When the determination on screen was reached, in the reader's own clock.
	 *
	 * Shown because a retained status has to be *dateable*: with the failure beside it, "Up to date"
	 * and "as of nine minutes ago" are the two halves of one honest sentence (SPEC story 118).
	 */
	const checkedAt = $derived(
		remote.at === null
			? ''
			: new Date(remote.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);

	/** Whether an Update is running, which is the one state that makes the control inert. */
	const running = $derived(update !== null);

	/**
	 * The Update button, so the dialog's focus goes back to the control that opened it (WCAG 2.4.3).
	 *
	 * A plain binding rather than `$state`: nothing renders from it, and `restoreFocusTo` reads it at
	 * the moment the dialog closes.
	 */
	let updateButton: HTMLButtonElement | undefined;
</script>

<div class="flex flex-col items-end gap-0.5" data-testid="remote-status-slot">
	<!-- `min-h-8`, matching the save indicator's leading row: the eyebrow top-aligns the two slots,
	     so the badge and its two buttons keep their centre line whatever this column grows below it. -->
	<div class="flex min-h-8 items-center gap-2">
		<!--
			The plain answer and the progress, in one polite region.

			Together rather than in two, because they are one sentence about one thing: a screen reader
			hearing "Checking…" from one region and "Your work is on GitHub" from another has to work out
			which of them is now true. `aria-atomic` so the whole line is re-read rather than only the
			words that changed — "Checking…" on its own says nothing about what is being checked.

			The lead names GitHub itself, so there is no eyebrow in front of it repeating the word.
		-->
		<p
			aria-live="polite"
			aria-atomic="true"
			class="badge gap-1.5 badge-sm font-medium whitespace-nowrap shadow-sm"
			class:badge-success={remote.status === 'up-to-date' && remote.failure === ''}
			class:badge-warning={remote.status !== 'up-to-date' || remote.failure !== ''}
			data-remote-status={remote.status ?? 'unchecked'}
			data-testid="remote-status-state"
		>
			{lead}{#if remote.checking}&nbsp;· Checking…{:else if remote.failure}&nbsp;· Check failed{/if}
		</p>
		<!--
			The one press between the lead and the six (SPEC story 42).

			Not `title`, not a tooltip: daisyUI renders those through CSS `::before`, so they are neither
			announced nor dismissable (ADR-0016). `aria-controls` binds the button to the panel below the
			row rather than beside it, because a badge is not a container for two sentences.
		-->
		<button
			type="button"
			class="btn btn-ghost btn-xs"
			aria-expanded={detailShown}
			aria-controls="remote-status-detail"
			data-testid="remote-status-explain"
			onclick={() => (detailShown = !detailShown)}
		>
			{detailShown ? 'Hide what this means' : 'What this means'}
		</button>
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
			class:btn-disabled={remote.checking}
			aria-disabled={remote.checking}
			data-testid="check-remote-status"
			onclick={() => {
				if (!remote.checking) onCheck();
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

	<!--
		The determination and its consequence, which the lead above is a projection of.

		⚠ **Not in the live region.** It appears because the reader pressed for it, and a polite region
		that grew two sentences on a press would re-read the whole status to say something the reader
		is already looking at.
	-->
	{#if detailShown}
		<div
			id="remote-status-detail"
			class="max-w-72 rounded-box bg-base-200 px-3 py-2 text-right"
			data-testid="remote-status-detail"
		>
			<p class="text-sm font-medium" data-testid="remote-status-determination">{label}</p>
			<p class="text-xs opacity-70">{detail}</p>
		</div>
	{/if}

	{#if checkedAt !== ''}
		<p class="text-xs text-base-content opacity-70" data-testid="remote-status-checked">
			Checked at {checkedAt}
		</p>
	{/if}

	<!--
		What an Update is doing (SPEC stories 121–124).

		Polite and `aria-atomic`, for the reason the determination above is: "412 of 900 files" on its
		own says nothing about what is being counted, and a screen reader hearing the count change
		without the sentence around it has to work out which transfer it belongs to.

		In the bar rather than in the toast stack, and it is the one line here that stays: it is not
		news to be read and put away but the state of something running, it disappears of its own
		accord when the transfer ends, and a reader who dismissed it would have no way to get it back.
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
</div>

<!--
	What the Update did, why it did not happen, why the status on screen is no longer being confirmed,
	and whether the Published Site was built from other files — as messages the reader can put away.

	**Out of the bar, and none of them is the determination.** The badge above says what Ballastella
	last worked out and stays; each of these is news about a gesture or a reading, and four sentences
	stacked under the eyebrow pushed the work down the screen with nothing on them to say "read, thank
	you". Their words, their roles and their remedies are unchanged.

	⚠ **`refusal` on the two that are refusals**, which are inserted at the moment their text first
	exists — a polite region does not reliably announce that (ADR-0016's amendment), and a refusal
	nobody hears is an author who believes the Remote's changes are now in their Workspace. The
	`remote-status-failure` alert also leaves the determination beside it exactly as it was: a network
	failure, an expired credential or a spent hourly budget is not agreement, and reported as `Up to
	date` it is the one reading that licenses publishing over somebody else's work (SPEC story 118).

	⚠ **Published Site staleness is never one of the six** (SPEC story 120, ADR-0033). A site built by
	another editor version has different chunk names, so this is routinely true of a Workspace whose
	scholarship agrees with its Remote exactly. What it means is "republish when you like", which is
	why it is its own sentence with its own remedy and why it is a note rather than a warning.
-->
<Toast text={notice} testid="update-outcome" tone="info" />
<Toast text={failure} testid="update-failure" refusal />
<Toast text={remote.failure} testid="remote-status-failure" refusal />
<Toast
	text={remote.publishedSiteStale.length === 0
		? ''
		: `The Published Site was built from different files (${remote.publishedSiteStale.length} ` +
			`${remote.publishedSiteStale.length === 1 ? 'file' : 'files'} differ). Publish again to rebuild it.`}
	testid="published-site-stale"
	tone="info"
/>

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
