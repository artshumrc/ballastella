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
// Workspace came from there* — and a reader who opened somebody's public Workspace has a legitimate
// connected-but-unable-to-push state (see `clone-from-remote.ts`). So a `permissions.push` of
// `false` is a sentence, and the caller records the relationship anyway.
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
// AND THE SUBSET REFUSAL, WHICH IS THE ONE THAT SAVES SOMEBODY'S WORK
//
// ADR-0033: *"If the Remote carries a `ballastella-site.json` listing Projects this Workspace does
// not have, refuse to bind and name them."* It is ADR-0024's *"restoring a backup creates a new
// named Workspace and switches to it — it never overwrites and never merges"* applied to a
// repository, and it is here because connecting is the last moment at which the answer costs
// nothing.
//
// **It catches two Workspaces, not one.** The obvious one is a second machine: a laptop connected to
// the repository the desktop published from, whose first send would delete every Project the laptop
// has not got. The other is a Workspace this app itself made — a Clone that stopped part way — and
// it is why the check is a refusal rather than a notice.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { parsePublishedSite, type PublishedProject } from '../publish/publish.js';
import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import { Workspace } from '../project/workspace.js';
import { PUBLISHED_SITE_RECORD_NAME } from '../transfer/viewer-files.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';
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
	/** Defaulting to the page's own, as the publish engine and the place lookup already do. */
	readonly fetch?: FetchFn;
};

/** Why a binding did not happen, in the words the user should see. */
export type RemoteBindRefusal =
	/** GitHub would not accept the credential at all: a mistyped, expired, or revoked token. */
	| 'credential'
	/** No such repository, or none this credential can see — which looks the same from here. */
	| 'no-repository'
	/**
	 * The Remote carries Projects this Workspace has not got, so publishing to it would delete them.
	 *
	 * The remedy is Open a Workspace from GitHub, never a merge: ADR-0024 refuses to answer the
	 * collision, and there is no honest resolution for two Alignments of one sheet.
	 */
	| 'projects-not-here'
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
	 * publish would be refused", and that is the only question being asked.
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
	/** `''` when the site is gone; otherwise the sentence saying it may not be. */
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

const request = (options: BindRemoteOptions): FetchFn =>
	options.fetch ?? ((input, init) => fetch(input, init));

const repositoryUrl = (remote: RemoteReference): string =>
	`${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repository)}`;

const headers = (token: string): Record<string, string> => ({
	Accept: 'application/vnd.github+json',
	Authorization: `Bearer ${token}`
});

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
 * Ask GitHub whether this credential may push to this repository.
 *
 * @throws RemoteBindRefusedError when the credential is rejected, or there is no such repository
 */
export async function readRemoteRights(options: BindRemoteOptions): Promise<RemoteRights> {
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
		throw new RemoteBindRefusedError('no-repository', noRepositoryMessage(remote));
	}
	if (!response.ok) {
		throw new RemoteBindRefusedError('refused', refusedMessage(remote, await problemOf(response)));
	}

	const body = (await response.json().catch(() => ({}))) as { permissions?: { push?: unknown } };
	return { canPush: body.permissions?.push === true };
}

/**
 * The Projects the Remote's own site record lists, or `[]` when it has nothing to say.
 *
 * ⚠ **Read from `raw.githubusercontent.com`, which is where a repository's *bytes* live** — the
 * API answers file lists, and this is one file. One request and none of the hourly budget.
 *
 * ⚠ **Credentialed, and the reason is that the check below is otherwise inert.** The raw host
 * answers 404 for a private repository read without one, so an unauthenticated read makes
 * `published` empty and the subset refusal silently never fires — a second machine binds to a
 * private Remote carrying Projects it has not got, and the one thing standing between it and
 * deleting them is skipped without a word. Private repositories are out of scope, but nothing here
 * refuses one, so this must not quietly drop its own protection on them. The token costs
 * nothing extra: {@link readRemoteRights} has already established with it that this repository
 * exists and is pushable, so it has been sent to GitHub for this repository a moment ago, and the
 * raw host takes `Authorization: Bearer`.
 *
 * ⚠ **Every failure answers "nothing listed", and that is a deliberate asymmetry.** A 404 is the
 * ordinary case — a repository that has never been published to — and a network blip, a 500, or a
 * record this build cannot parse are all *we cannot say*. Refusing to bind over any of them would
 * stop a scholar binding a perfectly good repository because a CDN hiccuped, and it is the refusal
 * below rather than this read that is load-bearing: what it protects against is a Remote that
 * demonstrably lists Projects this Workspace has not got.
 */
async function readRemoteProjects(
	options: BindRemoteOptions
): Promise<readonly PublishedProject[]> {
	const { remote, token } = options;
	const branch = remote.branch ?? DEFAULT_REMOTE_BRANCH;
	// Per segment: a branch name may hold a `/`, and the raw host resolves one across its segments
	// itself — while a `#` in one is a fragment that would silently truncate the request.
	const url =
		`${GITHUB_RAW_ORIGIN}/${encodeURIComponent(remote.owner)}/` +
		`${encodeURIComponent(remote.repository)}/` +
		`${branch.split('/').map(encodeURIComponent).join('/')}/${PUBLISHED_SITE_RECORD_NAME}`;
	try {
		const response = await request(options)(url, {
			headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
		});
		if (!response.ok) return [];
		return parsePublishedSite(new Uint8Array(await response.arrayBuffer())).projects;
	} catch {
		return [];
	}
}

/** Where a repository's Pages settings live, which is the one screen the guided step sends to. */
export const pagesSettingsUrl = (remote: RemoteReference): string =>
	`https://github.com/${encodeURIComponent(remote.owner)}/` +
	`${encodeURIComponent(remote.repository)}/settings/pages`;

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
 * Connect a Workspace to a repository: refuse a Review Workspace, then ask GitHub the two questions
 * that can refuse.
 *
 * The order is the design. The review refusal is first because a Review Workspace must not so much
 * as *ask* GitHub a question with somebody's credential attached (ADR-0024); the rights check next,
 * because a credential GitHub will not look at is the cheaper answer and the one that makes every
 * later question meaningless; the subset refusal last, because it is the one that costs a request
 * against the raw host.
 *
 * ⚠ **Nothing is written to the Workspace here, and nothing on the Remote is touched.** The
 * relationship is the caller's to keep (ADR-0044), so a refusal leaves the Workspace exactly as it
 * was by construction rather than by an unwind.
 *
 * ⚠ **Nothing here asks for Share Links.** {@link enableRemotePages} is a later, optional act with
 * its own press, for the reason the header gives.
 *
 * @throws ReviewWorkspaceError when the Workspace is a review copy (ADR-0024)
 * @throws RemoteBindRefusedError when GitHub refuses the credential, has no such repository, or
 *   carries Projects this Workspace has not got (ADR-0033)
 */
export async function bindWorkspaceToRemote(
	store: ProjectStore,
	workspaceName: string,
	options: BindRemoteOptions
): Promise<RemoteBindOutcome> {
	assertNotReviewing(
		workspaceName,
		await readReviewMark(store),
		'connected to a repository on GitHub'
	);
	const rights = await readRemoteRights(options);

	const published = await readRemoteProjects(options);
	if (published.length > 0) {
		// Asked only when the Remote has something to be missing, so an ordinary bind to an empty
		// repository still reads no Project files at all.
		const here = new Set(
			(await new Workspace(store).listProjects()).map((project) => project.directory)
		);
		// By directory rather than by name: the directory is a Project's identity and what `?p=` names
		// (ADR-0008), while the name is what the scholar recognises — so the comparison uses the first
		// and the sentence uses the second.
		const missing = published.filter((project) => !here.has(project.directory));
		if (missing.length > 0) {
			throw new RemoteBindRefusedError(
				'projects-not-here',
				notHereMessage(options.remote, missing)
			);
		}
	}

	return {
		remote: {
			owner: options.remote.owner,
			repository: options.remote.repository,
			branch: options.remote.branch ?? DEFAULT_REMOTE_BRANCH
		},
		canPush: rights.canPush,
		rightsNotice: rights.canPush ? '' : noPushMessage(options.remote)
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

/**
 * What the subset refusal says, and where it sends the scholar instead.
 *
 * ⚠ **It names the Projects, and it names Open a Workspace from GitHub.** "This Workspace is
 * missing work" is not something anybody can act on; *"“Amsterdam 1625” is on it and is not here"*
 * is. And the remedy has to be on the same screen as the refusal, because the alternative a scholar
 * will otherwise reach for is to bind anyway from a second machine and publish — which is the loss
 * this refusal exists to prevent. The guided sequence renders the control beside this sentence, so
 * the operation it names is a press rather than an instruction to go and find one.
 */
function notHereMessage(remote: RemoteReference, missing: readonly PublishedProject[]): string {
	const names = missing.map((project) => `“${project.name || project.directory}”`).join(', ');
	const are = missing.length === 1 ? 'is a Project' : 'are Projects';
	return (
		`${describeRemote(remote)} already carries work from Ballastella, and ${names} ${are} on it ` +
		`that this Workspace has not got. Publishing this Workspace there would delete ` +
		`${missing.length === 1 ? 'it' : 'them'}, so nothing has been bound and the token has not been ` +
		`kept. Open ${describeRemote(remote)} from GitHub instead: that brings the whole of it down ` +
		`into a new Workspace of its own, and never overwrites or merges anything you already have. ` +
		`If this Workspace is a copy that stopped part way through downloading, opening it from ` +
		`GitHub again is the way to finish it.`
	);
}

function noPushMessage(remote: RemoteReference): string {
	return (
		`This token cannot push to ${describeRemote(remote)}, so publishing to it will be refused. ` +
		`The binding has been kept anyway, because it records where this Workspace belongs. To ` +
		`publish, use a fine-grained personal access token with “Contents: Read and write” for this ` +
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
		`Nothing is wrong with your token and nothing needs fixing. Publish once: that makes the ` +
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
 * What withdrawing Share Links cannot undo, said before it happens.
 *
 * ⚠ **It is not a way to unpublish, and it is never presented as one** (ADR-0045). A scholar who
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
