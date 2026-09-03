<script lang="ts">
	// Where a scholar's work is, in one badge with two clauses (ADR-0044).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// TWO QUESTIONS, ONE PLACE, AND NEVER ONE WORD
	//
	// *Is my edit kept on this machine* and *does GitHub hold it too* are different questions with
	// different remedies, and conflating them is how a scholar comes to believe a saved edit is a sent
	// one. That rule is kept where it does the work — in the text, as two clauses that are always both
	// present — rather than in two badges with two backgrounds side by side, where it only cost
	// height. Collapsing them to one word is the failure this shape exists to refuse.
	//
	// **One region, read as one line.** `role="status"` and `aria-atomic`, so a screen reader hears
	// "Saved here · in sync with ada/atlas" rather than two regions of which the listener has to work
	// out which is now true. It is the bar's *only* `role="status"` — `getByRole('status')` must stay
	// unambiguous, which is a hint that a screen-reader user would otherwise have to disambiguate too.
	//
	// **The GitHub clause is the caller's words, not this file's.** `RemoteStatus` owns the phrasing
	// of the six determinations and the popover that holds them; this places the clause it is
	// handed beside the local one. With no Remote there is no such question, so the badge is the local
	// clause alone — and it is still drawn, because the local clause is the only signal a Workspace
	// with no Save button has that an edit reached storage at all (ADR-0017 rule 5).

	import type { SaveState } from '@ballastella/core';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';

	// Not named `state`: a local binding by that name turns every `$state` in this file into a
	// store subscription.
	let {
		saveState,
		github = '',
		determination = '',
		agreeing = false,
		popoverTarget,
		expanded = false,
		onToggle
	}: {
		/** Whether the edit is kept on this machine (ADR-0017 rule 5). */
		saveState: SaveState;
		/** Whether GitHub has it, in the caller's words. `''` for a Workspace with no Remote. */
		github?: string;
		/** The determination behind that clause, for a spec to read. Carries nothing a user needs. */
		determination?: string;
		/** Whether GitHub agrees, which is the only thing that keeps the badge out of warning. */
		agreeing?: boolean;
		/** The status detail popover this badge opens, or `undefined` when there is no Remote. */
		popoverTarget?: string;
		/** Whether the status detail popover is open. */
		expanded?: boolean;
		/** Keeps the trigger's expanded state current before the native toggle event is delivered. */
		onToggle?: () => void;
	} = $props();

	/**
	 * "Saving" is often over in a few milliseconds, especially in OPFS. Shown for less than this
	 * it is a strobe rather than information — and an indicator that flickers is worse than one
	 * that lingers, since the thing it has to convey is reassurance.
	 */
	const MINIMUM_SAVING_MS = 400;

	/**
	 * ⚠ **"Saved here", not "Saved"** (ADR-0044). The bare word conflated the two facts a scholar most
	 * needs kept apart: their edit is safe on this machine the moment they make it, and it is on
	 * GitHub only once a Sync has carried it there. The GitHub clause sits next to it, so this one has
	 * to say which of the two it means.
	 *
	 * The other two are unchanged: there is nowhere else for an unsaved edit to be.
	 */
	const LABELS: Record<SaveState, string> = {
		saved: 'Saved here',
		saving: 'Saving…',
		unsaved: 'Unsaved changes'
	};

	let shown = $state<SaveState>('saved');
	let savingSince = 0;

	$effect(() => {
		const next = saveState;
		if (next === 'saving') {
			savingSince = Date.now();
			shown = 'saving';
			return;
		}
		const remaining = MINIMUM_SAVING_MS - (Date.now() - savingSince);
		if (remaining <= 0) {
			shown = next;
			return;
		}
		const timer = setTimeout(() => {
			shown = next;
		}, remaining);
		return () => clearTimeout(timer);
	});

	/**
	 * Whether *both* clauses are settled.
	 *
	 * ⚠ **The colour and the mark follow the whole badge, never the local half.** A tick beside
	 * "Saved here · changes both ways" is an all-clear over a sentence that is not one, and a scholar
	 * who reads the badge as a shape rather than as words would take it. The meaning is in the text
	 * regardless — neither the tint nor the glyph says anything the sentence does not.
	 */
	const settled = $derived(shown === 'saved' && (github === '' || agreeing));
</script>

<div role="status" aria-atomic="true">
	{#if popoverTarget === undefined}
		<p
			data-save-state={shown}
			data-remote-status={github === '' ? undefined : determination}
			data-testid="where-your-work-is"
			class="badge h-8 gap-1.5 font-medium whitespace-nowrap shadow-sm"
			class:badge-success={settled}
			class:badge-warning={!settled}
		>
			{#if shown === 'saving'}
				<span class="loading loading-xs loading-spinner" aria-hidden="true"></span>
			{:else if settled}
				<span class="saved-mark" aria-hidden="true">
					<CircleCheck class="size-3.5" />
				</span>
			{:else}
				<TriangleAlert class="size-3.5" aria-hidden="true" />
			{/if}
			{LABELS[shown]}{#if github !== ''}&nbsp;· {github}{/if}
		</p>
	{:else}
		<button
			type="button"
			popovertarget={popoverTarget}
			aria-controls={popoverTarget}
			aria-expanded={expanded}
			data-save-state={shown}
			data-remote-status={determination}
			data-testid="where-your-work-is"
			class="badge h-8 gap-1.5 font-medium whitespace-nowrap shadow-sm"
			class:badge-success={settled}
			class:badge-warning={!settled}
			style="anchor-name: --{popoverTarget}"
			onclick={onToggle}
		>
			{#if shown === 'saving'}
				<span class="loading loading-xs loading-spinner" aria-hidden="true"></span>
			{:else if settled}
				<span class="saved-mark" aria-hidden="true">
					<CircleCheck class="size-3.5" />
				</span>
			{:else}
				<TriangleAlert class="size-3.5" aria-hidden="true" />
			{/if}
			{LABELS[shown]}{#if github !== ''}&nbsp;· {github}{/if}
		</button>
	{/if}
</div>

<style>
	.saved-mark {
		animation: saved-confirmation 300ms ease-out;
	}

	@keyframes saved-confirmation {
		0% {
			transform: scale(0.6);
		}
		60% {
			transform: scale(1.2);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.saved-mark {
			animation: none;
		}
	}
</style>
