<script lang="ts">
	import { tick } from 'svelte';

	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	/**
	 * What the write-ahead journal put back at startup, and everything it could not.
	 *
	 * ─────────────────────────────────────────────────────────────────────────────────────────
	 * A RECOVERY THE USER CANNOT TELL HAPPENED IS ONE THEY CANNOT CHECK
	 *
	 * The whole point of the journal is that a file on disk is not what the user last left it as —
	 * this build wrote over it, at startup, from a copy in browser storage. That is a change to a
	 * scholar's own files made without a gesture, and the only honest version of it is one that says
	 * so, names every file, and can be read.
	 *
	 * So, following the same reasoning as `UpdatePrompt`:
	 *
	 *   * **Visible text, never a tooltip.** A daisyUI tooltip is a CSS `::before` and is never
	 *     announced (ADR-0016).
	 *   * **`aria-live="polite"` on a wrapper that is always mounted**. A live region inserted with its
	 *     text already in it is often not announced at all, which would leave this news sighted-only —
	 *     and a startup recovery is exactly the thing a screen-reader user would otherwise be told less
	 *     about than anybody else.
	 *   * **Polite and not `role="alert"`**: nothing here may pull focus away from what the author is
	 *     doing to tell them something that was already true when they arrived.
	 *   * **In the page's flow, under the bar, and never a floating card.** This notice has no timer:
	 *     it stays until "Got it" is pressed, so anything it covers it covers indefinitely. A fixed
	 *     corner card would sit over the Project screen's pinned "Map Image" and "Annotation Layer"
	 *     pair — the one way of adding to a Project — and no corner is free at every width, because
	 *     below `lg` the Layer rail is a full-width block at the end of the document. So it takes room
	 *     of its own, for `ReviewBanner`'s reason: news that persists must not be laid over the work it
	 *     is about. Only a startup or a Workspace switch produces a report, so the space it takes is
	 *     never claimed out from under a gesture in progress.
	 *   * **Dismissed by the user and by nothing else.** It does not time out. Four separate lists
	 *     are shown rather than a count, because "put back", "deliberately not put back", "could not
	 *     be put back yet" and "this version will not read it" are four different things to do next.
	 *   * **A row whose entry is *kept* carries its own exit.** Dismissal is keyed on the report's
	 *     contents, so news about something still in the journal comes back at every startup until the
	 *     thing itself goes.
	 */
	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const report = $derived(storage?.session.replayReport ?? null);
	/** The Workspace the replay wrote into, named the way its author knows it rather than by its key. */
	const restoredInto = $derived(
		report === null ? '' : (storage?.workspaceLabel(report.workspace) ?? '')
	);
	/**
	 * And what the startup's **deletions** did.
	 *
	 * ⚠ **The only step of the recovery chain that removes files, and it was the only one that said
	 * nothing.** `finishInterruptedDeletions` runs before the replay, against the same Workspace,
	 * from a record written when the user pressed Delete — and it deleted files out of a scholar's
	 * own folder during startup with no notice in either direction. ADR-0017's standard for this
	 * chain is that every recovery is *named* to the user; the same three bullets above apply
	 * unchanged, and the same panel carries it so a startup speaks once rather than twice.
	 *
	 * Three lists rather than a count, for the reason the replay has four: "carried out", "refused,
	 * and here is why" and "could not be done yet" are three different things to do next — and the
	 * middle one is how a user finds out that a second folder of the same name has an unfinished
	 * deletion pointed at it.
	 */
	const deletions = $derived(storage?.session.deletionReport ?? null);

	let dismissed = $state<string | null>(null);
	// Keyed on the report object, so a *second* replay — switching Workspace, say — is shown even
	// though the last one was dismissed. Dismissing by a boolean hid every later recovery too.
	const showing = $derived((report !== null || deletions !== null) && dismissed !== reportKey());

	function reportKey(): string {
		return JSON.stringify([
			report?.workspace ?? '',
			report?.restored ?? [],
			report?.skipped.map((entry) => entry.path) ?? [],
			report?.failed.map((entry) => entry.path) ?? [],
			report?.problems.map((entry) => entry.key) ?? [],
			deletions?.finished ?? [],
			deletions?.refused.map((entry) => entry.directory) ?? [],
			deletions?.unfinished ?? []
		]);
	}

	const headingId = $props.id();

	/** The panel's own last control, so focus has somewhere to land that is still in the document. */
	let dismissButton = $state<HTMLButtonElement | null>(null);

	/**
	 * ⚠ **Dismissing this must not drop focus on the floor.**
	 *
	 * "Got it" removes the `<section>` that contains it, so a keyboard or screen-reader user who
	 * activates it has the focused element deleted from under them and lands on `<body>` — at the top
	 * of the document, with no announcement, and with the next Tab starting from the beginning of the
	 * page. It is load-bearing here because this panel is the *only* user-facing surface for every
	 * deletion a folder Workspace reports.
	 *
	 * Focus goes to `<main>`, which is where the user's attention should be once the news is
	 * dismissed — the Project list they came here for. `tabIndex = -1` is what makes a landmark
	 * focusable without putting it in the tab order, which is the settled pattern for exactly this.
	 */
	function dismiss(): void {
		dismissed = reportKey();
		const main = document.querySelector('main');
		if (!(main instanceof HTMLElement)) return;
		main.tabIndex = -1;
		main.focus();
	}

	/**
	 * Forget one refusal's note, and put focus somewhere that still exists.
	 *
	 * The paragraph holding the button goes with the note. If the panel is still saying something
	 * else, focus its "Got it", which is present whenever the panel is; if the panel has gone
	 * because that refusal was the whole of it, this is a dismissal and lands where one does.
	 */
	function forgetDeletion(directory: string): void {
		storage?.session.forgetDeletion(directory);
		void tick().then(() => {
			if (showing && dismissButton) dismissButton.focus();
			else {
				const main = document.querySelector('main');
				if (main instanceof HTMLElement) {
					main.tabIndex = -1;
					main.focus();
				}
			}
		});
	}

	/**
	 * Throw away one refused entry's kept copy, and put focus somewhere that still exists.
	 *
	 * The same shape as {@link forgetDeletion} directly above, and for the same reason: the paragraph
	 * holding the button goes with the entry.
	 */
	function forgetReplaySkip(path: string, copy: string): void {
		storage?.session.forgetReplaySkip(path, copy);
		void tick().then(() => {
			if (showing && dismissButton) dismissButton.focus();
			else {
				const main = document.querySelector('main');
				if (main instanceof HTMLElement) {
					main.tabIndex = -1;
					main.focus();
				}
			}
		});
	}
</script>

<div aria-live="polite" aria-atomic="true" data-testid="recovered-region">
	{#if showing}
		<!--
			`max-h` with its own scroller, because the lists are as long as the recovery was: a
			Workspace switch that replayed thirty files would otherwise leave the screen the author came
			for a couple of lines tall, since the layout gives this its full height before the route below
			it gets what is left.
		-->
		<section
			class="max-h-[40vh] overflow-y-auto border-b border-base-300 bg-base-200"
			aria-labelledby={headingId}
			data-testid="recovered-edits"
		>
			<div class="flex flex-col gap-2 p-4">
				<h2 id={headingId} class="text-base font-semibold">
					{report !== null
						? report.restored.length > 0
							? 'An unsaved change was put back'
							: 'An unsaved change was found'
						: (deletions?.finished.length ?? 0) > 0
							? 'A deletion was finished'
							: 'A deletion was not finished'}
				</h2>
				{#if deletions !== null && deletions.finished.length > 0}
					<p class="text-sm" data-testid="deletion-finished">
						Ballastella closed before {deletions.finished.length === 1
							? 'a Project you deleted was'
							: 'some Projects you deleted were'} finished being removed, so {deletions.finished
							.length === 1
							? 'it has'
							: 'they have'} been removed now: {deletions.finished.join(', ')}.
					</p>
				{/if}
				<!--
					⚠ **A refusal needs an exit that costs nobody a file.**

					A folder Workspace finishes no deletion unattended, so a refusal is the whole of what a
					startup there ever reports — and nothing else ends one. No record expires,
					`Workspace.#claim` drops one only when a Project is created or duplicated under that name,
					Workspace settings' discard cannot by construction reach the Workspace that is open, and
					"Got it" below is keyed on the report's *contents*, so the next startup builds a
					byte-identical report and shows it again. The one remedy the sentence used to offer was
					"delete it again", which — in the case the sentence exists for, a colleague's folder
					holding their own Project of that name — destroys their work.

					So: forget the note. It removes a note about a deletion and never a file, which makes
					it the one gesture here that is safe to offer for a state the user cannot otherwise
					leave. If the deletion really was theirs, the Project is still listed and Delete is
					right there.
				-->
				{#each deletions?.refused ?? [] as entry (entry.directory)}
					<p class="text-sm text-warning" data-testid="deletion-refused">
						{entry.detail}
						<!--
							⚠ **The accessible name carries the folder, and the visible label cannot.** Two
							refusals render two buttons reading "Forget this note", and the only thing telling them
							apart is the prose beside them in a `<p>` that is not programmatically associated with
							either. A screen-reader user tabbing the panel would meet two identical buttons and
							have to guess which note each one throws away — for a control whose whole purpose is to
							be the safe choice. It also makes `getByTestId('forget-deletion')` a strict-mode
							violation the moment a test constructs two, which is the test that had to exist.
						-->
						<button
							type="button"
							class="btn ml-1 align-baseline btn-xs"
							data-testid="forget-deletion"
							aria-label="Forget the unfinished deletion of “{entry.directory}”"
							onclick={() => forgetDeletion(entry.directory)}
						>
							Forget this note
						</button>
					</p>
				{/each}
				{#if deletions !== null && deletions.unfinished.length > 0}
					<p class="text-sm text-warning" data-testid="deletion-unfinished">
						{deletions.unfinished.length === 1 ? 'A Project you deleted' : 'Projects you deleted'} could
						not be removed and {deletions.unfinished.length === 1 ? 'is' : 'are'} still here: {deletions.unfinished.join(
							', '
						)}. Ballastella will try again the next time this Workspace is opened. Deleting {deletions
							.unfinished.length === 1
							? 'it'
							: 'them'} again from the list is the way to be sure.
					</p>
				{/if}
				{#if report !== null && report.restored.length > 0}
					<p class="text-sm">
						Ballastella closed before {report.restored.length === 1
							? 'this file was'
							: 'these files were'}
						finished saving in “{restoredInto}”, so the change has been written now:
					</p>
					<ul class="list-inside list-disc text-sm" data-testid="recovered-restored">
						{#each report.restored as path (path)}
							<li>{path}</li>
						{/each}
					</ul>
				{/if}
				<!--
					⚠ **A kept entry needs an exit, for the reason an unfinished deletion does.**

					Every skip used to drop its entry, so every skip was news that could only be told once. Two
					reasons now keep one — a refusal that would otherwise destroy an edit, and an entry
					waiting on the scholar to say which version wins — and "Got it" below is keyed on the
					report's *contents*, so the next startup builds a byte-identical report and shows the
					same warning again, for ever. Nothing else ends it: no record expires, and Workspace
					settings' discard would take every other file's rescue copy with it.

					Unlike the deletion's note, this one **is** destructive, so the label says which file it
					throws away and the sentence beside it has already said the copy is the only one.

					⚠ **The identity travels with the row, not just the path.** This notice never expires, so
					the button can be pressed after arbitrary later work; keyed on the path alone it destroyed
					whatever was at that path *then* — including a stranded edit made an hour later.

					⚠ **This is the only action offered, and it is the discarding one.** Applying a held copy
					is a chooser that does not exist yet, so a scholar meeting `cannot-tell-which-is-newer` can
					read both versions' sizes and keep waiting, or throw the copy away. Everything a chooser
					needs is already reachable; what is missing is the UI.
				-->
				{#each report?.skipped ?? [] as entry (`${entry.path}:${entry.copy ?? ''}`)}
					{@const copy = entry.copy}
					<p class="text-sm text-warning" data-testid="recovered-skipped">
						{entry.detail}
						{#if copy !== null}
							<button
								type="button"
								class="btn ml-1 align-baseline btn-xs"
								data-testid="forget-replay-skip"
								aria-label="Throw away the kept copy of “{entry.path}”"
								onclick={() => forgetReplaySkip(entry.path, copy)}
							>
								Throw this copy away
							</button>
						{/if}
					</p>
				{/each}
				{#each report?.failed ?? [] as entry (entry.path)}
					<p class="text-sm text-warning" data-testid="recovered-failed">{entry.detail}</p>
				{/each}
				{#each report?.problems ?? [] as problem (problem.key)}
					<p class="text-sm text-warning" data-testid="recovered-problem">{problem.detail}</p>
				{/each}
				<div class="flex justify-end">
					<button
						type="button"
						class="btn btn-sm"
						data-testid="recovered-dismiss"
						bind:this={dismissButton}
						onclick={dismiss}
					>
						Got it
					</button>
				</div>
			</div>
		</section>
	{/if}
</div>
