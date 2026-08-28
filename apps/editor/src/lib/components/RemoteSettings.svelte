<script lang="ts">
	import { describeRemote, describeTokenProblem, parseRemoteReference } from '@ballastella/core';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';

	import ModalDialog from './ModalDialog.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * Which repository this Workspace publishes to, and the credential that may push to it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THIS IS ITS OWN DIALOG AND NOT A SECTION OF WORKSPACE SETTINGS
	 *
	 * Workspace settings answers *where your work is kept and what may be done to it* — a question
	 * about this machine. This one answers *where your work goes when you publish it*, which is a
	 * question about the web, and it is the one a scholar comes looking for by name. Keeping the two
	 * apart is also what keeps a first visit clear of any of it: nothing here renders anywhere until
	 * the user opens this dialog, so somebody who never publishes is never shown a sign-in prompt.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE TOKEN IS CHECKED TWICE, CHEAPLY THEN PROPERLY
	 *
	 * `describeTokenProblem` catches the paste that went wrong — an empty clipboard, half a token, a
	 * repository address in the wrong field — with no request at all, and says which. GitHub catches
	 * the rest, at the moment of binding, because whether a token is any good is a question only
	 * GitHub can answer. Either way a refused credential is **not kept**: `WorkspaceStorage.bindRemote`
	 * writes it only after GitHub has answered.
	 *
	 * Every explanation is visible text rather than a tooltip: daisyUI renders tooltips through CSS
	 * `::before`, so they are neither announced nor dismissable (ADR-0016).
	 */
	let { open = $bindable(false), storage }: { open?: boolean; storage: WorkspaceStorage } =
		$props();

	/**
	 * Hydration-stable ids, for the reason `NavigationBar` documents about its own.
	 *
	 * One `$props.id()` suffixed three ways, because Svelte allows exactly one call per component —
	 * and `for`/`id` is the whole of what ties a label to its field for a screen reader.
	 */
	const fieldId = $props.id();
	const repositoryId = `${fieldId}-repository`;
	const tokenId = `${fieldId}-token`;
	const signInTokenId = `${fieldId}-sign-in-token`;
	const openRepositoryId = `${fieldId}-open-repository`;
	const rememberId = `${fieldId}-remember-sign-in`;

	let repository = $state('');
	let token = $state('');
	let signInToken = $state('');
	let openRepository = $state('');
	/**
	 * Whether the escape hatch is open, in each of the two places this dialog can bind a credential.
	 *
	 * ⚠ **Closed by default, and the field is not in the document until it is opened.** Where this
	 * deployment has a GitHub App, a personal access token is not a choice a scholar is asked to make —
	 * one door, and it is the button. This exists for the instructor whose class meets a broken App
	 * installation on a Tuesday morning, so it is worded for somebody who already knows what they are
	 * asking for and it is never a peer of the sign-in.
	 *
	 * Two states rather than one because both sections can be on screen at once, and a single one
	 * would open a form the author was not looking at. Where **no** App is configured neither is read:
	 * the paste is that fork's whole authentication and it is the plain content of both sections.
	 */
	let bindPasteRevealed = $state(false);
	let signInPasteRevealed = $state(false);
	/** Whether an Open is running, which is minutes rather than the moment a bind takes. */
	let opening = $state(false);
	/** Whether a request is in flight, so the button cannot be pressed twice. */
	let working = $state(false);
	/** What the last action did, in the words the user should see. */
	let outcome = $state('');
	/** Why the last action did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/**
	 * Sentences the binding succeeded *with*: a credential that cannot push.
	 *
	 * Separate from {@link problem} because it is not a failure — the binding stands either way — and
	 * rendering it as an error would tell a scholar their Workspace is not bound when it is.
	 */
	let notices = $state<string[]>([]);

	const bound = $derived(storage.remote);
	/** A legacy binding waiting to be confirmed or declined, which is not yet a Remote. */
	const legacy = $derived(storage.legacyRemote);
	/**
	 * Whether the guided sequence exists to be opened from here.
	 *
	 * ⚠ **The same fact `NavigationBar` mounts it on**, and it has to be, because this dialog does not
	 * mount its own copy — it opens the bar's through `connectSequence`. The bar leaves `ConnectToGitHub`
	 * unmounted over a review copy and over a Workspace whose interrupted Import or Update is
	 * unresolved, so a control here in either state would set a flag no dialog is watching: a press
	 * that does nothing. Absent rather than present and refused, which is the arrangement every other
	 * control over those two states already has.
	 */
	const sequenceOffered = $derived(storage.review === null && storage.unavailable === '');

	function reset(): void {
		outcome = '';
		problem = '';
		notices = [];
	}

	/**
	 * Forget what the dialog last said, once it is closed.
	 *
	 * ⚠ **This component is mounted for the page's life, so nothing else clears a notice.** Without
	 * this, “Opened ada/atlas into a new Workspace called “atlas”” is still on screen the next time
	 * anybody opens the dialog — including after switching to a Workspace it has nothing to say
	 * about. Closing is the right moment for the Workspace case too: this is a modal, so the only
	 * Workspace change that can happen while it is open is an Open's own, and that message is about
	 * the Workspace the user has just been moved into and must survive the switch.
	 */
	$effect(() => {
		if (!open) {
			reset();
			// Closed again with the dialog: an escape hatch left open would be on the screen of whoever
			// opens this next, which is the arrangement it exists to avoid.
			bindPasteRevealed = false;
			signInPasteRevealed = false;
		}
	});

	/**
	 * Check the held sign-in has life left in it, the moment this dialog is opened.
	 *
	 * ⚠ **Expiry is answered *before* work starts, never during it.** A GitHub App's user token lasts
	 * eight hours, and a publish that met the end of one partway through would leave blobs in no tree
	 * and a ref that never moved. `ensureCredentialFresh` renews it through the broker where it can and
	 * clears it where it cannot, so every screen then renders the not-signed-in state and the remedy is
	 * the button already on this one.
	 *
	 * This is the same call Publish makes before it starts, and it is here as well because this is the
	 * screen a scholar comes to when they suspect their sign-in has gone.
	 *
	 * An `$effect` rather than a `$derived`: it is a request, not a value.
	 */
	$effect(() => {
		if (!open) return;
		void storage.ensureCredentialFresh().catch((cause: unknown) => {
			problem = cause instanceof Error ? cause.message : String(cause);
		});
	});

	async function bind(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		reset();

		const reference = parseRemoteReference(repository);
		if (reference === null) {
			problem =
				`“${repository.trim()}” is not a repository address. It looks like “owner/repository” — ` +
				`the two parts after github.com in your browser's address bar — and the whole of that ` +
				`address works too.`;
			return;
		}
		// An empty field while signed in is not a mistake: the credential is already held, and asking
		// for a paste on top of it would make the sign-in button unable to do the one thing it is for.
		// A paste is still honoured over the sign-in, because somebody who typed one meant it.
		const pasted = token.trim() === '' && storage.signedIn ? null : token;
		if (pasted !== null) {
			const tokenProblem = describeTokenProblem(pasted);
			if (tokenProblem) {
				problem = tokenProblem;
				return;
			}
		}

		working = true;
		try {
			const result = await storage.bindRemote(reference, pasted?.trim() ?? null);
			// Cleared only on success. A refused paste stays in the field, because pasting an
			// eighty-two-character token again to fix a one-character mistake is not a remedy.
			token = '';
			repository = '';
			outcome =
				`This Workspace is bound to ${describeRemote(result.binding)}. Publishing will send it ` +
				`there, and nowhere else.`;
			notices = result.rightsNotice ? [result.rightsNotice] : [];
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	async function signIn(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		reset();

		const tokenProblem = describeTokenProblem(signInToken);
		if (tokenProblem) {
			problem = tokenProblem;
			return;
		}

		working = true;
		try {
			const rights = await storage.signIn(signInToken.trim());
			signInToken = '';
			outcome = 'Signed in to GitHub. Your sign-in is forgotten when this tab closes.';
			notices = rights.canPush
				? []
				: [
						`This token reaches ${bound ? describeRemote(bound) : 'the repository'} but cannot ` +
							`push to it, so publishing will be refused. A fine-grained personal access token ` +
							`with “Contents: Read and write” for this repository is what publishing needs.`
					];
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	/**
	 * Leave for GitHub, or say why this browser cannot.
	 *
	 * A browser that will not hold the `state` cannot finish a sign-in it starts, so the refusal is
	 * shown here — beside the paste, which needs no storage of that kind — rather than after a trip
	 * to GitHub and an authorisation that would then be thrown away.
	 */
	function beginSignIn(): void {
		reset();
		// ⚠ **`installed: true`, and this is the re-acquisition surface rather than the front door.**
		// The install-first trip belongs to the guided sequence, which is where a first-time author
		// arrives; somebody who has opened Workspace settings to sign in again has been here before,
		// and wants a credential rather than a second look at an installation they already made.
		problem = storage.beginGitHubSignIn({ installed: true });
	}

	function signOut(): void {
		reset();
		storage.signOut();
		outcome = 'Signed out of GitHub. Nothing on this computer or on GitHub has been changed.';
	}

	/**
	 * Open a Workspace from GitHub.
	 *
	 * ⚠ **Offered whether or not anybody is signed in, and it asks for no token.** This reads a
	 * public repository, which needs no credential at all — that is the whole point of it, and gating
	 * it behind a sign-in would put a GitHub account in front of the one operation a student
	 * without one is promised.
	 */
	async function openFromGitHub(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		reset();

		const reference = parseRemoteReference(openRepository);
		if (reference === null) {
			problem =
				`“${openRepository.trim()}” is not a repository address. It looks like ` +
				`“owner/repository” — the two parts after github.com in your browser's address bar — and ` +
				`the whole of that address works too.`;
			return;
		}

		opening = true;
		try {
			const opened = await storage.openFromGitHub(reference);
			openRepository = '';
			outcome = opened.notice;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			opening = false;
		}
	}
</script>

<ModalDialog bind:open title="Remote repository" wide>
	<div class="flex flex-col gap-4">
		<section class="rounded-box border border-base-300 p-4">
			<h3 class="font-semibold">Where this Workspace publishes</h3>

			{#if storage.review !== null}
				<!--
					ADR-0024: somebody else's work is never published to your own address. Said in visible text
					rather than left as an absent control with no explanation — and refused in `packages/core`
					as well, so a guard that lives in markup is not the only one.
				-->
				<p class="mt-3 text-sm text-warning" data-testid="no-remote-in-review">
					This is a review copy of somebody else's Project, so it cannot be bound to a repository
					and no GitHub sign-in is readable while it is open. Go back to your own Workspace first.
				</p>
			{:else if legacy}
				<!--
					⚠ **A `remote.json` this installation cannot corroborate** (ADR-0038). The binding is a
					file inside the published tree, so a fork, a colleague's copied folder and a restored
					Backup all carry one naming somebody else's repository — and lifting it silently would
					aim a Publish at a repository this author has never seen.

					**The question itself is the door's** (ADR-0041): it is asked once, where every other
					way to a Remote already is, rather than sitting in a dialog nobody opens. What this
					section does is stay out of the way of it — there is no bind form underneath while the
					question stands, so it cannot be answered here by accident.
				-->
				<p class="mt-1 text-sm" data-testid="legacy-remote-waiting">
					This Workspace's files say it was published to
					<code>{describeRemote(legacy)}</code>, and this browser has no record of ever having
					published there. Connect to GitHub asks whether that repository is yours.
				</p>
				{#if sequenceOffered}
					<div class="mt-3">
						<button
							class="btn btn-sm"
							data-testid="open-connect-sequence"
							onclick={() => connectSequence.start()}
						>
							Connect to GitHub…
						</button>
					</div>
				{/if}
			{:else if bound}
				<p class="mt-1 text-sm opacity-70">
					Publishing sends this Workspace to
					<code data-testid="bound-remote">{describeRemote(bound)}</code>, on the branch
					<code>{bound.branch}</code>, and nowhere else.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<!--
						The door, which for a bound Workspace names the repository, states what it and this
						Workspace last agreed on, and holds every gesture about it — Publish, Update from
						GitHub, the check, and giving the repository up (ADR-0041). None of those is
						reimplemented here.
					-->
					{#if sequenceOffered}
						<button
							class="btn btn-sm"
							data-testid="open-connect-sequence"
							onclick={() => connectSequence.start()}
						>
							Show this Workspace's repository
						</button>
					{/if}
				</div>
			{:else}
				<p class="mt-1 text-sm opacity-70">
					One GitHub repository, once, for the whole Workspace. Afterwards publishing never asks you
					where.
				</p>
				<!--
					⚠ **The guided sequence, opened rather than reimplemented.** This dialog describes what a
					Remote *is*; the sequence is what gets a Workspace one, and it is the same component the
					navigation bar's control opens (`ConnectToGitHub`, reached through `connectSequence`).
					Two implementations of connecting is the outcome this arrangement exists to prevent — the
					sequence picks the repository from what GitHub says the author has granted, so nothing
					below has to be typed correctly from memory.
				-->
				{#if sequenceOffered}
					<div class="mt-3">
						<button
							class="btn btn-primary btn-sm"
							data-testid="open-connect-sequence"
							onclick={() => connectSequence.start()}
						>
							Connect to GitHub
						</button>
					</div>
				{/if}
				<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void bind(event)}>
					<div class="flex flex-col gap-1">
						<label class="text-sm font-medium" for={repositoryId}>Repository</label>
						<input
							id={repositoryId}
							class="input w-full max-w-md input-sm"
							bind:value={repository}
							data-testid="remote-repository-field"
							placeholder="owner/repository"
							autocomplete="off"
							spellcheck="false"
						/>
						<!--
							The repository has to exist and be public before an address of it can be pasted here.
							Making one is the guided sequence's, which offers GitHub's own new-repository screen
							with the name filled in and then tells the author what to do there — so this field
							says the requirement and sends nobody to a second copy of that offer.
						-->
						<p class="text-sm opacity-70">
							It has to be public.{#if sequenceOffered}
								Do not have one yet? <strong>Connect to GitHub</strong> above makes one with you.
							{/if}
						</p>
					</div>
					<!--
						⚠ **The token field is gated on the same predicate the sign-in button is, inverted.** Where
						this deployment has an App there is one credential and the scholar never chooses between
						two, so the field is not on the screen at all — not disabled, not annotated “(not needed)”,
						not present and empty. Where there is no App the paste is this fork's whole authentication
						and it is the plain content of the form, which is the promise `docs/hosting.md` Part 1
						opens with and does not get to break.
					-->
					{#if storage.signInWithGitHubOffered}
						<div>
							<button
								class="btn btn-ghost btn-xs"
								type="button"
								aria-expanded={bindPasteRevealed}
								data-testid="reveal-bind-token"
								onclick={() => (bindPasteRevealed = !bindPasteRevealed)}
							>
								Use a personal access token instead
							</button>
						</div>
					{/if}
					{#if !storage.signInWithGitHubOffered || bindPasteRevealed}
						<div class="flex flex-col gap-1">
							<label class="text-sm font-medium" for={tokenId}>
								Personal access token
								{#if storage.signedIn}<span class="font-normal opacity-70">(not needed)</span>{/if}
							</label>
							<input
								id={tokenId}
								class="input w-full max-w-md input-sm"
								type="password"
								bind:value={token}
								data-testid="remote-token-field"
								autocomplete="off"
								spellcheck="false"
							/>
							{#if storage.signedIn}
								<p class="text-sm opacity-70">
									You are signed in, so binding will use that. Leave this empty unless you want to
									bind with a personal access token instead.
								</p>
							{:else}
								<p class="text-sm opacity-70">
									A fine-grained personal access token with “Contents: Read and write” for that
									repository. It is checked the moment you press the button, kept only in this tab,
									and forgotten when you close it.
								</p>
							{/if}
						</div>
					{/if}
					<div>
						<button
							class="btn btn-primary btn-sm"
							type="submit"
							data-testid="bind-remote"
							disabled={working}
						>
							{working ? 'Asking GitHub…' : 'Bind this Workspace'}
						</button>
					</div>
				</form>
			{/if}
		</section>

		<!--
			⚠ **Signed in *or* bound, and the first half is what keeps Sign out reachable.** Gated on the
			binding alone, unbinding took the only Sign out button off the screen while `unbindRemote`
			deliberately left the credential alive — so "forget the credential, so this machine can be
			handed to somebody" became unreachable, and the token stayed in the tab for the rest of the
			session.

			`signedIn` reads the seal without asking about a review copy: the credential store answers
			`null` while one is open (ADR-0033), so a section gated on it alone would be absent from a
			review copy *because* the seal holds rather than because a condition remembered to say so.
			That stops being enough the moment a condition that does not read the seal is added beside
			it — see the next note.
		-->
		<!--
			⚠ **`signInWithGitHubOffered` is the third condition, and it is what makes the front door
			reachable at all.** Gated on "signed in or bound" alone, the only way to a sign-in was to
			bind first — which needs a pasted token — so the GitHub button would have been unreachable
			by exactly the scholar it exists for. It stays absent in a fork with no App, where there is
			nothing to reach.

			⚠ **And `review === null` is the fourth, because the third is a constant.** The paragraph
			above is true of `signedIn` and of `bound`, both of which read the seal — but
			`signInWithGitHubOffered` answers a question about the *deployment*, so on its own it put
			this whole section, sign-in button included, on the screen a student's submission is open
			on. A section that renders "because the seal holds" has to be gated on something the seal
			moves.
		-->
		{#if storage.review === null && (storage.signedIn || bound || storage.signInWithGitHubOffered)}
			<section class="rounded-box border border-base-300 p-4" data-testid="remote-sign-in-section">
				<h3 class="font-semibold">Your GitHub sign-in</h3>
				{#if storage.signedIn}
					<!--
						⚠ **The account is named here** (ADR-0041). It was in the Workspace menu's header, which
						no longer restates the credential — and *which* account is the question a scholar on a
						shared or a classmate's machine is actually asking. Read from the credential store rather
						than from anything remembered, so it says what is true: the store is sealed while a
						Review Workspace is open (ADR-0033), and a token that cannot be read is a token this
						screen must not claim to hold.
					-->
					<!--
						⚠ **The sentence states which of the two rules is in force**, rather than one wording
						that is true in both. What happens when this tab closes is the whole subject of the
						choice below it, and a scholar on a shared machine deciding whether to tick it is owed
						the current answer in the same breath (ADR-0041).
					-->
					<p class="mt-1 text-sm opacity-70" data-testid="remote-signed-in">
						Signed in to GitHub{storage.identity ? ` as ${storage.identity}` : ''}. The sign-in
						survives a reload{storage.rememberSignIn
							? `, and this computer keeps the renewable half of it so that coming back tomorrow does not mean signing in again. The eight-hour token itself is still forgotten when this tab closes.`
							: ` and is forgotten when this tab closes, so a shared machine keeps no credential.`}
					</p>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn btn-sm" data-testid="remote-sign-out" onclick={() => signOut()}>
							Sign out
						</button>
					</div>
				{:else}
					<p class="mt-1 text-sm opacity-70">Not signed in, so nothing can be published yet.</p>
					{#if storage.signInWithGitHubOffered}
						<!--
							The front door, and where an App is configured it is the only one on the screen: press,
							authorise on GitHub's own screen, come back. The paste is kept rather than replaced — a
							fork with no App of its own has nothing else (ADR-0031) — but it is behind the
							disclosure below rather than beside this.

							⚠ **Absent entirely when no App is configured**, which is what
							`signInWithGitHubOffered` answers. A button that redirects to an authorize URL with
							no client ID behind it is worse than no button: it takes the scholar to GitHub to be
							refused there, about a thing they cannot fix.
						-->
						<div class="mt-3 flex flex-col gap-1">
							<button
								class="btn w-fit btn-primary btn-sm"
								data-testid="sign-in-with-github"
								disabled={working}
								onclick={() => beginSignIn()}
							>
								Sign in with GitHub
							</button>
							<p class="text-sm opacity-70">
								This takes you to GitHub, where you choose which repositories Ballastella may touch,
								and brings you back. Nothing is kept on this computer beyond this tab.
							</p>
						</div>
						<!--
							⚠ **The escape hatch, and it is deliberately not a peer of the button above.** A paste
							form of equal weight beside the sign-in is the two-doors arrangement a scholar cannot
							read: two credentials on one screen and nothing saying which is meant for them. So it
							is a disclosure, closed, worded for somebody who already knows what a personal access
							token is — the instructor whose App installation has broken during a class, not the
							student.
						-->
						<p class="mt-3">
							<button
								class="btn btn-ghost btn-xs"
								type="button"
								aria-expanded={signInPasteRevealed}
								data-testid="reveal-sign-in-token"
								onclick={() => (signInPasteRevealed = !signInPasteRevealed)}
							>
								Sign in with a personal access token instead
							</button>
						</p>
					{:else}
						<p class="mt-1 text-sm opacity-70">Paste a token to sign in again.</p>
					{/if}
					{#if !storage.signInWithGitHubOffered || signInPasteRevealed}
						<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void signIn(event)}>
							<div class="flex flex-col gap-1">
								<label class="text-sm font-medium" for={signInTokenId}>Personal access token</label>
								<input
									id={signInTokenId}
									class="input w-full max-w-md input-sm"
									type="password"
									bind:value={signInToken}
									data-testid="remote-sign-in-field"
									autocomplete="off"
									spellcheck="false"
								/>
							</div>
							<div>
								<button
									class="btn btn-primary btn-sm"
									type="submit"
									data-testid="remote-sign-in"
									disabled={working}
								>
									{working ? 'Asking GitHub…' : 'Sign in'}
								</button>
							</div>
						</form>
					{/if}
				{/if}
				<!--
					⚠ **Unticked until the author ticks it, and this is a plain control rather than its final
					home** (ADR-0041). The rule narrows rather than falls: a scholar on a shared or lab
					machine changes nothing and keeps the old behaviour, and a durable credential is never a
					default somebody else chose.

					Offered signed out as well as signed in, because it is a decision about this machine
					rather than about the sign-in currently held — and answering it before pressing the
					button is the order a person actually meets it in.
				-->
				<div class="mt-4 border-t border-base-300 pt-3">
					<label class="flex items-start gap-2 text-sm" for={rememberId}>
						<input
							id={rememberId}
							class="checkbox mt-0.5 checkbox-sm"
							type="checkbox"
							data-testid="remember-sign-in"
							checked={storage.rememberSignIn}
							onchange={(event) => storage.setRememberSignIn(event.currentTarget.checked)}
						/>
						<span>
							Keep me signed in on this computer.
							<span class="block opacity-70">
								Only the part that renews the sign-in is kept, never the token that publishes, and
								it is kept outside every Workspace — a Backup and a Publish carry no part of it.
								Leave this off on a shared or library computer.
							</span>
						</span>
					</label>
				</div>
			</section>
		{/if}

		<!--
			⚠ **Outside every condition above, and offered to a Review Workspace too.** This makes or
			selects an *ordinary* Workspace rather than touching this one, so none of the reasons a review
			copy may not be bound or published apply to it — and a reviewer who wants their own copy of
			the work they are looking at is a reasonable person, not a promotion route (ADR-0024). The
			review copy stays a review copy either way. It needs no credential, so it is deliberately not
			inside the sign-in section either.
		-->
		<section class="rounded-box border border-base-300 p-4">
			<h3 class="font-semibold">Open a Workspace from GitHub</h3>
			<p class="mt-1 text-sm opacity-70">
				Download somebody's published Workspace into a new Workspace of your own. It has to be a
				public repository, and you do not need a GitHub account or a token to do this. Nothing you
				already have is changed — the Workspace you are in now is left exactly as it is. This
				computer keeps one Workspace for each repository, so opening the same one again takes you
				back to it rather than downloading a second copy.
			</p>
			<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void openFromGitHub(event)}>
				<div class="flex flex-col gap-1">
					<label class="text-sm font-medium" for={openRepositoryId}>Repository to open</label>
					<input
						id={openRepositoryId}
						class="input w-full max-w-md input-sm"
						bind:value={openRepository}
						data-testid="open-repository-field"
						placeholder="owner/repository"
						autocomplete="off"
						spellcheck="false"
					/>
				</div>
				<div>
					<!--
						`aria-disabled` for the busy state and never `disabled`: a `disabled` button leaves the
						tab order the moment it is pressed, dropping a keyboard user's focus to `<body>` for
						the length of a download that runs in minutes (WCAG 2.4.3).
					-->
					<button
						class="btn btn-primary btn-sm"
						class:btn-disabled={opening}
						aria-disabled={opening}
						type="submit"
						data-testid="open-from-github"
					>
						{opening ? 'Opening…' : 'Open a Workspace from GitHub'}
					</button>
				</div>
			</form>
			<!--
				Per-file progress, announced. A Map Image's pyramid is thousands of files over real minutes,
				and this is one of the places a scholar is waiting on something they cannot see.
				`role="status"` so it reaches assistive technology without interrupting, which is
				CONTRIBUTING's mandated method for exactly this.
			-->
			{#if storage.transfer && opening}
				<p role="status" class="mt-3 text-sm" data-testid="open-progress">
					{storage.transfer.files} of {storage.transfer.totalFiles} files downloaded from
					{storage.transfer.subject}.
				</p>
			{/if}
		</section>

		<!--
			What happened, announced. `aria-live="polite"` rather than `role="alert"` for the outcome,
			which is CONTRIBUTING's mandated method for a status; the refusal below is inserted at the
			moment its text first exists, which a polite region does not reliably announce.
		-->
		<p aria-live="polite" class="text-sm" data-testid="remote-outcome">{outcome}</p>
		{#each notices as notice (notice)}
			<div role="status" class="alert flex-col items-start alert-warning">
				<p data-testid="remote-notice">{notice}</p>
			</div>
		{/each}
		{#if problem}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<p data-testid="remote-problem">{problem}</p>
			</div>
		{/if}
	</div>

	{#snippet actions()}
		<button class="btn" data-testid="close-remote-settings" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>
