<script lang="ts">
	import { describeRemote, describeTokenProblem, parseRemoteReference } from '@ballastella/core';

	import ModalDialog from './ModalDialog.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * Which repository this Workspace publishes to, and the credential that may push to it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * WHY THIS IS ITS OWN DIALOG AND NOT A SECTION OF WORKSPACE SETTINGS
	 *
	 * Workspace settings answers *where your work is kept and what may be done to it* — a question
	 * about this machine. This one answers *where your work goes when you publish it*, which is a
	 * question about the web, and it is the one a scholar comes looking for by name. Keeping the two
	 * apart is also what keeps a first visit clear of any of it: nothing here renders anywhere until
	 * the user opens this dialog, so somebody who never publishes is never shown a sign-in prompt
	 * (SPEC story 38).
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * THE TOKEN IS CHECKED TWICE, CHEAPLY THEN PROPERLY
	 *
	 * `describeTokenProblem` catches the paste that went wrong — an empty clipboard, half a token, a
	 * repository address in the wrong field — with no request at all, and says which. GitHub catches
	 * the rest, at the moment of binding, because whether a token is any good is a question only
	 * GitHub can answer. Either way a refused credential is **not kept**: `WorkspaceStorage.bindRemote`
	 * writes it only after GitHub has answered.
	 *
	 * Every explanation is visible text rather than a tooltip: daisyUI renders tooltips through CSS
	 * `::before`, so they are neither announced nor dismissable (ADR-0016, SPEC story 111).
	 */
	let { open = $bindable(false), storage }: { open?: boolean; storage: WorkspaceStorage } =
		$props();

	/**
	 * Hydration-stable ids, for the reason `NavigationBar` documents about its own.
	 *
	 * One `$props.id()` suffixed three ways, because Svelte allows exactly one call per component —
	 * and `for`/`id` is the whole of what ties a label to its field for a screen reader.
	 */
	const fieldId = $props.id();
	const repositoryId = `${fieldId}-repository`;
	const tokenId = `${fieldId}-token`;
	const signInTokenId = `${fieldId}-sign-in-token`;

	let repository = $state('');
	let token = $state('');
	let signInToken = $state('');
	/** Whether a request is in flight, so the button cannot be pressed twice. */
	let working = $state(false);
	/** What the last action did, in the words the user should see. */
	let outcome = $state('');
	/** Why the last action did not happen. Its own state so it can be an alert. */
	let problem = $state('');
	/**
	 * Sentences the binding succeeded *with*: a credential that cannot push, and Pages left off.
	 *
	 * Separate from {@link problem} because neither is a failure — the binding stands in both cases —
	 * and rendering them as errors would tell a scholar their Workspace is not bound when it is.
	 */
	let notices = $state<string[]>([]);

	const bound = $derived(storage.remote);

	/**
	 * A repository name to prefill `github.com/new` with (story 8).
	 *
	 * The Workspace's own name, put through the character set GitHub allows in a repository name. The
	 * one step the tool does not do is still a short one when the field arrives filled in.
	 */
	const suggestedName = $derived(
		storage.name
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '-')
			.replace(/^[-.]+|[-.]+$/g, '') || 'my-workspace'
	);
	const createRepositoryHref = $derived(
		`https://github.com/new?name=${encodeURIComponent(suggestedName)}`
	);

	function reset(): void {
		outcome = '';
		problem = '';
		notices = [];
	}

	async function bind(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		reset();

		const reference = parseRemoteReference(repository);
		if (reference === null) {
			problem =
				`“${repository.trim()}” is not a repository address. It looks like “owner/repository” — ` +
				`the two parts after github.com in your browser's address bar — and the whole of that ` +
				`address works too.`;
			return;
		}
		const tokenProblem = describeTokenProblem(token);
		if (tokenProblem) {
			problem = tokenProblem;
			return;
		}

		working = true;
		try {
			const result = await storage.bindRemote(reference, token.trim());
			// Cleared only on success. A refused paste stays in the field, because pasting an
			// eighty-two-character token again to fix a one-character mistake is not a remedy.
			token = '';
			repository = '';
			outcome =
				`This Workspace is bound to ${describeRemote(result.binding)}. Publishing will send it ` +
				`there, and nowhere else.`;
			notices = [
				...(result.rightsNotice ? [result.rightsNotice] : []),
				...(result.pages.instruction ? [result.pages.instruction] : [])
			];
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	async function signIn(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		reset();

		const tokenProblem = describeTokenProblem(signInToken);
		if (tokenProblem) {
			problem = tokenProblem;
			return;
		}

		working = true;
		try {
			const rights = await storage.signIn(signInToken.trim());
			signInToken = '';
			outcome = 'Signed in to GitHub. Your sign-in is forgotten when this tab closes.';
			notices = rights.canPush
				? []
				: [
						`This token reaches ${bound ? describeRemote(bound) : 'the repository'} but cannot ` +
							`push to it, so publishing will be refused. A fine-grained personal access token ` +
							`with “Contents: Read and write” for this repository is what publishing needs.`
					];
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			working = false;
		}
	}

	function signOut(): void {
		reset();
		storage.signOut();
		outcome = 'Signed out of GitHub. Nothing on this computer or on GitHub has been changed.';
	}

	async function unbind(): Promise<void> {
		reset();
		const was = bound;
		try {
			await storage.unbindRemote();
			outcome =
				`This Workspace no longer publishes to ${was ? describeRemote(was) : 'a repository'}. ` +
				`Nothing there has been changed — the site is exactly as it was, and binding again puts ` +
				`things back.`;
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

<ModalDialog bind:open title="Remote repository" wide>
	<div class="flex flex-col gap-4">
		<section class="rounded-box border border-base-300 p-4">
			<h3 class="font-semibold">Where this Workspace publishes</h3>

			{#if storage.review !== null}
				<!--
					ADR-0024, SPEC story 39: somebody else's work is never published to your own address.
					Said in visible text rather than left as an absent control with no explanation — and
					refused in `packages/core` as well, so a guard that lives in markup is not the only one.
				-->
				<p class="mt-3 text-sm text-warning" data-testid="no-remote-in-review">
					This is a review copy of somebody else's Project, so it cannot be bound to a repository
					and no GitHub sign-in is readable while it is open. Go back to your own Workspace first.
				</p>
			{:else if bound}
				<p class="mt-1 text-sm opacity-70">
					Publishing sends this Workspace to
					<code data-testid="bound-remote">{describeRemote(bound)}</code>, on the branch
					<code>{bound.branch}</code>, and nowhere else.
				</p>
				<div class="mt-3 flex flex-wrap gap-2">
					<button
						class="btn btn-outline btn-sm btn-warning"
						data-testid="unbind-remote"
						disabled={working}
						onclick={() => unbind()}
					>
						Unbind from {describeRemote(bound)}
					</button>
				</div>
				<p class="mt-3 text-sm opacity-70">
					Unbinding only makes this computer forget the address. Nothing on GitHub is deleted and
					your published site goes on serving.
				</p>
			{:else}
				<p class="mt-1 text-sm opacity-70">
					One GitHub repository, once, for the whole Workspace. Afterwards publishing never asks you
					where.
				</p>
				<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void bind(event)}>
					<div class="flex flex-col gap-1">
						<label class="text-sm font-medium" for={repositoryId}>Repository</label>
						<input
							id={repositoryId}
							class="input w-full max-w-md input-sm"
							bind:value={repository}
							data-testid="remote-repository-field"
							placeholder="owner/repository"
							autocomplete="off"
							spellcheck="false"
						/>
						<p class="text-sm opacity-70">
							It has to be public. Do not have one yet?
							<!-- The one step the tool does not take, made short: the name arrives filled in.

							     `resolve()` is for this app's own routes; github.com is not one, so the rule
							     is disabled here for the one case it does not cover. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								class="link"
								href={createRepositoryHref}
								rel="noreferrer noopener"
								target="_blank"
								data-testid="create-repository"
							>
								Create “{suggestedName}” on GitHub
							</a>
							<!-- eslint-enable svelte/no-navigation-without-resolve -->
							, choose <strong>Public</strong>, then come back here and paste its address.
						</p>
					</div>
					<div class="flex flex-col gap-1">
						<label class="text-sm font-medium" for={tokenId}>Personal access token</label>
						<input
							id={tokenId}
							class="input w-full max-w-md input-sm"
							type="password"
							bind:value={token}
							data-testid="remote-token-field"
							autocomplete="off"
							spellcheck="false"
						/>
						<p class="text-sm opacity-70">
							A fine-grained personal access token with “Contents: Read and write” and “Pages: Read
							and write” for that repository. It is checked the moment you press the button, kept
							only in this tab, and forgotten when you close it.
						</p>
					</div>
					<div>
						<button
							class="btn btn-primary btn-sm"
							type="submit"
							data-testid="bind-remote"
							disabled={working}
						>
							{working ? 'Asking GitHub…' : 'Bind this Workspace'}
						</button>
					</div>
				</form>
			{/if}
		</section>

		<!--
			⚠ **Signed in *or* bound, and the first half is what makes story 37 performable.** Gated on
			the binding alone, unbinding took the only Sign out button off the screen while
			`unbindRemote` deliberately left the credential alive — so "forget the credential, so this
			machine can be handed to somebody" became unreachable, and the token stayed in the tab for
			the rest of the session.

			It also reads the seal correctly for a Review Workspace, without asking about one: the
			credential store answers `null` while a review copy is open (ADR-0033, story 40), so
			`signedIn` is false and a review copy is unbound, and this whole section is therefore absent
			from one — *because* the seal holds rather than because a condition remembered to say so.
		-->
		{#if storage.signedIn || bound}
			<section class="rounded-box border border-base-300 p-4">
				<h3 class="font-semibold">Your GitHub sign-in</h3>
				{#if storage.signedIn}
					<p class="mt-1 text-sm opacity-70" data-testid="remote-signed-in">
						Signed in to GitHub. The sign-in survives a reload and is forgotten when this tab
						closes, so a shared machine keeps no credential.
					</p>
					<div class="mt-3 flex flex-wrap gap-2">
						<button class="btn btn-sm" data-testid="remote-sign-out" onclick={() => signOut()}>
							Sign out
						</button>
					</div>
				{:else}
					<p class="mt-1 text-sm opacity-70">
						Not signed in, so nothing can be published yet. Paste a token to sign in again.
					</p>
					<form class="mt-3 flex flex-col gap-3" onsubmit={(event) => void signIn(event)}>
						<div class="flex flex-col gap-1">
							<label class="text-sm font-medium" for={signInTokenId}>Personal access token</label>
							<input
								id={signInTokenId}
								class="input w-full max-w-md input-sm"
								type="password"
								bind:value={signInToken}
								data-testid="remote-sign-in-field"
								autocomplete="off"
								spellcheck="false"
							/>
						</div>
						<div>
							<button
								class="btn btn-primary btn-sm"
								type="submit"
								data-testid="remote-sign-in"
								disabled={working}
							>
								{working ? 'Asking GitHub…' : 'Sign in'}
							</button>
						</div>
					</form>
				{/if}
			</section>
		{/if}

		<!--
			What happened, announced. `aria-live="polite"` rather than `role="alert"` for the outcome,
			which is CONTRIBUTING's mandated method for a status; the refusal below is inserted at the
			moment its text first exists, which a polite region does not reliably announce (story 112).
		-->
		<p aria-live="polite" class="text-sm" data-testid="remote-outcome">{outcome}</p>
		{#each notices as notice (notice)}
			<div role="status" class="alert flex-col items-start alert-warning">
				<p data-testid="remote-notice">{notice}</p>
			</div>
		{/each}
		{#if problem}
			<div role="alert" class="alert flex-col items-start alert-warning">
				<p data-testid="remote-problem">{problem}</p>
			</div>
		{/if}
	</div>

	{#snippet actions()}
		<button class="btn" data-testid="close-remote-settings" onclick={() => (open = false)}>
			Close
		</button>
	{/snippet}
</ModalDialog>
