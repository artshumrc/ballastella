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

	import {
		connectSequence,
		gitHubAccountKnown,
		rememberGitHubAccount
	} from '$lib/connect-sequence.svelte.js';

	import ModalDialog from './ModalDialog.svelte';
	import RepositoryChoice from './RepositoryChoice.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * The one guided sequence that leaves a Workspace with a repository on GitHub it can publish to.
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
	 * The three `$effect`s are all requests or subscriptions rather than values — the listing read, the
	 * freshness check the moment the sequence opens, and the two window events that notice the author
	 * coming back from the other tab. Everything else is `$derived`, per the project's standing
	 * preference.
	 *
	 * ⚠ **The one thing remembered is that the account step has been offered, and it is a hint.**
	 * Whether a stranger has a GitHub account is the single fact here nothing can read: GitHub will
	 * not answer it, so the first step *states the prerequisite* rather than detecting it, and only
	 * "this has been said already" is worth keeping. A held credential overrules it, so the hint can
	 * never hold the sequence behind where reality has got to.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ⚠ NO STEP OF THIS SEQUENCE IS A FULL STOP
	 *
	 * It is a property of every branch rather than of one of them. A sign-in GitHub declined, a
	 * sign-in that ran out, a listing GitHub would not answer, a listing the network lost, a
	 * repository the author cannot publish to, a Workspace the Remote's contents would destroy — each
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
	 * ONE DOOR WHERE THERE IS AN APP, AND THE DOOR THAT WORKS WHERE THERE IS NOT
	 *
	 * `storage.signInWithGitHubOffered` is `isGitHubAppConfigured(GITHUB_APP)`, already computed and
	 * already reactive, and it decides which of two first steps this sequence has. Where an App is
	 * configured the sequence never mentions a personal access token: a student cannot be asked to
	 * choose between two credentials if only one of them is on the screen.
	 *
	 * Where there is none — a fork that has registered no App of its own — the first step is the
	 * paste, because a sign-in button with no client ID behind it takes the author to GitHub to be
	 * refused there about a thing they cannot fix. That path is the whole of such a fork's
	 * authentication, so it carries the guidance a fork's author needs rather than being a fallback:
	 * the repository has to be public, the deep link fills its name in, and the token's two
	 * permissions are named. `token` is a word this component may say **only** in that step; every
	 * other step speaks of signing in.
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
	 * The steps this sequence has.
	 *
	 * `no-app` is the paste, and it is the whole of a fork's authentication rather than a fallback: a
	 * deployment with no App of its own opens there and never on a sign-in that cannot complete.
	 *
	 * `choices-refused` is separate from `no-choices` and must stay separate. `github-installations`
	 * answers a sign-in GitHub will not act on as a refusal rather than as an empty list precisely so
	 * that nothing tells a student they have no repository when what is wrong is the sign-in; folded
	 * into `no-choices`, that is exactly what this sequence would say in the one region a reader who
	 * cannot see the screen has.
	 *
	 * `sign-in-ended` is not a step of the path so much as the one place the path can be thrown back
	 * to from anywhere: an eight-hour sign-in that ran out and could not be renewed. It exists as a
	 * step of its own so that an expiry reads as an expiry, rather than as a Workspace with no
	 * repositories or as a publish that failed.
	 */
	type Step =
		| 'no-app'
		| 'needs-account'
		| 'needs-sign-in'
		| 'sign-in-ended'
		| 'loading-choices'
		| 'choosing'
		| 'no-choices'
		| 'choices-refused'
		| 'creating'
		| 'connecting'
		| 'connected';

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
	/**
	 * Whether the account step is behind this author.
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
	 * the true reading of the facts.
	 */
	let changing = $state(false);
	/**
	 * The repositories GitHub had answered with at the moment the second tab opened, or `null` when
	 * no repository is being made.
	 *
	 * ⚠ **This is the whole of what the editor knows about the other tab, and it must stay that way.**
	 * The editor cannot see GitHub's screen and must not pretend to: what it can do is ask GitHub the
	 * same question again and notice that the answer grew. So the comparison is against a set taken
	 * before the author left, and a repository absent then and present now is the one they just made.
	 */
	let madeAgainst = $state<ReadonlySet<string> | null>(null);
	/** How many times the listing has been re-read since the second tab opened. */
	let rereads = $state(0);
	/** Whether a re-read is in flight, so a focus storm is not a request storm. */
	let rereading = $state(false);

	const bound = $derived(storage.remote);
	const boundName = $derived(bound === null ? '' : describeRemote(bound));
	const connectingName = $derived(connecting === null ? '' : describeRemote(connecting));

	/** What GitHub last said the author has granted, and `[]` while it has said nothing or refused. */
	const granted = $derived<readonly GrantedRepository[]>(
		listing?.kind === 'listed' ? listing.repositories : []
	);

	/**
	 * The repositories that were not there when the second tab opened.
	 *
	 * Empty whenever no repository is being made, so the marks are only ever about a trip the author
	 * actually took.
	 */
	const newlyGranted = $derived.by<ReadonlySet<string>>(() => {
		const before = madeAgainst;
		if (before === null) return new Set<string>();
		return new Set(granted.map(describeRemote).filter((name) => !before.has(name)));
	});

	const step = $derived<Step>(
		bound !== null && !changing
			? 'connected'
			: connecting !== null
				? 'connecting'
				: // A deployment with no App of its own opens on the paste: a sign-in button with no client
					// ID behind it takes the author to GitHub to be refused about a thing they cannot fix.
					!storage.signInWithGitHubOffered
					? 'no-app'
					: !storage.signedIn
						? expiry !== ''
							? 'sign-in-ended'
							: accountKnown
								? 'needs-sign-in'
								: 'needs-account'
						: // ⚠ **A refusal is read before anything below it**, because `granted` is empty for a
							// refusal as well as for a grant of nothing, and every state under here treats that
							// emptiness as a fact about the grant. `readGrantedRepositories` answers a sign-in GitHub
							// will not act on as a refusal rather than as an empty list precisely so that nothing tells
							// a student their repository is missing when the read is what failed — and `creating` is
							// where that misreading does the most damage, since its own account of a listing that did
							// not grow is that access to the new repository was never granted.
							listing?.kind === 'refused'
							? 'choices-refused'
							: // ⚠ **Ahead of the listing's remaining states**, so a re-read under way does not put the
								// instructions for the other tab off the screen and replace them with “asking GitHub…”.
								// The step ends when GitHub answers with something that was not there before.
								madeAgainst !== null && newlyGranted.size === 0
								? 'creating'
								: listing === null
									? 'loading-choices'
									: granted.length === 0
										? 'no-choices'
										: 'choosing'
	);

	/**
	 * A repository name to prefill `github.com/new` with.
	 *
	 * The Workspace's own name, put through the character set GitHub allows in a repository name. The
	 * one step the tool does not take is still a short one when the field arrives filled in.
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
	 * Where an author grants this App access to a repository it has not got.
	 *
	 * ⚠ **This is the only way access is ever granted.** The endpoint that would add a repository to
	 * an installation is documented for classic personal access tokens only, so it is GitHub's own
	 * screen or nothing.
	 */
	const GRANT_ACCESS_HREF = 'https://github.com/settings/installations';

	/**
	 * The address the Published Site will answer at.
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

	/** Which account this is, for somebody on a shared or a classmate's machine. */
	const account = $derived(
		storage.signedIn
			? storage.identity
				? `Signed in to GitHub as ${storage.identity}.`
				: 'Signed in to GitHub.'
			: ''
	);

	/** How the connecting step counts itself, which differs by how many steps preceded it. */
	const lastStep = $derived(storage.signInWithGitHubOffered ? 'Step 4 of 4' : 'Step 2 of 2');

	/**
	 * What has just become true, for a reader who cannot see the step change.
	 *
	 * One region whose words change with the step, rather than a live region per step: a region that is
	 * inserted at the same moment its text first exists is not reliably announced (ADR-0016's
	 * amendment), and the whole point here is that the announcement arrives on every change.
	 */
	const announcement = $derived(
		step === 'no-app'
			? 'Step 1 of 2: name your repository on GitHub and paste an access token for it.'
			: step === 'needs-account'
				? 'Step 1 of 4: you need a GitHub account.'
				: step === 'needs-sign-in'
					? 'Step 2 of 4: sign in to GitHub.'
					: step === 'sign-in-ended'
						? 'Your GitHub sign-in has ended. Sign in again to carry on.'
						: step === 'loading-choices'
							? 'Step 3 of 4: asking GitHub which repositories you have given Ballastella access to.'
							: step === 'choosing'
								? 'Step 3 of 4: choose where your map goes.'
								: step === 'no-choices'
									? 'Step 3 of 4: you have given Ballastella access to no repository yet, so make one.'
									: step === 'choices-refused'
										? 'Step 3 of 4: your repositories on GitHub could not be read.'
										: step === 'creating'
											? 'Step 3 of 4: making a repository on GitHub, in the other tab.'
											: step === 'connecting'
												? `${lastStep}: connecting ${connectingName}.`
												: `Done: this Workspace is on GitHub at ${boundName}.`
	);

	const title = $derived(step === 'connected' ? 'Your repository on GitHub' : 'Connect to GitHub');

	/**
	 * Where GitHub's own sign-up lives.
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
			// The trip to the other tab is over either way by the time anybody opens the sequence again —
			// taken or abandoned — and the list is where both outcomes are legible: a repository that was
			// made is in it, one thought better of is simply absent. Keeping the step would put a
			// remembered press ahead of the reading of the world that produced it.
			madeAgainst = null;
			rereads = 0;
			repository = '';
			token = '';
			return;
		}
		// A credential in hand settles the one question the account step exists to ask, so an author
		// who signs out, or whose sign-in runs out, is put back at the sign-in and not at the
		// beginning. Written and not read here, so this cannot re-enter itself.
		if (storage.signedIn) {
			accountKnown = true;
			rememberGitHubAccount();
		}
		// ⚠ **Not asked at all where there is no App.** `/user/installations` answers a GitHub App user
		// token and nothing else, so a fork whose author has pasted a personal access token would get a
		// refusal here — which would present to them as "you have no repositories" over a step they are
		// not on.
		if (!storage.signInWithGitHubOffered) return;
		if ((bound !== null && !changing) || !storage.signedIn || listing !== null) return;
		const credential = storage.credential;
		if (credential === null) return;
		void list(credential).then(
			(answer) => {
				listing = answer;
			},
			(cause: unknown) => {
				// ⚠ **Rendered as a refusal of the listing rather than as a loose error**, because the
				// alternative is the `loading-choices` step saying "asking GitHub…" for ever with a
				// sentence underneath it and nothing to press. A refusal has a Try again.
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
	 * ⚠ **An expiry is answered before any work starts, never during it**. A GitHub App's user token
	 * lasts eight hours; met partway through a connection, the end of one would report itself as a
	 * repository that refused the author. `ensureCredentialFresh` renews it through the broker where
	 * it can and ends the session where it cannot, and what it throws is the sentence `packages/core`
	 * composes for exactly this — rendered as it arrives, because a wording of ours would be a second
	 * account of a lifetime GitHub owns.
	 *
	 * The same call `RemoteSettings` makes on opening, and for the same reason: this is the screen a
	 * scholar comes to when they suspect their sign-in has gone.
	 */
	$effect(() => {
		if (!open) return;
		void storage.ensureCredentialFresh().catch((cause: unknown) => {
			expiry = cause instanceof Error ? cause.message : String(cause);
		});
	});

	/**
	 * Ask GitHub again, which is the only thing the editor can do about the other tab.
	 *
	 * Guarded against overlapping reads: a window that regains focus also fires `visibilitychange` in
	 * some browsers, and an author alt-tabbing between two tabs would otherwise spend a request per
	 * flick of somebody's hourly budget.
	 */
	async function reread(): Promise<void> {
		const credential = storage.credential;
		if (credential === null || rereading) return;
		rereading = true;
		try {
			listing = await list(credential);
			rereads += 1;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			rereading = false;
		}
	}

	/**
	 * Note what GitHub had answered, so the return can be recognised.
	 *
	 * The press this hangs off is an ordinary link, so the second tab is the browser's own doing and
	 * nothing here has to survive a pop-up blocker.
	 */
	function beginCreating(): void {
		problem = '';
		rereads = 0;
		madeAgainst = new Set(granted.map(describeRemote));
	}

	/**
	 * Watch for the author coming back, for as long as they are away.
	 *
	 * ⚠ **Two events rather than one, and no timer.** A tab switched back to fires
	 * `visibilitychange`; a window raised over another application fires `focus` without it. Polling
	 * would spend a request a second on an event that has an event, so the manual control beside the
	 * instructions is what covers a browser that fires neither.
	 */
	$effect(() => {
		if (step !== 'creating') return;
		const observe = (): void => void reread();
		const onVisible = (): void => {
			if (document.visibilityState === 'visible') observe();
		};
		window.addEventListener('focus', observe);
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			window.removeEventListener('focus', observe);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	/**
	 * Leave for GitHub, having marked the tab so that the return comes back here.
	 *
	 * ⚠ **The mark goes down before the call, because the call navigates.** `beginGitHubSignIn`
	 * assigns `location` and *then* returns `''`, so there is no moment after it in which this page is
	 * still the one on screen. A refusal means the trip never started, and the mark comes back up.
	 */
	function beginSignIn(): void {
		problem = '';
		connectSequence.signInRefusal = '';
		connectSequence.leavingForGitHub();
		problem = storage.beginGitHubSignIn();
		if (problem !== '') connectSequence.notLeavingAfterAll();
	}

	/** Take the account step as read, whether it was read or acted on. */
	function passAccountStep(): void {
		accountKnown = true;
		rememberGitHubAccount();
	}

	/**
	 * Ask GitHub for the listing again, after a refusal that was not about the sign-in.
	 *
	 * Clearing the answer is the whole of it: the read is an effect over "a credential is held and
	 * nothing has been asked yet", so forgetting what came back is what asks again.
	 */
	function readAgain(): void {
		problem = '';
		listing = null;
	}

	/**
	 * Forget the credential and who it belonged to, so the next person at this machine is nobody.
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
	 * Connect the chosen repository: rights, the binding, and Pages, as one press.
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
			// Whatever came back, the request for a different repository has been answered.
			changing = false;
		}
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
			The step, said for a reader who cannot see it change. `role="status"` so it reaches assistive
			technology without interrupting, which is CONTRIBUTING's mandated method for exactly this, and
			it is in the document from the first frame so every later change is an update to a region that
			is already there.
		-->
		<p role="status" class="sr-only" data-testid="connect-step">{announcement}</p>

		{#if step === 'no-app'}
			<!--
				⚠ **The fork's whole door, and the one place in this sequence the word *token* is allowed.**
				This copy of Ballastella has registered no GitHub App, so there is no sign-in that could
				complete and none is offered. What is offered instead is the path that needs no server and
				no account of anybody's — `docs/hosting.md` Part 1 §6 is the longer version — and it gets
				the guidance rather than a note under a field: the repository has to be public, its name
				arrives filled in, and the two permissions are named.
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
		{:else if step === 'needs-account'}
			<!--
				⚠ **Offered, never detected**. GitHub cannot be asked whether a stranger has an account, so
				an interface claiming to know would be a guess rendered as a fact — and a question the
				author had to answer before anything happened would be a step everybody pays for so that one
				person is not surprised. This states the prerequisite, says what it is for and that it costs
				nothing, and offers both ways onward. Somebody who already has an account is one press from
				the sign-in; somebody who has not is one press from making one.
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
				⚠ **An expiry reads as an expiry**. A sign-in from GitHub lasts eight hours, and one that
				has run out makes every later request fail — as a listing with no repositories in it, or as
				a repository that refused the author, unless something says what actually happened first.
				`packages/core`'s sentence says it, and says the remedy.
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
					would otherwise be the only place it was said.
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
		{:else if step === 'choosing' || step === 'no-choices' || step === 'choices-refused'}
			<section
				data-testid={step === 'no-choices'
					? 'connect-no-choices'
					: step === 'choices-refused'
						? 'connect-refused-choices'
						: 'connect-choosing'}
			>
				<p class="max-w-prose text-sm opacity-70" data-testid="connect-account">{account}</p>
				{#if listing?.kind === 'listed'}
					<RepositoryChoice
						repositories={listing.repositories}
						newly={newlyGranted}
						onchoose={(chosen: GrantedRepository) =>
							void connect({ owner: chosen.owner, repository: chosen.repository }, null)}
					/>
					<!--
						⚠ **The action is here for a full list as well as an empty one**. Having nothing granted
						is the ordinary state of somebody who has just made an account, and an empty area whose
						only offer was to close the sequence would be the dead end this sequence exists to
						remove — but an author who wants a fresh repository rather than one of the ones listed
						needs the same offer, so it is beside the list rather than instead of it.
					-->
					<div class="m-4 flex flex-wrap items-center gap-3">
						<!-- `resolve()` is for this app's own routes; github.com is not one, so the rule is
						     disabled here for the one case it does not cover. -->
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							class="btn btn-sm"
							class:btn-primary={step === 'no-choices'}
							href={createRepositoryHref}
							rel="noreferrer noopener"
							target="_blank"
							data-testid="create-repository"
							onclick={() => beginCreating()}
						>
							Create a new one
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<p class="max-w-prose text-sm opacity-70" data-testid="create-repository-note">
							Opens GitHub in a second tab, with the name “{suggestedName}” already filled in. This
							tab stays where it is.
						</p>
					</div>
				{:else if listing?.kind === 'refused'}
					<!--
						`github-installations` answers a rejected sign-in as a refusal rather than as an empty
						list, deliberately, and its own sentence is what says which. Rendered as it arrives:
						a wording of ours would be a second account of a thing only GitHub knows.
					-->
					<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="connect-choices-refused">{listing.message}</p>
						<!--
							⚠ **The remedy differs by refusal and both have one**. A sign-in GitHub will not act
							on is answered by signing in again; a GitHub that could not be reached is answered by
							asking it again, which is also the press that covers a return this screen did not
							notice.
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
		{:else if step === 'creating'}
			<section data-testid="connect-creating">
				<h3 class="font-semibold">Making a repository on GitHub</h3>
				<!--
					⚠ **Three things, in this order, and the order is the point**. A student who installed
					Ballastella with *Only select repositories* before making this repository finds the new
					one outside the grant, and the editor cannot add it — the endpoint that would is
					documented for classic personal access tokens only. So: make it, then give access to it,
					then come back. Step 2 is the one everybody misses.
				-->
				<ol class="mt-3 flex max-w-prose list-decimal flex-col gap-2 pl-6">
					<li data-testid="creating-instruction">
						In the other tab, make the repository. <strong>It has to be public</strong>, or the
						published map will not answer for anybody you send the address to.
					</li>
					<li data-testid="creating-instruction">
						On the same screen, <strong>give Ballastella access to it</strong>. A repository made
						after Ballastella was installed is not covered by what you gave access to before, and
						this tab cannot add it for you.
					</li>
					<li data-testid="creating-instruction">Come back to this tab.</li>
				</ol>
				<p class="mt-3 max-w-prose text-sm opacity-70">
					Nothing needs to be typed here afterwards. Coming back to this tab is enough: GitHub is
					asked again and the repository you just made appears below.
				</p>
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<!--
						⚠ **The automatic re-read is a convenience and never the only way through**. A browser
						that fires neither `focus` nor `visibilitychange`, or an author who took a long detour,
						must still be able to carry on.
					-->
					<button
						class="btn btn-sm"
						data-testid="reread-repositories"
						onclick={() => void reread()}
					>
						Look again
					</button>
				</div>
				{#if rereads > 0}
					<!--
						⚠ **Created but not granted is a named state**. A screen identical to the one they left
						says nothing about which of the three steps went wrong, and “no repositories found”
						names the wrong cause entirely: the repository exists, and access to it is what is
						missing.
					-->
					<div role="status" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="created-not-granted">
							GitHub still answers with the same repositories as before. If you made one, it is
							almost certainly step 2 that is outstanding: the repository exists, but Ballastella
							has not been given access to it, so GitHub does not list it here.
						</p>
						<!-- eslint-disable svelte/no-navigation-without-resolve -->
						<a
							class="btn btn-sm"
							href={GRANT_ACCESS_HREF}
							rel="noreferrer noopener"
							target="_blank"
							data-testid="grant-access"
						>
							Give Ballastella access to it
						</a>
						<!-- eslint-enable svelte/no-navigation-without-resolve -->
						<p class="max-w-prose text-sm opacity-70">
							Opens your Ballastella settings on GitHub. Choose the repository you just made, save,
							then come back and press <strong>Look again</strong>.
						</p>
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
					into a submission form. Visible text as well as a copy, because a browser that refuses the
					clipboard must not leave them with nothing to read.
				-->
				<p class="mt-3 max-w-prose">
					Your published map will answer at
					<code data-testid="published-site-address">{publishedSiteAddress}</code>.
				</p>
				<!--
					⚠ **A sign-in GitHub declined lands here too, whenever the Workspace is already bound.**
					The publish dialog's own door is a redirect off the page, so the return leg reopens the
					sequence over a Workspace with a Remote — which derives this step — and a refusal said
					only on the page behind is a refusal behind a dialog. The way to start the trip again from
					here is **Publish…**, which is the screen that offered the sign-in in the first place.
				-->
				{#if connectSequence.signInRefusal}
					<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="connect-sign-in-refused">{connectSequence.signInRefusal}</p>
					</div>
				{/if}
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
						⚠ **Connecting once is not permanent**. A Workspace that has a Remote derives the
						connected step from having one, so the way back to the choice is a press that says the
						author wants a different one — and it is here, on the step they land on, rather than
						behind Workspace settings.
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
			did not work when it did.
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
			⚠ **Sign out is beside Close, so it is on every step a sign-in is held through**. The
			credential lasts as long as this tab and no longer, which is what makes a shared machine safe
			to walk away from — but "as long as the tab" is too long for somebody handing the seat over
			now, and Workspace settings is not where they would look for it.
		-->
		{#if storage.signedIn}
			<button class="btn" data-testid="connect-sign-out" onclick={() => signOut()}>Sign out</button>
		{/if}
		<!--
			⚠ **Closing is offered on every step, and it is what makes this a sequence rather than a
			trap**. Nothing is lost by it: the step is derived, so reopening reads the same facts.
			`creating` is the one step that lands somewhere else — the close clears the set its return
			comparison is made against, deliberately, for the reason written where that clearing happens.
		-->
		<button class="btn" data-testid="close-connect-sequence" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>
