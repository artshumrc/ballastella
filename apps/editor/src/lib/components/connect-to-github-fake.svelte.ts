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

import type {
	GrantedRepositoriesOutcome,
	RemoteBindOutcome,
	RemoteReference
} from '@ballastella/core';

import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

/** What `bindRemote` was called with, which is where "one act, existing code" is asserted. */
export type BindCall = { readonly remote: RemoteReference; readonly token: string | null };

export class FakeStorage {
	remote = $state<{ owner: string; repository: string; branch: string } | null>(null);
	signedIn = $state(false);
	identity = $state('');
	credential = $state<string | null>(null);

	/** Every call to {@link bindRemote}, in order. */
	readonly bindCalls: BindCall[] = [];
	/** How many times the sign-in was begun. */
	signInsBegun = 0;
	/** What `beginGitHubSignIn` answers: `''` for a redirect under way, a sentence for a refusal. */
	signInRefusal = '';
	/** What `bindRemote` answers, or throws when it is an `Error`. */
	bindAnswer: RemoteBindOutcome | Error = outcome();
	/** How many times the sign-in was ended by a press. */
	signOuts = 0;
	/**
	 * What the freshness check answers: `null` for a sign-in with life in it, an `Error` for one that
	 * has run out and could not be renewed. The real one clears the credential in that case, so this
	 * one does too — every screen renders the not-signed-in state, and the sequence's expiry step is a
	 * reading of that plus the sentence.
	 */
	expiry: Error | null = null;

	beginGitHubSignIn(): string {
		this.signInsBegun += 1;
		return this.signInRefusal;
	}

	async ensureCredentialFresh(): Promise<void> {
		await Promise.resolve();
		const ran_out = this.expiry;
		if (ran_out === null) return;
		// The real one clears the grant record along with the credential, so the check that follows an
		// expiry finds nothing to check rather than reporting the same expiry for ever.
		this.expiry = null;
		this.signOut();
		throw ran_out;
	}

	signOut(): void {
		this.signOuts += 1;
		this.signedIn = false;
		this.identity = '';
		this.credential = null;
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

/** A binding that worked, with push rights and Pages on. Override a field per test. */
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
		pages: { enabled: true, instruction: '' },
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
 * ⚠ **Story 34 is about the same component being closed and opened again**, and a remount would
 * assert something weaker: everything a fresh component reads is by definition a fresh reading, so
 * a state left behind on close would go unnoticed. `mount` treats a state proxy as reactive props,
 * so writing `open` here is the author pressing Close and then the navigation bar's control.
 */
export function sequenceProps(over: Omit<SequenceProps, 'open'>): SequenceProps {
	const props = $state({ open: true, ...over });
	return props;
}
