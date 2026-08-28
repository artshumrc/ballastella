/**
 * The members of `WorkspaceStorage` the guided sequence reads, as a reactive fake.
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
	signInDepartureUrl,
	type GitHubApp,
	type GrantedRepositoriesOutcome,
	type RemoteBindOutcome,
	type RemotePagesOutcome,
	type RemoteReference
} from '@ballastella/core';

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
	credential = $state<string | null>(null);

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
	/** How many times the later Pages act was asked for. `0` is "nothing was asked of GitHub". */
	pagesAsks = 0;
	/** What `enablePages` answers, or throws when it is an `Error`. */
	pagesAnswer: RemotePagesOutcome | Error = { enabled: true, instruction: '' };
	/** How many times the sign-in was ended by a press. */
	signOuts = 0;
	/**
	 * What the freshness check answers: `null` for a sign-in with life in it, an `Error` for one that
	 * has run out and could not be renewed. The real one clears the credential in that case, so this
	 * one does too — every screen renders the not-signed-in state, and the sequence's expiry step is a
	 * reading of that plus the sentence.
	 */
	expiry: Error | null = null;

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

	signOut(): void {
		this.signOuts += 1;
		this.signedIn = false;
		this.identity = '';
		this.credential = null;
	}

	async enablePages(): Promise<RemotePagesOutcome> {
		this.pagesAsks += 1;
		await Promise.resolve();
		if (this.pagesAnswer instanceof Error) throw this.pagesAnswer;
		return this.pagesAnswer;
	}

	async bindRemote(remote: RemoteReference, token: string | null): Promise<RemoteBindOutcome> {
		this.bindCalls.push({ remote, token });
		await Promise.resolve();
		if (this.bindAnswer instanceof Error) throw this.bindAnswer;
		// The real one records the binding on the Workspace, and the sequence's `connected` step is a
		// reading of exactly that rather than of anything this call returned.
		const { owner, repository, branch } = this.bindAnswer.binding;
		this.remote = { owner, repository, branch };
		return this.bindAnswer;
	}
}

/** A binding that worked, with push rights. Override a field per test. */
export function outcome(over: Partial<RemoteBindOutcome> = {}): RemoteBindOutcome {
	return {
		binding: {
			formatVersion: 1,
			owner: 'ada',
			repository: 'atlas',
			branch: 'main'
		},
		canPush: true,
		rightsNotice: '',
		...over
	};
}

/** What the sequence is mounted with. `open` is a signal, which is what the next function is for. */
export type SequenceProps = {
	open: boolean;
	storage: WorkspaceStorage;
	onpublish: () => void;
	list: (token: string) => Promise<GrantedRepositoriesOutcome>;
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
