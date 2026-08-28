// What a bound Workspace's one Remote does to an Import into it (ADR-0037, ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// AN IMPORT INTO A SYNCHRONIZED WORKSPACE IS STILL ORDINARY LOCAL WORK
//
// Nothing here gives an imported Project a Remote, a Baseline, a status or a Publish action of its
// own: synchronization stays one whole Workspace to at most one Remote (ADR-0038), and an Import is
// a copy that keeps no relationship with where it came from (ADR-0037). The imported files cross the
// managed store like any other write, so they are in the local-change index and the next Remote
// Status reads `Changes to publish`; the next deliberate Publish carries them because Publish owns
// the whole Workspace namespace and has never needed to be told about a particular Project.
//
// So there are exactly two things a Remote adds to an Import, and both of them happen *before* the
// allocation.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE: THE REMOTE IS EVIDENCE, AND A REMOTE THAT CANNOT BE READ IS NOT "EMPTY"
//
// A bound Workspace's Remote may hold a Project this installation has never seen — published from
// another machine, or added by a collaborator. `allocateProjectImport` reserves those directories
// when it is told about them, and this is what tells it: one tree listing, taken before a byte is
// allocated.
//
// ⚠ **A listing that failed is refused rather than read as an empty Remote.** Allocating
// `amsterdam-1625` because a truncated tree did not happen to mention it manufactures a Conflict the
// author did not create, cannot see, and meets weeks later at a Publish — two unrelated Projects at
// one directory. The cost of refusing is that the author tries again when GitHub answers; the cost of
// guessing is somebody's afternoon, discovered by whoever publishes second. The Baseline is *not* a
// substitute for the listing either: it is what the two sides last shared, so a Project that exists
// only on GitHub is exactly what it cannot know about.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO: IMPORTING YOUR OWN REMOTE'S PROJECT IS NOT AN IMPORT
//
// A Project invitation names a repository and a directory, and the repository named may be the
// author's own — their second machine's URL, a link they sent themselves, their own Published Site
// found through a search. Copying it in would detach a second, unsynchronized duplicate of work the
// Workspace already tracks: the same Project twice on the hub, one of them with no route back to the
// Remote, and an author who edits whichever they open.
//
// The refusal names what to do instead — the Project they already have, or **Update from GitHub** —
// and deliberately does *not* offer to import a detached copy anyway. There is no version of that
// offer a reader can act on well.
//
// ⚠ **Identity is compared through `remoteIdentityKey`, never as pasted text.** `Ada/Atlas`,
// `ada/atlas` and `https://github.com/ada/atlas.git` are one repository, and a comparison of strings
// would refuse one spelling and duplicate the other two.
//
// ⚠ **A Project Bundle can never establish this, and must not be made to.** Its origin is a filename
// (untrusted, chosen by whoever sent it) and the Project's carried provenance is another build's
// observation, inherited on every transfer since. Neither says where these bytes came from, so a
// bundle whose history mentions the Workspace's own Remote is an ordinary Import — refusing it would
// refuse a colleague's legitimate hand-back on the strength of a string in a file. Nothing counts as
// an own-Remote source unless directly observed evidence can establish that it is one.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { RemoteRepository } from '../remote/publish-to-remote.js';
import { describeRemote, isSameRemote } from '../remote/remote-binding.js';
import { RemoteStatusUnavailableError, readRemoteInventory } from '../remote/remote-status.js';
import type { RemoteStatusRefusal } from '../remote/remote-status.js';
import { recognisedProjectDirectories } from '../remote/synchronization-paths.js';
import type { SynchronizationBaseline } from '../remote/synchronization-metadata.js';
import type { ImportDestination } from './project-import-allocation.js';
import type { ProjectImportOrigin } from './project-import-source.js';
import { ImportRefusedError } from './project-import-transaction.js';

/** The Workspace an Import is arriving in, as its synchronization describes it. */
export interface ImportIntoWorkspace {
	/**
	 * The Remote this Workspace is bound to, or `null` when it is bound to nothing.
	 *
	 * The installation-local relationship (ADR-0038), never a `remote.json` read out of the
	 * Workspace: a binding carried in from a restored Backup or a fork's published tree binds nothing,
	 * and must not make an Import ask GitHub about a repository this installation has no relationship
	 * with.
	 */
	readonly remote: RemoteRepository | null;
	/**
	 * The valid Baseline for that Remote, or `null` for `Cannot tell`.
	 *
	 * Validity is `SynchronizationMetadata.readBaseline`'s to decide — a record naming another
	 * repository is already `null` by the time it reaches here — so this consumes the Baseline
	 * abstraction rather than judging one.
	 */
	readonly baseline?: SynchronizationBaseline | null;
	/** Every path the Workspace holds now, Project material or not. */
	readonly local: Iterable<string>;
	/** The credential to list the Remote with, or `null` to list a public one anonymously. */
	readonly token?: string | null;
	readonly fetch?: FetchFn;
}

/**
 * The two inventories an allocation needs from outside the Workspace.
 *
 * `Pick` rather than a shape of its own, so the answer is spread straight into
 * {@link ImportDestination} at the call site and cannot drift from what the allocator reads. An
 * absent member is "no evidence of that kind", which is the honest reading for an unbound Workspace
 * and never the reading for a Remote that could not be listed — that is refused instead.
 */
export type ImportEvidence = Pick<ImportDestination, 'remote' | 'baseline'>;

/** What {@link assertNotOwnRemote} is asked about one Import. */
export interface OwnRemoteCheck {
	/** What the source reader *observed* about where the closure came from. */
	readonly origin: ProjectImportOrigin;
	/** The Remote this Workspace is bound to, or `null` when it is bound to nothing. */
	readonly remote: RemoteRepository | null;
	/** Every path the Workspace holds now. */
	readonly local: Iterable<string>;
	/** Every path the current Remote tree holds. */
	readonly remotePaths: Iterable<string>;
	/** Every path the valid Baseline records. */
	readonly baselinePaths?: Iterable<string>;
}

/**
 * Refuse an Import of the Project this Workspace already synchronizes.
 *
 * Own-Remote is **both** halves of the pair: the origin's normalised repository identity is this
 * Workspace's Remote, *and* the Project directory it names is one this Workspace's synchronization
 * recognises — locally, on the Remote now, or in the Baseline. An origin carrying no repository at
 * all (a Project Bundle, a Review Workspace) matches neither half; see this module's header for why
 * that is deliberate rather than a gap.
 *
 * ⚠ **The directory clause is not redundant, and it is what makes the refusal *nameable*.** A
 * refusal has to say what to do instead, and it can only say "the Project you already have" or
 * "Update from GitHub" about a Project one of the three inventories has actually seen. A directory
 * none of them recognises is a Project this Workspace's Remote relationship has never held — nothing
 * a Publish would collide with and nothing an Update would bring — so it is an ordinary Import.
 *
 * @throws ImportRefusedError `'own-remote'`, with nothing written and no Baseline touched
 */
export function assertNotOwnRemote(check: OwnRemoteCheck): void {
	const remote = check.remote;
	const origin = check.origin;
	if (remote === null || origin.kind !== 'github') return;
	if (!isSameRemote(origin, remote)) return;

	const local = recognisedProjectDirectories({ local: check.local });
	const synchronized = recognisedProjectDirectories({
		remote: check.remotePaths,
		baseline: check.baselinePaths ?? []
	});
	const here = local.has(origin.directory);
	if (!here && !synchronized.has(origin.directory)) return;

	const named = describeRemote(remote);
	throw new ImportRefusedError(
		'own-remote',
		here
			? `“${origin.projectName}” is already in this Workspace, which is synchronized with ` +
					`${named}, so Importing it would leave you two copies of your own work and only one of ` +
					`them synchronized. Open it from your Projects instead. Nothing has been added to your ` +
					`Workspace.`
			: `“${origin.projectName}” is a Project of ${named}, which is this Workspace's own Remote, ` +
					`so it is not somebody else's work to copy in. Use Update from GitHub to bring it into ` +
					`this Workspace. Nothing has been added to your Workspace.`
	);
}

/**
 * The Remote and Baseline evidence this Import must be allocated against.
 *
 * The order is the design: **the listing first, then the own-Remote question, and both before
 * anything is allocated.** A Remote that cannot be inventoried is refused without the second
 * question being asked at all — a refusal that named the Project the author should Update to instead
 * would be a claim about a Remote nobody has managed to read.
 *
 * An unbound Workspace asks GitHub nothing and answers with no evidence of either kind, which is how
 * {@link ImportDestination} spells "there is no Remote and no Baseline".
 *
 * @throws ImportRefusedError `'remote-unavailable'` when a bound Workspace's Remote cannot be
 *   inventoried authoritatively, and `'own-remote'` for an Import of this Workspace's own Remote
 *   Project. Both refuse before the Import marker and before any destination write.
 */
export async function readImportEvidence(
	origin: ProjectImportOrigin,
	workspace: ImportIntoWorkspace
): Promise<ImportEvidence> {
	const remote = workspace.remote;
	if (remote === null) return {};

	let paths: readonly string[];
	try {
		const inventory = await readRemoteInventory({
			remote,
			token: workspace.token ?? null,
			...(workspace.fetch === undefined ? {} : { fetch: workspace.fetch })
		});
		paths = inventory.map((entry) => entry.path);
	} catch (cause) {
		if (!(cause instanceof RemoteStatusUnavailableError)) throw cause;
		throw new ImportRefusedError('remote-unavailable', uninventoriable(remote, cause.refusal));
	}

	const baseline = workspace.baseline?.files;
	assertNotOwnRemote({
		origin,
		remote,
		local: workspace.local,
		remotePaths: paths,
		...(baseline === undefined ? {} : { baselinePaths: baseline.keys() })
	});
	return { remote: paths, ...(baseline === undefined ? {} : { baseline: [...baseline.keys()] }) };
}

/**
 * Why the Remote could not be inventoried, and what that costs *this* operation.
 *
 * Said here rather than reused from the Remote Status sentences, which all end on "the status beside
 * this is the last one Ballastella was able to work out" — true of a status control and misleading
 * of an Import, where nothing was displayed and nothing happened.
 */
function uninventoriable(remote: RemoteRepository, refusal: RemoteStatusRefusal): string {
	const named = describeRemote(remote);
	const because: Record<RemoteStatusRefusal, string> = {
		unreachable: `Ballastella could not reach GitHub to read ${named}`,
		credential: `GitHub would not accept this browser's credential for ${named}`,
		'rate-limited': `GitHub's hourly request limit is used up, so ${named} could not be read`,
		'no-repository': `GitHub has no ${named} that this browser can see`,
		'not-public': `${named} cannot be read without signing in`,
		truncated: `GitHub could only list part of ${named}`,
		refused: `GitHub refused to list ${named}`
	};
	return (
		`${because[refusal]}, so Ballastella cannot tell which Projects this Workspace's Remote already ` +
		`holds — and an Import placed without knowing that could collide with a Project that exists ` +
		`only on GitHub. Nothing has been added to your Workspace. Try again once ${named} can be read.`
	);
}
