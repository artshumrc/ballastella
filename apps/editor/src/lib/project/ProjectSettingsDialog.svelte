<script lang="ts">
	import {
		automaticBorderStyle,
		bordersIllegibleThemes,
		type BaseMapAppearance,
		type BaseMapBorderStyle,
		type BaseMapBorders,
		type ProjectFile
	} from '@ballastella/core';

	import BorderStyleFields from '$lib/base-map/BorderStyleFields.svelte';
	import ModalDialog from '$lib/components/ModalDialog.svelte';
	import { formatWhen } from '$lib/text';
	import { theme } from '$lib/theme.svelte';

	import { describeImportEvidence, describeImportProvenance } from './import-provenance-text.js';
	import ProjectSharing from './ProjectSharing.svelte';

	import type { EditorSession } from '../editor-session.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let {
		session,
		storage,
		project,
		directory,
		appearance,
		borders,
		borderStyle,
		onmakeoffline
	}: {
		session: EditorSession;
		storage: WorkspaceStorage;
		project: ProjectFile;
		directory: string;
		appearance: BaseMapAppearance;
		borders: BaseMapBorders;
		borderStyle: BaseMapBorderStyle;
		onmakeoffline: () => unknown;
	} = $props();

	let open = $state(false);
	let shareLinks = $state<boolean | null>(null);
	let unsentWork = $state(true);
	const provenance = $derived(project.importProvenance ?? []);

	async function reReadSharing(): Promise<void> {
		shareLinks = await storage.remote.hasShareLinks();
		unsentWork = (await storage.remote.projectReach(directory)).unsent;
	}

	export async function show(): Promise<void> {
		open = true;
		await reReadSharing();
	}
</script>

<ModalDialog bind:open title="Project settings" wide>
	<div class="flex flex-col divide-y divide-rule">
		<section class="flex flex-col items-start gap-3 pb-6">
			<h3 class="font-serif text-lg">Project details</h3>

			<label class="flex w-full flex-col gap-1">
				<span class="text-sm font-medium">Project name</span>
				<input
					class="input w-full"
					data-testid="project-name-input"
					value={project.name}
					oninput={(event) =>
						session.updateProject({ name: event.currentTarget.value }, { debounce: true })}
					onchange={() => session.commitProject()}
					onblur={() => session.commitProject()}
				/>
			</label>

			<dl class="flex w-full flex-col gap-3 text-sm">
				<div class="flex flex-col gap-1">
					<dt class="text-sm font-semibold opacity-70">Last saved</dt>
					<dd>
						<time class="tabular-nums" data-testid="project-updated-at" datetime={project.updatedAt}
							>{formatWhen(project.updatedAt, project.updatedAt)}</time
						>
					</dd>
				</div>
			</dl>
		</section>

		{#if provenance.length > 0}
			<section class="flex flex-col items-start gap-3 pt-6" data-testid="import-provenance">
				<h3 class="font-serif text-lg">How this Project got here</h3>
				<p class="max-w-prose text-sm opacity-70">
					A read-only record of the transfers that brought this Project into this Workspace. It does
					not say who made the work or who holds rights in it.
				</p>
				<ol class="flex w-full flex-col gap-3 text-sm">
					{#each provenance as entry, at (at)}
						<li
							class="flex flex-col gap-1 border-l-2 border-rule pl-3"
							data-testid="provenance-entry"
							data-provenance-kind={entry.kind}
							data-provenance-evidence={entry.evidence}
						>
							<p>{describeImportProvenance(entry)}</p>
							<p class="text-xs opacity-70">
								<span data-testid="provenance-evidence">{describeImportEvidence(entry)}</span>
								<time class="tabular-nums" datetime={entry.observedAt}
									>{formatWhen(entry.observedAt, entry.observedAt)}</time
								>
							</p>
						</li>
					{/each}
				</ol>
			</section>
		{/if}

		<section class="flex flex-col items-start gap-3 pt-6" data-testid="border-settings">
			<h3 class="font-serif text-lg">Borders</h3>
			<p class="max-w-prose text-sm opacity-70">
				How this Project draws administrative boundaries. Which boundaries it draws — none,
				national, or every division inside them — is chosen on the map itself.
			</p>
			<BorderStyleFields
				{borders}
				style={borderStyle}
				automatic={automaticBorderStyle(appearance, theme.current)}
				illegibleIn={borderStyle.color === null
					? []
					: bordersIllegibleThemes(appearance, borderStyle.color)}
				onchange={(patch, options) => void session.chooseBorderStyle(patch, options ?? {})}
				oncommit={() => void session.commitProject()}
			/>
		</section>

		<ProjectSharing
			name={project.name}
			{directory}
			onFrontPage={project.onFrontPage}
			{shareLinks}
			link={storage.remote.projectShareLink(directory)}
			unsent={unsentWork}
			setOnFrontPage={(on) => session.setProjectOnFrontPage(directory, on)}
			enableShareLinks={async () => {
				const outcome = await storage.remote.enableShareLinks();
				await reReadSharing();
				if (!outcome.enabled) throw new Error(outcome.instruction);
			}}
			verifyShareLinks={() => storage.remote.verifyShareLinks()}
			send={async () => {
				await storage.remote.sync('send');
				await reReadSharing();
			}}
		/>

		<section class="flex flex-col items-start gap-3 pt-6">
			<h3 class="font-serif text-lg">Base Map offline</h3>
			<p class="max-w-prose text-sm opacity-70">
				Store the Base Map tiles for this Project in this Workspace for use without a network
				connection.
			</p>
			<button
				type="button"
				class="btn btn-sm"
				data-testid="make-offline"
				onclick={() => {
					open = false;
					onmakeoffline();
				}}
			>
				Make this Project available offline
			</button>
		</section>
	</div>

	{#snippet actions()}
		<button type="button" class="btn btn-sm" onclick={() => (open = false)}>Close</button>
	{/snippet}
</ModalDialog>
