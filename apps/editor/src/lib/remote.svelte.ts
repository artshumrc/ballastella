import {
	PUBLISHED_SITE_RECORD_NAME,
	RemoteStatusChecker,
	RemoteStatusUnavailableError,
	UNCHECKED_REMOTE_STATUS,
	anonymousDetermination,
	awaitRemotePages,
	bindWorkspaceToRemote,
	checkSourceStatus,
	describeRemote,
	disableRemotePages,
	enableRemotePages,
	guidedPagesStep,
	messageOf,
	observedShareLinks,
	projectRemoteReach,
	projectShareUrl,
	publishedSiteStaleness,
	readContestedAlignments,
	readPublishedSite,
	readRemoteInventory,
	readRemotePages,
	readRemoteRights,
	readRemoteSharing,
	withdrawShareLinks,
	withdrawalNotRecordedMessage,
	type AlignmentChoice,
	type AlignmentQuestion,
	type InventoryEntry,
	type ProjectRemoteReach,
	type PublishedSite,
	type PublishedSitePlan,
	type RemoteBindOutcome,
	type RemotePagesOutcome,
	type RemotePagesWithdrawal,
	type RemoteReference,
	type RemoteRelationship,
	type RemoteRepository,
	type RemoteRights,
	type RemoteSendPlan,
	type RemoteSharing,
	type RemoteStatusObservation,
	type RemoteStatusState,
	type RemoteStatusTrigger,
	type SourceStatus,
	type SyncMode,
	type SynchronizationBaseline,
	type ViewerBundle,
	type WorkspaceUpdate
} from '@ballastella/core';

import { deploymentRoot } from './base-map/deployment-assets.js';
import type { EditorSession } from './editor-session.svelte.js';
import type { GitHubAccount } from './github-account.svelte.js';
import type { SyncProgress } from './sync/sync-progress.js';
import { loadViewerBundle, readBundleAsset } from './sync/viewer-bundle-source.js';

export interface SyncForecast {
	readonly site: PublishedSite | null;
	readonly plan: PublishedSitePlan | null;
	readonly staleness: string;
	readonly canSend: boolean | null;
	readonly forecast: RemoteSendPlan;
	readonly questions: readonly AlignmentQuestion[];
}

export interface SyncOutcome {
	readonly got: WorkspaceUpdate | null;
	readonly sent: {
		remote: string;
		files: number;
		uploaded: number;
		site: PublishedSite | null;
	} | null;
	readonly baselineKept: boolean;
}

export class SyncFailure extends Error {
	constructor(
		cause: unknown,
		readonly got: boolean,
		readonly written: boolean
	) {
		super(messageOf(cause), { cause });
	}
}

type RemoteHost = {
	readonly name: () => string;
	readonly github: GitHubAccount;
};

const nothingTo = (act: string): string => `has no repository, so there is nothing to ${act}.`;

export class Remote {
	bound = $state<RemoteRelationship | null>(null);
	baseline = $state<SynchronizationBaseline | null>(null);
	status = $state<RemoteStatusState>(UNCHECKED_REMOTE_STATUS);
	updateProgress = $state<{ files: number; totalFiles: number } | null>(null);
	updateNotice = $state('');
	readonly #session: EditorSession;
	readonly #host: RemoteHost;
	#checker: RemoteStatusChecker | null = null;

	constructor(session: EditorSession, host: RemoteHost) {
		this.#session = session;
		this.#host = host;
	}

	async load(): Promise<void> {
		await this.#follow((await this.#session.synchronization?.readRemote()) ?? null);
	}

	async #follow(remote: RemoteRelationship | null): Promise<void> {
		const metadata = this.#session.synchronization;
		this.bound = remote;
		this.baseline =
			remote === null || metadata === null ? null : await metadata.readBaseline(remote);
		this.#watch();
	}

	#watch(): void {
		this.close();
		this.status = UNCHECKED_REMOTE_STATUS;
		this.updateProgress = null;
		this.updateNotice = '';
		const remote = this.bound;
		if (remote === null) return;
		const github = this.#host.github;
		const checker = new RemoteStatusChecker({
			observe: (trigger) => {
				const mayRequest = trigger === 'explicit' || github.credential !== null;
				if (!mayRequest && this.baseline !== null) return null;
				return this.#observe(remote, github.credential, mayRequest);
			},
			now: () => Date.now(),
			onChange: (state) => {
				if (this.#checker === checker) this.status = state;
			}
		});
		this.#checker = checker;
		void checker.check('open');
	}

	async #observe(
		remote: RemoteRepository,
		token: string | null,
		mayRequest: boolean
	): Promise<RemoteStatusObservation> {
		const changes = this.#session.localChanges;
		const baseline = (await this.#session.synchronization?.readBaseline(remote)) ?? null;

		const determined = (
			status: SourceStatus,
			requested: boolean,
			found = { publishedSiteStale: [] as readonly string[], shareLinks: false }
		): RemoteStatusObservation => ({
			outcome: 'determined',
			status,
			publishedSiteStale: found.publishedSiteStale,
			shareLinks: found.shareLinks,
			requested
		});
		if (changes === null || baseline === null) return determined('cannot-tell', false);
		if (!mayRequest) return { outcome: 'not-attempted' };
		let listed: readonly InventoryEntry[];
		try {
			listed = await readRemoteInventory({ remote, token });
		} catch (cause) {
			const determination =
				token === null && cause instanceof RemoteStatusUnavailableError
					? anonymousDetermination(cause.refusal)
					: null;
			if (determination === null) throw cause;
			return determined(determination, true);
		}
		const found = await checkSourceStatus({ changes, remote: listed, baseline });
		return determined(found.status, true, found);
	}

	async check(trigger: RemoteStatusTrigger = 'explicit'): Promise<void> {
		await this.#checker?.check(trigger);
	}

	close(): void {
		this.#checker?.close();
		this.#checker = null;
	}

	async planSync(): Promise<SyncForecast> {
		const remote = this.#require(nothingTo('ask'));
		const token = this.#host.github.credential;
		const session = this.#session;
		const [bundle, carried, site, rights, withdrawing] = await Promise.all([
			loadViewerBundle(),
			this.hasShareLinks(),
			readPublishedSite(session.store),
			token === null ? { canPush: false } : this.readRights().catch(() => null),
			this.#withdrawing()
		]);
		const forecastFor = (plan: PublishedSitePlan | null) =>
			session.planRemoteSend({
				token,
				remote,
				pending: plan?.files ?? [],
				sending: rights?.canPush === true
			});
		let plan = carried ? await this.#planSite(bundle) : null;
		let forecast = await forecastFor(plan);
		if (!carried && !withdrawing && forecast.shareLinks) {
			plan = await this.#planSite(bundle);
			forecast = await forecastFor(plan);
		}
		const questions = await readContestedAlignments(session.store, {
			remote,
			commit: forecast.head,
			conflicts: forecast.conflicts
		});
		if (forecast.incoming.length > 0 || forecast.conflicts.length > 0) await this.check();
		return {
			site,
			plan,
			staleness:
				site === null || plan === null
					? ''
					: publishedSiteStaleness(site, {
							viewerVersion: bundle.version,
							projects: session.projects
						}),
			canSend: rights?.canPush ?? null,
			forecast,
			questions
		};
	}

	async sync(
		mode: SyncMode,
		options: {
			site?: PublishedSitePlan | null;
			overwrite?: readonly string[];
			alignmentChoices?: ReadonlyMap<string, AlignmentChoice>;
			onProgress?: (progress: SyncProgress) => void;
		} = {}
	): Promise<SyncOutcome> {
		const getting = mode === 'get' || mode === 'both';
		const remote = this.#require(nothingTo(getting ? 'get' : 'send to'));
		const session = this.#session;
		let got: WorkspaceUpdate | null = null;
		let written = false;
		try {
			if (getting) {
				this.updateNotice = '';
				this.updateProgress = { files: 0, totalFiles: 0 };
				const { update, baselineKept } = await session.updateFromRemote({
					remote,
					token: this.#host.github.credential,
					onProgress: (progress) => {
						this.updateProgress = progress;
						options.onProgress?.({ phase: 'getting', ...progress, requestsRemaining: null });
					},
					alignmentChoices: options.alignmentChoices
				});
				got = update;
				this.updateNotice = baselineKept
					? update.notice
					: `${update.notice} This browser would not keep a record of what the two of them now ` +
						`hold in common, so Ballastella cannot tell what has changed on either side until ` +
						`the next Sync.`;
				if (mode === 'get') return { got, sent: null, baselineKept: true };
			}
			const { token } = this.#signedIn(
				nothingTo('send to'),
				() =>
					`Nothing was sent, because you are not signed in to GitHub. The repository is exactly as ` +
					`it was.`
			);
			let plan =
				options.site === undefined ? await this.#siteToRebuild(token, remote) : options.site;
			if (plan !== null && got !== null) plan = await this.#planSite();
			const site =
				plan === null
					? null
					: await session.writePublishedSite({
							plan,
							readAsset: readBundleAsset,
							onProgress: (seen) =>
								options.onProgress?.({ phase: 'writing', ...seen, requestsRemaining: null })
						});
			written = plan !== null;
			const sent = await session.sendToRemote({
				token,
				remote,
				overwrite: mode === 'overwrite' ? (options.overwrite ?? []) : undefined,
				onProgress: (seen) => options.onProgress?.({ phase: 'sending', ...seen })
			});
			await session.synchronization?.clearWithdrawal();
			return {
				got,
				sent: {
					remote: describeRemote(remote),
					files: sent.plan.files.length,
					uploaded: sent.plan.uploads,
					site
				},
				baselineKept: sent.baselineKept
			};
		} catch (cause) {
			throw new SyncFailure(cause, got !== null, written);
		} finally {
			this.updateProgress = null;
			this.baseline = (await session.synchronization?.readBaseline(remote)) ?? null;
			await this.check();
		}
	}

	async bind(remote: RemoteReference, token: string | null): Promise<RemoteBindOutcome> {
		const github = this.#host.github;
		const outcome = await bindWorkspaceToRemote(this.#session.store, this.#host.name(), {
			token: token ?? github.credential,
			remote
		});
		if (token !== null) github.keepPasted(token);
		const binding = outcome.remote;
		const metadata = this.#session.synchronization;
		if (metadata !== null && !(await metadata.bindRemote(binding))) {
			throw new Error(
				`Ballastella reached ${describeRemote(binding)}, but this browser would not keep the ` +
					`record that “${this.#host.name()}” belongs to it, so the Workspace is not bound. Site ` +
					`data may be blocked for this site, or browser storage may be full.`
			);
		}
		await this.#follow(binding);
		return outcome;
	}

	async unbind(): Promise<void> {
		await this.#session.synchronization?.clearRemote();
		await this.#follow(null);
	}

	async hasShareLinks(): Promise<boolean> {
		return observedShareLinks({
			workspace: await this.#carriesPublishedSite(),
			remote: this.status.shareLinks,
			withdrawing: await this.#withdrawing()
		});
	}

	async #carriesPublishedSite(): Promise<boolean> {
		return this.#session.store.size(PUBLISHED_SITE_RECORD_NAME).then(
			() => true,
			() => false
		);
	}

	async #withdrawing(): Promise<boolean> {
		const remote = this.bound;
		if (remote === null) return false;
		return (await this.#session.synchronization?.readWithdrawal(remote)) ?? false;
	}

	async #siteToRebuild(token: string, remote: RemoteRepository): Promise<PublishedSitePlan | null> {
		if (await this.#withdrawing()) return null;
		const rebuilds =
			(await this.#carriesPublishedSite()) ||
			(await this.#session.planRemoteSend({ token, remote })).shareLinks;
		return rebuilds ? this.#planSite() : null;
	}

	async #planSite(bundle?: ViewerBundle): Promise<PublishedSitePlan> {
		return this.#session.planPublishedSite({
			bundle: bundle ?? (await loadViewerBundle()),
			editorUrl: deploymentRoot(),
			repository: this.bound
		});
	}

	async projectReach(directory: string): Promise<ProjectRemoteReach> {
		return projectRemoteReach({
			directory,
			baseline: this.baseline,
			changes: (await this.#session.localChanges?.localChanges()) ?? null
		});
	}

	projectShareLink(directory: string): string {
		return this.bound === null ? '' : projectShareUrl(this.bound, directory);
	}

	async enableShareLinks(): Promise<RemotePagesOutcome> {
		const { remote, token } = this.#shareLinksRequest('turn Share Links on for');

		await this.#session.synchronization?.clearWithdrawal();
		await this.#session.writePublishedSite({
			plan: await this.#planSite(),
			readAsset: readBundleAsset
		});

		return this.#host.github.pagesSetupByHand
			? guidedPagesStep(remote)
			: enableRemotePages({ token, remote });
	}

	async checkShareLinks(): Promise<RemotePagesOutcome> {
		return awaitRemotePages(this.#shareLinksRequest('check Share Links for'));
	}

	async verifyShareLinks(): Promise<string> {
		const request = this.#shareLinksRequest('share a Project from');
		return (await readRemotePages(request)) ? '' : guidedPagesStep(request.remote).instruction;
	}

	async withdrawShareLinks(): Promise<RemotePagesWithdrawal> {
		const { remote, token } = this.#shareLinksRequest('withdraw Share Links from');

		const requested = (await this.#session.synchronization?.requestWithdrawal(remote)) ?? false;
		await this.#session.flush();
		await withdrawShareLinks(this.#session.store);
		const withdrawal = await disableRemotePages({ token, remote });
		if (requested) return withdrawal;
		return {
			...withdrawal,
			notice:
				withdrawalNotRecordedMessage(remote) +
				(withdrawal.notice === '' ? '' : ` ${withdrawal.notice}`)
		};
	}

	#shareLinksRequest(act: string): { remote: RemoteRepository; token: string } {
		return this.#signedIn(
			`has no repository yet, so there is no site to ${act}.`,
			(remote) =>
				`Asking GitHub to ${act} ${remote} needs you to be signed in, and you are ` +
				`not. Sign in and press it again.`
		);
	}

	async readRights(): Promise<RemoteRights> {
		return readRemoteRights(
			this.#signedIn(
				nothingTo('ask'),
				(remote) =>
					`Whether you may push to ${remote} is something only GitHub can say, ` +
					`and asking needs you to be signed in.`
			)
		);
	}

	async readSharing(): Promise<RemoteSharing> {
		const request = this.#signedIn(
			nothingTo('ask'),
			(remote) =>
				`Whose ${remote} is can only be answered by GitHub, and asking needs you ` +
				`to be signed in.`
		);
		return readRemoteSharing({ ...request, identity: this.#host.github.identity });
	}

	async signIn(token: string): Promise<RemoteRights> {
		const remote = this.#require(
			'is not bound to a repository yet, so there is nothing to sign in to. Bind it to one first.'
		);
		const rights = await readRemoteRights({ token, remote });
		this.#host.github.keepPasted(token);
		return rights;
	}

	#require(unbound: string): RemoteRepository {
		if (this.bound === null) throw new Error(`“${this.#host.name()}” ${unbound}`);
		return this.bound;
	}

	#signedIn(
		unbound: string,
		signedOut: (remote: string) => string
	): { remote: RemoteRepository; token: string } {
		const remote = this.#require(unbound);
		const token = this.#host.github.credential;
		if (token === null) throw new Error(signedOut(describeRemote(remote)));
		return { remote, token };
	}
}
