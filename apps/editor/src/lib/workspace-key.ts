import type { WorkspaceIdentity } from '@ballastella/core';

export const opfsWorkspaceKey = (name: string): string => `opfs:${name}`;
export const folderWorkspaceKey = (folderReference: string): string => `folder:${folderReference}`;

const unprefixed =
	(prefix: string) =>
	(key: string): string | null =>
		key.startsWith(prefix) ? key.slice(prefix.length) : null;
export const namedWorkspaceOf = unprefixed('opfs:');
export const folderReferenceOf = unprefixed('folder:');

export const workspaceIdentityOf = (key: string): WorkspaceIdentity =>
	namedWorkspaceOf(key) === null ? 'a-name-anywhere' : 'this-browser';

export const folderWorkspaceLabel = (name: string): string => `${name} (Workspace folder)`;

export function workspaceKeyLabel(key: string): string {
	const folder = folderReferenceOf(key);
	return namedWorkspaceOf(key) ?? (folder === null ? key : folderWorkspaceLabel(folder));
}
