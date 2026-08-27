<script lang="ts">
	import {
		describeRemote,
		readGrantedRepositories,
		type GrantedRepositoriesOutcome,
		type GrantedRepository,
		type RemoteBindOutcome
	} from '@ballastella/core';

	import { connectSequence } from '$lib/connect-sequence.svelte.js';

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
	 * The one `$effect` is the listing read, which is a request rather than a value. Everything else is
	 * `$derived`, per the project's standing preference.
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
	 * `no-app` — the paste, in a deployment that has registered no App — and `needs-account`, leaving
	 * and resuming, `creating` and what an empty grant offers all belong to later tickets. They are
	 * absent rather than stubbed: a half-working state is worse than one whose absence is visible.
	 */
	type Step = 'needs-sign-in' | 'loading-choices' | 'choosing' | 'connecting' | 'connected';

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

	const bound = $derived(storage.remote);
	const boundName = $derived(bound === null ? '' : describeRemote(bound));
	const connectingName = $derived(connecting === null ? '' : describeRemote(connecting));

	const step = $derived<Step>(
		bound !== null
			? 'connected'
			: connecting !== null
				? 'connecting'
				: !storage.signedIn
					? 'needs-sign-in'
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
		step === 'needs-sign-in'
			? 'Step 1 of 3: sign in to GitHub.'
			: step === 'loading-choices'
				? 'Step 2 of 3: asking GitHub which repositories you have given Ballastella access to.'
				: step === 'choosing'
					? 'Step 2 of 3: choose where your map goes.'
					: step === 'connecting'
						? `Step 3 of 3: connecting ${connectingName}.`
						: `Done: this Workspace is on GitHub at ${boundName}.`
	);

	const title = $derived(step === 'connected' ? 'Your repository on GitHub' : 'Connect to GitHub');

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
			listing = null;
			notices = [];
			problem = '';
			copied = false;
			return;
		}
		if (bound !== null || !storage.signedIn || listing !== null) return;
		const token = storage.credential;
		if (token === null) return;
		void list(token).then(
			(answer) => {
				listing = answer;
			},
			(cause: unknown) => {
				problem = cause instanceof Error ? cause.message : String(cause);
			}
		);
	});

	/**
	 * Leave for GitHub, having marked the tab so that the return comes back here (story 8).
	 *
	 * ⚠ **The mark goes down before the call, because the call navigates.** `beginGitHubSignIn`
	 * assigns `location` and *then* returns `''`, so there is no moment after it in which this page is
	 * still the one on screen. A refusal means the trip never started, and the mark comes back up.
	 */
	function beginSignIn(): void {
		connectSequence.leavingForGitHub(false);
		problem = storage.beginGitHubSignIn();
		if (problem !== '') connectSequence.leavingForGitHub(true);
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

		{#if step === 'needs-sign-in'}
			<section data-testid="connect-sign-in">
				<h3 class="font-semibold">Sign in to GitHub</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					GitHub is where your map will live once it is on the web. Pressing this takes you to
					GitHub, where you choose which repositories Ballastella may work with, and brings you back
					here to carry on. Nothing is kept on this computer beyond this tab.
				</p>
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
		<button class="btn" data-testid="close-connect-sequence" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>
