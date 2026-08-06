<script lang="ts">
	import { resolve } from '$app/paths';

	import type { EditorSession } from '../editor-session.svelte.js';
	import SaveIndicator from './SaveIndicator.svelte';

	/**
	 * One Project, selected client-side from `?p=<folder>` (ADR-0008).
	 *
	 * Almost everything a Project *is* arrives in later slices — the Historical Map panes, the
	 * Control Points, the Layer stack. What is here is the frame they hang in and, more
	 * importantly, the autosave rules they will follow: the name field below is the app's first
	 * editable value, so it is where "typing coalesces into one write" and "the edit is committed
	 * when it ends" are established rather than improvised per slice (ADR-0017).
	 */
	let { session }: { session: EditorSession } = $props();
</script>

{#if session.projectProblem}
	<div role="alert" class="mt-8 alert flex-col items-start alert-warning">
		<h2 class="font-semibold">
			{session.projectProblem.kind === 'missing'
				? 'Project not found'
				: 'This Project cannot be opened'}
		</h2>
		<p>{session.projectProblem.message}</p>
		<a class="btn btn-sm" href={resolve('/')}>Back to all Projects</a>
	</div>
{:else if session.openProject}
	<div class="mt-8 flex flex-wrap items-center justify-between gap-4">
		<h2 class="text-2xl font-semibold">{session.openProject.name}</h2>
		<div class="flex flex-col items-end">
			<SaveIndicator saveState={session.saveState} />
			{#if session.saveError}
				<p class="text-sm text-warning">{session.saveError}</p>
			{/if}
		</div>
	</div>

	<!--
		`onchange` and `onblur` both mean "the edit is over" (ADR-0017 rule 1). Neither writes on its
		own: `commitProjectName` is a no-op unless there is a pending write, because tabbing into and
		out of this field must not rewrite `project.json` — the write stamps a fresh `updatedAt`, and
		ADR-0010 is explicit that merely looking at an old Project must not modify files.
	-->
	<label class="floating-label mt-6 block max-w-md">
		<span>Project name</span>
		<input
			class="input w-full"
			value={session.openProject.name}
			oninput={(event) => session.typeProjectName(event.currentTarget.value)}
			onchange={() => session.commitProjectName()}
			onblur={() => session.commitProjectName()}
		/>
	</label>

	<dl class="mt-6 text-sm opacity-70">
		<dt class="font-medium">Folder</dt>
		<dd><code>{session.openDirectory}</code></dd>
		<dt class="mt-2 font-medium">Last saved</dt>
		<dd><time datetime={session.openProject.updatedAt}>{session.openProject.updatedAt}</time></dd>
	</dl>

	<p class="mt-8 max-w-prose">
		This Project has no Historical Maps yet. Adding one, aligning it, and annotating it arrive in
		later slices; what works now is the Workspace itself — creating Projects, naming them, and
		having every change written to storage as you make it.
	</p>

	<p class="mt-6"><a class="link" href={resolve('/')}>Back to all Projects</a></p>
{:else}
	<p class="mt-8">Opening…</p>
{/if}
