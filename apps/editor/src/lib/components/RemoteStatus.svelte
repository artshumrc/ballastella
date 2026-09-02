<script lang="ts">
	// Whether GitHub agrees with this Workspace, in words, on every screen (ADR-0044).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ONE BADGE, TWO CLAUSES, AND EVERYTHING ELSE ONE PRESS AWAY (ADR-0044)
	//
	// The bar answers *where is my work* once. `WhereYourWorkIs` is that badge and owns the bar's one
	// `role="status"`; this supplies its GitHub clause, and holds the determination, the sentence, the
	// time of the reading and the Baseline behind the disclosure beside it.
	//
	// ⚠ **The two clauses are always both present and never collapse into one word.** *Is my edit kept
	// on this machine* and *does GitHub hold it too* are different questions with different remedies,
	// and conflating them is how a scholar comes to believe a saved edit is a sent one. The rule is
	// kept in the text, where it does the work, rather than in two badges side by side, where it only
	// cost height.
	//
	// ⚠ **The check and the transfer are not here: they are on the Sync modal** (ADR-0044).
	// Getting is the only way Remote work reaches a Workspace and an explicit check is the only status a
	// signed-out author can get, so they moved rather than went — to the Sync modal, which reads both
	// sides and shows what it found before it moves a byte. What stays here is what a get *says*: its
	// progress, its outcome and its refusals.
	//
	// ⚠ **And no deletion confirmation, because there is nothing left to confirm** (ADR-0044). Every
	// removal either side would suffer is named on the Sync modal the author read before pressing, so
	// a question raised from here would be the second asking of one already answered.
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
	// A DIRECTION ON THE BADGE, THE DETERMINATION BEHIND ONE PRESS
	//
	// The scholar's question is *is my work anywhere but this machine?*, and the only answer they can
	// act on is which direction has something outstanding in it. So the clause says that — to send, to
	// get, both ways, or nothing — and the determination's own name, the reading's time and the
	// Baseline's commit sit behind a disclosure.
	//
	// ⚠ **The repository is named in the agreeing clause and nowhere else** (ADR-0044). A name beside
	// a state that is not agreement reports an intention rather than a fact, and the whole value of
	// seeing it is that it is a fact — the bar reading *Synced with `owner/repo`* the moment a
	// repository was connected, before a byte had moved, is what this replaces.
	//
	// ⚠ **A Conflict reads as the both-directions row it is.** There is genuinely work outstanding in
	// both directions, and which file the two sides contest is the determination's business rather
	// than the badge's. What the clause may never do is promise agreement.
	//
	// ⚠ **`remoteStatusClauses` and `REMOTE_STATUS_DETAILS` live here and `REMOTE_STATUS_LABELS`
	// does not.** The labels are the domain's own words and are shared, so a second surface cannot
	// spell one of them differently; these two are this bar's phrasing of them for one reader in one
	// place, and nothing else renders them.
	//
	// ⚠ **Git's vocabulary is not available here, and neither is *connected*.** `ahead` and `behind`
	// name positions in a commit graph a scholar never opens, and being connected is not an
	// achievement: it says a repository was chosen, not that any work reached it.
	// `remote-status.dom.test.ts` holds the list and reads this surface for it.

	import {
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

	/**
	 * The Remote Status this bar renders, read under a local name.
	 *
	 * ⚠ **`state` is renamed on the way in because a variable of that name takes `$state` with it.**
	 * Svelte reads `$state` beside a declared `state` as a store subscription and refuses to compile,
	 * so nothing in this component could hold reactive state of its own while the prop kept its name.
	 */
	let {
		saveState,
		remote: repository,
		state: remote,
		baseline,
		update,
		notice,
		failure
	}: {
		/** The local clause of the one badge, passed straight through. */
		saveState: SaveState;
		/**
		 * The repository this Workspace syncs with.
		 *
		 * Named on the badge only where the two sides agree, which is why it is a prop rather than
		 * read off {@link baseline}: a Baseline is absent in exactly the state that must not name one.
		 */
		remote: RemoteRepository;
		state: RemoteStatusState;
		/** What this Workspace and GitHub last agreed on, or `null` when nothing here knows. */
		baseline: SynchronizationBaseline | null;
		/** An Update in flight, as files done out of files planned, or `null` for none. */
		update: { files: number; totalFiles: number } | null;
		/** What the last Update did, or `''`. */
		notice: string;
		/** Why the last Update did not happen, or `''`. */
		failure: string;
	} = $props();

	/**
	 * Which direction has something outstanding in it, one per determination.
	 *
	 * ⚠ **Only the agreeing clause names the repository**, and it is the only one that can: the other
	 * four report a difference, and a repository named beside a difference says the Workspace was
	 * pointed at it rather than that any work reached it (ADR-0044).
	 *
	 * ⚠ **There is no clause for a Conflict, because there is no such determination** (ADR-0046). One
	 * file changed on both sides is work outstanding in both directions, which `changes both ways`
	 * already says; what the Sync does about it — a second copy, or one question — is on the modal
	 * that is one press away.
	 */
	const remoteStatusClauses: Record<SourceStatus, string> = $derived({
		'in-sync': `in sync with ${describeRemote(repository)}`,
		'changes-to-send': 'changes to send',
		'changes-to-get': 'changes to get',
		'changes-both-ways': 'changes both ways',
		'cannot-tell': "can't tell what's on GitHub"
	});

	/**
	 * What the determination beside it means, and what the author can do about it.
	 *
	 * The remedy named is the one gesture the bar offers, which is Sync. Nothing here names a remedy
	 * the reader cannot reach from the screen they are on.
	 */
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

	/**
	 * The sixth clause, which is the absence of a determination rather than one of the five.
	 *
	 * ⚠ **It is not one of the five and must not be projected onto them.** A signed-out author has
	 * taken no reading yet: `in sync` would be a claim nothing here has made, and `Cannot tell` is a
	 * *determination* about missing evidence rather than the absence of a determination. Naming the
	 * gap is what makes the Sync control beside it mean something.
	 */
	const UNCHECKED_CLAUSE = 'not checked yet';

	/** What the sixth sentence means, for the reader who presses on it. */
	const UNCHECKED_DETAIL =
		'Nothing has been read from GitHub in this Workspace yet. Sync reads both sides and says what it found.';

	/** The GitHub half of the badge, which is the one this component supplies. */
	const github = $derived(
		remote.status === null ? UNCHECKED_CLAUSE : remoteStatusClauses[remote.status]
	);

	/**
	 * The clause the badge carries, with what is happening to it now.
	 *
	 * ⚠ **A check in flight or a check that failed is said *beside* the determination, never instead
	 * of it.** A network failure, an expired credential or a spent hourly budget is not agreement, and
	 * reported as agreement it is the one reading that licenses sending over somebody else's work. The
	 * sentence saying which of those it was is in the stack, where it can be put away.
	 */
	const clause = $derived(
		remote.checking
			? `${github} · Checking…`
			: remote.failure === ''
				? github
				: `${github} · Check failed`
	);

	/** Whether GitHub holds this Workspace's work, on the last reading that completed. */
	const agreeing = $derived(remote.status === 'in-sync' && remote.failure === '');

	/** The determination, in the domain's own words, one press behind the badge. */
	const label = $derived(
		remote.status === null ? REMOTE_STATUS_UNCHECKED : REMOTE_STATUS_LABELS[remote.status]
	);

	/** The sentence behind the clause, beside the determination it explains. */
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
		What the getting half of a Sync is doing.

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
			Getting from GitHub: {update.files} of {update.totalFiles}
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
	date` it is the one reading that licenses sending over somebody else's work.

	⚠ **Published Site staleness is never one of the six** (ADR-0033). A site built by another editor
	version has different chunk names, so this is routinely true of a Workspace whose scholarship agrees
	with its Remote exactly. What it means is "the next Sync rebuilds it", which is why it is its own
	sentence with its own remedy and why it is a note rather than a warning.
-->
<Toast text={notice} testid="update-outcome" tone="info" />
<Toast text={failure} testid="update-failure" refusal />
<Toast text={remote.failure} testid="remote-status-failure" refusal />
<Toast
	text={remote.publishedSiteStale.length === 0
		? ''
		: `The Published Site was built from different files (${remote.publishedSiteStale.length} ` +
			`${remote.publishedSiteStale.length === 1 ? 'file' : 'files'} differ). The next Sync rebuilds it.`}
	testid="published-site-stale"
	tone="info"
/>
