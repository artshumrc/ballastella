import { foldName } from '../project/workspace.js';
import { OpfsProjectStore } from './directory-handle-store.js';

export const DEFAULT_WORKSPACE_NAME = 'My Workspace';
export const MAX_WORKSPACE_NAME_LENGTH = 64;
const SUFFIX_ATTEMPTS = 1000;
const codePoints = (value: string): string[] => [...value];

// By code point, so a surrogate pair is never cut in half.
const truncate = (value: string, limit: number): string =>
	codePoints(value).slice(0, limit).join('');

export function toWorkspaceName(displayName: string): string {
	const cleaned = truncate(
		displayName
			.normalize('NFC')
			.replace(/[^\p{L}\p{M}\p{N} ()_-]+/gu, ' ')
			.replace(/\s+/g, ' ')
			.trim(),
		MAX_WORKSPACE_NAME_LENGTH
	).trim();
	return cleaned === '' || cleaned === '.' || cleaned === '..' ? DEFAULT_WORKSPACE_NAME : cleaned;
}

// The stem is shortened so the suffix survives the length cap; otherwise every candidate is the same name.
function suffixedWorkspaceName(preferred: string, suffix: number): string {
	const marker = ` (${suffix})`;
	const room = MAX_WORKSPACE_NAME_LENGTH - codePoints(marker).length;
	const stem = truncate(preferred, Math.max(1, room)).trim();
	return toWorkspaceName(`${stem || DEFAULT_WORKSPACE_NAME}${marker}`);
}

class WorkspaceNameExhaustedError extends Error {
	override readonly name = 'WorkspaceNameExhaustedError';
	constructor(preferred: string) {
		super(
			`There are already too many Workspaces called “${preferred}” to make another one. ` +
				`Rename or delete some of them, or choose a different name. Nothing has been created.`
		);
	}
}

const opfsRoot = (): Promise<FileSystemDirectoryHandle> => navigator.storage.getDirectory();

export async function listOpfsWorkspaces(): Promise<string[]> {
	const names: string[] = [];
	for await (const [name, handle] of (await opfsRoot()).entries()) {
		if (handle.kind === 'directory') names.push(name);
	}
	return names.sort((a, b) => a.localeCompare(b));
}

export async function ensureOpfsWorkspace(name: string): Promise<string> {
	const wanted = toWorkspaceName(name);
	await (await opfsRoot()).getDirectoryHandle(wanted, { create: true });
	return wanted;
}

export async function createOpfsWorkspace(displayName: string): Promise<string> {
	const preferred = toWorkspaceName(displayName);
	const taken = new Set((await listOpfsWorkspaces()).map(foldName));
	if (!taken.has(foldName(preferred))) return ensureOpfsWorkspace(preferred);
	for (let suffix = 2; suffix <= SUFFIX_ATTEMPTS; suffix += 1) {
		const candidate = suffixedWorkspaceName(preferred, suffix);
		if (!taken.has(foldName(candidate))) return ensureOpfsWorkspace(candidate);
	}
	throw new WorkspaceNameExhaustedError(preferred);
}

export async function deleteOpfsWorkspace(name: string): Promise<void> {
	await (await opfsRoot()).removeEntry(name, { recursive: true });
}

export const openOpfsWorkspace = (name: string): OpfsProjectStore => OpfsProjectStore.open(name);
