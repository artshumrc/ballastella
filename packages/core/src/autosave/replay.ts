import { writeArrivedFile } from '../alignment/alignment-file.js';
import { IMAGE_DIRECTORY, imageInfoPath } from '../project/image-files.js';
import { referencedImagePath } from '../remote-iiif/referenced-image.js';
import { projectFilePath } from '../project/project-file.js';
import { RESERVED_DIRECTORY_NAMES, hoistedImageId } from '../project/workspace.js';
import {
	PathNotFoundError,
	messageOf,
	readIfPresent,
	sameBytes,
	topLevelSegment,
	type Bytes,
	type ProjectStore,
	type StorePath
} from '../store/project-store.js';
import type { DeletedProjects } from './deleted-projects.js';
import {
	WriteAheadJournal,
	describeSize,
	fingerprintOf,
	readHeldCopies,
	readJournal,
	type JournalEntry,
	type JournalProblem,
	type JournalStorage
} from './journal.js';

type ReplaySkipReason =
	| 'no-such-project'
	| 'project-deleted'
	| 'no-such-map-image'
	| 'already-in-the-store'
	| 'cannot-tell-which-is-newer'
	| 'superseded';

interface ReplaySkipped {
	readonly path: StorePath;
	readonly reason: ReplaySkipReason;
	readonly detail: string;
	readonly copy: string | null;
}

interface ReplayFailure {
	readonly path: StorePath;
	readonly detail: string;
}

export interface JournalReplayReport {
	readonly workspace: string;
	readonly restored: readonly StorePath[];
	readonly skipped: readonly ReplaySkipped[];
	readonly failed: readonly ReplayFailure[];
	readonly problems: readonly JournalProblem[];
}

export const replayIsNoteworthy = (report: JournalReplayReport): boolean =>
	report.restored.length > 0 ||
	report.skipped.length > 0 ||
	report.failed.length > 0 ||
	report.problems.length > 0;

export async function replayJournal(
	storage: JournalStorage,
	store: ProjectStore,
	workspace: string,
	options: { readonly deleted?: DeletedProjects; readonly journal?: WriteAheadJournal } = {}
): Promise<JournalReplayReport> {
	const journal = options.journal ?? new WriteAheadJournal(storage, workspace);
	const { entries, problems: journalProblems } = readJournal(storage, workspace);
	const { copies: alreadyHeld, problems: heldProblems } = readHeldCopies(storage, workspace);
	const problems = [...journalProblems, ...heldProblems];
	const restored: StorePath[] = [];
	const skipped: ReplaySkipped[] = [];
	const failed: ReplayFailure[] = [];

	for (const entry of entries) {
		try {
			const blocked = await missingOwner(store, entry.path, options.deleted);
			if (blocked !== null) {
				skipped.push(blocked);
				journal.discard(entry.path);
				continue;
			}

			const current = await readIfPresent(store, entry.path);
			const verdict = current === null ? null : compare(entry, current);
			if (current !== null && verdict === 'already-in-the-store') {
				skipped.push({
					path: entry.path,
					reason: verdict,
					copy: null,
					detail:
						`An unsaved change to “${entry.path}” did not need to be put back — your ` +
						`Workspace already had it.`
				});
				journal.forget(entry.path);
				continue;
			}
			if (current !== null && verdict !== null && verdict !== 'write') {
				// Otherwise the stale baseline carries into the next edit and a refusal becomes a standing one.
				journal.observe(entry.path, current, journal.mark());
				const setAside = journal.hold(entry.path, entry.bytes, entry.at, verdict);
				skipped.push({
					path: entry.path,
					reason: verdict,
					copy: setAside,
					detail:
						verdict === 'superseded'
							? `An unsaved change to “${entry.path}” was not put back, because that file has been ` +
								`changed since the change was made — putting it back would undo the newer one. ` +
								`${describeWhereItWent(setAside)}`
							: `An unsaved change to “${entry.path}” was found, and Ballastella cannot tell ` +
								`whether it is newer than the file in your Workspace. The unsaved copy is ` +
								`${describeSize(entry.bytes.length)}${describeWhen(entry.at)}; ` +
								`the file in your Workspace is ${describeSize(current.length)}. Nothing has been ` +
								`overwritten. ${describeWhereItWent(setAside)}`
				});
				continue;
			}

			await writeArrivedFile(store, entry.path, entry.bytes, { intent: 'update' });
			restored.push(entry.path);
			journal.forget(entry.path);
		} catch (cause) {
			failed.push({
				path: entry.path,
				detail:
					`An unsaved change to “${entry.path}” could not be put back: ` +
					`${messageOf(cause)}. It has been kept and ` +
					`will be tried again next time this Workspace is opened.`
			});
		}
	}

	for (const copy of alreadyHeld) {
		try {
			const current = await readIfPresent(store, copy.path);
			skipped.push({
				path: copy.path,
				reason: copy.reason === 'superseded' ? 'superseded' : 'cannot-tell-which-is-newer',
				copy: copy.fingerprint,
				detail:
					`An unsaved change to “${copy.path}”${describeWhen(copy.at)} is still being kept: ` +
					`it was not put back, and nothing has been overwritten. The kept copy is ` +
					`${describeSize(copy.bytes.length)}; ` +
					`${
						current === null
							? 'there is no such file in your Workspace now'
							: `the file in your Workspace is ${describeSize(current.length)}`
					}.`
			});
		} catch (cause) {
			failed.push({
				path: copy.path,
				detail:
					`A kept copy of “${copy.path}” could not be described: ` +
					`${messageOf(cause)}. It is still being kept.`
			});
		}
	}

	return { workspace, restored, skipped, failed, problems };
}

function describeWhereItWent(copy: string | null): string {
	return copy === null
		? `Ballastella could not set your copy aside — there is no room left in this browser's ` +
				`storage for it. It is still in the journal, where the next change to this file will ` +
				`replace it, so save or copy anything you need from it now.`
		: `Your copy has been kept.`;
}

function describeWhen(at: string): string {
	if (at === '') return '';
	const when = new Date(at);
	if (Number.isNaN(when.getTime())) return '';
	return `, from ${when.toLocaleString()}`;
}

function compare(
	entry: JournalEntry,
	current: Bytes
): 'write' | 'already-in-the-store' | 'cannot-tell-which-is-newer' | 'superseded' {
	if (sameBytes(current, entry.bytes)) return 'already-in-the-store';
	if (entry.held === null) return 'cannot-tell-which-is-newer';
	if (fingerprintOf(current) !== entry.held) return 'superseded';
	return 'write';
}

// Any doubt counts as present: a wrong "missing" would silently destroy the rescued edit.
async function hasMapImage(store: ProjectStore, imageId: string): Promise<boolean> {
	for (const path of [imageInfoPath(imageId), referencedImagePath(imageId)]) {
		try {
			await store.size(path);
			return true;
		} catch (cause) {
			if (!(cause instanceof PathNotFoundError)) return true;
		}
	}
	try {
		return (await store.list(`${IMAGE_DIRECTORY}/${imageId}/`)).length > 0;
	} catch {
		return true;
	}
}

async function missingOwner(
	store: ProjectStore,
	path: StorePath,
	deleted: DeletedProjects | undefined
): Promise<ReplaySkipped | null> {
	const owner = topLevelSegment(path);
	if (owner !== path && deleted?.has(owner) === true) {
		return {
			path,
			reason: 'project-deleted',
			copy: null,
			detail:
				`An unsaved change to “${path}” was not put back, because you deleted the ` +
				`Project it belongs to.`
		};
	}

	const imageId = hoistedImageId(path);
	if (imageId !== null) {
		if (path === imageInfoPath(imageId) || path === referencedImagePath(imageId)) return null;
		return (await hasMapImage(store, imageId))
			? null
			: {
					path,
					reason: 'no-such-map-image',
					copy: null,
					detail:
						`An unsaved change to “${path}” was not put back, because the Map Image it ` +
						`belongs to is no longer in this Workspace.`
				};
	}

	if (RESERVED_DIRECTORY_NAMES.includes(owner)) return null;
	if (owner === path) return null;
	if (path === projectFilePath(owner)) return null;
	const present = await readIfPresent(store, projectFilePath(owner)).catch(() => true);
	return present !== null
		? null
		: {
				path,
				reason: 'no-such-project',
				copy: null,
				detail:
					`An unsaved change to “${path}” was not put back, because the Project it belongs to is ` +
					`no longer in this Workspace.`
			};
}
