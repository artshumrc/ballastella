<script lang="ts">
	import {
		describeRemote,
		publishedSiteUrl,
		shareLinksWithdrawalMessage,
		type RemotePagesOutcome,
		type RemoteRights
	} from '@ballastella/core';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';

	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * The repository this Workspace belongs to, in the Workspace's own editing dialog.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THE STANDING RELATIONSHIP LIVES HERE AND NOT IN THE GUIDED SEQUENCE
	 *
	 * Which repository this Workspace belongs to, what the two of them last agreed on, Share Links,
	 * the way to a different repository and the way to give this one up are all *settings of this
	 * Workspace* — so they are on the Workspace's own row, beside its name, its Backup and what the
	 * browser has promised about keeping it (ADR-0042).
	 *
	 * ⚠ **The guided sequence is the way in and has no other job** (ADR-0044). It survives only for a
	 * Workspace that belongs to no repository yet: connecting hands off to the Sync modal, and the
	 * Workspace comes to rest here. Kept there, the standing state made a door somebody has already
	 * been through into a screen they had to come back to.
	 *
	 * ⚠ **The transfer is not here either.** The bar's one control opens the Sync modal, which reads
	 * both sides and shows what it found before it moves a byte.
	 *
	 * ⚠ **The determination is not restated here.** Whether GitHub agrees with this Workspace is the
	 * badge's one sentence (`RemoteStatus`), so *Check Remote Status* closes this surface on the
	 * press: a `showModal()` dialog makes everything outside it inert, and an inert live region is
	 * not a quiet one but a silent one.
	 */
	let {
		storage,
		onclose
	}: {
		storage: WorkspaceStorage;
		/** Close the dialog this is inside, for the presses whose answer is outside it. */
		onclose: () => void;
	} = $props();

	/** What GitHub says this sign-in may do with the Remote, or `null` while nobody has asked. */
	let rights = $state<RemoteRights | null>(null);
	/**
	 * Whether GitHub has been asked about the rights.
	 *
	 * ⚠ **Separate from {@link rights}, and for the reason the sequence's own read gives.** A read
	 * that failed leaves `rights` at `null` for ever, so an effect guarded on `rights` alone would
	 * ask again the moment the request settled — one `GET` per microtask, for as long as GitHub is
	 * unreachable.
	 */
	let rightsAsked = $state(false);
	/**
	 * What asking for Share Links answered, or `null` while nobody has asked for them.
	 *
	 * ⚠ **`null` is "not asked", and it is the state this must open in** (ADR-0045). A Remote is a
	 * place the work lives before it is a site anybody reads, so nothing here asks GitHub about Pages
	 * on its own — an instruction about a permission said before the press would answer a question
	 * the author has not asked.
	 */
	let pages = $state<RemotePagesOutcome | null>(null);
	/**
	 * Whether this Workspace already carries a Published Site, or `null` while nobody has looked.
	 *
	 * ⚠ **Read rather than remembered** (ADR-0045). Share Links are the site record's presence and
	 * nothing else, so this is a reading of the Workspace's files — which is what makes it right
	 * after another surface, or another tab, has changed them.
	 */
	let shareLinks = $state<boolean | null>(null);
	/** Whether a Share Links act is in flight, so a second press is not a second request. */
	let working = $state(false);
	/** Whether the withdrawal's confirmation is on screen. */
	let withdrawing = $state(false);
	/** What GitHub said about taking the site down, or `''`. */
	let withdrawalNotice = $state('');
	/** What a press left true, in words. */
	let notice = $state('');
	/** Why the last press did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/** Whether the address has just been put on the clipboard, so the press says it worked. */
	let copied = $state(false);

	const bound = $derived(storage.remote);
	const boundName = $derived(bound === null ? '' : describeRemote(bound));
	/** Whether a status check is running, which is the only thing that makes its control busy. */
	const checking = $derived(storage.remoteStatusState.checking);
	/**
	 * Whether the author may send to the Remote they have: `null` until GitHub has said.
	 *
	 * ⚠ **Signed out it is `null` and stays there** (ADR-0043). Push rights cannot be read without a
	 * credential, so this says sending needs a sign-in and **nothing about rights**. Claiming either
	 * way from an absent credential would be inventing the answer.
	 */
	const canPush = $derived<boolean | null>(
		storage.signedIn && rights !== null ? rights.canPush : null
	);
	/** Whether the relationship is known to be read-only, which is the one state that says so. */
	const readOnly = $derived(canPush === false);
	const siteAddress = $derived(bound === null ? '' : publishedSiteUrl(bound));
	const withdrawalWarning = $derived(bound === null ? '' : shareLinksWithdrawalMessage(bound));

	/**
	 * The Baseline, in words, beside the repository it is about.
	 *
	 * ⚠ **`Cannot tell` is a determination rather than a silence** (ADR-0044), so the absence of a
	 * record is stated rather than left blank — a Workspace whose Remote nobody here has evidence
	 * about must not read as one that agrees with it.
	 */
	const baselineSentence = $derived.by(() => {
		const record = storage.baseline;
		if (bound === null) return '';
		return record === null
			? `Cannot tell what has changed since this Workspace and ${boundName} last agreed: there is ` +
					`no record of it on this computer.`
			: `Ballastella last agreed with ${boundName} at commit ${record.commit}, over ` +
					`${record.files.size} ${record.files.size === 1 ? 'file' : 'files'}.`;
	});

	/**
	 * Ask GitHub whether this sign-in may send to the Remote this Workspace has.
	 *
	 * ⚠ **Only where a Remote *and* a credential both exist**, which is what makes the signed-out
	 * state say nothing about rights rather than say "no". A refusal is swallowed on purpose: there
	 * is nothing for the author to do about it and nothing they asked for, and the send engine's own
	 * permission check still refuses before a byte moves.
	 */
	$effect(() => {
		if (bound === null || !storage.signedIn || rightsAsked) return;
		rightsAsked = true;
		void storage.readRights().then(
			(answer) => {
				rights = answer;
			},
			() => {}
		);
	});

	/**
	 * Read whether this Workspace has Share Links. No credential and no request.
	 *
	 * ⚠ **Re-read when the status check moves**, rather than once on open: the answer is two-sided
	 * (ADR-0045), and on a machine that has only got the Workspace the Remote's half is the whole of
	 * it — so a dialog opened before the first check finishes would otherwise stand on a *no* the
	 * evidence has since overturned.
	 */
	$effect(() => {
		void storage.remoteStatusState.shareLinks;
		if (bound === null) return;
		void storage.hasShareLinks().then(
			(answer) => {
				shareLinks = answer;
			},
			() => {}
		);
	});

	/**
	 * Ask for Share Links, check again, or withdraw them — the three presses, and one wrapper.
	 *
	 * ⚠ **Never throws its answer at anybody.** A refusal is a sentence naming what GitHub requires
	 * and the setting to change by hand, and the connection it is said over stands — so it is a
	 * notice rather than a problem. The one thing that *is* a problem is a press that could not be
	 * made at all, which is a sign-in that is no longer held.
	 */
	async function shareLinksAct(act: () => Promise<void>): Promise<void> {
		problem = '';
		working = true;
		try {
			await act();
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	/** Write the viewer into the Workspace and ask GitHub for an address. */
	const enablePages = () =>
		shareLinksAct(async () => {
			pages = await storage.enableShareLinks();
			// The viewer is in the Workspace whatever GitHub answered, so this is true either way — and
			// it is what puts *Withdraw Share Links* on screen beside a refusal the author is still
			// working through.
			shareLinks = true;
		});

	/** Poll GitHub until the site answers, then carry on. */
	const checkPages = () =>
		shareLinksAct(async () => {
			pages = await storage.checkShareLinks();
		});

	/** Take the viewer back out and ask GitHub to take the site down. */
	const withdrawPages = () =>
		shareLinksAct(async () => {
			const withdrawal = await storage.withdrawShareLinks();
			withdrawing = false;
			withdrawalNotice = withdrawal.notice;
			pages = null;
			shareLinks = false;
		});

	/**
	 * Forget which repository this Workspace syncs with.
	 *
	 * ⚠ **Named for what it does, not for the mechanism.** *Unbind* is on the glossary's Avoid list —
	 * a scholar cannot be asked to learn a word to stop doing something. Only this computer forgets:
	 * nothing on GitHub is deleted, which the sentence the press leaves behind says.
	 */
	async function disconnect(): Promise<void> {
		problem = '';
		notice = '';
		const was = boundName;
		working = true;
		rights = null;
		rightsAsked = false;
		try {
			await storage.unbindRemote();
			notice =
				`This Workspace no longer syncs with ${was}. Nothing there has been changed — ` +
				`everything in it is exactly as it was, and connecting again puts things back.`;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	/** Ask GitHub what it holds now, on the badge rather than behind this dialog. */
	function check(): void {
		onclose();
		void storage.checkRemoteStatus();
	}

	/** Go back to the guided sequence, which is the one place a repository is chosen. */
	function chooseAnother(): void {
		onclose();
		connectSequence.start();
	}

	/**
	 * Put the address on the clipboard, for pasting into a submission form.
	 *
	 * The address is visible text as well, because a browser that refuses clipboard access must not
	 * leave the author with no way to read it.
	 */
	async function copyAddress(): Promise<void> {
		copied = false;
		try {
			await navigator.clipboard.writeText(siteAddress);
			copied = true;
		} catch {
			problem =
				`This browser would not let the page put anything on the clipboard, so copy the address ` +
				`above by hand. It is usually a setting this browser holds for this site.`;
		}
	}
</script>

{#if bound !== null}
	<section class="mt-4 border-t border-base-300 pt-3" data-testid="workspace-remote">
		<h3 class="font-semibold">On GitHub</h3>
		<p class="mt-1 max-w-prose" data-testid="workspace-remote-repository">
			This Workspace syncs with <code>{boundName}</code>.
		</p>
		<!--
			What the two sides last agreed on, beside the repository it is about. The determination
			itself is the badge's and is not restated here: this is the evidence behind it.
		-->
		<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="remote-baseline">
			{baselineSentence}
		</p>
		<!--
			⚠ **What is said about sending here is only ever what is known** (ADR-0043). Push rights
			cannot be read without a credential, so signed out this says that sending needs a sign-in
			and **nothing whatever about rights** — a scholar whose Workspace belongs to somebody else's
			public repository must not be told they may send to it, nor that they may not.
		-->
		{#if !storage.signedIn}
			<p class="mt-3 max-w-prose text-sm" data-testid="send-needs-sign-in">
				Sending to <code>{boundName}</code> needs you to be signed in to GitHub. Getting from it does
				not.
			</p>
		{:else if readOnly}
			<!--
				⚠ **The relationship stated once, rather than discovered at a refusal.** GitHub says this
				sign-in may read this repository and not write to it, which is an ordinary and permanent
				state — a read-only collaborator, or somebody else's public repository connected here. So
				there is no send affordance below at all: a control that will certainly refuse is worse
				than its absence, and the way forward is on the same screen as the limitation.
			-->
			<div role="status" class="mt-3 alert flex-col items-start alert-warning">
				<p data-testid="read-only-remote">
					You can get changes from <code>{boundName}</code> into this Workspace, but you cannot send
					to it: GitHub does not give this sign-in write access there. Nothing is wrong with your
					work or your sign-in. If <code>{boundName}</code> is somebody else's, ask them for write access
					to it — or sync with a repository of your own instead.
				</p>
			</div>
		{/if}
		<!--
			⚠ **The one thing collaboration cannot do, said before anybody meets it as a Conflict.**
			Two people cannot both align the same Map Image, and a boundary belongs in what the
			interface says up front rather than in a question at the end of an afternoon.
		-->
		<p class="mt-3 max-w-prose text-sm opacity-70" data-testid="shared-remote-limit">
			If somebody else works in <code>{boundName}</code> too, the two of you can work on different Projects
			at the same time. What you cannot both do is align the same Map Image: whoever syncs second is asked
			which of the two Alignments to keep.
		</p>
		<!--
			The address, which is what an author was asked for: a link to give a professor or paste into
			a submission form. Visible text as well as a copy, because a browser that refuses the
			clipboard must not leave them with nothing to read.
		-->
		<p class="mt-3 max-w-prose">
			With Share Links on, your map answers at
			<code data-testid="published-site-address">{siteAddress}</code>.
		</p>
		<!--
			⚠ **Nothing about Share Links is offered to somebody who is not signed in.** Every one of
			the three presses is a request to GitHub, so the offer would be a control that can only
			refuse — and the sentence a scholar needs in that state is the one above, about sending
			needing a sign-in, rather than a second one about a website.
		-->
		{#if !storage.signedIn || shareLinks === null}
			<!--
				Not signed in: said once, above, by the branch that owns that state.

				⚠ **And nothing at all until the Workspace's own files have been read.** Whether there is
				a site is a reading rather than a remembered flag (ADR-0045), so it arrives one turn
				after the dialog does — and an offer rendered in the meantime is an offer that disappears
				under the hand of anybody who takes it.
			-->
		{:else if pages?.enabled}
			<p class="mt-3 max-w-prose" data-testid="pages-enabled">
				Anybody you give that address to can now open your map there. It appears the first time you
				Sync.
			</p>
		{:else if shareLinks !== true}
			<p class="mt-3 max-w-prose">
				That address answers nothing yet. Your work is on GitHub either way — Share Links is what
				also lets other people open it.
			</p>
			<!-- `aria-disabled` and never `disabled`, for the reason every busy control on this surface
			     uses the same: a `disabled` button leaves the tab order the instant it is pressed,
			     dropping a keyboard user to `<body>` (WCAG 2.4.3). -->
			<button
				class="btn mt-2 btn-sm"
				class:btn-disabled={working}
				aria-disabled={working}
				data-testid="enable-pages"
				onclick={() => {
					if (!working) void enablePages();
				}}
			>
				{working ? 'Asking GitHub…' : 'Turn Share Links on'}
			</button>
		{/if}
		{#if pages && !pages.enabled}
			<div role="status" class="mt-3 alert flex-col items-start alert-warning">
				<p data-testid="pages-notice">{pages.instruction}</p>
				<!--
					⚠ **The guided step: the screen, the branch, and the folder, handed over.** GitHub
					requires `Administration: write` to turn Pages on and ADR-0040 refuses to ask for it, so
					this is the ordinary answer rather than a rare one — and the manual step has to be one
					click rather than a search. The link and the branch come off the outcome, so nothing
					here can build an address the sentence beside it disagrees with.
				-->
				{#if pages.next === 'guided'}
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<p>
						<a
							class="link"
							href={pages.settingsUrl}
							target="_blank"
							rel="noreferrer noopener"
							data-testid="pages-settings-link"
						>
							Open Settings → Pages for {boundName}
						</a>
						— set Source to “Deploy from a branch”, choose
						<code data-testid="pages-branch">{pages.branch}</code> and
						<code>/ (root)</code>, and press Save.
					</p>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<!--
						⚠ **The waiting and the verifying are ours** (ADR-0045). The author does one thing on
						github.com; guessing when it took effect, and pressing until it does, is the
						avoidable half of the manual step. One press polls until the site answers.
					-->
					<button
						class="btn btn-sm"
						class:btn-disabled={working}
						aria-disabled={working}
						data-testid="check-pages"
						onclick={() => {
							if (!working) void checkPages();
						}}
					>
						{working ? 'Asking GitHub…' : 'Check again'}
					</button>
				{/if}
			</div>
		{/if}
		<!--
			⚠ **Withdrawal says what it cannot undo before it happens, and it is never called
			taking the work back** (ADR-0045). A scholar who reads "turn the site off" as "make it unseen" will
			act on that reading — with an embargoed photograph, or a manuscript under a library's
			publication restriction — so the three things it cannot promise are on the screen where the
			press is, rather than in a document nobody opens.
		-->
		{#if shareLinks === true && storage.signedIn}
			{#if withdrawing}
				<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
					<p data-testid="withdraw-warning">{withdrawalWarning}</p>
					<div class="flex flex-wrap gap-2">
						<button
							class="btn btn-sm btn-warning"
							class:btn-disabled={working}
							aria-disabled={working}
							data-testid="withdraw-share-links-confirm"
							onclick={() => {
								if (!working) void withdrawPages();
							}}
						>
							{working ? 'Asking GitHub…' : 'Withdraw Share Links'}
						</button>
						<button
							class="btn btn-ghost btn-sm"
							data-testid="withdraw-share-links-cancel"
							onclick={() => (withdrawing = false)}
						>
							Keep them
						</button>
					</div>
				</div>
			{:else}
				<button
					class="btn mt-3 btn-ghost btn-sm"
					data-testid="withdraw-share-links"
					onclick={() => (withdrawing = true)}
				>
					Withdraw Share Links…
				</button>
			{/if}
		{/if}
		{#if withdrawalNotice}
			<div role="status" class="mt-3 alert flex-col items-start alert-warning">
				<p data-testid="withdrawal-notice">{withdrawalNotice}</p>
			</div>
		{/if}
		<div class="mt-3 flex flex-wrap items-center gap-2">
			<!--
				The explicit check. **Always offered, not only while signed out**: signed out it is the
				only way to a status at all, since automatic anonymous polling is ruled out by GitHub's
				sixty-an-hour anonymous budget, and signed in it is still the answer to "has anything
				changed *now*".
			-->
			<button
				class="btn btn-sm"
				class:btn-disabled={checking}
				aria-disabled={checking}
				data-testid="check-remote-status"
				onclick={() => {
					if (!checking) check();
				}}
			>
				Check Remote Status
			</button>
			<!--
				⚠ **Connecting once is not permanent**, and the guided sequence is the one place a
				repository is chosen at all — so this is the way back to it rather than a second copy of
				the choice.
			-->
			<button class="btn btn-sm" data-testid="change-repository" onclick={() => chooseAnother()}>
				Choose a different repository
			</button>
			<button
				class="btn btn-sm"
				data-testid="copy-published-site-address"
				onclick={() => void copyAddress()}
			>
				Copy the address
			</button>
			<button
				class="btn btn-outline btn-sm btn-warning"
				class:btn-disabled={working}
				aria-disabled={working}
				data-testid="unbind-remote"
				onclick={() => {
					if (!working) void disconnect();
				}}
			>
				Disconnect from {boundName}
			</button>
			<p aria-live="polite" class="text-sm opacity-70" data-testid="copied-address">
				{copied ? 'The address is on your clipboard.' : ''}
			</p>
		</div>
	</section>
{/if}

{#if notice}
	<div role="status" class="mt-3 alert flex-col items-start alert-warning">
		<p data-testid="workspace-remote-notice">{notice}</p>
	</div>
{/if}
{#if problem}
	<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
		<p data-testid="workspace-remote-problem">{problem}</p>
	</div>
{/if}
