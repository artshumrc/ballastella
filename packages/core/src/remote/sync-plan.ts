import { ALIGNMENT_DIRECTORY } from '../alignment/alignment.js';
import { BASE_MAP_TILE_ROOT } from '../base-map/tile-cache.js';
import { IMAGE_DIRECTORY } from '../project/image-files.js';
import { topLevelSegment } from '../store/project-store.js';
import type { PathChoice, SourcePath } from './synchronization-planner.js';
import { REQUESTS_BEYOND_BLOBS } from './send-to-remote.js';
import type { RemoteSendPlan } from './send-to-remote.js';

export type SyncMode = 'get' | 'send' | 'both' | 'overwrite';

export interface Change {
	readonly kind: 'project' | 'map-image' | 'base-map';
	readonly id: string;
	readonly name: string;
	readonly files: number;
}

export interface SyncColumn {
	readonly added: readonly Change[];
	readonly changed: readonly Change[];
	readonly removed: readonly Change[];
}

export interface SyncPlan {
	readonly toGet: SyncColumn;
	readonly toSend: SyncColumn;
	readonly conflicts: readonly SourcePath[];
	readonly overwrites: readonly Change[];
	readonly budget: {
		readonly requests: number;
		readonly remaining: number | null;
		readonly resetsAt: Date | null;
	};
	readonly size: { readonly bytes: number; readonly files: number };
}

function owner(path: string): { kind: Change['kind']; id: string } {
	if (path.startsWith(BASE_MAP_TILE_ROOT)) return { kind: 'base-map', id: 'base-map' };
	if (path.startsWith(`${IMAGE_DIRECTORY}/`)) {
		return { kind: 'map-image', id: path.split('/')[1] ?? path };
	}
	if (path.startsWith(`${ALIGNMENT_DIRECTORY}/`)) {
		const file = path.slice(ALIGNMENT_DIRECTORY.length + 1);
		return { kind: 'map-image', id: file.replace(/\.json$/, '') };
	}
	return { kind: 'project', id: topLevelSegment(path) };
}

export function describeChanges(
	paths: Iterable<string>,
	names: ReadonlyMap<string, string> = new Map()
): readonly Change[] {
	const counted = new Map<string, { kind: Change['kind']; id: string; files: number }>();
	for (const path of paths) {
		const { kind, id } = owner(path);
		const key = `${kind}\u0000${id}`;
		const seen = counted.get(key);
		if (seen === undefined) counted.set(key, { kind, id, files: 1 });
		else seen.files += 1;
	}
	const order: Record<Change['kind'], number> = { 'map-image': 0, 'base-map': 1, project: 2 };
	return [...counted.values()]
		.sort((left, right) => order[left.kind] - order[right.kind] || (left.id < right.id ? -1 : 1))
		.map((entry) => ({
			kind: entry.kind,
			id: entry.id,
			name:
				entry.kind === 'base-map'
					? 'The Base Map’s offline tiles'
					: (names.get(entry.id) ?? entry.id),
			files: entry.files
		}));
}

const column = (
	choices: readonly PathChoice[],
	removed: Iterable<string>,
	names: ReadonlyMap<string, string>
): SyncColumn => ({
	added: describeChanges(
		choices.filter((choice) => choice.effect === 'add').map((choice) => choice.path),
		names
	),
	changed: describeChanges(
		choices.filter((choice) => choice.effect === 'replace').map((choice) => choice.path),
		names
	),
	removed: describeChanges(removed, names)
});

export function describeSyncPlan(
	upload: RemoteSendPlan,
	names: ReadonlyMap<string, string> = new Map()
): SyncPlan {
	const incoming = upload.incoming;
	return {
		toGet: column(
			incoming,
			incoming.filter((choice) => choice.effect === 'delete').map((choice) => choice.path),
			names
		),
		toSend: column(upload.outgoing, upload.removed, names),
		conflicts: upload.conflicts,
		overwrites: describeChanges(upload.overwrites, names),
		budget: {
			requests: upload.uploads + REQUESTS_BEYOND_BLOBS,
			remaining: upload.requestsRemaining,
			resetsAt: upload.requestsResetAt
		},
		size: { bytes: upload.uploadBytes, files: upload.uploads }
	};
}
