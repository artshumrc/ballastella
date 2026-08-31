<script lang="ts">
	import { untrack } from 'svelte';

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
	let { storage, installed = false }: { storage: FakeStorage; installed?: boolean } = $props();

	/**
	 * `installed` is set on the real object rather than faked, because it is ordinary state on it —
	 * what a browser fires is `appinstalled`, and the listener for that is attached by `start()`,
	 * which is the layout's job and not a component's.
	 *
	 * `untrack` because the capture is meant to be once: the prop is how a test says which browser it
	 * is standing up, and a test that wants the other one mounts the other screen.
	 */
	const app = provideInstalledApp();
	app.installed = untrack(() => installed);
</script>

<KeepingYourWork storage={storage as unknown as WorkspaceStorage} />
