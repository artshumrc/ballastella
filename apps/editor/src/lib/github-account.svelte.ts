import {
	GITHUB_APP,
	SIGN_IN_STATE_KEY,
	browserCredentialStore,
	clearGrantRecord,
	clearRememberedGrant,
	closedWhileReviewing,
	describeCallbackRefusal,
	durableCredentialStorage,
	exchangeAuthorizationCode,
	grantAccessUrl as composeGrantAccessUrl,
	isGitHubAppConfigured,
	isGrantFresh,
	newSignInState,
	readGitHubLogin,
	readGrantRecord,
	readRememberSignIn,
	readRememberedGrant,
	refreshGitHubToken,
	signInAgainMessage,
	signInDepartureUrl,
	verifySignInState,
	writeGrantRecord,
	writeRememberSignIn,
	writeRememberedGrant,
	GitHubCallbackRefusedError,
	GitHubSignInError,
	type CredentialStorage,
	type CredentialStore,
	type DurableCredentialStorage,
	type GitHubTokenGrant,
	type SignInCallback
} from '@ballastella/core';

import { readItem, sessionArea, takeItem, writeItem } from './browser-storage.js';

const SIGN_IN_RETURN_KEY = 'ballastella.github-sign-in-return';
const SIGN_IN_REDIRECT_KEY = 'ballastella.github-sign-in-redirect';

const sealedStorage = (
	readable: () => boolean,
	removable: () => boolean,
	inner: CredentialStorage
): CredentialStorage => ({
	getItem: (key) => (readable() ? inner.getItem(key) : null),
	setItem: (key, value) => {
		if (readable()) inner.setItem(key, value);
	},
	removeItem: (key) => {
		if (removable()) inner.removeItem(key);
	}
});

const callbackUri = (): string => `${globalThis.location.origin}${globalThis.location.pathname}`;

type GitHubAccountHost = {
	readonly reviewing: () => boolean;
	readonly recovered: () => Promise<void>;
	readonly onSignedIn: () => void;
};

export class GitHubAccount {
	signedIn = $state(false);
	rememberSignIn = $state(false);
	identity = $state('');
	readonly signInWithGitHubOffered = isGitHubAppConfigured(GITHUB_APP);

	readonly #host: GitHubAccountHost;
	readonly #credentials: CredentialStore;
	readonly #grants: CredentialStorage;
	readonly #durable: DurableCredentialStorage = durableCredentialStorage();
	readonly #remembered: CredentialStorage;

	constructor(host: GitHubAccountHost) {
		this.#host = host;
		const own = () => !host.reviewing();
		this.#credentials = closedWhileReviewing(host.reviewing, browserCredentialStore());
		this.#grants = sealedStorage(own, own, sessionArea);
		this.#remembered = sealedStorage(() => this.rememberSignIn && own(), own, this.#durable);
	}

	get credential(): string | null {
		return this.#credentials.read();
	}

	get pagesSetupByHand(): boolean {
		const grant = readGrantRecord(this.#grants);
		return grant !== null && grant.token === this.#credentials.read();
	}

	refresh(): void {
		const held = this.#credentials.read() !== null;
		const gained = held && !this.signedIn;
		this.signedIn = held;

		if (gained) this.#host.onSignedIn();
	}

	keepPasted(token: string): void {
		this.#credentials.write(token);
		this.#forgetGrant();
	}

	signOut(): void {
		this.#credentials.clear();
		this.identity = '';
		this.#forgetGrant();
	}

	#forgetGrant(): void {
		clearGrantRecord(this.#grants);
		clearRememberedGrant(this.#remembered);
		this.refresh();
	}

	setRememberSignIn(remember: boolean): void {
		this.rememberSignIn = remember;
		writeRememberSignIn(this.#durable, remember);
		if (!remember) {
			clearRememberedGrant(this.#remembered);
			return;
		}
		const grant = readGrantRecord(this.#grants);
		if (grant !== null) writeRememberedGrant(this.#remembered, grant);
	}

	grantAccessUrl(options: { readonly targetId: number }): string {
		return composeGrantAccessUrl({ app: GITHUB_APP, targetId: options.targetId });
	}

	beginGitHubSignIn(options: { readonly installed?: boolean } = {}): string {
		const state = newSignInState();
		const redirectUri = callbackUri();
		writeItem('sessionStorage', SIGN_IN_STATE_KEY, state);
		writeItem('sessionStorage', SIGN_IN_REDIRECT_KEY, redirectUri);
		writeItem('sessionStorage', SIGN_IN_RETURN_KEY, globalThis.location.search);
		if (readItem('sessionStorage', SIGN_IN_STATE_KEY) !== state) {
			return (
				`This browser will not let this page remember the sign-in it would be starting, so going ` +
				`to GitHub could only end in the reply being refused when you came back. It is usually a ` +
				`setting blocking storage for this site. Paste a personal access token below instead — ` +
				`that path needs none of this.`
			);
		}
		globalThis.location.assign(
			signInDepartureUrl({
				app: GITHUB_APP,
				redirectUri,
				state,
				installed: options.installed ?? false
			})
		);
		return '';
	}

	async completeGitHubSignIn(callback: SignInCallback): Promise<void> {
		const stored = takeItem('sessionStorage', SIGN_IN_STATE_KEY);
		const redirectUri = takeItem('sessionStorage', SIGN_IN_REDIRECT_KEY) ?? callbackUri();
		const refusal = verifySignInState(callback.state, stored);

		if (refusal !== '') throw new GitHubCallbackRefusedError(refusal);
		const declined = describeCallbackRefusal(callback);
		if (declined !== '') throw new GitHubSignInError(declined);

		if (this.#host.reviewing()) {
			throw new GitHubSignInError(
				`A review copy of somebody else's Project is open, so nothing has been signed in to. No ` +
					`GitHub sign-in is readable or writable while one is — go back to your own Workspace ` +
					`and sign in there.`
			);
		}

		const grant = await exchangeAuthorizationCode({
			app: GITHUB_APP,
			code: callback.code,
			redirectUri
		});

		this.#keepGrant(grant);
		this.identity = await readGitHubLogin({ token: grant.token });
	}

	async ensureCredentialFresh(): Promise<void> {
		const grant = readGrantRecord(this.#grants);
		if (grant === null) return;

		if (grant.token !== this.#credentials.read()) {
			clearGrantRecord(this.#grants);
			return;
		}
		if (isGrantFresh(grant, Date.now())) return;

		const renewed =
			grant.refreshToken === ''
				? null
				: await refreshGitHubToken({ app: GITHUB_APP, refreshToken: grant.refreshToken }).catch(
						() => null
					);
		if (renewed === null) {
			this.signOut();
			throw new GitHubSignInError(signInAgainMessage());
		}
		this.#keepGrant(renewed);
	}

	consumeSignInReturn(): string {
		return takeItem('sessionStorage', SIGN_IN_RETURN_KEY) ?? '';
	}

	async restoreRememberedSignIn(): Promise<void> {
		await this.#durable.settled();
		this.rememberSignIn = readRememberSignIn(this.#durable);
		await this.#host.recovered();
		if (!this.rememberSignIn) return;

		if (this.#credentials.read() !== null) {
			const held = readGrantRecord(this.#grants);
			if (held !== null && held.token === this.#credentials.read()) {
				writeRememberedGrant(this.#remembered, held);
			}
			return;
		}
		const remembered = readRememberedGrant(this.#remembered);
		if (remembered === null) return;
		try {
			const renewed = await refreshGitHubToken({
				app: GITHUB_APP,
				refreshToken: remembered.refreshToken
			});

			this.#keepGrant(renewed);
			this.identity = await readGitHubLogin({ token: renewed.token });
		} catch {
			clearRememberedGrant(this.#remembered);
		}
	}

	#keepGrant(grant: GitHubTokenGrant): void {
		writeGrantRecord(this.#grants, grant);
		this.#credentials.write(grant.token);
		writeRememberedGrant(this.#remembered, grant);
		this.refresh();
	}
}
