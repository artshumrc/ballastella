export const DEFAULT_REMOTE_BRANCH = 'main';

export type RemoteReference = {
	readonly owner: string;
	readonly repository: string;
	readonly branch?: string;
};

export type RemoteRepository = Required<RemoteReference>;

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+$/;

export const isRepositoryName = (value: string): boolean =>
	REPOSITORY_PATTERN.test(value) && value !== '.' && value !== '..';

export const isOwnerName = (value: string): boolean => OWNER_PATTERN.test(value);

export function normaliseRemoteIdentity(record: {
	readonly owner?: unknown;
	readonly repository?: unknown;
	readonly branch?: unknown;
}): { owner: string; repository: string; branch: string } | null {
	const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
	const owner = text(record.owner);
	const repository = text(record.repository);
	if (!isOwnerName(owner) || !isRepositoryName(repository)) return null;
	return { owner, repository, branch: text(record.branch) || DEFAULT_REMOTE_BRANCH };
}

export const describeRemote = (remote: RemoteReference): string =>
	`${remote.owner}/${remote.repository}`;

export function parseRemoteReference(
	pasted: string
): { readonly owner: string; readonly repository: string } | null {
	const trimmed = pasted
		.trim()
		.replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
		.replace(/\/+$/, '')
		.replace(/\.git$/i, '');
	const segments = trimmed.split('/');
	if (segments.length !== 2) return null;
	const [owner, repository] = segments;
	if (owner === undefined || !isOwnerName(owner)) return null;
	if (repository === undefined || !isRepositoryName(repository)) return null;
	return { owner, repository };
}

const remoteIdentityKey = (remote: RemoteReference): string =>
	`${remote.owner.toLowerCase()}/${remote.repository.toLowerCase()}#${remote.branch || DEFAULT_REMOTE_BRANCH}`;

export const isSameRemote = (one: RemoteReference, other: RemoteReference): boolean =>
	remoteIdentityKey(one) === remoteIdentityKey(other);
