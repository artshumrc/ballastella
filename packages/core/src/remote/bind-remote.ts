// Connecting a Workspace to a repository: the rights check (ADR-0033), and the separate later act
// of asking for Share Links.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE RIGHTS ARE ASKED FOR HERE AND NOT AT THE PUSH
//
// ADR-0033: *"Push rights are checked when a Remote is bound, not when 4,000 tiles have finished
// uploading."* One `GET /repos/{owner}/{repo}` answers it, before a byte is sent, at the moment the
// user is already thinking about this repository. Discovered afterwards it is the worst news at the
// worst moment, and the upload it follows spent an hour of somebody's afternoon and most of an
// hourly request budget.
//
// **A refusal does not refuse the connection.** The relationship is also provenance — *this
// Workspace came from there* — and a reader who got somebody's public repository has a
// legitimate connected-but-unable-to-push state. So a `permissions.push` of `false` is a sentence,
// and the caller records the relationship anyway.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// CONNECTING NEEDS NO CREDENTIAL, BECAUSE GETTING DOES NOT
//
// A public repository is readable by anyone, so {@link bindWorkspaceToRemote} takes `token: null`
// and asks GitHub the same question with no `Authorization` header at all (ADR-0044). That is the
// whole of how a student with no GitHub account seeds a Workspace from their instructor's
// repository: make a Workspace, connect it, get.
//
// ⚠ **An anonymous connection says nothing whatever about push rights.** GitHub returns no
// `permissions` at all to a reader it does not know, so `canPush` is `false` for "certainly not"
// and for "nobody asked" alike — and {@link RemoteBindOutcome.rightsNotice} is therefore empty
// rather than carrying {@link noPushMessage}. Whether this author may send is a question a sign-in
// answers, and a screen that reported it from here would be stating a fact it could not have
// checked (ADR-0044).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SHARE LINKS ARE NOT PART OF CONNECTING, AND FAIL INTO A SENTENCE WHEN THEY ARE ASKED FOR
//
// A Remote is a place the work lives before it is a site anybody reads (ADR-0045), so
// {@link enableRemotePages} is a separate, later, optional act — asked for in the Workspace's own
// settings and never made during a connection. Made during one, it answered a question about a
// permission that the author had not asked, in the middle of onboarding.
//
// `POST /repos/{owner}/{repo}/pages` needs `Pages: write` **and** `Administration: write` together,
// and ADR-0040 refuses `Administration` for the App outright — so on a correctly configured
// deployment this call is routinely refused, and the refusal is a *step* rather than an error at the
// end: {@link pagesSettingsUrl}, the branch, `/ (root)`, and {@link awaitRemotePages} polling until
// the site answers. Nothing here ever throws: a repository full of correct files that serves nothing
// is the failure this exists to avoid, and an error dialog is a worse one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND NOTHING HERE REFUSES A REPOSITORY FOR HOLDING WORK THIS WORKSPACE HAS NOT GOT
//
// ADR-0033 used to refuse that binding, because the first send would have deleted every Project the
// Workspace had not got. It cannot any more: a send removes only what the Synchronization Baseline
// recorded, so a Workspace with no Baseline removes nothing at all in either direction, and the
// Projects the repository holds read as *To get* on the Sync modal instead (ADR-0044). The refusal
// was protection against a deletion that is now impossible, and keeping it would refuse the case it
// used to be for: a scholar connecting an existing Workspace to an existing repository.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import { GITHUB_API_ORIGIN } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote } from './remote-binding.js';
import type { ProjectStore } from '../store/project-store.js';

/** The repository an act is about, before its branch has been resolved. */
export type RemoteReference = {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
};

export type BindRemoteOptions = {
	/**
	 * An opaque bearer credential. Where it came from is not this module's business (ADR-0031):
	 * a pasted fine-grained token and a broker-exchanged one are the same string here.
	 */
	readonly token: string;
	readonly remote: RemoteReference;
	/** Defaulting to the page's own, as the send engine and the place lookup already do. */
	readonly fetch?: FetchFn;
};

/**
 * The same, for the two acts that may be done with no credential at all.
 *
 * ⚠ **Connecting and reading rights are the only two, and Share Links are deliberately not among
 * them.** Every Pages call writes to somebody's repository, so those keep {@link BindRemoteOptions}
 * and cannot be reached without a token — which is a property of the types rather than a check.
 */
export type ConnectRemoteOptions = Omit<BindRemoteOptions, 'token'> & {
	readonly token: string | null;
};

/** Why a binding did not happen, in the words the user should see. */
export type RemoteBindRefusal =
	/** GitHub would not accept the credential at all: a mistyped, expired, or revoked token. */
	| 'credential'
	/** No such repository, or none this credential can see — which looks the same from here. */
	| 'no-repository'
	/** Anything else GitHub said. */
	| 'refused';

/** Binding was refused, with nothing written and no credential kept. */
export class RemoteBindRefusedError extends Error {
	readonly refusal: RemoteBindRefusal;

	constructor(refusal: RemoteBindRefusal, message: string) {
		super(message);
		this.name = 'RemoteBindRefusedError';
		this.refusal = refusal;
	}
}

/** What GitHub says about this credential and this repository. */
export type RemoteRights = {
	/**
	 * Whether the credential may push to it.
	 *
	 * `false` for a token with no write permission **and** for a response carrying no `permissions`
	 * at all, which is what an unauthenticated read of a public repository answers. Both mean "this
	 * send would be refused", and that is the only question being asked.
	 */
	readonly canPush: boolean;
};

/**
 * What the author is owed next, when GitHub would not turn Pages on by itself.
 *
 * ⚠ **`sync-first` is not a permission problem and must never be reported as one.** A repository
 * created at `github.com/new` with no README has no branch at all, so there is nothing for Pages to
 * be pointed at *yet* and nothing to fix — see {@link noBranchYet}.
 */
export type RemotePagesNext = 'none' | 'sync-first' | 'guided';

/** What happened when Share Links were asked for. */
export type RemotePagesOutcome = {
	readonly enabled: boolean;
	/** What is owed next: nothing, one Sync, or the guided step. */
	readonly next: RemotePagesNext;
	/** `''` when Pages is on; otherwise the sentence saying what happened and what to do. */
	readonly instruction: string;
	/**
	 * The repository's own Pages settings screen, for the guided step's link. `''` when Pages is on.
	 *
	 * On the outcome rather than composed by whoever renders it, so the link, the branch and the
	 * sentence naming both come from one place and cannot come to disagree.
	 */
	readonly settingsUrl: string;
	/** The branch to choose on that screen, resolved. `''` when Pages is on. */
	readonly branch: string;
};

/** What happened when Share Links were withdrawn. */
export type RemotePagesWithdrawal = {
	/** Whether GitHub reports the site gone — including a repository that never had one. */
	readonly disabled: boolean;
	/**
	 * What the author has to be told about the withdrawal, or `''` when there is nothing.
	 *
	 * ⚠ **Not the negation of {@link disabled}.** {@link disableRemotePages} fills it only where the
	 * site may still answer, but a caller that also has to keep the withdrawal *request* has a second
	 * thing to say — {@link withdrawalNotRecordedMessage} — and says it here, over a site GitHub did
	 * take down. So a reader renders whatever is in it and never infers it from `disabled`.
	 */
	readonly notice: string;
};

/** A connection that was made, and everything the user has to be told about it. */
export type RemoteBindOutcome = {
	/** The repository, with its branch resolved. What the caller records as the relationship. */
	readonly remote: Required<RemoteReference>;
	readonly canPush: boolean;
	/** `''` when the credential may push; otherwise the sentence saying it may not. */
	readonly rightsNotice: string;
};

const request = (options: ConnectRemoteOptions): FetchFn =>
	options.fetch ?? ((input, init) => fetch(input, init));

const repositoryUrl = (remote: RemoteReference): string =>
	`${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repository)}`;

const headers = (token: string | null): Record<string, string> =>
	token === null
		? { Accept: 'application/vnd.github+json' }
		: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };

/** GitHub's own words for a refusal, which are more useful than a status code alone. */
async function problemOf(response: Response): Promise<string> {
	try {
		const body = (await response.json()) as { message?: unknown };
		return typeof body?.message === 'string' ? body.message : response.statusText;
	} catch {
		return response.statusText;
	}
}

/**
 * Ask GitHub whether this credential may push to this repository — or, with none, whether the
 * repository is there to be read at all.
 *
 * @throws RemoteBindRefusedError when the credential is rejected, or there is no such repository
 */
export async function readRemoteRights(options: ConnectRemoteOptions): Promise<RemoteRights> {
	const { remote, token } = options;
	let response: Response;
	try {
		response = await request(options)(repositoryUrl(remote), { headers: headers(token) });
	} catch (cause) {
		// A `fetch` that rejects is the network, a blocked request, or a browser extension — never a
		// judgement about the repository. Said as itself rather than as "no such repository", which
		// would send the user off to check a name that is fine.
		throw new RemoteBindRefusedError('refused', unreachableMessage(remote, cause));
	}
	if (response.status === 401) throw new RemoteBindRefusedError('credential', credentialMessage());
	// ⚠ GitHub answers 404 for a repository that does not exist **and** for one the credential cannot
	// see, so a typo, a private repository, and a token scoped to somebody else's account are one
	// answer here. The message says so rather than asserting the first of the three.
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

/** Where a repository's Pages settings live, which is the one screen the guided step sends to. */
export const pagesSettingsUrl = (remote: RemoteReference): string =>
	`https://github.com/${encodeURIComponent(remote.owner)}/` +
	`${encodeURIComponent(remote.repository)}/settings/pages`;

/**
 * The address a repository's Published Site answers at, once Share Links are on.
 *
 * GitHub Pages serves an owner's own `<login>.github.io` repository at the domain root and every
 * other repository in a folder beneath it, so the two cases are one line apart and the wrong one is
 * an address that answers nothing. Case-insensitively, because GitHub's own comparison is:
 * `Ada/Ada.github.io` is the root site too.
 */
export function publishedSiteUrl(remote: RemoteReference): string {
	const host = `${remote.owner.toLowerCase()}.github.io`;
	return remote.repository.toLowerCase() === host
		? `https://${host}/`
		: `https://${host}/${remote.repository}/`;
}

/**
 * The link that opens one Project on that site — the whole of what *Share Project* hands over.
 *
 * ⚠ **`?p=<directory>` and nothing else** (ADR-0045). There is no token, no signature and nothing
 * unguessable in it: the repository is readable and the files are fetchable, so being on the Front
 * Page is discovery and never permission. Anything here that looked like a secret would invite the
 * one reading a scholar with embargoed material must not take.
 */
export function projectShareUrl(remote: RemoteReference, directory: string): string {
	return `${publishedSiteUrl(remote)}?p=${encodeURIComponent(directory)}`;
}

/** The site is on: the one outcome with nothing left to say and nowhere left to send anybody. */
const pagesOn: RemotePagesOutcome = {
	enabled: true,
	next: 'none',
	instruction: '',
	settingsUrl: '',
	branch: ''
};

/**
 * Turn GitHub Pages on for this repository, or say what to click.
 *
 * Never throws, and answers one of four things (ADR-0045). A `409` is *already enabled*, which is
 * success — a scholar asking again on a second machine meets it every time; a `2xx` is the site
 * newly on; a `422` is a repository with no branch and is answered as one Sync rather than as a
 * permission; and everything else — which on a correctly configured deployment is the ordinary
 * answer, because ADR-0040 refuses `Administration: write` — is the guided step.
 */
export async function enableRemotePages(options: BindRemoteOptions): Promise<RemotePagesOutcome> {
	const { remote, token } = options;
	const branch = remote.branch ?? DEFAULT_REMOTE_BRANCH;
	let response: Response;
	try {
		response = await request(options)(`${repositoryUrl(remote)}/pages`, {
			method: 'POST',
			headers: { ...headers(token), 'content-type': 'application/json' },
			body: JSON.stringify({ source: { branch, path: '/' } })
		});
	} catch {
		return guidedStep(remote, branch);
	}
	if (response.status === 409 || response.ok) return pagesOn;
	// ⚠ **422 is a repository with no branches, not a token without `Pages: write`.** GitHub cannot
	// point Pages at a branch that does not exist, and a repository created at `github.com/new` with
	// no README has none at all — which is exactly the sequence the guided flow walks the scholar
	// through, and exactly what its own prefilled link produces. Collapsed into
	// {@link pagesInstruction} it tells them to fix a permission that is fine and then to choose a
	// branch their repository does not have.
	if (response.status === 422) {
		return {
			enabled: false,
			next: 'sync-first',
			instruction: noBranchYet(remote, branch),
			settingsUrl: pagesSettingsUrl(remote),
			branch
		};
	}
	return guidedStep(remote, branch);
}

const guidedStep = (remote: RemoteReference, branch: string): RemotePagesOutcome => ({
	enabled: false,
	next: 'guided',
	instruction: pagesInstruction(remote, branch),
	settingsUrl: pagesSettingsUrl(remote),
	branch
});

/**
 * How long to wait between polls of a site that has not answered yet, in milliseconds.
 *
 * Backed off rather than evenly spaced, and the first one is immediate: an author who has just
 * pressed Save on github.com is answered at once where GitHub was quick, and a site that takes half
 * a minute to appear costs five requests rather than thirty. Bounded because *Check again* is a
 * press with a result, not a background job — a poll that never gave up would leave the author
 * watching a spinner with no way to be told what to do next.
 */
export const PAGES_POLL_DELAYS: readonly number[] = [0, 2_000, 4_000, 8_000, 16_000];

export type AwaitRemotePagesOptions = BindRemoteOptions & {
	/** Injectable so the poll's whole sequence is a test costing milliseconds. */
	readonly wait?: (milliseconds: number) => Promise<void>;
};

/**
 * Whether GitHub now reports a Pages site for this repository.
 *
 * Never throws. Anything but a `2xx` is *not yet*: a repository whose site has never been turned on
 * answers `404`, and a network failure is not evidence that the author did the wrong thing.
 */
export async function readRemotePages(options: BindRemoteOptions): Promise<boolean> {
	try {
		const response = await request(options)(`${repositoryUrl(options.remote)}/pages`, {
			headers: headers(options.token)
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Poll until the site answers, and then carry on — what *Check again* does.
 *
 * ⚠ **The waiting and the verifying are ours** (ADR-0045). The author does one thing on github.com;
 * asking them to guess when it took effect, and to press again until it does, is the part of the
 * manual step that is avoidable. So one press polls {@link PAGES_POLL_DELAYS} and answers either the
 * site being on or the same guided step it was already on, which is a screen they can act on again.
 */
export async function awaitRemotePages(
	options: AwaitRemotePagesOptions
): Promise<RemotePagesOutcome> {
	const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	for (const delay of PAGES_POLL_DELAYS) {
		if (delay > 0) await wait(delay);
		if (await readRemotePages(options)) return pagesOn;
	}
	return guidedStep(options.remote, branch);
}

/**
 * Take the Pages site down, or say that it may still be answering.
 *
 * Never throws, for {@link enableRemotePages}'s reason. A `404` is a repository with no site, which
 * is the state being asked for — an author who withdraws twice must not be told the second attempt
 * failed. The repository and the scholar's files are untouched either way: what removes the viewer
 * from the tree is the next Sync, not this call.
 */
export async function disableRemotePages(
	options: BindRemoteOptions
): Promise<RemotePagesWithdrawal> {
	let response: Response;
	try {
		response = await request(options)(`${repositoryUrl(options.remote)}/pages`, {
			method: 'DELETE',
			headers: headers(options.token)
		});
	} catch {
		return { disabled: false, notice: siteStillUpMessage(options.remote) };
	}
	if (response.ok || response.status === 404) return { disabled: true, notice: '' };
	return { disabled: false, notice: siteStillUpMessage(options.remote) };
}

/**
 * Connect a Workspace to a repository: refuse a Review Workspace, then ask GitHub who is asking.
 *
 * The order is the design. The review refusal is first because a Review Workspace must not so much
 * as *ask* GitHub a question with somebody's credential attached (ADR-0024); the rights check
 * second, and it is the one request this makes — it establishes that the repository exists, that
 * this credential can see it, and whether it can push.
 *
 * ⚠ **A repository already holding Ballastella work is not refused** (ADR-0044). See this module's
 * header: with no Baseline a Sync removes nothing in either direction, so what that repository
 * holds is work to get rather than work about to be deleted.
 *
 * ⚠ **Nothing is written to the Workspace here, and nothing on the Remote is touched.** The
 * relationship is the caller's to keep (ADR-0044), so a refusal leaves the Workspace exactly as it
 * was by construction rather than by an unwind.
 *
 * ⚠ **Nothing here asks for Share Links.** {@link enableRemotePages} is a later, optional act with
 * its own press, for the reason the header gives.
 *
 * @throws ReviewWorkspaceError when the Workspace is a review copy (ADR-0024)
 * @throws RemoteBindRefusedError when GitHub refuses the credential or has no such repository
 */
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
		// ⚠ **Silent where nobody was asked.** An anonymous read carries no `permissions`, so a
		// `canPush` of `false` here means "unknown" rather than "refused" — and saying the second
		// would tell a signed-out student that GitHub had turned them down.
		rightsNotice: rights.canPush || options.token === null ? '' : noPushMessage(options.remote)
	};
}

// ── What the refusals and the notices say ─────────────────────────────────────────────────────

function credentialMessage(): string {
	return (
		`GitHub would not accept that token, so nothing has been bound and it has not been kept. A ` +
		`token that has expired or been revoked looks exactly like a mistyped one from here. Make a ` +
		`new fine-grained personal access token, give it access to this repository, and paste the ` +
		`whole of it.`
	);
}

function noRepositoryMessage(remote: RemoteReference): string {
	return (
		`GitHub has no repository at ${describeRemote(remote)}, or none this token can see, so ` +
		`nothing has been bound. Check the owner and the repository name — a private repository looks ` +
		`exactly like a missing one to somebody who cannot open it, and a fine-grained token reaches ` +
		`only the repositories it was given. If you have not made it yet, create it on GitHub first ` +
		`and choose Public.`
	);
}

/**
 * No public repository there — which, to a reader who has signed in to nothing, is also what a
 * private one looks like.
 *
 * Separate from {@link noRepositoryMessage} because none of that sentence's three causes is this
 * author's: there is no token to have mistyped, to have expired, or to have been scoped to the
 * wrong account.
 */
function noPublicRepositoryMessage(remote: RemoteReference): string {
	return (
		`GitHub has no public repository at ${describeRemote(remote)}, so nothing has been ` +
		`connected. From here a private repository looks exactly like a missing one, because this ` +
		`reads GitHub without signing in — check the owner and the repository name, and sign in if ` +
		`the repository is a private one.`
	);
}

function refusedMessage(remote: RemoteReference, detail: string): string {
	return (
		`GitHub refused to say anything about ${describeRemote(remote)}: ${detail}. Nothing has been ` +
		`bound and the token has not been kept.`
	);
}

function unreachableMessage(remote: RemoteReference, cause: unknown): string {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return (
		`GitHub could not be reached, so nothing has been bound and the token has not been kept. The ` +
		`browser reported: ${detail}. This is about the connection rather than about ` +
		`${describeRemote(remote)} — everything you have is still saved on this computer.`
	);
}

function noPushMessage(remote: RemoteReference): string {
	return (
		`This token cannot push to ${describeRemote(remote)}, so sending to it will be refused. ` +
		`The binding has been kept anyway, because it records where this Workspace belongs. To ` +
		`send, use a fine-grained personal access token with “Contents: Read and write” for this ` +
		`repository — or, if it is somebody else's, ask them for write access.`
	);
}

/**
 * What to say when the repository has no branch for Pages to serve from.
 *
 * A repository with nothing in it has no branches, so there is nothing for Pages to be pointed at
 * *yet* — and nothing to fix. The remedy is the thing the scholar was going to do next anyway, and
 * saying "your token lacks a permission" here sends them to a settings page to correct something
 * that is already right.
 */
function noBranchYet(remote: RemoteReference, branch: string): string {
	return (
		`GitHub Pages is not on yet for ${describeRemote(remote)}, because the repository is empty — a ` +
		`repository created without a README has no “${branch}” branch for a site to be served from. ` +
		`Nothing is wrong with your token and nothing needs fixing. Sync once: that makes the ` +
		`branch. If the site still serves nothing afterwards, open ${describeRemote(remote)} → ` +
		`Settings → Pages, set Source to “Deploy from a branch”, choose “${branch}” and “/ (root)”, ` +
		`and press Save.`
	);
}

/**
 * What to click when Pages could not be turned on — which setting, where, and what to choose.
 *
 * ⚠ **It names both permissions, because GitHub requires both.** `POST /pages` needs `Pages: write`
 * and `Administration: write` together; ADR-0040 refuses `Administration` for the App, so this is
 * the ordinary answer rather than a rare one. Naming only `Pages` blames the permission the author
 * did grant and sends them to a settings screen that was already right.
 *
 * The wording `docs/hosting.md` Part 2 step 3 carries, said where a scholar meets the problem rather
 * than in a document they would have to be told to open.
 */
function pagesInstruction(remote: RemoteReference, branch: string): string {
	return (
		`GitHub Pages could not be turned on for ${describeRemote(remote)} — that needs both ` +
		`“Pages: Read and write” and “Administration: Read and write”, and this credential does not ` +
		`have them. It is one setting, done once: on GitHub open ${describeRemote(remote)} → Settings ` +
		`→ Pages, set Source to “Deploy from a branch”, choose the branch “${branch}” and the folder ` +
		`“/ (root)”, and press Save. Until then your files will arrive and the site will serve nothing.`
	);
}

/**
 * What to say when GitHub would not take the site down.
 *
 * The address is the thing a scholar has given out, so a withdrawal that only half happened has to
 * be said rather than swallowed: the viewer files still go on the next Sync, and what is left is a
 * site serving a repository with nothing in it to serve.
 */
function siteStillUpMessage(remote: RemoteReference): string {
	return (
		`GitHub would not turn the site off for ${describeRemote(remote)}, so it may still answer. ` +
		`The viewer's files will be taken out of the repository on the next Sync either way, and your ` +
		`own work is untouched. To turn it off by hand, open ${pagesSettingsUrl(remote)} and set ` +
		`Source to “None”.`
	);
}

/**
 * What to say when this browser would not keep the withdrawal request.
 *
 * ⚠ **The request is the whole of what makes the Remote's viewer set mean *remove*** (ADR-0045). A
 * Remote carrying a viewer set the Workspace does not is also a Workspace freshly got from a Remote
 * that has a site, and rebuilding is the safe reading of that pair — so an unrecorded withdrawal is
 * not a withdrawal that half happened but one the next Sync silently reverses. Said here for
 * {@link siteStillUpMessage}'s reason: the address is the thing a scholar has given out.
 */
export function withdrawalNotRecordedMessage(remote: RemoteReference): string {
	return (
		`This browser would not keep the record that ${describeRemote(remote)}'s site is to come down, ` +
		`so the next Sync will put the viewer's files back rather than take them out. Site data may be ` +
		`blocked for this site, or browser storage may be full. Withdraw Share Links again once that ` +
		`is fixed.`
	);
}

/**
 * What withdrawing Share Links cannot undo, said before it happens.
 *
 * ⚠ **It is not a way to take the work back, and it is never presented as one** (ADR-0045). A scholar who
 * reads "turn the site off" as "make it unseen" will act on that reading — with an embargoed
 * photograph, or a manuscript under a library's restriction — so the three things it cannot promise
 * are named in the confirmation rather than in a document nobody opens.
 */
export function shareLinksWithdrawalMessage(remote: RemoteReference): string {
	return (
		`Withdrawing Share Links takes the reading site off ${describeRemote(remote)}: the viewer's ` +
		`files are removed on the next Sync and the address stops being served. It cannot make ` +
		`anything unseen. Every link you have already given out stops working, the address may keep ` +
		`answering from a cache for a while, and anything a reader has already downloaded or forked ` +
		`is beyond reach. Your repository and your own files are untouched, and you can ask for Share ` +
		`Links again at any time.`
	);
}
