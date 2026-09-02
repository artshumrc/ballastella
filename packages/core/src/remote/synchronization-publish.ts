// The outbound half of a Sync: the transfer, and the evidence it leaves behind (ADR-0038, ADR-0044).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ONLY OUTBOUND ACTION, AND THE ONLY PLACE A PUBLISHED BASELINE IS WRITTEN
//
// `publish-to-remote.ts` sends bytes and answers what it sent. This is where that answer becomes
// what *this installation believes* — the durable Baseline, and the narrowing of the local-change
// index that goes with it. Keeping the two apart is what lets the transport be asserted on the
// resulting tree and the evidence be asserted on the record, without either test having to arrange
// the other's fixtures.
//
// Nothing here is reachable from saving, checking status, opening, or getting. There is exactly one
// caller and it is the Sync modal's *Send changes*.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ORDER IS THE DESIGN, AND EVERY REFUSAL BEFORE THE UPLOAD IS FREE
//
//   1. **The plan**, which is the permission check, the complete local hashing, and one
//      commit-consistent Remote inventory. `planRemotePublish` posts nothing, so a read-only
//      account, a repository nobody can see, a truncated listing and every synchronization refusal
//      reach the author with the Remote untouched.
//   2. **The upload**, which is invisible until the ref moves.
//   3. **The Baseline**, and only then the index.
//
// ⚠ **Steps 2 and 3 can disagree, and the direction is settled.** If durable Baseline storage fails
// after Remote publication succeeds, the Publish succeeded and the status is now Cannot tell: never
// the Publish reported as failed, and never stale evidence retained. So a refused
// write is answered as {@link WorkspacePublished.baselineKept} `false` rather than thrown, and
// `writeBaseline` has already discarded the record that describes the state before — a stale map
// the reader could not tell from a current one is every path this publish legitimately changed
// coming back as somebody else's work.
//
// ⚠ **And the index is narrowed only under a Baseline that was kept.** Clearing marks with no
// evidence to compare them against is `Cannot tell` reported as `Up to date` on the next check,
// which is the one direction that licenses an overwrite.

import type { FetchFn } from '../injection/store-image-fetch.js';
import type { ProjectStore } from '../store/project-store.js';
import {
	planRemotePublish,
	publishToRemote,
	type PendingLocalFile,
	type RemotePublishPlan,
	type RemoteRepository
} from './publish-to-remote.js';
import type { SynchronizationMetadata } from './synchronization-metadata.js';

/**
 * Whatever can narrow the local-change index to what is still unpublished.
 *
 * A seam rather than {@link LocalChangeIndex} itself, because this module has no business knowing
 * how the marks are stored and a Workspace with nowhere to keep them is an ordinary case.
 */
export interface SharedStateRecorder {
	/** @returns whether the narrowed record was made durable */
	clearShared(paths: Iterable<string>): Promise<boolean>;
}

export interface PublishWorkspaceOptions {
	readonly token: string;
	readonly remote: RemoteRepository;
	/**
	 * Where this installation keeps what it believes about this Workspace's Remote.
	 *
	 * Absent for a session with nowhere durable to keep one. That is not the same news as a store
	 * that refused — such a session never could have kept a Baseline and does not report having lost
	 * one — so it publishes with no evidence either way and {@link WorkspacePublished.baselineKept}
	 * stays `true`.
	 */
	readonly metadata?: SynchronizationMetadata;
	/** The index to narrow once the Baseline is durable, or absent for a session that keeps none. */
	readonly changes?: SharedStateRecorder;
	readonly fetch?: FetchFn;
	/**
	 * The paths the author was shown as going, and agreed to: *Overwrite the repository*.
	 *
	 * ⚠ **The paths and not a `true`, because the plan this runs is not the plan they read.** The
	 * forecast is made before the local publish writes; this replans afterwards, against a tree
	 * listing taken minutes later on a large Workspace. Handed a bare "yes" the engine would apply a
	 * decision about one `notes.json` to whatever the second listing found — including a Project
	 * another machine published in the window, deleted without anybody having seen its name.
	 *
	 * Left out, a send removes only what the Baseline recorded, leaves everything the Remote has
	 * moved past exactly as it is, and refuses a Conflict. That is the default.
	 */
	readonly overwrite?: readonly string[];
	readonly onProgress?: (seen: {
		readonly files: number;
		readonly totalFiles: number;
		readonly requestsRemaining: number | null;
	}) => void;
	/** What a local publish is about to write, for the forecast's three budgets. */
	readonly pending?: readonly PendingLocalFile[];
}

/** What a publish did, and what this installation now believes about it. */
export interface WorkspacePublished {
	/** The commit the branch now holds. */
	readonly commit: string;
	/** The plan that actually ran, which is never the forecast the author was shown. */
	readonly plan: RemotePublishPlan;
	/**
	 * Whether the durable Baseline was kept.
	 *
	 * `false` is a successful publication this browser could not record, which is `Cannot tell` — and
	 * it is never a failed publish. The caller has to say so out loud: met unexplained on the next
	 * publish, that `Cannot tell` is a refusal nobody can account for.
	 */
	readonly baselineKept: boolean;
	/** The source paths the Baseline now accounts for, whether or not it was kept. */
	readonly shared: readonly string[];
}

/**
 * Send this Workspace to its Remote and record what the two now share.
 *
 * @throws RemotePublishRefusedError for a read-only account, a repository nobody can see, a
 *   truncated listing, a path changed on both sides, and a Remote that moved past what `overwrite`
 *   agreed to — every one of them with the Remote and the Baseline exactly as they were
 * @throws RemotePublishRateLimitedError, RemotePublishCredentialError, RemotePublishFailedError
 */
export async function publishWorkspaceToRemote(
	store: ProjectStore,
	options: PublishWorkspaceOptions
): Promise<WorkspacePublished> {
	const request = {
		token: options.token,
		remote: options.remote,
		...(options.fetch === undefined ? {} : { fetch: options.fetch })
	};
	const plan = await planRemotePublish(store, {
		...request,
		baseline: (await options.metadata?.readBaseline(options.remote)) ?? null,
		...(options.pending === undefined ? {} : { pending: options.pending })
	});
	const { commit, baseline, shared } = await publishToRemote(store, {
		...request,
		plan,
		...(options.overwrite === undefined ? {} : { overwrite: options.overwrite }),
		...(options.onProgress === undefined ? {} : { onProgress: options.onProgress })
	});

	const baselineKept =
		options.metadata === undefined ||
		(await options.metadata.writeBaseline({ remote: options.remote, commit, files: baseline }));
	if (baselineKept) await options.changes?.clearShared(shared);
	return { commit, plan, baselineKept, shared };
}
