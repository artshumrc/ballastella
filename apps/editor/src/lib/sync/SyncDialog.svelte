<script lang="ts">
	import { tick } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';

	import {
		MAX_SENT_FILES,
		RemoteSendCredentialError,
		STATIC_HOSTING_LIMIT_BYTES,
		count,
		describeBytes,
		describeOutboundRemovals,
		describeChanges,
		describeRemote,
		describeSyncPlan,
		describeTokenProblem,
		messageOf,
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

	import Alert from '../components/Alert.svelte';
	import BusyButton from '../components/BusyButton.svelte';
	import ModalDialog from '../components/ModalDialog.svelte';
	import TokenField from '../components/TokenField.svelte';
	import { connectSequence } from '../connect-sequence.svelte.js';
	import type { EditorSession } from '../editor-session.svelte.js';
	import Toast from '../toasts/Toast.svelte';
	import { SyncFailure, type SyncOutcome } from '../remote.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';
	import { describeSyncProgress, type SyncProgress } from './sync-progress.js';

	let {
		storage,
		open = $bindable(false),
		syncing = $bindable(false),
		progress = $bindable<SyncProgress | null>(null),
		restoreFocusTo,
		onrepositorysettings
	}: {
		storage: WorkspaceStorage;
		open?: boolean;
		syncing?: boolean;
		progress?: SyncProgress | null;
		restoreFocusTo?: () => HTMLElement | null | undefined;
		onrepositorysettings?: () => void;
	} = $props();

	const session = $derived(storage.session);
	const remote = $derived(storage.remote.bound);
	const signedIn = $derived(storage.github.signedIn);
	let plan = $state<PublishedSitePlan | null>(null);
	let site = $state<PublishedSite | null>(null);
	let upload = $state<RemoteSendPlan | null>(null);
	let problem = $state('');
	let canSend = $state<boolean | null>(null);
	let overwriteAgreed = $state(false);
	let outbound = $state<OutboundDeletionPreview | null>(null);
	let askingSharing = $state(false);
	let alignmentQuestions = $state<readonly AlignmentQuestion[]>([]);
	const alignmentChoices = new SvelteMap<string, AlignmentChoice>();
	let failure = $state('');
	let plannedProjectKey = '';
	let running = $state<SyncMode | null>(null);
	let token = $state('');
	let signingIn = $state(false);
	let rightsNotice = $state('');

	let done = $state<SyncOutcome | null>(null);
	let staleness = $state('');

	const describeWhen = (at: Date): string =>
		at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	const projectStateKey = (projects: readonly ProjectSummary[]): string =>
		projects
			.map(
				(project) =>
					`${project.directory}\u0000${project.name}\u0000${project.onFrontPage}\u0000${project.problem}`
			)
			.join('\u0001');

	const forget = () => {
		plan = null;
		site = null;
		canSend = null;
		upload = null;
		problem = '';
		overwriteAgreed = false;
		outbound = null;
		askingSharing = false;
		progress = null;
		rightsNotice = '';
		alignmentQuestions = [];
		alignmentChoices.clear();
	};

	const reset = () => {
		forget();
		failure = '';
		done = null;
	};

	let plannedFor: EditorSession | null = null;
	let shownFor: EditorSession | null = null;
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
		void readBothSides(++planning);
	});

	async function readBothSides(mine: number): Promise<void> {
		if (storage.remote.bound === null) return;
		try {
			const read = await storage.remote.planSync();
			if (mine !== planning) return;
			alignmentQuestions = read.questions;
			site = read.site;
			plan = read.plan;
			canSend = read.canSend;
			upload = read.forecast;
			staleness = read.staleness;
		} catch (cause) {
			if (cause instanceof RemoteSendCredentialError) storage.github.signOut();
			if (mine !== planning) return;
			problem = messageOf(cause);
		}
	}

	const projectNames = $derived(
		new Map(session.projects.map((project) => [project.directory, project.name]))
	);

	const sync = $derived<SyncPlan | null>(
		upload === null ? null : describeSyncPlan(upload, projectNames)
	);

	const anythingIn = (column: SyncColumn): boolean =>
		column.added.length + column.changed.length + column.removed.length > 0;

	const parts = (column: SyncColumn, testid: string) => [
		{ heading: 'New', changes: column.added },
		{ heading: 'Changed', changes: column.changed },
		{ heading: 'Removals', changes: column.removed, testid: `${testid}-removals` }
	];

	const siteIsCurrent = $derived(
		plan === null ||
			(site !== null &&
				staleness === '' &&
				site.baseMapBundled === plan.baseMapBundled &&
				site.baseMapAssetsBundled === plan.baseMapAssetsBundled)
	);

	const somethingToGet = $derived(sync !== null && anythingIn(sync.toGet));
	const somethingToSend = $derived(upload !== null && (!upload.unchanged || !siteIsCurrent));

	const nothingToDo = $derived(
		sync !== null && !somethingToGet && !somethingToSend && sync.conflicts.length === 0
	);

	const somethingToResolve = $derived(sync !== null && sync.conflicts.length > 0);

	const contested = $derived<readonly Change[]>(
		sync === null
			? []
			: describeChanges(
					sync.conflicts.map((row) => row.path),
					projectNames
				)
	);

	const askToOverwrite = async () => {
		const forecast = upload;
		const bound = storage.remote.bound;
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
			const sharing = await storage.remote.readSharing().catch(() => ({
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

	const run = async (mode: SyncMode) => {
		if (syncing || remote === null) return;
		if (mode !== 'get' && (!signedIn || canSend !== true)) return;
		if (mode === 'overwrite' && !overwriteAgreed) return;
		running = mode;
		syncing = true;
		failure = '';
		try {
			const outcome = await storage.remote.sync(mode, {
				site: plan,
				overwrite: upload?.overwrites ?? [],
				alignmentChoices,
				onProgress: (seen) => (progress = seen)
			});
			staleness = '';
			open = false;
			await tick();
			done = outcome;
		} catch (cause) {
			const stopped = cause instanceof SyncFailure ? cause : new SyncFailure(cause, false, false);
			if (stopped.cause instanceof RemoteSendCredentialError) storage.github.signOut();
			failure =
				stopped.message +
				(stopped.got
					? ` What GitHub had was brought in first and is still here; nothing has been sent.`
					: '') +
				(stopped.written
					? ` The website itself was written into this Workspace, so syncing again sends it ` +
						`without doing that work twice.`
					: '');
		} finally {
			running = null;
			syncing = false;
			progress = null;
			if (open) {
				forget();
				void readBothSides(++planning);
			}
		}
	};

	const beginSignIn = () => {
		problem = connectSequence.beginSignIn(storage.github, true);
	};

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
		const bound = storage.remote.bound;
		try {
			const rights = await storage.remote.signIn(token.trim());
			token = '';
			rightsNotice = rights.canPush
				? ''
				: `This token reaches ${bound ? describeRemote(bound) : 'the repository'} but cannot ` +
					`push. Use a fine-grained token with “Contents: Read and write” for this repository.`;
			forget();
			await readBothSides(++planning);
		} catch (cause) {
			problem = messageOf(cause);
		} finally {
			signingIn = false;
		}
	};

	const siteBreakdown = $derived.by(() => {
		const files = plan?.files ?? [];
		const mapImages = plan?.mapImages ?? { files: 0, bytes: 0 };
		const row = (label: string, baseMap: boolean) => {
			const of = files.filter((file) => file.path.startsWith('base-map/') === baseMap);
			return { label, files: of.length, bytes: of.reduce((total, file) => total + file.bytes, 0) };
		};
		const baseMap = row('Base Map labels and symbols', true);
		return {
			totalFiles: files.length + mapImages.files,
			totalBytes: (plan?.bytes ?? 0) + mapImages.bytes,
			rows: [
				...(mapImages.files > 0 ? [{ label: 'Map Images', ...mapImages }] : []),
				row('Viewer and site data', false),
				...(baseMap.files > 0 ? [baseMap] : [])
			]
		};
	});

	const progressLine = $derived(describeSyncProgress(progress));
	const standingRefusal = $derived(failure || problem);

	const resetsAt = $derived(
		sync?.budget.resetsAt
			? sync.budget.resetsAt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
			: ''
	);

	const result = $derived.by(() => {
		if (!done) return '';
		const got = done.got;
		const sent = done.sent;
		return (
			(got === null
				? ''
				: `Brought in ${count(got.added.length, 'new file')} and ${count(got.replaced.length, 'changed file')}` +
					`${got.removed.length === 0 ? '' : `, and removed ${count(got.removed.length, 'file')} GitHub no longer has`}.`) +
			(sent
				? `${got === null ? '' : ' '}Sent to ${sent.remote}: ${sent.files} files, ` +
					`${sent.uploaded} of them uploaded` +
					`${sent.site === null ? '' : `, carrying ${count(sent.site.projects.length, 'Project')}`}.`
				: '') +
			(done.baselineKept
				? ''
				: ` This browser would not keep the record of what ${sent?.remote ?? 'the repository'} now ` +
					`holds, so the next Sync cannot tell your own work there from somebody else's.`)
		);
	});
</script>

<!-- Outside the <dialog>: showModal() makes the rest inert, and inert live regions are silent. -->
<Toast text={result} testid="sync-status" tone="info" />
<Toast text={open ? '' : staleness} testid="sync-stale" tone="info" />
<Toast text={open ? '' : standingRefusal} testid="sync-failure" tone="error" refusal />

{#snippet changeList(changes: readonly Change[], className = 'text-sm')}
	<ul class={className}>
		{#each changes as change (change.kind + change.id)}
			<li class="flex items-baseline justify-between gap-4 py-1">
				<span class="min-w-0 break-words">{change.name}</span>
				<span class="shrink-0 tabular-nums opacity-70">{count(change.files, 'file')}</span>
			</li>
		{/each}
	</ul>
{/snippet}

{#snippet column(column: SyncColumn, testid: string, heading: string, where: string)}
	<section class="min-w-0 flex-1" data-testid={testid}>
		<h3 class="font-semibold">{heading}</h3>
		<p class="mt-1 text-sm opacity-70">{where}</p>
		{#if !anythingIn(column)}
			<p class="mt-3 text-sm" data-testid="{testid}-nothing">Nothing.</p>
		{:else}
			{#each parts(column, testid) as part (part.heading)}
				{#if part.changes.length > 0}
					<h4
						class={['mt-3 text-sm font-medium', !part.testid && 'opacity-70']}
						data-testid={part.testid}
					>
						{part.heading}
					</h4>
					{@render changeList(part.changes)}
				{/if}
			{/each}
		{/if}
	</section>
{/snippet}

<ModalDialog bind:open wide title="Sync with GitHub" {restoreFocusTo}>
	<div class="mx-auto flex w-full max-w-[46rem] flex-col gap-6" data-testid="sync-modal">
		<Alert text={failure} tone="error" />
		<Alert text={rightsNotice} testid="sync-no-push" />

		{#if remote !== null}
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
						onrepositorysettings?.();
					}}
				>
					Repository settings…
				</button>
			</p>
		{/if}

		<Alert text={problem} testid="sync-problem" tone="error" />

		{#if remote === null}
			<p data-testid="sync-unbound">
				This Workspace belongs to no repository yet. <strong>Sync with GitHub</strong> on the bar connects
				it to one.
			</p>
		{:else}
			{#if !signedIn && storage.github.signInWithGitHubOffered}
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
			{:else if !signedIn}
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
						<TokenField
							bind:value={token}
							testid="sync-token-field"
							class="min-w-0 grow basis-72"
						/>
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
			{#if !problem && sync === null}
				<p class="flex items-center gap-2 text-sm opacity-70" data-testid="sync-reading">
					<span aria-hidden="true" class="loading loading-xs loading-spinner"></span>
					Reading <code>{describeRemote(remote)}</code> and this Workspace…
				</p>
			{:else if !problem && sync !== null}
				{#if nothingToDo}
					<p data-testid="sync-nothing-to-do">
						Nothing needs changing. <code>{describeRemote(remote)}</code> holds this Workspace exactly
						as it is here.
					</p>
				{/if}

				{#if plan !== null}
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
							{#each siteBreakdown.rows as row (row.label)}
								<dt class="pe-6">{row.label}</dt>
								<dd class="pe-6 text-right tabular-nums opacity-70">{row.files} files</dd>
								<dd class="text-right font-medium tabular-nums">{describeBytes(row.bytes)}</dd>
							{/each}
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
					<Alert tone="info" testid="sync-read-only">
						<p>
							Your GitHub account can read <code>{describeRemote(remote)}</code> but cannot write to it,
							so this Workspace can take its changes and not send any. Ask whoever owns it for write access
							if you need to send.
						</p>
					</Alert>
				{/if}

				{#if contested.length > 0}
					<div class="alert alert-vertical items-start alert-info" data-testid="sync-conflicts">
						<p>
							{contested.length === 1 ? 'One thing has' : `${contested.length} things have`} changed both
							here and on <code>{describeRemote(remote)}</code> since the two last agreed. Getting
							brings GitHub's version in beside your own, named
							<strong>(from GitHub)</strong>, so you can look at both and delete the one you do not
							want. Nothing is combined and nothing of yours is replaced.
						</p>
						{@render changeList(contested)}
					</div>
				{/if}

				{#each alignmentQuestions as question (question.path)}
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
					<section data-testid="sync-overwrite-removals">
						<h3 class="text-sm font-medium opacity-70">
							Overwriting the repository would also remove
						</h3>
						{@render changeList(sync.overwrites, 'mt-1 text-sm')}
					</section>
				{/if}

				{#if outbound !== null && !overwriteAgreed}
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

		<p aria-live="polite" aria-atomic="true" class="text-sm" data-testid="sync-progress">
			{progressLine}
		</p>
	</div>

	{#snippet actions()}
		<BusyButton busy={syncing} class="btn" onclick={() => (open = false)}>
			{nothingToDo ? 'Close' : 'Cancel'}
		</BusyButton>
		{#if remote !== null && sync !== null}
			<BusyButton
				busy={syncing || !(somethingToGet || somethingToResolve)}
				class="btn"
				data-testid="sync-get"
				onclick={() => run('get')}
			>
				{running === 'get' ? 'Getting…' : 'Get changes'}
			</BusyButton>
			{#if signedIn && canSend === true}
				<BusyButton
					busy={syncing || !somethingToSend}
					class="btn"
					data-testid="sync-send"
					onclick={() => run('send')}
				>
					{running === 'send' ? 'Sending…' : 'Send changes'}
				</BusyButton>
				<BusyButton
					busy={syncing || !(somethingToGet || somethingToSend)}
					class="btn btn-primary"
					data-testid="sync-both"
					onclick={() => run('both')}
				>
					{running === 'both' ? 'Syncing…' : 'Get and send'}
				</BusyButton>
				{#if overwriteAgreed}
					<BusyButton
						busy={syncing}
						class="btn btn-warning"
						data-testid="sync-overwrite"
						onclick={() => run('overwrite')}
					>
						{running === 'overwrite' ? 'Overwriting…' : 'Overwrite the repository'}
					</BusyButton>
				{:else}
					<BusyButton
						busy={syncing || askingSharing}
						class="btn"
						data-testid="sync-arm-overwrite"
						onclick={askToOverwrite}
					>
						{askingSharing ? 'Asking GitHub…' : 'Overwrite the repository'}
					</BusyButton>
				{/if}
			{/if}
		{/if}
	{/snippet}
</ModalDialog>
