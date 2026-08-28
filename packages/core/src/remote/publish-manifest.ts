// What the Remote held the last time a publish finished: `path → blob SHA` (ADR-0033).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// LOCAL ONLY, AND KEYED THE WAY THE WRITE-AHEAD JOURNAL IS
//
// Kept **local only**, keyed by Workspace and backing as the write-ahead journal is. It is
// deliberately **not** a file in the Workspace, and the reason is the whole of what it is for: it
// records what *this machine* last saw on the Remote, and a record that travelled with the Workspace
// — into a Backup, into a Clone, up to the Remote itself — would be the other machine's belief
// arriving as this one's evidence. A publish that would overwrite work this machine has never seen is
// refused on this record; a manifest that could be published is a manifest that cannot make that
// judgement.
//
// So it is `localStorage`, under a Workspace-scoped key, exactly as `journal.ts` and
// `deleted-projects.ts` are — and under a prefix of its own, because `journalledWorkspaces` and
// `discardJournal` walk theirs and treat everything under it as an unsaved edit.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// IT IS EVIDENCE, NOT A CACHE, AND EVERY FAILURE ANSWERS "NO EVIDENCE"
//
// A browser that will not store it, a value truncated by a full `localStorage`, a record written by a
// build that spells this differently, **a record naming a different repository**: all four answer
// `null`, which is *we cannot say what the Remote held*. With no manifest a publish falls back to the
// bind-time check and says plainly that it cannot tell — a fallback that has to be handled anyway, and
// the only direction that cannot turn a storage problem into an overwrite.
//
// The last of those four is why the record names its Remote rather than only its Workspace. A
// Workspace can be re-bound with the manifest untouched, and a self-validating record answers that
// without anything having to remember to clear it — and survives a re-bind and a re-bind back, which
// clearing would not.
//
// ⚠ **A Workspace of 40 000 files is a manifest of a couple of megabytes, against an origin-wide 5 MB
// `localStorage` budget shared with the write-ahead journal.** {@link PublishManifests.write} answers
// whether it was kept rather than throwing, for the same reason `DeletedProjects.record` does: a
// manifest that would not fit must not fail a publish that has already succeeded.

import type { JournalStorage } from '../autosave/journal.js';
import { keysWithPrefix } from '../autosave/workspace-scoped-key.js';
import type { RemoteRepository } from './publish-to-remote.js';

/**
 * Every key this module owns begins with this. Nothing else in the origin may.
 *
 * Not under `ballastella.journal.` — see the header — and not under `ballastella.deleted.`, whose
 * records are a standing instruction to delete a directory.
 */
export const PUBLISH_MANIFEST_KEY_PREFIX = 'ballastella.publish-manifest.';

/**
 * The stored shape this build writes and understands.
 *
 * Checked on the way in rather than assumed, the discipline `deleted-projects.ts` records: a record
 * this build has no rules for is one to answer "no evidence" about, not one to read with the wrong
 * rules and then act on.
 */
export const PUBLISH_MANIFEST_FORMAT_VERSION = 1;

/** What one Workspace's Remote held when its last publish finished. */
export interface PublishManifest {
	/**
	 * Which repository and branch it is a claim about.
	 *
	 * ⚠ **Recorded so the record can be checked against the Remote it is offered as evidence about.**
	 * A Workspace can be re-bound — `bindRemote` takes a Workspace that is already bound, and
	 * unbinding leaves everything else where it is — so "keyed by Workspace" alone would let this
	 * machine's claim about `ada/atlas` stand, undetectably, as evidence about `ada/atlas-2`. The
	 * branch is part of it because two branches of one repository are two different trees.
	 */
	readonly remote: RemoteRepository;
	/** The commit the ref was moved to, so the record says *which* publish it describes. */
	readonly commit: string;
	/** Every path in that commit, and the blob SHA it pointed at. */
	readonly files: ReadonlyMap<string, string>;
}

/** The stored form, so a future field is an addition rather than a re-encoding. */
interface StoredManifest {
	readonly formatVersion: number;
	/** ISO 8601, for whoever is reading `localStorage` with the devtools open. */
	readonly at: string;
	readonly owner: string;
	readonly repository: string;
	readonly branch: string;
	readonly commit: string;
	readonly files: Record<string, string>;
}

/**
 * The publish manifest of **one** Workspace.
 *
 * Bound to a Workspace at construction for the reason {@link WriteAheadJournal} and
 * {@link DeletedProjects} are: one click switches Workspaces, and a manifest keyed by nothing else
 * would let what this machine saw on one Remote stand as evidence about another.
 */
export class PublishManifests {
	readonly #storage: JournalStorage;
	readonly #key: string;

	constructor(storage: JournalStorage, workspace: string) {
		this.#storage = storage;
		this.#key = publishManifestKey(workspace);
	}

	/**
	 * What `remote` held when this Workspace last published, or `null` for "we cannot say".
	 *
	 * ⚠ **The Remote is an argument because the answer depends on it.** A record describing a
	 * different repository, or a different branch of the same one, is somebody's belief about
	 * somewhere else and is answered `null` — the same "we cannot say" a missing record gets, which
	 * is the only direction that cannot turn a re-binding into an overwrite.
	 */
	read(remote: RemoteRepository): PublishManifest | null {
		let value: string | null;
		try {
			value = this.#storage.getItem(this.#key);
		} catch {
			// A storage that will not answer — Safari with cookies blocked reads and throws. Not evidence
			// of an empty Remote; evidence of nothing.
			return null;
		}
		return decode(value, remote);
	}

	/**
	 * Record what the Remote holds now.
	 *
	 * @returns whether it was kept. `false` is a browser that will not store it, or a Workspace too
	 *   large for what is left of the 5 MB — see the header. Answered rather than thrown, because a
	 *   publish that has already reached the Remote must not be reported as having failed.
	 */
	write(manifest: PublishManifest): boolean {
		const stored: StoredManifest = {
			formatVersion: PUBLISH_MANIFEST_FORMAT_VERSION,
			at: new Date().toISOString(),
			owner: manifest.remote.owner,
			repository: manifest.remote.repository,
			branch: manifest.remote.branch,
			commit: manifest.commit,
			files: Object.fromEntries(manifest.files)
		};
		try {
			this.#storage.setItem(this.#key, JSON.stringify(stored));
			return true;
		} catch {
			// ⚠ **The record that is already there is thrown away, and that is the point of catching at
			// all.** A `QuotaExceededError` leaves the *previous* publish's map in place, and the reader
			// above cannot tell it from a record of the publish that has just happened — so every path
			// this publish legitimately changed would come back as somebody else's work. Removing it
			// degrades the answer to "we cannot say", which is the fallback a publish handles anyway.
			this.clear();
			return false;
		}
	}

	/** Forget it. Idempotent. */
	clear(): void {
		try {
			this.#storage.removeItem(this.#key);
		} catch {
			// Nothing a caller can do, and nothing is lost: an unremovable record is one the reader above
			// still validates before anybody acts on it.
		}
	}
}

/** The key one Workspace's manifest is filed under. */
export const publishManifestKey = (workspace: string): string =>
	`${PUBLISH_MANIFEST_KEY_PREFIX}${encodeURIComponent(workspace)}`;

/**
 * Throw away the manifest of a Workspace that is being deleted.
 *
 * ⚠ **The same reuse hazard the journal and the deletion records carry**, and it is the destructive
 * one: a manifest left behind by a Workspace called "Marking 2026" is this machine's claim about what
 * a Remote held, standing ready for whatever "Marking 2026" is made next — a Workspace bound to a
 * different repository, whose first publish would then be judged against somebody else's tree.
 *
 * @returns whether a manifest was there to remove
 */
export function discardPublishManifest(storage: JournalStorage, workspace: string): boolean {
	const key = publishManifestKey(workspace);
	const held = keysWithPrefix(storage, PUBLISH_MANIFEST_KEY_PREFIX).includes(key);
	if (!held) return false;
	try {
		storage.removeItem(key);
		return true;
	} catch {
		return false;
	}
}

/** A stored value as a manifest, with anything this build has no rules for answering "no evidence". */
function decode(value: string | null, remote: RemoteRepository): PublishManifest | null {
	if (value === null) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed as Partial<StoredManifest>;
	if (record.formatVersion !== PUBLISH_MANIFEST_FORMAT_VERSION) return null;
	// A claim about somewhere else, which is no claim about here. This is what survives a Workspace
	// re-bound to a second repository and then bound back to the first: clearing on re-bind would
	// have thrown away a record that is still perfectly good evidence about the Remote it names.
	if (
		record.owner !== remote.owner ||
		record.repository !== remote.repository ||
		record.branch !== remote.branch
	) {
		return null;
	}
	if (typeof record.commit !== 'string' || record.commit === '') return null;
	const files = record.files;
	if (typeof files !== 'object' || files === null || Array.isArray(files)) return null;
	const entries = new Map<string, string>();
	for (const [path, sha] of Object.entries(files)) {
		// One bad entry is a truncated or foreign record rather than a manifest missing one file, and
		// reading it as the latter is how a partial belief comes to license an overwrite.
		if (typeof sha !== 'string' || sha === '') return null;
		entries.set(path, sha);
	}
	return { remote, commit: record.commit, files: entries };
}
