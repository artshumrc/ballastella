// Whatever address a student happens to have, turned into the repository it means.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// CANDIDATES RATHER THAN AN ANSWER, BECAUSE ONE PAGES ADDRESS IS TWO REAL LAYOUTS
//
// `ada.github.io/atlas` is `ada/atlas` served at a subpath **or** a folder called `atlas` inside the
// user site repository `ada/ada.github.io`. Both are ordinary GitHub Pages layouts and the address
// carries nothing that separates them, so no parser can answer this and no author should be asked
// to: the question is GitHub's, and GitHub is asked. The candidates are probed in order against the
// same unauthenticated tree listing a Clone reads, and the first that holds a Workspace wins.
//
// ⚠ **This is beside {@link parseRemoteReference} rather than inside it.** That one guards a *bind* —
// the address a Workspace will publish to — where one answer or none is the only safe shape, and a
// function that sometimes means two repositories has no business deciding where somebody's work
// goes. This one only ever opens somebody else's public Remote, which changes nothing anywhere.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A CUSTOM DOMAIN IS A REFUSAL AND CANNOT BE ANYTHING ELSE
//
// Pages serves a repository at whatever domain its author points at it, and the site says nowhere
// which repository that was. So a host that is neither `github.com` nor `*.github.io` produces no
// candidates at all, and the sentence names what to paste instead — anything else would be guessing
// at repository names on somebody's behalf and spending an anonymous reader's hourly budget on it.
//
// ⚠ **No `Authorization` header reaches any of this**, for {@link readRemoteTree}'s reason: this is
// the path a student with no GitHub account takes, and a credential sent here would make an account
// a prerequisite for the one operation that needs none (ADR-0031, ADR-0043).

import type { FetchFn } from '../injection/store-image-fetch.js';
import { describeReset } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH, isOwnerName, isRepositoryName } from './remote-binding.js';
import { RemoteTreeRefusedError, readRemoteTree } from './remote-tree.js';
import { projectDirectories } from './synchronization-paths.js';

/** One repository a pasted address could mean. */
export type AddressCandidate = {
	readonly owner: string;
	readonly repository: string;
	/** Why this candidate was derived, for the confirmation the author reads. */
	readonly why: string;
};

/**
 * Which repository an address turned out to mean, or why it could not be said.
 *
 * A sentence rather than a kind, because nothing above this branches on which refusal it was: every
 * one of them is read by the person who pasted the address, and each names what to do next.
 */
export type AddressResolution =
	| {
			readonly kind: 'resolved';
			readonly remote: { readonly owner: string; readonly repository: string };
			readonly why: string;
	  }
	| { readonly kind: 'refused'; readonly message: string };

/**
 * Every repository a pasted address could mean, in the order they are worth asking GitHub about.
 *
 * | Pasted | Candidates |
 * | --- | --- |
 * | `owner/repository` | `owner/repository` |
 * | `github.com/owner/repository` | `owner/repository` |
 * | `<owner>.github.io/<segment>` | `owner/segment`, then `owner/owner.github.io` |
 * | `<owner>.github.io` | `owner/owner.github.io` |
 *
 * A scheme, a `www.`, a trailing slash and a `.git` are all tolerated, exactly as
 * {@link parseRemoteReference} tolerates them: the likeliest paste is the whole of what was in an
 * address bar.
 *
 * ⚠ **Both segments are checked against GitHub's own character sets before they leave here**, and
 * `.` and `..` are refused by name — everything downstream interpolates them into a URL path, where
 * `ada/..` addresses an endpoint about a *user* and climbs out of the repository on the raw host.
 */
export function workspaceAddressCandidates(pasted: string): readonly AddressCandidate[] {
	const trimmed = pasted
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/^www\./i, '')
		// The trailing slash first, for `parseRemoteReference`'s reason: a clone URL is `…/atlas.git`,
		// and stripping the suffix first leaves `atlas.git` behind for anybody whose copy had a slash.
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '');
	if (trimmed === '') return [];

	const [host = '', ...rest] = trimmed.split('/');
	if (/^github\.com$/i.test(host)) return repositoryNamed(rest);

	const pages = /^(.+)\.github\.io$/i.exec(host);
	if (pages !== null) return publishedSite(pages[1] ?? '', rest);

	// A host of somebody's own is the one shape with a reason rather than a typo behind it, and it is
	// told apart from a short `owner/repository` by the dot no owner name may hold.
	if (host.includes('.')) return [];
	return repositoryNamed([host, ...rest]);
}

/**
 * The repository an address names outright, which is one candidate or none.
 *
 * Nothing deeper is taken: a URL naming a file inside a repository is not a repository, and
 * truncating one to its first two segments would open something the author did not name.
 */
function repositoryNamed(segments: readonly string[]): readonly AddressCandidate[] {
	if (segments.length !== 2) return [];
	const [owner = '', repository = ''] = segments;
	if (!isOwnerName(owner) || !isRepositoryName(repository)) return [];
	return [{ owner, repository, why: `Your address names ${owner}/${repository}.` }];
}

/**
 * The two repositories a Published Site's address could be served from.
 *
 * ⚠ **The project site comes first.** `ada.github.io/atlas` is far more often the repository
 * `ada/atlas` served at a subpath than a folder called `atlas` inside `ada`'s own site repository,
 * and this order is what decides which of two repositories that both exist a student opens.
 *
 * A deeper address — a page *inside* the site, which is what an address bar usually holds — reads
 * the same, because only its first segment can be a repository name.
 */
function publishedSite(owner: string, rest: readonly string[]): readonly AddressCandidate[] {
	if (!isOwnerName(owner)) return [];
	const userSite = `${owner}.github.io`;
	const segment = rest[0];
	const candidates: AddressCandidate[] = [];
	if (segment !== undefined && segment !== '' && segment !== userSite) {
		if (!isRepositoryName(segment)) return [];
		candidates.push({
			owner,
			repository: segment,
			why:
				`A published site at ${userSite}/${segment} is usually the repository ` +
				`${owner}/${segment}.`
		});
	}
	candidates.push({
		owner,
		repository: userSite,
		why:
			candidates.length === 0
				? `A published site at ${userSite} is ${owner}'s own site, ${owner}/${userSite}.`
				: `It could instead be a folder called “${segment ?? ''}” inside ${owner}'s own site, ` +
					`${owner}/${userSite}.`
	});
	return candidates;
}

/**
 * Which repository a pasted address means, asked of GitHub rather than of the author.
 *
 * Each candidate's file list is read anonymously and in order, and the first that holds a Project is
 * the answer. A repository that is missing, private or empty is simply not the one and the next is
 * tried; anything that says nothing about *which* candidate is right — the hourly limit, a truncated
 * listing, a GitHub that could not be reached — stops the probe and is reported, because carrying on
 * would end in "no Workspace anywhere" over a question that was never answered.
 *
 * ⚠ **This resolves and does not transfer.** What comes back is confirmed by the author before a
 * download that may run to gigabytes begins.
 */
export async function resolveWorkspaceAddress(
	pasted: string,
	fetchFn?: FetchFn
): Promise<AddressResolution> {
	const candidates = workspaceAddressCandidates(pasted);
	if (candidates.length === 0) return { kind: 'refused', message: notAnAddressMessage(pasted) };

	for (const candidate of candidates) {
		const remote = { ...candidate, branch: DEFAULT_REMOTE_BRANCH };
		let paths: readonly string[];
		try {
			paths = (await readRemoteTree(remote, fetchFn)).map((blob) => blob.path);
		} catch (cause) {
			const stop = stopsTheProbe(candidate, cause);
			if (stop !== null) return { kind: 'refused', message: stop };
			continue;
		}
		// The same question a Clone asks of the same listing: a top-level directory holding a
		// `project.json` is a Project, and a repository with none of them holds no Workspace whatever
		// else it is serving.
		if (projectDirectories(paths).size > 0) {
			return { kind: 'resolved', remote: candidate, why: candidate.why };
		}
	}
	return { kind: 'refused', message: noWorkspaceMessage(candidates) };
}

/**
 * The sentence a refusal that ends the probe carries, or `null` for one that only rules a candidate
 * out.
 *
 * `no-repository`, `not-public` and `empty` are the three that answer *this candidate is not the
 * one*: from a page that signs in to nothing, a private repository and a missing one look the same,
 * and an empty one holds nothing to open. Everything else is a fact about the reading rather than
 * about the repository, and reporting it as "no Workspace was found" would name the wrong cause.
 */
function stopsTheProbe(candidate: AddressCandidate, cause: unknown): string | null {
	const name = `${candidate.owner}/${candidate.repository}`;
	if (!(cause instanceof RemoteTreeRefusedError)) {
		return `GitHub could not be reached, so ${name} could not be read: ${String(cause)}.`;
	}
	switch (cause.refusal) {
		case 'no-repository':
		case 'not-public':
		case 'empty':
			return null;
		case 'rate-limited':
			return rateLimitedMessage(name, cause.resetAt);
		case 'truncated':
			return (
				`GitHub could only list the first ${cause.listed} files in ${name}, so Ballastella ` +
				`cannot tell whether the address you pasted means that repository. Nothing has been ` +
				`downloaded. Ask whoever published it for the “owner/repository” form of the address.`
			);
		case 'unreachable':
			return (
				`GitHub could not be reached, so ${name} could not be read. The browser reported: ` +
				`${cause.detail}. Everything you already have is still saved on this computer.`
			);
		case 'refused':
			return `GitHub refused to list ${name}: ${cause.detail}.`;
	}
}

/**
 * The hourly limit, said as a wait rather than as a fault in the address.
 *
 * ⚠ **Named as *anonymous* and the connection as *shared*, for `clone-from-remote.ts`'s reason.**
 * This path signs in to nothing, so the budget is GitHub's 60 requests an hour per internet
 * connection — and a class all opening their instructor's Workspace at once spends it between them.
 */
function rateLimitedMessage(name: string, resetAt: Date | null): string {
	const at = describeReset(resetAt);
	return (
		`GitHub's hourly limit for anonymous readers has been used up, so ${name} could not be ` +
		`read. Nothing is wrong with the address — opening a Workspace reads GitHub without signing ` +
		`in, and that allows 60 requests an hour for each internet connection, so on a shared one — a ` +
		`university network, a classroom — everybody's reading counts together. ` +
		`${at === '' ? 'Wait until the limit resets and try again' : `Try again after ${at}, when the limit resets`}.`
	);
}

/**
 * An address no repository can be derived from, which is one situation with two causes.
 *
 * A custom domain gets its own sentence because it is the one that is not a mistake: the address is
 * real, it is somebody's published site, and the fact that it cannot be traced back to a repository
 * is a property of GitHub Pages rather than of the paste.
 */
function notAnAddressMessage(pasted: string): string {
	const shown = pasted.trim();
	const host = shown
		.replace(/^https?:\/\//i, '')
		.replace(/^www\./i, '')
		.split('/')[0];
	const customDomain = host !== undefined && host.includes('.');
	return customDomain
		? `“${shown}” is a site on an address of its own, and a site like that says nothing about ` +
				`which repository on GitHub it was published from — so Ballastella cannot work out what ` +
				`to open. Paste the GitHub address instead: “owner/repository”, or the whole of ` +
				`https://github.com/owner/repository.`
		: `“${shown}” is not an address Ballastella can open. It takes “owner/repository”, the whole ` +
				`of https://github.com/owner/repository, or the address of a published site on ` +
				`github.io.`;
}

/** Every candidate read, and none of them a Workspace. */
function noWorkspaceMessage(candidates: readonly AddressCandidate[]): string {
	const names = candidates.map((one) => `${one.owner}/${one.repository}`).join(' or ');
	return (
		`Nothing that Ballastella can open is published at ${names}. Either there is no public ` +
		`repository there — from here a private one looks exactly like a missing one, because this ` +
		`reads GitHub without signing in — or what is published there was not published by ` +
		`Ballastella. Check the address with whoever gave it to you.`
	);
}
