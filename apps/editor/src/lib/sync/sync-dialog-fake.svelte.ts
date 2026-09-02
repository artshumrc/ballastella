/**
 * The members of `WorkspaceStorage` and `EditorSession` the Sync modal reads, as a reactive fake.
 *
 * A `.svelte.ts` module rather than a plain one because the modal's whole contract is that what it
 * shows is *derived* from what it found: `remote`, `signedIn` and the projects have to be signals so
 * that an assertion about the modal reacting to a Sync is not an assertion about a fake that cannot
 * move. The real classes are thousands of lines over OPFS, IndexedDB and GitHub, so they are not
 * what a component seam should be standing up. The values a spec *varies* are next door, in
 * `sync-dialog-forecast.ts`.
 *
 * ⚠ **Every method records what it was asked and nothing here reaches GitHub.** What the four modes
 * do to a repository is Seam 1's, against the shared fake GitHub; what this seam answers is what a
 * reader sees and which mode a press asks for.
 */

import type {
	ProjectSummary,
	PublishedSitePlan,
	PublishedSite,
	RemoteSendPlan,
	RemoteRepository,
	RemoteRights,
	RemoteSharing,
	SynchronizationBaseline,
	WorkspaceUpdate,
	AlignmentChoice,
	AlignmentQuestion
} from '@ballastella/core';

import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
import { ATLAS, emptyForecast, localPlan } from './sync-dialog-forecast.js';

export class FakeSession {
	projects = $state<ProjectSummary[]>([]);
	/** What the Workspace's own site record says, or `null` for a Workspace with no site. */
	siteRecord: PublishedSite | null = null;
	forecast: RemoteSendPlan | Error = emptyForecast();
	/** What each `planRemoteSend` was asked, so the read-only path can be told from the ordinary. */
	readonly forecasts: { sending: boolean | undefined }[] = [];
	/** What each `sendToRemote` was asked, which is where the mode a press means is asserted. */
	readonly sends: { overwrite: readonly string[] | undefined }[] = [];
	/** How many times the viewer was written into the Workspace. */
	siteWrites = 0;
	sendAnswer: Error | null = null;
	synchronization = { readBaseline: async () => null };
	/** The Alignment questions the plan raises, which a spec sets to exercise the one question. */
	alignmentQuestions: readonly AlignmentQuestion[] = [];

	async readAlignmentQuestions(): Promise<readonly AlignmentQuestion[]> {
		return this.alignmentQuestions;
	}

	async readPublishedSite(): Promise<PublishedSite | null> {
		return this.siteRecord;
	}

	async planPublishedSite(): Promise<PublishedSitePlan> {
		return localPlan();
	}

	async planRemoteSend(options: { sending?: boolean }): Promise<RemoteSendPlan> {
		this.forecasts.push({ sending: options.sending });
		if (this.forecast instanceof Error) throw this.forecast;
		return this.forecast;
	}

	async writePublishedSite(): Promise<PublishedSite | null> {
		this.siteWrites += 1;
		return this.siteRecord;
	}

	async sendToRemote(options: { overwrite?: readonly string[] }): Promise<{
		commit: string;
		plan: RemoteSendPlan;
		baselineKept: boolean;
	}> {
		this.sends.push({ overwrite: options.overwrite });
		if (this.sendAnswer !== null) throw this.sendAnswer;
		return {
			commit: 'newc0mmit',
			plan: this.forecast instanceof Error ? emptyForecast() : this.forecast,
			baselineKept: true
		};
	}
}

export class FakeSyncStorage {
	remote = $state<RemoteRepository | null>(ATLAS);
	signedIn = $state(true);
	credential = $state<string | null>('a-credential-this-component-never-renders');
	baseline = $state<SynchronizationBaseline | null>(null);
	name = 'Atlas';
	session = $state(new FakeSession());

	/** Whether the Workspace carries the viewer file set, which is what Share Links are (ADR-0045). */
	shareLinks = $state(false);
	rights: RemoteRights = { canPush: true };
	sharing: RemoteSharing = { shared: false, known: true, owner: 'ada', others: [] };
	/** What `getFromRemote` answers, or an error it throws. */
	getAnswer: WorkspaceUpdate | Error = {
		added: ['a'],
		replaced: [],
		removed: []
	} as unknown as WorkspaceUpdate;

	/** Every mode a press asked for, in order. */
	readonly gets: number[] = [];
	/** What each get was told about the contested Alignments, so the answer can be asserted. */
	readonly getChoices: (ReadonlyMap<string, AlignmentChoice> | undefined)[] = [];
	checks = 0;
	signOuts = 0;

	async hasShareLinks(): Promise<boolean> {
		return this.shareLinks;
	}

	async readRights(): Promise<RemoteRights> {
		return this.rights;
	}

	async readSharing(): Promise<RemoteSharing> {
		return this.sharing;
	}

	async checkRemoteStatus(): Promise<void> {
		this.checks += 1;
	}

	async getFromRemote(
		options: { alignmentChoices?: ReadonlyMap<string, AlignmentChoice> } = {}
	): Promise<WorkspaceUpdate> {
		this.gets.push(this.gets.length);
		this.getChoices.push(options.alignmentChoices);
		if (this.getAnswer instanceof Error) throw this.getAnswer;
		return this.getAnswer;
	}

	signOut(): void {
		this.signOuts += 1;
	}
}

/** The fake, as the component's prop type. The cast is the seam and is asserted nowhere else. */
export const asStorage = (fake: FakeSyncStorage): WorkspaceStorage =>
	fake as unknown as WorkspaceStorage;
