// One Project on somebody's Published Site, offered as a read-only Import source (ADR-0037).
//
// **The Review's mechanics, asked for a different purpose.** The tree listing, the anonymity, the
// truncation refusal and the blob-SHA check are `review-from-remote.ts`'s and are shared rather than
// restated — `readReviewTree` for the file list and its refusals, `findProject` for the namespace
// question, `gitBlobSha` for the byte check. What differs is what happens to the result: a Review
// fills a throwaway Workspace and *reports* what the author failed to send, while an Import hands
// a validated closure to the engine that will make it the user's own work, so a Project the Remote
// cannot supply whole is refused before a destination path is allocated.
//
// ⚠ **No credential, and none may be added.** Reading a public repository is anonymous (ADR-0031), so
// importing a Project off a Remote needs no GitHub account — the same property the Review has, for the
// same reason, and the reason there is no credential anywhere in this module's types.
//
// ⚠ **Nothing here connects anything.** The repository coordinates travel out on the origin as
// observed provenance, and an imported Project retains no Remote relationship (ADR-0037).

import type { FetchFn } from '../injection/store-image-fetch.js';
import { createHttpProjectStore } from '../store/http-project-store.js';
import type { Bytes, StorePath } from '../store/project-store.js';
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
import { gitBlobSha } from './blob-sha.js';
import { GITHUB_RAW_ORIGIN } from './github-api.js';
import { DEFAULT_REMOTE_BRANCH } from './remote-binding.js';
import { urlPath, type RemoteBlob } from './remote-tree.js';
import {
	findProject,
	readReviewHeadCommit,
	readReviewTree,
	type ReviewReference
} from './review-from-remote.js';

/** Which Project on which Remote to Import. The Review's reference, unchanged. */
export interface RemoteProjectSourceOptions {
	readonly remote: ReviewReference;
	/** Defaulting to the page's own, as the send engine and the HTTP store already do. */
	readonly fetch?: FetchFn;
}

/**
 * Read one Project out of a public repository as a validated Import source.
 *
 * The order is the design and it is what makes every refusal free: the tree first, the named Project
 * found in it, `project.json` fetched and parsed, then the closure gathered and validated from the
 * listing. Not one closure byte is fetched until all of that has held.
 *
 * @throws ReviewRefusedError for a repository that cannot be read, or a Project that is not in it
 * @throws ImportSourceRefusedError for a Project the Remote does not hold whole
 * @throws ProjectFormatTooNewError for a Project from a newer version of the app (ADR-0010)
 */
export async function readRemoteProjectSource(
	options: RemoteProjectSourceOptions
): Promise<ProjectImportSource> {
	const branch = options.remote.branch ?? DEFAULT_REMOTE_BRANCH;
	const remote = { ...options.remote, branch };

	// ⚠ **The commit is resolved first and everything after it is read *at* that commit.** It is what
	// the Import records as the state it copied, and a branch is a moving target: a
	// push landing between the listing and the last pyramid tile would have the tree, the bytes and
	// the recorded commit describing three different trees — and the SHA check below would refuse the
	// Import as tampering. Pinned, a push during a long copy is simply not in it, and the provenance
	// entry names a commit whose tree every byte was verified against, which is the only thing that
	// makes it a fact Ballastella observed.
	const commit = await readReviewHeadCommit(remote, options.fetch);
	const at = { ...remote, branch: commit };

	const blobs = await readReviewTree(at, options.fetch);
	const { directory, manifest } = findProject(remote, blobs);
	const read = checkedReader(at, options.fetch);

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

/**
 * What the Remote holds for this Project, Project-relative.
 *
 * **The Remote's paths are a Workspace's paths** — a Remote's tree is a Workspace laid out as
 * ADR-0008 lays one out — so the Project's own files lose their directory prefix and the shared pool
 * keeps the names it already has. That is the same mapping `hoistedImageId` performs on a bundle's
 * entries in the other direction, which is what makes the three sources report one closure.
 *
 * Everything outside the Project's directory and outside the shared pool is simply not offered:
 * another Project's files, the author's own `README.md`, the site record beside them. The closure
 * is then taken out of what is offered, so a file the Project never references cannot travel even if
 * it is under a name that looks shared.
 */
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

/** The closure's bytes, one file at a time, each checked against the SHA the tree named. */
async function* fetchClosure(
	read: (path: StorePath, sha: string) => Promise<Bytes>,
	shas: ReadonlyMap<string, string>,
	prefix: string,
	paths: readonly ClosurePath[]
): AsyncIterable<ClosureFile> {
	for (const path of paths) {
		const at = isSharedClosurePath(path) ? path : `${prefix}${path}`;
		const sha = shas.get(at);
		// Not in the listing the closure was built from — which cannot happen through this module, since
		// the closure is a subset of it. Skipped rather than fetched blind, so the one place that decides
		// what an incomplete source means is the delivery check in `createProjectImportSource`.
		if (sha === undefined) continue;
		yield { path, bytes: await read(at as StorePath, sha) };
	}
}

/**
 * Fetch one file from the raw host and refuse it if the bytes are not the ones the tree named.
 *
 * ⚠ **The check is what makes an Import of somebody's shared Project trustworthy**, and it costs
 * one hash over bytes already in memory. Without it a proxy or a cache serving a rewritten copy
 * becomes permanent work in the user's own Workspace, indistinguishable from what its author wrote.
 */
function checkedReader(
	remote: Required<ReviewReference>,
	fetchFn: FetchFn | undefined
): (path: StorePath, sha: string) => Promise<Bytes> {
	const source = createHttpProjectStore({
		resolve: (path) =>
			`${GITHUB_RAW_ORIGIN}/${urlPath(remote.owner)}/${urlPath(remote.repository)}/` +
			`${urlPath(remote.branch)}/${urlPath(path)}`,
		// Spread rather than assigned: under `exactOptionalPropertyTypes` an explicit `undefined` is not
		// the same as an absent property, and the store's default is "the page's own `fetch`".
		...(fetchFn === undefined ? {} : { fetch: fetchFn })
	});
	return async (path, sha) => {
		let content: Bytes;
		try {
			content = await source.read(path);
		} catch {
			throw new ImportSourceRefusedError(
				'incomplete',
				`“${path}” is in ${remote.owner}/${remote.repository}'s file list but could not be ` +
					`downloaded, so this Project cannot be copied whole.`
			);
		}
		if ((await gitBlobSha(content)) !== sha) {
			throw new ImportSourceRefusedError(
				'incomplete',
				`“${path}” arrived as different bytes from the ones ` +
					`${remote.owner}/${remote.repository} lists for it, so it is not what its author ` +
					`sent.`
			);
		}
		return content;
	};
}
