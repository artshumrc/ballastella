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
		confirmingImport = false;
		if (!storage) return;
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
		} catch (cause) {
			announcement = cause instanceof Error ? cause.message : String(cause);
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
			<button
				class="btn btn-primary btn-sm"
				data-testid="import-review"
				disabled={importing}
				onclick={() => (confirmingImport = true)}
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

	Always rendered and empty when idle, for the reason every other live region in this app is: one
	inserted at the same moment as its first text is not reliably announced. `aria-live="polite"`
	rather than `role="status"`, this app's settled convention wherever the save indicator is also on
	screen — which since ticket 04 is every screen.
-->
<p aria-live="polite" class="sr-only" data-testid="review-announcement">{announcement}</p>

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
