import type { FetchFn } from '../injection/store-image-fetch.js';
import { PROJECT_FILE_NAME } from '../project/project-file.js';
import { foldName, takenDirectoryNames, unusedDirectoryName } from '../project/workspace.js';
import { describeRemote, isSameRemote } from '../remote/remote-binding.js';
import {
	RemoteStatusUnavailableError,
	readRemoteInventory,
	type RemoteStatusRefusal
} from '../remote/remote-status.js';
import type { RemoteRepository } from '../remote/remote-binding.js';
import type { SynchronizationBaseline } from '../remote/synchronization-metadata.js';
import { recognisedProjectDirectories } from '../remote/synchronization-paths.js';
import type { StorePath } from '../store/project-store.js';
import {
	isSharedClosurePath,
	type ClosurePath,
	type ProjectImportOrigin,
	type ProjectImportSource
} from './project-import-source.js';
import { ImportRefusedError } from './project-import-transaction.js';

interface ImportDestination {
	readonly names?: Iterable<string>;
	readonly local?: Iterable<string>;
	readonly remote?: Iterable<string>;
	readonly baseline?: Iterable<string>;
}

interface ProjectImportAllocation {
	readonly name: string;
	readonly directory: string;
	readonly destinations: ReadonlyMap<ClosurePath, StorePath>;
}

export function allocateProjectImport(
	closure: ProjectImportSource,
	destination: ImportDestination = {}
): ProjectImportAllocation {
	const shown = new Set([...(destination.names ?? [])].map(foldName));
	let name = closure.project.name;
	for (let suffix = 1; shown.has(foldName(name)); suffix += 1) {
		name =
			suffix === 1
				? `${closure.project.name} (imported)`
				: `${closure.project.name} (imported ${suffix})`;
	}

	const taken = takenDirectoryNames(destination.local ?? []);
	const shared = recognisedProjectDirectories({
		remote: destination.remote ?? [],
		baseline: destination.baseline ?? []
	});
	for (const held of shared) taken.add(foldName(held));
	const directory = unusedDirectoryName(name, taken);

	const destinations = new Map<ClosurePath, StorePath>(
		closure.paths.map((path) => [path, isSharedClosurePath(path) ? path : `${directory}/${path}`])
	);

	const existing = new Map<string, string>();
	for (const path of destination.local ?? []) existing.set(foldName(path), path);
	for (const [path, at] of destinations) {
		const held = existing.get(foldName(at));
		if (held === undefined) continue;
		throw new ImportRefusedError(
			'destination-exists',
			`This Workspace already holds “${held}”, and the Import would write ` +
				`${path === PROJECT_FILE_NAME ? 'the Project' : `“${path}”`} to “${at}”. ` +
				'Nothing has been added to your Workspace.'
		);
	}
	return { name, directory, destinations };
}

export interface ImportIntoWorkspace {
	readonly remote: RemoteRepository | null;
	readonly baseline?: SynchronizationBaseline | null;
	readonly local: Iterable<string>;
	readonly token?: string | null;
	readonly fetch?: FetchFn;
}

export function assertNotOwnRemote(check: {
	readonly origin: ProjectImportOrigin;
	readonly remote: RemoteRepository | null;
	readonly local: Iterable<string>;
	readonly remotePaths: Iterable<string>;
	readonly baselinePaths?: Iterable<string>;
}): void {
	const { remote, origin } = check;
	if (remote === null || origin.kind !== 'github' || !isSameRemote(origin, remote)) return;
	const here = recognisedProjectDirectories({ local: check.local }).has(origin.directory);
	const synchronized = recognisedProjectDirectories({
		remote: check.remotePaths,
		baseline: check.baselinePaths ?? []
	});
	if (!here && !synchronized.has(origin.directory)) return;
	const named = describeRemote(remote);
	throw new ImportRefusedError(
		'own-remote',
		here
			? `“${origin.projectName}” is already in this Workspace, which is synchronized with ` +
					`${named}, so Importing it would leave you two copies of your own work and only one of ` +
					`them synchronized. Open it from your Projects instead. Nothing has been added to your ` +
					`Workspace.`
			: `“${origin.projectName}” is a Project of ${named}, which is this Workspace's own Remote, ` +
					`so it is not somebody else's work to copy in. Use Sync to bring it into ` +
					`this Workspace. Nothing has been added to your Workspace.`
	);
}

export async function readImportEvidence(
	origin: ProjectImportOrigin,
	workspace: ImportIntoWorkspace
): Promise<Pick<ImportDestination, 'remote' | 'baseline'>> {
	const remote = workspace.remote;
	if (remote === null) return {};
	let paths: readonly string[];
	try {
		const inventory = await readRemoteInventory({
			remote,
			token: workspace.token ?? null,
			...(workspace.fetch === undefined ? {} : { fetch: workspace.fetch })
		});
		paths = inventory.map((entry) => entry.path);
	} catch (cause) {
		if (!(cause instanceof RemoteStatusUnavailableError)) throw cause;
		throw new ImportRefusedError('remote-unavailable', uninventoriable(remote, cause.refusal));
	}

	const baseline = workspace.baseline?.files;
	assertNotOwnRemote({
		origin,
		remote,
		local: workspace.local,
		remotePaths: paths,
		...(baseline === undefined ? {} : { baselinePaths: baseline.keys() })
	});
	return { remote: paths, ...(baseline === undefined ? {} : { baseline: [...baseline.keys()] }) };
}

function uninventoriable(remote: RemoteRepository, refusal: RemoteStatusRefusal): string {
	const named = describeRemote(remote);
	const because: Record<RemoteStatusRefusal, string> = {
		unreachable: `Ballastella could not reach GitHub to read ${named}`,
		credential: `GitHub would not accept this browser's credential for ${named}`,
		'rate-limited': `GitHub's hourly request limit is used up, so ${named} could not be read`,
		'no-repository': `GitHub has no ${named} that this browser can see`,
		'not-public': `${named} cannot be read without signing in`,
		truncated: `GitHub could only list part of ${named}`,
		refused: `GitHub refused to list ${named}`
	};
	return (
		`${because[refusal]}, so Ballastella cannot tell which Projects this Workspace's Remote already ` +
		`holds — and an Import placed without knowing that could collide with a Project that exists ` +
		`only on GitHub. Nothing has been added to your Workspace. Try again once ${named} can be read.`
	);
}
