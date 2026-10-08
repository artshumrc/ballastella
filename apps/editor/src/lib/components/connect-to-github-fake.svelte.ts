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

import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

type BindCall = { readonly remote: RemoteReference; readonly token: string | null };

export const FAKE_APP: GitHubApp = {
	brokerOrigin: 'https://broker.fake.invalid',
	clientId: 'Iv1.fakeclientid',
	appSlug: 'fake-app'
};

export const FAKE_REDIRECT_URI = 'https://atlas.fake.invalid/editor/';
export const FAKE_STATE = 'fakestate';

export class FakeStorage {
	bound = $state<{ owner: string; repository: string; branch: string } | null>(null);
	signInWithGitHubOffered = $state(true);
	name = $state('Atlas');
	signedIn = $state(false);
	identity = $state('');
	rememberSignIn = $state(false);
	credential = $state<string | null>(null);
	baseline = $state<SynchronizationBaseline | null>(null);
	status = $state<RemoteStatusState>(UNCHECKED_REMOTE_STATUS);
	readonly bindCalls: BindCall[] = [];
	signInsBegun = 0;
	readonly signInDepartures: string[] = [];
	signInRefusal = '';
	bindAnswer: RemoteBindOutcome | Error = outcome();
	pagesAsks = 0;
	pagesChecks = 0;
	pagesWithdrawals = 0;
	pagesAnswer: RemotePagesOutcome | Error = pagesOn();
	checkAnswer: RemotePagesOutcome | Error = pagesOn();
	withdrawalAnswer: RemotePagesWithdrawal | Error = { disabled: true, notice: '' };
	shareLinks = $state(false);
	pagesSetupByHand = $state(false);
	withdrawing = $state(false);
	signOuts = 0;
	unbinds = 0;
	checks = 0;
	rightsReads = 0;
	rightsAnswer: RemoteRights | Error = { canPush: true };
	expiry: Error | null = null;
	readonly github = this;
	readonly remote = this;

	grantAccessUrl(options: { readonly targetId: number }): string {
		return composeGrantAccessUrl({ app: FAKE_APP, targetId: options.targetId });
	}

	beginGitHubSignIn(options: { readonly installed?: boolean } = {}): string {
		this.signInsBegun += 1;
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
		this.expiry = null;
		this.signOut();
		throw ranOut;
	}

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

	async hasShareLinks(): Promise<boolean> {
		await Promise.resolve();
		return observedShareLinks({
			workspace: this.shareLinks,
			remote: this.status.shareLinks,
			withdrawing: this.withdrawing
		});
	}

	async enableShareLinks(): Promise<RemotePagesOutcome> {
		this.pagesAsks += 1;
		await Promise.resolve();
		if (this.pagesAnswer instanceof Error) throw this.pagesAnswer;
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
		this.withdrawing = true;
		this.shareLinks = false;
		return this.withdrawalAnswer;
	}

	async unbind(): Promise<void> {
		this.unbinds += 1;
		await Promise.resolve();
		this.bound = null;
		this.baseline = null;
	}

	async check(): Promise<void> {
		this.checks += 1;
		await Promise.resolve();
	}

	async bind(remote: RemoteReference, token: string | null): Promise<RemoteBindOutcome> {
		this.bindCalls.push({ remote, token });
		await Promise.resolve();
		if (this.bindAnswer instanceof Error) throw this.bindAnswer;
		this.bound = { ...this.bindAnswer.remote };
		return this.bindAnswer;
	}
}

export function outcome(over: Partial<RemoteBindOutcome> = {}): RemoteBindOutcome {
	return {
		remote: { owner: 'ada', repository: 'atlas', branch: 'main' },
		canPush: true,
		rightsNotice: '',
		...over
	};
}

const pagesOn = (): RemotePagesOutcome => ({
	enabled: true,
	next: 'none',
	instruction: '',
	settingsUrl: '',
	branch: ''
});

export const pagesGuided = (instruction: string): RemotePagesOutcome => ({
	enabled: false,
	next: 'guided',
	instruction,
	settingsUrl: 'https://github.com/ada/atlas/settings/pages',
	branch: 'main'
});

type SequenceProps = {
	open: boolean;
	storage: WorkspaceStorage;
	onsync: () => void;
	list: (token: string) => Promise<GrantedRepositoriesOutcome>;
	resolveAddress: (pasted: string) => Promise<AddressResolution>;
};

export function sequenceProps(over: Omit<SequenceProps, 'open'>): SequenceProps {
	const props = $state({ open: true, ...over });
	return props;
}
