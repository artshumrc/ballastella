/**
 * The members of `WorkspaceStorage` the two GitHub surfaces read, as a reactive fake.
 *
 * Shared by the guided sequence (`ConnectToGitHub`) and by the standing relationship on the
 * Workspace's own row (`WorkspaceRemote`), because they read one storage between them: the sequence
 * connects and the row is what the connection comes to rest as.
 *
 * A `.svelte.ts` module rather than a plain one because the sequence's whole contract is that its step
 * is *derived*: `remote` and `signedIn` have to be signals or every assertion about the sequence moving
 * on its own would be an assertion about a fake that cannot move. The real class is 2600 lines over
 * OPFS and IndexedDB, so it is not what a component seam should be standing up.
 *
 * ⚠ **Every method records what it was asked and nothing here reaches GitHub.** What arrives at
 * `bindRemote` is the claim "connecting is one act on the existing code"; what `github-installations`
 * and `bind-remote` then do with it is asserted at Seam 1 against the shared fake GitHub.
 */

import {
	grantAccessUrl as composeGrantAccessUrl,
	signInDepartureUrl,
	UNCHECKED_REMOTE_STATUS,
	observedShareLinks,
	type AddressResolution,
	type GitHubApp,
	type GrantedRepositoriesOutcome,
	type RemoteBindOutcome,
	type RemotePagesOutcome,
	type RemotePagesWithdrawal,
	type RemoteReference,
	type RemoteRights,
	type RemoteStatusState,
	type SynchronizationBaseline
} from '@ballastella/core';

import type { TransferState } from '../editor-session.svelte.js';
import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

/** What `bindRemote` was called with, which is where "one act, existing code" is asserted. */
export type BindCall = { readonly remote: RemoteReference; readonly token: string | null };

/**
 * An App that is nobody's, so a spec naming its addresses names no deployment's.
 *
 * The real storage reads `GITHUB_APP`; what a spec here is about is *which of the two addresses* the
 * sequence departs to, and a fake App keeps that assertion readable — and keeps this module clear of
 * `scripts/check-github-broker.mjs`, which is not exempt outside `.test.ts`.
 */
export const FAKE_APP: GitHubApp = {
	brokerOrigin: 'https://broker.fake.invalid',
	clientId: 'Iv1.fakeclientid',
	appSlug: 'fake-app'
};

/** The callback the fake App is registered against, which the authorize URL carries. */
export const FAKE_REDIRECT_URI = 'https://atlas.fake.invalid/editor/';

/** The `state` this fake mints, fixed so a departure address is a string a spec can write down. */
export const FAKE_STATE = 'fakestate';

export class FakeStorage {
	remote = $state<{ owner: string; repository: string; branch: string } | null>(null);
	/**
	 * Whether this deployment has a GitHub App at all — `isGitHubAppConfigured(GITHUB_APP)`, which the
	 * real storage computes once. A signal rather than a field so a spec can prove the sequence's
	 * first step is a reading of it and not a position chosen when the dialog opened.
	 */
	signInWithGitHubOffered = $state(true);
	/** The Workspace's name, which is what the create-repository link arrives pre-filled with. */
	name = $state('Atlas');
	signedIn = $state(false);
	identity = $state('');
	/**
	 * Whether this computer has been asked to keep the sign-in past the tab (ADR-0041).
	 *
	 * A signal because the sentence beside the choice is a reading of it: what happens when the tab
	 * closes is the whole subject of the choice, so ticking it has to change the sentence rather than
	 * leave the author with the answer that was true a moment ago.
	 */
	rememberSignIn = $state(false);
	credential = $state<string | null>(null);
	/** What this Workspace and GitHub last agreed on, which the connected step states in words. */
	baseline = $state<SynchronizationBaseline | null>(null);
	/** The determination the badge carries, read here only for whether a check is running. */
	remoteStatusState = $state<RemoteStatusState>(UNCHECKED_REMOTE_STATUS);
	/** An Update in flight, which is the one thing that makes its control busy. */
	updateProgress = $state<{ files: number; totalFiles: number } | null>(null);
	/**
	 * The transfer the bar's progress line is a reading of, or `null` between transfers.
	 *
	 * A signal because the progress count is one: the real storage writes it per file over
	 * minutes, and a plain field could not show that the line follows the download rather than
	 * being written once when it starts.
	 */
	transfer = $state<TransferState | null>(null);

	/** Every call to {@link bindRemote}, in order. */
	readonly bindCalls: BindCall[] = [];
	/** How many times the sign-in was begun. */
	signInsBegun = 0;
	/**
	 * Where each begun sign-in departed to, in order.
	 *
	 * ⚠ **The address, not the flag.** The claim the sequence has to carry is that a first-time author
	 * leaves for the App's *install* screen and somebody who only wants a credential leaves for the
	 * plain authorize screen, so the recorded navigation is the URL `packages/core` composes from what
	 * the component asked for — the same function the real storage assigns to `location`.
	 */
	readonly signInDepartures: string[] = [];
	/** What `beginGitHubSignIn` answers: `''` for a redirect under way, a sentence for a refusal. */
	signInRefusal = '';
	/** What `bindRemote` answers, or throws when it is an `Error`. */
	bindAnswer: RemoteBindOutcome | Error = outcome();
	/** How many times Share Links were asked for. `0` is "nothing was asked of GitHub". */
	pagesAsks = 0;
	/** How many times *Check again* polled GitHub. */
	pagesChecks = 0;
	/** How many times Share Links were withdrawn. */
	pagesWithdrawals = 0;
	/** What `enableShareLinks` answers, or throws when it is an `Error`. */
	pagesAnswer: RemotePagesOutcome | Error = pagesOn();
	/** What `checkShareLinks` answers, or throws when it is an `Error`. */
	checkAnswer: RemotePagesOutcome | Error = pagesOn();
	/** What `withdrawShareLinks` answers, or throws when it is an `Error`. */
	withdrawalAnswer: RemotePagesWithdrawal | Error = { disabled: true, notice: '' };
	/** Whether this Workspace's own tree carries the site record (ADR-0045). */
	shareLinks = $state(false);
	/** Whether the author has asked for the site to come down and no Sync has carried it out. */
	withdrawing = $state(false);
	/** How many times the sign-in was ended by a press. */
	signOuts = 0;
	/** How many times the Workspace was unbound, which is the claim about the one caller. */
	unbinds = 0;
	/** How many times a status check was asked for by a press. */
	checks = 0;
	/** How many times an Update was asked for by a press. */
	updates = 0;
	/** What `unbindRemote` answers, or throws when it is an `Error`. */
	unbindAnswer: Error | null = null;
	/**
	 * How many times the push-rights read was made, and what it answers.
	 *
	 * ⚠ **The default is `canPush: true`, and the count is what a spec asserts the signed-out case
	 * with.** Push rights cannot be read without a credential, so "nothing is said about rights while
	 * signed out" is a claim about a request that was never made — and an answer that defaulted to
	 * *cannot send* would make every other spec render the read-only state.
	 */
	rightsReads = 0;
	/** What `readRights` answers, or throws when it is an `Error`. */
	rightsAnswer: RemoteRights | Error = { canPush: true };

	/**
	 * What the freshness check answers: `null` for a sign-in with life in it, an `Error` for one that
	 * has run out and could not be renewed. The real one clears the credential in that case, so this
	 * one does too — every screen renders the not-signed-in state, and the sequence's expiry step is a
	 * reading of that plus the sentence.
	 */
	expiry: Error | null = null;

	/** The App's own grant screen, composed from the fake App exactly as the real storage does. */
	grantAccessUrl(options: { readonly targetId: number }): string {
		return composeGrantAccessUrl({ app: FAKE_APP, targetId: options.targetId });
	}

	beginGitHubSignIn(options: { readonly installed?: boolean } = {}): string {
		this.signInsBegun += 1;
		// A refusal is a trip that never started, so it records no departure — which is what makes
		// "the browser would not keep the state" distinguishable from "it left".
		if (this.signInRefusal === '') {
			this.signInDepartures.push(
				signInDepartureUrl({
					app: FAKE_APP,
					redirectUri: FAKE_REDIRECT_URI,
					state: FAKE_STATE,
					installed: options.installed ?? false
				})
			);
		}
		return this.signInRefusal;
	}

	async ensureCredentialFresh(): Promise<void> {
		await Promise.resolve();
		const ranOut = this.expiry;
		if (ranOut === null) return;
		// The real one clears the grant record along with the credential, so the check that follows an
		// expiry finds nothing to check rather than reporting the same expiry for ever.
		this.expiry = null;
		this.signOut();
		throw ranOut;
	}

	/** Every value the preference was set to, in order, so a press is distinguishable from a render. */
	readonly remembers: boolean[] = [];

	setRememberSignIn(remember: boolean): void {
		this.remembers.push(remember);
		this.rememberSignIn = remember;
	}

	signOut(): void {
		this.signOuts += 1;
		this.signedIn = false;
		this.identity = '';
		this.credential = null;
	}

	async readRights(): Promise<RemoteRights> {
		this.rightsReads += 1;
		await Promise.resolve();
		if (this.rightsAnswer instanceof Error) throw this.rightsAnswer;
		return this.rightsAnswer;
	}

	/**
	 * The two-sided rule the real storage answers, over the same evidence and the same function: this
	 * Workspace's own tree, what the last status check saw on the Remote's, and the recorded
	 * withdrawal. A fake that answered a stored flag could not falsify a surface that ignored the
	 * Remote's half.
	 */
	async hasShareLinks(): Promise<boolean> {
		await Promise.resolve();
		return observedShareLinks({
			workspace: this.shareLinks,
			remote: this.remoteStatusState.shareLinks,
			withdrawing: this.withdrawing
		});
	}

	async enableShareLinks(): Promise<RemotePagesOutcome> {
		this.pagesAsks += 1;
		await Promise.resolve();
		if (this.pagesAnswer instanceof Error) throw this.pagesAnswer;
		// The real one writes the viewer into the Workspace before it asks GitHub anything, and keeps
		// it whatever the answer is — which is what puts the withdrawal beside a refusal.
		this.withdrawing = false;
		this.shareLinks = true;
		return this.pagesAnswer;
	}

	async checkShareLinks(): Promise<RemotePagesOutcome> {
		this.pagesChecks += 1;
		await Promise.resolve();
		if (this.checkAnswer instanceof Error) throw this.checkAnswer;
		return this.checkAnswer;
	}

	async withdrawShareLinks(): Promise<RemotePagesWithdrawal> {
		this.pagesWithdrawals += 1;
		await Promise.resolve();
		if (this.withdrawalAnswer instanceof Error) throw this.withdrawalAnswer;
		// The real one records the asking before the files go, because the Remote's copy is not
		// removed until the next Sync carries it out.
		this.withdrawing = true;
		this.shareLinks = false;
		return this.withdrawalAnswer;
	}

	async unbindRemote(): Promise<void> {
		this.unbinds += 1;
		await Promise.resolve();
		if (this.unbindAnswer !== null) throw this.unbindAnswer;
		this.remote = null;
		this.baseline = null;
	}

	async checkRemoteStatus(): Promise<void> {
		this.checks += 1;
		await Promise.resolve();
	}

	async updateFromRemote(): Promise<void> {
		this.updates += 1;
		await Promise.resolve();
	}

	async bindRemote(remote: RemoteReference, token: string | null): Promise<RemoteBindOutcome> {
		this.bindCalls.push({ remote, token });
		await Promise.resolve();
		if (this.bindAnswer instanceof Error) throw this.bindAnswer;
		// The real one records the binding on the Workspace, and every surface that says which
		// repository this Workspace has is a reading of exactly that rather than of anything this call
		// returned.
		this.remote = { ...this.bindAnswer.remote };
		return this.bindAnswer;
	}
}

/** A connection that worked, with push rights. Override a field per test. */
export function outcome(over: Partial<RemoteBindOutcome> = {}): RemoteBindOutcome {
	return {
		remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
		canPush: true,
		rightsNotice: '',
		...over
	};
}

/** Share Links on, with nothing left to say and nowhere left to send anybody. */
export const pagesOn = (): RemotePagesOutcome => ({
	enabled: true,
	next: 'none',
	instruction: '',
	settingsUrl: '',
	branch: ''
});

/**
 * The guided step: GitHub refused, and what is owed is the screen, the branch and the folder.
 *
 * The ordinary answer rather than a rare one — ADR-0040 refuses `Administration: write` for the App,
 * and `POST /pages` needs it — so it is a named fixture rather than an override spelled per test.
 */
export const pagesGuided = (instruction: string): RemotePagesOutcome => ({
	enabled: false,
	next: 'guided',
	instruction,
	settingsUrl: 'https://github.com/ada/atlas/settings/pages',
	branch: 'main'
});

/** What the sequence is mounted with. `open` is a signal, which is what the next function is for. */
export type SequenceProps = {
	open: boolean;
	storage: WorkspaceStorage;
	onsync: () => void;
	list: (token: string) => Promise<GrantedRepositoriesOutcome>;
	/**
	 * Which repository a pasted address means.
	 *
	 * ⚠ **Injected in every mount rather than left to its default**, because the default is the real
	 * anonymous probe: a test that pressed the inbound door's button without one would reach for the
	 * network, which both seams' fences refuse.
	 */
	resolveAddress: (pasted: string) => Promise<AddressResolution>;
};

/**
 * Mounting props whose `open` a test can write, so closing and reopening is one sequence rather
 * than two mounts.
 *
 * ⚠ **What `connect-to-github.dom.test.ts` asserts here is the same component being closed and
 * opened again**, and a remount would assert something weaker: everything a fresh component reads
 * is by definition a fresh reading, so a state left behind on close would go unnoticed. `mount`
 * treats a state proxy as reactive props, so writing `open` here is the author pressing Close and
 * then the navigation bar's control.
 */
export function sequenceProps(over: Omit<SequenceProps, 'open'>): SequenceProps {
	const props = $state({ open: true, ...over });
	return props;
}
