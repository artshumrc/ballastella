// How far one Project's work has got towards the Remote, from local records alone.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS ASKS NO REQUEST, AND WHY IT NEED NOT
//
// Two questions are asked of a single Project: has any of it reached the Remote, and has anything
// happened to it here since. Both are claims about the *outbound* half, and the outbound half is
// answered entirely by what this machine holds — the Baseline says what the two sides last agreed
// and the local change index says what has been written here since (ADR-0038). Reaching GitHub
// would answer a different question, more slowly, and would put a request behind opening a settings
// dialog.
//
// ⚠ **Absent evidence is "not sent", never "sent".** A Workspace with no Baseline, or nothing
// keeping the change index, cannot show that its work has got anywhere; read the other way round it
// hands a colleague a link that quietly serves last week (ADR-0045).

import type { LocalChanges } from './local-change-index.js';
import type { SynchronizationBaseline } from './synchronization-metadata.js';

/** What a Project's own directory has, and has not, sent to the Remote. */
export interface ProjectRemoteReach {
	/** The last agreement recorded files inside this Project, so the Remote holds a version of it. */
	readonly synced: boolean;
	/** Work inside it that has not reached the Remote, including a Project that has never been sent. */
	readonly unsent: boolean;
}

export interface ProjectRemoteReachInput {
	/** The Project's folder, which is its identity (ADR-0008). */
	readonly directory: string;
	/** What the two sides last agreed, or `null` where nothing durable records an agreement. */
	readonly baseline: SynchronizationBaseline | null;
	/** What has been written or removed here since, or `null` where nothing tracked it. */
	readonly changes: LocalChanges | null;
}

export function projectRemoteReach(input: ProjectRemoteReachInput): ProjectRemoteReach {
	// The separator is part of the prefix, or `amsterdam` claims every file of `amsterdam-1625`.
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
