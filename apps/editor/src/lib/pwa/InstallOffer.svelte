<script lang="ts">
	import { useInstalledApp } from './installed-app.svelte.js';

	const app = useInstalledApp();
</script>

<div class="mt-3" data-testid="install-offer">
	{#if app.installed}
		<p class="text-sm opacity-70" data-testid="install-state-installed">
			Installed on this computer, which is what lets your browser keep the permission for your
			Workspace folder between visits.
		</p>
	{:else if app.installable}
		<button
			class="btn btn-sm"
			type="button"
			data-testid="install-app"
			onclick={() => void app.install()}
		>
			Install Ballastella…
		</button>
	{:else}
		<p class="text-sm opacity-70" data-testid="install-state-unavailable">
			Install from your browser's own menu — “Install” or “Add to Dock”, in the address bar or the
			browser menu. Installing is what lets the browser stop asking about your folder.
		</p>
	{/if}
</div>
