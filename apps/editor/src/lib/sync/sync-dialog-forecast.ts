import type {
	PendingLocalFile,
	PublishedSitePlan,
	RemoteSendPlan,
	RemoteRepository
} from '@ballastella/core';

export const ATLAS: RemoteRepository = { owner: 'ada', repository: 'atlas', branch: 'main' };

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
		shareLinks: false,
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

export const at = (path: string, sha = 'a'.repeat(40)) => ({
	path,
	sha,
	bytes: 12,
	onRemote: false,
	authored: false
});

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
