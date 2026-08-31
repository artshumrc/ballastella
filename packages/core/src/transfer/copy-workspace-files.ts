import { writeAlignmentBytes } from '../alignment/alignment-file.js';
import { alignmentImageId } from '../alignment/alignment.js';
import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import type {
	Bytes,
	EnumerableReadOnlyProjectStore,
	ProjectStore,
	StorePath
} from '../store/project-store.js';
import type { TransferProgressListener } from './transfer.js';

export interface CopyWorkspaceFilesOptions {
	/** The Workspace being moved. Read, and never written. */
	readonly from: EnumerableReadOnlyProjectStore;
	/** Where it is going. Must hold no files at all — see {@link copyWorkspaceFiles}. */
	readonly to: ProjectStore;
	/** The name the refusals use, which is the name the author knows this Workspace by. */
	readonly workspaceName: string;
	readonly onProgress?: TransferProgressListener;
}

export interface WorkspaceCopy {
	readonly files: number;
	readonly bytes: number;
}

/**
 * Copy every file of one Workspace into another store, so existing work can reach a folder on disk.
 *
 * ⚠ **The destination must be empty, and this is the whole safety argument.** ADR-0024's rule for
 * every transfer is that it never overwrites and never merges, and here both failures are reachable
 * from one gesture: a folder the author picked by mistake holds their colleague's checkout, and
 * ADR-0023's one-Alignment-per-Map-Image rule means a merge would overwrite an Alignment several of
 * *their* Projects are drawn by. Nothing is written when it refuses, so a wrong folder costs the
 * press and nothing else.
 *
 * **Nothing is deleted, here or by any caller.** The source Workspace is left exactly as it was, and
 * the move is a move only in the sense the author cares about — their work is now in a folder they
 * can see. Removing the copy in browser storage is their own act afterwards, from the roster, once
 * they have looked in the folder and found their Projects there.
 *
 * **Everything is copied, including what a Backup leaves out.** `exportWorkspaceTar` excludes the
 * published viewer files because an archive carrying a stale viewer bundle is a restored site that
 * has gone wrong; this is not an archive, it is the same Workspace in a different place, and
 * `base-map/`'s offline extract is real work of the author's that a re-fetch would cost them.
 *
 * @throws ReviewWorkspaceError when `from` is a review copy (ADR-0024)
 */
export async function copyWorkspaceFiles(
	options: CopyWorkspaceFilesOptions
): Promise<WorkspaceCopy> {
	const { from, to, workspaceName, onProgress } = options;
	// Somebody else's work never becomes a Workspace of the author's own in a folder they keep: a
	// review copy is built to be thrown away, and a copy of one on disk outlives every reason it
	// existed. Refused in the copier rather than only where the control is, for the reason
	// `exportWorkspaceTar`'s refusal is here rather than only in the app.
	assertNotReviewing(workspaceName, await readReviewMark(from), 'moved into a folder');

	const held = await to.list('');
	if (held.length > 0) {
		throw new Error(
			`That folder already holds files, so “${workspaceName}” was not moved into it and nothing ` +
				`was written. Choose an empty folder — a new one is fine — so that nothing of yours is ` +
				`overwritten and nothing already in the folder is mixed in with your work.`
		);
	}

	const paths = await from.list('');
	const sizes = await Promise.all(paths.map((path) => from.size(path)));
	const totalBytes = sizes.reduce((sum, size) => sum + size, 0);

	let files = 0;
	let bytes = 0;
	const report = (path: StorePath | null): void =>
		onProgress?.({ files, totalFiles: paths.length, bytes, totalBytes, path });

	report(null);
	for (const path of paths) {
		// One file in the heap at a time, which is the same bound `exportWorkspaceTar` documents: the
		// store has no streaming read, so a copied `full/max` derivative is held whole for as long as
		// its write takes.
		const content = await from.read(path);
		await writeCopied(to, path, content);
		files += 1;
		bytes += content.length;
		report(path);
	}
	report(null);

	return { files, bytes };
}

/**
 * Write one copied file, sending an Alignment through the one writer (ADR-0023).
 *
 * The path arrives out of `list`, so the compiler only ever sees a `string` and the
 * `AlignmentPath` brand cannot apply — the same gap `restore-workspace-tar.ts`'s `writeRestored`
 * documents, and it is closed the same way rather than left as a true statement about the codebase
 * that the next reader takes for permission. `intent: 'create'` always writes here, because the
 * destination is refused above unless it is empty.
 */
async function writeCopied(store: ProjectStore, path: StorePath, bytes: Bytes): Promise<void> {
	const imageId = alignmentImageId(path);
	if (imageId === null) {
		await store.write(path, bytes);
		return;
	}
	await writeAlignmentBytes(
		{
			read: (at) => store.read(at),
			commit: (at, content) => store.write(at, content)
		},
		{ imageId, bytes, write: { intent: 'create' } }
	);
}
