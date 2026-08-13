// Binding a Workspace to a repository: the rights check, and turning Pages on (ADR-0033).
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
// **A refusal does not refuse the binding.** The binding is provenance — *this Workspace came from
// there* — and a reader who cloned somebody's published Workspace has a legitimate bound-but-
// unable-to-push state (ticket 07). So a `permissions.push` of `false` is a sentence, and the
// document is written anyway.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PAGES ENABLEMENT FAILS INTO A SENTENCE, NEVER INTO AN ERROR
//
// `POST /repos/{owner}/{repo}/pages` needs `Pages: write`, which is a permission separate from
// `contents: write` and one a scholar creating a token by hand will often not have ticked. A
// repository full of correct files that serves nothing is the failure this exists to avoid (story
// 6); an error dialog over a binding that otherwise worked is a worse one. So every outcome except
// success carries {@link pagesInstruction} — which setting, where, and what to choose — and the
// binding stands.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AND THE SUBSET REFUSAL, WHICH IS THE ONE THAT SAVES SOMEBODY'S WORK
//
// ADR-0033: *"If the Remote carries a `ballastella-site.json` listing Projects this Workspace does
// not have, refuse to bind and name them."* It is ADR-0024's *"restoring a backup creates a new
// named Workspace and switches to it — it never overwrites and never merges"* applied to a
// repository, and it is here because binding is the last moment at which the answer costs nothing.
//
// **It catches two Workspaces, not one.** The obvious one is a second machine: a laptop bound to the
// repository the desktop published from, whose first publish would delete every Project the laptop
// has not got. The other is a Workspace this app itself made — a Clone that stopped part way — and
// it is why the check is a refusal rather than a notice. A Clone writes its binding last, so an
// interrupted one is left *unbound* and the Publish button has no target
// (`clone-from-remote.ts`); binding it by hand is the one remaining route into the same loss.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { parsePublishedSite, type PublishedProject } from '../publish/publish.js';
import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import { Workspace } from '../project/workspace.js';
import { PUBLISHED_SITE_RECORD_NAME } from '../transfer/viewer-files.js';
import { GITHUB_API_ORIGIN, GITHUB_RAW_ORIGIN } from './github-api.js';
import {
	DEFAULT_REMOTE_BRANCH,
	REMOTE_BINDING_FORMAT_VERSION,
	describeRemote,
	writeRemoteBinding,
	type RemoteBinding
} from './remote-binding.js';
import type { ProjectStore } from '../store/project-store.js';

/** The repository a bind is about, before there is a binding document for it. */
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
	 * The remedy is Clone, never a merge: ADR-0024 refuses to answer the collision, and there is no
	 * honest resolution for two Alignments of one sheet.
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

/** What happened when Pages enablement was attempted. */
export type RemotePagesOutcome = {
	readonly enabled: boolean;
	/** `''` when Pages is on; otherwise the instruction naming the setting and what to choose. */
	readonly instruction: string;
};

/** A binding that happened, and everything the user has to be told about it. */
export type RemoteBindOutcome = {
	readonly binding: RemoteBinding;
	readonly canPush: boolean;
	/** `''` when the credential may push; otherwise the sentence saying it may not. */
	readonly rightsNotice: string;
	readonly pages: RemotePagesOutcome;
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
 * ⚠ **Read from `raw.githubusercontent.com`, which is where SPEC puts a repository's *bytes*** — the
 * API answers file lists, and this is one file. One request and none of the hourly budget.
 *
 * ⚠ **Credentialed, and the reason is that the check below is otherwise inert.** The raw host
 * answers 404 for a private repository read without one, so an unauthenticated read makes
 * `published` empty and the subset refusal silently never fires — a second machine binds to a
 * private Remote carrying Projects it has not got, and the one thing standing between it and
 * deleting them is skipped without a word. SPEC puts private repositories out of scope, but nothing
 * here refuses one, so this must not quietly drop its own protection on them. The token costs
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

/**
 * Turn GitHub Pages on for this repository, or say what to click.
 *
 * Never throws. A `409` is *already enabled*, which is success — a scholar binding a second machine
 * to the repository they published from last week meets it every time.
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
		return { enabled: false, instruction: pagesInstruction(remote, branch) };
	}
	if (response.status === 409 || response.ok) return { enabled: true, instruction: '' };
	// ⚠ **422 is a repository with no branches, not a token without `Pages: write`.** GitHub cannot
	// point Pages at a branch that does not exist, and a repository created at `github.com/new` with
	// no README has none at all — which is exactly the sequence stories 6 to 8 walk the scholar
	// through, and exactly what this ticket's own prefilled link produces. Collapsed into
	// {@link pagesInstruction} it tells them to fix a permission that is fine and then to choose a
	// branch their repository does not have.
	if (response.status === 422) return { enabled: false, instruction: noBranchYet(remote, branch) };
	return { enabled: false, instruction: pagesInstruction(remote, branch) };
}

/**
 * Bind a Workspace to a repository: check the rights, write the document, offer Pages.
 *
 * The order is the design. The review refusal is first because a Review Workspace must not so much
 * as *ask* GitHub a question with somebody's credential attached (ADR-0024, story 40); the rights
 * check next, because it is the one remaining step that can refuse and a refusal has to leave the
 * Workspace exactly as it was — no `remote.json`, and a caller that keeps no credential. Pages is
 * last because its failure is a sentence rather than a refusal, and a binding that stood or fell by
 * it would refuse over a permission a scholar can grant afterwards in ten seconds.
 *
 * ⚠ **The review refusal is here *and* in `writeRemoteBinding`, deliberately.** Two layers, one
 * sentence: this one makes the refusal cost nothing, and the one on the write is what holds for a
 * caller that never comes through here — which is the argument `exportWorkspaceTar` and
 * `WorkspaceStorage.assertNotReviewing` already make about the same rule.
 *
 * The subset refusal goes between the two, for the reason the rights check comes before the write:
 * it is the other thing that can refuse, and a refusal has to leave the Workspace exactly as it was.
 * Second rather than first because a credential GitHub will not look at is the cheaper answer and
 * the one that makes every later question meaningless.
 *
 * @throws ReviewWorkspaceError when the Workspace is a review copy (ADR-0024, story 39)
 * @throws RemoteBindRefusedError when GitHub refuses the credential, has no such repository, or
 *   carries Projects this Workspace has not got (ADR-0033, story 23)
 */
export async function bindWorkspaceToRemote(
	store: ProjectStore,
	workspaceName: string,
	options: BindRemoteOptions
): Promise<RemoteBindOutcome> {
	assertNotReviewing(workspaceName, await readReviewMark(store), 'bound to a repository on GitHub');
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

	const binding: RemoteBinding = {
		formatVersion: REMOTE_BINDING_FORMAT_VERSION,
		owner: options.remote.owner,
		repository: options.remote.repository,
		branch: options.remote.branch ?? DEFAULT_REMOTE_BRANCH
	};
	await writeRemoteBinding(store, workspaceName, binding);
	return {
		binding,
		canPush: rights.canPush,
		rightsNotice: rights.canPush ? '' : noPushMessage(options.remote),
		pages: await enableRemotePages(options)
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
 * ⚠ **It names the Projects, and it names Clone.** "This Workspace is missing work" is not something
 * anybody can act on; *"“Amsterdam 1625” is on it and is not here"* is. And the remedy has to be on
 * the same screen as the refusal, because the alternative a scholar will otherwise reach for is to
 * bind anyway from a second machine and publish — which is the loss this refusal exists to prevent.
 */
function notHereMessage(remote: RemoteReference, missing: readonly PublishedProject[]): string {
	const names = missing.map((project) => `“${project.name || project.directory}”`).join(', ');
	const are = missing.length === 1 ? 'is a Project' : 'are Projects';
	return (
		`${describeRemote(remote)} already carries work from Ballastella, and ${names} ${are} on it ` +
		`that this Workspace has not got. Publishing this Workspace there would delete ` +
		`${missing.length === 1 ? 'it' : 'them'}, so nothing has been bound and the token has not been ` +
		`kept. Clone ${describeRemote(remote)} instead: that brings the whole of it down into a new ` +
		`Workspace of its own, and never overwrites or merges anything you already have. If this ` +
		`Workspace is a copy that stopped part way through downloading, cloning again is the way to ` +
		`finish it.`
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
 * The wording `docs/hosting.md` Part 2 step 3 carries, said where a scholar meets the problem rather
 * than in a document they would have to be told to open (story 7).
 */
function pagesInstruction(remote: RemoteReference, branch: string): string {
	return (
		`GitHub Pages could not be turned on for ${describeRemote(remote)} — that needs a token with ` +
		`“Pages: Read and write”, which this one does not have. It is one setting, done once: on ` +
		`GitHub open ${describeRemote(remote)} → Settings → Pages, set Source to “Deploy from a ` +
		`branch”, choose the branch “${branch}” and the folder “/ (root)”, and press Save. Until then ` +
		`your files will arrive and the site will serve nothing.`
	);
}
