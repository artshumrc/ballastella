<script lang="ts">
	import { tick } from 'svelte';

	import { describeRemote, type ReturnLink } from '@ballastella/core';

	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * What a link from a Published Site would do, and the press that does it.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * IT OFFERS; IT DOES NOT ACT
	 *
	 * The whole of why this component exists rather than the route simply calling the engine. A URL
	 * is a thing anyone can send, and one that created a Workspace and switched to it on arrival
	 * would be a link that rearranges a stranger's editor — minutes of downloading and a Workspace
	 * they did not ask for, from a repository they have never heard of. So the offer names the
	 * repository, says what would happen, and waits. Turning it down costs one press and downloads
	 * nothing.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * ONE LINK, TWO ANSWERS, AND THE VOCABULARY IS THE DIFFERENCE
	 *
	 * A Published *Project* carries one “Open in Ballastella” rather than competing Import and Review
	 * links, because the choice between keeping somebody's work and looking at it is a decision to put
	 * in front of a reader once they have arrived, not two links to tell them apart in a navbar. So the
	 * Project invitation raises **both** offers here and names the Workspace an Import would go into,
	 * in words. The whole-repository invitation keeps its single answer: opening a Workspace from
	 * GitHub is one operation, and there is nothing to choose between.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * NOT A DIALOG, AND NOT A CREDENTIAL
	 *
	 * Rendered in the page above whichever screen `?p=` chose, in the shape the sign-in outcome
	 * already uses on that route: a modal would make the rest of the document inert on arrival, which
	 * is a hostile thing for a link to do to somebody who was reading. It stays after the operation
	 * so that its outcome survives the Workspace switch underneath it — the route does not remount,
	 * and the sentence is about the Workspace the visitor has just been moved into.
	 *
	 * ⚠ **Every operation here is unauthenticated and nothing asks for a sign-in.** A student with no
	 * GitHub account is the person this link is most likely to reach, and a credential prompt in front
	 * of it would be the one thing that stops them.
	 */
	let {
		storage,
		link,
		ondismiss
	}: {
		storage: WorkspaceStorage;
		link: ReturnLink;
		/**
		 * Take this offer off the page, and say what the route has to put right behind it.
		 *
		 * `'declined'` was turned down having done nothing; `'finished'` is an operation that left the
		 * visitor in the Workspace it made; `'imported'` names the directory the Project was allocated
		 * in the Workspace they never left.
		 *
		 * The three are not interchangeable to the page underneath: a declined Review leaves a `?p=`
		 * naming a Project this Workspace has not got, a finished one leaves a `?p=` naming the
		 * Project the visitor came to read, and an Import may have allocated a different directory
		 * from the one the link named. The route acts on the difference.
		 */
		ondismiss: (
			outcome: { reason: 'declined' | 'finished' } | { reason: 'imported'; directory: string }
		) => void;
	} = $props();

	/** What the operation did, in the words the user should see, or `''`. */
	let outcome = $state('');
	/** Why it did not happen. Its own state, so a refusal is an alert rather than a status. */
	let problem = $state('');
	/**
	 * Which choice is running, or `''`.
	 *
	 * Which one, rather than merely that one is: both Project choices are on screen together, and a
	 * pair of buttons that both say “Downloading…” does not tell a visitor what they pressed.
	 */
	let running = $state<'' | 'import' | 'accept'>('');
	const busy = $derived(running !== '');
	/** Where an Import put the Project, once one has, so the route can go to it. */
	let importedInto = $state('');
	/**
	 * The line saying what the press did, focused once it does.
	 *
	 * ⚠ **Every choice here unmounts the button that was pressed.** The outcome replaces the whole
	 * offer, so on success focus would land on `<body>` — after minutes of downloading, at the top of
	 * a page that has changed underneath the reader. This line names the Project and the Workspace,
	 * which is the result they came for, and the Close button beside it is the way on.
	 */
	let outcomeLine: HTMLElement | null = $state(null);

	const remote = $derived(describeRemote(link));

	/**
	 * The Workspace an Import would copy into, or `null` when none may be.
	 *
	 * ⚠ **Read live rather than captured when the offer was raised**, which is the opposite of the
	 * hub's Import dialog and for the reason that dialog is modal and this is not: the switcher is
	 * reachable the whole time this is on screen, so a name captured on arrival is a sentence that
	 * quietly stops being true. Reading it here keeps the Workspace named and the Workspace written
	 * to the same one; `importRemoteProject` re-checks it anyway, which is the layer that catches a
	 * switch mid-download.
	 */
	const importTarget = $derived(storage.importTarget);

	/** Run one of the choices, with the busy state and the refusal handling they share. */
	async function choose(
		which: 'import' | 'accept',
		operation: () => Promise<string>
	): Promise<void> {
		if (busy) return;
		outcome = '';
		problem = '';
		running = which;
		try {
			outcome = await operation();
			// See {@link outcomeLine}. After the operation, because the line it focuses is rendered by
			// the same update that closes the offer's own buttons.
			await tick();
			outcomeLine?.focus();
		} catch (cause) {
			problem = cause instanceof Error ? cause.message : String(cause);
		} finally {
			running = '';
		}
	}

	const openWorkspace = (): Promise<void> =>
		choose('accept', async () => {
			if (link.kind !== 'clone') return '';
			// The engine's own sentence, which says which Workspace the visitor is now in — the one
			// thing they cannot work out for themselves after the screen has changed underneath them.
			const { notice } = await storage.openFromGitHub({
				owner: link.owner,
				repository: link.repository
			});
			return notice;
		});

	const review = (): Promise<void> =>
		choose('accept', async () => {
			if (link.kind !== 'review') return '';
			const { notice } = await storage.reviewFrom({
				owner: link.owner,
				repository: link.repository,
				project: link.project
			});
			return notice;
		});

	const importProject = (): Promise<void> =>
		choose('import', async () => {
			const target = importTarget;
			if (link.kind !== 'review' || target === null) return '';
			const done = await storage.importRemoteProject(
				{ owner: link.owner, repository: link.repository, project: link.project },
				target
			);
			importedInto = done.directory;
			// The allocated name, because a Workspace that already held a Project of that name gives
			// the arriving one another — and a scholar who is not told goes looking for the first.
			return (
				`Imported ${done.name} into ${done.workspace}. It is yours to edit now, ` +
				`with no connection back to where it came from.`
			);
		});

	const close = () => {
		landOnTheEditor();
		ondismiss(
			importedInto === '' ? { reason: 'finished' } : { reason: 'imported', directory: importedInto }
		);
	};

	/**
	 * Put focus on the editor itself, because the route is about to take this offer off the page.
	 *
	 * ⚠ **Before `ondismiss`, not after.** The parent unmounts this section in the update that call
	 * causes, and `focus()` on a node that has left the document is a silent no-op — so whatever moved
	 * focus has to move it while the control pressed is still there. `<main>` with `tabIndex = -1` is
	 * this app's settled answer for "the news is done with, look at the work" (`RecoveredEdits`), and
	 * it is on both screens a link can land on.
	 */
	function landOnTheEditor(): void {
		const main = document.querySelector('main');
		if (!(main instanceof HTMLElement)) return;
		main.tabIndex = -1;
		main.focus();
	}
</script>

<!--
	`aria-live="polite"` rather than `role="status"`: the editor's navigation bar already owns the
	page's one status region — the save indicator — and a second would make `getByRole('status')`
	ambiguous across the whole app.
-->
<section
	class="m-4 rounded-box border border-base-300 p-4"
	aria-live="polite"
	data-testid="return-link-offer"
>
	{#if outcome}
		<p bind:this={outcomeLine} tabindex="-1" data-testid="return-link-outcome">{outcome}</p>
		<button class="btn mt-3 btn-sm" data-testid="dismiss-return-link" onclick={close}>Close</button>
	{:else}
		<h2 class="font-semibold">
			{#if link.kind === 'clone'}
				Open a Workspace from GitHub: {remote}?
			{:else}
				Open “{link.project}” from {remote}?
			{/if}
		</h2>
		<p class="mt-1 max-w-prose text-sm opacity-70">
			{#if link.kind === 'clone'}
				You followed a link from a published site. This downloads that whole Workspace into a
				<strong>new Workspace of your own</strong>, which you can then go on working in. Nothing you
				already have is changed, and you do not need a GitHub account. If this computer has already
				opened {remote}, it takes you back to that Workspace instead of downloading a second copy.
				Nothing has been downloaded yet.
			{:else}
				You followed a link from a published site, and there are two things you can do with that
				Project. <strong>Import</strong> copies it into the Workspace you are in as work of your own
				— yours to edit, publish and back up, with no connection back to where it came from.
				<strong>A review copy</strong>
				puts it in a separate throwaway Workspace, so you can look at it without adding it to anything.
				Either way you do not need a GitHub account. Nothing has been downloaded yet.
			{/if}
		</p>

		<div class="mt-3 flex flex-wrap gap-2">
			<!--
				`aria-disabled` for the busy state and never `disabled`: a `disabled` button leaves the tab
				order the moment it is pressed, dropping a keyboard user's focus to `<body>` for the length
				of a download that runs in minutes (WCAG 2.4.3).
			-->
			{#if link.kind === 'review' && importTarget !== null}
				<!--
					⚠ **The destination in words, and it is the primary choice.** A reader who followed a link
					is being asked to keep somebody's work; "this Workspace" would not tell them which one,
					and the switcher is two clicks away.

					**Absent when there is nothing to Import into** — inside a review copy, or over a
					Workspace whose interrupted Import has not been resolved. Reviewing still works, so the
					choice is withheld rather than offered and refused.
				-->
				<button
					class="btn btn-primary btn-sm"
					class:btn-disabled={busy}
					aria-disabled={busy}
					data-testid="import-return-link"
					onclick={() => void importProject()}
				>
					{running === 'import' ? 'Downloading…' : `Import into “${importTarget.name}”`}
				</button>
			{/if}
			<button
				class="btn btn-sm"
				class:btn-primary={link.kind === 'clone'}
				class:btn-disabled={busy}
				aria-disabled={busy}
				data-testid="accept-return-link"
				onclick={() => void (link.kind === 'clone' ? openWorkspace() : review())}
			>
				{#if running === 'accept'}
					Downloading…
				{:else if link.kind === 'clone'}
					Open a Workspace from GitHub
				{:else}
					Open in a review copy
				{/if}
			</button>
			<!--
				Shown as unavailable while the download runs, because it is: no operation here can be
				stopped part way, and a button that looks pressable and answers nothing is worse than one
				that says so.
			-->
			<button
				class="btn btn-sm"
				class:btn-disabled={busy}
				aria-disabled={busy}
				data-testid="dismiss-return-link"
				onclick={() => !busy && (landOnTheEditor(), ondismiss({ reason: 'declined' }))}
			>
				No thanks
			</button>
		</div>

		<!--
			Per-file progress, announced. A Map Image's pyramid is thousands of files over real
			minutes, and this is one of the places a visitor is waiting on something they cannot see.
		-->
		{#if storage.transfer && busy}
			<p class="mt-3 text-sm" data-testid="return-link-progress">
				{storage.transfer.files} of {storage.transfer.totalFiles} files downloaded from
				{storage.transfer.subject}.
			</p>
		{/if}
	{/if}

	{#if problem}
		<!-- The refusals: no such public repository, no Project by that name, a truncated file list, no
		     room to hold it, a Project this Workspace already synchronizes, or one from a newer
		     version. Each has left nothing behind. -->
		<div role="alert" class="mt-3 alert flex-col items-start alert-error">
			<p data-testid="return-link-problem">{problem}</p>
		</div>
	{/if}
</section>
