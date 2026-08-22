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
		type RemoteStatusState
	} from '@ballastella/core';

	let {
		state,
		onCheck
	}: {
		state: RemoteStatusState;
		/** Check now, because the author asked. Never throttled — see `RemoteStatusChecker`. */
		onCheck: () => void;
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
	</div>

	{#if checkedAt !== ''}
		<p class="text-xs text-base-content opacity-70" data-testid="remote-status-checked">
			Checked at {checkedAt}
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
