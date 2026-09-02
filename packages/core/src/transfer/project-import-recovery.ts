// Resolving the Import marker a dead tab left behind, before the Workspace opens (ADR-0037).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE OTHER HALF OF THE GATE, NOT A BACKGROUND TIDY-UP
//
// `project-import-transaction.ts` writes a closure straight to its final paths and makes it
// provisional by naming it in one durable marker: while that marker is unresolved the Workspace is
// **unavailable**, because provisional files sit at ordinary Workspace paths and every reader would
// otherwise see them. That gate is only worth having if something closes it, and this is that
// something. It runs before a Project list, a Map Image list, a size, a Backup, a sync plan, a
// Remote read, an interrupted deletion or a journal replay — before anything at all asks the
// Workspace a question.
//
// So it is a *prerequisite* rather than a task. A recovery that cannot finish does not get retried
// later while the user works; it leaves the marker exactly where it is and the Workspace shut, and
// the next visit tries again from the same inventory. The marker is the durable evidence, which is
// why nothing here removes it until there is nothing left for it to describe.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE TWO STATES ARE OPPOSITE INSTRUCTIONS, AND THE COMMIT BOUNDARY IS WHY
//
// - **`'writing'`**: nothing about the closure is durable, so every path the marker names goes. The
//   imported `project.json` goes **first** — a Workspace's list of Projects *is* whichever
//   directories hold one (ADR-0008), so a cleanup that stopped half way must not leave a listable
//   Project whose Layers name files that are gone — and the marker goes **last**, so an interruption
//   inside the sweep leaves the inventory for the next attempt.
// - **`'committed'`**: every final path is durable and **nothing may be rolled back**. The Project is
//   the user's, complete, and all that is left is removing the marker that shuts the Workspace.
//
// Getting those two the wrong way round is the one failure the whole protocol exists to prevent, so
// a marker that will not parse is neither: it is refused, and the Workspace stays shut. "Unreadable
// is not absent" pointing the same way it points in `review-workspace.ts` and `alignment-file.ts`.
//
// ⚠ **The marker's inventory is authoritative and nothing here infers a path from a name.**
// `images/` and `alignments/` are the Workspace's shared pool (ADR-0023): a sweep by prefix would
// delete a Map Image of the user's own that happens to sit one directory along, and there is nothing
// in a path that says which transaction put it there.

import { PathNotFoundError, type ProjectStore, type StorePath } from '../store/project-store.js';
import {
	clearImportTransaction,
	discardImportTransaction,
	readImportTransaction,
	type ImportTransaction
} from './project-import-transaction.js';

/** What a startup found outstanding, and what it did about it. */
export type ImportRecovery =
	/** No marker. The Workspace is the user's own and whole. */
	| { readonly outcome: 'nothing' }
	/** An unfinished Import was swept and the Workspace is as it was before it started. */
	| { readonly outcome: 'discarded'; readonly transaction: string }
	/** A finished Import's bookkeeping was completed and the Project is there. */
	| { readonly outcome: 'completed'; readonly transaction: string };

/** Why a Workspace is still not available. Every one of them leaves the marker where it is. */
export type ImportRecoveryFailure =
	/** There is a marker and it cannot be read as one, so neither instruction can be followed. */
	| 'unreadable'
	/** A committed transaction's closure is missing a path the marker names. */
	| 'incomplete'
	/** The backing would not say whether the committed closure is all there. */
	| 'unverifiable'
	/** A path the marker names, or the marker itself, could not be removed. */
	| 'residue';

/**
 * The Workspace stays unavailable, with a sentence for the person whose Import it was.
 *
 * A failure rather than a report, because every caller's next step is the same: do not open the
 * Workspace. The marker is untouched, so the retry is a reload.
 */
export class ImportRecoveryFailedError extends Error {
	readonly failure: ImportRecoveryFailure;

	constructor(
		failure: ImportRecoveryFailure,
		message: string,
		options?: { readonly cause?: unknown }
	) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ImportRecoveryFailedError';
		this.failure = failure;
	}
}

/**
 * Resolve any outstanding Import before this Workspace answers a single question about itself.
 *
 * @throws ImportRecoveryFailedError when the Workspace must stay unavailable
 */
export async function recoverProjectImport(store: ProjectStore): Promise<ImportRecovery> {
	const mark = await readImportTransaction(store);
	if (mark === null) return { outcome: 'nothing' };
	if (mark.state === 'unreadable') {
		throw new ImportRecoveryFailedError(
			'unreadable',
			'This Workspace has a record of an Import that cannot be read, so Ballastella cannot tell ' +
				'whether the Project arrived or not and will not open the Workspace until it can. Reload ' +
				'this page to try again. Nothing has been lost.'
		);
	}
	return mark.state === 'committed' ? finish(store, mark) : discard(store, mark);
}

/**
 * Take back an Import that was still being written.
 *
 * The sweep of abandoned writes comes first, and it is the whole Workspace rather than the
 * inventory's directories: a crash inside an atomic write leaves a temporary file `list` hides and
 * `delete` refuses, one of them beside the marker itself at the Workspace root, and a per-directory
 * sweep would be the same walk several times over while still missing that one. Startup is one of
 * the two moments this is safe — nothing else is writing, because the Workspace has not opened.
 *
 * Then {@link discardImportTransaction}, which owns the ordering both ends depend on. Both halves
 * are idempotent, which is what makes a retry after a failed attempt the same as a first attempt.
 */
async function discard(store: ProjectStore, marker: ImportTransaction): Promise<ImportRecovery> {
	try {
		await store.reclaimAbandonedWrites('');
		await discardImportTransaction(store, marker);
	} catch (cause) {
		throw new ImportRecoveryFailedError(
			'residue',
			'An Import did not finish, and what it had already written could not be removed — so this ' +
				'Workspace stays closed rather than opening with part of a Project in it. Reload this page ' +
				'to try again. None of your own work has been touched.',
			{ cause }
		);
	}
	return { outcome: 'discarded', transaction: marker.transaction };
}

/**
 * Finish an Import that was durably committed before the tab died.
 *
 * The closure is verified whole first, from the inventory rather than by walking the Workspace: past
 * the commit boundary nothing may be rolled back, so a closure with a hole in it is neither swept nor
 * opened — it is said, and the marker stays. `size` rather than `read`, because a pyramid is
 * thousands of tile files and both real backings answer this from directory metadata (ADR-0001).
 */
async function finish(store: ProjectStore, marker: ImportTransaction): Promise<ImportRecovery> {
	const missing: StorePath[] = [];
	for (const path of marker.paths) {
		try {
			await store.size(path);
		} catch (cause) {
			if (!(cause instanceof PathNotFoundError)) {
				throw new ImportRecoveryFailedError(
					'unverifiable',
					'An Import finished and Ballastella cannot reach this Workspace to check that the ' +
						'Project is all there, so it will not open it yet. Reload this page to try again.',
					{ cause }
				);
			}
			missing.push(path);
		}
	}
	if (missing.length > 0) {
		throw new ImportRecoveryFailedError(
			'incomplete',
			`An Import was recorded as finished, but ${
				missing.length === 1
					? 'one of the Project’s files is'
					: `${missing.length} of the Project’s files are`
			} not in this Workspace — so it stays closed rather than opening with an incomplete Project ` +
				'in it. Nothing has been removed. Reload this page to try again, and if it says this every ' +
				'time, restore a Backup of this Workspace.'
		);
	}

	try {
		await clearImportTransaction(store);
	} catch (cause) {
		throw new ImportRecoveryFailedError(
			'residue',
			'An Import finished and this Workspace’s record of it could not be cleared, so it stays ' +
				'closed until that record goes. Nothing has been lost — the Project is there. Reload this ' +
				'page to try again.',
			{ cause }
		);
	}
	return { outcome: 'completed', transaction: marker.transaction };
}
