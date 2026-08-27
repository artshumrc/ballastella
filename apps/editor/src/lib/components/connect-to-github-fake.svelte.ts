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

import type { RemoteBindOutcome, RemoteReference } from '@ballastella/core';

/** What `bindRemote` was called with, which is where "one act, existing code" is asserted. */
export type BindCall = { readonly remote: RemoteReference; readonly token: string | null };

export class FakeStorage {
	remote = $state<{ owner: string; repository: string; branch: string } | null>(null);
	/**
	 * Whether this deployment has a GitHub App at all — `isGitHubAppConfigured(GITHUB_APP)`, which the
	 * real storage computes once. A signal rather than a field so a spec can prove the sequence's
	 * first step is a reading of it and not a position chosen when the dialog opened.
	 */
	signInWithGitHubOffered = $state(true);
	/** The Workspace's name, which is what the fork's step fills the create-repository link in from. */
	name = $state('Atlas');
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

	beginGitHubSignIn(): string {
		this.signInsBegun += 1;
		return this.signInRefusal;
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
