import type {
	AlignmentChoice,
	AlignmentQuestion,
	ProjectSummary,
	PublishedSite,
	PublishedSitePlan,
	RemoteRepository,
	RemoteSendPlan,
	RemoteSharing,
	SyncMode
} from '@ballastella/core';

import type { Remote, SyncForecast, SyncOutcome } from '../remote.svelte.js';
import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
import { ATLAS, emptyForecast } from './sync-dialog-forecast.js';

export class FakeSyncStorage {
	bound = $state<RemoteRepository | null>(ATLAS);
	signedIn = $state(true);
	readonly github = this;
	readonly remote = this;
	name = 'Atlas';
	session = $state({ projects: [] as ProjectSummary[] });
	forecast: RemoteSendPlan | Error = emptyForecast();
	plan: PublishedSitePlan | null = null;
	site: PublishedSite | null = null;
	canSend: boolean | null = true;
	questions: readonly AlignmentQuestion[] = [];
	sharing: RemoteSharing = { shared: false, known: true, owner: 'ada', others: [] };
	outcome: SyncOutcome | Error = { got: null, sent: null, baselineKept: true };
	readonly syncs: {
		mode: SyncMode;
		site: PublishedSitePlan | null | undefined;
		overwrite: readonly string[] | undefined;
		choices: [string, AlignmentChoice][];
	}[] = [];

	async planSync(): Promise<SyncForecast> {
		if (this.forecast instanceof Error) throw this.forecast;
		return {
			site: this.site,
			plan: this.plan,
			staleness: '',
			canSend: this.canSend,
			forecast: this.forecast,
			questions: this.questions
		};
	}

	async sync(mode: SyncMode, options: Parameters<Remote['sync']>[1] = {}): Promise<SyncOutcome> {
		this.syncs.push({
			mode,
			site: options.site,
			overwrite: options.overwrite,
			choices: [...(options.alignmentChoices ?? [])]
		});
		if (this.outcome instanceof Error) throw this.outcome;
		return this.outcome;
	}

	async readSharing(): Promise<RemoteSharing> {
		return this.sharing;
	}

	signOut(): void {}
}

export const asStorage = (fake: FakeSyncStorage): WorkspaceStorage =>
	fake as unknown as WorkspaceStorage;
