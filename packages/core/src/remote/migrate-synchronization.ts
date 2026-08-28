// Lifting a v1 Workspace's Remote out of the Workspace and out of `localStorage` (ADR-0038).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY A BINDING ALONE IS NOT ENOUGH TO BIND
//
// v1 kept two pieces of evidence: `remote.json` in the Workspace, and a publish manifest in
// `localStorage`. The manifest is installation-local, so it is proof that *this machine* published to
// that repository. The binding is a file inside the published tree, so it is proof of nothing about
// this machine at all — a fork, a colleague's copied folder, and a restored Backup all carry a
// `remote.json` naming somebody else's repository, and lifting it silently would leave an author's
// Publish button aimed at a repository they have never seen.
//
// So the two answers are different by construction. A matching legacy binding plus a matching manifest
// is sufficient to lift the relationship automatically. A legacy binding without corroborating
// installation-local evidence requires explicit confirmation; confirmation preserves the binding but
// leaves the Baseline absent and Remote Status at Cannot tell.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// NOTHING PARTIAL SURVIVES A FAILURE
//
// The relationship and the Baseline are two records, and a migration that wrote one of them would
// leave a Workspace bound with a Baseline that has no relationship to validate against, or bound with
// no evidence at all while the evidence still sat in `localStorage` unconsumed. Both writes must land
// or neither does; a refused store leaves the legacy records exactly where they were, so the next
// visit can try again.
//
// The v1 manifest is discarded only once the new records are both in place. `remote.json` is **not**
// deleted: the published tree's copy is the viewer's compatibility evidence for an old site, and this
// module only stops it being read as the active relationship.

import { PublishManifests } from './publish-manifest.js';
import { readRemoteBinding } from './remote-binding.js';
import type { ReadOnlyProjectStore } from '../store/project-store.js';
import { SynchronizationMetadata, type RemoteRelationship } from './synchronization-metadata.js';

/** What a migration pass found, and what it did about it. */
export type SynchronizationMigration =
	/** This Workspace already has installation-local metadata; v1 is not consulted. */
	| { readonly kind: 'already-local'; readonly remote: RemoteRelationship | null }
	/** No legacy binding at all, which is a Workspace that was never bound. */
	| { readonly kind: 'no-legacy-evidence' }
	/** A binding corroborated by this machine's own publish evidence, lifted with its Baseline. */
	| { readonly kind: 'migrated'; readonly remote: RemoteRelationship }
	/** A binding this machine cannot corroborate. Nothing written; ask, naming the repository. */
	| { readonly kind: 'confirmation-required'; readonly remote: RemoteRelationship }
	/** The durable store refused. Legacy evidence is untouched and no new record exists. */
	| { readonly kind: 'failed'; readonly remote: RemoteRelationship };

/**
 * Decide, once, what this Workspace's v1 evidence means — and act on it where it is unambiguous.
 *
 * ⚠ **Must run before any synchronization action is offered for the Workspace.** Everything
 * downstream reads {@link SynchronizationMetadata} and nothing else, so a Workspace whose migration
 * has not been decided reads as unbound — and a Publish offered against that would be a Publish to
 * nowhere while `remote.json` still named a repository.
 *
 * `manifests` is the Workspace's v1 manifest reader, or `null` for a session with no `localStorage` to
 * read one from. A session that cannot read installation-local v1 evidence cannot corroborate a
 * binding, which is {@link SynchronizationMigration} `confirmation-required` rather than a lift.
 */
export async function migrateSynchronizationMetadata(options: {
	readonly metadata: SynchronizationMetadata;
	readonly store: ReadOnlyProjectStore;
	readonly manifests: PublishManifests | null;
}): Promise<SynchronizationMigration> {
	const { metadata, store, manifests } = options;

	// Already decided. Re-reading `remote.json` here is what would let a fork's published binding
	// redirect a Workspace that has been correctly bound to the repository its author selected.
	const local = await metadata.readRemote();
	if (local !== null) return { kind: 'already-local', remote: local };

	const legacy = await readRemoteBinding(store);
	if (legacy === null) return { kind: 'no-legacy-evidence' };
	const remote = { owner: legacy.owner, repository: legacy.repository, branch: legacy.branch };

	// `read` answers `null` for a manifest belonging to another Workspace, another repository, another
	// branch, another format version, or a truncated write — every one of which is a record that
	// corroborates nothing.
	const manifest = manifests?.read(remote) ?? null;
	if (manifest === null) return { kind: 'confirmation-required', remote };

	if (!(await metadata.bindRemote(remote))) return { kind: 'failed', remote };
	if (!(await metadata.writeBaseline({ remote, commit: manifest.commit, files: manifest.files }))) {
		// Bound with no Baseline would be a successful migration reporting `Cannot tell` — indistinguishable
		// from the confirmation path, and it would consume evidence that is still perfectly good.
		await metadata.clearRemote();
		return { kind: 'failed', remote };
	}
	manifests?.clear();
	return { kind: 'migrated', remote };
}

/**
 * Lift a legacy binding the user has explicitly confirmed, naming the repository.
 *
 * ⚠ **No Baseline is written, and that is the point.** There is no evidence about what this machine
 * shared with that repository, and inventing an empty Baseline would claim the Remote holds nothing —
 * which is the reading that licenses overwriting all of it. The Workspace is bound and its status is
 * `Cannot tell` until a deliberate Open, Update or Publish establishes real evidence.
 *
 * @returns whether the relationship was kept
 */
export async function confirmLegacyRemote(
	metadata: SynchronizationMetadata,
	remote: RemoteRelationship
): Promise<boolean> {
	return metadata.bindRemote(remote);
}
