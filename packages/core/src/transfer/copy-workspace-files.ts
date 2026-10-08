import { writeArrivedFile } from '../alignment/alignment-file.js';
import { assertNotReviewing, readReviewMark } from '../project/review-workspace.js';
import type { EnumerableReadOnlyProjectStore, ProjectStore } from '../store/project-store.js';
import type { TransferProgressListener } from './transfer.js';

interface WorkspaceCopy {
	readonly files: number;
	readonly bytes: number;
}

export async function copyWorkspaceFiles(options: {
	readonly from: EnumerableReadOnlyProjectStore;
	readonly to: ProjectStore;
	readonly workspaceName: string;
	readonly onProgress?: TransferProgressListener;
}): Promise<WorkspaceCopy> {
	const { from, to, workspaceName, onProgress } = options;
	assertNotReviewing(workspaceName, await readReviewMark(from), 'moved into a folder');

	if ((await to.list('')).length > 0) {
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
	const report = (path: string | null): void =>
		onProgress?.({ files, totalFiles: paths.length, bytes, totalBytes, path });

	report(null);
	for (const path of paths) {
		const content = await from.read(path);
		await writeArrivedFile(to, path, content);
		files += 1;
		bytes += content.length;
		report(path);
	}
	report(null);

	return { files, bytes };
}
