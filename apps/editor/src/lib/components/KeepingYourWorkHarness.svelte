<script lang="ts">
	import { untrack } from 'svelte';

	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	import KeepingYourWork from './KeepingYourWork.svelte';
	import type { FakeStorage } from './keeping-your-work-fake.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	let { storage, installed = false }: { storage: FakeStorage; installed?: boolean } = $props();

	const app = provideInstalledApp();
	app.installed = untrack(() => installed);
</script>

<KeepingYourWork storage={storage as unknown as WorkspaceStorage} />
