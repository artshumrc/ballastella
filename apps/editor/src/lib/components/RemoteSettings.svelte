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
	 * the user opens this dialog, so somebody who never publishes is never shown a sign-in prompt
	 * (SPEC story 38).
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
	 * `::before`, so they are neither announced nor dismissable (ADR-0016, SPEC story 111).
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

	let repository = $state('');
	let token = $state('');
	let signInToken = $state('');
	let openRepository = $state('');
	/** Whether an Open is running, which is minutes rather than the moment a bind takes. */
	let opening = $state(false);
	/** Whether a request is in flight, so the button cannot be pressed twice. */
	let working = $state(false);
	/** What the last action did, in the words the user should see. */
	let outcome = $state('');
	/** Why the last action did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/**
	 * Sentences the binding succeeded *with*: a credential that cannot push, and Pages left off.
	 *
	 * Separate from {@link problem} because neither is a failure — the binding stands in both cases —
	 * and rendering them as errors would tell a scholar their Workspace is not bound when it is.
	 */
	let notices = $state<string[]>([]);

	const bound = $derived(storage.remote);
	/** A legacy binding waiting to be confirmed or declined, which is not yet a Remote. */
	const legacy = $derived(storage.legacyRemote);

	/**
	 * A repository name to prefill `github.com/new` with (story 8).
	 *
	 * The Workspace's own name, put through the character set GitHub allows in a repository name. The
	 * one step the tool does not do is still a short one when the field arrives filled in.
	 */
	const suggestedName = $derived(
		storage.name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^[-.]+|[-.]+$/g, '') || 'my-workspace'
	);
	const createRepositoryHref = $derived(
		`https://github.com/new?name=${encodeURIComponent(suggestedName)}`
	);

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
		if (!open) reset();
	});

	/**
	 * Check the held sign-in has life left in it, the moment this dialog is opened.
	 *
	 * ⚠ **Expiry is answered *before* work starts, never during it** (SPEC story 33). A GitHub App's
	 * user token lasts eight hours, and a publish that met the end of one partway through would leave
	 * blobs in no tree and a ref that never moved. `ensureCredentialFresh` renews it through the
	 * broker where it can and clears it where it cannot, so every screen then renders the
	 * not-signed-in state and the remedy is the button already on this one.
	 *
	 * This is the same call ticket 04's Publish makes before it starts, and it is here as well
	 * because this is the screen a scholar comes to when they suspect their sign-in has gone.
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
			notices = [
				...(result.rightsNotice ? [result.rightsNotice] : []),
				...(result.pages.instruction ? [result.pages.instruction] : [])
			];
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
		problem = storage.beginGitHubSignIn();
	}

	function signOut(): void {
		reset();
		storage.signOut();
		outcome = 'Signed out of GitHub. Nothing on this computer or on GitHub has been changed.';
	}

	/**
	 * Open a Workspace from GitHub (SPEC stories 96–104).
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

	async function acceptLegacy(): Promise<void> {
		reset();
		const lifted = legacy;
		working = true;
		try {
			await storage.acceptLegacyRemote();
			outcome =
				`This Workspace publishes to ${lifted ? describeRemote(lifted) : 'that repository'}. ` +
				`Ballastella has no record of what is there yet, so it cannot tell what has changed since ` +
				`the two last agreed — the next publish establishes that record.`;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	function declineLegacy(): void {
		reset();
		storage.declineLegacyRemote();
		outcome =
			'Left unbound. Nothing has been published and nothing on GitHub has changed. Bind this ' +
			'Workspace yourself if you do want it to publish somewhere.';
	}

	async function unbind(): Promise<void> {
		reset();
		const was = bound;
		try {
			await storage.unbindRemote();
			outcome =
				`This Workspace no longer publishes to ${was ? describeRemote(was) : 'a repository'}. ` +
				`Nothing there has been changed — the site is exactly as it was, and binding again puts ` +
				`things back.`;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<ModalDialog bind:open title="Remote repository" wide>
	<div class="flex flex-col gap-4">
		<section class="rounded-box border border-base-300 p-4">
			<h3 class="font-semibold">Where this Workspace publishes</h3>

			{#if storage.review !== null}
				<!--
					ADR-0024, SPEC story 39: somebody else's work is never published to your own address.
					Said in visible text rather than left as an absent control with no explanation — and
					refused in `packages/core` as well, so a guard that lives in markup is not the only one.
				-->
				<p class="mt-3 text-sm text-warning" data-testid="no-remote-in-review">
					This is a review copy of somebody else's Project, so it cannot be bound to a repository
					and no GitHub sign-in is readable while it is open. Go back to your own Workspace first.
				</p>
			{:else if legacy}
				<!--
					⚠ **A `remote.json` this installation cannot corroborate** (ADR-0038). The binding is a
					file inside the published tree, so a fork, a colleague's copied folder and a restored
					Backup all carry one naming somebody else's repository. Lifting it silently would aim a
					Publish button at a repository this author has never seen, so it is named and asked
					about — and until it is answered the Workspace is unbound and there is no bind form
					underneath to answer it by accident.
				-->
				<p class="mt-1 text-sm" data-testid="legacy-remote-offer">
					This Workspace's files say it was published to
					<code data-testid="legacy-remote">{describeRemote(legacy)}</code>, but this browser has no
					record of ever having published there. Only accept this if
					<code>{describeRemote(legacy)}</code> is your own repository — a copied folder or a fork carries
					somebody else's address.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<button
						class="btn btn-primary btn-sm"
						data-testid="accept-legacy-remote"
						disabled={working}
						onclick={() => void acceptLegacy()}
					>
						Yes, publish to {describeRemote(legacy)}
					</button>
					<button
						class="btn btn-outline btn-sm"
						data-testid="decline-legacy-remote"
						disabled={working}
						onclick={() => declineLegacy()}
					>
						No, leave this Workspace unbound
					</button>
				</div>
			{:else if bound}
				<p class="mt-1 text-sm opacity-70">
					Publishing sends this Workspace to
					<code data-testid="bound-remote">{describeRemote(bound)}</code>, on the branch
					<code>{bound.branch}</code>, and nowhere else.
				</p>
				<!--
					The Baseline, said in words. `Cannot tell` is a determination rather than a silence — see
					`NavigationBar`'s note — so it is stated here too, on the screen a scholar comes to when
					they want to know where their work goes.
				-->
				<p class="mt-1 text-sm opacity-70" data-testid="remote-baseline">
					{#if storage.baseline}
						Ballastella last agreed with {describeRemote(bound)} at commit
						<code>{storage.baseline.commit}</code>, over {storage.baseline.files.size} files.
					{:else}
						Cannot tell what has changed since this Workspace and {describeRemote(bound)} last agreed:
						there is no record of it on this computer.
					{/if}
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<!-- The same sequence the navigation bar opens, which for a bound Workspace names the
					     repository and the address its Published Site answers at. -->
					<button
						class="btn btn-sm"
						data-testid="open-connect-sequence"
						onclick={() => connectSequence.start()}
					>
						Show this Workspace's repository
					</button>
					<button
						class="btn btn-outline btn-sm btn-warning"
						data-testid="unbind-remote"
						disabled={working}
						onclick={() => unbind()}
					>
						Unbind from {describeRemote(bound)}
					</button>
				</div>
				<p class="mt-3 text-sm opacity-70">
					Unbinding only makes this computer forget the address. Nothing on GitHub is deleted and
					your published site goes on serving.
				</p>
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
				<div class="mt-3">
					<button
						class="btn btn-primary btn-sm"
						data-testid="open-connect-sequence"
						onclick={() => connectSequence.start()}
					>
						Connect to GitHub
					</button>
				</div>
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
						<p class="text-sm opacity-70">
							It has to be public. Do not have one yet?
							<!-- The one step the tool does not take, made short: the name arrives filled in.

							     `resolve()` is for this app's own routes; github.com is not one, so the rule
							     is disabled here for the one case it does not cover. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								class="link"
								href={createRepositoryHref}
								rel="noreferrer noopener"
								target="_blank"
								data-testid="create-repository"
							>
								Create “{suggestedName}” on GitHub
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							, choose <strong>Public</strong>, then come back here and paste its address.
						</p>
					</div>
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
								A fine-grained personal access token with “Contents: Read and write” and “Pages:
								Read and write” for that repository. It is checked the moment you press the button,
								kept only in this tab, and forgotten when you close it.
							</p>
						{/if}
					</div>
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
			⚠ **Signed in *or* bound, and the first half is what makes story 37 performable.** Gated on
			the binding alone, unbinding took the only Sign out button off the screen while
			`unbindRemote` deliberately left the credential alive — so "forget the credential, so this
			machine can be handed to somebody" became unreachable, and the token stayed in the tab for
			the rest of the session.

			`signedIn` reads the seal without asking about a review copy: the credential store answers
			`null` while one is open (ADR-0033, story 40), so a section gated on it alone would be absent
			from a review copy *because* the seal holds rather than because a condition remembered to
			say so. That stops being enough the moment a condition that does not read the seal is added
			beside it — see the next note.
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
			<section class="rounded-box border border-base-300 p-4">
				<h3 class="font-semibold">Your GitHub sign-in</h3>
				{#if storage.signedIn}
					<p class="mt-1 text-sm opacity-70" data-testid="remote-signed-in">
						Signed in to GitHub. The sign-in survives a reload and is forgotten when this tab
						closes, so a shared machine keeps no credential.
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
							The nicer front door (SPEC stories 32, 56). Offered first because it is the shorter
							path — press, authorise on GitHub's own screen, come back — and the paste is kept
							below it rather than replaced, because a fork with no App of its own has nothing
							else (ADR-0031).

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
						<p class="mt-3 text-sm opacity-70">Or paste a token instead:</p>
					{:else}
						<p class="mt-1 text-sm opacity-70">Paste a token to sign in again.</p>
					{/if}
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
				Per-file progress, announced. A Map Image's pyramid is thousands of files over real
				minutes, and this is one of the places a scholar is waiting on something they cannot see
				(workspace-and-layers SPEC story 96). `role="status"` so it reaches assistive technology
				without interrupting, which is CONTRIBUTING's mandated method for exactly this.
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
			moment its text first exists, which a polite region does not reliably announce (story 112).
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
