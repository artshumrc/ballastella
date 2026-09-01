<script lang="ts">
	// Whether GitHub agrees with this Workspace, in words, on every screen (ADR-0038).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ONE BADGE, TWO CLAUSES, AND EVERYTHING ELSE ONE PRESS AWAY (ADR-0041)
	//
	// The bar answers *where is my work* once. `WhereYourWorkIs` is that badge and owns the bar's one
	// `role="status"`; this supplies its GitHub clause, and holds the determination, the sentence, the
	// time of the reading, the Baseline and the two gestures behind the disclosure beside it.
	//
	// ⚠ **The two clauses are always both present and never collapse into one word.** *Is my edit kept
	// on this machine* and *does GitHub hold it too* are different questions with different remedies,
	// and conflating them is how a scholar comes to believe a saved edit is a published one. The rule
	// is kept in the text, where it does the work, rather than in two badges side by side, where it
	// only cost height.
	//
	// ⚠ **The check and the Update are not here: they are behind the door** (ADR-0041). An Update is
	// the only way Remote work reaches a Workspace and an explicit check is the only status a
	// signed-out author can get, so they moved rather than went — to the one surface that holds the
	// whole GitHub relationship, beside the Publish they must never be merged with. What stays here is
	// what an Update *says*: its progress, its outcome and its refusals, and the question it stops to
	// ask before it removes anything.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE MEANING IS IN THE TEXT
	//
	// Never a colour, never an icon, never a disabled button. Every one of the six determinations is a
	// sentence from `REMOTE_STATUS_LABELS`, the failure is a sentence, and the staleness notice is a
	// sentence. `data-remote-status` exists for a spec to read and carries nothing a user needs. The
	// badge's tint and mark say nothing the two clauses do not, and follow the whole badge rather than
	// either half of it — see `WhereYourWorkIs`.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// A PLAIN CLAUSE, AND SIX DETERMINATIONS BEHIND ONE PRESS
	//
	// A newcomer's question is *is my work on GitHub?*, and `Changes on both sides` does not answer
	// it at a glance. So the badge carries one plain sentence per determination and puts the
	// determination's own name and its consequence behind a disclosure.
	//
	// ⚠ **The clause is a projection of the six and never a replacement for them.** Collapsing the
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
		type SaveState,
		type SourceStatus,
		type SynchronizationBaseline,
		type UpdateDeletionPreview
	} from '@ballastella/core';

	import Toast from '$lib/toasts/Toast.svelte';

	import ModalDialog from './ModalDialog.svelte';
	import WhereYourWorkIs from './WhereYourWorkIs.svelte';

	/**
	 * The Remote Status this bar renders, read under a local name.
	 *
	 * ⚠ **`state` is renamed on the way in because a variable of that name takes `$state` with it.**
	 * Svelte reads `$state` beside a declared `state` as a store subscription and refuses to compile,
	 * so nothing in this component could hold reactive state of its own while the prop kept its name.
	 */
	let {
		saveState,
		state: remote,
		baseline,
		update,
		notice,
		failure,
		deletionPreview,
		onAnswerDeletions,
		restoreFocusTo
	}: {
		/** The local clause of the one badge, passed straight through. */
		saveState: SaveState;
		state: RemoteStatusState;
		/** What this Workspace and GitHub last agreed on, or `null` when nothing here knows. */
		baseline: SynchronizationBaseline | null;
		/** An Update in flight, as files done out of files planned, or `null` for none. */
		update: { files: number; totalFiles: number } | null;
		/** What the last Update did, or `''`. */
		notice: string;
		/** Why the last Update did not happen, or `''`. */
		failure: string;
		/** What the Update in flight would remove, while it waits to be told. */
		deletionPreview: UpdateDeletionPreview | null;
		/** Answer that question. `false` for every way of not saying yes. */
		onAnswerDeletions: (confirmed: boolean) => void;
		/**
		 * Where focus goes if the control that started the Update is no longer in the document.
		 *
		 * The bar's door control, which is what the Update was pressed from — the door closes on that
		 * press, so by the time this question arrives focus is already back on it and this is the
		 * fallback rather than the ordinary path.
		 */
		restoreFocusTo?: () => HTMLElement | null | undefined;
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

	/**
	 * The seventh clause, which is the absence of a determination rather than one of the six.
	 *
	 * ⚠ **It names GitHub like the other six, and the determination behind the press does not.** The
	 * badge's GitHub clause is always about GitHub, so a reader scanning one line never has to work out
	 * which half of it a bare "Not checked yet" belonged to; `REMOTE_STATUS_UNCHECKED` is the domain's
	 * own seventh sentence and is what the disclosure states, unchanged.
	 */
	const UNCHECKED_LEAD = 'GitHub has not been checked yet';

	/** What the seventh sentence means, for the reader who presses on it. */
	const UNCHECKED_DETAIL =
		'Nothing has been read from GitHub in this Workspace yet. Check Remote Status asks GitHub what it holds.';

	/**
	 * The lead, which is the GitHub half of the badge.
	 *
	 * ⚠ **`Not checked yet` is a seventh sentence and it is not one of the six.** A signed-out author
	 * has taken no reading yet, and there is no honest way to project that onto the six: `Up to date`
	 * would be a claim nothing here has made, and `Cannot tell` is a *determination* about missing
	 * evidence rather than the absence of a determination. Naming the gap is what makes the button
	 * beside it mean something — so it leads with itself rather than with a plain answer it does not
	 * have.
	 */
	const lead = $derived(
		remote.status === null ? UNCHECKED_LEAD : REMOTE_STATUS_LEADS[remote.status]
	);

	/**
	 * The clause the badge carries, with what is happening to it now.
	 *
	 * ⚠ **A check in flight or a check that failed is said *beside* the determination, never instead
	 * of it.** A network failure, an expired credential or a spent hourly budget is not agreement, and
	 * reported as `Up to date` it is the one reading that licenses publishing over somebody else's
	 * work. The sentence saying which of those it was is in the stack, where it can be put away.
	 */
	const clause = $derived(
		remote.checking
			? `${lead} · Checking…`
			: remote.failure === ''
				? lead
				: `${lead} · Check failed`
	);

	/** Whether GitHub holds this Workspace's work, on the last reading that completed. */
	const agreeing = $derived(remote.status === 'up-to-date' && remote.failure === '');

	/** The determination, in the domain's own words, one press behind the badge. */
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

	/** When the determination on screen was reached, in the reader's own clock. */
	const checkedAt = $derived(
		remote.at === null
			? ''
			: new Date(remote.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
	);
</script>

<div class="flex flex-col items-end gap-0.5" data-testid="remote-status-slot">
	<!-- `min-h-8`: the eyebrow top-aligns its clusters, so the badge and its disclosure keep their
	     centre line whatever this column grows below them. -->
	<div class="flex min-h-8 items-center gap-2">
		<!--
			The one badge, and the bar's one `role="status"`.

			Both clauses in one region and one element, so a screen reader hears them as one line rather
			than working out which of two regions is now true — `WhereYourWorkIs` holds the reasoning and
			`aria-atomic`.
		-->
		<WhereYourWorkIs
			{saveState}
			github={clause}
			determination={remote.status ?? 'unchecked'}
			{agreeing}
		/>
		<!--
			The one press between the badge and everything behind it.

			Not `title`, not a tooltip: daisyUI renders those through CSS `::before`, so they are neither
			announced nor dismissable (ADR-0016). `aria-controls` binds the button to the panel below the
			row rather than beside it, because a badge is not a container for four lines and two buttons.
		-->
		<button
			type="button"
			class="btn btn-outline btn-xs"
			aria-expanded={detailShown}
			aria-controls="remote-status-detail"
			data-testid="remote-status-explain"
			onclick={() => (detailShown = !detailShown)}
		>
			{detailShown ? 'Hide what this means' : 'What this means'}
		</button>
	</div>

	<!--
		The determination, what it means, when it was read and what the two sides last agreed on — in
		that order, because each line explains the one above it. What to *do* about any of it is behind
		the door (ADR-0041); this panel is the reading, and the reading alone.

		⚠ **Not in the live region.** It appears because the reader pressed for it, and a polite region
		that grew four sentences on a press would re-read the whole status to say something the reader
		is already looking at.
	-->
	{#if detailShown}
		<div
			id="remote-status-detail"
			class="max-w-80 rounded-box bg-base-200 px-3 py-2 text-right shadow-lg"
			data-testid="remote-status-detail"
		>
			<p class="text-sm font-medium" data-testid="remote-status-determination">{label}</p>
			<p class="text-xs opacity-70">{detail}</p>
			<!--
				When the determination on screen was reached, in the reader's own clock.

				Here rather than in the bar because a retained status has to be *dateable* without costing
				the eyebrow a second line: with the failure beside it, "Up to date" and "as of nine minutes
				ago" are the two halves of one honest sentence, and both are one press away together.
			-->
			{#if checkedAt !== ''}
				<p class="mt-1 text-xs opacity-70" data-testid="remote-status-checked">
					Checked at {checkedAt}
				</p>
			{/if}
			<!--
				What the two sides last agreed on, beside the determination it explains.

				⚠ **Absent rather than hedged when there is no record**, because `Cannot tell` is the
				determination above and stating it twice in two vocabularies is how a reader comes to think
				they are two facts.
			-->
			{#if baseline !== null}
				<p class="mt-1 text-xs opacity-70" data-testid="remote-status-baseline">
					Last agreed with GitHub at commit <code>{baseline.commit}</code>, over
					{baseline.files.size}
					{baseline.files.size === 1 ? 'file' : 'files'}.
				</p>
			{/if}
		</div>
	{/if}

	<!--
		What an Update is doing.

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
	date` it is the one reading that licenses publishing over somebody else's work.

	⚠ **Published Site staleness is never one of the six** (ADR-0033). A site built by another editor
	version has different chunk names, so this is routinely true of a Workspace whose scholarship agrees
	with its Remote exactly. What it means is "republish when you like", which is why it is its own
	sentence with its own remedy and why it is a note rather than a warning.
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
	What the Update would remove, before it removes any of it.

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
	{restoreFocusTo}
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
