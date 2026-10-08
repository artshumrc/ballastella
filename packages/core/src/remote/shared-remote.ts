import type { FetchFn } from '../injection/store-image-fetch.js';
import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { topLevelSegment } from '../store/project-store.js';
import { GITHUB_API_ORIGIN, githubFetch, repoApiUrl } from './github-api.js';
import { describeRemote, type RemoteReference } from './remote-binding.js';

export type RemoteSharing = {
	readonly shared: boolean;
	readonly known: boolean;
	readonly owner: string;
	readonly others: readonly string[];
};

type RemoteSharingOptions = {
	readonly token: string;
	readonly remote: RemoteReference;
	readonly identity?: string;
	readonly fetch?: FetchFn;
};

const request = (options: RemoteSharingOptions) => githubFetch(options.fetch, options.token);

const same = (one: string, other: string): boolean =>
	one !== '' && one.toLowerCase() === other.toLowerCase();

export async function readGitHubLogin(options: {
	readonly token: string;
	readonly fetch?: FetchFn;
}): Promise<string> {
	const response = await githubFetch(
		options.fetch,
		options.token
	)(`${GITHUB_API_ORIGIN}/user`).catch(() => null);
	if (!response?.ok) return '';
	const body = (await response.json().catch(() => ({}))) as { login?: unknown };
	return typeof body.login === 'string' ? body.login : '';
}

async function readContributors(options: RemoteSharingOptions): Promise<string[] | null> {
	const response = await request(options)(
		`${repoApiUrl(options.remote)}/contributors?per_page=100&anon=1`
	).catch(() => null);
	if (response?.status === 204) return [];
	if (!response?.ok) return null;
	const body = await response.json().catch(() => null);
	if (!Array.isArray(body)) return null;
	return body
		.map((one) => (one as { login?: unknown }).login)
		.filter((login): login is string => typeof login === 'string');
}

export async function readRemoteSharing(options: RemoteSharingOptions): Promise<RemoteSharing> {
	const owner = options.remote.owner;
	const identity = options.identity?.trim()
		? options.identity.trim()
		: await readGitHubLogin(options);
	if (identity === '') {
		return { shared: true, known: false, owner, others: [] };
	}
	if (!same(owner, identity)) {
		return { shared: true, known: true, owner, others: [owner] };
	}

	const contributors = await readContributors(options);
	if (contributors === null) return { shared: true, known: false, owner, others: [] };
	const others = [...new Set(contributors.filter((login) => !same(login, identity)))].sort();
	return { shared: others.length > 0, known: true, owner, others };
}

export type OutboundDeletionPreview = {
	readonly remote: RemoteReference;
	readonly projects: readonly string[];
	readonly mapImages: readonly string[];
	readonly paths: readonly string[];
	readonly remaining: readonly string[];
	readonly message: string;
};

export function describeOutboundRemovals(options: {
	readonly remote: RemoteReference;
	readonly sharing: RemoteSharing;
	readonly removed: Iterable<string>;
	readonly source: Iterable<string>;
}): OutboundDeletionPreview {
	const paths = [...new Set(options.removed)].sort();
	const source = [...options.source];
	const heldUnder = (prefix: string): boolean => source.some((path) => path.startsWith(prefix));
	const accounted = new Set<string>();
	const claim = (prefix: string): void => {
		for (const path of paths) if (path.startsWith(prefix)) accounted.add(path);
	};

	const projects: string[] = [];
	const candidates = new Set(
		paths
			.filter((path) => path.includes('/'))
			.map(topLevelSegment)
			.filter((directory) => directory !== IMAGE_DIRECTORY && directory !== ALIGNMENT_DIRECTORY)
	);
	for (const directory of [...candidates].sort()) {
		if (heldUnder(`${directory}/`)) continue;
		projects.push(directory);
		claim(`${directory}/`);
	}

	const mapImages: string[] = [];
	const identities = new Set(
		paths
			.filter((path) => path.startsWith(`${IMAGE_DIRECTORY}/`))
			.map((path) => path.split('/')[1] ?? '')
	);
	for (const imageId of [...identities].sort()) {
		if (imageId === '' || heldUnder(`${IMAGE_DIRECTORY}/${imageId}/`)) continue;
		mapImages.push(imageId);
		claim(`${IMAGE_DIRECTORY}/${imageId}/`);
		accounted.add(`${ALIGNMENT_DIRECTORY}/${imageId}.json`);
	}

	const remaining = paths.filter((path) => !accounted.has(path));
	return {
		remote: options.remote,
		projects,
		mapImages,
		paths,
		remaining,
		message: removalMessage(options.remote, options.sharing, projects, mapImages, remaining, paths)
	};
}

function sentenceList(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] as string}`;
}

export const count = (many: number, thing: string): string =>
	`${many} ${thing}${many === 1 ? '' : 's'}`;

function whoseSentence(remote: RemoteReference, sharing: RemoteSharing): string {
	const where = describeRemote(remote);
	if (!sharing.known) {
		return (
			`Ballastella could not establish whether anybody else works in ${where}, so it is asking as ` +
			`though somebody does.`
		);
	}
	if (sharing.others.length === 1 && sharing.others[0] === sharing.owner) {
		return `${where} belongs to ${sharing.owner}, not to you.`;
	}
	if (sharing.others.length === 0) return `${where} may not be yours alone.`;
	const who = sentenceList([...sharing.others]);
	return `${who} ${sharing.others.length === 1 ? 'has' : 'have'} worked in ${where} as well as you.`;
}

function removalMessage(
	remote: RemoteReference,
	sharing: RemoteSharing,
	projects: readonly string[],
	mapImages: readonly string[],
	remaining: readonly string[],
	paths: readonly string[]
): string {
	const whose = whoseSentence(remote, sharing);
	if (paths.length === 0) {
		return (
			`${whose} Overwriting anyway takes nothing off ${describeRemote(remote)} — every file it ` +
			`holds is one this Workspace has too — but it replaces the files you were just shown with ` +
			`this Workspace's own copies of them, and whatever anybody else put in those is lost.`
		);
	}
	const named = [
		...projects.map((directory) => `the Project ${directory}`),
		...mapImages.map((imageId) => `the Map Image ${imageId}`)
	];
	const rest =
		remaining.length === 0
			? ''
			: ` ${named.length === 0 ? 'It removes' : 'It also removes'} ` +
				`${count(remaining.length, 'file')}: ${remaining.join(', ')}.`;
	return (
		`${whose} Overwriting anyway removes ${count(paths.length, 'file')} from ` +
		`${describeRemote(remote)} that this Workspace has not got.` +
		(named.length === 0 ? '' : ` That removes ${sentenceList(named)} completely.`) +
		rest +
		` Nothing in this Workspace is changed either way, and there is no way to put them back from ` +
		`here afterwards.`
	);
}
