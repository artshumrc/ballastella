<script module lang="ts">
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
		messageOf,
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
	import { Task } from '$lib/task.svelte.js';
	import { slide } from 'svelte/transition';

	import Alert from './Alert.svelte';
	import BusyButton from './BusyButton.svelte';
	import ExternalLink from './ExternalLink.svelte';
	import ModalDialog from './ModalDialog.svelte';
	import RepositoryChoice from './RepositoryChoice.svelte';
	import TokenField from './TokenField.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		open = $bindable(false),
		storage,
		onsync,
		list = (token: string) => readGrantedRepositories({ token }),
		resolveAddress = (pasted: string) => resolveWorkspaceAddress(pasted)
	}: {
		open?: boolean;
		storage: WorkspaceStorage;
		onsync: () => void;
		list?: (token: string) => Promise<GrantedRepositoriesOutcome>;
		resolveAddress?: (pasted: string) => Promise<AddressResolution>;
	} = $props();

	const github = $derived(storage.github);

	const fieldId = $props.id();
	const repositoryFieldId = `${fieldId}-repository`;
	const addressFieldId = `${fieldId}-address`;
	const otherWayInId = `${fieldId}-other-way-in`;

	const fresh = () => ({
		repository: '',
		token: '',
		byAddress: false,
		address: '',
		finding: new Task(),
		resolved: null as { remote: RemoteReference; why: string } | null,
		listing: null as GrantedRepositoriesOutcome | null,
		problem: '',
		expiry: '',
		madeAgainst: null as ReadonlySet<string> | null,
		rereads: 0
	});

	let visit = $state(fresh());
	let otherWayIn = $state(false);
	let connecting = $state<RemoteReference | null>(null);
	let accountKnown = $state(gitHubAccountKnown());
	let rereading = $state(false);
	const connectingName = $derived(connecting === null ? '' : describeRemote(connecting));
	const resolvedName = $derived(
		visit.resolved === null ? '' : describeRemote(visit.resolved.remote)
	);

	const listing = $derived(visit.listing);
	const granted = $derived<readonly GrantedRepository[]>(
		listing?.kind === 'listed' ? listing.repositories : []
	);

	const installations = $derived(listing?.kind === 'listed' ? listing.installations : []);

	const isOwnAccount = (account: string): boolean =>
		github.identity !== '' && account.toLowerCase() === github.identity.toLowerCase();

	const coversEverything = $derived(
		installations.some((one) => one.coversEverything && isOwnAccount(one.account))
	);

	const grantTarget = $derived.by<GrantedInstallation | null>(() => {
		const narrow = installations.filter((one) => !one.coversEverything);
		return narrow.find((one) => isOwnAccount(one.account)) ?? narrow[0] ?? null;
	});

	const canGrantAccess = $derived(
		grantTarget !== null &&
			(!grantTarget.isOrganization ||
				granted.some(
					(one) =>
						one.canGrantAccess && one.owner.toLowerCase() === grantTarget.account.toLowerCase()
				))
	);

	const newlyGranted = $derived.by<ReadonlySet<string>>(() => {
		const before = visit.madeAgainst;
		if (before === null) return new Set<string>();
		return new Set(granted.map(describeRemote).filter((name) => !before.has(name)));
	});

	const step = $derived.by<Step>(() => {
		if (visit.byAddress) return 'by-address';
		if (connecting !== null) return 'connecting';
		if (!github.signInWithGitHubOffered) return 'no-app';
		if (!github.signedIn) {
			if (visit.expiry !== '') return 'sign-in-ended';
			return accountKnown ? 'needs-sign-in' : 'needs-account';
		}
		if (listing?.kind === 'refused') return 'choices-refused';
		if (visit.madeAgainst !== null && newlyGranted.size === 0) return 'creating';
		if (listing === null) return 'loading-choices';
		return granted.length === 0 ? 'no-choices' : 'choosing';
	});

	const offersAddress = $derived(
		!(['by-address', 'loading-choices', 'creating', 'connecting'] as Step[]).includes(step)
	);

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

	const grantAccessHref = $derived(
		grantTarget === null ? '' : github.grantAccessUrl({ targetId: grantTarget.targetId })
	);

	const account = $derived(
		github.signedIn
			? github.identity
				? `Signed in to GitHub as ${github.identity}.`
				: 'Signed in to GitHub.'
			: ''
	);

	const announcement = $derived(
		(
			{
				'by-address':
					visit.resolved !== null
						? `${resolvedName} holds a Workspace. Say whether to connect to it.`
						: 'Paste the address of a repository to connect this Workspace to it.',
				'no-app': 'Step 1 of 2: name your repository on GitHub and paste an access token for it.',
				'needs-account': 'Step 1 of 4: you need a GitHub account.',
				'needs-sign-in': 'Step 2 of 4: sign in to GitHub.',
				'sign-in-ended': 'Your GitHub sign-in has ended. Sign in again to carry on.',
				'loading-choices':
					'Step 3 of 4: asking GitHub which repositories you have given Ballastella access to.',
				choosing: 'Step 3 of 4: choose where your map goes.',
				'no-choices':
					'Step 3 of 4: you have given Ballastella access to no repository yet, so make one.',
				'choices-refused': 'Step 3 of 4: your repositories on GitHub could not be read.',
				creating: 'Step 3 of 4: making a repository on GitHub, in the other tab.',
				connecting: `${github.signInWithGitHubOffered ? 'Step 4 of 4' : 'Step 2 of 2'}: connecting to ${connectingName}.`
			} satisfies Record<Step, string>
		)[step]
	);

	$effect(() => {
		if (!open) {
			visit = fresh();
			connectSequence.signInRefusal = '';
			return;
		}
		if (github.signedIn) passAccountStep();
		if (!github.signInWithGitHubOffered) return;
		if (!github.signedIn || visit.listing !== null) return;
		const credential = github.credential;
		if (credential === null) return;
		void list(credential).then(
			(answer) => {
				visit.listing = answer;
			},
			(cause: unknown) => {
				visit.listing = {
					kind: 'refused',
					refusal: 'network',
					message:
						`Your repositories on GitHub could not be read. The browser reported: ${messageOf(cause)}. ` +
						`Everything you have is still saved on this computer.`
				};
			}
		);
	});

	$effect(() => {
		if (!open) return;
		void github.ensureCredentialFresh().catch((cause: unknown) => {
			visit.expiry = messageOf(cause);
		});
	});

	async function reread(): Promise<void> {
		const credential = github.credential;
		if (credential === null || rereading) return;
		rereading = true;
		try {
			visit.listing = await list(credential);
			visit.rereads += 1;
		} catch (cause) {
			visit.problem = messageOf(cause);
		} finally {
			rereading = false;
		}
	}

	function beginCreating(): void {
		visit.problem = '';
		visit.rereads = 0;
		visit.madeAgainst = new Set(granted.map(describeRemote));
	}

	function rereadOnReturn(): void {
		if (step === 'creating' && document.visibilityState === 'visible') void reread();
	}

	function beginSignIn(installed: boolean): void {
		visit.problem = connectSequence.beginSignIn(github, installed);
	}

	function passAccountStep(): void {
		accountKnown = true;
		rememberGitHubAccount();
	}

	function readAgain(): void {
		visit.problem = '';
		visit.listing = null;
	}

	function signOut(): void {
		visit.problem = '';
		visit.expiry = '';
		visit.listing = null;
		github.signOut();
	}

	async function connect(remote: RemoteReference, pasted: string | null): Promise<void> {
		visit.problem = '';
		connecting = remote;
		try {
			await storage.remote.bind(remote, pasted);
			open = false;
			onsync();
		} catch (cause) {
			visit.problem = messageOf(cause);
		} finally {
			connecting = null;
		}
	}

	async function findByAddress(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const { finding } = visit;
		if (finding.working) return;
		visit.problem = '';
		visit.resolved = null;
		await finding.run(async () => {
			const answer = await resolveAddress(visit.address);
			if (answer.kind === 'resolved') visit.resolved = { remote: answer.remote, why: answer.why };
			else finding.problem = answer.message;
		});
	}

	function showOtherWayIn(showing: boolean): void {
		otherWayIn = showing;
		if (showing && visit.repository.trim() === '' && storage.remote.bound !== null) {
			visit.repository = describeRemote(storage.remote.bound);
		}
	}

	async function connectWithToken(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		visit.problem = '';

		const remote = parseRemoteReference(visit.repository);
		if (remote === null) {
			visit.problem =
				`“${visit.repository.trim()}” is not a repository address. It looks like “owner/repository” — ` +
				`the two parts after github.com in your browser's address bar — and the whole of that ` +
				`address works too.`;
			return;
		}
		visit.problem = describeTokenProblem(visit.token);
		if (visit.problem !== '') return;

		await connect(remote, visit.token.trim());
	}
</script>

<svelte:window onfocus={rereadOnReturn} />
<svelte:document onvisibilitychange={rereadOnReturn} />

<ModalDialog bind:open title="Sync with GitHub" wide>
	<div class="flex flex-col gap-4" data-testid="connect-sequence">
		<p role="status" class="sr-only" data-testid="connect-step">{announcement}</p>

		{#if step === 'by-address'}
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
							bind:value={visit.address}
							data-testid="workspace-address-field"
							placeholder="ada.github.io/atlas"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<button
							class="btn w-fit btn-primary btn-sm"
							class:btn-disabled={visit.finding.working}
							aria-disabled={visit.finding.working}
							type="submit"
							data-testid="find-workspace-address"
						>
							{visit.finding.working ? 'Asking GitHub…' : 'Find it on GitHub'}
						</button>
						<button
							class="btn btn-sm"
							type="button"
							data-testid="leave-by-address"
							onclick={() => (visit.byAddress = false)}
						>
							Never mind
						</button>
					</div>
				</form>
				{#if visit.resolved !== null}
					<div class="mt-4 rounded-box border border-base-300 p-4">
						<p class="max-w-prose" data-testid="resolved-address">
							GitHub has <code>{resolvedName}</code>. Connecting compares it with this Workspace and
							shows you what is on each side; nothing moves until you say so.
						</p>
						<p class="mt-1 max-w-prose text-sm opacity-70" data-testid="resolved-address-why">
							{visit.resolved.why}
						</p>
						<div class="mt-3 flex flex-wrap items-center gap-2">
							<BusyButton
								busy={connecting !== null}
								class="btn btn-primary btn-sm"
								data-testid="open-resolved-address"
								onclick={() => visit.resolved && connect(visit.resolved.remote, null)}
							>
								{connecting !== null ? 'Connecting…' : `Connect to ${resolvedName}`}
							</BusyButton>
							<button
								class="btn btn-sm"
								data-testid="reject-resolved-address"
								onclick={() => (visit.resolved = null)}
							>
								That is not it
							</button>
						</div>
					</div>
				{/if}
				<Alert text={visit.finding.problem} testid="workspace-address-refused" class="mt-3" />
			</section>
		{:else if step === 'no-app'}
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
			<section data-testid="connect-needs-account">
				<h3 class="font-semibold">You need a GitHub account</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					GitHub is where your map will live once it is on the web: it holds your work, and it is
					what answers when somebody opens the address you give them. An account is free, and making
					one takes a minute.
				</p>
				<div class="mt-3 flex flex-wrap items-center gap-2">
					<ExternalLink
						class="btn btn-primary btn-sm"
						href="https://github.com/signup"
						data-testid="connect-sign-up"
						onclick={passAccountStep}
					>
						Make a GitHub account
					</ExternalLink>
					<button class="btn btn-sm" data-testid="connect-have-account" onclick={passAccountStep}>
						I already have one
					</button>
				</div>
				<p class="mt-3 max-w-prose text-sm opacity-70">
					GitHub opens in a second tab, so this one stays where it is. Come back to it when you have
					an account and carry on from the next step.
				</p>
			</section>
		{:else if step === 'sign-in-ended'}
			<section data-testid="connect-sign-in-ended">
				<h3 class="font-semibold">Your GitHub sign-in has ended</h3>
				<p class="mt-3 max-w-prose" data-testid="connect-expiry">{visit.expiry}</p>
				{@render signInButton(true)}
			</section>
		{:else if step === 'needs-sign-in'}
			<section data-testid="connect-sign-in">
				<h3 class="font-semibold">Sign in to GitHub</h3>
				<p class="mt-1 max-w-prose text-sm opacity-70">
					GitHub is where your map will live once it is on the web. Pressing this takes you to
					GitHub, where you install Ballastella and sign in on the same screen, and brings you back
					here to carry on. Nothing is kept on this computer beyond this tab.
				</p>
				<p class="mt-3 max-w-prose" data-testid="connect-choose-all-repositories">
					On GitHub's screen, choose <strong>All repositories</strong>: GitHub says that covers
					every repository you own now <em>and</em> every one you make later. If you choose only some,
					a repository you make after today will not be there when you look for it here, until you go
					back to GitHub and add it.
				</p>
				<Alert text={connectSequence.signInRefusal} testid="connect-sign-in-refused" class="mt-3" />
				{@render signInButton(false)}
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
					<div class="m-4 flex flex-wrap items-center gap-3">
						<ExternalLink
							class={step === 'no-choices' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
							href={createRepositoryHref}
							data-testid="create-repository"
							onclick={beginCreating}
						>
							Create a new one
						</ExternalLink>
						<p class="max-w-prose text-sm opacity-70" data-testid="create-repository-note">
							Opens GitHub in a second tab, with the name “{suggestedName}” already filled in. This
							tab stays where it is.
						</p>
					</div>
					{#if grantTarget !== null}
						<div class="m-4 flex flex-col items-start gap-2" data-testid="repository-missing">
							<p class="max-w-prose text-sm opacity-70">
								If the repository you want is not in this list, it is on GitHub all the same — what
								is missing is that Ballastella has not been let at it.
							</p>
							{#if canGrantAccess}
								{@render grantAccess('it')}
							{:else}
								<p class="max-w-prose text-sm opacity-70">
									Only somebody who administers that repository can let Ballastella at it, so that
									is who to ask. Once they have, come back and press
									<strong>Look again</strong>.
								</p>
							{/if}
							<button class="btn btn-sm" data-testid="reread-repositories" onclick={readAgain}>
								Look again
							</button>
						</div>
					{/if}
				{:else if listing?.kind === 'refused'}
					<Alert text={listing.message} testid="connect-choices-refused" class="mt-3">
						{#if listing.refusal === 'credential'}
							{@render signInButton(true, 'btn btn-sm', 'connect-sign-in-again')}
						{:else}
							<button class="btn btn-sm" data-testid="connect-read-again" onclick={readAgain}>
								Try again
							</button>
						{/if}
					</Alert>
				{/if}
			</section>
		{:else if step === 'creating'}
			<section data-testid="connect-creating">
				<h3 class="font-semibold">Making a repository on GitHub</h3>
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
					<button
						class="btn btn-sm"
						data-testid="reread-repositories"
						onclick={() => void reread()}
					>
						Look again
					</button>
				</div>
				{#if visit.rereads > 0}
					<Alert role="status" class="mt-3">
						{#if coversEverything}
							<p data-testid="created-not-listed">
								GitHub still answers with the same repositories as before. If you have just made
								one, give it a moment and press <strong>Look again</strong>.
							</p>
						{:else}
							<p data-testid="created-not-granted">
								GitHub still answers with the same repositories as before. If you made one, it is
								almost certainly step 2 that is outstanding: the repository exists, but Ballastella
								has not been given access to it, so GitHub does not list it here.
								{#if !canGrantAccess}
									Only an admin of the repository can give Ballastella access to it, so that is who
									to ask.
								{/if}
							</p>
							{#if canGrantAccess}
								{@render grantAccess('the repository you just made')}
							{:else}
								<p class="max-w-prose text-sm opacity-70">
									Once they have, come back and press <strong>Look again</strong>.
								</p>
							{/if}
						{/if}
					</Alert>
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
			<section class="border-t border-base-300 pt-3" data-testid="connect-address-offer">
				<p class="max-w-prose text-sm opacity-70">
					Has somebody sent you the address of a map they shared, or is your repository one GitHub
					has not listed above? You can type the address instead, with no account.
				</p>
				<button
					class="btn mt-2 w-fit btn-sm"
					data-testid="open-by-address"
					onclick={() => (visit.byAddress = true)}
				>
					Type a repository address
				</button>
			</section>
		{/if}

		{#if github.signInWithGitHubOffered}
			<section class="border-t border-base-300 pt-3" data-testid="connect-credential">
				{#if github.signedIn}
					<p class="max-w-prose text-sm opacity-70" data-testid="connect-signed-in">
						Signed in to GitHub{github.identity ? ` as ${github.identity}` : ''}. The sign-in
						survives a reload{github.rememberSignIn
							? `, and this computer keeps the part that renews it, so that coming back tomorrow does not mean signing in again. The eight-hour sign-in itself is still forgotten when this tab closes.`
							: ` and is forgotten when this tab closes, so a shared machine keeps nothing of it.`}
					</p>
				{:else}
					<p class="max-w-prose text-sm opacity-70" data-testid="connect-signed-out">
						Not signed in to GitHub, so nothing can be sent yet.
					</p>
				{/if}
				<label class="mt-3 flex max-w-prose items-start gap-2 text-sm">
					<input
						class="checkbox mt-0.5 checkbox-sm"
						type="checkbox"
						data-testid="remember-sign-in"
						checked={github.rememberSignIn}
						onchange={(event) => github.setRememberSignIn(event.currentTarget.checked)}
					/>
					<span> Keep me signed in on this computer. </span>
				</label>
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

		<Alert text={visit.problem} testid="connect-problem" />
	</div>

	{#snippet actions()}
		{#if github.signedIn}
			<button class="btn" data-testid="connect-sign-out" onclick={signOut}>Sign out</button>
		{/if}
		<button class="btn" data-testid="close-connect-sequence" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>

{#snippet grantAccess(what: string)}
	<ExternalLink class="btn btn-sm" href={grantAccessHref} data-testid="grant-access">
		Give Ballastella access to it
	</ExternalLink>
	<p class="max-w-prose text-sm opacity-70">
		Opens Ballastella's own screen on GitHub, on the account the repository is under. Add {what},
		save, then come back and press <strong>Look again</strong>.
	</p>
{/snippet}

{#snippet signInButton(
	installed: boolean,
	className = 'btn mt-3 w-fit btn-primary btn-sm',
	testid = 'connect-sign-in-with-github'
)}
	<button class={className} data-testid={testid} onclick={() => beginSignIn(installed)}>
		Sign in with GitHub
	</button>
{/snippet}

{#snippet pasteToConnect()}
	<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void connectWithToken(event)}>
		<div class="flex flex-col gap-1">
			<label class="text-sm font-medium" for={repositoryFieldId}>Your repository on GitHub</label>
			<input
				id={repositoryFieldId}
				class="input w-full max-w-md input-sm"
				bind:value={visit.repository}
				data-testid="connect-repository-field"
				placeholder="owner/repository"
				autocomplete="off"
				spellcheck="false"
			/>
			<p class="max-w-prose text-sm opacity-70">
				It has to be public. Do not have one yet?
				<ExternalLink
					class="link"
					href={createRepositoryHref}
					data-testid="connect-create-repository"
				>
					Create “{suggestedName}” on GitHub
				</ExternalLink>
				, choose <strong>Public</strong>, then come back to this tab.
			</p>
		</div>
		<TokenField bind:value={visit.token} testid="connect-token-field">
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
		</TokenField>
		<div>
			<button class="btn w-fit btn-primary btn-sm" type="submit" data-testid="connect-paste">
				Sync this Workspace
			</button>
		</div>
	</form>
{/snippet}
