<script lang="ts">
	import { workspaceKeyLabel } from '$lib/editor-session.svelte.js';
	import { useWorkspaceHost } from '$lib/workspace-storage.svelte.js';

	/**
	 * What the write-ahead journal put back at startup, and everything it could not (ticket 20).
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
	 *   * **Visible text, never a tooltip** (SPEC story 111). A daisyUI tooltip is a CSS `::before`
	 *     and is never announced (ADR-0016).
	 *   * **`aria-live="polite"` on a wrapper that is always mounted** (SPEC story 112). A live region
	 *     inserted with its text already in it is often not announced at all, which would leave this
	 *     news sighted-only — and a startup recovery is exactly the thing a screen-reader user would
	 *     otherwise be told less about than anybody else.
	 *   * **Polite and not `role="alert"`**, and fixed rather than in the flow, for story 113's
	 *     reason: nothing here may pull focus or reflow the page out from under a half-finished drag.
	 *   * **Dismissed by the user and by nothing else.** It does not time out. Four separate lists
	 *     are shown rather than a count, because "put back", "deliberately not put back", "could not
	 *     be put back yet" and "this version will not read it" are four different things to do next.
	 */
	const host = useWorkspaceHost();
	const storage = $derived(host.storage);
	const report = $derived(storage?.session.replayReport ?? null);
	/**
	 * And what the startup's **deletions** did (ticket 21, review 2).
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
</script>

<div
	class="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-start p-4"
	aria-live="polite"
	aria-atomic="true"
	data-testid="recovered-region"
>
	{#if showing}
		<section
			class="pointer-events-auto card max-w-md border border-base-300 bg-base-200 shadow-lg"
			aria-labelledby={headingId}
			data-testid="recovered-edits"
		>
			<div class="card-body gap-2 p-4">
				<h2 id={headingId} class="card-title text-base">
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
				{#each deletions?.refused ?? [] as entry (entry.directory)}
					<p class="text-sm text-warning" data-testid="deletion-refused">{entry.detail}</p>
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
						finished saving in “{workspaceKeyLabel(report.workspace)}”, so the change has been
						written now:
					</p>
					<ul class="list-inside list-disc text-sm" data-testid="recovered-restored">
						{#each report.restored as path (path)}
							<li>{path}</li>
						{/each}
					</ul>
				{/if}
				{#each report?.skipped ?? [] as entry (entry.path)}
					<p class="text-sm text-warning" data-testid="recovered-skipped">{entry.detail}</p>
				{/each}
				{#each report?.failed ?? [] as entry (entry.path)}
					<p class="text-sm text-warning" data-testid="recovered-failed">{entry.detail}</p>
				{/each}
				{#each report?.problems ?? [] as problem (problem.key)}
					<p class="text-sm text-warning" data-testid="recovered-problem">{problem.detail}</p>
				{/each}
				<div class="card-actions justify-end">
					<button
						type="button"
						class="btn btn-sm"
						data-testid="recovered-dismiss"
						onclick={() => (dismissed = reportKey())}
					>
						Got it
					</button>
				</div>
			</div>
		</section>
	{/if}
</div>
