<script module lang="ts">
	/**
	 * The steps this sequence has.
	 *
	 * ⚠ **A list rather than a bare union, because "every one of them" is a claim under test.** No step
	 * of this sequence may be a dead end, and no step may say GitHub's own vocabulary for the
	 * per-account list — both are properties of *all* the branches, so a thirteenth added without one
	 * of them is exactly the regression that has to fail. Enumerating the type is what lets
	 * `connect-to-github.dom.test.ts` reach every branch and read what it renders.
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
	 * repositories or as a send that failed.
	 *
	 * `by-address` is the repository typed rather than chosen, and it sits **before the sign-in**
	 * rather than behind it. Connecting to a public repository needs no account and sends no
	 * credential, so making a student sign in to reach it would lock them out of the likeliest thing
	 * this tool is used for: getting the Workspace their instructor shared. Signing in only ever
	 * *adds* the list of the author's own repositories beside it, and it is what an organisation
	 * repository GitHub will not list is reached by.
	 *
	 * ⚠ **`loading-choices` and `connecting` are the two the author passes through rather than lands
	 * on.** Each is a request in flight and each is guaranteed to answer — a listing read that throws
	 * becomes `choices-refused`, and a bind that throws clears `connecting` and goes back to the
	 * choice — which is why neither renders a control of its own and why nothing here waits for ever.
	 *
	 * ⚠ **Every refusal is a sentence over the list the author chooses from again.** There used to be
	 * a step for one of them — a Remote carrying Projects this Workspace had not got, which a send
	 * would have deleted — and it is gone with the refusal: a send removes only what the
	 * Synchronization Baseline recorded, so that repository is one to connect to and get from
	 * (ADR-0044).
	 *
	 * ⚠ **There is no step at the end, and that is the point of the sequence being one** (ADR-0044).
	 * Connecting hands off to the Sync modal, where the repository's contents stand under **To get**;
	 * the standing relationship — the Baseline, Share Links, a different repository, giving this one
	 * up — is the Workspace's own settings and lives on its roster row (`WorkspaceRemote`).
	 */
	export const CONNECT_STEPS = [
		'by-address',
		'no-app',
		'needs-account',
		'needs-sign-in',
		'sign-in-ended',
		'loading-choices',
		'choosing',
		'no-choices',
		'choices-refused',
		'creating',
		'connecting'
	] as const;

	export type Step = (typeof CONNECT_STEPS)[number];
</script>

<script lang="ts">
	import {
		describeRemote,
		describeTokenProblem,
		parseRemoteReference,
		readGrantedRepositories,
		resolveWorkspaceAddress,
		type AddressResolution,
		type GrantedInstallation,
		type GrantedRepositoriesOutcome,
		type GrantedRepository,
		type RemoteReference
	} from '@ballastella/core';

	import {
		connectSequence,
		gitHubAccountKnown,
		rememberGitHubAccount
	} from '$lib/connect-sequence.svelte.js';
	import { slide } from 'svelte/transition';

	import ModalDialog from './ModalDialog.svelte';
	import RepositoryChoice from './RepositoryChoice.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * Getting a Workspace a repository: the guided sequence, and nothing that comes after it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE SEQUENCE ENDS AT THE CONNECTION, AND IT SURVIVES ONLY FOR A WORKSPACE WITHOUT ONE
	 *
	 * Sign in, choose or create or type an address, connect — and then the Sync modal, where both
	 * sides are compared and everything the repository holds stands under **To get**. There is no
	 * step at the end saying it worked (ADR-0044).
	 *
	 * ⚠ **The standing state is not here.** Which repository this Workspace belongs to, what it and
	 * GitHub last agreed on, Share Links, **Check Remote Status**, the way to a different repository
	 * and the way to give this one up are settings of the Workspace, on its roster row
	 * (`WorkspaceRemote`, ADR-0042). Kept at the end of the sequence, they made a door somebody had
	 * already been through into a screen they had to come back to.
	 *
	 * ⚠ **The transfer is not here at all** (ADR-0044). The bar's one control opens the Sync modal
	 * directly for a Workspace that has a repository — pressing Sync reads both sides and shows what
	 * it found, which moves nothing and is therefore safe to be one press away. What was two gestures
	 * whose consequences differed in kind is one screen that states both before either happens.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ONE REPOSITORY, REACHED ONE WAY
	 *
	 * ⚠ **There is no separate act that opens a Workspace from a repository, because Sync is that
	 * act** (ADR-0044). Make a Workspace, connect it, get. So the address a student was given and the
	 * repository an author picks off their own list arrive at the same `connect`, and what follows is
	 * the same modal — where a second door would have been the same three requests behind a second
	 * noun, with its own account of what happens to a Workspace that already has content in it.
	 *
	 * ⚠ **Connecting needs no credential, and that is the property to protect.** A public repository
	 * is readable by anyone, so `bindRemote` connects with a sign-in where there is one and without
	 * where there is not — and a student with no GitHub account gets their instructor's Workspace.
	 * Sending is what needs signing in.
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
	 * The three `$effect`s are all requests or subscriptions rather than values — the listing read,
	 * the freshness check the moment the sequence opens, and the two window events that notice the
	 * author coming back from the other tab. Everything else is `$derived`, per the project's
	 * standing preference.
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
	 * sign-in that ran out, a listing GitHub would not answer, a listing the network lost, an address
	 * no repository can be derived from — each one names what to do and renders the control that does
	 * it, on the same screen. Nothing here may render a refusal whose only sequel is the Close button.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * CONNECTING IS ONE ACT, AND IT IS THE EXISTING CODE
	 *
	 * `connect` calls `WorkspaceStorage.bindRemote`, which asks GitHub about the repository before any
	 * bytes move and then writes the binding — in that order, for the reasons `bind-remote.ts`
	 * records. There is no second path to either here.
	 *
	 * ⚠ **A repository already holding work is not refused** (ADR-0044). A send removes only what the
	 * Synchronization Baseline recorded, so a Workspace with no Baseline removes nothing at all — and
	 * what that repository holds is a large **To get** column rather than work about to be deleted.
	 *
	 * ⚠ **Share Links are not part of it.** A Remote is a place the work lives before it is a site
	 * anybody reads (ADR-0045), so asking for them, checking again and withdrawing them are the
	 * Workspace's own settings and are not reachable from this sequence at all. Folded into the
	 * connection they answered a question about who may read this — with a paragraph about a GitHub
	 * permission — in the middle of a step that was about where the work goes.
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
	 * permissions and the resource owner are named.
	 *
	 * ⚠ **The word `token` is said in exactly two places, and neither is a step a student lands on**:
	 * the `no-app` step, and behind the disclosure below the sign-in — closed until an instructor
	 * whose App installation has broken presses it. Both render the same `pasteToConnect` form,
	 * because they are the same act. Every other step speaks of signing in.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE SENTENCES THE OUTCOMES CARRY ARE `packages/core`'s OWN
	 *
	 * Every refusal — GitHub's about a credential, `workspace-address.ts`'s about a custom domain — is
	 * rendered exactly as `packages/core` composes it. They name settings on GitHub's own screens and
	 * are the one thing in the sequence that may have to be done by hand, so they have to be complete
	 * rather than pleasant, and a second wording here would be a second thing to keep in step with
	 * GitHub's interface. Every word this component writes for itself is about the author's map and
	 * their repository.
	 */
	let {
		open = $bindable(false),
		storage,
		onsync,
		list = (token: string) => readGrantedRepositories({ token }),
		resolveAddress = (pasted: string) => resolveWorkspaceAddress(pasted)
	}: {
		open?: boolean;
		storage: WorkspaceStorage;
		/** Hand off to the Sync modal, which is where a connection ends. Called with this closing. */
		onsync: () => void;
		/**
		 * The listing read, injectable so every step of the sequence is a test costing milliseconds.
		 * Defaults to the one read of GitHub's installation endpoints there is.
		 */
		list?: (token: string) => Promise<GrantedRepositoriesOutcome>;
		/**
		 * Which repository a pasted address means, injectable for the same reason {@link list} is.
		 * Defaults to `packages/core`'s probe, which asks GitHub anonymously and answers a sentence.
		 */
		resolveAddress?: (pasted: string) => Promise<AddressResolution>;
	} = $props();

	/**
	 * Hydration-stable ids for the fork's own two fields, for the reason `NavigationBar` documents.
	 *
	 * One `$props.id()` suffixed twice, because Svelte allows exactly one call per component — and
	 * `for`/`id` is the whole of what ties a label to its field for a screen reader.
	 */
	const fieldId = $props.id();
	const repositoryFieldId = `${fieldId}-repository`;
	const tokenFieldId = `${fieldId}-token`;
	const addressFieldId = `${fieldId}-address`;
	const rememberFieldId = `${fieldId}-remember-sign-in`;
	const otherWayInId = `${fieldId}-other-way-in`;

	/** What was typed into the two fields the paste needs, wherever the paste is being offered. */
	let repository = $state('');
	let token = $state('');

	/**
	 * Whether the escape hatch is open, on a deployment that has an App.
	 *
	 * ⚠ **Closed until it is asked for, and it survives nothing.** Closing the sequence forgets it, so
	 * a student who never presses it never has a token field on the screen and never meets the word.
	 */
	let otherWayIn = $state(false);

	/**
	 * That the author has asked to open a Workspace by its address.
	 *
	 * ⚠ **A fact about a press, exactly as {@link otherWayIn} is, and it survives nothing.** Closing the
	 * sequence forgets it, so reopening reads the world again and lands wherever the world says.
	 */
	let byAddress = $state(false);
	/** What the author pasted: a Published Site's address, a GitHub one, or `owner/repository`. */
	let address = $state('');
	/** Whether GitHub is being asked which candidate is real, so a second press is not a second ask. */
	let resolving = $state(false);
	/**
	 * The repository the address turned out to mean, waiting to be confirmed.
	 *
	 * ⚠ **Nothing is transferred until this has been confirmed**: the download runs to gigabytes and
	 * an ambiguous address has two real answers, so the one that was chosen is named first.
	 */
	let resolved = $state<{ remote: RemoteReference; why: string } | null>(null);
	/** Why the address could not be resolved. `packages/core`'s own sentence, or `''`. */
	let addressRefusal = $state('');
	/** What GitHub answered about the grant, or `null` while nothing has been asked. */
	let listing = $state<GrantedRepositoriesOutcome | null>(null);
	/** The repository being connected, which is what makes `connecting` a state of the world. */
	let connecting = $state<RemoteReference | null>(null);
	/** Why the last press did not happen. Its own state so it can be an alert. */
	let problem = $state('');
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
	const connectingName = $derived(connecting === null ? '' : describeRemote(connecting));
	const resolvedName = $derived(resolved === null ? '' : describeRemote(resolved.remote));

	/** What GitHub last said the author has granted, and `[]` while it has said nothing or refused. */
	const granted = $derived<readonly GrantedRepository[]>(
		listing?.kind === 'listed' ? listing.repositories : []
	);

	/** The Installations GitHub listed, and `[]` while it has said nothing or refused. */
	const installations = $derived(listing?.kind === 'listed' ? listing.installations : []);

	/** Whether an Installation sits on the account this author is signed in as. */
	const isOwnAccount = (account: string): boolean =>
		storage.identity !== '' && account.toLowerCase() === storage.identity.toLowerCase();

	/**
	 * Whether this author's Installation already reaches a repository they have not made yet.
	 *
	 * ⚠ **Read against the account signed in, never taken from whichever installation says yes.** The
	 * repository is about to be made at `github.com/new`, which makes it under that account — so an
	 * organisation that granted Ballastella everything answers a different question, and answering
	 * with it would drop the grant step for the one author who still needs it.
	 *
	 * ⚠ **Asked of GitHub rather than assumed from the install screen.** *All repositories* promises
	 * to cover future repositories in GitHub's product interface and not in their documented
	 * contract (ADR-0040), which is why `repository_selection` is read back at all.
	 */
	const coversEverything = $derived(
		installations.some((one) => one.coversEverything && isOwnAccount(one.account))
	);

	/**
	 * The Installation a repository outside the grant would have to be added to, or `null`.
	 *
	 * The author's own account's where there is one, because `github.com/new` makes the repository
	 * under the account signed in; otherwise the first narrow Installation there is, which is the only
	 * one that could be widened at all. A wide Installation is never the target: there is nothing on
	 * its screen to change.
	 */
	const grantTarget = $derived.by<GrantedInstallation | null>(() => {
		const narrow = installations.filter((one) => !one.coversEverything);
		return narrow.find((one) => isOwnAccount(one.account)) ?? narrow[0] ?? null;
	});

	/**
	 * Whether widening that Installation is this author's to do.
	 *
	 * ⚠ **Read from the Installation and not from the missing repository.** GitHub reports nothing at
	 * all about a repository an Installation does not reach, so the question is asked of the account
	 * instead: an Installation on the author's own account is theirs to widen, and one on an
	 * organisation is the organisation's — theirs only where GitHub already reports them
	 * administering something inside it.
	 *
	 * ⚠ **False means no link, never a quieter link.** Sending a write collaborator or a plain
	 * organisation member to a grant screen they cannot save is the dead end this hand-off replaced,
	 * repeated at a better address.
	 */
	const canGrantAccess = $derived.by(() => {
		const target = grantTarget;
		if (target === null) return false;
		if (!target.isOrganization) return true;
		return granted.some(
			(one) => one.canGrantAccess && one.owner.toLowerCase() === target.account.toLowerCase()
		);
	});

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
		// ⚠ **Ahead of the sign-in, because it needs no account.** A door whose first step is signing
		// in locks out the person most likely to be standing at it: a student connecting to the public
		// repository their instructor shared, who has no GitHub account and needs none to get.
		byAddress
			? 'by-address'
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
	 * The steps the typed address is offered beside.
	 *
	 * ⚠ **Every step a signed-out author can land on, and the listing steps as well.** Connecting to
	 * a public repository needs no account, so it belongs in front of the sign-in rather than behind
	 * it; and signing in only ever *adds* the author's own repositories beside it, so it does not
	 * disappear the moment somebody has a credential — an organisation repository GitHub will not
	 * list is reached this way and no other.
	 */
	const offersAddress = $derived(
		step === 'no-app' ||
			step === 'needs-account' ||
			step === 'needs-sign-in' ||
			step === 'sign-in-ended' ||
			step === 'choosing' ||
			step === 'no-choices' ||
			step === 'choices-refused'
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
	 * screen or nothing — and the screen is the App's own, opened on the account whose Installation
	 * has to change. `''` where there is no Installation to widen, which is where {@link canGrantAccess}
	 * is false and nothing renders this.
	 */
	const grantAccessHref = $derived(
		grantTarget === null ? '' : storage.grantAccessUrl({ targetId: grantTarget.targetId })
	);

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
		step === 'by-address'
			? resolved !== null
				? `${describeRemote(resolved.remote)} holds a Workspace. Say whether to connect to it.`
				: 'Paste the address of a repository to connect this Workspace to it.'
			: step === 'no-app'
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
												: `${lastStep}: connecting to ${connectingName}.`
	);

	const title = 'Sync with GitHub';

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
			// Left behind, a refusal from a connection attempted an hour ago is still on screen the next
			// time anybody opens the sequence — over a Workspace it may have nothing to say about.
			listing = null;
			problem = '';
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
			// The address step is a press like any other here, so a reopened sequence reads the world
			// rather than the field somebody typed into an hour ago.
			byAddress = false;
			address = '';
			resolved = null;
			addressRefusal = '';
			resolving = false;
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
		if (!storage.signedIn || listing !== null) return;
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
	 * Asked on opening rather than at the first press, because this is the screen a scholar comes to
	 * when they suspect their sign-in has gone.
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
	function beginSignIn(installed = false): void {
		problem = '';
		connectSequence.signInRefusal = '';
		connectSequence.leavingForGitHub();
		problem = storage.beginGitHubSignIn({ installed });
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
		storage.signOut();
	}

	/**
	 * Connect the chosen repository: the rights and the binding, as one press.
	 *
	 * ⚠ **A refusal leaves `connecting` cleared, so the sequence goes back to the choice**, with the
	 * refusal said over the list the author chooses from again.
	 *
	 * ⚠ **Success ends the sequence on the Sync modal** (ADR-0044). Connecting moves no bytes, and
	 * what the author came for is the work — so the next thing on screen is both sides compared, with
	 * everything the repository holds under **To get**. There is no step at the end saying it worked:
	 * the modal that opens is the evidence, and the standing relationship is a setting of the
	 * Workspace, on its roster row.
	 *
	 * ⚠ **No credential is required.** `bindRemote` connects with whatever sign-in is held and with
	 * none where there is none, which is what lets a student get from a public repository.
	 */
	async function connect(remote: RemoteReference, pasted: string | null): Promise<void> {
		problem = '';
		connecting = remote;
		try {
			await storage.bindRemote(remote, pasted);
			sync();
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			connecting = null;
		}
	}

	/**
	 * Ask GitHub which repository the pasted address means.
	 *
	 * ⚠ **This resolves and does not connect.** `resolveWorkspaceAddress` reads a file list per
	 * candidate and nothing else, so what a press costs is at most two anonymous listings; the
	 * connection is made on the confirmation below and never here.
	 */
	async function findByAddress(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (resolving) return;
		problem = '';
		addressRefusal = '';
		resolved = null;
		resolving = true;
		try {
			const answer = await resolveAddress(address);
			if (answer.kind === 'resolved') {
				resolved = { remote: answer.remote, why: answer.why };
			} else {
				addressRefusal = answer.message;
			}
		} catch (cause) {
			addressRefusal = cause instanceof Error ? cause.message : String(cause);
		} finally {
			resolving = false;
		}
	}

	/**
	 * Connect this Workspace to the repository the author has just confirmed.
	 *
	 * The same connect the list's own choices make, which is the whole point of folding the two doors
	 * into one: a repository reached by typing its address and one reached by choosing it from a list
	 * are the same repository, connected the same way, and get from the same Sync modal afterwards.
	 */
	async function connectToResolvedAddress(): Promise<void> {
		const found = resolved;
		if (found === null || connecting !== null) return;
		await connect(found.remote, null);
	}

	/**
	 * Show or hide the way in that does not go through the App, and fill in what is already known.
	 */
	function showOtherWayIn(showing: boolean): void {
		otherWayIn = showing;
		// The repository is not the question for a Workspace that already has one, and an instructor
		// who reached this because sending stopped working has one. Prefilled, not fixed: the field
		// is typed over freely, and an author who has already typed something keeps it.
		if (showing && repository.trim() === '' && bound !== null) repository = describeRemote(bound);
	}

	/**
	 * The fork's own connect: the typed address and the pasted token, checked here before GitHub.
	 *
	 * ⚠ **Both refusals are `packages/core`'s and neither costs a request.** `parseRemoteReference`
	 * and `describeTokenProblem` catch the paste that went wrong — an empty clipboard, half a token, an
	 * address in the wrong field — and say which, which is the whole of what any form over those two
	 * values can do about them. A refused token stays in the field: pasting
	 * eighty-two characters again to fix a one-character mistake is not a remedy.
	 */
	async function connectWithToken(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		problem = '';

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

	function sync(): void {
		open = false;
		onsync();
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

		{#if step === 'by-address'}
			<!--
				⚠ **The inbound door, in front of the sign-in rather than behind it** (ADR-0031, ADR-0044).
				A student with no GitHub account opening their instructor's shared Workspace is the
				likeliest thing this tool is asked to do, and it needs nothing: no account, no credential,
				and no change to the Workspace they are in.

				⚠ **The address is resolved by asking GitHub, never by asking the author.**
				`ada.github.io/atlas` is two real GitHub layouts and no parser can tell them apart, so
				`packages/core` probes the candidates in order and the first that holds a Workspace wins.
				What the author is asked is the one question they can answer: whether the repository that
				came back is the one they meant.
			-->
			<section data-testid="connect-by-address">
				<h3 class="font-semibold">Type a repository address</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					Paste the address — the web address of somebody's shared map, the github.com address of
					the repository, or just <code>owner/repository</code>. It has to be a public repository.
					You need no GitHub account to connect to one and get from it; sending needs a sign-in.
					Nothing is sent anywhere but GitHub, and connecting on its own moves no files in either
					direction.
				</p>
				<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void findByAddress(event)}>
					<div class="flex flex-col gap-1">
						<label class="text-sm font-medium" for={addressFieldId}>
							The address of the repository
						</label>
						<input
							id={addressFieldId}
							class="input w-full max-w-md input-sm"
							bind:value={address}
							data-testid="workspace-address-field"
							placeholder="ada.github.io/atlas"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<!-- `aria-disabled` and never `disabled` while the request runs, for the reason every
						     busy control on this surface uses the same one: a `disabled` button leaves the tab
						     order the instant it is pressed (WCAG 2.4.3). -->
						<button
							class="btn w-fit btn-primary btn-sm"
							class:btn-disabled={resolving}
							aria-disabled={resolving}
							type="submit"
							data-testid="find-workspace-address"
						>
							{resolving ? 'Asking GitHub…' : 'Find it on GitHub'}
						</button>
						<!--
							The way back, so this step is no more a full stop than any other: an author who
							pressed it by mistake returns to whichever step the world says they are on.
						-->
						<button
							class="btn btn-sm"
							type="button"
							data-testid="leave-by-address"
							onclick={() => {
								byAddress = false;
							}}
						>
							Never mind
						</button>
					</div>
				</form>
				{#if resolved !== null}
					<!--
						⚠ **The confirmation, and the only place connecting can start from.** An ambiguous
						address has two real answers and what a Sync would then fetch can run to gigabytes, so
						the repository that was chosen is named — with why it was chosen — before this
						Workspace is joined to it.
					-->
					<div class="mt-4 rounded-box border border-base-300 p-4">
						<p class="max-w-prose" data-testid="resolved-address">
							GitHub has <code>{resolvedName}</code>. Connecting compares it with this Workspace and
							shows you what is on each side; nothing moves until you say so.
						</p>
						<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="resolved-address-why">
							{resolved.why}
						</p>
						<div class="mt-3 flex flex-wrap items-center gap-2">
							<button
								class="btn btn-primary btn-sm"
								class:btn-disabled={connecting !== null}
								aria-disabled={connecting !== null}
								data-testid="open-resolved-address"
								onclick={() => {
									if (connecting === null) void connectToResolvedAddress();
								}}
							>
								{connecting !== null ? 'Connecting…' : `Connect to ${resolvedName}`}
							</button>
							<button
								class="btn btn-sm"
								data-testid="reject-resolved-address"
								onclick={() => {
									resolved = null;
								}}
							>
								That is not it
							</button>
						</div>
					</div>
				{/if}
				{#if addressRefusal}
					<!--
						`packages/core`'s own sentence. A site on an address of its own cannot be traced back
						to the repository behind it, and only that sentence can say so and say what to paste
						instead — a wording here would be a second account of a rule that module owns.
					-->
					<div role="alert" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="workspace-address-refused">{addressRefusal}</p>
					</div>
				{/if}
			</section>
		{:else if step === 'no-app'}
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
					This copy of Ballastella has no GitHub sign-in set up, so it sends with a personal access
					token you make on GitHub yourself. Nothing is sent anywhere but GitHub, and the token is
					kept only in this tab and forgotten when you close it.
				</p>
				{@render pasteToConnect()}
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
					     disabled here for the one case it does not cover, as it is at every other outbound
					     link to GitHub in this component. -->
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
				<!--
					⚠ **This author has an Installation already**, or the sign-in that ran out could never
					have listed anything: only a fresh credential is wanted, which is what the plain
					authorize screen gives without asking them to review an installation they already made.
				-->
				<button
					class="btn mt-3 w-fit btn-primary btn-sm"
					data-testid="connect-sign-in-with-github"
					onclick={() => beginSignIn(true)}
				>
					Sign in with GitHub
				</button>
			</section>
		{:else if step === 'needs-sign-in'}
			<section data-testid="connect-sign-in">
				<h3 class="font-semibold">Sign in to GitHub</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					GitHub is where your map will live once it is on the web. Pressing this takes you to
					GitHub, where you install Ballastella and sign in on the same screen, and brings you back
					here to carry on. Nothing is kept on this computer beyond this tab.
				</p>
				<!--
					⚠ **Said before the departure, because after it this screen is gone.** GitHub's install
					screen asks which repositories Ballastella may work with, and *All repositories* is the
					answer that does not come back to bite: it is GitHub's own promise that the grant covers
					every repository the account owns now and every one it owns later. Choosing only some is
					allowed and is not undone here — what it costs is that a repository made next week is
					invisible until the author returns to GitHub and adds it, and that consequence is theirs
					to accept rather than to discover.
				-->
				<p class="mt-3 max-w-prose" data-testid="connect-choose-all-repositories">
					On GitHub's screen, choose <strong>All repositories</strong>: GitHub says that covers
					every repository you own now <em>and</em> every one you make later. If you choose only some,
					a repository you make after today will not be there when you look for it here, until you go
					back to GitHub and add it.
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
					{#if grantTarget !== null}
						<!--
							⚠ **The repository the author already has and cannot see is the other half of this
							step, and it is not answered by making a second one.** The list says an absent
							repository is one Ballastella has not been let at rather than one that is not on
							GitHub; what it could not say until here is *what to do about that* — and the only
							other route to the same screen is behind **Create a new one**, which asks somebody
							who has a repository to make one they do not need.

							⚠ **The link where widening is the author's, the admin where it is not**, exactly as
							the `creating` step decides it and for the same reason: a screen an author can save
							nothing on is the dead end this hand-off replaced, and offering it at a better
							address would only move the wall.
						-->
						<div class="m-4 flex flex-col items-start gap-2" data-testid="repository-missing">
							<p class="max-w-prose text-sm opacity-70">
								If the repository you want is not in this list, it is on GitHub all the same — what
								is missing is that Ballastella has not been let at it.
							</p>
							{#if canGrantAccess}
								<!-- eslint-disable svelte/no-navigation-without-resolve -->
								<a
									class="btn btn-sm"
									href={grantAccessHref}
									rel="noreferrer noopener"
									target="_blank"
									data-testid="grant-access"
								>
									Give Ballastella access to it
								</a>
								<!-- eslint-enable svelte/no-navigation-without-resolve -->
								<p class="max-w-prose text-sm opacity-70">
									Opens Ballastella's own screen on GitHub, on the account the repository is under.
									Add it, save, then come back and press <strong>Look again</strong>.
								</p>
							{:else}
								<p class="max-w-prose text-sm opacity-70">
									Only somebody who administers that repository can let Ballastella at it, so that
									is who to ask. Once they have, come back and press
									<strong>Look again</strong>.
								</p>
							{/if}
							<button
								class="btn btn-sm"
								data-testid="reread-repositories"
								onclick={() => readAgain()}
							>
								Look again
							</button>
						</div>
					{/if}
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
							<!-- A credential that reached GitHub and was refused is one an Installation was made
							     for, so this is the only-a-fresh-credential trip too. -->
							<button
								class="btn btn-sm"
								data-testid="connect-sign-in-again"
								onclick={() => beginSignIn(true)}
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
					⚠ **Three things, in this order, and the order is the point** — but only where the grant
					is a narrow one. A student who installed Ballastella with *Only select repositories*
					before making this repository finds the new one outside the grant, and the editor cannot
					add it: the endpoint that would is documented for classic personal access tokens only.
					So: make it, then give access to it, then come back. Step 2 is the one everybody misses.

					⚠ **Step 2 names a different screen, and says so.** `github.com/new` carries no control
					that grants an App access to anything, so the instruction this replaced — *"on the same
					screen"* — named a place the thing could not be done, which is the wall this was
					reported from.

					Where GitHub reports the grant as covering everything on this account, that middle step
					does not exist, and naming it would send the author to a screen with nothing to change.
					Where widening the grant is somebody else's to do, step 2 is to ask them.
				-->
				<ol class="mt-3 flex max-w-prose list-decimal flex-col gap-2 pl-6">
					<li data-testid="creating-instruction">
						In the other tab, make the repository. <strong>It has to be public</strong>, or the
						shared map will not answer for anybody you send the address to.
					</li>
					{#if !coversEverything}
						<li data-testid="creating-instruction">
							{#if canGrantAccess}
								On a <strong>second screen</strong> — Ballastella's own on GitHub, not the one you
								make the repository on —
								<strong>give Ballastella access to it</strong>. A repository made after Ballastella
								was installed is not covered by what you gave access to before, and this tab cannot
								add it for you.
							{:else}
								Ask the repository's <strong>admin</strong> to give Ballastella access to it. That
								happens on a <strong>second screen</strong> on GitHub, not the one you make the repository
								on, and only somebody who administers the repository can save it.
							{/if}
						</li>
					{/if}
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
				{#if rereads > 0 && coversEverything}
					<!--
						⚠ **The same unchanged listing, with the one likely cause removed.** Ballastella
						already reaches everything on this account, so naming a missing grant here would be a
						confident wrong answer: what is left is a repository not made yet, or GitHub not
						answering with it quite yet.
					-->
					<div role="status" class="mt-3 alert flex-col items-start alert-warning">
						<p data-testid="created-not-listed">
							GitHub still answers with the same repositories as before. If you have just made one,
							give it a moment and press <strong>Look again</strong>.
						</p>
					</div>
				{:else if rereads > 0}
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
							{#if !canGrantAccess}
								Only an admin of the repository can give Ballastella access to it, so that is who to
								ask.
							{/if}
						</p>
						{#if canGrantAccess}
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								class="btn btn-sm"
								href={grantAccessHref}
								rel="noreferrer noopener"
								target="_blank"
								data-testid="grant-access"
							>
								Give Ballastella access to it
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							<p class="max-w-prose text-sm opacity-70">
								Opens Ballastella's own screen on GitHub, on the account the repository is under.
								Add the repository you just made, save, then come back and press
								<strong>Look again</strong>.
							</p>
						{:else}
							<!--
								⚠ **No link at all, rather than a link they cannot save.** A grant screen an
								author has no rights on is the dead end this hand-off exists to remove, and
								offering it at a better address would only move the wall.
							-->
							<p class="max-w-prose text-sm opacity-70">
								Once they have, come back and press <strong>Look again</strong>.
							</p>
						{/if}
					</div>
				{/if}
			</section>
		{:else}
			<section data-testid="connect-connecting">
				<h3 class="font-semibold">Connecting</h3>
				<p class="mt-3 max-w-prose">
					Setting {connectingName} up as the repository this Workspace syncs with. Nothing is being sent
					or fetched: what is there and what is here are compared next, on a screen that names both before
					anything moves.
				</p>
			</section>
		{/if}

		{#if offersAddress}
			<!--
				⚠ **The typed address, offered on every step a signed-out author can be standing on.**
				Connecting to a public repository needs no account, so being asked to sign in first would
				be a prerequisite invented for nothing — and signing in only *adds* the list of the
				author's own repositories beside this, which is why a repository GitHub will not list is
				reached here.
			-->
			<section class="border-t border-base-300 pt-3" data-testid="connect-address-offer">
				<p class="max-w-prose text-sm opacity-70">
					Has somebody sent you the address of a map they shared, or is your repository one GitHub
					has not listed above? You can type the address instead, with no account.
				</p>
				<button
					class="btn mt-2 w-fit btn-sm"
					data-testid="open-by-address"
					onclick={() => {
						byAddress = true;
					}}
				>
					Type a repository address
				</button>
			</section>
		{/if}

		{#if storage.signInWithGitHubOffered}
			<!--
				⚠ **What is true of the sign-in, and the one choice about it, on every step of the door**
				(ADR-0044). Both were in the Remote dialog ADR-0042 deletes, and both belong wherever a
				sign-in is reachable: *which* account is the question a scholar on a shared or a
				classmate's machine is actually asking, and the choice below is about this computer rather
				than about the sign-in currently held — so it is answerable before the button is pressed,
				which is the order a person meets it in.

				The account is read from the credential store rather than from anything remembered, so it
				says what is true: the store is sealed while a Review Workspace is open (ADR-0033), and a
				token that cannot be read is one this screen must not claim to hold.

				⚠ **The sentence states which of the two rules is in force**, rather than one wording that
				is true under both. What happens when this tab closes is the whole subject of the choice
				beneath it, and a scholar deciding whether to tick it is owed the current answer in the
				same breath.

				⚠ **Absent where no App is configured.** There is nothing renewable to keep: a fork's whole
				authentication is a pasted token, which lives in this tab and has no refresh half at all,
				so the choice would be a promise this deployment cannot make.
			-->
			<section class="border-t border-base-300 pt-3" data-testid="connect-credential">
				{#if storage.signedIn}
					<p class="max-w-prose text-sm opacity-70" data-testid="connect-signed-in">
						Signed in to GitHub{storage.identity ? ` as ${storage.identity}` : ''}. The sign-in
						survives a reload{storage.rememberSignIn
							? `, and this computer keeps the part that renews it, so that coming back tomorrow does not mean signing in again. The eight-hour sign-in itself is still forgotten when this tab closes.`
							: ` and is forgotten when this tab closes, so a shared machine keeps nothing of it.`}
					</p>
				{:else}
					<p class="max-w-prose text-sm opacity-70" data-testid="connect-signed-out">
						Not signed in to GitHub, so nothing can be sent yet.
					</p>
				{/if}
				<!--
					⚠ **Unticked until the author ticks it** (ADR-0044). The rule narrows rather than falls: a
					scholar on a shared or lab machine changes nothing and keeps the old behaviour, and a
					durable credential is never a default somebody else chose.
				-->
				<label class="mt-3 flex max-w-prose items-start gap-2 text-sm" for={rememberFieldId}>
					<input
						id={rememberFieldId}
						class="checkbox mt-0.5 checkbox-sm"
						type="checkbox"
						data-testid="remember-sign-in"
						checked={storage.rememberSignIn}
						onchange={(event) => storage.setRememberSignIn(event.currentTarget.checked)}
					/>
					<span>
						Keep me signed in on this computer.
					</span>
				</label>
				<!--
					⚠ **A disclosure, and *closed* is the whole of what makes it one** (ADR-0044).
					An App installation that has broken mid-class leaves an instructor with no way in, and
					this is it; a student on the same deployment must never be offered a choice between two
					credentials, and a field that is not in the document is not an offer. So the word is
					said only once it has been asked for, and the label that asks for it says nothing a
					student would have to learn.

					A `<button aria-expanded>` and not `<details>`: ADR-0016 bans the `<details>` dropdown,
					and the WAI-ARIA disclosure button is unambiguously outside that ban.
				-->
				<div class="mt-3">
					<button
						type="button"
						class="btn btn-outline btn-xs"
						aria-expanded={otherWayIn}
						aria-controls={otherWayInId}
						data-testid="connect-other-way-in"
						onclick={() => showOtherWayIn(!otherWayIn)}
					>
						{otherWayIn ? 'Hide personal access token sign-in' : 'Signing in will not work for me'}
					</button>
					{#if otherWayIn}
						<div
							id={otherWayInId}
							class="overflow-hidden"
							data-testid="connect-other-way-in-panel"
							transition:slide={{ duration: 200 }}
						>
							<h4 class="mt-3 font-semibold">Sign in with a personal access token</h4>
							<p class="mt-2 max-w-prose text-sm opacity-70">
								If signing in cannot reach your repository — the app's access to it was removed, or
								it was never granted and the account that could grant it is not yours to change —
								connect with a personal access token you make yourself instead. It sends
								identically, and it is kept only in this tab.
							</p>
							{@render pasteToConnect()}
						</div>
					{/if}
				</div>
			</section>
		{/if}

		<!-- What refused the last press, over the list the author chooses from again. -->
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
			now, and the door is where everything else about the sign-in already is.
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

{#snippet pasteToConnect()}
	<!--
		⚠ **The paste, in the one shape it has.** It is a fork's whole front door and it is the
		instructor's way back in when an App installation has broken, and those are the same act — a
		repository and a token, both checked by `packages/core` before GitHub is asked anything. Two
		wordings of the same form would be two accounts of GitHub's token screen to keep in step, and
		the guidance is what makes a token that works first time rather than on the third try.
	-->
	<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void connectWithToken(event)}>
		<div class="flex flex-col gap-1">
			<label class="text-sm font-medium" for={repositoryFieldId}>Your repository on GitHub</label>
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
			<!--
				⚠ **Two permissions, a third that is a choice, and the owner — all four set on one form
				and only one of them obvious.** Contents is what a Sync writes with and Pages is what
				turning the site on needs, so a token with the first alone gets an author all the way to a
				Published Site that never appears. `POST /pages` needs `Administration: write` beside
				`Pages: write` (ADR-0040), so a token without it meets the guided step exactly as a
				sign-in does — named here as a choice rather than a requirement, because the same
				permission carries renaming, transferring and deleting the repository, and a token kept in
				a browser tab is not the place to hand that over unasked. **Resource owner** is the trap:
				left on a personal account for a repository an organisation owns, GitHub issues a token
				that cannot see it, and the symptom is a repository that appears not to exist.
			-->
			<p class="max-w-prose text-sm opacity-70">
				A fine-grained personal access token for that repository, with
				<strong>Contents: Read and write</strong> and <strong>Pages: Read and write</strong>. Set
				<strong>Resource owner</strong> to whoever owns the repository — your own account, or the organisation
				it is under — or the token will not be able to see it. GitHub shows the token once, on the page
				that makes it.
			</p>
			<p class="max-w-prose text-sm opacity-70">
				<strong>Administration: Read and write</strong> is a choice, not a requirement. GitHub asks
				for it before it will turn a Pages site on for you, so a token carrying it means Share Links
				come on with one press here; a token without it leaves you one setting to make on GitHub
				yourself, once — which is what signing in does too. That row set to <em>Read and write</em>
				also lets the token rename, transfer and delete the repository, so leave it at
				<em>No access</em> if you would rather make the setting by hand.
			</p>
		</div>
		<div>
			<button class="btn w-fit btn-primary btn-sm" type="submit" data-testid="connect-paste">
				Sync this Workspace
			</button>
		</div>
	</form>
{/snippet}
