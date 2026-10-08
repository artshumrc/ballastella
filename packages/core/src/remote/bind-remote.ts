import type { FetchFn } from '../injection/store-image-fetch.js';
import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import { githubFetch, problemOf, repoApiUrl } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote, type RemoteReference } from './remote-binding.js';
import { messageOf, type ProjectStore } from '../store/project-store.js';

type BindRemoteOptions = {
	readonly token: string;
	readonly remote: RemoteReference;
	readonly fetch?: FetchFn;
};

type ConnectRemoteOptions = Omit<BindRemoteOptions, 'token'> & {
	readonly token: string | null;
};

type RemoteBindRefusal = 'credential' | 'no-repository' | 'refused';

export class RemoteBindRefusedError extends Error {
	override readonly name = 'RemoteBindRefusedError';
	constructor(
		readonly refusal: RemoteBindRefusal,
		message: string
	) {
		super(message);
	}
}

export type RemoteRights = {
	readonly canPush: boolean;
};

type RemotePagesNext = 'none' | 'sync-first' | 'guided';

export type RemotePagesOutcome = {
	readonly enabled: boolean;
	readonly next: RemotePagesNext;
	readonly instruction: string;
	readonly settingsUrl: string;
	readonly branch: string;
};

export type RemotePagesWithdrawal = {
	readonly disabled: boolean;
	readonly notice: string;
};

export type RemoteBindOutcome = {
	readonly remote: Required<RemoteReference>;
	readonly canPush: boolean;
	readonly rightsNotice: string;
};

const pagesUrl = (remote: RemoteReference): string => `${repoApiUrl(remote)}/pages`;

export async function readRemoteRights(options: ConnectRemoteOptions): Promise<RemoteRights> {
	const { remote, token } = options;
	const response = await githubFetch(
		options.fetch,
		token
	)(repoApiUrl(remote)).catch((cause) => {
		throw new RemoteBindRefusedError('refused', unreachableMessage(remote, cause));
	});
	if (response.status === 401) throw new RemoteBindRefusedError('credential', credentialMessage());
	if (response.status === 404) {
		throw new RemoteBindRefusedError(
			'no-repository',
			token === null ? noPublicRepositoryMessage(remote) : noRepositoryMessage(remote)
		);
	}
	if (!response.ok) {
		throw new RemoteBindRefusedError('refused', refusedMessage(remote, await problemOf(response)));
	}

	const body = (await response.json().catch(() => ({}))) as { permissions?: { push?: unknown } };
	return { canPush: body.permissions?.push === true };
}

export const pagesSettingsUrl = (remote: RemoteReference): string =>
	`https://github.com/${encodeURIComponent(remote.owner)}/` +
	`${encodeURIComponent(remote.repository)}/settings/pages`;

export function publishedSiteUrl(remote: RemoteReference): string {
	const host = `${remote.owner.toLowerCase()}.github.io`;
	return remote.repository.toLowerCase() === host
		? `https://${host}/`
		: `https://${host}/${remote.repository}/`;
}

export function projectShareUrl(remote: RemoteReference, directory: string): string {
	return `${publishedSiteUrl(remote)}?p=${encodeURIComponent(directory)}`;
}

const pagesOn: RemotePagesOutcome = {
	enabled: true,
	next: 'none',
	instruction: '',
	settingsUrl: '',
	branch: ''
};

const pagesOff = (
	remote: RemoteReference,
	next: RemotePagesNext,
	instruction: (remote: RemoteReference, branch: string) => string
): RemotePagesOutcome => {
	const branch = remote.branch ?? DEFAULT_REMOTE_BRANCH;
	return {
		enabled: false,
		next,
		instruction: instruction(remote, branch),
		settingsUrl: pagesSettingsUrl(remote),
		branch
	};
};

export async function enableRemotePages(options: BindRemoteOptions): Promise<RemotePagesOutcome> {
	const { remote, token } = options;
	const response = await githubFetch(options.fetch, token)(pagesUrl(remote), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ source: { branch: remote.branch ?? DEFAULT_REMOTE_BRANCH, path: '/' } })
	}).catch(() => null);
	if (response?.status === 409 || response?.ok) return pagesOn;
	if (response?.status === 422) return pagesOff(remote, 'sync-first', noBranchYet);
	return pagesOff(remote, 'guided', pagesInstruction);
}

export const guidedPagesStep = (remote: RemoteReference): RemotePagesOutcome =>
	pagesOff(remote, 'guided', pagesByHandMessage);

export const PAGES_POLL_DELAYS: readonly number[] = [0, 2_000, 4_000, 8_000, 16_000];

export async function readRemotePages(options: BindRemoteOptions): Promise<boolean> {
	const response = await githubFetch(
		options.fetch,
		options.token
	)(pagesUrl(options.remote)).catch(() => null);
	return response?.ok === true;
}

export async function awaitRemotePages(
	options: BindRemoteOptions & { readonly wait?: (milliseconds: number) => Promise<void> }
): Promise<RemotePagesOutcome> {
	const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	for (const delay of PAGES_POLL_DELAYS) {
		if (delay > 0) await wait(delay);
		if (await readRemotePages(options)) return pagesOn;
	}
	return pagesOff(options.remote, 'guided', pagesInstruction);
}

export async function disableRemotePages(
	options: BindRemoteOptions
): Promise<RemotePagesWithdrawal> {
	const response = await githubFetch(options.fetch, options.token)(pagesUrl(options.remote), {
		method: 'DELETE'
	}).catch(() => null);
	if (response?.ok || response?.status === 404) return { disabled: true, notice: '' };
	return { disabled: false, notice: siteStillUpMessage(options.remote) };
}

export async function bindWorkspaceToRemote(
	store: ProjectStore,
	workspaceName: string,
	options: ConnectRemoteOptions
): Promise<RemoteBindOutcome> {
	assertNotReviewing(workspaceName, await readReviewMark(store), 'given a repository on GitHub');
	const rights = await readRemoteRights(options);

	return {
		remote: {
			owner: options.remote.owner,
			repository: options.remote.repository,
			branch: options.remote.branch ?? DEFAULT_REMOTE_BRANCH
		},
		canPush: rights.canPush,
		rightsNotice: rights.canPush || options.token === null ? '' : noPushMessage(options.remote)
	};
}

const credentialMessage = (): string =>
	`GitHub would not accept that token, so nothing has been bound and it has not been kept. A ` +
	`token that has expired or been revoked looks exactly like a mistyped one from here. Make a ` +
	`new fine-grained personal access token, give it access to this repository, and paste the ` +
	`whole of it.`;

const noRepositoryMessage = (remote: RemoteReference): string =>
	`GitHub has no repository at ${describeRemote(remote)}, or none this token can see, so ` +
	`nothing has been bound. Check the owner and the repository name — a private repository looks ` +
	`exactly like a missing one to somebody who cannot open it, and a fine-grained token reaches ` +
	`only the repositories it was given. If you have not made it yet, create it on GitHub first ` +
	`and choose Public.`;

const noPublicRepositoryMessage = (remote: RemoteReference): string =>
	`GitHub has no public repository at ${describeRemote(remote)}, so nothing has been ` +
	`connected. From here a private repository looks exactly like a missing one, because this ` +
	`reads GitHub without signing in — check the owner and the repository name, and sign in if ` +
	`the repository is a private one.`;

const refusedMessage = (remote: RemoteReference, detail: string): string =>
	`GitHub refused to say anything about ${describeRemote(remote)}: ${detail}. Nothing has been ` +
	`bound and the token has not been kept.`;

const unreachableMessage = (remote: RemoteReference, cause: unknown): string =>
	`GitHub could not be reached, so nothing has been bound and the token has not been kept. The ` +
	`browser reported: ${messageOf(cause)}. This is about the connection rather than about ` +
	`${describeRemote(remote)} — everything you have is still saved on this computer.`;

const noPushMessage = (remote: RemoteReference): string =>
	`This token cannot push to ${describeRemote(remote)}, so sending to it will be refused. ` +
	`The binding has been kept anyway, because it records where this Workspace belongs. To ` +
	`send, use a fine-grained personal access token with “Contents: Read and write” for this ` +
	`repository — or, if it is somebody else's, ask them for write access.`;

const noBranchYet = (remote: RemoteReference, branch: string): string =>
	`GitHub Pages is not on yet for ${describeRemote(remote)}, because the repository is empty — a ` +
	`repository created without a README has no “${branch}” branch for a site to be served from. ` +
	`Nothing is wrong with your token and nothing needs fixing. Sync once: that makes the ` +
	`branch. If the site still serves nothing afterwards, open ${describeRemote(remote)} → ` +
	`Settings → Pages, set Source to “Deploy from a branch”, choose “${branch}” and “/ (root)”, ` +
	`and press Save.`;

const pagesInstruction = (remote: RemoteReference, branch: string): string =>
	`GitHub Pages could not be turned on for ${describeRemote(remote)} — that needs both ` +
	`“Pages: Read and write” and “Administration: Read and write”, and this credential does not ` +
	`have them. It is one setting, done once: on GitHub open ${describeRemote(remote)} → Settings ` +
	`→ Pages, set Source to “Deploy from a branch”, choose the branch “${branch}” and the folder ` +
	`“/ (root)”, and press Save. Until then your files will arrive and the site will serve nothing.`;

const pagesByHandMessage = (remote: RemoteReference, branch: string): string =>
	`Turning the site on is one setting you make yourself for ${describeRemote(remote)}. GitHub ` +
	`requires “Administration: Read and write” before it will do it for anybody, and signing in to ` +
	`Ballastella never asks you for that — it does not ask for the right to rename, transfer or ` +
	`delete your repositories. So: open ${describeRemote(remote)} → Settings → Pages, set Source ` +
	`to “Deploy from a branch”, choose the branch “${branch}” and the folder “/ (root)”, and press ` +
	`Save. Then press Check again and Ballastella takes it from there. Until that setting is made ` +
	`your files will arrive and the site will serve nothing.`;

const siteStillUpMessage = (remote: RemoteReference): string =>
	`GitHub would not turn the site off for ${describeRemote(remote)}, so it may still answer. ` +
	`The viewer's files will be taken out of the repository on the next Sync either way, and your ` +
	`own work is untouched. To turn it off by hand, open ${pagesSettingsUrl(remote)} and set ` +
	`Source to “None”.`;

export const withdrawalNotRecordedMessage = (remote: RemoteReference): string =>
	`This browser would not keep the record that ${describeRemote(remote)}'s site is to come down, ` +
	`so the next Sync will put the viewer's files back rather than take them out. Site data may be ` +
	`blocked for this site, or browser storage may be full. Withdraw Share Links again once that ` +
	`is fixed.`;

export const shareLinksWithdrawalMessage = (remote: RemoteReference): string =>
	`Withdrawing Share Links takes the reading site off ${describeRemote(remote)}: the viewer's ` +
	`files are removed on the next Sync and the address stops being served. It cannot make ` +
	`anything unseen. Every link you have already given out stops working, the address may keep ` +
	`answering from a cache for a while, and anything a reader has already downloaded or forked ` +
	`is beyond reach. Your repository and your own files are untouched, and you can ask for Share ` +
	`Links again at any time.`;
