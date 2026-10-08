import type { FetchFn } from '../injection/store-image-fetch.js';
import type { Bytes } from '../store/project-store.js';
import {
	ImportSourceRefusedError,
	createProjectImportSource,
	isSharedClosurePath,
	parseImportedProjectFile,
	type ClosureFile,
	type ClosurePath,
	type OfferedFile,
	type ProjectImportSource
} from '../transfer/project-import-source.js';
import { verifiedReader } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH, describeRemote } from './remote-binding.js';
import type { RemoteBlob } from './remote-tree.js';
import {
	findProject,
	readReviewHeadCommit,
	readReviewTree,
	type ReviewReference
} from './review-from-remote.js';

export async function readRemoteProjectSource(options: {
	readonly remote: ReviewReference;
	readonly fetch?: FetchFn;
}): Promise<ProjectImportSource> {
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote = { ...options.remote, branch };
	const commit = await readReviewHeadCommit(remote, options.fetch);
	const at = { ...remote, branch: commit };
	const blobs = await readReviewTree(at, options.fetch);
	const { directory, manifest } = findProject(remote, blobs);
	const named = describeRemote(remote);
	const read = verifiedReader(remote, commit, options.fetch, {
		missing: (path) =>
			new ImportSourceRefusedError(
				'incomplete',
				`“${path}” is in ${named}'s file list but could not be downloaded, so this Project ` +
					`cannot be copied whole.`
			),
		corrupt: (path) =>
			new ImportSourceRefusedError(
				'incomplete',
				`“${path}” arrived as different bytes from the ones ${named} lists for it, so it is not ` +
					`what its author sent.`
			)
	});

	const projectFileBytes = await read(manifest.path, manifest.sha);
	const project = parseImportedProjectFile(projectFileBytes);
	const prefix = `${directory}/`;
	const offered = offer(blobs, prefix);
	const shas = new Map(blobs.map((blob) => [blob.path, blob.sha]));

	return createProjectImportSource({
		origin: {
			kind: 'github',
			owner: remote.owner,
			repository: remote.repository,
			branch,
			directory,
			commit,
			projectName: project.name
		},
		project,
		projectFileBytes,
		offered,
		files: (paths) => fetchClosure(read, shas, prefix, paths)
	});
}

function offer(blobs: readonly RemoteBlob[], prefix: string): OfferedFile[] {
	const offered: OfferedFile[] = [];
	for (const blob of blobs) {
		if (blob.path.startsWith(prefix)) {
			offered.push({ path: blob.path.slice(prefix.length), bytes: blob.bytes });
			continue;
		}
		if (isSharedClosurePath(blob.path)) offered.push({ path: blob.path, bytes: blob.bytes });
	}
	return offered;
}

async function* fetchClosure(
	read: (path: string, sha: string) => Promise<Bytes>,
	shas: ReadonlyMap<string, string>,
	prefix: string,
	paths: readonly ClosurePath[]
): AsyncIterable<ClosureFile> {
	for (const path of paths) {
		const at = isSharedClosurePath(path) ? path : `${prefix}${path}`;
		const sha = shas.get(at);
		if (sha === undefined) continue;
		yield { path, bytes: await read(at, sha) };
	}
}
