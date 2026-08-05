<script lang="ts">
	import { resolve } from '$app/paths';
	import type { ProjectSummary } from '@ballastella/core';

	import type { EditorSession } from '../editor-session.svelte.js';
	import ModalDialog from './ModalDialog.svelte';

	/**
	 * The hub: every Project in the Workspace, and the whole of its lifecycle.
	 *
	 * This is the same page a Reader gets from a Published Site (ADR-0008) — a scholar's
	 * portfolio at one address rather than a scatter of unrelated URLs — so it is a feature and
	 * not scaffolding.
	 */
	let { session }: { session: EditorSession } = $props();

	let creating = $state(false);
	let newName = $state('');

	let renaming = $state<ProjectSummary | null>(null);
	let renamedTo = $state('');

	let deleting = $state<ProjectSummary | null>(null);

	const dateFormat = new Intl.DateTimeFormat(undefined, {
		dateStyle: 'medium',
		timeStyle: 'short'
	});
	const lastTouched = (updatedAt: string) => {
		const when = new Date(updatedAt);
		return Number.isNaN(when.valueOf()) ? 'never' : dateFormat.format(when);
	};

	const startCreating = () => {
		newName = '';
		creating = true;
	};

	const create = async () => {
		creating = false;
		await session.createProject(newName);
	};

	const startRenaming = (project: ProjectSummary) => {
		renamedTo = project.name;
		renaming = project;
	};

	const rename = async () => {
		const project = renaming;
		renaming = null;
		if (project) await session.renameProject(project.directory, renamedTo);
	};

	const remove = async () => {
		const project = deleting;
		deleting = null;
		if (project) await session.deleteProject(project.directory);
	};
</script>

<section class="mt-8">
	<div class="flex flex-wrap items-baseline justify-between gap-4">
		<h2 class="text-2xl font-semibold">Projects</h2>
		<button class="btn btn-primary" onclick={startCreating}>New Project</button>
	</div>

	{#if session.status === 'unreachable'}
		<!-- ADR-0008: a normal state with a recovery, never an error boundary. -->
		<div role="alert" class="mt-6 alert flex-col items-start alert-warning">
			<h3 class="font-semibold">Workspace not reachable</h3>
			<p>
				Your Workspace could not be opened, so the Projects in it cannot be listed. Nothing has been
				lost — it is still wherever it was.
			</p>
			{#if session.unreachableDetail}
				<p class="text-sm opacity-80">The browser reported: {session.unreachableDetail}</p>
			{/if}
			<button class="btn btn-sm" onclick={() => session.refresh()}>Locate Workspace again</button>
		</div>
	{:else if session.status === 'loading'}
		<p class="mt-6">Looking for your Projects…</p>
	{:else if session.projects.length === 0}
		<p class="mt-6">
			No Projects yet. A Project holds the Historical Maps you are working with, the Alignments you
			make, and the Annotations you write.
		</p>
	{:else}
		<ul class="mt-6 flex flex-col gap-3">
			{#each session.projects as project (project.directory)}
				<li class="card bg-base-100 card-border">
					<div class="card-body flex-row flex-wrap items-center justify-between gap-4">
						<div>
							<h3 class="text-lg font-medium">
								<a class="link" href={resolve(`/?p=${encodeURIComponent(project.directory)}`)}>
									{project.name}
								</a>
							</h3>
							<p class="text-sm opacity-70">
								Last saved <time datetime={project.updatedAt}>{lastTouched(project.updatedAt)}</time
								>
								· folder <code>{project.directory}</code>
							</p>
							{#if project.problem === 'format-too-new'}
								<p class="text-sm text-warning">Made with a newer version of Ballastella.</p>
							{:else if project.problem === 'unreadable'}
								<p class="text-sm text-warning">Its project.json could not be read.</p>
							{/if}
						</div>
						<div class="flex flex-wrap gap-2">
							<button
								class="btn btn-sm"
								onclick={() => startRenaming(project)}
								disabled={project.problem !== null}
							>
								Rename<span class="sr-only"> {project.name}</span>
							</button>
							<button
								class="btn btn-sm"
								onclick={() => session.duplicateProject(project.directory)}
								disabled={project.problem !== null}
							>
								Duplicate<span class="sr-only"> {project.name}</span>
							</button>
							<button class="btn btn-outline btn-error btn-sm" onclick={() => (deleting = project)}>
								Delete<span class="sr-only"> {project.name}</span>
							</button>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<ModalDialog bind:open={creating} title="New Project">
	<label class="floating-label">
		<span>Project name</span>
		<input
			class="input w-full"
			bind:value={newName}
			placeholder="Amsterdam 1625"
			onkeydown={(event) => event.key === 'Enter' && create()}
		/>
	</label>
	{#snippet actions()}
		<button class="btn" onclick={() => (creating = false)}>Cancel</button>
		<button class="btn btn-primary" onclick={create}>Create Project</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => renaming !== null, (open) => !open && (renaming = null)}
	title="Rename Project"
>
	<label class="floating-label">
		<span>New name</span>
		<input
			class="input w-full"
			bind:value={renamedTo}
			onkeydown={(event) => event.key === 'Enter' && rename()}
		/>
	</label>
	<p class="mt-3 text-sm opacity-70">
		Two Projects may share a name; the folder this one lives in does not change, so a link you have
		already shared keeps working.
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (renaming = null)}>Cancel</button>
		<button class="btn btn-primary" onclick={rename}>Rename</button>
	{/snippet}
</ModalDialog>

<ModalDialog
	bind:open={() => deleting !== null, (open) => !open && (deleting = null)}
	title="Delete Project"
>
	<p>
		Delete <strong>{deleting?.name}</strong> and everything in it? Its Historical Maps, Alignments, and
		Annotations go with it. This cannot be undone.
	</p>
	{#snippet actions()}
		<button class="btn" onclick={() => (deleting = null)}>Cancel</button>
		<button class="btn btn-error" onclick={remove}>Delete Project</button>
	{/snippet}
</ModalDialog>
