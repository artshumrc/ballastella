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
	//   2. `stampCanonicalUrl` runs **before** anything is written. Core refuses an address it cannot
	//      make an image service out of and its refusal ends "Nothing has been changed." — and
	//      `scholar.example`, with no scheme, is the ordinary way to arrive there.
	//   3. Progress is announced from **inside** the modal and the result from outside it after a
	//      `tick()`. `showModal()` makes the rest of the document inert, and an inert `aria-live`
	//      region is not a quiet one: it is not announced at all.
	//   4. Neither button is ever `disabled`, and neither is ever removed. A `disabled` button leaves
	//      the tab order the moment it is pressed and a removed one leaves it altogether, and both
	//      drop a keyboard user's focus to `<body>` (SPEC story 60, WCAG 2.4.3). `aria-disabled` and
	//      a guard in the handler say the same thing without moving anybody's focus.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// EVERY STATE OF THE CONTROL LEADS SOMEWHERE, AND NONE OF THEM IS A DISABLED BUTTON
	//
	// Unbound: it publishes locally exactly as it always did, and says where binding lives. Bound with
	// no credential: it asks for the credential, here, rather than sending the user to another dialog
	// — and the confirm button says what pressing it in that state actually does, which is write the
	// website into the Workspace and send it nowhere. Bound with a credential and nothing to do: it
	// says so, and the button is inert beside the sentence saying why. Bound to a Remote somebody else
	// has written to: it names the files, offers Clone and replace, and the button waits for one of
	// them. A disabled Publish button with no explanation is the failure this whole epic exists to
	// remove; the explanation is the part that matters, and it is always on screen.

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
		type PublishPlan,
		type PublishedProject,
		type PublishedSite,
		type RemotePublishPlan
	} from '@ballastella/core';

	import { deploymentRoot } from '../base-map/deployment-assets';
	import ModalDialog from '../components/ModalDialog.svelte';
	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
	import { describePublishProgress, type PublishProgress } from './publish-progress.js';
	import { loadViewerBundle, readBundleAsset } from './viewer-bundle-source';

	let {
		storage,
		open = $bindable(false),
		// Both bindable so the navigation bar's Publish control can be `aria-disabled` with a label
		// that reflects progress while the modal that owns the run is on screen (SPEC stories 59, 60).
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
	 * remembered to ask (ADR-0033, story 40).
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
	/**
	 * Whether the deployment's Base Map display assets (glyphs and sprites) travel with the site.
	 */
	let includeBaseMap = $state(true);
	/** The address the user wants their Map Images to answer at, or `''` (SPEC story 92). */
	let canonicalUrl = $state('');

	/** The credential being pasted, for a Workspace that is bound and not signed in. */
	let token = $state('');
	let signingIn = $state(false);
	/**
	 * What the sign-in found out about pushing, when the answer was that it cannot (story 5).
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
		stamped: number;
		sent: { remote: string; files: number; uploaded: number } | null;
		/** The Remote nothing was sent to, or `''` when there was nothing to send to. */
		notSent: string;
		/** Whether this machine kept its record of what the Remote now holds (ADR-0033). */
		manifestKept: boolean;
	} | null>(null);

	/** The record the Workspace's own Published Site carries, and whether it is behind. */
	let staleness = $state('');

	/** A hydration-stable id for the credential field, for the reason `NavigationBar` documents. */
	const tokenId = $props.id();

	const messageOf = (cause: unknown): string =>
		cause instanceof Error ? cause.message : String(cause);

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
	 * are not in the Workspace. Planned against the folder as it stands, all three of story 9's
	 * numbers understate a *first* publish, which is the publish they exist for, and the request
	 * warning is computed on a count with the whole website missing from it.
	 *
	 * ⚠ **A 401 here is the stale sign-in, and it is what settles ticket 03's carried-over note.**
	 * Rights are read when a Remote is bound and when a token is pasted, at no other moment — so the
	 * bar's "Signed in to GitHub" means *a credential is held*, never *a credential still works*. The
	 * answer taken here is the second of the two the ticket offered: leave the label alone and let the
	 * **refusal** carry it. This is where it arrives, because planning is the first credentialed
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
	 * Work out the plan whenever the dialog opens, and exactly once per opening.
	 *
	 * On open rather than once: see decision 1 in the header. `session` is a dependency so that
	 * switching Workspace with the dialog open re-plans against the Workspace now in front of the
	 * user rather than the one they left.
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
			return;
		}
		if (plannedFor === active) return;
		plannedFor = active;
		reset();
		void planOpening(active, ++planning);
	});

	/** Everything the dialog has to say before it does anything: the record, the plan, the forecast. */
	async function planOpening(active: EditorSession, mine: number): Promise<void> {
		try {
			const bundle = await loadViewerBundle();
			const record = await active.readPublishedSite();
			// Offered back rather than asked for again, exactly as the address below is: a site published
			// without the Base Map's labels is one whose author has already answered this, and a box that
			// reverted to "on" every time the dialog opened would re-add five megabytes to their site
			// whenever they published a typo fix.
			//
			// ⚠ **`baseMapAssetsRequested` and never `baseMapAssetsBundled`.** The second says what was
			// *written*, and a deployment with no Base Map archive writes `false` whatever the box said —
			// so read as the answer it leaves a site first published from such a deployment unticked
			// forever, on every deployment that does have the archive, with no place names on its
			// geography and nothing on screen saying why. A record written before the answer was kept
			// falls back to the old reading, which is the best there is for a record that never carried
			// it.
			const wanted = record?.baseMapAssetsRequested ?? true;
			const planned = await active.planPublish({
				bundle,
				includeBaseMap: wanted,
				editorUrl: deploymentRoot()
			});
			if (mine !== planning) return;
			site = record;
			includeBaseMap = wanted;
			plan = planned;
			staleness =
				record === null
					? ''
					: publishedSiteStaleness(record, {
							viewerVersion: bundle.version,
							projects: active.projects
						});
			// Offered back rather than asked for again: a citable address that changes every time it
			// is re-published is not citable (ADR-0004).
			canonicalUrl = planned.canonicalUrl ?? '';
		} catch (cause) {
			if (mine !== planning) return;
			failure = messageOf(cause);
		}
		if (mine !== planning) return;
		await forecastUpload(plan?.files ?? [], mine);
	}

	/** Re-plan when the Base Map choice changes, so the stated size is the one being agreed to. */
	const chooseBaseMap = async (wanted: boolean) => {
		includeBaseMap = wanted;
		if (!open) return;
		const mine = ++planning;
		try {
			const planned = await session.planPublish({
				bundle: await loadViewerBundle(),
				includeBaseMap: wanted,
				editorUrl: deploymentRoot()
			});
			if (mine !== planning) return;
			plan = planned;
		} catch (cause) {
			if (mine === planning) failure = messageOf(cause);
			return;
		}
		// **And the upload forecast with it**, because the answer moves all three budgets: the Base
		// Map's glyphs are five megabytes and a few hundred blobs, and a request warning that did not
		// follow the checkbox would be a warning about a publish nobody is about to make.
		await forecastUpload(plan?.files ?? [], mine);
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
					`push to it, so publishing will be refused. A fine-grained personal access token with ` +
					`“Contents: Read and write” for this repository is what publishing needs.`;
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
	 * two Base Map flags are the rest of it, and they are read off the *plan* rather than off the
	 * checkbox because a deployment with no Base Map assets writes `false` whatever the box says.
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
	 * Whether pressing the button would change nothing anywhere (SPEC story 15).
	 *
	 * The Remote holding this Workspace already is most of it, and the rest is the two things the
	 * dialog itself can still be asked for: a Base Map choice the site does not carry, and an address
	 * that has been typed over. Said rather than left as a publish that uploads one file — the site
	 * record's timestamp — and reports success.
	 */
	const nothingToDo = $derived(
		upload?.unchanged === true &&
			siteIsCurrent &&
			canonicalUrl.trim() === (plan?.canonicalUrl ?? '')
	);

	/**
	 * How many files the Remote will hold: the Workspace's, and the website about to be written.
	 *
	 * Two numbers on the plan rather than one, because only the first is a list of paths the upload
	 * can read bytes from — see {@link RemotePublishPlan.pending}. Story 9's question is about the
	 * sum, and on a first publish the second half is most of it.
	 */
	const uploadFiles = $derived(upload === null ? 0 : upload.files.length + upload.pending.length);

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
	 * What the confirm button says, which has to be what pressing it does.
	 *
	 * ⚠ **A bound Workspace with no credential publishes into the folder and reaches nobody.** The
	 * paste form and this button are on screen together — the run guards the upload on the credential,
	 * and the button does not — so a plain "Publish" there is the one press in this dialog that reads
	 * as putting the work on the web and does not. It is still offered, because the local publish is
	 * a real thing to want and every state of this control has to lead somewhere.
	 */
	const confirmLabel = $derived(
		publishing
			? 'Publishing…'
			: remote !== null && !signedIn
				? 'Publish into this Workspace only'
				: // Said on the button as well as on the remedy that armed it, because between the two
					// presses is where a scholar looks away — and "Publish" is not what this one does.
					conflict !== null && replacing
					? 'Publish anyway, replacing it'
					: 'Publish'
	);

	const run = async () => {
		const agreed = plan;
		if (!agreed || publishing || nothingToDo || blockedByConflict) return;
		publishing = true;
		failure = '';
		/** Whether the viewer has reached the Workspace, so a later refusal does not deny it. */
		let written = false;
		try {
			// The address is settled **first** — decision 2 in the header. Refused here, nothing has been
			// written and nothing has been sent, which is what its refusal claims.
			const stamped =
				canonicalUrl.trim() === '' ? { images: 0 } : await session.stampCanonicalUrl(canonicalUrl);
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
			let manifestKept = true;
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
				manifestKept = result.manifestKept;
			} else if (bound !== null) {
				// ⚠ **A bound Workspace with no credential publishes locally and reaches nobody**, and the
				// worst instance of it is the one this dialog exists to close: an expired token clears the
				// credential from under the button, so the very next press would otherwise report a
				// successful publish to a scholar who has just been told their sign-in has gone.
				notSent = describeRemote(bound);
			}

			// Closed, and the close applied, *before* the result is set — decision 3 in the header.
			staleness = '';
			open = false;
			await tick();
			published = {
				site: siteWritten,
				files: agreed.files.length,
				stamped: stamped.images,
				sent,
				notSent,
				manifestKept
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
			(published.stamped > 0
				? ` ${published.stamped === 1 ? '1 Map Image' : `${published.stamped} Map Images`} ` +
					`stamped for ${canonicalUrl.trim()}.`
				: '') +
			(sent
				? ` Sent to ${sent.remote}: ${sent.files} files, ${sent.uploaded} of them uploaded.`
				: '') +
			(published.notSent
				? ` Nothing was sent to ${published.notSent}, because you are not signed in to GitHub: ` +
					`your Published Site is exactly as it was. Publish again once you have signed in and ` +
					`this goes there without doing the work twice.`
				: '') +
			// Said rather than swallowed: the publish reached the Remote and this machine's record of
			// what it now holds did not survive, which is what the next publish would otherwise meet as
			// an unexplained "we cannot tell whether somebody else wrote this" (ADR-0033, ticket 05).
			(published.manifestKept
				? ''
				: ` This browser would not keep the record of what ${sent?.remote ?? 'the Remote'} now ` +
					`holds, so the next publish cannot tell your own work there from somebody else's.`)
		);
	});
</script>

<!--
	The result, announced from outside the dialog — where the dialog no longer is by the time this has
	anything to say, because `run` closes it before it sets `published`. Progress is announced from a
	second region inside the modal; see `progressLine`.

	Always rendered, empty when idle: an `aria-live` region inserted at the same moment as its first
	text is not reliably announced.

	`aria-live="polite"` rather than `role="status"`, which would be the idiomatic choice but for the
	save indicator already being this bar's one `status` role — two of them make `getByRole('status')`
	ambiguous, and ADR-0016's own note on this says a test that has to disambiguate is a hint that a
	screen-reader user would have to as well. `aria-atomic` so each update is read as a whole sentence
	rather than as the words that changed.
-->
<p
	aria-live="polite"
	aria-atomic="true"
	class="mt-2 text-sm opacity-80"
	data-testid="publish-status"
>
	{result}
</p>

{#if staleness && !open}
	<div
		aria-live="polite"
		class="mt-2 alert flex-col items-start alert-info"
		data-testid="publish-stale"
	>
		<p>{staleness}</p>
	</div>
{/if}

<!--
	A refusal outlives the dialog it was raised in (ticket 04): it is the one thing on this screen a
	user has to act on, and dismissing the modal is how they get back to the Workspace to act on it.
	Both kinds — a publish that stopped, and an upload that could not even be planned — because a
	scholar who closes the dialog over a truncated tree has exactly the same work to do as one who
	closes it over a spent request budget.
-->
{#if standingRefusal && !open}
	<div
		role="alert"
		class="mt-2 alert flex-col items-start alert-error"
		data-testid="publish-failure"
	>
		<p>{standingRefusal}</p>
	</div>
{/if}

<ModalDialog bind:open title="Publish this Workspace">
	{#if failure}
		<div role="alert" class="alert flex-col items-start alert-error">
			<p>{failure}</p>
		</div>
	{/if}

	{#if plan === null}
		<p>Working out what publishing would add…</p>
	{:else}
		<p>
			An <code>index.html</code> and a read-only viewer are written into your Workspace, beside the
			work already there:
			<strong>{plan.files.length} files, {describeBytes(plan.bytes)}</strong>. Your Map Images are
			not copied — publishing adds a website to the folder you already have.
		</p>
		<p class="mt-2 text-sm opacity-80" data-testid="publish-projects">
			The site will carry {describeProjects(plan.projects)}.
		</p>

		<!--
			Where the Workspace goes afterwards, and what that costs (ADR-0032, ADR-0033).

			Four states, and every one of them leads somewhere: unbound offers the binding, bound and
			signed out offers the paste, a refusal names its remedy, and a Remote that already holds this
			Workspace says so rather than uploading a timestamp and reporting success.
		-->
		<section class="mt-4 rounded-box border border-base-300 p-4">
			<h3 class="font-semibold">Sending it to the web</h3>
			{#if remote === null}
				<p class="mt-1 text-sm" data-testid="publish-unbound">
					This Workspace is not bound to a repository, so publishing writes the website into your
					Workspace and sends it nowhere. To put it on the web, open the Workspace menu at the top
					left and choose <strong>Remote repository…</strong> — one GitHub repository, once, and publishing
					never asks you where again.
				</p>
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
					What the sign-in found out about pushing (story 5). Outside the branches below for the
					same reason the refusal is: it is a fact about the credential now held, and the branch
					that produced it is the one the sign-in has just left.
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
					<form class="mt-3 flex flex-col gap-2" onsubmit={(event) => void signIn(event)}>
						<p class="text-sm" data-testid="publish-sign-in-needed">
							This Workspace publishes to <code>{describeRemote(remote)}</code>, and you are not
							signed in to GitHub. Paste a fine-grained personal access token with “Contents: Read
							and write” for that repository. It is kept only in this tab.
						</p>
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
						<div>
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
				{:else if uploadProblem}
					<!-- Its remedy is not a sign-in: a truncated tree, a repository GitHub cannot show. The
					     message itself names what to do, and there is nothing further to render. -->
				{:else if upload === null}
					<p class="mt-1 text-sm opacity-70">Asking GitHub what it already has…</p>
				{:else if nothingToDo}
					<!--
						⚠ **Before the conflict, and that ordering is the fix to a dead button.** A conflict
						is a statement about *whose* the files on the Remote are, and `unknown` is raised on
						nothing more than "no manifest, and the owned namespace is not empty" — which is the
						state of a Workspace whose Remote matches it byte for byte, the ordinary first press
						after a complete Clone (story 24). Rendered conflict-first, that Workspace was shown a
						refusal, offered a replace that armed and then changed nothing, and left with a
						`aria-disabled` Publish button and the sentence explaining it suppressed. Nothing here
						would change anything anywhere, so there is nothing to refuse and nothing at stake.
					-->
					<p class="mt-1 text-sm" data-testid="publish-nothing-to-do">
						Nothing needs changing. <code>{describeRemote(remote)}</code> already holds this Workspace
						exactly as it is here, so there is nothing to send and your Published Site is up to date.
					</p>
				{:else}
					{#if conflict !== null}
						<!--
							⚠ **The refusal, and both of its remedies, on one screen.** Naming the paths is the
							whole of the reporting — there is no diff and no per-file choosing (SPEC "Out of
							scope" item 3) — and the two ways on are Clone or replace, never a merge. The second
							is a two-step: this button only *arms* it, and the confirm button below then says
							what pressing it does. That is `ProjectHub`'s deletion pattern, for its reason.

							⚠ **Beside the budgets rather than instead of them.** A conflict is where the
							replacement tree is largest and where the scholar is being asked to press through a
							warning, so it is the worst possible moment to be the one state that hides story 9's
							two numbers, the hosting cliff and the hourly request budget.
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
								Cloning is in the Workspace menu at the top left, under <strong
									>Remote repository…</strong
								>. It makes a new Workspace and leaves this one exactly as it is.
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
					<p class="mt-1 text-sm">
						Publishing sends this Workspace to <code>{describeRemote(remote)}</code>, on the branch
						<code>{remote.branch}</code>, and nowhere else.
					</p>
					<!--
					The three budgets, stated separately because the two kinds of content load them
					oppositely (ADR-0033): offline Base Map tiles are byte-heavy and file-cheap, and a
					Map Image's pyramid is the other way round. Shown whether or not they warn, so
					that "how many files and how many bytes will this send" is answerable before the button
					is pressed rather than only when something is already wrong (SPEC story 9).
				-->
					<ul class="mt-2 list-disc pl-5 text-sm opacity-80" data-testid="publish-budget">
						<li data-budget="files">
							{upload.uploads} of {uploadFiles} files need uploading; the rest are already there. A publish
							can carry {MAX_PUBLISHED_FILES} files at most.
						</li>
						<li data-budget="bytes">
							The site will hold {describeBytes(upload.bytes)}, of the
							{describeBytes(STATIC_HOSTING_LIMIT_BYTES)} GitHub Pages will serve.
						</li>
						<li data-budget="requests">
							{#if upload.requestsRemaining === null}
								GitHub did not say how much of this hour's request budget is left.
							{:else}
								GitHub allows {upload.requestsRemaining} more requests this hour{resetsAt === ''
									? ''
									: `, and the budget resets at ${resetsAt}`}.
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
				{/if}
			{/if}
		</section>

		<label class="mt-4 flex items-start gap-3">
			<input
				type="checkbox"
				class="checkbox mt-1"
				checked={includeBaseMap}
				onchange={(event) => chooseBaseMap(event.currentTarget.checked)}
			/>
			<span>
				Include Base Map labels and symbols
				<span class="block text-sm opacity-70">
					The Base Map tiles still need a network connection; no tile archive ships with
					Ballastella.
				</span>
			</span>
		</label>

		<label class="floating-label mt-6">
			<span>Address your Map Images will be published at (optional)</span>
			<input
				class="input w-full"
				bind:value={canonicalUrl}
				placeholder="https://your-name.github.io/your-repository"
			/>
		</label>
		<p class="mt-2 text-sm opacity-70">
			Fill this in and each Map Image becomes a real IIIF image service at that address, which
			Allmaps and other tools can read directly. Your Projects keep working here either way.
		</p>

		<!--
			⚠ **`aria-live` and never `role="status"` on this bar's screens.** The save indicator owns the
			one `status` role in the editor, and a second one — even inside an open modal, where Playwright
			matches roles off the DOM rather than off the accessibility tree — makes `getByRole('status')`
			ambiguous, which is acceptance criterion 2 in as many words. The Base Map's size is a report
			rather than a refusal, so it is polite rather than assertive; every other warning here is an
			`alert` and stays one.
		-->
		{#each plan.warnings as warning (warning.kind)}
			<div
				role={warning.kind === 'base-map-size' ? undefined : 'alert'}
				aria-live={warning.kind === 'base-map-size' ? 'polite' : undefined}
				class="mt-4 alert flex-col items-start"
				class:alert-warning={warning.kind !== 'base-map-size'}
				class:alert-info={warning.kind === 'base-map-size'}
				data-warning={warning.kind}
			>
				<p>{warning.message}</p>
			</div>
		{/each}
	{/if}

	<!--
		Progress, seen and announced by the same element, from inside the modal so that it is not in
		the inert half of the document while it has something to say. Always rendered and empty when
		idle, for the same reason the region outside is.
	-->
	<p aria-live="polite" aria-atomic="true" class="mt-4" data-testid="publish-progress">
		{progressLine}
	</p>

	<!--
		⚠ **Neither button is ever `disabled`, and neither is ever removed** — decision 4 in the header,
		applied to both. A `disabled` button leaves the tab order the moment it is pressed and a removed
		one leaves it altogether, and both drop a keyboard user's focus to `<body>` (SPEC story 60, WCAG
		2.4.3). Cancel becomes inert while a publish runs, and Publish while there is nothing to do — and
		in both cases the sentence saying why is on screen above.
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
		<button
			class="btn btn-primary"
			class:btn-disabled={publishing || plan === null || nothingToDo || blockedByConflict}
			aria-disabled={publishing || plan === null || nothingToDo || blockedByConflict}
			onclick={run}
		>
			{confirmLabel}
		</button>
	{/snippet}
</ModalDialog>
