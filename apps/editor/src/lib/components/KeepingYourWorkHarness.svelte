<script lang="ts">
	import { provideInstalledApp } from '$lib/pwa/installed-app.svelte.js';

	import KeepingYourWork from './KeepingYourWork.svelte';
	import type { FakeStorage } from './keeping-your-work-fake.svelte.js';
	import type { WorkspaceStorage } from '../workspace-storage.svelte.js';

	/**
	 * The section under a parent that puts an `InstalledApp` in context, which is what the install
	 * offer inside it reads and only a component can provide.
	 *
	 * The real `InstalledApp` rather than a fake: its constructor declares state and attaches the
	 * listeners a browser would fire, and the offer's three states are a reading of that — what this
	 * harness is here for is the context, not a different answer.
	 */
	let { storage }: { storage: FakeStorage } = $props();

	provideInstalledApp();
</script>

<KeepingYourWork storage={storage as unknown as WorkspaceStorage} />
