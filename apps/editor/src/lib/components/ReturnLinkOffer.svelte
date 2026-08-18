<script lang="ts">
	import { describeRemote, type ReturnLink } from '@ballastella/core';

	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * What a link from a Published Site would do, and the press that does it (SPEC stories 49–51).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * IT OFFERS; IT DOES NOT ACT
	 *
	 * The whole of why this component exists rather than the route simply calling `cloneFrom`. A URL
	 * is a thing anyone can send, and one that created a Workspace and switched to it on arrival
	 * would be a link that rearranges a stranger's editor — minutes of downloading and a Workspace
	 * they did not ask for, from a repository they have never heard of. So the offer names the
	 * repository, says what would happen, and waits. Turning it down costs one press and downloads
	 * nothing.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * NOT A DIALOG, AND NOT A CREDENTIAL
	 *
	 * Rendered in the page above whichever screen `?p=` chose, in the shape the sign-in outcome
	 * already uses on that route: a modal would make the rest of the document inert on arrival, which
	 * is a hostile thing for a link to do to somebody who was reading. It stays after the operation
	 * so that its outcome survives the Workspace switch underneath it — the route does not remount,
	 * and the sentence is about the Workspace the visitor has just been moved into.
	 *
	 * ⚠ **Both operations are unauthenticated and nothing here asks for a sign-in** (SPEC stories 48
	 * and 50). A student with no GitHub account is the person this link is most likely to reach, and
	 * a credential prompt in front of it would be the one thing that stops them.
	 */
	let {
		storage,
		link,
		ondismiss
	}: {
		storage: WorkspaceStorage;
		link: ReturnLink;
		/**
		 * Take this offer off the page — `'declined'` when it was turned down having done nothing, and
		 * `'finished'` when what it offered has already happened.
		 *
		 * The two are not interchangeable to the page underneath: a declined Review leaves a `?p=`
		 * naming a Project this Workspace has not got, and a finished one leaves a `?p=` naming the
		 * Project the visitor came to read. The route acts on the difference.
		 */
		ondismiss: (reason: 'declined' | 'finished') => void;
	} = $props();

	/** What the operation did, in the words the user should see, or `''`. */
	let outcome = $state('');
	/** Why it did not happen. Its own state, so a refusal is an alert rather than a status. */
	let problem = $state('');
	/** Whether it is running, so the button cannot be pressed twice. */
	let busy = $state(false);

	const remote = $derived(describeRemote(link));

	async function accept(): Promise<void> {
		if (busy) return;
		outcome = '';
		problem = '';
		busy = true;
		try {
			const done =
				link.kind === 'clone'
					? await storage.cloneFrom({ owner: link.owner, repository: link.repository })
					: await storage.reviewFrom({
							owner: link.owner,
							repository: link.repository,
							project: link.project
						});
			// The engines' own sentences, which say which Workspace the visitor is now in — the one
			// thing they cannot work out for themselves after the screen has changed underneath them.
			outcome = done.notice;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			busy = false;
		}
	}
</script>

<!--
	`aria-live="polite"` rather than `role="status"`: the editor's navigation bar already owns the
	page's one status region — the save indicator — and a second would make `getByRole('status')`
	ambiguous across the whole app.
-->
<section
	class="m-4 rounded-box border border-base-300 p-4"
	aria-live="polite"
	data-testid="return-link-offer"
>
	{#if outcome}
		<p data-testid="return-link-outcome">{outcome}</p>
		<button
			class="btn mt-3 btn-sm"
			data-testid="dismiss-return-link"
			onclick={() => ondismiss('finished')}
		>
			Close
		</button>
	{:else}
		<h2 class="font-semibold">
			{#if link.kind === 'clone'}
				Open the Workspace published at {remote}?
			{:else}
				Review “{link.project}” from {remote}?
			{/if}
		</h2>
		<p class="mt-1 max-w-prose text-sm opacity-70">
			{#if link.kind === 'clone'}
				You followed a link from a published site. This downloads that whole Workspace into a
				<strong>new Workspace of your own</strong>, which you can then go on working in. Nothing you
				already have is changed, and you do not need a GitHub account. Nothing has been downloaded
				yet.
			{:else}
				You followed a link from a published site. This downloads that one Project into a separate
				<strong>review copy</strong> — a throwaway Workspace holding only that Project. Nothing in this
				Workspace is changed, nothing from the review copy can be brought back into it, and you do not
				need a GitHub account. Nothing has been downloaded yet.
			{/if}
		</p>

		<div class="mt-3 flex flex-wrap gap-2">
			<!--
				`aria-disabled` for the busy state and never `disabled`: a `disabled` button leaves the tab
				order the moment it is pressed, dropping a keyboard user's focus to `<body>` for the length
				of a download that runs in minutes (WCAG 2.4.3).
			-->
			<button
				class="btn btn-primary btn-sm"
				class:btn-disabled={busy}
				aria-disabled={busy}
				data-testid="accept-return-link"
				onclick={() => void accept()}
			>
				{#if busy}
					Downloading…
				{:else if link.kind === 'clone'}
					Clone into a new Workspace
				{:else}
					Open in a review copy
				{/if}
			</button>
			<!--
				Shown as unavailable while the download runs, because it is: neither operation can be
				stopped part way, and a button that looks pressable and answers nothing is worse than one
				that says so.
			-->
			<button
				class="btn btn-sm"
				class:btn-disabled={busy}
				aria-disabled={busy}
				data-testid="dismiss-return-link"
				onclick={() => !busy && ondismiss('declined')}
			>
				No thanks
			</button>
		</div>

		<!--
			Per-file progress, announced. A Map Image's pyramid is thousands of files over real
			minutes, and this is one of the places a visitor is waiting on something they cannot see.
		-->
		{#if storage.transfer && busy}
			<p class="mt-3 text-sm" data-testid="return-link-progress">
				{storage.transfer.files} of {storage.transfer.totalFiles} files downloaded from
				{storage.transfer.subject}.
			</p>
		{/if}
	{/if}

	{#if problem}
		<!-- The refusals: no such public repository, no Project by that name, a truncated file list, no
		     room to hold it, or a Project from a newer version. Each has left nothing behind. -->
		<div role="alert" class="mt-3 alert flex-col items-start alert-error">
			<p data-testid="return-link-problem">{problem}</p>
		</div>
	{/if}
</section>
