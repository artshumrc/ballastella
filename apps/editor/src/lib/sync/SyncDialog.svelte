<script lang="ts">
	// Sync: one control, one modal, four choices (ADR-0044).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// PRESSING SYNC MOVES NOTHING
	//
	// It reads both sides and opens on what it found: a **To get** column and a **To send** column,
	// each naming the Projects and Map Images that would move, each with a headed **Removals** line
	// naming exactly what would disappear from that side. Then four choices — get, send, both, or
	// overwrite the repository. A deletion discovered *after* a press is the failure this shape
	// exists to prevent, which is why there is no second confirmation anywhere: the inbound deletion
	// preview and the outbound one both folded into this screen.
	//
	// ⚠ **Both columns come from one plan and one tree listing**, so they cannot disagree about which
	// side a difference is on. That disagreement is what made two separate gestures unsafe.
	//
	// `<dialog>` + `showModal()` through `ModalDialog` is mandated (ADR-0016), which is what brings
	// Escape, the focus trap, and focus restoration.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE DECISIONS THIS FILE IS MADE OF, EVERY ONE ARRIVED AT FROM A REAL DEFECT
	//
	//   1. The plan is computed **on open** rather than once. A Workspace's byte total and its Project
	//      list both change while the app is running, and a plan computed at startup would state a
	//      size that is no longer true at the one moment where the number is the whole point.
	//   2. Progress is announced from **inside** the modal and the result from outside it after a
	//      `tick()`. `showModal()` makes the rest of the document inert, and an inert `aria-live`
	//      region is not a quiet one: it is not announced at all.
	//   3. The actions are never `disabled` and stay in the tab order while a Sync runs.
	//      `aria-disabled` and a guard preserve focus — a `disabled` button leaves the tab order the
	//      instant it is pressed, dropping the keyboard user who pressed it (WCAG 2.4.3).
	//   4. **Where the author cannot write, the send affordances are absent rather than
	//      present-and-refusing.** The rights are read live, because write access is somebody else's
	//      to grant and to take away, and the plan is still made — a read-only collaborator is owed
	//      the *To get* column, and refusing to compare the two sides would leave them looking at
	//      nothing.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// TWO TRANSACTIONS, NOT ONE
	//
	// `get` keeps the inbound crash-recovery protocol; `send` keeps the single-commit property.
	// `both` runs get and then send, and a failure in the first leaves the second unattempted — so
	// the author is never told a Sync half happened without being told which half.

	import { tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';

	import {
		MAX_SENT_FILES,
		RemoteSendCredentialError,
		STATIC_HOSTING_LIMIT_BYTES,
		describeBytes,
		describeOutboundRemovals,
		describeChanges,
		describeRemote,
		describeSyncPlan,
		describeTokenProblem,
		publishedSiteStaleness,
		type AlignmentChoice,
		type AlignmentQuestion,
		type Change,
		type OutboundDeletionPreview,
		type ProjectSummary,
		type PublishedSitePlan,
		type PublishedSite,
		type RemoteSendPlan,
		type SyncColumn,
		type SyncMode,
		type SyncPlan
	} from '@ballastella/core';

	import { deploymentRoot } from '../base-map/deployment-assets';
	import ModalDialog from '../components/ModalDialog.svelte';
	import { connectSequence } from '../connect-sequence.svelte.js';
	import { workspaceSettings } from '../workspace-settings.svelte.js';
	import type { EditorSession } from '../editor-session.svelte.js';
	import Toast from '../toasts/Toast.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
	import { describeSyncProgress, type SyncProgress } from './sync-progress.js';
	import { loadViewerBundle, readBundleAsset } from './viewer-bundle-source';

	let {
		storage,
		open = $bindable(false),
		// Both bindable so the navigation bar's one GitHub control can be `aria-disabled` with a label
		// that reflects progress while the modal that owns the run is on screen.
		syncing = $bindable(false),
		progress = $bindable<SyncProgress | null>(null),
		restoreFocusTo
	}: {
		storage: WorkspaceStorage;
		open?: boolean;
		syncing?: boolean;
		progress?: SyncProgress | null;
		/** Where focus goes when this closes, if the control that opened it has gone. */
		restoreFocusTo?: () => HTMLElement | null | undefined;
	} = $props();

	const session = $derived(storage.session);
	/** The repository this Workspace syncs with, or `null` when it belongs to none. */
	const remote = $derived(storage.remote);
	/**
	 * Whether a credential is held.
	 *
	 * Read from `WorkspaceStorage`, which mirrors the sealed credential store — so this is `false`
	 * inside a Review Workspace because the seal holds, rather than because a condition here
	 * remembered to ask (ADR-0024).
	 */
	const signedIn = $derived(storage.signedIn);

	/** What a send would write into the Workspace first, for a Workspace with Share Links. */
	let plan = $state<PublishedSitePlan | null>(null);
	/** The record this Workspace's own Published Site carries, or `null` before there is one. */
	let site = $state<PublishedSite | null>(null);
	/** The forecast both columns are read from, or `null` before GitHub has been asked. */
	let upload = $state<RemoteSendPlan | null>(null);
	/** Why the two sides could not be compared: a truncated tree, an expired sign-in. */
	let problem = $state('');
	/**
	 * Whether this account may write to the repository, or `null` while nobody has asked.
	 *
	 * ⚠ **Read live and never remembered** (ADR-0044). Write access is somebody else's to grant and
	 * to take away, and the state this decides — send affordances absent rather than refusing — is
	 * exactly the one a remembered answer gets wrong.
	 */
	let canSend = $state<boolean | null>(null);
	/**
	 * Whether this Workspace has Share Links, or `null` while nobody has looked (ADR-0045).
	 *
	 * ⚠ **It decides whether the Published Site is written at all.** Without Share Links a Sync carries the
	 * scholar's own files and nothing else, and writing the viewer into the Workspace anyway would be
	 * the very thing that gave them Share Links — the answer is the files' presence, so writing them
	 * *is* asking for a site.
	 */
	let shareLinks = $state<boolean | null>(null);
	/**
	 * Whether the author has answered the shared-Remote question and may overwrite (ADR-0044).
	 *
	 * ⚠ **Cleared by every re-plan, deliberately**: a decision taken about one set of files is not a
	 * decision about the set a later listing found.
	 */
	let overwriteAgreed = $state(false);
	/** What an overwrite would take off a **shared** Remote, while it waits to be answered. */
	let outbound = $state<OutboundDeletionPreview | null>(null);
	/** Whether GitHub is being asked whose the repository is, so a second press is not a second ask. */
	let askingSharing = $state(false);
	/**
	 * The contested Alignments, each with both sides' Control Point counts and dates (ADR-0046).
	 *
	 * ⚠ **A question rather than a copy, because there is exactly one Alignment per Map Image**
	 * (ADR-0023): a second file would be referenced by nothing and drawn nowhere, and a copy the
	 * scholar cannot look at is worse than being asked.
	 */
	let alignmentQuestions = $state<readonly AlignmentQuestion[]>([]);
	/** What the author has answered so far, by Alignment path. Unanswered ones stop nothing. */
	const alignmentChoices = new SvelteMap<string, AlignmentChoice>();
	/** Why the Sync stopped, or why there is nothing to do. */
	let failure = $state('');
	/** The Project state the current forecast was built from. */
	let plannedProjectKey = '';
	/** Which mode is running, or `null`. */
	let running = $state<SyncMode | null>(null);
	/** The credential being pasted, for a Workspace that is connected and not signed in. */
	let token = $state('');
	let signingIn = $state(false);
	/**
	 * What the sign-in found out about pushing, when the answer was that it cannot.
	 *
	 * A notice rather than a refusal: the credential works, every request the forecast makes is a
	 * GET, and the 403 arrives at the first blob. `signIn` reads the rights for exactly this reason,
	 * and throwing the answer away is how a `Contents: Read` token gets four thousand tiles into a
	 * send before saying anything.
	 */
	let rightsNotice = $state('');
	/** A hydration-stable id for the credential field, for the reason `NavigationBar` documents. */
	const tokenId = $props.id();

	/** What happened, once it has. Announced, and it stays on screen after the modal closes. */
	let done = $state<{
		got: { added: number; replaced: number; removed: number } | null;
		sent: { remote: string; files: number; uploaded: number; site: PublishedSite | null } | null;
		/** Whether this machine kept its Synchronization Baseline for the Remote (ADR-0033). */
		baselineKept: boolean;
	} | null>(null);

	/** The record the Workspace's own Published Site carries, and whether it is behind. */
	let staleness = $state('');

	const messageOf = (cause: unknown): string =>
		cause instanceof Error ? cause.message : String(cause);

	const count = (many: number, thing: string): string => `${many} ${thing}${many === 1 ? '' : 's'}`;

	/** A date a person reads, in their own locale. */
	const describeWhen = (at: Date): string =>
		at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	const projectStateKey = (projects: readonly ProjectSummary[]): string =>
		projects
			.map(
				(project) =>
					`${project.directory}\u0000${project.name}\u0000${project.onFrontPage}\u0000${project.problem}`
			)
			.join('\u0001');

	/** Everything the opening pass is about to answer for itself, cleared before it runs. */
	const forget = () => {
		plan = null;
		site = null;
		shareLinks = null;
		canSend = null;
		upload = null;
		problem = '';
		// A decision taken about one set of files is not a decision about the set a later listing
		// found, so the shared-Remote answer goes with the plan it was given about.
		overwriteAgreed = false;
		outbound = null;
		askingSharing = false;
		progress = null;
		rightsNotice = '';
		alignmentQuestions = [];
		// A decision about one pair of Alignments is not a decision about the pair a later listing
		// found, for the same reason the shared-Remote answer goes with its plan.
		alignmentChoices.clear();
	};

	const reset = () => {
		forget();
		failure = '';
		done = null;
	};

	/**
	 * Which session the modal on screen was planned for, or `null` while it is closed.
	 *
	 * ⚠ **A plain `let`, and the reason is the whole of why this guard exists.** The effect below
	 * writes `plan`, `progress` and `problem`, and `progress` is a `$bindable`: the parent's binding
	 * writes it straight back through this component's props, which is where the effect reads `open`
	 * from. So an ungated effect re-runs itself through the round trip. Reading a `$state` here would
	 * put the guard inside the loop it exists to break.
	 */
	let plannedFor: EditorSession | null = null;

	/**
	 * Which session the result, the staleness notice and the standing refusal are statements about.
	 *
	 * They render **outside** the modal and outlive it, on a navigation bar that is mounted on every
	 * screen — so unlike everything `reset` covers, closing is not what makes them stale. Switching
	 * Workspace is.
	 */
	let shownFor: EditorSession | null = null;

	/**
	 * Which planning run may still write, so a run overtaken by another lands nowhere.
	 *
	 * The same `#generation` shape `EditorSession` opens Projects with, and needed for the same
	 * reason: this is three awaits deep and the Workspace can be switched with the modal open.
	 */
	let planning = 0;

	$effect(() => {
		const active = session;
		if (shownFor !== active) {
			shownFor = active;
			done = null;
			staleness = '';
			failure = '';
			problem = '';
			rightsNotice = '';
		}
		if (!open) {
			plannedFor = null;
			plannedProjectKey = '';
			return;
		}
		const currentProjectKey = projectStateKey(active.projects);
		if (plannedFor === active && plannedProjectKey === currentProjectKey) return;
		plannedFor = active;
		plannedProjectKey = currentProjectKey;
		reset();
		token = '';
		void readBothSides(active, ++planning);
	});

	/**
	 * Read both sides and work out what a Sync would do — one listing, both columns.
	 *
	 * ⚠ **The rights first, because they decide whether a plan may even be made in order to send.**
	 * A read-only collaborator's plan is made with `sending: false`, which skips the push check the
	 * engine would otherwise refuse on — so their *To get* column exists rather than being replaced
	 * by a refusal about a button they are not being offered.
	 *
	 * ⚠ **A 401 here is the stale sign-in.** Rights are read when a Remote is bound and when a token
	 * is pasted, at no other moment — so the bar's "Signed in to GitHub" means *a credential is
	 * held*, never *a credential still works*. This is the first credentialed request a Sync makes
	 * and it posts nothing at all, so an expired token is met on opening the modal, with the Remote
	 * untouched, and never after four thousand tiles have gone.
	 */
	async function readBothSides(active: EditorSession, mine: number): Promise<void> {
		const bound = storage.remote;
		// ⚠ **`null` is a plan read anonymously, and it is not a reason to read nothing** (ADR-0044).
		// A public repository is readable by anyone, so a signed-out author gets a *To get* column and
		// the three affordances that send are simply not on the screen — which is the whole of how a
		// student with no GitHub account gets their instructor's Workspace.
		const credential = storage.credential;
		if (bound === null) return;
		try {
			const [bundle, hasSite, record, rights, withdrawing] = await Promise.all([
				loadViewerBundle(),
				storage.hasShareLinks(),
				active.readPublishedSite(),
				// A question GitHub would not answer is read as *cannot write*, which is the direction
				// that offers a control that can only refuse to nobody. Signed out it is not asked at
				// all: rights cannot be read without a credential, and nothing here may claim them.
				credential === null
					? Promise.resolve({ canPush: false })
					: storage.readRights().catch(() => ({ canPush: false })),
				storage.withdrawingShareLinks()
			]);
			const sitePlan = (): Promise<PublishedSitePlan> =>
				active.planPublishedSite({ bundle, editorUrl: deploymentRoot(), repository: bound });
			// The viewer is only pending where there is a site to keep current, so the three budgets are
			// about the Sync being offered rather than about one that is not going to happen.
			let local = hasSite ? await sitePlan() : null;
			let forecast = await active.planRemoteSend({
				token: credential,
				remote: bound,
				pending: local?.files ?? [],
				sending: rights.canPush
			});
			// ⚠ **The Remote's own site counts, and learning of it costs the one extra listing here.**
			// A Workspace got from a Remote that has Share Links carries no viewer files, so the local
			// answer above is *no site* and the send that followed removed the Remote's — a live site
			// taken down with every link handed out. Re-planned rather than patched, because the three
			// budgets have to be about the Sync being offered: the viewer is thousands of files and
			// megabytes, and a forecast quoting the numbers without it is wrong in the direction that
			// ends at a rate limit part way through.
			if (!hasSite && !withdrawing && forecast.shareLinks) {
				local = await sitePlan();
				forecast = await active.planRemoteSend({
					token: credential,
					remote: bound,
					pending: local.files,
					sending: rights.canPush
				});
			}
			if (mine !== planning) return;
			// ⚠ **The only bytes a forecast downloads**, and only where a Map Image's Alignment is
			// contested: the question cannot be answered without both sides' Control Point counts.
			const questions = await active.readAlignmentQuestions({
				remote: bound,
				commit: forecast.head,
				conflicts: forecast.conflicts
			});
			if (mine !== planning) return;
			alignmentQuestions = questions;
			// What a send will *do* about a site, which is not the same as what this Workspace holds:
			// a withdrawal removes the Remote's copy and writes nothing, and a Workspace got from a
			// Remote that has one writes the viewer it does not yet carry.
			shareLinks = local !== null;
			site = record;
			plan = local;
			canSend = rights.canPush;
			upload = forecast;
			staleness =
				record === null || local === null
					? ''
					: publishedSiteStaleness(record, {
							viewerVersion: bundle.version,
							projects: active.projects
						});
			// ⚠ **The bar has to agree with what this just found.** The forecast has listed the tree; a
			// status control still reading `Up to date` beside a modal saying the Remote has moved is
			// the disagreement ADR-0044 exists to remove.
			if (forecast.incoming.length > 0 || forecast.conflicts.length > 0) {
				await storage.checkRemoteStatus();
			}
		} catch (cause) {
			// Outside the guard: the credential is dead whichever run found that out, and leaving it in
			// place would put the next Sync's discovery of it after the upload has started.
			if (cause instanceof RemoteSendCredentialError) storage.signOut();
			if (mine !== planning) return;
			problem = messageOf(cause);
		}
	}

	/** Both columns and the budgets, in the terms the author reads them in. */
	const sync = $derived<SyncPlan | null>(
		upload === null
			? null
			: describeSyncPlan(
					upload,
					new Map(session.projects.map((project) => [project.directory, project.name]))
				)
	);

	const anythingIn = (column: SyncColumn): boolean =>
		column.added.length + column.changed.length + column.removed.length > 0;

	/**
	 * Whether the Published Site in this Workspace already says exactly what a send would write.
	 *
	 * Staleness covers the viewer's version and every Project fact the record carries (ADR-0045); the
	 * two Base Map flags are the rest of it, and they are read off the plan so the comparison
	 * describes the files this send will actually write.
	 */
	const siteIsCurrent = $derived(
		// A Workspace with no Share Links has no site to be behind (ADR-0045).
		shareLinks === false ||
			(site !== null &&
				plan !== null &&
				staleness === '' &&
				site.baseMapBundled === plan.baseMapBundled &&
				site.baseMapAssetsBundled === plan.baseMapAssetsBundled)
	);

	const somethingToGet = $derived(sync !== null && anythingIn(sync.toGet));
	/**
	 * Whether sending would change the repository.
	 *
	 * ⚠ **Read from {@link RemoteSendPlan.unchanged} rather than from the *To send* column**, and
	 * the two are not the same question. The column is the scholar's own work — Projects and Map
	 * Images — and a Workspace with Share Links also sends a viewer, a site record and a `.nojekyll`,
	 * none of which is source and none of which appears in a column. A Workspace whose Projects
	 * already agree with the repository but whose *site* has never reached it has an empty column and
	 * a great deal to send.
	 */
	const somethingToSend = $derived(
		upload !== null && (!upload.unchanged || (shareLinks === true && !siteIsCurrent))
	);

	/** Whether the two sides agree, so pressing anything would change nothing anywhere. */
	const nothingToDo = $derived(
		sync !== null && !somethingToGet && !somethingToSend && sync.conflicts.length === 0
	);

	/** Whether getting would resolve a Conflict, which is a reason to get with nothing else to get. */
	const somethingToResolve = $derived(sync !== null && sync.conflicts.length > 0);

	/**
	 * The Conflicts the plan found, named rather than listed as paths.
	 *
	 * `SyncPlan.conflicts` carries paths because the *engine* reasons about paths; nothing on this
	 * screen shows one.
	 */
	const contested = $derived<readonly Change[]>(
		sync === null
			? []
			: describeChanges(
					sync.conflicts.map((row) => row.path),
					new Map(session.projects.map((project) => [project.directory, project.name]))
				)
	);

	/**
	 * Whose the repository is decides how many presses an overwrite takes, and the reading is live.
	 *
	 * A collaborator arrives between two visits, so a remembered *solo* is the answer that deletes
	 * their afternoon with nothing said. Where the Remote is the author's alone this arms in one
	 * press; where it is not, the removal list goes on screen as a question first.
	 *
	 * A question GitHub would not answer is treated as *shared*, for `shared-remote.ts`'s reason.
	 */
	const askToOverwrite = async () => {
		const forecast = upload;
		const bound = storage.remote;
		if (
			askingSharing ||
			overwriteAgreed ||
			outbound !== null ||
			forecast === null ||
			bound === null
		) {
			return;
		}
		askingSharing = true;
		try {
			const sharing = await storage.readSharing().catch(() => ({
				shared: true,
				known: false,
				owner: bound.owner,
				others: []
			}));
			if (!sharing.shared) {
				overwriteAgreed = true;
				return;
			}
			outbound = describeOutboundRemovals({
				remote: bound,
				sharing,
				removed: forecast.overwrites,
				source: forecast.overwriteSource.keys()
			});
		} finally {
			askingSharing = false;
		}
	};

	/**
	 * Carry out one of the four choices.
	 *
	 * ⚠ **`both` is two transactions in order, and a failure in the first leaves the second
	 * unattempted.** Getting keeps the inbound crash-recovery protocol and sending keeps the
	 * single-commit property; folded into one they would have neither.
	 */
	const run = async (mode: SyncMode) => {
		if (syncing || remote === null) return;
		// ⚠ **Getting is the one mode a signed-out author may run** (ADR-0044): it reads a public
		// repository anonymously and writes only this computer. Everything else writes to GitHub.
		if (mode !== 'get' && (!signedIn || canSend !== true)) return;
		if (mode === 'overwrite' && !overwriteAgreed) return;
		running = mode;
		syncing = true;
		failure = '';
		let got: { added: number; replaced: number; removed: number } | null = null;
		let sent: {
			remote: string;
			files: number;
			uploaded: number;
			site: PublishedSite | null;
		} | null = null;
		let baselineKept = true;
		/**
		 * What the site would carry, read before the get and remade after one.
		 *
		 * ⚠ **Held here rather than read off the render at the moment of the write** (ADR-0045). A get
		 * changes the Project list, the effect above re-plans the moment it does, and the re-plan
		 * clears `plan` — so a `both` that brought a Project in reached the write with nothing to
		 * write and skipped the site entirely.
		 */
		const wantsSite = shareLinks === true;
		let sitePlan = plan;
		/** Whether the viewer reached the Workspace, so a later refusal does not deny it. */
		let written = false;
		try {
			if (mode === 'get' || mode === 'both') {
				const inbound = await storage.getFromRemote({
					onProgress: (seen) => {
						progress = { phase: 'getting', ...seen, requestsRemaining: null };
					},
					alignmentChoices
				});
				got = {
					added: inbound.added.length,
					replaced: inbound.replaced.length,
					removed: inbound.removed.length
				};
			}
			if (mode !== 'get') {
				// ⚠ **The Published Site is not written at all for a Workspace with no Share Links**
				// (ADR-0045). A repository holds the work until an author asks for a site, and since
				// having Share Links *is* carrying the viewer file set, writing it here would grant them
				// — silently, on a press about GitHub.
				let site: PublishedSite | null = null;
				if (wantsSite && got !== null) {
					// ⚠ **Re-planned after a get, never the plan the columns were drawn from** (Story 63).
					// The site record names every Project the Workspace holds, so a record written from
					// the plan made before the get leaves out whatever the get just brought in — and the
					// send that follows puts that record over the one the other machine wrote, taking a
					// Project off the front page on the very Sync that fetched it.
					sitePlan = await session.planPublishedSite({
						bundle: await loadViewerBundle(),
						editorUrl: deploymentRoot(),
						repository: remote
					});
				}
				if (wantsSite && sitePlan !== null) {
					site = await session.writePublishedSite({
						plan: sitePlan,
						readAsset: readBundleAsset,
						onProgress: (seen) => {
							progress = { phase: 'writing', ...seen, requestsRemaining: null };
						}
					});
					written = true;
				}
				const uploaded = await sendToRemote(mode === 'overwrite');
				sent = { ...uploaded, site };
				baselineKept = uploaded.baselineKept;
			}
			// Closed, and the close applied, *before* the result is set — decision 2 in the header.
			staleness = '';
			open = false;
			await tick();
			done = { got, sent, baselineKept };
		} catch (cause) {
			if (cause instanceof RemoteSendCredentialError) storage.signOut();
			// ⚠ **A refusal after the viewer has been written must not imply nothing happened.** Core's
			// upload refusals all say "nothing on your Published Site has changed", which is true and is
			// about the repository — while the Workspace in front of the author has just gained a
			// website. Left unsaid, a scholar re-reads it as "nothing at all happened" and cannot
			// account for the files.
			failure =
				messageOf(cause) +
				(got === null
					? ''
					: ` What GitHub had was brought in first and is still here; nothing has been sent.`) +
				(written
					? ` The website itself was written into this Workspace, so syncing again sends it ` +
						`without doing that work twice.`
					: '');
		} finally {
			running = null;
			syncing = false;
			progress = null;
			// Whatever happened, the Remote or this machine's evidence about it has moved. Re-read the
			// Baseline rather than assume it — a refused `writeBaseline` discards the stale record, so
			// the honest answer afterwards is the `null` this finds — and then recompute.
			const bound = storage.remote;
			if (bound !== null) {
				storage.baseline = (await session.synchronization?.readBaseline(bound)) ?? null;
				await storage.checkRemoteStatus();
			}
			if (open) {
				// Still on screen because the Sync refused: re-read both sides, so the columns describe
				// the two of them as they are now rather than as they were before the attempt. The
				// refusal itself stays — it is the one thing on screen the author has to act on.
				forget();
				void readBothSides(session, ++planning);
			}
		}
	};

	/**
	 * The upload half of a send: the bytes, and what this installation then believes.
	 *
	 * The local site write is the caller's, because whether it ran is what a refusal afterwards has to
	 * be able to say out loud.
	 */
	async function sendToRemote(overwriting: boolean): Promise<{
		remote: string;
		files: number;
		uploaded: number;
		baselineKept: boolean;
	}> {
		// The Remote and the credential are read again here rather than taken from the render: a send
		// of a large Workspace runs for minutes, and a sign-out during one must not be answered by
		// uploading anyway.
		const bound = storage.remote;
		const credential = storage.credential;
		if (bound === null || credential === null) {
			throw new Error(
				`Nothing was sent, because you are not signed in to GitHub. The repository is exactly as ` +
					`it was.`
			);
		}
		const result = await session.sendToRemote({
			token: credential,
			remote: bound,
			// The author's answer carried through to the engine as **the files it was about** — which
			// re-plans against the Workspace the local site write has just changed, minutes newer than the
			// listing on screen. An agreement to remove one Annotation must not become an agreement to
			// delete a Project that arrived in the meantime.
			...(overwriting ? { overwrite: upload?.overwrites ?? [] } : {}),
			onProgress: (seen) => {
				progress = { phase: 'sending', ...seen };
			}
		});
		// The withdrawal was the asking and this send is the carrying out, so it is answered here and
		// only on the path that succeeded: a send that threw leaves it outstanding for the next one,
		// rather than turning it into a site the following Sync would rebuild.
		await storage.finishWithdrawal();
		return {
			remote: describeRemote(bound),
			files: result.plan.files.length,
			uploaded: result.plan.uploads,
			baselineKept: result.baselineKept
		};
	}

	/**
	 * Leave for GitHub, so the author comes back holding the credential this screen is missing.
	 *
	 * ⚠ **The mark goes down before the call, because the call navigates.** `beginGitHubSignIn`
	 * assigns `location` and *then* returns `''`, so there is no moment after it in which this page
	 * is still the one on screen. A refusal means the trip never started, and the mark comes back up
	 * — otherwise it would reopen the guided sequence on some unrelated reload later in the session.
	 */
	const beginSignIn = () => {
		problem = '';
		connectSequence.signInRefusal = '';
		connectSequence.leavingForGitHub();
		// ⚠ **`installed: true`, because this modal is only ever open over a connected Workspace.** The
		// relationship came from a repository GitHub listed as granted, so the Installation exists and
		// what is missing is the credential alone — which the plain authorize screen issues.
		problem = storage.beginGitHubSignIn({ installed: true });
		if (problem !== '') connectSequence.notLeavingAfterAll();
	};

	/** Supply the credential from here, rather than sending the author off to another dialog. */
	const signIn = async (event: SubmitEvent) => {
		event.preventDefault();
		if (signingIn) return;
		const problemWithToken = describeTokenProblem(token);
		if (problemWithToken) {
			problem = problemWithToken;
			return;
		}
		signingIn = true;
		problem = '';
		rightsNotice = '';
		const bound = storage.remote;
		try {
			const rights = await storage.signIn(token.trim());
			token = '';
			// Read at the sign-in and said out loud here, as the door does: every request the forecast
			// makes is a GET, so a token that can read and not write plans perfectly and meets its 403
			// at the first blob.
			rightsNotice = rights.canPush
				? ''
				: `This token reaches ${bound ? describeRemote(bound) : 'the repository'} but cannot ` +
					`push. Use a fine-grained token with “Contents: Read and write” for this repository.`;
			forget();
			await readBothSides(session, ++planning);
		} catch (cause) {
			problem = messageOf(cause);
		} finally {
			signingIn = false;
		}
	};

	/**
	 * What a site would weigh and carry, for a Workspace that has Share Links.
	 *
	 * ⚠ **ADR-0020 requires the Base Map's size be stated before it is added**, and this row is where
	 * it is stated. Without Share Links there is no site for any of it to be about (ADR-0045).
	 */
	const siteBreakdown = $derived.by(() => {
		const files = plan?.files ?? [];
		const mapImages = plan?.mapImages ?? { files: 0, bytes: 0 };
		const baseMap = files.filter((file) => file.path.startsWith('base-map/'));
		const viewer = files.filter((file) => !file.path.startsWith('base-map/'));
		return {
			totalFiles: files.length + mapImages.files,
			totalBytes: (plan?.bytes ?? 0) + mapImages.bytes,
			mapImageFiles: mapImages.files,
			mapImageBytes: mapImages.bytes,
			baseMapFiles: baseMap.length,
			baseMapBytes: baseMap.reduce((total, file) => total + file.bytes, 0),
			viewerFiles: viewer.length,
			viewerBytes: viewer.reduce((total, file) => total + file.bytes, 0)
		};
	});

	/** The line announced while the Sync is happening, from **inside** the modal. */
	const progressLine = $derived(describeSyncProgress(progress));

	/** What the user is left holding once the modal is dismissed, or `''`. */
	const standingRefusal = $derived(failure || problem);

	/**
	 * When this hour's request budget resets, as a clock time a person reads.
	 *
	 * `''` when the Remote said nothing about it — a corporate proxy strips the headers — in which
	 * case the sentence leaves the clause out rather than naming a time it does not know.
	 */
	const resetsAt = $derived(
		sync?.budget.resetsAt
			? sync.budget.resetsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
			: ''
	);

	/** What happened, announced once the modal has closed and the region outside it is live again. */
	const result = $derived.by(() => {
		if (!done) return '';
		const got = done.got;
		const sent = done.sent;
		return (
			(got === null
				? ''
				: `Brought in ${count(got.added, 'new file')} and ${count(got.replaced, 'changed file')}` +
					`${got.removed === 0 ? '' : `, and removed ${count(got.removed, 'file')} GitHub no longer has`}.`) +
			(sent
				? `${got === null ? '' : ' '}Sent to ${sent.remote}: ${sent.files} files, ` +
					`${sent.uploaded} of them uploaded` +
					// What the site a Reader meets now carries, where there is one. The count and not the
					// front-page tally: which Projects are listed is each Project's own settings' subject
					// (ADR-0045), and a number said here would be a second place to read it from.
					`${sent.site === null ? '' : `, carrying ${count(sent.site.projects.length, 'Project')}`}.`
				: '') +
			// Said rather than swallowed: the send reached the Remote and this machine's Baseline for it
			// did not survive, which is the `Cannot tell` the next Sync would otherwise meet as an
			// unexplained "we cannot tell whether somebody else wrote this" (ADR-0033).
			(done.baselineKept
				? ''
				: ` This browser would not keep the record of what ${sent?.remote ?? 'the repository'} now ` +
					`holds, so the next Sync cannot tell your own work there from somebody else's.`)
		);
	});
</script>

<!--
	The result, the staleness notice and a refusal that outlives the modal — all three in the layout's
	toast stack, which is outside the dialog and therefore not inert.

	⚠ **Outside is not a preference, it is the mechanism.** `showModal()` makes the whole document
	outside the open `<dialog>` inert, and an inert `aria-live` region is not a quiet one — it is not
	announced at all. So progress is announced from inside the modal (see `progressLine`) and these
	are announced from outside it, which is where the modal has gone by the time there is a result.

	`!open` on the two that a re-opened modal restates for itself. The result has no place inside it.
-->
<Toast text={result} testid="sync-status" tone="info" />
<Toast text={open ? '' : staleness} testid="sync-stale" tone="info" />
<Toast text={open ? '' : standingRefusal} testid="sync-failure" tone="error" refusal />

<!--
	One Change, as one line: what it is called, and how many files it accounts for.

	⚠ **The name and never the paths behind it.** A Sync of one map is four thousand paths, and a
	column that listed them is not a decision anybody can take (ADR-0044).
-->
{#snippet changeLine(change: Change)}
	<li class="flex items-baseline justify-between gap-4 py-1">
		<span class="min-w-0 break-words">{change.name}</span>
		<span class="shrink-0 tabular-nums opacity-70">{count(change.files, 'file')}</span>
	</li>
{/snippet}

<!--
	One column: what would arrive, what would change, and — under its own heading — what would go.

	The removals have a heading of their own because they are the half nobody expects and the half
	that cannot be undone. Absent when there are none: a heading over an empty list reads as a
	consequence nobody can find.
-->
{#snippet column(column: SyncColumn, testid: string, heading: string, where: string)}
	<section class="min-w-0 flex-1" data-testid={testid}>
		<h3 class="font-semibold">{heading}</h3>
		<p class="mt-1 text-sm opacity-70">{where}</p>
		{#if !anythingIn(column)}
			<p class="mt-3 text-sm" data-testid="{testid}-nothing">Nothing.</p>
		{:else}
			{#if column.added.length > 0}
				<h4 class="mt-3 text-sm font-medium opacity-70">New</h4>
				<ul class="text-sm">
					{#each column.added as change (change.kind + change.id)}{@render changeLine(
							change
						)}{/each}
				</ul>
			{/if}
			{#if column.changed.length > 0}
				<h4 class="mt-3 text-sm font-medium opacity-70">Changed</h4>
				<ul class="text-sm">
					{#each column.changed as change (change.kind + change.id)}{@render changeLine(
							change
						)}{/each}
				</ul>
			{/if}
			{#if column.removed.length > 0}
				<h4 class="mt-3 text-sm font-medium" data-testid="{testid}-removals">Removals</h4>
				<ul class="text-sm">
					{#each column.removed as change (change.kind + change.id)}{@render changeLine(
							change
						)}{/each}
				</ul>
			{/if}
		{/if}
	</section>
{/snippet}

<ModalDialog bind:open wide title="Sync with GitHub" {restoreFocusTo}>
	<div class="mx-auto flex w-full max-w-[46rem] flex-col gap-6" data-testid="sync-modal">
		{#if failure}
			<div role="alert" class="alert flex-col items-start alert-error">
				<p>{failure}</p>
			</div>
		{/if}
		<!--
			What the sign-in found out about pushing. Outside the branches below because it is a fact
			about the credential now held, and the branch that produced it is the one the sign-in has
			just left.
		-->
		{#if rightsNotice}
			<div role="alert" class="alert flex-col items-start alert-warning" data-testid="sync-no-push">
				<p>{rightsNotice}</p>
			</div>
		{/if}

		{#if remote !== null}
			<!--
				Where the work goes, and the way to everything about the relationship that is not a
				transfer: Share Links, choosing a different repository, giving it up. Those are settings of
				the Workspace and live on its roster row (ADR-0042); the bar's one control opens *this*
				modal directly (ADR-0044), so this is the handoff to them rather than a second copy.

				⚠ **Outside every gate below, and that is not a layout preference.** A forecast that
				refused — an expired sign-in, a repository GitHub cannot show, no network at all — is
				exactly the state in which an author needs to change where their work goes, and a link
				rendered only beside a successful plan would be absent whenever it mattered.

				One line that does not wrap: each fact is unbreakable and the row wraps between them, so a
				repository name long enough to break the line moves the facts after it down instead of
				pushing them into a horizontal scroll only a pointer could reach (WCAG 2.1.1).
			-->
			<p
				class="flex flex-wrap items-baseline gap-x-3 border-b border-rule pb-3 text-sm [&>*]:whitespace-nowrap"
				data-testid="sync-destination"
			>
				<code>{describeRemote(remote)}</code>
				<span aria-hidden="true" class="opacity-40">·</span>
				<span class="opacity-80">branch <code>{remote.branch}</code></span>
				{#if signedIn}
					<span aria-hidden="true" class="opacity-40">·</span>
					<span class="opacity-80">Signed in to GitHub</span>
				{/if}
				<span aria-hidden="true" class="opacity-40">·</span>
				<button
					class="link text-sm link-hover"
					type="button"
					data-testid="sync-repository-settings"
					onclick={() => {
						open = false;
						workspaceSettings.start();
					}}
				>
					Repository settings…
				</button>
			</p>
		{/if}

		<!--
			⚠ **The refusal comes before the paste, and it is not an ordering preference.** An expired
			sign-in raises its refusal *and* clears the credential, so a refusal rendered inside the
			`signedIn` branch would be replaced, in the same update, by the very form it is the reason
			for — the scholar would be shown a token field and never told why. Both are on screen: what
			happened, and the one thing that fixes it.
		-->
		{#if problem}
			<div role="alert" class="alert flex-col items-start alert-error" data-testid="sync-problem">
				<p>{problem}</p>
			</div>
		{/if}

		{#if remote === null}
			<!-- Unreachable through the bar, which offers connecting instead; kept so no route here can
			     render an empty modal. -->
			<p data-testid="sync-unbound">
				This Workspace belongs to no repository yet. <strong>Sync with GitHub</strong> on the bar connects
				it to one.
			</p>
		{:else}
			<!--
				⚠ **The sign-in is offered beside the plan, never instead of it** (ADR-0044). Getting
				needs no credential — a public repository is readable by anyone — so a signed-out author
				reads the same two columns as anybody else and it is *sending* that the offer below is
				about. Rendered in place of the plan, this was the screen that told a student with no
				GitHub account to sign up before they could take their instructor's Workspace.

				⚠ **One door, and which one is a fact about the deployment rather than about this modal.**
				A student on a deployment with an App is never asked to choose between two credentials, so
				where the front door exists the paste is not on this screen at all — absent, not empty and
				not disabled. A fork that registered no App of its own has only the paste (ADR-0031).

				**Connected with no credential is an ordinary arrival, not an edge**: the credential is
				this tab's and the relationship is not, so a connected Workspace reopened in a fresh tab
				and pressed to Sync lands here.
			-->
			{#if signedIn}
				<!-- Said only where it is true, by the branches below that own the plan. -->
			{:else if storage.signInWithGitHubOffered}
				<div class="flex flex-col gap-1" data-testid="sync-signed-out">
					<p class="text-sm" data-testid="sync-sign-in-needed">
						Sign in to GitHub to send this Workspace to <code>{describeRemote(remote)}</code>.
						Getting from it needs no sign-in. This takes you to GitHub and brings you back here.
						Nothing is kept on this computer beyond this tab.
					</p>
					<button
						class="btn mt-2 w-fit btn-primary btn-sm"
						type="button"
						data-testid="sync-sign-in-with-github"
						onclick={() => beginSignIn()}
					>
						Sign in with GitHub
					</button>
				</div>
			{:else}
				<form data-testid="sync-signed-out" onsubmit={(event) => void signIn(event)}>
					<p class="text-sm" data-testid="sync-sign-in-needed">
						Getting from <code>{describeRemote(remote)}</code> needs no sign-in. To send to it, sign
						in with a token that has
						<strong>Contents: Read and write</strong>
						and <strong>Pages: Read and write</strong>, made under the account that owns the
						repository. Kept only in this tab. Adding
						<strong>Administration: Read and write</strong> lets Share Links turn the site on for you
						rather than leaving you one setting to make on GitHub — it also carries the right to delete
						the repository, so it is a choice rather than something to grant by default.
					</p>
					<div class="mt-3 flex flex-wrap items-end gap-3">
						<div class="flex min-w-0 grow basis-72 flex-col gap-1">
							<label class="text-sm font-medium" for={tokenId}>Personal access token</label>
							<input
								id={tokenId}
								class="input w-full max-w-md input-sm"
								type="password"
								bind:value={token}
								data-testid="sync-token-field"
								autocomplete="off"
								spellcheck="false"
							/>
						</div>
						<!-- `aria-disabled` and a guard in the handler, never `disabled`, for the reason
						     decision 3 gives: a control removed from the tab order the instant it is pressed
						     drops the keyboard user who pressed it. -->
						<button
							class="btn btn-sm"
							class:btn-disabled={signingIn}
							aria-disabled={signingIn}
							type="submit"
							data-testid="sync-sign-in"
						>
							{signingIn ? 'Asking GitHub…' : 'Sign in to GitHub'}
						</button>
					</div>
				</form>
			{/if}
			{#if problem}
				<!--
					The refusal is rendered above, outside these branches, so that it stands beside the
					sign-in it is the reason for. Nothing further belongs here: its own sentence names the
					remedy, and a truncated tree or a repository GitHub cannot show has no control to offer.
				-->
			{:else if sync === null}
				<p class="flex items-center gap-2 text-sm opacity-70" data-testid="sync-reading">
					<span aria-hidden="true" class="loading loading-xs loading-spinner"></span>
					Reading <code>{describeRemote(remote)}</code> and this Workspace…
				</p>
			{:else}
				{#if nothingToDo}
					<p data-testid="sync-nothing-to-do">
						Nothing needs changing. <code>{describeRemote(remote)}</code> holds this Workspace exactly
						as it is here.
					</p>
				{/if}

				{#if shareLinks === true && plan !== null}
					<!--
					What the site this Sync keeps current would weigh and carry — the total first and
					largest, with the breakdown under it as a ledger: label left, figures right, a hairline
					between the rows. The figures are tabular in the text face — ADR-0036 leaves no
					monospaced family to reach for.

					⚠ **Only for a Workspace that has Share Links** (ADR-0045). Without them a Sync carries
					the scholar's own files and there is no site for any of this to be about.
				-->
					<section data-testid="sync-site-breakdown">
						<h3 class="text-sm font-medium opacity-70">Published site</h3>
						<p class="mt-1 flex flex-wrap items-baseline gap-x-3">
							<strong class="text-4xl leading-none font-semibold tabular-nums"
								>{describeBytes(siteBreakdown.totalBytes)}</strong
							>
							<span class="text-sm tabular-nums opacity-70"
								>{siteBreakdown.totalFiles} files total</span
							>
						</p>
						<p class="mt-2 text-sm" data-testid="sync-site-projects">
							This site will carry {count(plan.projects.length, 'Project')}.
						</p>
						<dl
							class="mt-4 grid grid-cols-[1fr_auto_6rem] items-baseline border-t border-rule text-sm [&>*]:border-b [&>*]:border-rule [&>*]:py-2"
						>
							{#if siteBreakdown.mapImageFiles > 0}
								<dt class="pe-6">Map Images</dt>
								<dd class="pe-6 text-right tabular-nums opacity-70">
									{siteBreakdown.mapImageFiles} files
								</dd>
								<dd class="text-right font-medium tabular-nums">
									{describeBytes(siteBreakdown.mapImageBytes)}
								</dd>
							{/if}
							<dt class="pe-6">Viewer and site data</dt>
							<dd class="pe-6 text-right tabular-nums opacity-70">
								{siteBreakdown.viewerFiles} files
							</dd>
							<dd class="text-right font-medium tabular-nums">
								{describeBytes(siteBreakdown.viewerBytes)}
							</dd>
							{#if siteBreakdown.baseMapFiles > 0}
								<dt class="pe-6">Base Map labels and symbols</dt>
								<dd class="pe-6 text-right tabular-nums opacity-70">
									{siteBreakdown.baseMapFiles} files
								</dd>
								<dd class="text-right font-medium tabular-nums">
									{describeBytes(siteBreakdown.baseMapBytes)}
								</dd>
							{/if}
						</dl>
					</section>
					{#each plan.warnings.filter((warning) => warning.kind !== 'base-map-size') as warning (warning.kind)}
						<div
							role="alert"
							class="alert flex-col items-start alert-warning"
							data-warning={warning.kind}
						>
							<p>{warning.message}</p>
						</div>
					{/each}
				{/if}

				<!--
				The two columns, which is what pressing Sync is *for*: what it found, before it does
				anything. Side by side above `sm` and stacked below it, so the comparison is a comparison
				wherever it is read.

				⚠ **The send column is absent, not empty, where the author cannot write** (ADR-0044). A
				column headed *To send* beside actions that are not there is a screen describing a
				capability the reader has not got.
			-->
				<div class="flex flex-col gap-6 sm:flex-row sm:gap-8">
					{@render column(
						sync.toGet,
						'to-get',
						'To get',
						`On ${describeRemote(remote)} and not in this Workspace.`
					)}
					{#if canSend === true}
						{@render column(
							sync.toSend,
							'to-send',
							'To send',
							`In this Workspace and not on ${describeRemote(remote)}.`
						)}
					{/if}
				</div>

				{#if canSend === false}
					<!--
					Said once, plainly, where the second column would be. Nothing on this screen offers a
					send, so this explains an absence rather than a refusal.
				-->
					<div
						role="alert"
						class="alert flex-col items-start alert-info"
						data-testid="sync-read-only"
					>
						<p>
							Your GitHub account can read <code>{describeRemote(remote)}</code> but cannot write to it,
							so this Workspace can take its changes and not send any. Ask whoever owns it for write access
							if you need to send.
						</p>
					</div>
				{/if}

				{#if contested.length > 0}
					<!--
					⚠ **Resolved into a copy, never merged and never chosen between** (ADR-0046). The Sync
					moves everything else in both directions and leaves GitHub's version of the contested
					thing beside your own, for you to look at and delete one. Not a warning, because
					nothing here is at risk: it is a notice about what getting will make.
				-->
					<div class="alert alert-vertical items-start alert-info" data-testid="sync-conflicts">
						<p>
							{contested.length === 1 ? 'One thing has' : `${contested.length} things have`} changed both
							here and on <code>{describeRemote(remote)}</code> since the two last agreed. Getting
							brings GitHub's version in beside your own, named
							<strong>(from GitHub)</strong>, so you can look at both and delete the one you do not
							want. Nothing is combined and nothing of yours is replaced.
						</p>
						<ul class="text-sm">
							{#each contested as change (change.kind + change.id)}{@render changeLine(
									change
								)}{/each}
						</ul>
					</div>
				{/if}

				{#each alignmentQuestions as question (question.path)}
					<!--
					⚠ **A question rather than a copy, and the only one in the product** (ADR-0046). There is
					exactly one Alignment per Map Image, so a second file would be referenced by nothing and
					drawn nowhere. Both counts and both dates are on screen because they are what makes the
					question answerable without opening the two Alignments.

					A `radiogroup` rather than two buttons: the two are exclusive, one is chosen before the
					Sync runs, and leaving it unanswered is allowed — the rest of the Sync goes ahead.
				-->
					<fieldset
						class="rounded-box border border-rule p-4"
						data-testid="sync-alignment-question"
						data-image={question.imageId}
					>
						<legend class="px-1 text-sm font-medium">
							Two alignments of <code>{question.imageId}</code>
						</legend>
						<p class="text-sm">
							This map has been aligned both here and on <code>{describeRemote(remote)}</code> since the
							two last agreed. There is only one alignment per map, so Ballastella cannot keep both —
							choose which to keep, or leave this and the rest of the Sync goes ahead without it.
						</p>
						<div class="mt-3 flex flex-col gap-2">
							{#each [{ value: 'keep-mine', label: 'Keep mine', side: question.mine }, { value: 'take-theirs', label: 'Take the one from GitHub', side: question.theirs }] as const as option (option.value)}
								<label class="flex items-baseline gap-2 text-sm">
									<input
										type="radio"
										class="radio radio-sm"
										name="alignment-{question.path}"
										value={option.value}
										checked={alignmentChoices.get(question.path) === option.value}
										onchange={() => alignmentChoices.set(question.path, option.value)}
									/>
									<span>
										{option.label} — {count(option.side.controlPoints, 'control point')}{option.side
											.at
											? `, ${describeWhen(option.side.at)}`
											: ', no date recorded'}
									</span>
								</label>
							{/each}
						</div>
					</fieldset>
				{/each}

				{#if sync.overwrites.length > 0 && canSend === true}
					<!--
					⚠ **Overwrite names what it would remove before it will proceed** (ADR-0044, Story 15).
					This is the one mode whose removals come from the Workspace alone, so the *To send*
					column above does not carry them: they are not what a send would do.
				-->
					<section data-testid="sync-overwrite-removals">
						<h3 class="text-sm font-medium opacity-70">
							Overwriting the repository would also remove
						</h3>
						<ul class="mt-1 text-sm">
							{#each sync.overwrites as change (change.kind + change.id)}{@render changeLine(
									change
								)}{/each}
						</ul>
					</section>
				{/if}

				{#if outbound !== null && !overwriteAgreed}
					<!--
					⚠ **A second press rather than a louder first one, and only where the repository is not
					the author's alone** (ADR-0044). On a solo repository an overwrite can only discard the
					author's own work; on a shared one it deletes a colleague's, so what would go is named
					and whose the repository is is said first.
				-->
					<div
						role="alert"
						class="alert alert-vertical items-start alert-warning"
						data-testid="sync-shared-remote"
					>
						<p>{outbound.message}</p>
						<p class="text-sm">
							The version you replace stays in the repository's history on GitHub.
						</p>
						<div class="flex flex-wrap gap-2">
							<button
								class="btn btn-sm btn-warning"
								data-testid="confirm-shared-overwrite"
								onclick={() => (overwriteAgreed = true)}
							>
								{outbound.paths.length === 0
									? 'Yes, replace their work'
									: 'Yes, remove them and overwrite'}
							</button>
							<!-- The way out of the question, which is what stops it being a full stop. -->
							<button
								class="btn btn-sm"
								data-testid="cancel-shared-overwrite"
								onclick={() => (outbound = null)}
							>
								Leave it as it is
							</button>
						</div>
					</div>
				{/if}

				{#if canSend === true}
					<!--
					The three budgets, stated separately because the two kinds of content load them
					oppositely (ADR-0033): offline Base Map tiles are byte-heavy and file-cheap, and a Map
					Image's pyramid is the other way round. Shown whether or not they warn, so that "how
					many files and how many bytes will this move" is answerable before the button is
					pressed rather than only when something is already wrong.
				-->
					<ul
						class="border-t border-rule text-sm tabular-nums [&>li]:py-2 [&>li+li]:border-t [&>li+li]:border-rule"
						data-testid="sync-budget"
					>
						<li data-budget="files">
							{sync.size.files} of {upload === null
								? 0
								: upload.files.length + upload.pending.length} files need uploading (limit: {MAX_SENT_FILES}).
						</li>
						<li data-budget="bytes">
							Sending would move {describeBytes(sync.size.bytes)}; the repository would hold
							{describeBytes(upload?.bytes ?? 0)} / {describeBytes(STATIC_HOSTING_LIMIT_BYTES)}
							GitHub Pages limit.
						</li>
						<li data-budget="requests">
							{#if sync.budget.remaining === null}
								Requests this hour: unavailable.
							{:else}
								Requests this hour: {sync.budget.remaining} left{resetsAt === ''
									? ''
									: `; resets at ${resetsAt}`}.
							{/if}
						</li>
					</ul>
					{#each upload?.warnings ?? [] as warning (warning.kind)}
						<div
							role="alert"
							class="alert flex-col items-start alert-warning"
							data-remote-warning={warning.kind}
						>
							<p>{warning.message}</p>
						</div>
					{/each}
				{/if}
			{/if}
		{/if}

		<!--
			Progress, seen and announced by the same element, from inside the modal so that it is not in
			the inert half of the document while it has something to say.

			⚠ **Outside every gate above, and unconditionally rendered while the modal is open.** A re-plan
			nulls the plan — gated on it this region would be removed mid-Sync and re-inserted already
			holding a line, and an `aria-live` region inserted together with its first text is not
			announced.
		-->
		<p aria-live="polite" aria-atomic="true" class="text-sm" data-testid="sync-progress">
			{progressLine}
		</p>
	</div>

	<!--
		The four choices, and Cancel. Never `disabled`, for the reason decision 3 gives.

		⚠ **The three that send are absent where the author cannot write** (Story 50), and signed out
		nobody can. Getting is offered either way: a public repository is readable by anyone, so the
		one press a signed-out student needs is on the screen. Overwrite is absent as well until the
		shared-Remote question has been answered, which is what makes that question a gate rather than
		a notice.
	-->
	{#snippet actions()}
		<button
			class="btn"
			class:btn-disabled={syncing}
			aria-disabled={syncing}
			onclick={() => {
				if (!syncing) open = false;
			}}
		>
			{nothingToDo ? 'Close' : 'Cancel'}
		</button>
		{#if remote !== null && sync !== null}
			<!--
				⚠ **Getting is offered signed out, and that is the property this whole flow exists for**
				(ADR-0044). A public repository is readable by anyone, so a student with no GitHub account
				connects to their instructor's repository and presses this. The three below it send, and
				they are absent rather than present-and-refusing.
			-->
			<button
				class="btn"
				class:btn-disabled={syncing || !(somethingToGet || somethingToResolve)}
				aria-disabled={syncing || !(somethingToGet || somethingToResolve)}
				data-testid="sync-get"
				onclick={() => void run('get')}
			>
				{running === 'get' ? 'Getting…' : 'Get changes'}
			</button>
			{#if signedIn && canSend === true}
				<button
					class="btn"
					class:btn-disabled={syncing || !somethingToSend}
					aria-disabled={syncing || !somethingToSend}
					data-testid="sync-send"
					onclick={() => void run('send')}
				>
					{running === 'send' ? 'Sending…' : 'Send changes'}
				</button>
				<button
					class="btn btn-primary"
					class:btn-disabled={syncing || !(somethingToGet || somethingToSend)}
					aria-disabled={syncing || !(somethingToGet || somethingToSend)}
					data-testid="sync-both"
					onclick={() => void run('both')}
				>
					{running === 'both' ? 'Syncing…' : 'Get and send'}
				</button>
				{#if overwriteAgreed}
					<button
						class="btn btn-warning"
						class:btn-disabled={syncing}
						aria-disabled={syncing}
						data-testid="sync-overwrite"
						onclick={() => void run('overwrite')}
					>
						{running === 'overwrite' ? 'Overwriting…' : 'Overwrite the repository'}
					</button>
				{:else}
					<button
						class="btn"
						class:btn-disabled={syncing || askingSharing}
						aria-disabled={syncing || askingSharing}
						data-testid="sync-arm-overwrite"
						onclick={() => void askToOverwrite()}
					>
						{askingSharing ? 'Asking GitHub…' : 'Overwrite the repository'}
					</button>
				{/if}
			{/if}
		{/if}
	{/snippet}
</ModalDialog>
