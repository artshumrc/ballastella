<script lang="ts">
	import {
		describeRemote,
		describeTokenProblem,
		parseRemoteReference,
		readGrantedRepositories,
		type GrantedRepositoriesOutcome,
		type GrantedRepository,
		type RemoteBindOutcome,
		type RemoteReference
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
	 * ONE DOOR WHERE THERE IS AN APP, AND THE DOOR THAT WORKS WHERE THERE IS NOT
	 *
	 * `storage.signInWithGitHubOffered` is `isGitHubAppConfigured(GITHUB_APP)`, already computed and
	 * already reactive, and it decides which of two first steps this sequence has. Where an App is
	 * configured the sequence never mentions a personal access token: a student cannot be asked to
	 * choose between two credentials if only one of them is on the screen (SPEC stories 37, 46).
	 *
	 * Where there is none — a fork that has registered no App of its own — the first step is the paste,
	 * because a sign-in button with no client ID behind it takes the author to GitHub to be refused
	 * there about a thing they cannot fix (stories 50–52). That path is the whole of such a fork's
	 * authentication, so it carries the guidance a fork's author needs rather than being a fallback:
	 * the repository has to be public, the deep link fills its name in, and the token's two
	 * permissions are named. `token` is a word this component may say **only** in that step, which is
	 * the exception the Brief's vocabulary rule carves out.
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
	 * `needs-account`, leaving and resuming, `creating` and what an empty grant offers all belong to
	 * later tickets. They are absent rather than stubbed: a half-working state is worse than one whose
	 * absence is visible.
	 */
	type Step =
		'no-app' | 'needs-sign-in' | 'loading-choices' | 'choosing' | 'connecting' | 'connected';

	/**
	 * Hydration-stable ids for the fork's own two fields, for the reason `NavigationBar` documents.
	 *
	 * One `$props.id()` suffixed twice, because Svelte allows exactly one call per component — and
	 * `for`/`id` is the whole of what ties a label to its field for a screen reader.
	 */
	const fieldId = $props.id();
	const repositoryFieldId = `${fieldId}-repository`;
	const tokenFieldId = `${fieldId}-token`;

	/** What the fork's author typed, in the step that is the only place this sequence has fields. */
	let repository = $state('');
	let token = $state('');

	/** What GitHub answered about the grant, or `null` while nothing has been asked. */
	let listing = $state<GrantedRepositoriesOutcome | null>(null);
	/** The repository being connected, which is what makes `connecting` a state of the world. */
	let connecting = $state<RemoteReference | null>(null);
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
				: !storage.signInWithGitHubOffered
					? 'no-app'
					: !storage.signedIn
						? 'needs-sign-in'
						: listing === null
							? 'loading-choices'
							: 'choosing'
	);

	/**
	 * A repository name to fill `github.com/new` in with, for the fork's own step.
	 *
	 * The Workspace's own name put through the character set GitHub allows, exactly as the Remote
	 * settings dialog does it: the one step the tool does not take is a short one when the field
	 * arrives filled in.
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
	/** How the connecting step counts itself, which differs by how many steps preceded it. */
	const lastStep = $derived(storage.signInWithGitHubOffered ? 'Step 3 of 3' : 'Step 2 of 2');

	const announcement = $derived(
		step === 'no-app'
			? 'Step 1 of 2: name your repository on GitHub and paste an access token for it.'
			: step === 'needs-sign-in'
				? 'Step 1 of 3: sign in to GitHub.'
				: step === 'loading-choices'
					? 'Step 2 of 3: asking GitHub which repositories you have given Ballastella access to.'
					: step === 'choosing'
						? 'Step 2 of 3: choose where your map goes.'
						: step === 'connecting'
							? `${lastStep}: connecting ${connectingName}.`
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
			repository = '';
			token = '';
			return;
		}
		// ⚠ **Not asked at all where there is no App.** `/user/installations` answers a GitHub App user
		// token and nothing else, so a fork whose author has pasted a personal access token would get a
		// refusal here — which would present to them as "you have no repositories" over a step they are
		// not on.
		if (bound !== null || !storage.signInWithGitHubOffered) return;
		if (!storage.signedIn || listing !== null) return;
		const credential = storage.credential;
		if (credential === null) return;
		void list(credential).then(
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
	async function connect(remote: RemoteReference, pasted: string | null): Promise<void> {
		problem = '';
		notices = [];
		connecting = remote;
		try {
			const outcome: RemoteBindOutcome = await storage.bindRemote(remote, pasted);
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

	/**
	 * The fork's own connect: the typed address and the pasted token, checked here before GitHub.
	 *
	 * ⚠ **Both refusals are `packages/core`'s and neither costs a request.** `parseRemoteReference`
	 * and `describeTokenProblem` catch the paste that went wrong — an empty clipboard, half a token, an
	 * address in the wrong field — and say which, which is the whole of what the Remote settings
	 * dialog's form does with the same two values. A refused token stays in the field: pasting
	 * eighty-two characters again to fix a one-character mistake is not a remedy.
	 */
	async function connectWithToken(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		problem = '';
		notices = [];

		const remote = parseRemoteReference(repository);
		if (remote === null) {
			problem =
				`“${repository.trim()}” is not a repository address. It looks like “owner/repository” — ` +
				`the two parts after github.com in your browser's address bar — and the whole of that ` +
				`address works too.`;
			return;
		}
		const tokenProblem = describeTokenProblem(token);
		if (tokenProblem !== '') {
			problem = tokenProblem;
			return;
		}

		await connect(remote, token.trim());
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

		{#if step === 'no-app'}
			<!--
				⚠ **The fork's whole door, and the one place in this sequence the word *token* is allowed.**
				This copy of Ballastella has registered no GitHub App, so there is no sign-in that could
				complete and none is offered (stories 50–52). What is offered instead is the path that needs
				no server and no account of anybody's — `docs/hosting.md` Part 1 §6 is the longer version —
				and it gets the guidance rather than a note under a field: the repository has to be public,
				its name arrives filled in, and the two permissions are named.
			-->
			<section data-testid="connect-no-app">
				<h3 class="font-semibold">Put this Workspace on GitHub</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					This copy of Ballastella has no GitHub sign-in set up, so it publishes with a personal
					access token you make on GitHub yourself. Nothing is sent anywhere but GitHub, and the
					token is kept only in this tab and forgotten when you close it.
				</p>
				<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void connectWithToken(event)}>
					<div class="flex flex-col gap-1">
						<label class="text-sm font-medium" for={repositoryFieldId}>
							Your repository on GitHub
						</label>
						<input
							id={repositoryFieldId}
							class="input w-full max-w-md input-sm"
							bind:value={repository}
							data-testid="connect-repository-field"
							placeholder="owner/repository"
							autocomplete="off"
							spellcheck="false"
						/>
						<p class="max-w-prose text-sm opacity-70">
							It has to be public. Do not have one yet?
							<!-- `resolve()` is for this app's own routes; github.com is not one, so the rule is
							     disabled here for the one case it does not cover. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								class="link"
								href={createRepositoryHref}
								rel="noreferrer noopener"
								target="_blank"
								data-testid="connect-create-repository"
							>
								Create “{suggestedName}” on GitHub
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							, choose <strong>Public</strong>, then come back to this tab.
						</p>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-sm font-medium" for={tokenFieldId}>Personal access token</label>
						<input
							id={tokenFieldId}
							class="input w-full max-w-md input-sm"
							type="password"
							bind:value={token}
							data-testid="connect-token-field"
							autocomplete="off"
							spellcheck="false"
						/>
						<p class="max-w-prose text-sm opacity-70">
							A fine-grained personal access token for that repository, with “Contents: Read and
							write” and “Pages: Read and write”. GitHub shows it once, on the page that makes it.
						</p>
					</div>
					<div>
						<button class="btn w-fit btn-primary btn-sm" type="submit" data-testid="connect-paste">
							Connect this Workspace
						</button>
					</div>
				</form>
			</section>
		{:else if step === 'needs-sign-in'}
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
						onchoose={(chosen: GrantedRepository) =>
							void connect({ owner: chosen.owner, repository: chosen.repository }, null)}
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
