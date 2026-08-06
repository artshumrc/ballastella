<script lang="ts">
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * Where the user's work is, and how to move it to a folder they can see.
	 *
	 * Shown on the hub only. Choosing where a Workspace lives is a Workspace-level act, and the one
	 * place a user asks the question is when they are looking at their Projects rather than editing
	 * inside one.
	 *
	 * Every explanation here is **visible text**, not a tooltip: daisyUI renders tooltips through CSS
	 * `::before`, so they are neither announced nor dismissable (ADR-0016), and "why does it keep
	 * asking about my folder?" is precisely the thing a user needs an answer to.
	 */
	let { storage }: { storage: WorkspaceStorage } = $props();

	const headingId = $props.id();
	const unreachable = $derived(storage.session.status === 'unreachable');
</script>

<section class="mt-8" aria-labelledby={headingId}>
	<h2 id={headingId} class="text-lg font-semibold">Where your work is stored</h2>

	{#if storage.backing === 'folder'}
		<p class="mt-2 max-w-prose text-sm">
			Your Workspace is the folder <code>{storage.folderName}</code>. Every Project in it is a real
			directory of real files, so you can back it up, sync it, or commit it to git without this
			tool's help.
		</p>
	{:else}
		<p class="mt-2 max-w-prose text-sm">
			Your Workspace is in this browser's own private storage. Your work is kept between visits, but
			you cannot see the files, and another browser cannot.
		</p>
	{/if}

	<div class="mt-3 flex flex-wrap gap-2">
		{#if storage.backing === 'folder'}
			{#if unreachable}
				<!-- ADR-0008: a folder that has been moved, renamed, or deleted is a normal state, and
				     locating it again is the recovery. -->
				<button class="btn btn-primary btn-sm" onclick={() => storage.chooseFolder()}>
					Locate Workspace folder again
				</button>
			{/if}
			<button class="btn btn-sm" onclick={() => storage.useBrowserStorage()}>
				Use browser storage instead
			</button>
		{:else if storage.canChooseFolder}
			{#if storage.reopenable}
				<button class="btn btn-primary btn-sm" onclick={() => storage.reopenFolder()}>
					Reopen “{storage.reopenable}”
				</button>
			{/if}
			<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>
				Choose Workspace folder…
			</button>
		{/if}
	</div>

	{#if storage.backing === 'browser' && storage.reopenable}
		<p class="mt-3 max-w-prose text-sm opacity-70">
			Your browser asks permission for <code>{storage.reopenable}</code> each time you return, because
			granting a folder is a decision it will not make for you. Installing Ballastella as an application
			is what stops it asking.
		</p>
	{/if}

	{#if storage.problem}
		<!-- Never a silent fall back: a Workspace that quietly became browser storage again looks,
		     from the user's side, exactly like the tool having lost their folder. -->
		<div role="alert" class="mt-4 alert flex-col items-start alert-warning">
			<h3 class="font-semibold">Your Workspace folder was not opened</h3>
			<p>{storage.problem}</p>
			<button class="btn btn-sm" onclick={() => storage.chooseFolder()}
				>Choose a folder again</button
			>
		</div>
	{/if}
</section>
