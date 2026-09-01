<script lang="ts">
	import ModalDialog from './ModalDialog.svelte';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let { storage }: { storage: WorkspaceStorage } = $props();

	const open = $derived(storage.resumeFolder !== '');
</script>

<ModalDialog {open} title="Open your Workspace folder" dismissable={false}>
	<p>
		This page was last open in a folder Workspace. Open it before showing this Project, so the
		Project is read from the right place.
	</p>
	{#if storage.problem}
		<p role="alert" class="mt-3 text-warning">{storage.problem}</p>
	{/if}
	{#snippet actions()}
		{#if storage.problem}
			<button class="btn btn-primary" onclick={() => storage.chooseFolder()}
				>Choose folder again</button
			>
		{:else}
			<button class="btn btn-primary" onclick={() => storage.resumeFolderWorkspace()}>
				Open Workspace folder
			</button>
		{/if}
	{/snippet}
</ModalDialog>
