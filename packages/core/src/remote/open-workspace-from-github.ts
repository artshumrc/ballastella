// Open a Workspace from GitHub: which Workspace of this installation a repository belongs to, and the
// evidence a successful transfer is entitled to record (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// ONE INSTALLATION, ONE SYNCHRONIZED WORKSPACE PER REPOSITORY
//
// One Ballastella installation keeps at most one synchronized local Workspace for a repository, and
// opening it again returns to that Workspace. The reason is not tidiness. Two local
// Workspaces both bound to `ada/atlas` are two Publish buttons aimed at one site, and whichever is
// pressed second silently replaces the other author's afternoon with its own idea of the whole
// Workspace — the Baselines say nothing about each other, so neither side is even told.
//
// ⚠ **The uniqueness is installation-local and deliberately not global.** A second machine holds its
// own metadata and may open its own Workspace with its own Baseline, which is the whole point of
// having a Remote. Nothing here asks GitHub whether somebody else has opened it.
//
// The lookup is `listRemoteRelationships`, which reads the relationship records themselves rather
// than a second index — so there is no reverse map that can come to disagree with the relationships
// it describes, and a Workspace deleted (and its metadata discarded with it) leaves no ghost.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NORMALIZED BEFORE LOOKUP, BECAUSE GITHUB DOES NOT CARE ABOUT CASE
//
// `github.com/Ada/Atlas` and `github.com/ada/atlas` are one repository, so an author who pasted the
// address off a colleague's slide and an author who typed it must land in the same Workspace. Owner
// and repository are folded for *comparison* only; what is stored is what the user chose, because
// that is the spelling their Published Site and their address bar show. Branches are compared as
// given: git ref names are case-sensitive, and `Main` is not `main`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SERIALIZED, SO TWO PRESSES CANNOT MAKE TWO BINDINGS
//
// Look up, download for four minutes, then write the relationship: between the first and the last
// step a second Open of the same repository would find nothing and start a second Workspace. Both
// would then write a relationship and the installation would hold exactly the two competing bindings
// this module exists to prevent. So Opens of the same repository run one after another, and the
// second — reaching the lookup after the first has recorded its relationship — selects rather than
// downloads. It is a lock over one tab's presses, which is the race a user can actually produce;
// two tabs of the same installation are not addressed here.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT IS RECORDED, AND WHEN
//
// A local-only Synchronization Baseline is established at successful Open, and not before. Nothing is
// recorded until `cloneFromRemote` has fetched every selected file, checked each against the blob SHA
// its tree named, and validated the whole prospective Workspace — so a refused, interrupted or
// graph-broken Remote leaves a directory that no relationship names, which no publish and no status
// will act on and which a later Open can resume into.
//
// The relationship goes first and the Baseline second, and the asymmetry is deliberate: a store that
// will not keep the relationship means the Workspace is *not* synchronized and is said so out loud,
// while a store that will not keep the Baseline leaves a bound Workspace reporting `Cannot tell` —
// never an Open reported as failed after the bytes have already arrived.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { EstimateStorage, OpenRestoreDestination } from '../transfer/restore-workspace-tar.js';
import type { TransferProgressListener } from '../transfer/transfer.js';
import {
	CloneRefusedError,
	cloneFromRemote,
	type CloneReference,
	type WorkspaceClone
} from './clone-from-remote.js';
import { describeRemote, normaliseRemoteIdentity, remoteIdentityKey } from './remote-binding.js';
import {
	SynchronizationMetadata,
	listRemoteRelationships,
	type MetadataStorage,
	type RemoteRelationship
} from './synchronization-metadata.js';

export interface OpenWorkspaceFromGitHubOptions {
	/** The repository the author or the invitation selected. Normalized here, not by the caller. */
	readonly remote: CloneReference;
	/**
	 * This installation's durable record store, or `null` for a browser that has none.
	 *
	 * `null` degrades exactly as everything else on this path does: no lookup, so no reopening and no
	 * uniqueness, and no Baseline, so the Workspace reads `Cannot tell`. Refusing instead would make a
	 * browser with site data blocked unable to open a public Workspace at all, which is the one
	 * operation on this path that is meant to need nothing.
	 */
	readonly metadata: MetadataStorage | null;
	/** How this installation names a new browser-backed Workspace in its metadata. */
	readonly workspaceKey: (workspaceName: string) => string;
	/** Makes the Workspace to fill. See {@link cloneFromRemote}. */
	readonly open: OpenRestoreDestination;
	readonly fetch?: FetchFn;
	readonly onProgress?: TransferProgressListener;
	readonly estimateStorage?: EstimateStorage;
}

/** What an Open did: returned to the Workspace this repository already has, or made one. */
export type OpenedWorkspace =
	| {
			readonly outcome: 'selected';
			/**
			 * The Workspace this installation already keeps for that repository.
			 *
			 * A key rather than a name, because the backing is part of it: a chosen folder and a
			 * browser-storage Workspace of the same name are two places. The caller resolves it, since
			 * only the app knows how it spells its own keys.
			 */
			readonly workspaceKey: string;
			readonly remote: RemoteRelationship;
	  }
	| {
			readonly outcome: 'opened';
			readonly workspaceKey: string;
			readonly workspaceName: string;
			readonly remote: RemoteRelationship;
			/**
			 * Whether the Baseline was kept. `false` is a durable store that refused, and the caller's
			 * answer to it is `Cannot tell` — never an Open reported as failed.
			 */
			readonly baselineRecorded: boolean;
			readonly transfer: WorkspaceClone;
	  };

/**
 * Open a Workspace from GitHub: select the one this installation already keeps for that repository,
 * or download, validate and adopt a new one.
 *
 * @throws CloneRefusedError for every way the transfer can refuse, and for a durable store that will
 *   not keep the relationship a synchronized Workspace consists of
 */
export async function openWorkspaceFromGitHub(
	options: OpenWorkspaceFromGitHubOptions
): Promise<OpenedWorkspace> {
	const remote = normaliseRemoteIdentity(options.remote);
	if (remote === null) {
		throw new CloneRefusedError(
			'refused',
			`“${options.remote.owner}/${options.remote.repository}” is not a repository address. It ` +
				`looks like “owner/repository” — the two parts after github.com in your browser's address ` +
				`bar.`
		);
	}
	return oneAtATime(remote, () => openOrSelect(remote, options));
}

/**
 * The Workspace this installation keeps for `remote`, or `null` for a repository it has never opened.
 *
 * ⚠ **At most one, and sorted rather than first-found.** Two records naming one repository is a state
 * this module refuses to create, but a v1 installation could reach it by hand — `bindRemote` has
 * always let an author aim two Workspaces at one repository — so the answer has to be *a* Workspace
 * and always the same one, rather than whichever the record store happened to enumerate first.
 */
export async function findWorkspaceForRepository(
	storage: MetadataStorage,
	remote: RemoteRelationship
): Promise<string | null> {
	const wanted = remoteIdentityKey(remote);
	const found = (await listRemoteRelationships(storage))
		.filter((held) => remoteIdentityKey(held.remote) === wanted)
		.map((held) => held.workspaceKey)
		.sort();
	return found[0] ?? null;
}

async function openOrSelect(
	remote: RemoteRelationship,
	options: OpenWorkspaceFromGitHubOptions
): Promise<OpenedWorkspace> {
	const storage = options.metadata;
	if (storage !== null) {
		const existing = await findWorkspaceForRepository(storage, remote);
		// ⚠ **Selected, and nothing else.** Not a download into it, not a fresh listing, and above all
		// not an advance of its Baseline: reopening is a way back to work already here, and a Baseline
		// moved on from a listing nobody transferred would report the author's own unpublished edits as
		// the Remote's. Bringing Remote changes in is `update-from-github.ts`'s job.
		if (existing !== null) return { outcome: 'selected', workspaceKey: existing, remote };
	}

	const transfer = await cloneFromRemote(options.open, {
		remote,
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
		...(options.estimateStorage === undefined ? {} : { estimateStorage: options.estimateStorage })
	});
	const workspaceKey = options.workspaceKey(transfer.workspaceName);

	if (storage === null) {
		return {
			outcome: 'opened',
			workspaceKey,
			workspaceName: transfer.workspaceName,
			remote,
			baselineRecorded: false,
			transfer
		};
	}

	const metadata = new SynchronizationMetadata(storage, workspaceKey);
	// ⚠ **The relationship is what makes the Workspace synchronized**, so a store that refuses is an
	// Open that did not happen rather than a Workspace bound to nothing. The bytes are kept and named
	// as kept: they are a directory nothing has heard of, which the next attempt resumes into.
	if (!(await metadata.bindRemote(remote))) {
		throw new CloneRefusedError('refused', unkeptRelationshipMessage(remote), 'partial');
	}
	// ⚠ **The Remote it was read from and the commit it stood at**, over the source paths every one of
	// which was checked against the SHA the tree named — not merely everything the listing claimed.
	const baselineRecorded = await metadata.writeBaseline({
		remote,
		commit: transfer.commit,
		files: transfer.source
	});
	return {
		outcome: 'opened',
		workspaceKey,
		workspaceName: transfer.workspaceName,
		remote,
		baselineRecorded,
		transfer
	};
}

/**
 * Opens of one repository, one after another. See this module's header for what the race costs.
 *
 * Keyed by the repository rather than global, so opening two different Remotes still runs both at
 * once — they cannot select each other's Workspace, and a four-minute download of one must not hold
 * up the other.
 */
const running = new Map<string, Promise<unknown>>();

async function oneAtATime<T>(remote: RemoteRelationship, work: () => Promise<T>): Promise<T> {
	const key = remoteIdentityKey(remote);
	// `.then(work, work)` rather than `.finally`: the queue must advance whether the Open ahead
	// succeeded or refused, and a refusal that stalled the queue would leave the repository unopenable
	// for the life of the tab.
	const mine = (running.get(key) ?? Promise.resolve()).then(work, work);
	const settled = mine.then(
		() => undefined,
		() => undefined
	);
	running.set(key, settled);
	// Dropped once nothing is waiting, so a session that opens many repositories does not accumulate a
	// resolved promise for each.
	void settled.then(() => {
		if (running.get(key) === settled) running.delete(key);
	});
	return mine;
}

function unkeptRelationshipMessage(remote: RemoteRelationship): string {
	return (
		`${describeRemote(remote)} was downloaded, but this browser would not keep the record that the ` +
		`new Workspace belongs to it — so it is not synchronized with anything and Ballastella has not ` +
		`switched to it. Site data may be blocked for this site, or browser storage may be full.`
	);
}
