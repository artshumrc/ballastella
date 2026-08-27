<script lang="ts">
	import {
		describeRemote,
		readGrantedRepositories,
		type GrantedRepositoriesOutcome,
		type GrantedRepository,
		type RemoteBindOutcome
	} from '@ballastella/core';

	import {
		connectSequence,
		gitHubAccountKnown,
		rememberGitHubAccount
	} from '$lib/connect-sequence.svelte.js';

	import ModalDialog from './ModalDialog.svelte';
	import RepositoryChoice from './RepositoryChoice.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * The one guided sequence that leaves a Workspace with a repository on GitHub it can publish to
	 * (SPEC stories 1, 2, 7–9, 26–32, 36, 43, 44).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE STEP IS DERIVED FROM WHAT IS TRUE, NEVER FROM A POSITION IT REMEMBERS
	 *
	 * ⚠ **There is no counter here and there must never be one.** A remembered position is a second
	 * source of truth free to disagree with the first, and the states it gets wrong are exactly the ones
	 * that matter: a sign-in that ended while the sequence was open, an author who signed in on another
	 * surface, a Workspace that another tab connected. Every one of those moves this sequence on its own,
	 * because {@link step} is a reading of the same facts every other screen reads.
	 *
	 * The two `$effect`s are both requests rather than values — the listing read, and the freshness
	 * check the moment the sequence opens. Everything else is `$derived`, per the project's standing
	 * preference.
	 *
	 * ⚠ **The one thing remembered is that the account step has been offered, and it is a hint.**
	 * Whether a stranger has a GitHub account is the single fact here nothing can read: GitHub will
	 * not answer it, so the first step *states the prerequisite* rather than detecting it, and only
	 * "this has been said already" is worth keeping (SPEC stories 3–6, 34). A held credential
	 * overrules it, so the hint can never hold the sequence behind where reality has got to.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ⚠ NO STEP OF THIS SEQUENCE IS A FULL STOP
	 *
	 * SPEC story 35, and it is a property of every branch rather than of one of them. A sign-in GitHub
	 * declined, a sign-in that ran out, a listing GitHub would not answer, a listing the network lost,
	 * a repository the author cannot publish to, a Workspace the Remote's contents would destroy — each
	 * one names what to do and renders the control that does it, on the same screen. Nothing here may
	 * render a refusal whose only sequel is the Close button.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * CONNECTING IS ONE ACT, AND IT IS THE EXISTING CODE
	 *
	 * `connect` calls `WorkspaceStorage.bindRemote`, which checks push rights before any bytes move,
	 * writes the binding, and offers Pages — in that order, for the reasons `bind-remote.ts` records.
	 * There is no second path to any of the three here, and Pages is never asked for separately. What
	 * this component adds is the rendering of what comes back:
	 *
	 * - a credential that cannot publish there, where the connection **stands** and the author is told
	 *   they cannot publish to it and why;
	 * - Pages left off, where the connection **stands** and the author gets the sentence naming the
	 *   setting, where it is, and what to choose;
	 * - and the refusal that protects a Workspace whose Remote carries Projects it has not got, where
	 *   the connection does **not** happen and the Projects are named.
	 *
	 * ⚠ **The last of those is a refusal and not a warning.** Publishing over it would delete somebody's
	 * work, so the sequence goes back to the choice rather than offering to proceed.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE SENTENCES THE OUTCOMES CARRY ARE `packages/core`'s OWN
	 *
	 * `rightsNotice`, the Pages instruction and every refusal are rendered exactly as `bind-remote`
	 * composes them. They name a permission on GitHub's own settings screens and are the one thing in
	 * the sequence that may have to be done by hand, so they have to be complete rather than pleasant —
	 * and a second wording here would be a second thing to keep in step with GitHub's interface. Every
	 * word this component writes for itself is about the author's map and their repository.
	 */
	let {
		open = $bindable(false),
		storage,
		onpublish,
		list = (token: string) => readGrantedRepositories({ token })
	}: {
		open?: boolean;
		storage: WorkspaceStorage;
		/** Hand off to the Publish button that already exists. Called with the sequence closing. */
		onpublish: () => void;
		/**
		 * The listing read, injectable so every step of the sequence is a test costing milliseconds.
		 * Defaults to the one read of GitHub's installation endpoints there is.
		 */
		list?: (token: string) => Promise<GrantedRepositoriesOutcome>;
	} = $props();

	/**
	 * The steps this sequence has, and the gaps where the rest of the epic's are.
	 *
	 * `no-app` — the paste, in a deployment that has registered no App — and `creating` belong to later
	 * tickets. They are absent rather than stubbed: a half-working state is worse than one whose
	 * absence is visible.
	 *
	 * `sign-in-ended` is not a step of the path so much as the one place the path can be thrown back
	 * to from anywhere: an eight-hour sign-in that ran out and could not be renewed. It exists as a
	 * step of its own so that an expiry reads as an expiry, rather than as a Workspace with no
	 * repositories or as a publish that failed (SPEC story 63).
	 */
	type Step =
		| 'needs-account'
		| 'needs-sign-in'
		| 'sign-in-ended'
		| 'loading-choices'
		| 'choosing'
		| 'connecting'
		| 'connected';

	/** What GitHub answered about the grant, or `null` while nothing has been asked. */
	let listing = $state<GrantedRepositoriesOutcome | null>(null);
	/** The repository being connected, which is what makes `connecting` a state of the world. */
	let connecting = $state<GrantedRepository | null>(null);
	/** What the connection succeeded *with*: rights that cannot publish, and Pages left off. */
	let notices = $state<string[]>([]);
	/** Why the last press did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/** Whether the address has just been put on the clipboard, so the press says it worked. */
	let copied = $state(false);
	/**
	 * Whether the account step is behind this author (stories 3–6).
	 *
	 * Read from the tab at mount rather than held in the module, so that a reload — which is what
	 * coming back from making an account on GitHub often is — lands where the author had got to.
	 */
	let accountKnown = $state(gitHubAccountKnown());
	/** The sentence a sign-in that ran out is reported with, or `''`. `packages/core`'s own. */
	let expiry = $state('');
	/**
	 * That the author of an already-connected Workspace has asked for a different repository.
	 *
	 * ⚠ **Not a position, and it survives nothing.** It is a fact about what was just pressed, and
	 * closing the sequence forgets it — a Workspace with a Remote opens on the Remote it has, which is
	 * the true reading of the facts (story 62).
	 */
	let changing = $state(false);

	const bound = $derived(storage.remote);
	const boundName = $derived(bound === null ? '' : describeRemote(bound));
	const connectingName = $derived(connecting === null ? '' : describeRemote(connecting));

	const step = $derived<Step>(
		bound !== null && !changing
			? 'connected'
			: connecting !== null
				? 'connecting'
				: !storage.signedIn
					? expiry !== ''
						? 'sign-in-ended'
						: accountKnown
							? 'needs-sign-in'
							: 'needs-account'
					: listing === null
						? 'loading-choices'
						: 'choosing'
	);

	/**
	 * The address the Published Site will answer at (story 32).
	 *
	 * GitHub Pages serves a user or organisation's own `<login>.github.io` repository at the domain
	 * root and every other repository in a folder beneath it, so the two cases are one line apart and
	 * the wrong one is an address that answers nothing. Case-insensitively, because GitHub's own
	 * comparison is: `Ada/Ada.github.io` is the root site too.
	 */
	const publishedSiteAddress = $derived.by(() => {
		if (bound === null) return '';
		const host = `${bound.owner.toLowerCase()}.github.io`;
		return bound.repository.toLowerCase() === host
			? `https://${host}/`
			: `https://${host}/${bound.repository}/`;
	});

	/** Which account this is, for somebody on a shared or a classmate's machine (story 9). */
	const account = $derived(
		storage.signedIn
			? storage.identity
				? `Signed in to GitHub as ${storage.identity}.`
				: 'Signed in to GitHub.'
			: ''
	);

	/**
	 * What has just become true, for a reader who cannot see the step change (story 66).
	 *
	 * One region whose words change with the step, rather than a live region per step: a region that is
	 * inserted at the same moment its text first exists is not reliably announced (ADR-0016's
	 * amendment), and the whole point here is that the announcement arrives on every change.
	 */
	const announcement = $derived(
		step === 'needs-account'
			? 'Step 1 of 4: you need a GitHub account.'
			: step === 'needs-sign-in'
				? 'Step 2 of 4: sign in to GitHub.'
				: step === 'sign-in-ended'
					? 'Your GitHub sign-in has ended. Sign in again to carry on.'
					: step === 'loading-choices'
						? 'Step 3 of 4: asking GitHub which repositories you have given Ballastella access to.'
						: step === 'choosing'
							? 'Step 3 of 4: choose where your map goes.'
							: step === 'connecting'
								? `Step 4 of 4: connecting ${connectingName}.`
								: `Done: this Workspace is on GitHub at ${boundName}.`
	);

	const title = $derived(step === 'connected' ? 'Your repository on GitHub' : 'Connect to GitHub');

	/**
	 * Where GitHub's own sign-up lives (stories 4 and 5).
	 *
	 * A constant rather than a computed address: there is nothing about this author to put in it, and
	 * the one thing that could go wrong is sending a student somewhere that is not GitHub.
	 */
	const SIGN_UP_ADDRESS = 'https://github.com/signup';

	/**
	 * Ask GitHub what the author has granted, once a credential exists to ask with.
	 *
	 * ⚠ **The one legitimate effect in this component.** It is a request rather than a value, and the
	 * moment to make it is when a credential first becomes available — which is not a moment any press
	 * on this screen owns: an author who signs in comes back through a redirect, and one who signed in
	 * on another surface never pressed anything here at all.
	 *
	 * Nothing is remembered across a close, so reopening asks again. A repository granted on GitHub's
	 * own screen a moment ago is exactly what the sequence has to be able to see.
	 */
	$effect(() => {
		if (!open) {
			// ⚠ **This component is mounted for the page's life, so nothing else clears any of this.**
			// Left behind, the Pages instruction from a connection made an hour ago is still on screen the
			// next time anybody opens the sequence — over a Workspace it may have nothing to say about.
			//
			// `changing` goes with them, so a Workspace that has a Remote reopens on the Remote it has:
			// asking for a different repository is a press, never a place the sequence sits in.
			listing = null;
			notices = [];
			problem = '';
			copied = false;
			changing = false;
			expiry = '';
			connectSequence.signInRefusal = '';
			return;
		}
		// A credential in hand settles the one question the account step exists to ask, so an author who
		// signs out, or whose sign-in runs out, is put back at the sign-in and not at the beginning
		// (stories 6 and 10). Written and not read here, so this cannot re-enter itself.
		if (storage.signedIn) {
			accountKnown = true;
			rememberGitHubAccount();
		}
		if ((bound !== null && !changing) || !storage.signedIn || listing !== null) return;
		const token = storage.credential;
		if (token === null) return;
		void list(token).then(
			(answer) => {
				listing = answer;
			},
			(cause: unknown) => {
				// ⚠ **Rendered as a refusal of the listing rather than as a loose error**, because the
				// alternative is the `loading-choices` step saying "asking GitHub…" for ever with a
				// sentence underneath it and nothing to press (story 35). A refusal has a Try again.
				const detail = cause instanceof Error ? cause.message : String(cause);
				listing = {
					kind: 'refused',
					refusal: 'network',
					message:
						`Your repositories on GitHub could not be read. The browser reported: ${detail}. ` +
						`Everything you have is still saved on this computer.`
				};
			}
		);
	});

	/**
	 * Ask whether the held sign-in has life left in it, the moment the sequence opens.
	 *
	 * ⚠ **An expiry is answered before any work starts, never during it** (story 63). A GitHub App's
	 * user token lasts eight hours; met partway through a connection, the end of one would report
	 * itself as a repository that refused the author. `ensureCredentialFresh` renews it through the
	 * broker where it can and ends the session where it cannot, and what it throws is the sentence
	 * `packages/core` composes for exactly this — rendered as it arrives, because a wording of ours
	 * would be a second account of a lifetime GitHub owns.
	 *
	 * The same call `RemoteSettings` makes on opening, and for the same reason: this is now the screen
	 * a scholar comes to when they suspect their sign-in has gone.
	 */
	$effect(() => {
		if (!open) return;
		void storage.ensureCredentialFresh().catch((cause: unknown) => {
			expiry = cause instanceof Error ? cause.message : String(cause);
		});
	});

	/**
	 * Leave for GitHub, having marked the tab so that the return comes back here (story 8).
	 *
	 * ⚠ **The mark goes down before the call, because the call navigates.** `beginGitHubSignIn`
	 * assigns `location` and *then* returns `''`, so there is no moment after it in which this page is
	 * still the one on screen. A refusal means the trip never started, and the mark comes back up.
	 */
	function beginSignIn(): void {
		problem = '';
		connectSequence.signInRefusal = '';
		connectSequence.leavingForGitHub(false);
		problem = storage.beginGitHubSignIn();
		if (problem !== '') connectSequence.leavingForGitHub(true);
	}

	/** Take the account step as read, whether it was read or acted on (stories 3–6). */
	function passAccountStep(): void {
		accountKnown = true;
		rememberGitHubAccount();
	}

	/**
	 * Ask GitHub for the listing again, after a refusal that was not about the sign-in.
	 *
	 * Clearing the answer is the whole of it: the read is an effect over "a credential is held and
	 * nothing has been asked yet", so forgetting what came back is what asks again (story 25).
	 */
	function readAgain(): void {
		problem = '';
		listing = null;
	}

	/**
	 * Forget the credential and who it belonged to, so the next person at this machine is nobody
	 * (story 10).
	 *
	 * The sequence stays open on whichever step is then true, which is the sign-in: signing out is a
	 * step backwards through the sequence rather than a way out of it.
	 */
	function signOut(): void {
		problem = '';
		expiry = '';
		listing = null;
		notices = [];
		storage.signOut();
	}

	/**
	 * Connect the chosen repository: rights, the binding, and Pages, as one press (story 26).
	 *
	 * ⚠ **A refusal leaves `connecting` cleared, so the sequence goes back to the choice.** That is what
	 * makes the subset refusal a refusal: the author is told what is on the repository that is not here,
	 * and the only thing on offer is a different repository.
	 */
	async function connect(repository: GrantedRepository): Promise<void> {
		problem = '';
		notices = [];
		connecting = repository;
		try {
			const outcome: RemoteBindOutcome = await storage.bindRemote(
				{ owner: repository.owner, repository: repository.repository },
				null
			);
			notices = [
				...(outcome.rightsNotice ? [outcome.rightsNotice] : []),
				...(outcome.pages.instruction ? [outcome.pages.instruction] : [])
			];
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			connecting = null;
			// Whatever came back, the request for a different repository has been answered.
			changing = false;
		}
	}

	/**
	 * Put the address on the clipboard, for pasting into a submission form (story 43).
	 *
	 * The address is visible text as well, because a browser that refuses clipboard access must not
	 * leave the author with no way to read it.
	 */
	async function copyAddress(): Promise<void> {
		copied = false;
		try {
			await navigator.clipboard.writeText(publishedSiteAddress);
			copied = true;
		} catch {
			problem =
				`This browser would not let the page put anything on the clipboard, so copy the address ` +
				`above by hand. It is usually a permission for this site.`;
		}
	}

	function publish(): void {
		open = false;
		onpublish();
	}
</script>

<ModalDialog bind:open {title} wide>
	<div class="flex flex-col gap-4" data-testid="connect-sequence">
		<!--
			The step, said for a reader who cannot see it change (story 66). `role="status"` so it reaches
			assistive technology without interrupting, which is CONTRIBUTING's mandated method for exactly
			this, and it is in the document from the first frame so every later change is an update to a
			region that is already there.
		-->
		<p role="status" class="sr-only" data-testid="connect-step">{announcement}</p>

		{#if step === 'needs-account'}
			<!--
				⚠ **Offered, never detected** (stories 3–5). GitHub cannot be asked whether a stranger has
				an account, so an interface claiming to know would be a guess rendered as a fact — and a
				question the author had to answer before anything happened would be a step everybody pays
				for so that one person is not surprised. This states the prerequisite, says what it is for
				and that it costs nothing, and offers both ways onward. Somebody who already has an
				account is one press from the sign-in; somebody who has not is one press from making one.
			-->
			<section data-testid="connect-needs-account">
				<h3 class="font-semibold">You need a GitHub account</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					GitHub is where your map will live once it is on the web: it holds your work, and it is
					what answers when somebody opens the address you give them. An account is free, and making
					one takes a minute.
				</p>
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<!-- `resolve()` is for this app's own routes; github.com is not one, so the rule is
					     disabled here for the one case it does not cover, as the Remote section's own
					     link to GitHub already is. -->
					<!-- eslint-disable svelte/no-navigation-without-resolve -->
					<a
						class="btn btn-primary btn-sm"
						href={SIGN_UP_ADDRESS}
						rel="noreferrer noopener"
						target="_blank"
						data-testid="connect-sign-up"
						onclick={() => passAccountStep()}
					>
						Make a GitHub account
					</a>
					<!-- eslint-enable svelte/no-navigation-without-resolve -->
					<button
						class="btn btn-sm"
						data-testid="connect-have-account"
						onclick={() => passAccountStep()}
					>
						I already have one
					</button>
				</div>
				<p class="mt-3 max-w-prose text-sm opacity-70">
					GitHub opens in a second tab, so this one stays where it is. Come back to it when you have
					an account and carry on from the next step.
				</p>
			</section>
		{:else if step === 'sign-in-ended'}
			<!--
				⚠ **An expiry reads as an expiry** (story 63). A sign-in from GitHub lasts eight hours, and
				one that has run out makes every later request fail — as a listing with no repositories in
				it, or as a repository that refused the author, unless something says what actually
				happened first. `packages/core`'s sentence says it, and says the remedy.
			-->
			<section data-testid="connect-sign-in-ended">
				<h3 class="font-semibold">Your GitHub sign-in has ended</h3>
				<p class="mt-3 max-w-prose" data-testid="connect-expiry">{expiry}</p>
				<button
					class="btn mt-3 w-fit btn-primary btn-sm"
					data-testid="connect-sign-in-with-github"
					onclick={() => beginSignIn()}
				>
					Sign in with GitHub
				</button>
			</section>
		{:else if step === 'needs-sign-in'}
			<section data-testid="connect-sign-in">
				<h3 class="font-semibold">Sign in to GitHub</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					GitHub is where your map will live once it is on the web. Pressing this takes you to
					GitHub, where you choose which repositories Ballastella may work with, and brings you back
					here to carry on. Nothing is kept on this computer beyond this tab.
				</p>
				<!--
					⚠ **A decline on GitHub's own screen happened on a document this component did not
					exist in** — the App sign-in replaces the page — so it arrives through
					`connectSequence` from the route that received the callback. Rendered here, above the
					button that starts the trip again, because the sequence reopens over the page that
					would otherwise be the only place it was said (story 35).
				-->
				{#if connectSequence.signInRefusal}
					<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="connect-sign-in-refused">{connectSequence.signInRefusal}</p>
					</div>
				{/if}
				<button
					class="btn mt-3 w-fit btn-primary btn-sm"
					data-testid="connect-sign-in-with-github"
					onclick={() => beginSignIn()}
				>
					Sign in with GitHub
				</button>
			</section>
		{:else if step === 'loading-choices'}
			<section data-testid="connect-loading-choices">
				<h3 class="font-semibold">Reading your repositories</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="connect-account">{account}</p>
				<p class="mt-3 max-w-prose">
					Asking GitHub which repositories you have given Ballastella access to…
				</p>
			</section>
		{:else if step === 'choosing'}
			<section data-testid="connect-choosing">
				<p class="max-w-prose text-sm opacity-70" data-testid="connect-account">{account}</p>
				{#if listing?.kind === 'listed'}
					<RepositoryChoice
						repositories={listing.repositories}
						onchoose={(repository) => void connect(repository)}
					/>
				{:else if listing?.kind === 'refused'}
					<!--
						`github-installations` answers a rejected sign-in as a refusal rather than as an empty
						list, deliberately, and its own sentence is what says which. Rendered as it arrives:
						a wording of ours would be a second account of a thing only GitHub knows.
					-->
					<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="connect-choices-refused">{listing.message}</p>
						<!--
							⚠ **The remedy differs by refusal and both have one** (story 35). A sign-in GitHub
							will not act on is answered by signing in again; a GitHub that could not be
							reached is answered by asking it again, which is also the press story 25 wants
							for a return this screen did not notice.
						-->
						{#if listing.refusal === 'credential'}
							<button
								class="btn btn-sm"
								data-testid="connect-sign-in-again"
								onclick={() => beginSignIn()}
							>
								Sign in with GitHub
							</button>
						{:else}
							<button
								class="btn btn-sm"
								data-testid="connect-read-again"
								onclick={() => readAgain()}
							>
								Try again
							</button>
						{/if}
					</div>
				{/if}
			</section>
		{:else if step === 'connecting'}
			<section data-testid="connect-connecting">
				<h3 class="font-semibold">Connecting your repository</h3>
				<p class="mt-3 max-w-prose">
					Setting {connectingName} up as the place this Workspace publishes to, checking you may publish
					there, and turning GitHub Pages on. This is one step and there is nothing else to do.
				</p>
			</section>
		{:else}
			<section data-testid="connect-connected">
				<h3 class="font-semibold">Connected</h3>
				<p class="mt-1 max-w-prose" data-testid="connect-outcome">
					<code>{boundName}</code>
					is connected, so publishing sends this Workspace there and nowhere else. Setting up is over.
				</p>
				<!--
					The address, which is what the author was asked for: a link to give a professor or paste
					into a submission form (stories 32 and 43). Visible text as well as a copy, because a
					browser that refuses the clipboard must not leave them with nothing to read.
				-->
				<p class="mt-3 max-w-prose">
					Your published map will answer at
					<code data-testid="published-site-address">{publishedSiteAddress}</code>.
				</p>
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<button
						class="btn btn-sm"
						data-testid="copy-published-site-address"
						onclick={() => void copyAddress()}
					>
						Copy the address
					</button>
					<!--
						The handoff. It is the Publish button that has always been on the bar, opened from here
						rather than reimplemented — the sequence's job ends where publishing begins.
					-->
					<button
						class="btn btn-primary btn-sm"
						data-testid="connect-publish"
						onclick={() => publish()}
					>
						Publish…
					</button>
					<!--
						⚠ **Connecting once is not permanent** (story 62). A Workspace that has a Remote
						derives the connected step from having one, so the way back to the choice is a press
						that says the author wants a different one — and it is here, on the step they land on,
						rather than behind Workspace settings where the epic found it.
					-->
					<button
						class="btn btn-sm"
						data-testid="change-repository"
						onclick={() => (changing = true)}
					>
						Choose a different repository
					</button>
					<p aria-live="polite" class="text-sm opacity-70" data-testid="copied-address">
						{copied ? 'The address is on your clipboard.' : ''}
					</p>
				</div>
			</section>
		{/if}

		<!--
			What the connection stands *with*, and what refused it. Two regions rather than one, because
			the first is not a failure: a repository that is correctly connected stays connected when
			Pages could not be turned on, and rendering that as an error would tell an author their setup
			did not work when it did (stories 30 and 31).
		-->
		{#each notices as notice (notice)}
			<div role="status" class="alert flex-col items-start alert-warning">
				<p data-testid="connect-notice">{notice}</p>
			</div>
		{/each}
		{#if problem}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<p data-testid="connect-problem">{problem}</p>
			</div>
		{/if}
	</div>

	{#snippet actions()}
		<!--
			⚠ **Sign out is beside Close, so it is on every step a sign-in is held through** (story 10).
			The credential lasts as long as this tab and no longer, which is what makes a shared machine
			safe to walk away from — but "as long as the tab" is too long for somebody handing the seat
			over now, and Workspace settings is not where they would look for it.
		-->
		{#if storage.signedIn}
			<button class="btn" data-testid="connect-sign-out" onclick={() => signOut()}>Sign out</button>
		{/if}
		<!--
			⚠ **Closing is offered on every step, and it is what makes this a sequence rather than a
			trap** (story 33). Nothing is lost by it: the step is derived, so reopening reads the same
			facts and lands in the same place (story 34).
		-->
		<button class="btn" data-testid="close-connect-sequence" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>
