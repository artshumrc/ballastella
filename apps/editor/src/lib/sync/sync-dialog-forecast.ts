/**
 * The values a Sync-modal spec varies: a forecast, a local plan, and a planned file.
 *
 * A plain module rather than the `.svelte.ts` fake beside it, because none of this is reactive
 * state — and `svelte/prefer-svelte-reactivity` reads a `Map` or a `Date` in a `.svelte.ts` as one.
 */

import type {
	PendingLocalFile,
	PublishedSitePlan,
	RemoteSendPlan,
	RemoteRepository
} from '@ballastella/core';

export const ATLAS: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };

/** A forecast with nothing in either direction, which every case starts from and varies. */
export function emptyForecast(over: Partial<RemoteSendPlan> = {}): RemoteSendPlan {
	return {
		head: 'c0ffee',
		files: [],
		pending: [],
		preserved: [],
		retained: [],
		leftAlone: [],
		incoming: [],
		outgoing: [],
		conflicts: [],
		unchanged: true,
		source: new Map(),
		removed: [],
		overwrites: [],
		overwriteSource: new Map(),
		uploads: 0,
		uploadBytes: 0,
		workspace: { files: 0, bytes: 0 },
		bytes: 0,
		requestsRemaining: 4800,
		requestsResetAt: new Date('2026-09-02T11:00:00Z'),
		warnings: [],
		...over
	};
}

/** One local source path with a stable blob SHA, for a forecast a test wants to be about a file. */
export const at = (path: string, sha = 'a'.repeat(40)) => ({
	path,
	sha,
	bytes: 12,
	onRemote: false,
	authored: false
});

/** What `planPublishedSite` answers: enough of a local plan for the Share Links half to be exercised. */
export const localPlan = (files: readonly PendingLocalFile[] = []): PublishedSitePlan =>
	({
		files,
		bytes: files.reduce((total, file) => total + file.bytes, 0),
		projects: [],
		mapImages: { files: 0, bytes: 0 },
		warnings: [],
		baseMapBundled: false,
		baseMapAssetsBundled: false
	}) as unknown as PublishedSitePlan;
