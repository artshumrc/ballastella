// A Remote may belong to somebody else, and the two things that follow from it (ADR-0043).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NOTHING HERE MAKES COLLABORATION POSSIBLE. IT MAKES THE INTERFACE HONEST ABOUT IT
//
// GitHub documents that a user access token reaches "repositories they own, repositories where they
// are a collaborator, and repositories that they can access through an organization membership", and
// that an App acting for a user reaches the intersection of what the App may touch and what the user
// may touch. So a write collaborator signs in, the repository is simply in their listing, and they
// publish to it — they install nothing and ask nobody. There is no code for that, and there is not
// meant to be.
//
// What there is code for is the one gesture whose blast radius is somebody else's afternoon.
// *Overwrite the repository* is the explicit local-wins escape hatch (ADR-0038, ADR-0044), and on a
// repository that is the author's alone it can only ever discard the author's own work. On a shared
// one it deletes a collaborator's, because it mirrors an owned namespace and removes what this
// Workspace has not got (ADR-0033). Both directions name what would go, on the Sync modal the author reads before
// pressing anything (ADR-0044); this is what the outbound half of that naming is built from.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ⚠ A READING THAT DID NOT HAPPEN SAYS *SHARED*, NEVER *SOLO*
//
// The whole point of the determination is to decide whether a deletion has to be named before it is
// carried out, so the two errors are not equal: a solo Remote read as shared costs one confirmation
// nobody needed, and a shared Remote read as solo deletes a colleague's work with nothing said.
// So a `GET` that fails, a credential GitHub will not act on, and a body that cannot be parsed all
// answer {@link RemoteSharing.shared} `true` with {@link RemoteSharing.known} `false`, and the
// sentence says the ownership could not be established rather than naming anybody.

import type { FetchFn } from '../injection/store-image-fetch.js';
import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { topLevelSegment } from '../store/project-store.js';
import { GITHUB_API_ORIGIN } from './github-api.js';
import { describeRemote } from './remote-binding.js';
import type { RemoteReference } from './bind-remote.js';

/** Whether a Remote is somebody else's as well as, or instead of, the signed-in author's. */
export type RemoteSharing = {
	/** Whether a deletion on this Remote has to be named before it is carried out. */
	readonly shared: boolean;
	/**
	 * Whether GitHub actually answered.
	 *
	 * `false` makes {@link shared} a precaution rather than a reading, for the reason in this
	 * module's header — and it is what stops the sentence naming a collaborator nobody established.
	 */
	readonly known: boolean;
	/** Whose account the repository is under. */
	readonly owner: string;
	/** Accounts other than the signed-in one that GitHub reports on it, sorted. */
	readonly others: readonly string[];
};

export type RemoteSharingOptions = {
	/** An opaque bearer credential, as every other GitHub read here takes one (ADR-0031). */
	readonly token: string;
	readonly remote: RemoteReference;
	/**
	 * Who the credential belongs to, when the caller already knows.
	 *
	 * Left out — a pasted token, whose account nothing has asked about — `GET /user` is read for it.
	 * The determination is *whose the repository is not*, so it cannot be made without a name, and
	 * guessing that an unknown author is the owner would answer *solo* to the one caller that has
	 * established nothing.
	 */
	readonly identity?: string;
	readonly fetch?: FetchFn;
};

const request = (options: RemoteSharingOptions): FetchFn =>
	options.fetch ?? ((input, init) => fetch(input, init));

const headers = (token: string): Record<string, string> => ({
	Accept: 'application/vnd.github+json',
	Authorization: `Bearer ${token}`
});

const same = (one: string, other: string): boolean =>
	one !== '' && one.toLowerCase() === other.toLowerCase();

/** Whose the credential is, or `''` when GitHub would not say. */
async function readIdentity(options: RemoteSharingOptions): Promise<string> {
	try {
		const response = await request(options)(`${GITHUB_API_ORIGIN}/user`, {
			headers: headers(options.token)
		});
		if (!response.ok) return '';
		const body = (await response.json().catch(() => ({}))) as { login?: unknown };
		return typeof body.login === 'string' ? body.login : '';
	} catch {
		return '';
	}
}

/**
 * Who else GitHub reports on this repository, or `null` when it would not say.
 *
 * ⚠ **`null` and `[]` are different answers and the difference is load-bearing.** An empty list is
 * GitHub saying nobody else has contributed; `null` is GitHub not answering, which this module's
 * header treats as *shared*. Anonymous contributors are asked for (`anon=1`) because a commit made
 * on github.com under an email GitHub cannot match to an account is still somebody else's work.
 */
async function readContributors(options: RemoteSharingOptions): Promise<string[] | null> {
	const { remote } = options;
	const url =
		`${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(remote.owner)}/` +
		`${encodeURIComponent(remote.repository)}/contributors?per_page=100&anon=1`;
	let response: Response;
	try {
		response = await request(options)(url, { headers: headers(options.token) });
	} catch {
		return null;
	}
	// 204 is a repository with no commits yet, which is nobody rather than an unanswered question.
	if (response.status === 204) return [];
	if (!response.ok) return null;
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body)) return null;
	return body
		.map((one) => (one as { login?: unknown }).login)
		.filter((login): login is string => typeof login === 'string');
}

/**
 * Whether this Remote is the signed-in author's alone, and who else is on it.
 *
 * ⚠ **The owner check comes first and costs nothing.** A repository under somebody else's account is
 * shared whatever its contributor list says, so the contributor read is made only for the case the
 * owner check cannot settle: the author's *own* repository that a colleague also pushes to.
 */
export async function readRemoteSharing(options: RemoteSharingOptions): Promise<RemoteSharing> {
	const owner = options.remote.owner;
	const identity = options.identity?.trim() ? options.identity.trim() : await readIdentity(options);
	if (identity === '') {
		return { shared: true, known: false, owner, others: [] };
	}
	if (!same(owner, identity)) {
		return { shared: true, known: true, owner, others: [owner] };
	}

	const contributors = await readContributors(options);
	if (contributors === null) return { shared: true, known: false, owner, others: [] };
	const others = [...new Set(contributors.filter((login) => !same(login, identity)))].sort();
	return { shared: others.length > 0, known: true, owner, others };
}

// ── What an Overwrite would take off the Remote ────────────────────────────────────────────────

/**
 * What a confirmed overwrite would remove from the Remote, in the terms it has to be asked in.
 *
 * ⚠ **Projects and Map Images rather than paths, exactly as `describeChanges` is.** "3 files
 * will be removed" is not a question anybody can answer; "the Project `florida-1657` and everything
 * drawn on it" is. Paths are still carried — {@link paths} for the record and {@link remaining} for
 * what neither grouping accounts for — so nothing is described away.
 */
export type OutboundDeletionPreview = {
	/** The repository the deletions would happen on. */
	readonly remote: RemoteReference;
	/**
	 * Project directories every one of whose Remote files would go, sorted.
	 *
	 * ⚠ **Directories rather than display names, and that is not the inbound preview's compromise.**
	 * A Project is removed *completely* precisely when this Workspace holds nothing under its
	 * directory — so there is no `project.json` here to read a name out of, by construction. The
	 * directory is what the Remote's tree calls it and what `?p=` names (ADR-0008).
	 */
	readonly projects: readonly string[];
	/** Map Image identities every one of whose Remote files would go, sorted. */
	readonly mapImages: readonly string[];
	/** Every path the publish would remove, sorted. */
	readonly paths: readonly string[];
	/**
	 * Removed paths no removed Project or Map Image above accounts for, sorted.
	 *
	 * A Project losing one Annotation, an Alignment for a Map Image that stays, a cached Base Map
	 * tile. Listed rather than summed away: the two groupings above are the *legible* part of a removal
	 * and this is the rest of it, and a confirmation showing only the legible part would be asking
	 * about less than it was about to do.
	 */
	readonly remaining: readonly string[];
	/** The question, in the words the author should be asked it in. */
	readonly message: string;
};

export type OutboundDeletionOptions = {
	readonly remote: RemoteReference;
	/** Whose the Remote is, which is what the question has to name. */
	readonly sharing: RemoteSharing;
	/** `RemotePublishPlan.removed`: the owned Remote source paths this publish takes down. */
	readonly removed: Iterable<string>;
	/** The local source namespace this publish would write, `RemotePublishPlan.source`'s keys. */
	readonly source: Iterable<string>;
};

/**
 * Group the removals into what a person can be asked about.
 *
 * ⚠ **Grouped against the *local* side, which is the mirror of the inbound preview's rule.** A
 * Project is removed completely when this Workspace holds nothing under its directory: everything
 * the Remote has there is then going, whatever else the Remote's tree holds, because `removed` is
 * by definition the Remote's owned source that this Workspace has not got.
 */
export function describeOutboundRemovals(
	options: OutboundDeletionOptions
): OutboundDeletionPreview {
	const paths = [...new Set(options.removed)].sort();
	const source = [...options.source];
	/** Whether this Workspace holds anything at all under a directory the Remote is losing. */
	const heldUnder = (prefix: string): boolean => source.some((path) => path.startsWith(prefix));

	const accounted = new Set<string>();
	const claim = (prefix: string): void => {
		for (const path of paths) if (path.startsWith(prefix)) accounted.add(path);
	};

	const projects: string[] = [];
	const candidates = new Set(
		paths
			.filter((path) => path.includes('/'))
			.map(topLevelSegment)
			.filter((directory) => directory !== IMAGE_DIRECTORY && directory !== ALIGNMENT_DIRECTORY)
	);
	for (const directory of [...candidates].sort()) {
		if (heldUnder(`${directory}/`)) continue;
		projects.push(directory);
		claim(`${directory}/`);
	}

	const mapImages: string[] = [];
	const identities = new Set(
		paths
			.filter((path) => path.startsWith(`${IMAGE_DIRECTORY}/`))
			.map((path) => path.split('/')[1] ?? '')
	);
	for (const imageId of [...identities].sort()) {
		if (imageId === '' || heldUnder(`${IMAGE_DIRECTORY}/${imageId}/`)) continue;
		mapImages.push(imageId);
		claim(`${IMAGE_DIRECTORY}/${imageId}/`);
		// ⚠ **The Alignment belongs to the Map Image and not to the leftovers**, for the reason the
		// inbound preview gives: it lives beside the pyramid rather than inside it, so a purely
		// prefix-shaped accounting would list it as an unexplained extra file in the same breath as
		// saying the Map Image it is the Alignment *for* is going.
		accounted.add(`${ALIGNMENT_DIRECTORY}/${imageId}.json`);
	}

	const remaining = paths.filter((path) => !accounted.has(path));
	return {
		remote: options.remote,
		projects,
		mapImages,
		paths,
		remaining,
		message: removalMessage(options.remote, options.sharing, projects, mapImages, remaining, paths)
	};
}

/** `a`, `a and b`, `a, b and c` — a list a person reads rather than one a program prints. */
function sentenceList(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
}

const count = (many: number, thing: string): string => `${many} ${thing}${many === 1 ? '' : 's'}`;

/**
 * Whose the repository is, said before what would happen to it.
 *
 * ⚠ **It names an account or it says the question could not be answered.** "Somebody else may be
 * working here" with nothing behind it is the kind of sentence a person learns to press through, and
 * a confirmation people press through is worse than none.
 */
function whoseSentence(remote: RemoteReference, sharing: RemoteSharing): string {
	const where = describeRemote(remote);
	if (!sharing.known) {
		return (
			`Ballastella could not establish whether anybody else works in ${where}, so it is asking as ` +
			`though somebody does.`
		);
	}
	if (sharing.others.length === 1 && sharing.others[0] === sharing.owner) {
		return `${where} belongs to ${sharing.owner}, not to you.`;
	}
	if (sharing.others.length === 0) return `${where} may not be yours alone.`;
	const who = sentenceList([...sharing.others]);
	return `${who} ${sharing.others.length === 1 ? 'has' : 'have'} worked in ${where} as well as you.`;
}

/**
 * The question the author is asked before a shared Remote loses anything.
 *
 * ⚠ **It says what an overwrite *will* do, not what it might.** This is the last point at which
 * the answer is still no, so the sentence is the whole of the consequence: whose the repository is,
 * which Projects and Map Images go, how much else, and that nothing in this Workspace is touched.
 */
function removalMessage(
	remote: RemoteReference,
	sharing: RemoteSharing,
	projects: readonly string[],
	mapImages: readonly string[],
	remaining: readonly string[],
	paths: readonly string[]
): string {
	const whose = whoseSentence(remote, sharing);
	if (paths.length === 0) {
		return (
			`${whose} Publishing anyway takes nothing off ${describeRemote(remote)} — every file it ` +
			`holds is one this Workspace has too — but it replaces the files you were just shown with ` +
			`this Workspace's own copies of them, and whatever anybody else put in those is lost.`
		);
	}
	const named = [
		...projects.map((directory) => `the Project ${directory}`),
		...mapImages.map((imageId) => `the Map Image ${imageId}`)
	];
	const rest =
		remaining.length === 0
			? ''
			: ` ${named.length === 0 ? 'It removes' : 'It also removes'} ` +
				`${count(remaining.length, 'file')}: ${remaining.join(', ')}.`;
	return (
		`${whose} Publishing anyway removes ${count(paths.length, 'file')} from ` +
		`${describeRemote(remote)} that this Workspace has not got.` +
		(named.length === 0 ? '' : ` That removes ${sentenceList(named)} completely.`) +
		rest +
		` Nothing in this Workspace is changed either way, and there is no way to put them back from ` +
		`here afterwards.`
	);
}
