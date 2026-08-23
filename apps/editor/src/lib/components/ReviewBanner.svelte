<script lang="ts">
	// "You are inside a review copy", on every screen, with every exit out of it
	// (ticket 14, ADR-0024, ADR-0037, workspace-and-layers SPEC stories 92–94).
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// WHY THIS IS IN THE LAYOUT AND NOT ON THE HUB
	//
	// ADR-0024: "Review is an action, not a mode you toggle. A setting is something a user can forget
	// they are inside, and the failure that creates is an afternoon's real work done in a Workspace
	// built to be thrown away."
	//
	// A banner that appeared only on the hub would *be* that setting. The screens a user forgets where
	// they are on are the working ones — the Project screen with a map on it, and the alignment route
	// with a sheet half placed — because those are the screens they spend an hour inside without
	// looking at anything that names the Workspace. So this is mounted by the root layout, beside
	// `NavigationBar` and `RecoveredEdits`, which is what makes "every screen" a structural fact
	// rather than three components that were each remembered.
	//
	// **Visible text rather than a badge, a tint, or an icon** (workspace-and-layers SPEC story 111). "Review copy" in a
	// coloured stripe is unreadable to a screen reader and ambiguous to everybody else; the sentence
	// says whose work this is, that nothing here reaches the user's own Workspace unless they ask for
	// it, and what the buttons do.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// THREE EXITS, AND WHY THE THIRD IS NOT A "PROMOTE"
	//
	// Back to your own Workspace, discard this one, and — since ADR-0037 — **Import**. There is still
	// no "promote" and no "merge": under ADR-0023 there is one Alignment per Map Image in a Workspace,
	// so nothing may lay a reviewed Project over the user's own shared pool. Import does not; it copies
	// the reviewed Project into the ordinary Workspace review began from, giving every incoming Map
	// Image a *fresh* identity, so no Alignment of theirs is touched and what arrives is a distinct
	// Map Image rather than a claim about one they already have.
	//
	// ⚠ **Both consequences are said before the confirmation, because both of them surprise people.**
	// A reviewer who has spent an hour aligning a colleague's sheet is copying *that*, not the file
	// they were sent — and the Workspace they are looking at is deleted afterwards. Neither is
	// recoverable by pressing something else, so neither may be discovered afterwards.
	//
	// ⚠ **The destination is named, and it is the Workspace review *began* from.** It is read off the
	// mark, which was written before the first Project byte landed, so a reviewer who has wandered
	// between Workspaces since is told where the copy is going rather than being followed.

	import { tick } from 'svelte';

	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { describeReviewSubject } from '@ballastella/core';

	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import ModalDialog from './ModalDialog.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const review = $derived(storage?.review ?? null);

	let confirmingDiscard = $state(false);
	let confirmingImport = $state(false);
	/** Whether an Import is running, so its button cannot be pressed a second time. */
	let importing = $state(false);
	/** What the last exit did or would not do, announced. `''` when nothing has happened. */
	let announcement = $state('');
	/**
	 * Why an Import did not happen, or `''`. Its own state so a refusal is an alert (SPEC story 94).
	 *
	 * ⚠ **Not {@link announcement}.** A refused Import is text inserted at the moment it first exists,
	 * which a polite region does not reliably announce — and it is the one outcome here that leaves the
	 * reviewer with something to decide rather than somewhere new to be. The refusals it carries name
	 * the recorded Workspace and say the review copy is still whole, which is CONTRIBUTING's split
	 * between a status and an error.
	 */
	let importProblem = $state('');
	/**
	 * The line naming the imported Project, focused once the recorded Workspace has been adopted.
	 *
	 * ⚠ **The banner is gone by then and so is every control in it** (SPEC story 95). A successful
	 * Import switches to the recorded Workspace, which makes `review` null, which unmounts the button
	 * that was pressed and the dialog's own restoration target with it — so focus would land on
	 * `<body>` at the top of a screen the reviewer has never seen. This line is outside that block for
	 * the same reason the announcement is, and it names the Project and the Workspace it arrived in,
	 * which is what the reviewer needs to read next.
	 */
	let announcementLine: HTMLElement | null = $state(null);
	/**
	 * The Import control, so a refusal can put focus back on it.
	 *
	 * ⚠ **The element, not `document.activeElement` when the confirmation was answered.** By then
	 * focus is on the confirm button, which stays in the document inside a `<dialog>` that has closed
	 * — so restoring "where it was" would leave a keyboard user on a control they cannot see. This is
	 * where the retry is, and it is still mounted because a refused Import leaves the review copy open.
	 */
	let importButton: HTMLElement | null = $state(null);
	/**
	 * Per-file progress while the reviewed Project is copied, or `''`.
	 *
	 * The transfer is the shared engine's, so it is the same count the hub's own Import announces; what
	 * is different here is that there is no dialog left to carry it — the confirmation closes before
	 * the copy begins — so the banner's own region says it. A pyramid is thousands of files over real
	 * minutes, and story 93 is that the wait is not silent.
	 */
	const importProgress = $derived.by(() => {
		const transfer = storage?.transfer;
		if (!importing || !transfer || transfer.kind !== 'import' || transfer.finished) return '';
		return `Copying ${transfer.subject}: ${transfer.files} of ${transfer.totalFiles} files.`;
	});

	/**
	 * The ordinary Workspace an Import would copy into, or `null` for a review copy that names none.
	 *
	 * ⚠ **A review copy made before ADR-0037 records no origin**, and there is nothing to infer one
	 * from: the current Workspace is this throwaway one, and the last one of the user's own is wherever
	 * they happened to go. So the action is absent and a sentence says why, rather than a button that
	 * refuses whenever it is pressed.
	 */
	const destination = $derived(storage?.reviewImportDestination ?? null);

	/**
	 * What was opened, in the words the banner uses.
	 *
	 * A mark that could not be read carries no Project name — see `readReviewMark`, which answers with
	 * a mark rather than with `null` when the file is there and unreadable. Saying "a Project somebody
	 * sent you" is the truthful reading of that; inventing the Workspace's own name would claim the
	 * bundle said something it did not.
	 *
	 * ⚠ **`describeReviewSubject` rather than the same conditional written here**, which is what this
	 * was. `assertNotReviewing` names the subject in the refusal a user meets when they try to publish
	 * or back one up, and this names it in the banner they are looking at while they do — two spellings
	 * is how the two screens come to say different things about one Workspace. That function is in core
	 * for exactly this, and it had no consumer.
	 */
	const subject = $derived(review === null ? '' : describeReviewSubject(review));

	/**
	 * Go back to the user's own Workspace, and say which one they landed in.
	 *
	 * ⚠ **The name is read *after* the switch, never predicted before it.** It used to announce
	 * `ownWorkspaceName`, which is the browser-storage fallback and is not where a folder-Workspace
	 * user goes — so the sentence claimed "You are back in your own Workspace, “My Workspace”" while
	 * the exit had reopened their folder, or, worse, while a refused folder grant had left them
	 * somewhere else again. `storage.name` is what the bar is showing, which is the only honest answer
	 * to "where am I now".
	 *
	 * ⚠ **A folder that would not reopen is said *here*, appended, and not left to the settings
	 * screen.** `storage.problem` is rendered where the storage question is asked, and a user who
	 * pressed an exit is not on that screen — so the whole report of "your folder was not opened, you
	 * are somewhere else" was one sentence saying where they were and nothing at all saying why it was
	 * not where they asked to go. Where the folder *did* reopen, `problem` is empty and this is the
	 * sentence it always was.
	 */
	const withProblem = (said: string): string =>
		storage?.problem ? `${said} ${storage.problem}` : said;

	async function leave(): Promise<void> {
		if (!storage) return;
		await storage.leaveReview();
		announcement = withProblem(
			`Left the review copy. You are back in your own Workspace, “${storage.name}”.`
		);
	}

	/**
	 * Import, then put the address bar on the Project that arrived.
	 *
	 * ⚠ **The navigation is here and the opening is `WorkspaceStorage`'s, and they are not the same
	 * thing.** `importReview` switches to the destination and opens the imported Project *before* it
	 * deletes the review copy, which is what makes "the imported result is established first" a fact
	 * about the order. What is left is the `?p=` this tab is sitting on, which still names the Project
	 * inside a Workspace that is now gone — so the effect on the hub would re-open nothing over the
	 * top of the copy that arrived. This banner is on every route, `/align/` included, so the address
	 * is rebuilt from the app's root rather than patched.
	 */
	async function importReviewed(): Promise<void> {
		if (importing) return;
		confirmingImport = false;
		if (!storage) return;
		importProblem = '';
		importing = true;
		try {
			const imported = await storage.importReview();
			announcement = imported.incomplete
				? imported.incomplete
				: `Imported “${imported.name}” into “${imported.workspace}”, and discarded the review copy.`;
			// eslint-disable-next-line svelte/no-navigation-without-resolve
			await goto(`${resolve('/')}?p=${encodeURIComponent(imported.directory)}`, {
				replaceState: true,
				noScroll: true,
				keepFocus: true
			}).catch(() => undefined);
			// ⚠ **After the navigation, because that is what unmounts the banner.** `keepFocus` keeps
			// whatever focus the switch left, which by now is nothing the reviewer can see: the button
			// they pressed went with the review copy. See {@link announcementLine}.
			await tick();
			announcementLine?.focus();
		} catch (cause) {
			importProblem = cause instanceof Error ? cause.message : String(cause);
			// The review copy is still open and every byte of it is still there, so the reviewer is put
			// back on the control they pressed — which is where they retry, or leave from.
			await tick();
			importButton?.focus();
		} finally {
			importing = false;
		}
	}

	async function discard(): Promise<void> {
		confirmingDiscard = false;
		if (!storage) return;
		const discarded = storage.name;
		try {
			await storage.discardReview();
			announcement = withProblem(`Discarded the review copy “${discarded}” and everything in it.`);
		} catch (cause) {
			announcement = cause instanceof Error ? cause.message : String(cause);
		}
	}
</script>

{#if review !== null && storage !== null}
	<!--
		`role="region"` with a name, rather than a bare `<div>`: a screen-reader user navigating by
		landmark can reach it from anywhere on the page, which is the point of it being on every screen.
		Not `role="alert"` — it is a steady-state fact about where you are, true from the first frame and
		unchanged for as long as the review copy is open, and an assertive region would interrupt a
		scholar mid-alignment to tell them something that was already true when they arrived.
	-->
	<section
		aria-label="Review copy"
		class="flex flex-wrap items-center gap-3 border-b border-warning bg-warning/15 px-4 py-2 text-sm"
		data-testid="review-banner"
	>
		<p class="grow">
			<strong>Review copy.</strong>
			This Workspace holds {subject} and nothing else. It is a throwaway copy: your own Workspaces are
			untouched, nothing here reaches one unless you Import it, and discarding it removes everything in
			it.
			{#if destination === null}
				<span data-testid="review-import-unavailable">
					This copy does not record which of your Workspaces it was opened from, so it cannot be
					Imported. Go back to your own Workspace and Import the file or the link there instead.
				</span>
			{/if}
		</p>
		{#if destination !== null}
			<!--
				`aria-disabled` for the running state and never `disabled`: the confirmation closes onto
				this button before the copy begins, and a `disabled` button leaves the tab order the moment
				it is given focus back — dropping a keyboard user onto `<body>` for the length of a copy
				that runs in minutes (WCAG 2.4.3, SPEC story 95).
			-->
			<button
				bind:this={importButton}
				class="btn btn-primary btn-sm"
				class:btn-disabled={importing}
				aria-disabled={importing}
				data-testid="import-review"
				onclick={() => !importing && (confirmingImport = true)}
			>
				Import into “{destination.name}”
			</button>
		{/if}
		<button class="btn btn-sm" data-testid="leave-review" onclick={() => void leave()}>
			Back to my Workspace
		</button>
		<button
			class="btn btn-outline btn-error btn-sm"
			data-testid="discard-review"
			onclick={() => (confirmingDiscard = true)}
		>
			Discard this review copy
		</button>
	</section>
{/if}

<!--
	What the last exit did, announced — and **outside the `{#if}` above, which is the whole point.**

	⚠ Both exits end with `review` becoming `null`, so a live region inside that block is torn out of
	the document in the same update that gives it its text. The browser test caught exactly that: after
	discarding, the element was not there to assert on, which means a screen-reader user would never
	have heard it either. Announcing something and destroying the region that announces it is worse
	than saying nothing, because it looks like a courtesy that was paid.

	Always rendered and `sr-only` when idle rather than wrapped in an `{#if}`, so the region is the
	same node throughout: one inserted at the same moment as its first text is not reliably announced,
	and an empty `<p>` has no line box, so it costs no space either way. `aria-live="polite"` rather
	than `role="status"`, this app's settled convention wherever the save indicator is also on screen
	— which since ticket 04 is every screen.

	⚠ **Visible and focusable when it says anything, because it is where a successful Import lands**
	(SPEC story 95). An Import's result is a Project in *another* Workspace, and every control that
	could have held focus went with the review copy — so focus has to go somewhere the reviewer can
	see, and this sentence names what arrived and where.
-->
<p
	bind:this={announcementLine}
	tabindex="-1"
	aria-live="polite"
	class="px-4 text-sm"
	class:sr-only={announcement === ''}
	class:py-2={announcement !== ''}
	data-testid="review-announcement"
>
	{announcement}
</p>

<!--
	How far the copy has got, in the same persistent-region shape. The confirmation is closed by the
	time the transfer starts, so without this the wait is silent (SPEC story 93). Not a second
	`role="status"`: the save indicator on the bar owns that role on every screen.
-->
<p
	aria-live="polite"
	class="px-4 text-sm"
	class:sr-only={importProgress === ''}
	data-testid="review-import-progress"
>
	{importProgress}
</p>

{#if importProblem}
	<!-- The refusals: a recorded Workspace that is gone or unreachable, a folder grant declined, no
	     room for the closure, a Project this Workspace already synchronizes. Each has left the review
	     copy open and holding every byte, which is what the sentence says. -->
	<div role="alert" class="m-4 alert flex-col items-start alert-error">
		<p data-testid="review-import-problem">{importProblem}</p>
	</div>
{/if}

{#if review !== null && storage !== null && destination !== null}
	<ModalDialog
		bind:open={() => confirmingImport, (open) => (confirmingImport = open)}
		title="Import into “{destination.name}”"
	>
		<!--
			The two consequences, both before the confirmation and neither of them softened. The first is
			what a reviewer who has been working in here is actually about to copy; the second is what
			happens to the Workspace they are looking at, and *when* — after, never before.
		-->
		<p data-testid="import-review-state">
			Copy {subject} <strong>as it is now</strong>, including any edits you have made in this review
			copy, into your Workspace <strong>{destination.name}</strong>? The copy is yours to edit: its
			Map Images arrive as new ones of your own, so nothing you have already aligned is changed.
		</p>
		<p class="mt-3 text-sm opacity-70" data-testid="import-review-consequence">
			This review copy <strong>“{storage.name}”</strong> is discarded once the copy has succeeded
			and you are back in {destination.name} — and only then. If anything goes wrong, it stays exactly
			as it is and you can try again.
		</p>
		{#snippet actions()}
			<button class="btn" onclick={() => (confirmingImport = false)}>Cancel</button>
			<button
				class="btn btn-primary"
				data-testid="confirm-import-review"
				onclick={() => void importReviewed()}
			>
				Import and discard the review copy
			</button>
		{/snippet}
	</ModalDialog>
{/if}

{#if review !== null && storage !== null}
	<ModalDialog
		bind:open={() => confirmingDiscard, (open) => (confirmingDiscard = open)}
		title="Discard this review copy"
	>
		<p>
			Discard <strong>{storage.name}</strong>, the review copy holding {subject}? Everything in it
			goes: the Project, its Annotations, and the Map Images and Alignments the bundle carried. This
			cannot be undone.
		</p>
		<p class="mt-3 text-sm opacity-70" data-testid="discard-review-consequence">
			Nothing of your own is touched. The file you were sent is not changed either, so you can open
			it again; and if you want to keep this Project, Import it instead — that copies it into your
			own Workspace and discards this one afterwards.
		</p>
		{#snippet actions()}
			<button class="btn" onclick={() => (confirmingDiscard = false)}>Cancel</button>
			<button
				class="btn btn-error"
				data-testid="confirm-discard-review"
				onclick={() => void discard()}
			>
				Discard this review copy
			</button>
		{/snippet}
	</ModalDialog>
{/if}
