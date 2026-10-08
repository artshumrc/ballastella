import type { FetchFn } from '../injection/store-image-fetch.js';
import { describeReset } from './github-api.js';
import {
	DEFAULT_REMOTE_BRANCH,
	describeRemote,
	isOwnerName,
	isRepositoryName
} from './remote-binding.js';
import { RemoteTreeRefusedError, readRemoteTree } from './remote-tree.js';
import { projectDirectories } from './synchronization-paths.js';

type AddressCandidate = {
	readonly owner: string;
	readonly repository: string;
	readonly why: string;
};

export type AddressResolution =
	| {
			readonly kind: 'resolved';
			readonly remote: { readonly owner: string; readonly repository: string };
			readonly why: string;
	  }
	| { readonly kind: 'refused'; readonly message: string };

const withoutScheme = (pasted: string): string =>
	pasted
		.trim()
		.replace(/^https?:\/\//i, '')
		.replace(/^www\./i, '');

export function workspaceAddressCandidates(pasted: string): readonly AddressCandidate[] {
	const trimmed = withoutScheme(pasted)
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '');
	if (trimmed === '') return [];

	const [host = '', ...rest] = trimmed.split('/');
	if (/^github\.com$/i.test(host)) return repositoryNamed(rest);
	const pages = /^(.+)\.github\.io$/i.exec(host);
	if (pages !== null) return publishedSite(pages[1] ?? '', rest);

	if (host.includes('.')) return [];
	return repositoryNamed([host, ...rest]);
}

function repositoryNamed(segments: readonly string[]): readonly AddressCandidate[] {
	if (segments.length !== 2) return [];
	const [owner = '', repository = ''] = segments;
	if (!isOwnerName(owner) || !isRepositoryName(repository)) return [];
	return [{ owner, repository, why: `Your address names ${owner}/${repository}.` }];
}

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

export async function resolveWorkspaceAddress(
	pasted: string,
	fetchFn?: FetchFn
): Promise<AddressResolution> {
	const candidates = workspaceAddressCandidates(pasted);
	if (candidates.length === 0) return { kind: 'refused', message: notAnAddressMessage(pasted) };
	const named = candidates.length === 1;

	for (const candidate of candidates) {
		const remote = { ...candidate, branch: DEFAULT_REMOTE_BRANCH };
		let paths: readonly string[];
		try {
			paths = (await readRemoteTree(remote, fetchFn)).map((blob) => blob.path);
		} catch (cause) {
			if (named && cause instanceof RemoteTreeRefusedError && cause.refusal === 'empty') {
				return { kind: 'resolved', remote: candidate, why: candidate.why };
			}
			const stop = stopsTheProbe(candidate, cause);
			if (stop !== null) return { kind: 'refused', message: stop };
			continue;
		}
		if (named || projectDirectories(paths).size > 0) {
			return { kind: 'resolved', remote: candidate, why: candidate.why };
		}
	}
	return { kind: 'refused', message: noWorkspaceMessage(candidates) };
}

function stopsTheProbe(candidate: AddressCandidate, cause: unknown): string | null {
	const name = describeRemote(candidate);
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
				`downloaded. Ask whoever owns it for the “owner/repository” form of the address.`
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

function notAnAddressMessage(pasted: string): string {
	const shown = pasted.trim();
	const [host = ''] = withoutScheme(pasted).split('/');
	return host.includes('.')
		? `“${shown}” is a site on an address of its own, and a site like that says nothing about ` +
				`which repository on GitHub it came from — so Ballastella cannot work out what ` +
				`to open. Paste the GitHub address instead: “owner/repository”, or the whole of ` +
				`https://github.com/owner/repository.`
		: `“${shown}” is not an address Ballastella can open. It takes “owner/repository”, the whole ` +
				`of https://github.com/owner/repository, or the address of a published site on ` +
				`github.io.`;
}

function noWorkspaceMessage(candidates: readonly AddressCandidate[]): string {
	const names = candidates.map(describeRemote).join(' or ');
	return (
		`Nothing that Ballastella can open is served at ${names}. Either there is no public ` +
		`repository there — from here a private one looks exactly like a missing one, because this ` +
		`reads GitHub without signing in — or what is there was not written by ` +
		`Ballastella. Check the address with whoever gave it to you.`
	);
}
