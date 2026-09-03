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

import { observedShareLinks } from '@ballastella/core';
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
	/** Which Projects each site write's plan named, so a plan made before a get can be told apart. */
	readonly siteProjectsWritten: string[][] = [];
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

	/** The Project list the site would carry, which is a reading of the Workspace at plan time. */
	async planPublishedSite(): Promise<PublishedSitePlan> {
		return { ...localPlan(), projects: [...this.projects] } as PublishedSitePlan;
	}

	async planRemoteSend(options: { sending?: boolean }): Promise<RemoteSendPlan> {
		this.forecasts.push({ sending: options.sending });
		if (this.forecast instanceof Error) throw this.forecast;
		return this.forecast;
	}

	async writePublishedSite(options: { plan: PublishedSitePlan }): Promise<PublishedSite | null> {
		this.siteWrites += 1;
		this.siteProjectsWritten.push(options.plan.projects.map((project) => project.directory));
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

	/** Whether this Workspace's own tree carries the site record (ADR-0045). */
	shareLinks = $state(false);
	/** Whether the last status check saw the Remote's tree carrying one. */
	remoteShareLinks = $state(false);
	/** Whether the author has asked for the site to come down and no Sync has carried it out yet. */
	withdrawing = $state(false);
	/** How many times a send answered the withdrawal request. */
	withdrawalsFinished = 0;
	rights: RemoteRights | Error = { canPush: true };
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

	/**
	 * The two-sided rule the real storage answers, over the same evidence and the same function
	 * (ADR-0045): this Workspace's own tree, what the last status check saw on the Remote's, and the
	 * recorded withdrawal.
	 */
	async hasShareLinks(): Promise<boolean> {
		return observedShareLinks({
			workspace: this.shareLinks,
			remote: this.remoteShareLinks,
			withdrawing: this.withdrawing
		});
	}

	async withdrawingShareLinks(): Promise<boolean> {
		return this.withdrawing;
	}

	async finishWithdrawal(): Promise<void> {
		this.withdrawalsFinished += 1;
	}

	async readRights(): Promise<RemoteRights> {
		if (this.rights instanceof Error) throw this.rights;
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
