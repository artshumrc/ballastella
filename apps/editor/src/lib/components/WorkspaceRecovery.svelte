<script lang="ts">
	import Alert from './Alert.svelte';

	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let { storage }: { storage: WorkspaceStorage } = $props();
</script>

{#if storage.unavailable}
	<Alert class="mt-8" heading="This Workspace is not open yet" testid="unrecovered-import">
		<p>{storage.unavailable}</p>
	</Alert>
{:else}
	{#if storage.session.status === 'unreachable'}
		<Alert class="mt-8" heading="Workspace not reachable">
			<p>
				Your Workspace could not be opened, so this Project cannot be shown. Nothing has been lost —
				it is still wherever it was.
			</p>
			{#if storage.session.unreachableDetail}
				<p class="text-sm opacity-80">The browser reported: {storage.session.unreachableDetail}</p>
			{/if}
			{#if storage.backing === 'folder'}
				<button class="btn btn-sm" onclick={() => storage.chooseFolder()}>
					Locate Workspace folder again
				</button>
			{:else}
				<button class="btn btn-sm" onclick={() => storage.locateWorkspaceAgain()}>
					Locate Workspace again
				</button>
			{/if}
		</Alert>
	{/if}

	{#if storage.problem}
		<Alert class="mt-4" heading="Your Workspace folder was not opened" text={storage.problem}>
			<button class="btn btn-sm" onclick={() => storage.chooseFolder()}
				>Choose a folder again</button
			>
		</Alert>
	{/if}
{/if}
