<script lang="ts">
	// "You are inside a review copy", on every screen, with the only two exits out of it
	// (ticket 14, ADR-0024, workspace-and-layers SPEC stories 92–94).
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
	// says whose work this is, that nothing here reaches the user's own Workspace, and what the two
	// buttons do.
	//
	// ─────────────────────────────────────────────────────────────────────────────────────────
	// EXACTLY TWO EXITS, AND WHY THERE IS NO THIRD
	//
	// Back to your own Workspace, and discard this one. There is deliberately **no** "keep this", "copy
	// to my Workspace", "save a copy", or "promote". ADR-0024 calls that the fence that makes the rest
	// coherent: under ADR-0023 there is one Alignment per Historical Map in a Workspace, so copying a
	// reviewed Project into the user's own is the collision the whole design exists to avoid, arriving
	// through a convenience. A scholar who wants a colleague's map in their own research adds the map
	// themselves.

	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	import ModalDialog from './ModalDialog.svelte';

	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const review = $derived(storage?.review ?? null);

	let confirmingDiscard = $state(false);
	/** What the last exit did or would not do, announced. `''` when nothing has happened. */
	let announcement = $state('');

	/**
	 * What was opened, in the words the banner uses.
	 *
	 * A mark that could not be read carries no Project name — see `readReviewMark`, which answers with
	 * a mark rather than with `null` when the file is there and unreadable. Saying "a Project somebody
	 * sent you" is the truthful reading of that; inventing the Workspace's own name would claim the
	 * bundle said something it did not.
	 */
	const subject = $derived(review?.project ? `“${review.project}”` : 'a Project somebody sent you');

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
	 * A folder that would not reopen is reported by `storage.problem` on the settings screen; what is
	 * said here is where the user actually is, because that is what this sentence is for.
	 */
	async function leave(): Promise<void> {
		if (!storage) return;
		await storage.leaveReview();
		announcement = `Left the review copy. You are back in your own Workspace, “${storage.name}”.`;
	}

	async function discard(): Promise<void> {
		confirmingDiscard = false;
		if (!storage) return;
		const discarded = storage.name;
		try {
			await storage.discardReview();
			announcement = `Discarded the review copy “${discarded}” and everything in it.`;
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
			untouched, nothing here can be copied into them, and discarding it removes everything in it.
		</p>
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

{#if review !== null && storage !== null}
	<ModalDialog
		bind:open={() => confirmingDiscard, (open) => (confirmingDiscard = open)}
		title="Discard this review copy"
	>
		<p>
			Discard <strong>{storage.name}</strong>, the review copy holding {subject}? Everything in it
			goes: the Project, its Annotations, and the Historical Maps and Alignments the bundle carried.
			This cannot be undone.
		</p>
		<p class="mt-3 text-sm opacity-70" data-testid="discard-review-consequence">
			Nothing of your own is touched. The file you were sent is not changed either, so you can open
			it again; and if you want a map from it in your own research, add that map to your own
			Workspace yourself.
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
