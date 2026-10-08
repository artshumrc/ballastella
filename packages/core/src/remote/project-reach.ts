import type { LocalChanges } from './local-change-index.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

export interface ProjectRemoteReach {
	readonly synced: boolean;
	readonly unsent: boolean;
}

export function projectRemoteReach(input: {
	readonly directory: string;
	readonly baseline: SynchronizationBaseline | null;
	readonly changes: LocalChanges | null;
}): ProjectRemoteReach {
	const inside = `${input.directory}/`;
	const under = (path: string): boolean => path.startsWith(inside);
	const synced = [...(input.baseline?.files.keys() ?? [])].some(under);
	if (!synced) return { synced: false, unsent: true };
	if (input.changes === null) return { synced: true, unsent: true };
	return {
		synced: true,
		unsent: input.changes.written.some(under) || input.changes.deleted.some(under)
	};
}
