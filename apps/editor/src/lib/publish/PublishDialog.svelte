<script lang="ts">
	// Publish: the Workspace becomes the website, and the website goes to its Remote (ADR-0032).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// ONE DIALOG, TWO PHASES, AND THE DECISIONS ALL COME FIRST
	//
	// The dialog exists because publishing has things to *say* before it does anything, and two of
	// them are decisions rather than reports: ADR-0020 requires the Base Map's size be stated before
	// it is added, and ADR-0008's ~1 GB hosting cliff is a cliff rather than a slowdown, so a user
	// finding out from a failed push is the failure it names. Phase one is therefore what will be
	// written into the Workspace *and* what will be sent to the Remote — files, bytes, and the three
	// budgets ADR-0033 separates. Phase two runs, with per-file progress and the hourly budget beside
	// it.
	//
	// `<dialog>` + `showModal()` through `ModalDialog` is mandated (ADR-0016), which is what brings
	// Escape, the focus trap, and focus restoration.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THE FOUR DECISIONS THIS FILE IS MADE OF, EVERY ONE ARRIVED AT FROM A REAL DEFECT
	//
	//   1. The plan is computed **on open** rather than once. A Workspace's byte total and its Project
	//      list both change while the app is running, and a plan computed at startup would state a
	//      size that is no longer true at the one moment where the number is the whole point.
	//   2. A GitHub Remote and credential are required before the Publish action is offered; a local-only
	//      publish would be indistinguishable from a successful web publish.
	//   3. Progress is announced from **inside** the modal and the result from outside it after a
	//      `tick()`. `showModal()` makes the rest of the document inert, and an inert `aria-live`
	//      region is not a quiet one: it is not announced at all.
	//   4. Once offered, Publish is never `disabled` and stays in the tab order while it is unavailable.
	//      A missing Remote or credential removes the action before it can be mistaken for a local-only
	//      publish; `aria-disabled` and a guard preserve focus for the remaining states.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// GITHUB IS REQUIRED BEFORE PUBLISHING IS OFFERED
	//
	// An unbound Workspace is directed to the Remote repository control, and a bound Workspace must
	// have a credential before Publish enters the action row. Once offered, Publish remains in the tab
	// order while planning, uploading, or waiting on a conflict; `aria-disabled` preserves focus in
	// those states without making an unavailable local-only publish look like an option.
	//
	// **Bound with no credential is an ordinary arrival, not an edge**: the credential is this tab's
	// and the binding is not, so a bound Workspace reopened in a fresh tab and pressed to Publish
	// lands here. Which door that state offers is `storage.signInWithGitHubOffered` — the deployment's
	// own answer, read the same way every other gate in the interface reads it. Where an App is
	// configured no personal access token field exists on this screen; where none is, the paste is the
	// only door there is (ADR-0031).

	import { tick } from 'svelte';

	import {
		MAX_PUBLISHED_FILES,
		RemotePublishCredentialError,
		STATIC_HOSTING_LIMIT_BYTES,
		describeBytes,
		describeRemote,
		describeTokenProblem,
		publishedSiteStaleness,
		type PendingLocalFile,
		type ProjectSummary,
		type PublishPlan,
		type PublishedProject,
		type PublishedSite,
		type RemotePublishPlan
	} from '@ballastella/core';

	import { deploymentRoot } from '../base-map/deployment-assets';
	import ModalDialog from '../components/ModalDialog.svelte';
	import { connectSequence } from '../connect-sequence.svelte.js';
	import type { EditorSession } from '../editor-session.svelte.js';
	import Toast from '../toasts/Toast.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
	import { describePublishProgress, type PublishProgress } from './publish-progress.js';
	import { loadViewerBundle, readBundleAsset } from './viewer-bundle-source';

	let {
		storage,
		open = $bindable(false),
		// Both bindable so the navigation bar's Publish control can be `aria-disabled` with a label
		// that reflects progress while the modal that owns the run is on screen.
		publishing = $bindable(false),
		progress = $bindable<PublishProgress | null>(null)
	}: {
		storage: WorkspaceStorage;
		open?: boolean;
		publishing?: boolean;
		progress?: PublishProgress | null;
	} = $props();

	const session = $derived(storage.session);
	/** Where this Workspace publishes, or `null` when it is bound to nothing (ADR-0032). */
	const remote = $derived(storage.remote);
	/**
	 * Whether a credential is held.
	 *
	 * Read from `WorkspaceStorage`, which mirrors the sealed credential store — so this is `false`
	 * inside a Review Workspace because the seal holds, rather than because a condition here
	 * remembered to ask (ADR-0033).
	 */
	const signedIn = $derived(storage.signedIn);

	let plan = $state<PublishPlan | null>(null);
	/** The record this Workspace's own Published Site carries, or `null` before there is one. */
	let site = $state<PublishedSite | null>(null);
	/** What the upload would cost, or `null` when there is nothing to ask GitHub about yet. */
	let upload = $state<RemotePublishPlan | null>(null);
	/** Why the upload could not even be worked out: a truncated tree, an expired sign-in. */
	let uploadProblem = $state('');
	/**
	 * Whether the scholar has taken the second remedy: *publish anyway, replacing it* (ADR-0033).
	 *
	 * ⚠ **Armed by its own button and never a default**, which is the two-step this codebase uses for
	 * everything that cannot be undone — `ProjectHub`'s deletion confirmation names what is at stake
	 * on the second step for the same reason. Until it is armed the confirm button is inert with the
	 * refusal above it saying why, so the state leads somewhere rather than being a dead button.
	 *
	 * Cleared by every re-forecast, deliberately: a decision taken about one set of files is not a
	 * decision about the set a later listing found.
	 */
	let replacing = $state(false);
	/** Why there is nothing to publish, or why publishing stopped. */
	let failure = $state('');
	/** The Project state the current forecast was built from. */
	let plannedProjectKey = '';

	/** The credential being pasted, for a Workspace that is bound and not signed in. */
	let token = $state('');
	let signingIn = $state(false);
	/**
	 * What the sign-in found out about pushing, when the answer was that it cannot.
	 *
	 * A notice rather than a refusal: the credential works, every request the forecast makes is a GET,
	 * and the 403 arrives at the first blob — after the whole website has been written into the
	 * Workspace. `signIn` reads the rights for exactly this reason, and throwing the answer away is
	 * how a `Contents: Read` token gets four thousand tiles into a publish before saying anything.
	 */
	let rightsNotice = $state('');

	/** What happened, once it has. Announced, and it stays on screen after the dialog closes. */
	let published = $state<{
		site: PublishedSite;
		files: number;
		sent: { remote: string; files: number; uploaded: number } | null;
		/** The Remote nothing was sent to, or `''` when there was nothing to send to. */
		notSent: string;
		/** Whether this machine kept its Synchronization Baseline for the Remote (ADR-0038). */
		baselineKept: boolean;
	} | null>(null);

	/** The record the Workspace's own Published Site carries, and whether it is behind. */
	let staleness = $state('');

	/** A hydration-stable id for the credential field, for the reason `NavigationBar` documents. */
	const tokenId = $props.id();

	const messageOf = (cause: unknown): string =>
		cause instanceof Error ? cause.message : String(cause);

	const projectStateKey = (projects: readonly ProjectSummary[]): string =>
		projects
			.map(
				(project) =>
					`${project.directory}\u0000${project.name}\u0000${project.onFrontPage}\u0000${project.problem}`
			)
			.join('\u0001');

	const reset = () => {
		plan = null;
		site = null;
		upload = null;
		uploadProblem = '';
		replacing = false;
		rightsNotice = '';
		failure = '';
		progress = null;
		published = null;
		token = '';
	};

	/**
	 * Work out what sending this Workspace would cost, or why that cannot be worked out.
	 *
	 * ⚠ **`willWrite` is not an optimisation, it is what makes the three budgets true.** The forecast
	 * is shown *before* the local publish writes anything — decision 2 in the header settles the
	 * address first, and nothing is written until the scholar confirms — so at this moment the viewer
	 * bundle, `ballastella-site.json` and, when the box is ticked, five megabytes of Base Map glyphs
	 * are not in the Workspace. Planned against the folder as it stands, all three budgets understate
	 * a *first* publish, which is the publish they exist for, and the request warning is computed on a
	 * count with the whole website missing from it.
	 *
	 * ⚠ **A 401 here is the stale sign-in.** Rights are read when a Remote is bound and when a token
	 * is pasted, at no other moment — so the bar's "Signed in to GitHub" means *a credential is held*,
	 * never *a credential still works*. The label is left alone deliberately and the **refusal**
	 * carries it instead. This is where it arrives, because planning is the first credentialed
	 * request a publish makes and it posts nothing at all — so an expired token is met on opening the
	 * dialog, with the Remote untouched, and never after four thousand tiles have gone. The credential
	 * is forgotten as well as reported, which puts the paste below back on screen.
	 */
	async function forecastUpload(
		willWrite: readonly PendingLocalFile[],
		mine: number = planning
	): Promise<void> {
		upload = null;
		uploadProblem = '';
		replacing = false;
		const bound = storage.remote;
		const credential = storage.credential;
		if (bound === null || credential === null) return;
		try {
			const forecast = await session.planRemotePublish({
				token: credential,
				remote: bound,
				pending: willWrite
			});
			if (mine !== planning) return;
			upload = forecast;
			// ⚠ **A refusal here is a statement about the Remote, and the bar has to agree with it.** The
			// forecast has just listed the tree and found source this Workspace has not taken in; a
			// status control still reading `Up to date` beside a dialog saying the Remote has moved is
			// the disagreement ADR-0038 exists to remove. Only on a refusal, so an ordinary open still
			// costs the one listing it always did.
			if (forecast.conflict !== null) await storage.checkRemoteStatus();
		} catch (cause) {
			// Outside the guard: the credential is dead whichever run found that out, and leaving it in
			// place would put the next publish's discovery of it after the upload has started.
			if (cause instanceof RemotePublishCredentialError) storage.signOut();
			if (mine !== planning) return;
			uploadProblem = messageOf(cause);
		}
	}

	/**
	 * Which session the dialog on screen was planned for, or `null` while it is closed.
	 *
	 * ⚠ **A plain `let`, and the reason is the whole of why this guard exists.** The effect below
	 * writes `plan`, `progress`, `uploadProblem` and — when the sign-in has expired — clears the
	 * credential, and `progress` is a `$bindable`: the parent's binding writes it straight back
	 * through this component's props, which is where the effect reads `open` from. So an ungated
	 * effect re-runs itself through the round trip. Measured, it planned twice on every open, and an
	 * expired sign-in then wiped its own refusal off the screen and left the scholar looking at a
	 * token field with nothing to say why. Reading a `$state` here would put the guard inside the loop
	 * it exists to break.
	 */
	let plannedFor: EditorSession | null = null;

	/**
	 * Which session the result, the staleness notice and the standing refusal are statements about.
	 *
	 * They render **outside** the dialog and outlive it, on a navigation bar that is mounted on every
	 * screen — so unlike everything `reset` covers, closing is not what makes them stale. Switching
	 * Workspace is: "Published … Sent to ada/atlas" left sitting under the bar of the Workspace the
	 * user has just switched to reads as a statement about that one.
	 */
	let shownFor: EditorSession | null = null;

	/**
	 * Which planning run may still write, so a run overtaken by another lands nowhere.
	 *
	 * The same `#generation` shape `EditorSession` opens Projects with, and needed for the same
	 * reason: this is three awaits deep, the Workspace can be switched with the dialog open, and the
	 * Base Map answer starts a run of its own. Without it the older run finishes last and `run` then
	 * publishes the plan of a Workspace nobody is looking at.
	 */
	let planning = 0;

	/**
	 * Work out the plan whenever the dialog opens or a Project's Front Page choice changes.
	 *
	 * On open rather than once: see decision 1 in the header. `session` is a dependency so that
	 * switching Workspace with the dialog open re-plans against the Workspace now in front of the
	 * user rather than the one they left. The Project key also makes the forecast follow a choice made
	 * inside this dialog.
	 */
	$effect(() => {
		const active = session;
		if (shownFor !== active) {
			shownFor = active;
			published = null;
			staleness = '';
			failure = '';
			uploadProblem = '';
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
		void planOpening(active, ++planning);
	});

	/** Everything the dialog has to say before it does anything: the record, the plan, the forecast. */
	async function planOpening(active: EditorSession, mine: number): Promise<void> {
		try {
			const bundle = await loadViewerBundle();
			const record = await active.readPublishedSite();
			const planned = await active.planPublish({
				bundle,
				editorUrl: deploymentRoot(),
				// The installation-local relationship, written *into* the site so its Front Page can
				// point back at the repository — never read back out of a site as a binding.
				repository: storage.remote
			});
			if (mine !== planning) return;
			site = record;
			plan = planned;
			staleness =
				record === null
					? ''
					: publishedSiteStaleness(record, {
							viewerVersion: bundle.version,
							projects: active.projects
						});
		} catch (cause) {
			if (mine !== planning) return;
			failure = messageOf(cause);
		}
		if (mine !== planning) return;
		await forecastUpload(plan?.files ?? [], mine);
	}

	/**
	 * Leave for GitHub, so the author comes back holding the credential this screen is missing.
	 *
	 * ⚠ **The mark goes down before the call, because the call navigates.** `beginGitHubSignIn`
	 * assigns `location` and *then* returns `''`, so there is no moment after it in which this page is
	 * still the one on screen. A refusal means the trip never started, and the mark comes back up —
	 * otherwise it would reopen the guided sequence on some unrelated reload later in the session.
	 *
	 * The return leg is a fresh document, so nothing here resumes: the mark reopens the sequence,
	 * whose `connected` step for a Workspace already bound ends in the **Publish…** handoff. Signing
	 * in from Publish therefore arrives back at Publish.
	 */
	const beginSignIn = () => {
		uploadProblem = '';
		connectSequence.signInRefusal = '';
		connectSequence.leavingForGitHub();
		uploadProblem = storage.beginGitHubSignIn();
		if (uploadProblem !== '') connectSequence.notLeavingAfterAll();
	};

	/** Supply the credential from here, rather than sending the user off to another dialog. */
	const signIn = async (event: SubmitEvent) => {
		event.preventDefault();
		const problem = describeTokenProblem(token);
		if (problem) {
			uploadProblem = problem;
			return;
		}
		signingIn = true;
		uploadProblem = '';
		rightsNotice = '';
		const bound = storage.remote;
		try {
			const rights = await storage.signIn(token.trim());
			token = '';
			// Read at the sign-in and said out loud here, as the Remote dialog does: every request the
			// forecast makes is a GET, so a token that can read and not write plans perfectly and meets
			// its 403 at the first blob — with the whole website already written into the Workspace.
			rightsNotice = rights.canPush
				? ''
				: `This token reaches ${bound ? describeRemote(bound) : 'the repository'} but cannot ` +
					`push. Use a fine-grained token with “Contents: Read and write” for this repository.`;
			await forecastUpload(plan?.files ?? []);
		} catch (cause) {
			uploadProblem = messageOf(cause);
		} finally {
			signingIn = false;
		}
	};

	/**
	 * Whether the Published Site in this Workspace already says exactly what publishing would write.
	 *
	 * Staleness covers the viewer's version and every Project fact the record carries (ADR-0032); the
	 * two Base Map flags are the rest of it, and they are read off the plan so the comparison describes
	 * the files this publish will actually write.
	 * Every other difference is a difference in the Workspace's own files, which
	 * {@link RemotePublishPlan.unchanged} sees.
	 */
	const siteIsCurrent = $derived(
		site !== null &&
			plan !== null &&
			staleness === '' &&
			site.baseMapBundled === plan.baseMapBundled &&
			site.baseMapAssetsBundled === plan.baseMapAssetsBundled
	);

	/**
	 * Whether pressing the button would change nothing anywhere.
	 *
	 * The Remote holding this Workspace already is most of it. Said rather than left as a publish that
	 * uploads one file — the site record's timestamp — and reports success.
	 */
	const nothingToDo = $derived(upload?.unchanged === true && siteIsCurrent);

	/**
	 * How many files the Remote will hold: the Workspace's, and the website about to be written.
	 *
	 * Two numbers on the plan rather than one, because only the first is a list of paths the upload
	 * can read bytes from — see {@link RemotePublishPlan.pending}. What the scholar is owed is the sum,
	 * and on a first publish the second half is most of it.
	 */
	const uploadFiles = $derived(upload === null ? 0 : upload.files.length + upload.pending.length);

	const publishedBreakdown = $derived.by(() => {
		const files = plan?.files ?? [];
		const mapImages = plan?.mapImages ?? { files: 0, bytes: 0 };
		const baseMap = files.filter((file) => file.path.startsWith('base-map/'));
		const site = files.filter((file) => !file.path.startsWith('base-map/'));
		return {
			totalFiles: files.length + mapImages.files,
			totalBytes: (plan?.bytes ?? 0) + mapImages.bytes,
			mapImageFiles: mapImages.files,
			mapImageBytes: mapImages.bytes,
			baseMapFiles: baseMap.length,
			baseMapBytes: baseMap.reduce((total, file) => total + file.bytes, 0),
			siteFiles: site.length,
			siteBytes: site.reduce((total, file) => total + file.bytes, 0)
		};
	});

	/**
	 * Why publishing would overwrite work this Workspace has never seen, or `null` (ADR-0033).
	 *
	 * The engine refuses on it whatever this dialog does — `publishToRemote` will not send a byte
	 * while it is set unless it is told to replace — so what is rendered from it is the *offer*, not
	 * the protection.
	 */
	const conflict = $derived(upload?.conflict ?? null);
	/** Whether the confirm button would refuse: a standing conflict the scholar has not answered. */
	const blockedByConflict = $derived(conflict !== null && !replacing);
	/**
	 * Whether the forecast itself was refused, so there is nothing to press through to.
	 *
	 * ⚠ **A read-only account is the case this exists for.** Publishing checks the account's
	 * permission before it lists a tree, so the refusal is here rather than at the first blob — and
	 * pressing Publish anyway would write the whole website into the Workspace before meeting the same
	 * refusal a second time, which is minutes of work for a transfer that cannot complete. A truncated
	 * tree and a repository GitHub cannot show arrive the same way.
	 */
	const blockedByProblem = $derived(uploadProblem !== '');

	/**
	 * What the confirm button says, which has to be what pressing it does. The button is rendered only
	 * after the Workspace has a Remote and a credential.
	 */
	const confirmLabel = $derived(
		publishing
			? 'Publishing…'
			: conflict !== null && replacing
				? 'Publish anyway, replacing it'
				: 'Publish'
	);

	const run = async () => {
		const agreed = plan;
		if (
			!agreed ||
			remote === null ||
			!signedIn ||
			publishing ||
			nothingToDo ||
			blockedByConflict ||
			blockedByProblem
		) {
			return;
		}
		publishing = true;
		failure = '';
		/** Whether the viewer has reached the Workspace, so a later refusal does not deny it. */
		let written = false;
		try {
			const siteWritten = await session.publish({
				plan: agreed,
				readAsset: readBundleAsset,
				onProgress: (seen) => {
					progress = {
						phase: 'writing',
						files: seen.files,
						totalFiles: seen.totalFiles,
						requestsRemaining: null
					};
				}
			});
			written = true;

			// The Remote and the credential are read again here rather than taken from the render: a
			// publish of a large Workspace runs for minutes, and a sign-out during one must not be
			// answered by uploading anyway.
			const bound = storage.remote;
			const credential = storage.credential;
			let sent: { remote: string; files: number; uploaded: number } | null = null;
			/** The Remote this publish did **not** reach, which the result has to say out loud. */
			let notSent = '';
			let baselineKept = true;
			if (bound !== null && credential !== null) {
				const result = await session.publishToRemote({
					token: credential,
					remote: bound,
					// The scholar's answer to the refusal, carried through to the engine as the **files it
					// was about** — which re-plans against the Workspace the local publish has just written
					// and would otherwise refuse all over again, on the same conflict they have already been
					// shown and accepted. The paths rather than a `true`, because that second plan is made
					// against a tree listing minutes newer than the one on screen: an agreement to replace
					// one Annotation must not become an agreement to delete a Project that arrived in the
					// meantime.
					...(replacing ? { replace: conflict?.paths ?? [] } : {}),
					onProgress: (seen) => {
						progress = { phase: 'uploading', ...seen };
					}
				});
				sent = {
					remote: describeRemote(bound),
					files: result.plan.files.length,
					uploaded: result.plan.uploads
				};
				baselineKept = result.baselineKept;
			} else if (bound !== null) {
				// A sign-out during a long publish can remove the credential after the local site is written;
				// keep the result explicit about the Remote that was not reached.
				notSent = describeRemote(bound);
			}

			// Closed, and the close applied, *before* the result is set — decision 3 in the header.
			staleness = '';
			open = false;
			await tick();
			published = {
				site: siteWritten,
				files: agreed.files.length,
				sent,
				notSent,
				baselineKept
			};
		} catch (cause) {
			if (cause instanceof RemotePublishCredentialError) storage.signOut();
			// ⚠ **A refusal after the viewer has been written must not imply nothing happened.** Core's
			// upload refusals all say "nothing on your Published Site has changed", which is true and is
			// about the Remote — while the Workspace in front of the user has just gained a website. Left
			// unsaid, a scholar re-reads it as "nothing at all happened" and cannot account for the files.
			failure = written
				? `${messageOf(cause)} The website itself was written into this Workspace, so publishing ` +
					`again sends it without doing that work twice.`
				: messageOf(cause);
			// The Workspace holds the website now, so the forecast is re-made against what is actually
			// there rather than against what was still pending when the dialog opened.
			await forecastUpload(plan?.files ?? []);
		} finally {
			publishing = false;
			progress = null;
			// Whatever happened, the Remote or this machine's evidence about it has moved, and the status
			// on the bar was worked out against the Workspace as it was before any of it. Re-read the
			// Baseline rather than assume it — a refused `writeBaseline` discards the stale record, so
			// the honest answer afterwards is the `null` this finds — and then recompute.
			const bound = storage.remote;
			if (bound !== null) {
				storage.baseline = (await session.synchronization?.readBaseline(bound)) ?? null;
				await storage.checkRemoteStatus();
			}
		}
	};

	/**
	 * The line announced while the publish is happening, from **inside** the dialog.
	 *
	 * It has to be inside: `showModal()` makes the whole document outside the open `<dialog>` inert,
	 * and an inert `aria-live` region is not a quiet one — it is not announced at all. So progress
	 * lives in the modal, which is the only non-inert subtree while publishing runs, and the result
	 * below lives outside it, which is where the dialog has gone by the time there is a result.
	 * Nothing is said twice: this is empty except while `progress` is set, and that is exactly the
	 * span during which the other one is empty.
	 */
	const progressLine = $derived(describePublishProgress(progress));

	/** What the user is left holding once the dialog is dismissed, or `''`. */
	const standingRefusal = $derived(failure || uploadProblem);

	/**
	 * How many Projects a site carries, and how many of them its Front Page lists (ADR-0032).
	 *
	 * ⚠ **Two numbers, because `projects` is every Project the site carries, listed or not.** Reporting
	 * only the length as a count of what the site "will list" was true before the Front Page choice
	 * existed and is false now: a Workspace of five Projects with two taken off publishes five and
	 * lists three. Saying "5" would overstate the Front Page; saying "3" would understate what is about
	 * to be written to a public host, which is the more dangerous of the two errors.
	 */
	const describeProjects = (projects: readonly PublishedProject[]): string => {
		if (projects.length === 0) return 'no Projects';
		const listed = projects.filter((project) => project.onFrontPage).length;
		const carried = projects.length === 1 ? '1 Project' : `${projects.length} Projects`;
		if (listed === projects.length) {
			return `${carried}, ${projects.length === 1 ? 'on' : 'all on'} the front page`;
		}
		if (listed === 0) return `${carried}, none of them on the front page`;
		return `${carried}, ${listed} of them on the front page`;
	};

	/**
	 * When this hour's request budget resets, as a clock time a person reads.
	 *
	 * `''` when the Remote said nothing about it — a corporate proxy strips the headers — in which
	 * case the sentence leaves the clause out rather than naming a time it does not know.
	 */
	const resetsAt = $derived(
		upload?.requestsResetAt
			? upload.requestsResetAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
			: ''
	);

	/**
	 * What happened, announced once the dialog has closed and the region outside it is live again.
	 *
	 * ⚠ **Where it went, or where it did not.** A publish that wrote the website and sent it nowhere
	 * is not a publish with one clause missing: the scholar has to be told that the site on the web is
	 * the one that was already there, and what to do about it.
	 */
	const result = $derived.by(() => {
		if (!published) return '';
		const sent = published.sent;
		return (
			`Published: ${published.files} files written into your Workspace, carrying ` +
			`${describeProjects(published.site.projects)}.` +
			(sent
				? ` Sent to ${sent.remote}: ${sent.files} files, ${sent.uploaded} of them uploaded.`
				: '') +
			(published.notSent
				? ` Nothing was sent to ${published.notSent}, because you are not signed in to GitHub: ` +
					`your Published Site is exactly as it was. Publish again once you have signed in and ` +
					`this goes there without doing the work twice.`
				: '') +
			// Said rather than swallowed: the publish reached the Remote and this machine's Baseline for
			// it did not survive, which is the `Cannot tell` the next publish would otherwise meet as an
			// unexplained "we cannot tell whether somebody else wrote this" (ADR-0038).
			(published.baselineKept
				? ''
				: ` This browser would not keep the record of what ${sent?.remote ?? 'the Remote'} now ` +
					`holds, so the next publish cannot tell your own work there from somebody else's.`)
		);
	});
</script>

<!--
	The result, the staleness notice and a refusal that outlives the modal — all three in the layout's
	toast stack, which is outside the dialog and therefore not inert.

	⚠ **Outside is not a preference, it is the mechanism.** `showModal()` makes the whole document
	outside the open `<dialog>` inert, and an inert `aria-live` region is not a quiet one — it is not
	announced at all. So progress is announced from inside the modal (see `progressLine`) and these
	are announced from outside it, which is where the dialog has gone by the time there is a result:
	`run` closes it before it sets `published`. Nothing is said twice.

	The result and the staleness notice are statuses, announced politely by the stack's own region,
	which is mounted from the first frame — a live region inserted at the same moment as its first
	text is not reliably announced. The refusal is the one thing here the scholar has to act on, so it
	is the one that is announced on insertion.

	`!open` on the two that a re-opened dialog restates for itself: the staleness notice and the
	refusal both appear inside it, and a toast repeating them behind the modal is the same sentence
	twice. The result has no place inside the dialog at all.
-->
<Toast text={result} testid="publish-status" tone="info" />
<Toast text={open ? '' : staleness} testid="publish-stale" tone="info" />
<Toast text={open ? '' : standingRefusal} testid="publish-failure" tone="error" refusal />

<!--
	The repository, the credential and what is left of this hour's request budget, on one line that
	does not wrap — the strip the button beneath it acts on, under a hairline of its own.

	Rendered by the two arms that have an answer to give: a Remote that already holds this Workspace,
	and a Remote that is about to. Each fact is unbreakable and the row wraps between them, so a
	repository name long enough to break the line moves the facts after it down instead of pushing
	them into a horizontal scroll only a pointer could reach (WCAG 2.1.1).
-->
{#snippet destinationStrip()}
	{#if remote !== null}
		<p
			class="mt-4 flex flex-wrap items-baseline gap-x-3 border-t border-rule pt-3 text-sm [&>*]:whitespace-nowrap"
			data-testid="publish-destination"
		>
			<code>{describeRemote(remote)}</code>
			<span aria-hidden="true" class="opacity-40">·</span>
			<span class="opacity-80">branch <code>{remote.branch}</code></span>
			<span aria-hidden="true" class="opacity-40">·</span>
			<span class="opacity-80">Signed in to GitHub</span>
			{#if upload !== null && upload.requestsRemaining !== null}
				<span aria-hidden="true" class="opacity-40">·</span>
				<span class="tabular-nums opacity-80"
					>{upload.requestsRemaining} requests left{resetsAt === ''
						? ''
						: `, resets ${resetsAt}`}</span
				>
			{/if}
		</p>
	{/if}
{/snippet}

<ModalDialog bind:open wide title="Publish this Workspace">
	<!--
		A receipt, read top to bottom: what the site weighs, what it carries, which Projects a Reader
		meets first, and last of all where it goes — immediately above the button that sends it there,
		so that Publish is never pressed with its target off screen.

		`wide` widens `ModalDialog`'s box and the cap here spends that width on one column rather than
		two: distance between a ledger row's label and its figure, and a destination line that holds
		the repository, the credential and the request budget without wrapping. Two columns were
		rejected — this dialog's worst state is a footer holding one sentence, and beside an empty
		second column that reads as a rendering fault.
	-->
	<div class="mx-auto flex w-full max-w-[40rem] flex-col gap-6">
		{#if failure}
			<div role="alert" class="alert flex-col items-start alert-error">
				<p>{failure}</p>
			</div>
		{/if}

		{#if plan === null}
			<p>Working out what publishing would add…</p>
		{:else}
			<!--
				The total first and largest, because it is the fact the dialog is opened to learn, with the
				breakdown under it as a ledger: label left, figures right, a hairline between the rows. The
				figures are tabular in the text face — ADR-0036 leaves no monospaced family to reach for.
			-->
			<section data-testid="publish-breakdown">
				<h3 class="text-sm font-medium opacity-70">Published site</h3>
				<p class="mt-1 flex flex-wrap items-baseline gap-x-3">
					<strong class="text-4xl leading-none font-semibold tabular-nums"
						>{describeBytes(publishedBreakdown.totalBytes)}</strong
					>
					<span class="text-sm tabular-nums opacity-70"
						>{publishedBreakdown.totalFiles} files total</span
					>
				</p>
				<!--
					What the site carries, at plan level and independent of the destination below: a receipt
					states what is in it, and the Project count is a fact about the site rather than about
					the Remote. `describeProjects` keeps its two numbers for the reason its own note gives.
				-->
				<p class="mt-2 text-sm" data-testid="publish-projects">
					This site will carry {describeProjects(plan.projects)}.
				</p>
				<dl
					class="mt-4 grid grid-cols-[1fr_auto_6rem] items-baseline border-t border-rule text-sm [&>*]:border-b [&>*]:border-rule [&>*]:py-2"
				>
					{#if publishedBreakdown.mapImageFiles > 0}
						<dt class="pe-6">Uploaded Map Images</dt>
						<dd class="pe-6 text-right tabular-nums opacity-70">
							{publishedBreakdown.mapImageFiles} files
						</dd>
						<dd class="text-right font-medium tabular-nums">
							{describeBytes(publishedBreakdown.mapImageBytes)}
						</dd>
					{/if}
					<dt class="pe-6">Viewer and site data</dt>
					<dd class="pe-6 text-right tabular-nums opacity-70">
						{publishedBreakdown.siteFiles} files
					</dd>
					<dd class="text-right font-medium tabular-nums">
						{describeBytes(publishedBreakdown.siteBytes)}
					</dd>
					{#if publishedBreakdown.baseMapFiles > 0}
						<dt class="pe-6">Base Map labels and symbols</dt>
						<dd class="pe-6 text-right tabular-nums opacity-70">
							{publishedBreakdown.baseMapFiles} files
						</dd>
						<dd class="text-right font-medium tabular-nums">
							{describeBytes(publishedBreakdown.baseMapBytes)}
						</dd>
					{/if}
				</dl>
			</section>
		{/if}

		<!--
			The choice in the middle of the receipt, between what the site weighs and where it goes.

			⚠ **Outside the `plan === null` gate above, and that is not an accident.** Changing a toggle
			re-plans, which nulls `plan` for as long as that takes; gated with the breakdown, the control
			the scholar has just pressed would vanish under their hand and come back.
		-->
		<section data-testid="publish-project-selection">
			<h3 class="font-semibold">Projects on the front page</h3>
			<p id="publish-project-description" class="mt-1 text-sm opacity-80">
				Choose which Projects Readers see first. All Projects stay published.
			</p>
			<ul class="mt-3 border-t border-rule">
				{#each session.projects as project (project.directory)}
					<li class="[&+li]:border-t [&+li]:border-rule">
						<label class="flex items-center justify-between gap-4 py-2 text-sm">
							<span class="font-medium">{project.name}</span>
							<span class="flex shrink-0 items-center gap-2">
								<span class="opacity-70">Front page</span>
								<input
									type="checkbox"
									class="toggle toggle-sm"
									data-testid="on-front-page-{project.directory}"
									checked={project.onFrontPage}
									onchange={(event) =>
										void session.setProjectOnFrontPage(
											project.directory,
											(event.currentTarget as HTMLInputElement).checked
										)}
									disabled={project.problem !== null}
									aria-label="On the front page — {project.name}"
									aria-describedby="publish-project-description"
								/>
							</span>
						</label>
					</li>
				{/each}
			</ul>
		</section>

		{#if plan !== null}
			{#each plan.warnings.filter((warning) => warning.kind !== 'base-map-size') as warning (warning.kind)}
				<div
					role="alert"
					class="alert flex-col items-start alert-warning"
					data-warning={warning.kind}
				>
					<p>{warning.message}</p>
				</div>
			{/each}

			<!--
				The foot of the receipt: where the Workspace goes afterwards, what that costs, and every
				state in which it cannot go anywhere (ADR-0032, ADR-0033).

				A GitHub repository and a credential are required before the action is offered, so each of
				the five arms is a footer laid out for what it has to say rather than a stack of alerts. A
				refusal names its remedy, and a Remote that already holds this Workspace says so rather
				than uploading a timestamp and reporting success.
			-->
			<footer class="border-t border-rule-strong pt-4">
				<h3 class="text-sm font-medium opacity-70">Publish destination</h3>
				{#if remote === null}
					<!--
						The state a first-time author meets, and the one arm that has a single sentence to
						carry: drawn as a glyph, a statement and its remedy rather than left as a lone line in
						an empty footer. It names the control that binds a Remote, which is where the way
						forward is.
					-->
					<div class="mt-3 flex items-start gap-3" data-testid="publish-unbound">
						<svg
							aria-hidden="true"
							class="mt-0.5 size-5 shrink-0 opacity-60"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"
							/>
						</svg>
						<div>
							<p class="font-medium">This Workspace publishes nowhere yet.</p>
							<p class="mt-1 text-sm opacity-80">
								Publishing sends the website to a GitHub repository, and this Workspace is bound to
								none. Bind one with <strong>Remote repository…</strong> in Workspace settings, and the
								destination and what sending it would cost appear here.
							</p>
						</div>
					</div>
				{:else}
					<!--
						⚠ **The refusal comes before the paste, and it is not an ordering preference.** An
						expired sign-in raises its refusal *and* clears the credential, so a refusal rendered in
						the `signedIn` branch would be replaced, in the same update, by the very form it is the
						reason for — the scholar would be shown a token field and never told why. Both are on
						screen: what happened, and the one thing that fixes it.
					-->
					{#if uploadProblem}
						<div
							role="alert"
							class="mt-3 alert flex-col items-start alert-error"
							data-testid="publish-upload-problem"
						>
							<p>{uploadProblem}</p>
						</div>
					{/if}
					<!--
						What the sign-in found out about pushing. Outside the branches below for the same reason
						the refusal is: it is a fact about the credential now held, and the branch that produced
						it is the one the sign-in has just left.
					-->
					{#if rightsNotice}
						<div
							role="alert"
							class="mt-3 alert flex-col items-start alert-warning"
							data-testid="publish-no-push"
						>
							<p>{rightsNotice}</p>
						</div>
					{/if}
					{#if !signedIn}
						<!--
							⚠ **One door, and which one is a fact about the deployment rather than about this
							dialog.** A student on a deployment with an App is never asked to choose between
							two credentials, so where the front door exists the paste is not on this screen at
							all — absent, not empty and not disabled. A fork that registered no App of its own
							has only the paste (ADR-0031), and it is unchanged: the same wording, the same
							validation, the same rights notice, the same test ids.
						-->
						{#if storage.signInWithGitHubOffered}
							<div class="mt-3 flex flex-col gap-1">
								<p class="text-sm" data-testid="publish-sign-in-needed">
									Sign in to GitHub to publish to <code>{describeRemote(remote)}</code>. This takes
									you to GitHub and brings you back here. Nothing is kept on this computer beyond
									this tab.
								</p>
								<button
									class="btn mt-2 w-fit btn-primary btn-sm"
									type="button"
									data-testid="publish-sign-in-with-github"
									onclick={() => beginSignIn()}
								>
									Sign in with GitHub
								</button>
							</div>
						{:else}
							<form class="mt-3" onsubmit={(event) => void signIn(event)}>
								<p class="text-sm" data-testid="publish-sign-in-needed">
									Sign in to publish to <code>{describeRemote(remote)}</code> with a token that has
									<strong>Contents: Read and write</strong>. Kept only in this tab.
								</p>
								<div class="mt-3 flex flex-wrap items-end gap-3">
									<div class="flex min-w-0 grow basis-72 flex-col gap-1">
										<label class="text-sm font-medium" for={tokenId}>Personal access token</label>
										<input
											id={tokenId}
											class="input w-full max-w-md input-sm"
											type="password"
											bind:value={token}
											data-testid="publish-token-field"
											autocomplete="off"
											spellcheck="false"
										/>
									</div>
									<button
										class="btn btn-sm"
										type="submit"
										data-testid="publish-sign-in"
										disabled={signingIn}
									>
										{signingIn ? 'Asking GitHub…' : 'Sign in to GitHub'}
									</button>
								</div>
							</form>
						{/if}
					{:else if uploadProblem}
						<!-- Its remedy is not a sign-in: a truncated tree, a repository GitHub cannot show. The
						     message itself names what to do, and there is nothing further to render. -->
					{:else if upload === null}
						<p class="mt-3 flex items-center gap-2 text-sm opacity-70">
							<span aria-hidden="true" class="loading loading-xs loading-spinner"></span>
							Asking <code>{describeRemote(remote)}</code> what it already has…
						</p>
					{:else if nothingToDo}
						<!--
							⚠ **Before the conflict, and that ordering is the fix to a dead button.** A conflict
							is a statement about *whose* the files on the Remote are, and `unknown` is raised on
							nothing more than "no manifest, and the owned namespace is not empty" — which is the
							state of a Workspace whose Remote matches it byte for byte, the ordinary first press
							after a complete Open from GitHub. Rendered conflict-first, that Workspace was shown a
							refusal, offered a replace that armed and then changed nothing, and left with a
							`aria-disabled` Publish button and the sentence explaining it suppressed. Nothing here
							would change anything anywhere, so there is nothing to refuse and nothing at stake.
						-->
						<p class="mt-3 text-sm" data-testid="publish-nothing-to-do">
							Nothing needs changing. <code>{describeRemote(remote)}</code> already holds this Workspace
							exactly as it is here, so there is nothing to send and your Published Site is up to date.
						</p>
						{@render destinationStrip()}
					{:else}
						{#if conflict !== null}
							<!--
								⚠ **The refusal, and both of its remedies, on one screen.** Naming the paths is the
								whole of the reporting — there is no diff and no per-file choosing — and the two
								ways on are Open a Workspace from GitHub or replace, never a merge. The second is
								a two-step: this button only *arms* it, and the confirm button below then says
								what pressing it does. That is `ProjectHub`'s deletion pattern, for its reason.

								⚠ **Beside the budgets rather than instead of them.** A conflict is where the
								replacement tree is largest and where the scholar is being asked to press through a
								warning, so it is the worst possible moment to be the one state that hides the two
								numbers, the hosting cliff and the hourly request budget.
							-->
							<!-- `alert-vertical`, not `flex-col`: daisyUI's `.alert` is a grid with
							     `grid-auto-flow: column`, so a flexbox utility on it does nothing and these three
							     children lay out as three squeezed columns with the button cut off. -->
							<div
								role="alert"
								class="mt-3 alert alert-vertical items-start alert-warning"
								data-testid="publish-conflict"
								data-conflict={conflict.reason}
							>
								<p>{conflict.message}</p>
								<p class="text-sm">
									{#if conflict.reason === 'remote-changes' || conflict.reason === 'changes-on-both-sides'}
										<strong>Update from GitHub</strong> is on the navigation bar, beside the Remote status.
									{:else}
										Opening it in a new Workspace is in the Workspace menu at the top left, under
										<strong>Remote repository…</strong>. It leaves this one exactly as it is.
									{/if}
								</p>
								<button
									class="btn btn-sm"
									class:btn-disabled={replacing}
									aria-disabled={replacing}
									data-testid="publish-replace"
									onclick={() => (replacing = true)}
								>
									{replacing ? 'Ready to replace it' : 'Publish anyway, replacing it'}
								</button>
							</div>
						{/if}
						<!--
							The three budgets, stated separately because the two kinds of content load them
							oppositely (ADR-0033): offline Base Map tiles are byte-heavy and file-cheap, and a
							Map Image's pyramid is the other way round. Shown whether or not they warn, so that
							"how many files and how many bytes will this send" is answerable before the button is
							pressed rather than only when something is already wrong.
						-->
						<ul
							class="mt-3 border-t border-rule text-sm tabular-nums [&>li]:py-2 [&>li+li]:border-t [&>li+li]:border-rule"
							data-testid="publish-budget"
						>
							<li data-budget="files">
								{upload.uploads} of {uploadFiles} files need uploading (limit: {MAX_PUBLISHED_FILES}).
							</li>
							<li data-budget="bytes">
								Site size: {describeBytes(upload.bytes)} / {describeBytes(
									STATIC_HOSTING_LIMIT_BYTES
								)} GitHub Pages limit.
							</li>
							<li data-budget="requests">
								{#if upload.requestsRemaining === null}
									Requests this hour: unavailable.
								{:else}
									Requests this hour: {upload.requestsRemaining} left{resetsAt === ''
										? ''
										: `; resets at ${resetsAt}`}.
								{/if}
							</li>
						</ul>
						{#each upload.warnings as warning (warning.kind)}
							<div
								role="alert"
								class="mt-3 alert flex-col items-start alert-warning"
								data-remote-warning={warning.kind}
							>
								<p>{warning.message}</p>
							</div>
						{/each}
						{@render destinationStrip()}
					{/if}
				{/if}
			</footer>
		{/if}

		<!--
			Progress, seen and announced by the same element, from inside the modal so that it is not in
			the inert half of the document while it has something to say. At the foot of the receipt, below
			the destination it is moving to.

			⚠ **Outside every gate above, and unconditionally rendered while the dialog is open.** Flipping
			a Front Page toggle re-plans, which nulls `plan` — gated on the plan this region would be
			removed mid-publish and re-inserted already holding a line, and an `aria-live` region inserted
			together with its first text is not announced, so the rest of that publish would be silent.
			Empty when idle, for the same reason the region outside the dialog is.
		-->
		<p aria-live="polite" aria-atomic="true" class="text-sm" data-testid="publish-progress">
			{progressLine}
		</p>
	</div>

	<!--
		Cancel becomes inert while a publish runs. Once it is offered, Publish stays in the tab order
		while planning, uploading, or waiting on a conflict; the sentence explaining why is on screen.
	-->
	{#snippet actions()}
		<button
			class="btn"
			class:btn-disabled={publishing}
			aria-disabled={publishing}
			onclick={() => {
				if (!publishing) open = false;
			}}
		>
			{nothingToDo ? 'Close' : 'Cancel'}
		</button>
		{#if remote !== null && signedIn}
			<button
				class="btn btn-primary"
				class:btn-disabled={publishing || plan === null || nothingToDo || blockedByConflict}
				aria-disabled={publishing ||
					plan === null ||
					nothingToDo ||
					blockedByConflict ||
					blockedByProblem}
				onclick={run}
			>
				{confirmLabel}
			</button>
		{/if}
	{/snippet}
</ModalDialog>
